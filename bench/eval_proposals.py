"""H4e real-audio gate: the decision engine against the mapper, per addition.

Runs ``overtone-cli hitsound`` over index-selected local maps and scores
each proposal against the mapper's own sounds, event by event: the mapper's
label is whether the sound event carries the addition, the proposal's is
whether its additions name it, joined on (object, part, edge). Bodies ride
neither side — H4 proposes nothing for them. Medians over maps where the
mapper uses the addition enough, exactly like P-6, because this gate exists
to answer one question: better than a rule, or it does not ship. The rules
to beat are P-6's (clap F1 0.59, finish F1 0.42).

    python bench/eval_proposals.py [--db PATH] [--limit N] [--offset N] [--cli PATH]
                                   [--profile P.json] [--style minimal|drum] [--bare]

``--profile`` decides with another profile file (the CLI's baked
``balanced`` otherwise). ``--style`` keeps only the songs whose mapper
hitsounded in that style, by ``in_style`` below, read from the mapper's own
sounds before anything is proposed; ``--offset`` then skips songs of that
style. ``--bare`` proposes on a copy of each map with every hitsound
stripped, written to a temporary folder and never beside the song, and
still scores against the mapper's sounds: the prior speaks only where the
mapper left a sound, so this measures the profile alone. Every run also
reports the proposals' character beside the mapper's: additions per object,
and the share of them on a beat.

Read-only like P-6, but slow: every song pays decode, attacks, tempo,
structure, evidence and decide inside the CLI. The maps are never
committed; this script and its numbers are.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from eval_hitsounds import (CLAP_SLOTS, FINISH_SLOTS, MIN_CLAPS, MIN_FINISHES,
                            open_index_readonly, quartiles, select_maps)
import overtone as ov
from overtone_library import read_osu_header

#: A timeout is for a run that hangs, not a slow one: on a loaded machine one
#: song's evidence took 546 s (2026-09-26), and 300 s stopped a whole run.
TIMEOUT_S = 1800

#: The two styles a profile is measured on, read from the mapper's own
#: sounds in 4/4. Set on 2026-09-26 from these numbers' spread over 4,543
#: local songs in 4/4, before any profile proposed anything (timeline):
#: additions per object below 0.1 is a map not hitsounded yet, and 0.1-0.4
#: the sparse ~4 % of the rest; a share on a beat of 0.8 is past the 75th
#: percentile (0.76); claps on 2 and 4 at 0.75 and finishes on the downbeat
#: at 0.7 are the upper quartiles (0.73, 0.72); whistles at most 0.4 of the
#: additions is the lower quartile (0.40).
MINIMAL_ADDITIONS = (0.1, 0.4)
MINIMAL_ON_BEAT = 0.8
DRUM_CLAPS_ON_2_AND_4 = 0.75
DRUM_FINISHES_ON_1 = 0.7
DRUM_WHISTLE_SHARE = 0.4
STYLES = ("minimal", "drum")


def default_cli() -> str:
    name = "overtone-cli.exe" if sys.platform == "win32" else "overtone-cli"
    override = os.environ.get("OVERTONE_CLI")
    if override:
        return override
    root = HERE.parent
    for candidate in (root / name, root / "target" / "release" / name):
        if candidate.is_file():
            return str(candidate)
    return name


def run_proposals(cli: str, audio: str, osu: str, profile: str | None = None) -> dict:
    """The CLI's proposal document. Raises ``RuntimeError`` on failure, like
    the sidecar, a run past the timeout included: one song must not end the
    evaluation of the others."""
    args = [cli, "hitsound", audio, osu] + (["--profile", profile] if profile else [])
    try:
        done = subprocess.run(args, capture_output=True, timeout=TIMEOUT_S,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"hitsound took over {TIMEOUT_S} s on {osu} and was stopped") from exc
    try:
        report = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if done.returncode != 0 or report is None or "units" not in report:
        detail = (done.stderr.decode("utf-8", "replace").strip()[-300:]
                  if done.stdout is not None else "")
        raise RuntimeError(f"hitsound failed on {osu} (exit {done.returncode}): {detail}")
    return report


def score_proposals(events: list[dict], units: list[dict]) -> dict:
    """Mapper-vs-proposal tallies per addition, joined on (object, part, edge).

    A proposal the mapper's event does not cover, or an event with no
    proposal, counts apart: the join is the measurement, and silent drops
    on either side would flatter it.
    """
    by_unit = {(u["object"], u["part"], u.get("edge")): u for u in units}
    out: dict[str, dict] = {}
    for addition in ("clap", "finish", "whistle"):
        tp = fp = fn = uncovered = 0
        mapper = 0
        for event in events:
            if event["part"] == "body":
                continue
            has = addition in event["sounds"]
            mapper += has
            unit = by_unit.get((event["object"], event["part"], event.get("edge")))
            if unit is None:
                uncovered += 1
                continue
            proposed = addition in unit["proposal"]["additions"]
            if has and proposed:
                tp += 1
            elif proposed:
                fp += 1
            elif has:
                fn += 1
        precision = tp / (tp + fp) if tp + fp else None
        recall = tp / (tp + fn) if tp + fn else None
        if precision is None or recall is None or precision + recall == 0:
            f1 = None
        else:
            f1 = 2 * precision * recall / (precision + recall)
        out[addition] = {"tp": tp, "fp": fp, "fn": fn, "uncovered": uncovered,
                         "mapper": mapper, "precision": precision,
                         "recall": recall, "f1": f1}
    return out


def _objects(beatmap: dict) -> int:
    return sum(1 for o in beatmap.get("hitobjects", [])
               if o.get("kind") in ("circle", "slider", "spinner", "hold"))


def style_metrics(beatmap: dict) -> dict:
    """What the style rule reads, from the mapper's own sounds: additions
    (whistle, finish, clap) per object, the share of those on the grid that
    fall on a beat, where claps and finishes fall, and the whistles' share.
    Places are ``hitsound_report``'s: sixteenths against the map's own red
    lines, under the meter most of the map uses. Slider bodies left out."""
    report = ov.hitsound_report(beatmap)
    meter = report["meter"]
    count = {"whistle": 0, "finish": 0, "clap": 0}
    placed = on_beat = claps = backbeat = finishes = downbeat = 0
    for sound in report["sounds"]:
        on_grid = sound["meter"] == meter and sound["slot"] is not None
        for name in sound["sounds"][1:]:
            count[name] += 1
            if not on_grid:
                continue
            placed += 1
            on_beat += sound["slot"] % ov.SLOTS_PER_BEAT == 0
            if name == "clap":
                claps += 1
                backbeat += sound["slot"] in CLAP_SLOTS
            elif name == "finish":
                finishes += 1
                downbeat += sound["slot"] in FINISH_SLOTS
    additions = sum(count.values())
    objects = _objects(beatmap)

    def share(part: int, whole: int) -> float | None:
        return part / whole if whole else None

    return {"meter": meter, "objects": objects, **count,
            "additions_per_object": share(additions, objects),
            "on_beat": share(on_beat, placed),
            "claps_on_2_and_4": share(backbeat, claps),
            "finishes_on_1": share(downbeat, finishes),
            "whistle_share": share(count["whistle"], additions)}


def in_style(metrics: dict, style: str) -> bool:
    """The style rule, 4/4 maps only. Minimal: few additions per object,
    nearly all on a beat, and enough claps or finishes to score one of them.
    Drum-focused: denser than minimal (never both), claps on the backbeat
    and finishes on the downbeat, each enough to score, and whistles a
    minority: the drums lead, not a melody line."""
    per_object = metrics["additions_per_object"]
    if metrics["meter"] != 4 or per_object is None:
        return False
    low, high = MINIMAL_ADDITIONS
    if style == "minimal":
        return (low <= per_object <= high
                and (metrics["on_beat"] or 0.0) >= MINIMAL_ON_BEAT
                and (metrics["clap"] >= MIN_CLAPS or metrics["finish"] >= MIN_FINISHES))
    if style == "drum":
        return (per_object > high
                and metrics["clap"] >= MIN_CLAPS
                and (metrics["claps_on_2_and_4"] or 0.0) >= DRUM_CLAPS_ON_2_AND_4
                and metrics["finish"] >= MIN_FINISHES
                and (metrics["finishes_on_1"] or 0.0) >= DRUM_FINISHES_ON_1
                and (metrics["whistle_share"] or 0.0) <= DRUM_WHISTLE_SHARE)
    raise ValueError(f"unknown style {style!r}")


def style_songs(db: sqlite3.Connection, min_objects: int, style: str,
                count: int) -> list[tuple[str, str]]:
    """The first ``count`` songs in ``style``, oldest first, each set judged
    by one map: its first that is not a hitsound difficulty (a mapset's
    store of sounds, not a map to play). A set whose first map is not in the
    style is not in it, whatever its other maps do. At most one song per
    mapper, because hitsounding is the mapper's taste: a compilation set, a
    set copied into two folders, or a prolific mapper would otherwise fill
    a sample with one person's hitsounds."""
    sets: set[str] = set()
    mappers: set[str] = set()
    songs: list[tuple[str, str]] = []
    rows = db.execute("SELECT path, version, creator FROM beatmaps "
                      "WHERE mode = 0 AND objects >= ? ORDER BY id", (min_objects,))
    for path, version, creator in rows:
        if "hitsound" in (version or "").lower():
            continue
        try:
            audio = str(Path(path).parent / read_osu_header(path).get("audio_file", ""))
        except (ValueError, OSError):
            continue
        folder = os.path.normcase(str(Path(path).parent))
        if not Path(audio).is_file() or folder in sets:
            continue
        sets.add(folder)
        mapper = (creator or "").strip().lower()
        if mapper in mappers:
            continue
        try:
            metrics = style_metrics(ov.read_osu_beatmap(path))
        except (ValueError, OSError):
            continue
        if in_style(metrics, style):
            mappers.add(mapper)
            songs.append((audio, path))
            if len(songs) >= count:
                break
    return songs


