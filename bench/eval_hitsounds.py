"""P-6 real-map evaluation: mapper agreement against simple positional baselines.

Mappers disagree with each other, so agreement with a map's own hitsounds is
not "accuracy". It is the bar the decision engine (H4) must beat: "better
than a rule, or it does not ship". Two rules, both positional, both read
against the map's own red lines through ``hitsound_report``:

- clap on beats 2 and 4 (sixteenth slots 4 and 12 in 4/4);
- finish on the downbeat (slot 0). The plan says "phrase starts"; phrase
  edges need audio structure, so the downbeat stands in as the map-only
  proxy, stated here instead of hidden.

Whistle gets no rule: nothing simple proposes it, and H2 showed whistles
mostly between sixteenths. Its distribution is reported, not scored.

    python bench/eval_hitsounds.py [--db PATH] [--limit N] [--min-objects N]

Selection comes from the library index (standard mode, ``--min-objects`` or
more objects, oldest first so a run is deterministic), which is opened
read-only and refused when it was written by a newer schema. Every ``.osu``
is only read. The maps are never committed; this script and its numbers are.

Scoring is per sound event: the mapper's label is whether the event carries
the addition, the rule's prediction is whether its slot is a target slot.
Events no rule can place (off the sixteenth grid, under another meter, or on
a map with no red lines) are counted apart, never guessed at. A map whose
mapper never uses the addition is skipped for that addition: there is no
recall of nothing.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import overtone as ov
from overtone_library import SCHEMA_VERSION, default_path

#: Rule targets, as sixteenth slots of the bar: beats 2 and 4 in 4/4.
CLAP_SLOTS = frozenset((4, 12))
#: The downbeat, standing in for phrase starts (see the module docstring).
FINISH_SLOTS = frozenset((0,))
#: A map counts for an addition only with this many of the mapper's own.
MIN_CLAPS = 20
MIN_FINISHES = 10


def open_index_readonly(path: str | Path) -> sqlite3.Connection:
    """The library index, read-only: no WAL, no user_version write, nothing."""
    db = sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True)
    try:
        version = db.execute("PRAGMA user_version").fetchone()[0]
    except sqlite3.Error:
        db.close()
        raise
    if version > SCHEMA_VERSION:
        db.close()
        raise ValueError(
            f"The library index was written by a newer Overtone (schema {version}; "
            f"this one reads {SCHEMA_VERSION}).")
    return db


def select_maps(db: sqlite3.Connection, min_objects: int, limit: int) -> list[str]:
    """Standard maps with enough objects, oldest first: deterministic runs."""
    return [row[0] for row in db.execute(
        "SELECT path FROM beatmaps WHERE mode = 0 AND objects >= ? "
        "ORDER BY id LIMIT ?", (min_objects, limit))]


def score_slots(placed: list[tuple[int | None, bool]],
                targets: frozenset[int]) -> dict:
    """One rule against the mapper's labels: TP/FP/FN over placed events.

    ``placed`` is (slot or None, mapper-uses-addition) per sound event;
    unplaced events are counted as ``skipped``, never scored. An event the
    mapper leaves bare but the rule claims is a false positive; one the
    mapper sounds off the rule's slots is a false negative. Precision,
    recall and F1 are None when their denominator is empty, so a map with
    no positives to find does not score 0 for finding none.
    """
    tp = fp = fn = skipped = 0
    for slot, has in placed:
        if slot is None:
            skipped += 1
        elif slot in targets and has:
            tp += 1
        elif slot in targets:
            fp += 1
        elif has:
            fn += 1
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    if precision is None or recall is None or precision + recall == 0:
        f1 = None
    else:
        f1 = 2 * precision * recall / (precision + recall)
    return {"tp": tp, "fp": fp, "fn": fn, "skipped": skipped,
            "precision": precision, "recall": recall, "f1": f1}


def evaluate_map(path: str) -> dict:
    """A map's mapper-vs-rule tallies, read only. Raises on unreadable files."""
    report = ov.hitsound_report(ov.read_osu_beatmap(path))
    meter = report["meter"]
    clap_placed: list[tuple[int | None, bool]] = []
    finish_placed: list[tuple[int | None, bool]] = []
    whistles = off_grid = other_meter = 0
    for sound in report["sounds"]:
        slot, m, names = sound["slot"], sound["meter"], sound["sounds"]
        if "whistle" in names:
            whistles += 1
        if m is not None and m != meter:
            other_meter += 1  # another meter: no rule speaks it, counted apart
            continue
        # Placed, or unplaced (off the grid, or no grid at all): score_slots
        # counts None as skipped, never as a miss.
        place = slot if m == meter else None
        if place is None:
            off_grid += 1
        if meter == 4:
            clap_placed.append((place, "clap" in names))
        finish_placed.append((place, "finish" in names))
    return {"meter4": meter == 4,
            "clap": score_slots(clap_placed, CLAP_SLOTS),
            "finish": score_slots(finish_placed, FINISH_SLOTS),
            "mapper_claps": sum(1 for _s, has in clap_placed if has),
            "mapper_finishes": sum(1 for _s, has in finish_placed if has),
            "whistles": whistles, "off_grid": off_grid,
            "other_meter": other_meter}


