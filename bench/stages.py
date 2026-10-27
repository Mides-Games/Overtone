"""Phase 10 timing stages: the engine against one slice of the Songs folder at a time.

single_bpm.py scores every one-red-line map at once. This scores the folder
in stages -- anime first, then bands whose drummers drift and change tempo --
so each stage gets its own baseline, its own fixes and its own confirmation
before the next one starts. The stages are SQL conditions over the library
index, listed in bench/stages.json.

    .venv/Scripts/python.exe bench/stages.py --list
    .venv/Scripts/python.exe bench/stages.py anime-single --jobs 3
    .venv/Scripts/python.exe bench/stages.py anime-single --save-baseline
    .venv/Scripts/python.exe bench/stages.py anime-single --compare   # after an engine change

The mapper's red lines are the truth: ranked and loved timings are mappable
by construction, so no listening is needed. ``--ranked-db`` holds a stage to
exactly those: maps the local osu!.db lists as ranked, approved or loved
(bench/mapper_agreement.py reads it). Without it every map of the stage
counts, graveyard timings included, and its report says so. Every song is assigned by a hash
of its folder name to **dev** (70 %, where changes are tuned) or **held out**
(30 %, never looked at while tuning). A change counts only if it improves the
held-out part as well, and Corpus A stays green.

Per map, every red line is scored with corpus_b's scoring:

- tempo ok: every red line at the map's octave and within 0.05 BPM
- joint 5 ms: tempo ok and every red line within 5 ms (the roadmap's bar)
- conv. 5 / 10 ms: the same after the mappers' red-line convention (the
  median signed error of the **dev** part, 10.0a's ~21 ms lead) is taken
  off. The constant is fitted on dev and applied to held-out, so the
  held-out figure is an honest estimate of an export-time convention; it is
  a diagnostic until the convention is decided, never an engine change.

Analyses share single_bpm's cache, so songs it already analysed cost nothing.
A measurement, not a gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import statistics

import numpy as np
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "bench"))

import overtone as ta  # noqa: E402
import overtone_library as lib  # noqa: E402
import corpus_b as cb  # noqa: E402
import single_bpm as sb  # noqa: E402

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "stages.json"
OUT_DIR = HERE / ".cache" / "stages"
BPM_BAR = 0.05


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def is_holdout(folder: str, share: float) -> bool:
    """A song's split from its folder name alone: stable across runs and
    machines, and independent of anything the engine says."""
    digest = hashlib.sha1(folder.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 2 ** 32 < share


def ranked_maps(osu_db: Path) -> tuple[set[tuple[str, str]], dict]:
    """(song folder, .osu file) of every map osu!.db lists as ranked,
    approved or loved, casefolded, and the database's header."""
    import mapper_agreement as ma
    header, maps = ma.parse_osu_db(osu_db.read_bytes())
    return {(m.folder.casefold(), m.filename.casefold()) for m in maps}, header


def build_stage(stage: dict, db_path: Path, share: float,
                ranked: set[tuple[str, str]] | None = None) -> tuple[list[dict], list[str]]:
    """The stage's maps grouped by song audio, each checked on disk; with
    ``ranked``, only the maps in it."""
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = db.execute(
        "SELECT beatmaps.path, sets.folder FROM beatmaps JOIN sets ON beatmaps.set_id = sets.id"
        f" WHERE {stage['where']} ORDER BY sets.folder, beatmaps.path").fetchall()
    db.close()
    skipped: list[str] = []
    unranked = 0
    by_audio: dict[str, dict] = {}
    for path, folder_name in rows:
        osu = Path(path)
        if ranked is not None and (Path(folder_name).name.casefold(),
                                   osu.name.casefold()) not in ranked:
            unranked += 1
            continue
        if not osu.is_file():
            skipped.append(f"{folder_name}/{osu.name}: map no longer there")
            continue
        audio = sb._audio_of(osu.parent, osu)
        if audio is None:
            skipped.append(f"{folder_name}/{osu.name}: song not found")
            continue
        song = by_audio.setdefault(str(audio), {
            "audio": str(audio), "folder": folder_name, "maps": [],
            "split": "holdout" if is_holdout(folder_name, share) else "dev"})
        song["maps"].append({"file": osu.name, "path": str(osu)})
    if unranked:
        skipped.append(f"{unranked} maps not ranked, approved or loved in osu!.db")
    return list(by_audio.values()), skipped