def bare_copy(osu: str, dest: Path) -> None:
    """``osu`` with every hitsound stripped, written to ``dest``: bits 0,
    sets, index and volume 0 (inherit), no custom file, every slider edge
    alike. Only hitsound fields change (P-2), so objects, timing and the
    (object, part, edge) join are the original's; the original is only read."""
    beatmap = ov.read_osu_beatmap(osu)
    changes: dict[int, dict] = {}
    for n, obj in enumerate(beatmap.get("hitobjects", [])):
        kind = obj.get("kind")
        if kind not in ("circle", "slider", "spinner", "hold"):
            continue
        change: dict = {"bits": 0, "sample": {"normal_set": 0, "addition_set": 0,
                                              "index": 0, "volume": 0, "file": ""}}
        if kind == "slider":
            change["edges"] = [{"bits": 0, "normal_set": 0, "addition_set": 0}
                               for _ in range(int(obj.get("slides", 1)) + 1)]
        changes[n] = change
    ov.set_object_hitsounds(beatmap, changes)
    dest.write_bytes(ov.beatmap_text(beatmap).encode("utf-8-sig" if beatmap.get("bom")
                                                      else "utf-8"))


def character(beatmap: dict, units: list[dict]) -> dict:
    """The proposal's additions beside the mapper's: how many, over the
    map's objects, and how many of those on the grid fall on a beat."""
    report = ov.hitsound_report(beatmap)
    meter = report["meter"]
    slot_of = {(s["object"], s["part"], s["edge"]): (s["slot"] if s["meter"] == meter else None)
               for s in report["sounds"]}
    out = {"objects": _objects(beatmap)}
    sides = {"mapper": [(slot_of[(s["object"], s["part"], s["edge"])], s["sounds"][1:])
                        for s in report["sounds"]],
             "proposed": [(slot_of.get((u["object"], u["part"], u.get("edge"))),
                           u["proposal"]["additions"]) for u in units]}
    for side, rows in sides.items():
        additions = placed = on_beat = 0
        for slot, names in rows:
            additions += len(names)
            if slot is not None:
                placed += len(names)
                on_beat += len(names) if slot % ov.SLOTS_PER_BEAT == 0 else 0
        out[side] = {"additions": additions, "placed": placed, "on_beat": on_beat}
    return out


