"""The library health check graded without listening (roadmap R6).

R6 asked a person to listen to 25 flagged lines and mark each true or false.
This replaces the ears with the stage plan's truth (owner decision
2026-10-22): a ranked or loved map is correctly timed. Each such map is
graded twice by the health check's own path (bench/health_sample.py's):

- **intact**: every flag on it is false;
- **shifted**: one red line, drawn with a seed, moved by each of SHIFTS_MS; a
  flag on that line is true (unless the intact map already flagged it), a
  flag on any other line false, and no flag on it is a miss.

Only maps with two red lines or more: the health check measures each line
against the map's common offset, so moving a one-line map's only line moves
the whole map and is, by design, not a flag.

The bar is fixed here, before any run, and mirrors R6's 15 of 25: on a pool
of every map once intact and once shifted by 15 ms, at least 60 % of the
``actionable`` flags must be true. ``weak`` (a flag under the actionable
thresholds) is reported beside it with the same rule. The false-flag rate on
intact lines and the recall at each shift are printed too, since precision
on a half-shifted pool depends on that mix.

Usage (on the server, where the Songs folder, osu!.db and the index are)::

    .venv/bin/python bench/health_truth.py anime-single --ranked-db /srv/osu/osu!.db \\
        --db <library.sqlite3> --split dev --max-songs 150 --out report.json
"""

from __future__ import annotations

import argparse
import copy
import json
import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))
sys.path.insert(0, str(HERE))

import overtone as ta  # noqa: E402
import overtone_library as lib  # noqa: E402
import stages  # noqa: E402

SEED = 61
SHIFTS_MS = (15.0, 5.0, 30.0)
BAR_SHARE = 0.60
BAR_SHIFT_MS = 15.0


def shifted(beatmap: dict, index: int, shift_ms: float) -> dict:
    """The beatmap with red line ``index`` moved by ``shift_ms``; nothing else."""
    reds = [list(r) for r in ta._beatmap_red_rows(beatmap)]
    reds[index][0] += shift_ms
    out = copy.copy(beatmap)
    out["sections"] = [s for s in beatmap.get("sections", []) if s.get("name") != "TimingPoints"]
    out["timing"] = dict(beatmap.get("timing", {}), reds=[(o, b) for o, b, _m in reds])
    return out


def flags(beatmap: dict, times, weights, duration: float) -> list[dict]:
    """The health check's flagged lines on these attacks, with their kind."""
    objects = [o for o in beatmap["hitobjects"] if "time" in o]
    first = min(o["time"] for o in objects) / 1000.0 if objects else 0.0
    last = min(duration, max(o.get("end_time", o["time"]) for o in objects) / 1000.0) \
        if objects else duration
    inside = (times >= first - 0.1) & (times <= last + 0.1)
    verdict, *_rest, detail = lib._health_verdict(
        ta.grade_reference_timing(beatmap, times[inside], weights[inside], last))
    if verdict != "check" or not detail:
        return []
    out = []
    for line in json.loads(detail):
        strong = int(line.get("attacks", 0)) >= lib.HEALTH_MIN_ATTACKS \
            and float(line.get("share", 0.0)) >= lib.HEALTH_MIN_SHARE
        out.append({"index": int(line["index"]), "kind": "actionable" if strong else "weak"})
    return out


def grade_song(song: dict, rng: random.Random) -> list[dict]:
    times, weights, duration = lib._attacks(song["audio"], "rust")
    rows, seen = [], set()
    for m in song["maps"]:
        beatmap = ta.read_osu_beatmap(m["path"])
        reds = ta._beatmap_red_rows(beatmap)
        key = tuple(reds)
        if len(reds) < 2 or key in seen:     # one line: a shift is the map's common offset
            continue
        seen.add(key)
        target = rng.randrange(len(reds))
        row = {"folder": song["folder"], "file": m["file"], "lines": len(reds),
               "target": target, "intact": flags(beatmap, times, weights, duration)}
        for s in SHIFTS_MS:
            row[f"shift_{s:g}"] = flags(shifted(beatmap, target, s), times, weights, duration)
        rows.append(row)
    return rows


def summarise(rows: list[dict]) -> dict:
    out = {"maps": len(rows), "lines": sum(r["lines"] for r in rows)}
    for kind in ("actionable", "weak"):
        false_intact = sum(1 for r in rows for f in r["intact"] if f["kind"] == kind)
        k = {"false_flags_intact": false_intact,
             "false_flag_rate_intact": false_intact / max(out["lines"], 1)}
        for s in SHIFTS_MS:
            got = rows
            true = sum(1 for r in got for f in r[f"shift_{s:g}"]
                       if f["kind"] == kind and f["index"] == r["target"]
                       and not any(g["index"] == r["target"] for g in r["intact"]))
            false = sum(1 for r in got for f in r[f"shift_{s:g}"]
                        if f["kind"] == kind and f["index"] != r["target"])
            k[f"recall_{s:g}"] = true / max(len(got), 1)
            pool_false = false + false_intact
            k[f"precision_pool_{s:g}"] = true / (true + pool_false) if true + pool_false else None
        p = k[f"precision_pool_{BAR_SHIFT_MS:g}"]
        k["keeps_word"] = p is not None and p >= BAR_SHARE
        out[kind] = k
    return out


def main(argv: list[str] | None = None) -> int:
    manifest = stages.load_manifest()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("stage", choices=[s["id"] for s in manifest["stages"]])
    parser.add_argument("--db", default=str(lib.default_path()))
    parser.add_argument("--ranked-db", required=True)
    parser.add_argument("--split", choices=("dev", "holdout"))
    parser.add_argument("--max-songs", type=int, default=0)
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    stage = next(s for s in manifest["stages"] if s["id"] == args.stage)
    ranked, _header = stages.ranked_maps(Path(args.ranked_db))
    songs, skipped = stages.build_stage(stage, Path(args.db), manifest.get("holdout_share", 0.3), ranked)
    if args.split:
        songs = [s for s in songs if s["split"] == args.split]
    rng = random.Random(SEED)
    rng.shuffle(songs)
    if args.max_songs:
        songs = songs[:args.max_songs]
    rows, errors, started = [], [], time.perf_counter()
    for i, song in enumerate(songs, 1):
        try:
            rows.extend(grade_song(song, rng))
        except Exception as exc:  # noqa: BLE001 -- one bad song never stops the run
            errors.append(f"{song['folder']}: {type(exc).__name__}: {exc}")
        if i % 20 == 0:
            print(f"{i}/{len(songs)} songs, {len(rows)} maps ({time.perf_counter() - started:.0f} s)",
                  flush=True)
    summary = summarise(rows)
    print(json.dumps(summary, indent=1))
    if args.out:
        Path(args.out).write_text(json.dumps({"stage": args.stage, "split": args.split, "seed": SEED,
                                              "summary": summary, "errors": errors, "rows": rows},
                                             indent=1), encoding="utf-8")
    print(f"{len(errors)} songs skipped on errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