def score_song(song: dict, analysis: dict) -> list[dict]:
    """One verdict per map of the song, every red line scored."""
    detected = [(line[0], line[1]) for line in analysis["lines"]]
    out = []
    for entry in song["maps"]:
        try:
            reds = ta.read_osu_red_lines(entry["path"])
        except (OSError, ValueError):
            continue
        if not reds:
            continue
        rows = cb.score_track(reds, detected)
        d_map, d_eng = beat_distances(reds, detected, analysis.get("duration_s") or 0.0)
        out.append({"file": entry["file"], "folder": song["folder"], "split": song["split"],
                    "path": analysis["path"], "map_lines": len(reds),
                    "detected_lines": len(detected), "rows": rows,
                    "d_map": d_map, "d_eng": d_eng})
    return out


def beat_distances(reds, detected, duration_s: float) -> tuple[np.ndarray, np.ndarray]:
    """Beat by beat, from the map's first red line to the song's end: each
    map beat's signed distance to the nearest engine beat (ms, positive when
    the engine is late), and each engine beat's to the nearest map beat with
    the same sign. The first says how many map beats the engine has (recall),
    the second how many engine beats are real (precision: a grid read at
    double time has every other beat on nothing)."""
    empty = np.zeros(0)
    if not detected or duration_s <= 0:
        return empty, empty
    start = reds[0][0] / 1000.0
    mb = np.asarray([t for t in cb.grid_beats(reds, duration_s) if t >= start - 1e-6]) * 1000.0
    eb = np.asarray([t for t in cb.grid_beats(detected, duration_s) if t >= start - 1e-6]) * 1000.0
    if mb.size == 0 or eb.size == 0:
        return empty, empty

    def nearest(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
        i = np.clip(np.searchsorted(dst, src), 1, dst.size - 1) if dst.size > 1 else np.zeros(src.size, int)
        left, right = dst[np.maximum(i - 1, 0)], dst[i]
        return np.where(np.abs(left - src) <= np.abs(right - src), left, right) - src

    return nearest(mb, eb), -nearest(eb, mb)


def beat_f(m: dict, tol_ms: float, shift_ms: float) -> float:
    """F-measure of the engine's beats against the map's at ``tol_ms``."""
    if m["d_map"].size == 0 or m["d_eng"].size == 0:
        return 0.0
    recall = float(np.mean(np.abs(m["d_map"] - shift_ms) <= tol_ms))
    precision = float(np.mean(np.abs(m["d_eng"] - shift_ms) <= tol_ms))
    return 0.0 if recall + precision == 0 else 2 * recall * precision / (recall + precision)


def beat_convention(maps: list[dict]) -> float:
    """The median signed beat distance within 50 ms, over the dev maps."""
    d = np.concatenate([m["d_map"] for m in maps if m["d_map"].size] or [np.zeros(0)])
    d = d[np.abs(d) <= 50]
    return float(np.median(d)) if d.size else 0.0


def tempo_ok(m: dict) -> bool:
    return all(r["octave"] == 1 and r["bpm_error"] is not None and r["bpm_error"] <= BPM_BAR
               for r in m["rows"])


def joint(m: dict, tol_ms: float, shift_ms: float = 0.0) -> bool:
    return tempo_ok(m) and all(r["error_ms"] is not None and abs(r["error_ms"] - shift_ms) <= tol_ms
                               for r in m["rows"])


def convention(maps: list[dict]) -> float:
    """The median signed error of tempo-correct red lines within 50 ms."""
    errors = [r["error_ms"] for m in maps if tempo_ok(m) for r in m["rows"]
              if r["error_ms"] is not None and abs(r["error_ms"]) <= 50]
    return statistics.median(errors) if errors else 0.0


def summarise(maps: list[dict], shift_ms: float, beat_shift_ms: float = 0.0) -> dict:
    n = len(maps)
    songs = {m["folder"] for m in maps}
    octaves: dict[str, int] = {}
    for m in maps:
        first = m["rows"][0]["octave"]
        key = "none" if first is None else f"x{first:g}"
        octaves[key] = octaves.get(key, 0) + 1

    def share(pred) -> float | None:
        return sum(map(pred, maps)) / n if n else None

    # The same shares averaged over songs, so a 12-difficulty set is one vote.
    per_song: dict[str, list[dict]] = {}
    for m in maps:
        per_song.setdefault(m["folder"], []).append(m)

    def song_share(pred) -> float | None:
        if not per_song:
            return None
        return statistics.mean(sum(map(pred, ms)) / len(ms) for ms in per_song.values())

    errors = [r["error_ms"] for m in maps for r in m["rows"] if r["error_ms"] is not None]
    # Red line by red line: on a map with tempo changes, how many of its lines
    # the engine has right, not only whether it has all of them.
    lines = [r for m in maps for r in m["rows"]]
    line_ok = [r for r in lines if r["octave"] == 1 and r["bpm_error"] is not None
               and r["bpm_error"] <= BPM_BAR]
    return {
        "maps": n, "songs": len(songs),
        "answered": sum(m["path"] not in ("refused", "error") for m in maps),
        "tempo_ok": share(tempo_ok),
        "octave_x1": share(lambda m: m["rows"][0]["octave"] == 1),
        "joint_5": share(lambda m: joint(m, 5)),
        "conv_5": share(lambda m: joint(m, 5, shift_ms)),
        "conv_10": share(lambda m: joint(m, 10, shift_ms)),
        "song_tempo_ok": song_share(tempo_ok),
        "song_conv_10": song_share(lambda m: joint(m, 10, shift_ms)),
        "line_count_match": share(lambda m: m["map_lines"] == m["detected_lines"]),
        "beat_f10": (statistics.mean(beat_f(m, 10, beat_shift_ms) for m in maps) if maps else None),
        "beat_f20": (statistics.mean(beat_f(m, 20, beat_shift_ms) for m in maps) if maps else None),
        "lines": len(lines),
        "line_tempo_ok": len(line_ok) / len(lines) if lines else None,
        "line_conv_10": (sum(abs(r["error_ms"] - shift_ms) <= 10 for r in line_ok) / len(lines)
                         if lines else None),
        "signed_error_ms": cb.quartiles(errors),
        "octaves": dict(sorted(octaves.items())),
    }


def pct(v: float | None) -> str:
    return "    -" if v is None else f"{100 * v:5.1f}"


def print_summary(title: str, s: dict, base: dict | None = None) -> None:
    def cell(key: str) -> str:
        text = pct(s[key])
        if base is not None and base.get(key) is not None and s[key] is not None:
            text += f" ({100 * (s[key] - base[key]):+.1f})"
        return text
    err = s["signed_error_ms"]
    signed = "-" if err is None else f"{err['median']:+.1f} [{err['q1']:+.1f}..{err['q3']:+.1f}]"
    print(f"  {title:<9} {s['maps']:>5} maps {s['songs']:>4} songs | tempo ok {cell('tempo_ok')} %"
          f" | octave x1 {cell('octave_x1')} % | joint 5 ms {cell('joint_5')} %"
          f" | conv 5 {cell('conv_5')} % | conv 10 {cell('conv_10')} %"
          f" | lines match {cell('line_count_match')} % | signed {signed} ms")
    print(f"  {'':<9} beats (F, convention off): within 10 ms {cell('beat_f10')} %,"
          f" within 20 ms {cell('beat_f20')} %")
    print(f"  {'':<9} red lines {s['lines']}: tempo ok {cell('line_tempo_ok')} %,"
          f" conv 10 {cell('line_conv_10')} %")
    print(f"  {'':<9} per song: tempo ok {pct(s['song_tempo_ok'])} %, conv 10 {pct(s['song_conv_10'])} %;"
          f" answered {s['answered']}/{s['maps']}; octaves "
          + ", ".join(f"{k} {v}" for k, v in s["octaves"].items()))


def main(argv: list[str] | None = None) -> int:
    manifest = load_manifest()
    ids = [s["id"] for s in manifest["stages"]]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("stage", nargs="?", choices=ids)
    parser.add_argument("--list", action="store_true", help="the stages and their sizes")
    parser.add_argument("--engine", choices=sb.ENGINES, default="python")
    parser.add_argument("--db", default=str(lib.default_path()), help="the library index (read only)")
    parser.add_argument("--jobs", type=int, default=1, help="analyses at once (each can take ~2 GB)")
    parser.add_argument("--split", choices=("dev", "holdout"),
                        help="one part only (the convention then needs dev: conv. figures are not read)")
    parser.add_argument("--max-songs", type=int, default=0, metavar="N", help="the first N songs only")
    parser.add_argument("--cli", help="overtone-cli binary (Rust engine)")
    parser.add_argument("--save-baseline", action="store_true",
                        help="keep this run as the stage's baseline (bench/.cache/stages/)")
    parser.add_argument("--compare", action="store_true", help="print the change against the baseline")
    parser.add_argument("--ranked-db", metavar="OSU_DB",
                        help="osu!.db: score only maps it lists as ranked, approved or loved")
    args = parser.parse_args(argv)
    db_path = Path(args.db)
    share = manifest["holdout_share"]
    ranked, ranked_info = None, None
    if args.ranked_db:
        ranked, header = ranked_maps(Path(args.ranked_db))
        ranked_info = {"osu_db_version": header["version"], "ranked_maps": len(ranked)}
        print(f"osu!.db v{header['version']}: {len(ranked)} ranked, approved or loved maps")

    if args.list or not args.stage:
        for stage in sorted(manifest["stages"], key=lambda s: s["order"]):
            songs, skipped = build_stage(stage, db_path, share, ranked)
            held = sum(s["split"] == "holdout" for s in songs)
            print(f"{stage['order']}. {stage['id']:<16} {len(songs):>5} songs "
                  f"({len(songs) - held} dev / {held} held out), "
                  f"{sum(len(s['maps']) for s in songs):>5} maps, {len(skipped)} skipped -- {stage['title']}")
        return 0

    started = time.perf_counter()
    stage = next(s for s in manifest["stages"] if s["id"] == args.stage)
    cli = None
    if args.engine in ("rust", "app"):
        import overtone_rust
        cli = Path(args.cli) if args.cli else overtone_rust.find_cli()
        if cli is None or not cli.is_file():
            print("No overtone-cli: build it with cargo build --release -p overtone-cli")
            return 2
    fingerprint = sb.engine_fingerprint(args.engine, cli)
    songs, skipped = build_stage(stage, db_path, share, ranked)
    if args.split:
        songs = [s for s in songs if s["split"] == args.split]
    if args.max_songs:
        songs = songs[:args.max_songs]
    print(f"stage {stage['id']}: {len(songs)} songs, {sum(len(s['maps']) for s in songs)} maps, "
          f"{len(skipped)} skipped")

    analyses: dict[str, dict] = {}
    todo = []
    for n, song in enumerate(songs):
        song["id"] = f"s{n:05d}"
        cached = cb.read_cache(sb.cache_path(args.engine, song, fingerprint))
        if cached is not None:
            analyses[song["id"]] = cached
        else:
            todo.append((song, song["audio"]))
    print(f"{len(songs) - len(todo)} from the cache, {len(todo)} to analyse", flush=True)
    for song, result in cb.run_analyses(todo, args.engine, cli, args.jobs):
        if result["path"] != "error":
            cb.write_cache(sb.cache_path(args.engine, song, fingerprint), result)
        analyses[song["id"]] = result

    maps = [m for song in songs for m in score_song(song, analyses[song["id"]])]
    dev = [m for m in maps if m["split"] == "dev"]
    held = [m for m in maps if m["split"] == "holdout"]
    shift = convention(dev)
    beat_shift = beat_convention(dev)
    summary = {"dev": summarise(dev, shift, beat_shift),
               "holdout": summarise(held, shift, beat_shift),
               "convention_ms": shift, "beat_convention_ms": beat_shift}

    # A ranked-only run and an every-map run answer different questions:
    # each keeps its own report and its own baseline.
    kind = f"{stage['id']}-{args.engine}" + ("-ranked" if ranked is not None else "")
    out = OUT_DIR / f"{kind}.json"
    base_path = OUT_DIR / f"{kind}-baseline.json"
    base = None
    if args.compare and base_path.is_file():
        base = json.loads(base_path.read_text(encoding="utf-8"))["summary"]
    print(f"\n{stage['title']} ({stage['id']}), {args.engine} engine, "
          f"convention fitted on dev: {shift:+.1f} ms")
    print_summary("dev", summary["dev"], base and base["dev"])
    print_summary("held out", summary["holdout"], base and base["holdout"])
    if args.compare and base is None:
        print("  no baseline yet: run with --save-baseline first")

    # The worst songs of the dev part: where to look next.
    failing: dict[str, list[str]] = {}
    for m in dev:
        if not tempo_ok(m):
            r = m["rows"][0]
            why = (m["path"] if r["octave"] is None else
                   f"x{r['octave']:g}" if r["octave"] != 1 else f"dBPM {r['bpm_error']:.2f}")
            failing.setdefault(m["folder"], []).append(why)
    if failing:
        print(f"\n  dev songs with a wrong tempo: {len(failing)} (first 15)")
        for folder, whys in list(failing.items())[:15]:
            print(f"    {folder[:70]:<70} {', '.join(sorted(set(whys)))}")

    payload = {"stage": stage, "engine": args.engine, "fingerprint": fingerprint,
               "ranked": ranked_info,
               "run": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "summary": summary, "skipped": skipped,
               "maps": [{k: v for k, v in m.items() if k not in ("rows", "d_map", "d_eng")} | {
                   "beat_f10": beat_f(m, 10, beat_shift),
                   "tempo_ok": tempo_ok(m), "conv_10": joint(m, 10, shift),
                   "first": m["rows"][0], "rows": m["rows"]} for m in maps]}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    if args.save_baseline:
        base_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        print(f"\n  baseline saved: {base_path}")
    print(f"\n  written: {out}  ({time.perf_counter() - started:.0f} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