def summarize(results: list[dict]) -> dict:
    """Corpus medians over maps where the mapper uses the addition enough."""
    summary = {"maps": len(results)}
    for addition, minimum in (("clap", MIN_CLAPS), ("finish", MIN_FINISHES)):
        f1 = [r[addition]["f1"] for r in results
              if r[addition]["mapper"] >= minimum and r[addition]["f1"] is not None]
        recall = [r[addition]["recall"] for r in results
                  if r[addition]["mapper"] >= minimum and r[addition]["recall"] is not None]
        summary[addition] = {"f1": quartiles(f1), "recall": quartiles(recall)}
    whistle = [r["whistle"]["f1"] for r in results if r["whistle"]["f1"] is not None]
    summary["whistle"] = {"f1": quartiles(whistle)}
    summary["uncovered"] = sum(r[a]["uncovered"] for r in results for a in ("clap", "finish"))
    shaped = [r["character"] for r in results if "character" in r]
    if shaped:
        summary["character"] = {side: {
            "additions_per_object": quartiles([c[side]["additions"] / c["objects"]
                                               for c in shaped if c["objects"]]),
            "on_beat": quartiles([c[side]["on_beat"] / c[side]["placed"]
                                  for c in shaped if c[side]["placed"]])}
            for side in ("mapper", "proposed")}
    return summary


