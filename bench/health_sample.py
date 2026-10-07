"""The library health check's precision sample (roadmap R6).

The health check flags maps whose red lines the attacks disagree with, marked
``actionable`` (a flagged line on ≥12 attacks at ≥0.60 share) or ``weak``.
Those words have shipped since 2026-09-30 with no hand-checked number behind
them. This script draws the sample the number must come from — deterministically,
so anyone re-runs it and gets the same maps — and writes the review sheet a
person listens through. Either the sample supports the labels or the labels
change; the rule is printed on the sheet before any verdict is filled in, so
the bar cannot move after the listening.

Usage (reads the local Songs folder, writes nothing into it)::

    .venv/Scripts/python.exe bench/health_sample.py --songs "C:\\osu!\\Songs"
    .venv/Scripts/python.exe bench/health_sample.py --songs ... --folders 80 --sample 25

What it does per folder: the attacks once per audio file through the Rust
sidecar (the health run's own engine), every difficulty graded on them with
the compilation-grade dedupe (difficulties sharing red lines grade once),
actionable candidates collected, and a seeded sample drawn. What it never
does: judge. The ``verdict`` column stays blank until a person with ears —
and an osu! editor — fills it by listening at each link.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import overtone as ta  # noqa: E402
import overtone_library as lib  # noqa: E402
import overtone_rust  # noqa: E402

HERE = Path(__file__).resolve().parent

#: Whose ears, whose seed. Both are in the sheet: a sample nobody can
#: re-derive is an anecdote, not a measurement.
FOLDER_SEED = 6
SAMPLE_SEED = 26

#: How many Songs folders the run grades. About five seconds an audio file
#: through the sidecar; eighty folders is a coffee, the whole Songs folder
#: would be an evening.
FOLDERS = 80

#: How many actionable flags a person listens to. Twenty-five close calls at
#: a minute each is half an hour with the editor open.
SAMPLE = 25

#: The bar, set before the listening. Fifteen true flags of twenty-five
#: keeps the words; fewer renames them to what the sample supports.
BAR = 15


def _folders(songs: Path, count: int) -> list[Path]:
    """Every Songs folder with a map in it, a seeded few of them."""
    names = sorted(path.name for path in songs.iterdir()
                   if path.is_dir() and any(path.glob("*.osu")))
    return [songs / name for name in random.Random(FOLDER_SEED).sample(names, min(count, len(names)))]


def _audio_of(folder: Path, beatmap: dict) -> Path | None:
    """The map's song by its AudioFilename, case honestly (the listing, not
    the OS lookup, so a mismatch that silences Linux is found here too)."""
    named = str(beatmap.get("general", {}).get("AudioFilename") or "").strip().strip('"')
    if not named:
        return None
    files = {entry.name.lower(): entry for entry in folder.iterdir() if entry.is_file()}
    found = files.get(named.lower())
    return found if found and found.suffix.lower() in (".mp3", ".ogg", ".wav", ".m4a",
                                                       ".flac", ".opus", ".mp4") else None


def _grade_folder(folder: Path) -> tuple[list[dict], list[str]]:
    """Every difficulty graded on its audio's attacks, once per audio file."""
    candidates: list[dict] = []
    errors: list[str] = []
    paths = sorted(folder.glob("*.osu"))
    by_audio: dict[str, list[Path]] = {}
    for path in paths:
        try:
            audio = _audio_of(folder, ta.read_osu_beatmap(path))
        except (OSError, ValueError) as exc:
            errors.append(f"{path.name}: {exc}")
            continue
        by_audio.setdefault(str(audio) if audio else "", []).append(path)
    for audio, maps in by_audio.items():
        if not audio:
            continue
        try:
            times, weights, duration = lib._attacks(audio, "rust")
        except Exception as exc:  # noqa: BLE001 -- one bad song never stops the run
            errors.append(f"{Path(audio).name}: {type(exc).__name__}: {exc}")
            continue
        graded: dict = {}
        for path in maps:
            try:
                beatmap = ta.read_osu_beatmap(path)
            except (OSError, ValueError) as exc:
                errors.append(f"{path.name}: {exc}")
                continue
            objects = [obj for obj in beatmap["hitobjects"] if "time" in obj]
            first = min(obj["time"] for obj in objects) / 1000.0 if objects else 0.0
            last = min(duration, max(obj.get("end_time", obj["time"])
                                     for obj in objects) / 1000.0) if objects else duration
            key = (tuple(ta._beatmap_red_rows(beatmap)), first, last)
            if key not in graded:
                inside = (times >= first - 0.1) & (times <= last + 0.1)
                graded[key] = lib._health_verdict(ta.grade_reference_timing(
                    beatmap, times[inside], weights[inside], last))
            verdict, _lines, _flagged, _worst, _common, detail = graded[key]
            if verdict != "check" or not detail:
                continue
            combos = ta._combo_numbers(beatmap.get("hitobjects", []))
            for line in json.loads(detail):
                if int(line.get("attacks", 0)) < lib.HEALTH_MIN_ATTACKS \
                        or float(line.get("share", 0.0)) < lib.HEALTH_MIN_SHARE:
                    continue
                offset = float(line["offset_ms"])
                near = min((float(t) for t in combos), key=lambda t: abs(t - offset),
                           default=offset)
                stamp = ta.mod_timestamp(offset, [combos[near]] if near in combos else None)
                candidates.append({
                    "folder": folder.name, "file": path.name,
                    "offset_ms": round(offset, 1), "end_ms": line["end_ms"],
                    "bpm": line["bpm"], "fitted_bpm": line["fitted_bpm"],
                    "issues": line["issues"], "relative_ms": line["relative_ms"],
                    "drift_ms": line["drift_ms"], "attacks": line["attacks"],
                    "share": line["share"], "stamp": stamp,
                    "link": ta.mod_editor_link(stamp),
                })
    return candidates, errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--songs", required=True)
    parser.add_argument("--folders", type=int, default=FOLDERS)
    parser.add_argument("--sample", type=int, default=SAMPLE)
    args = parser.parse_args()

    songs = Path(args.songs)
    folders = _folders(songs, args.folders)
    print(f"{len(folders)} folders (seed {FOLDER_SEED}), "
          f"sample of {args.sample} (seed {SAMPLE_SEED}), bar {BAR}/{args.sample}")
    started = time.perf_counter()
    candidates: list[dict] = []
    errors: list[str] = []
    for n, folder in enumerate(folders):
        rows, problems = _grade_folder(folder)
        candidates.extend(rows)
        errors.extend(f"{folder.name}: {problem}" for problem in problems)
        print(f"  [{n + 1}/{len(folders)}] {folder.name}: "
              f"{len(rows)} actionable ({time.perf_counter() - started:.0f} s)")
    rng = random.Random(SAMPLE_SEED)
    sample = rng.sample(candidates, min(args.sample, len(candidates))) if candidates else []
    for n, row in enumerate(sample, 1):
        row["n"] = n

    payload = {"folder_seed": FOLDER_SEED, "sample_seed": SAMPLE_SEED,
               "folders_scanned": len(folders), "folders": [f.name for f in folders],
               "actionable_found": len(candidates), "bar": f"{BAR}/{args.sample}",
               "errors": errors, "sample": sample}
    (HERE / "health_sample.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")

    lines = ["# Health precision sample", "",
             f"Drawn {time.strftime('%Y-%m-%d')} from {len(folders)} Songs folders "
             f"(seed {FOLDER_SEED}): {len(candidates)} actionable flags, {len(sample)} drawn "
             f"(seed {SAMPLE_SEED}). The rule, set before any listening: **{BAR} true flags "
             f"of {args.sample} keeps the words _actionable_ and _weak_; fewer renames them "
             f"to what the sample supports.**",
             "", "How to judge one: open the link in osu!'s editor, listen at the red line — "
             "does the map actually sit off the music there (late/early red line, drifting "
             "grid)? A flag on a line the ear cannot fault is a false alarm, even with "
             "strong evidence; evidence grades the detector, only the ear grades the map.", ""]
    for row in sample:
        evidence = (f"{row['attacks']} attacks, share {row['share']}, "
                    f"map {row['bpm']} BPM vs fitted {row['fitted_bpm']} BPM, "
                    f"relative {row['relative_ms']} ms, drift {row['drift_ms']} ms, "
                    f"issues {','.join(row['issues'])}")
        lines += [f"## {row['n']}. {row['folder']} — {row['file']}",
                  f"- where: {row['stamp']} ({row['offset_ms']} ms) — {row['link']}",
                  f"- the flag claims: {evidence}",
                  "- verdict (true / false / skip): ", ""]
    (HERE / "health_sample.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"actionable: {len(candidates)}, sampled: {len(sample)}, "
          f"errors: {len(errors)} ({time.perf_counter() - started:.0f} s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
