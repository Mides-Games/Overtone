"""The desktop app's editing helpers on fixed inputs, for test/editor.test.js.

The site's editor (src/lib/editor.js) is a port of the pure functions in
python/overtone.py. This runs them on a few fixed cases and writes what they
return to editor-golden.json beside it, so the JS is held to the Python's own
numbers rather than to a reading of it. Run from the repository root:

    .venv/Scripts/python.exe site/web/test/fixtures/editor-golden.py

Re-run only when overtone.py's editing helpers change on purpose, and say why
in the commit: a golden rewritten to make a red test green proves nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "python"))
import overtone as ta  # noqa: E402

OUT = Path(__file__).with_name("editor-golden.json")
BEATS = np.zeros(0)


def attacks(rng, spans, jitter_ms=3.0, extra=0.0, duration=None):
    """Attacks on a grid per (start_s, bpm, end_s) span, a little jitter, some off-grid noise.
    Times to the millisecond and weights 0-100, as the worker hands them to the page."""
    times = []
    for start, bpm, end in spans:
        beat = 60.0 / bpm
        t = start
        while t < end - 1e-9:
            times.append(t + rng.normal(0, jitter_ms / 1000.0))
            times.append(t + beat / 2 + rng.normal(0, jitter_ms / 1000.0))
            t += beat
    if extra:
        top = duration or max(end for _, _, end in spans)
        times += list(rng.uniform(0, top, int(extra * len(times))))
    times = np.sort(np.round(np.asarray(times), 3))
    weights = np.rint(rng.uniform(20, 100, times.size))
    return times, weights


def points_of(rows):
    return [ta.TimingPoint(o, b, 0.9, 0, m, k) for o, b, m, k in rows]


def rows_of(points):
    return [[p.offset_ms, p.bpm, p.meter, p.meter_known] for p in points]


def refit_row(row):
    return {"bpm": row["bpm"], "share": row["share"], "kept": row["kept"], "attacks": row["attacks"]}


def main():
    rng = np.random.default_rng(7)
    cases = []

    # A tempo change inside one section: 120 BPM for 30 s, then 132.
    t1, w1 = attacks(rng, [(0.5, 120.0, 30.5), (30.5, 132.0, 60.0)])
    base = [[500.0, 120.0, 4, True]]
    pts, report = ta.split_section(points_of(base), BEATS, 0, 30_400.0, t1, w1, 60_000.0)
    cases.append({"op": "split", "lines": base, "index": 0, "at": 30_400.0, "end": 60_000.0,
                  "attacks": {"t": t1.tolist(), "w": w1.tolist()},
                  "out": rows_of(pts), "report": {"split": report["split_ms"],
                                                  "sections": [refit_row(r) for r in report["sections"]]}})

    # Two sections of one tempo, the second line a little off: merged and refitted.
    t2, w2 = attacks(rng, [(1.0, 150.0, 40.0)], jitter_ms=2.0, extra=0.3)
    base = [[1000.0, 149.2, 4, True], [20_200.0, 150.6, 4, False], [40_000.0, 90.0, 3, True]]
    pts, report = ta.merge_sections(points_of(base), BEATS, 0, t2, w2, 45_000.0)
    cases.append({"op": "merge", "lines": base, "index": 0, "end": 45_000.0,
                  "attacks": {"t": t2.tolist(), "w": w2.tolist()},
                  "out": rows_of(pts), "report": {"removed": report["removed_ms"],
                                                  "sections": [refit_row(r) for r in report["sections"]]}})

    # A swung span read at 1/3 of the beat.
    t3, w3 = [], []
    for k in range(80):
        b = 2.0 + k * 0.5
        t3 += [b, b + 0.5 * 2 / 3]
    t3 = np.round(np.asarray(t3) + rng.normal(0, 0.002, len(t3)), 3)
    w3 = np.rint(rng.uniform(30, 100, t3.size))
    base = [[2000.0, 119.0, 4, True]]
    pts, report = ta.split_section(points_of(base), BEATS, 0, 22_000.0, t3, w3, 42_000.0)
    cases.append({"op": "split", "lines": base, "index": 0, "at": 22_000.0, "end": 42_000.0,
                  "attacks": {"t": t3.tolist(), "w": w3.tolist()},
                  "out": rows_of(pts), "report": {"split": report["split_ms"],
                                                  "sections": [refit_row(r) for r in report["sections"]]}})

    # Too few attacks after the split, and noise before it: the BPM is kept, with the reason.
    t4 = np.sort(np.round(rng.uniform(0, 10, 60), 3))
    t4 = np.concatenate([t4, [10.2, 10.7, 11.2]])
    w4 = np.rint(rng.uniform(20, 100, t4.size))
    base = [[0.0, 120.0, 4, False]]
    pts, report = ta.split_section(points_of(base), BEATS, 0, 10_000.0, t4, w4, 12_000.0)
    cases.append({"op": "split", "lines": base, "index": 0, "at": 10_000.0, "end": 12_000.0,
                  "attacks": {"t": t4.tolist(), "w": w4.tolist()},
                  "out": rows_of(pts), "report": {"split": report["split_ms"],
                                                  "sections": [refit_row(r) for r in report["sections"]]}})

    # Refused splits: under a beat after the line, and past the next one.
    for at in (700.0, 59_900.0):
        try:
            ta.split_section(points_of([[500.0, 120.0, 4, True]]), BEATS, 0, at, t1, w1, 60_000.0)
            raise SystemExit("expected a refusal")
        except ValueError:
            cases.append({"op": "split", "lines": [[500.0, 120.0, 4, True]], "index": 0, "at": at,
                          "end": 60_000.0, "attacks": {"t": [], "w": []}, "error": True})

    # The plain edits.
    lines = [[-20.0, 120.0, 4, True], [5000.0, 140.0, 3, False], [9000.0, 100.0, 4, True]]
    for index, delta in ((0, -1.0), (1, -6000.0), (1, 3.5), (2, 10.0)):
        cases.append({"op": "nudge", "lines": lines, "index": index, "delta": delta,
                      "out": rows_of(ta.nudge_timing_point(points_of(lines), BEATS, index, delta))})
    edge = [[3.0, 120.0, 4, True], [5000.0, 140.0, 4, True]]
    cases.append({"op": "nudge", "lines": edge, "index": 0, "delta": -10.0,
                  "out": rows_of(ta.nudge_timing_point(points_of(edge), BEATS, 0, -10.0))})
    cases.append({"op": "add", "lines": lines, "time": 7000.0, "bpm": 128.0,
                  "out": rows_of(ta.add_timing_point(points_of(lines), BEATS, 7000.0, 128.0))})
    cases.append({"op": "update", "lines": lines, "index": 1, "time": 9500.0, "bpm": 141.5,
                  "out": rows_of(ta.update_timing_point(points_of(lines), BEATS, 1, 9500.0, 141.5))})
    cases.append({"op": "delete", "lines": lines, "index": 1,
                  "out": rows_of(ta.delete_timing_point(points_of(lines), 1))})
    cases.append({"op": "meter", "lines": lines, "index": 1, "meter": 7,
                  "out": rows_of(ta.set_meter(points_of(lines), 1, 7))})
    cases.append({"op": "rescale", "lines": lines, "index": 2, "factor": 2.0,
                  "out": rows_of(ta.rescale_section(points_of(lines), 2, 2.0))})

    OUT.write_text(json.dumps({"cases": cases}, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(cases)} cases -> {OUT.name}")


if __name__ == "__main__":
    main()