def _f1_text(value: float | None) -> str:
    return "-" if value is None else f"{value:.2f}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=None, help="library index to read (read-only)")
    parser.add_argument("--limit", type=int, default=12, help="maps to propose, oldest first")
    parser.add_argument("--offset", type=int, default=0, help="maps to skip first")
    parser.add_argument("--cli", default=None, help="overtone-cli binary")
    parser.add_argument("--min-objects", type=int, default=200)
    parser.add_argument("--profile", default=None,
                        help="profile file to decide with (the CLI's balanced otherwise)")
    parser.add_argument("--style", choices=STYLES, default=None,
                        help="only songs whose mapper hitsounded in this style")
    parser.add_argument("--genre", default=None,
                        help="maps from bench/genre_corpus.json instead of the index")
    parser.add_argument("--third", choices=("build", "choose", "score"), default=None,
                        help="with --genre, which third of that genre's maps by set-id order")
    parser.add_argument("--bare", action="store_true",
                        help="propose on a copy with every hitsound stripped")
    args = parser.parse_args(argv)

    if args.genre:
        pairs = genre_pairs(args.genre, args.third, args.offset, args.limit)
        return run_pairs(pairs, args)

    from overtone_library import default_path
    db = open_index_readonly(args.db or str(default_path()))
    try:
        if args.style:
            pairs = style_songs(db, args.min_objects, args.style,
                                args.offset + args.limit)[args.offset:]
        else:
            paths = select_maps(db, args.min_objects, (args.offset + args.limit) * 8)
    finally:
        db.close()
    if not args.style:
        # One map per audio file: the same song proposed twice measures
        # nothing. The offset skips songs, not map rows — a set holds many
        # difficulties of one audio, so slicing happens after the dedup.
        seen_audio: set[str] = set()
        songs: list[tuple[str, str]] = []
        for path in paths:
            try:
                audio = str(Path(path).parent / read_osu_header(path).get("audio_file", ""))
            except (ValueError, OSError):
                continue
            if Path(audio).is_file() and audio not in seen_audio:
                seen_audio.add(audio)
                songs.append((audio, path))
        pairs = songs[args.offset:args.offset + args.limit]
    if not pairs:
        print("eval: no maps selected; is the index scanned?")
        return 1
    return run_pairs(pairs, args)


def genre_pairs(genre: str, third: str | None, offset: int, limit: int
                ) -> list[tuple[str, str]]:
    """(audio, map) for one genre of ``bench/genre_corpus.json``.

    The corpus is the same one the profiles are measured from, so ``--third
    score`` is exactly the maps a ``--third build`` profile never saw. A set
    whose file no longer hashes the same is skipped and named, as Corpus B
    does: the numbers must not quietly come from another version of a map.
    """
    manifest = HERE / "genre_corpus.json"
    if not manifest.is_file():
        print(f"eval: no {manifest.name}; run bench/genre_corpus.py --update first")
        return []
    body = json.loads(manifest.read_text(encoding="utf-8"))
    songs = Path(body["songs_folder"])
    rows = body.get("genres", {}).get(genre, {}).get("sets", [])
    if third:
        keep = {"build": 0, "choose": 1, "score": 2}[third]
        rows = [r for n, r in enumerate(rows) if n % 3 == keep]
    out: list[tuple[str, str]] = []
    for row in rows[offset:]:
        if len(out) >= limit:
            break
        osu = songs / row["folder"] / row["file"]
        if not osu.is_file():
            print(f"eval: skip {row['folder'][:50]}: the file is gone", flush=True)
            continue
        import hashlib
        if hashlib.sha1(osu.read_bytes()).hexdigest() != row["sha1"]:
            print(f"eval: skip {row['folder'][:50]}: it changed since it was measured",
                  flush=True)
            continue
        try:
            audio = osu.parent / read_osu_header(str(osu)).get("audio_file", "")
        except (ValueError, OSError):
            continue
        if audio.is_file():
            out.append((str(audio), str(osu)))
    return out


def run_pairs(pairs: list[tuple[str, str]], args) -> int:
    """Propose on every (audio, map) pair and print the summary."""
    cli = args.cli or default_cli()
    started = time.perf_counter()
    results: list[dict] = []
    errors = 0
    with tempfile.TemporaryDirectory(prefix="overtone-bare-") as scratch:
        for audio, osu in pairs:
            try:
                beatmap = ov.read_osu_beatmap(osu)
                events = ov.sound_events(beatmap)
                proposed_on = osu
                if args.bare:
                    proposed_on = str(Path(scratch) / "bare.osu")
                    bare_copy(osu, Path(proposed_on))
                report = run_proposals(cli, audio, proposed_on, args.profile)
                scored = score_proposals(events, report["units"])
                scored["character"] = character(beatmap, report["units"])
                results.append(scored)
                print(f"eval: {Path(osu).name[:50]}  clap {_f1_text(scored['clap']['f1'])}"
                      f"  finish {_f1_text(scored['finish']['f1'])}", flush=True)
            except (ValueError, OSError, RuntimeError) as exc:
                errors += 1
                print(f"eval: skip {Path(osu).name[:50]}: {str(exc)[:100]}", flush=True)
    elapsed = time.perf_counter() - started

    summary = summarize(results)
    summary["profile"] = args.profile or "balanced"
    summary["style"] = args.style
    summary["bare"] = args.bare
    summary["errors"] = errors
    summary["seconds"] = round(elapsed, 1)
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