def quartiles(values: list[float]) -> dict:
    """Median and quartiles; empty in, empty out."""
    if not values:
        return {"n": 0, "median": None, "q1": None, "q3": None}
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    lower = ordered[:mid]
    upper = ordered[mid + 1:] if n % 2 else ordered[mid:]
    median = statistics.median(ordered)
    return {"n": n, "median": median,
            "q1": statistics.median(lower) if lower else ordered[0],
            "q3": statistics.median(upper) if upper else ordered[-1]}


def summarize(results: list[dict]) -> dict:
    """Corpus medians over maps where the mapper uses the addition enough."""
    clap_f1 = [r["clap"]["f1"] for r in results
               if r["meter4"] and r["mapper_claps"] >= MIN_CLAPS
               and r["clap"]["f1"] is not None]
    clap_recall = [r["clap"]["recall"] for r in results
                   if r["meter4"] and r["mapper_claps"] >= MIN_CLAPS
                   and r["clap"]["recall"] is not None]
    finish_f1 = [r["finish"]["f1"] for r in results
                 if r["mapper_finishes"] >= MIN_FINISHES
                 and r["finish"]["f1"] is not None]
    finish_recall = [r["finish"]["recall"] for r in results
                     if r["mapper_finishes"] >= MIN_FINISHES
                     and r["finish"]["recall"] is not None]
    return {
        "maps": len(results),
        "clap_rule": {"f1": quartiles(clap_f1), "recall": quartiles(clap_recall)},
        "finish_rule": {"f1": quartiles(finish_f1),
                        "recall": quartiles(finish_recall)},
        "whistles": sum(r["whistles"] for r in results),
        "off_grid": sum(r["off_grid"] for r in results),
        "other_meter": sum(r["other_meter"] for r in results),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=str(default_path()),
                        help="library index to read (read-only)")
    parser.add_argument("--limit", type=int, default=1000,
                        help="maps to evaluate, oldest first")
    parser.add_argument("--min-objects", type=int, default=200)
    args = parser.parse_args(argv)

    db = open_index_readonly(args.db)
    try:
        paths = select_maps(db, args.min_objects, args.limit)
    finally:
        db.close()
    if not paths:
        print("eval: no maps selected; is the index scanned?")
        return 1

    started = time.perf_counter()
    results: list[dict] = []
    errors = 0
    for path in paths:
        try:
            results.append(evaluate_map(path))
        except (ValueError, OSError):
            errors += 1
    elapsed = time.perf_counter() - started

    summary = summarize(results)
    summary["errors"] = errors
    summary["seconds"] = round(elapsed, 1)
    summary["ms_per_map"] = round(elapsed / max(1, len(paths)) * 1000, 1)
    print(json.dumps(summary, indent=1))
    print(f"eval: {len(results)} maps, {errors} errors, "
          f"{summary['ms_per_map']} ms a map")
    return 0


if __name__ == "__main__":
    sys.exit(main())
