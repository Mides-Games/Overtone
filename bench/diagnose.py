"""Which timing problems cost the most: a stage report, diagnosed.

A stage report (bench/stages.py, or a server run's ``remote.py result --out``)
says how many maps came out right. This says *why* the rest did not, and how
much of the songs' time each reason takes, so the next fix goes where most of
the time is lost.

    .venv/Scripts/python.exe bench/diagnose.py report.json
    .venv/Scripts/python.exe bench/diagnose.py report.json --split holdout
    .venv/Scripts/python.exe bench/diagnose.py new.json --compare old.json

The mapper's red lines are the truth, as in the stages. Two kinds of problem:

**Time problems.** The song, from the map's first red line to its end, is cut
wherever the map's line or ours changes. Every stretch then gets exactly one
cause, the first of PROBLEMS that holds, so the shares add up to 100 % of the
time and are read as "this much of the songs is wrong for this reason":

- ``ok``: our BPM within 0.05 of the map's (or within 0.5 BPM with the beats
  still within 10 ms at both ends) and our beats within 10 ms of its beats,
  once the mappers' convention is taken off;
- ``half`` / ``double`` / ``quadruple`` / ``quarter``: read at that octave;
- ``ratio``: 3/2, 2/3, 4/3 or 3/4 of the map's (triplets, a bar read as beats);
- ``bpm_slightly_off``: at the map's octave, more than 0.05 BPM off and within
  3 %, the beats drifting off over the stretch ("222 instead of 220");
- ``tempo_wrong``: further than that, at no simple ratio;
- ``offbeat``: the right tempo, the beats half a beat away;
- ``phase_slightly_off``: the right tempo, the beats 10 to 25 ms away: as often
  one mapper's offset against the stage's convention as an engine error;
- ``phase_off``: the right tempo, the beats further away, and not half a beat.

**Line problems**, counted per minute of song and as the share of maps that have
at least one:

- ``missed_change``: a map change (another BPM) with none of ours within 2 beats;
- ``change_off``: the change is there, between 10 ms and 2 beats away;
- ``phantom_change``: our change with no map line within 2 beats;
- ``double_tick``: our new line starts close after a beat of the previous one,
  so the beat sounds twice;
- ``redundant_line``: our line repeats the previous one's BPM on its grid.

Each song weighs the same: a song with eight difficulties is not eight songs.
A measurement, not a gate. Its limits: the map is one mapper's reading (a
half-time intro can be a choice); mappers' offsets spread about +-6 ms around
the stage's convention (anime-single dev, 2340 one-line maps: 22 to 34 ms
between the quartiles, no format or frame clustering), so most of "beats 10-25
ms off" is that spread, not the engine; and a report written before
``duration_s`` was recorded ends each song 30 s after its last line, which
shortens the last stretch.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

#: The time problems, in the order a stretch is labelled.
PROBLEMS = ("ok", "quarter", "half", "double", "quadruple", "ratio", "tempo_wrong",
            "bpm_slightly_off", "offbeat", "phase_off", "phase_slightly_off")
LINE_PROBLEMS = ("missed_change", "change_off", "phantom_change", "double_tick", "redundant_line")

#: Plain names, for the table.
LABELS = {
    "ok": "right",
    "quarter": "read at a quarter",
    "half": "read at half",
    "double": "read at double",
    "quadruple": "read at four times",
    "ratio": "3/2, 2/3, 4/3 or 3/4",
    "tempo_wrong": "tempo wrong",
    "bpm_slightly_off": "BPM slightly off",
    "offbeat": "on the offbeat",
    "phase_off": "beats shifted",
    "phase_slightly_off": "beats 10-25 ms off",
    "missed_change": "map change missed",
    "change_off": "change not on the map's",
    "phantom_change": "change the map lacks",
    "double_tick": "double tick",
    "redundant_line": "line that changes nothing",
}

BPM_BAR = 0.05        # stages.BPM_BAR
BPM_EAR = 0.5         # stages.BPM_EAR
SLIGHT = 0.03         # a BPM this close (relative) is the right tempo, misread
RATIO_TOL = 0.03      # relative, for the octave and ratio readings
PHASE_MS = 10.0       # the stages' conv 10
PHASE_SMALL_MS = 25.0 # up to here a shift may be the mapper's own offset
CHANGE_BEATS = 2.0    # how far a change may be and still be the same change
TICK_SHARE = 0.4      # a new line this close after a beat sounds it twice
TICK_ON_MS = 3.0      # ... unless it is on the previous grid
TAIL_S = 30.0         # an old report's song end after its last line
RATIOS = {"quarter": 0.25, "half": 0.5, "double": 2.0, "quadruple": 4.0}
OTHER_RATIOS = (1.5, 2.0 / 3.0, 4.0 / 3.0, 0.75)


def _governing(lines, t: float) -> int:
    """The line in force at ``t``: the last one starting at or before it, the
    first one before any (osu! extends the first line backwards)."""
    n = 0
    for i, (offset, _) in enumerate(lines):
        if offset <= t + 1e-6:
            n = i
        else:
            break
    return n


def _phase(t: float, offset: float, bpm: float) -> float:
    """Signed ms from ``t`` to the nearest beat of the grid (offset, bpm)."""
    # wrapped into one half-open beat, so half a beat away reads the same at
    # both ends of a stretch (round() would give +half at one and -half at the other)
    step = 60000.0 / bpm
    return (offset - t + step / 2.0) % step - step / 2.0


def _close(r: float, target: float) -> bool:
    return abs(r / target - 1.0) <= RATIO_TOL


def stretch_problem(t0: float, t1: float, mline, eline, shift_ms: float = 0.0) -> str:
    """The cause of one stretch, map line ``mline`` against ours ``eline``."""
    (mo, mb), (eo, eb) = mline, eline
    r = eb / mb
    if abs(eb - mb) > BPM_BAR and not abs(r - 1.0) <= SLIGHT:
        for name, target in RATIOS.items():
            if _close(r, target):
                return name
        if any(_close(r, x) for x in OTHER_RATIOS):
            return "ratio"
        return "tempo_wrong"
    step = 60000.0 / mb
    # the beats at both ends of the stretch, from the map's grid to ours
    beats = [mo + round((t - mo) / step) * step for t in (t0, max(t0, t1 - step))]
    errors = [_phase(b, eo, eb) - shift_ms for b in beats]
    if abs(eb - mb) > BPM_BAR:
        if abs(eb - mb) <= BPM_EAR and all(abs(e) <= PHASE_MS for e in errors):
            return "ok"
        return "bpm_slightly_off"
    error = statistics.median(errors)
    if abs(error) <= PHASE_MS:
        return "ok"
    if abs(abs(error) - 60000.0 / eb / 2.0) <= 0.15 * 60000.0 / eb:
        return "offbeat"
    return "phase_slightly_off" if abs(error) <= PHASE_SMALL_MS else "phase_off"


def map_lines(m: dict) -> list[tuple[float, float]]:
    """The map's red lines, from a report's rows."""
    return sorted((float(r["offset_ms"]), float(r["bpm"])) for r in m["rows"])


def time_problems(mlines, elines, end_ms: float, shift_ms: float = 0.0) -> dict[str, float]:
    """Seconds of the map's span under each time problem."""
    out: dict[str, float] = defaultdict(float)
    if not mlines or not elines:
        return out
    start = mlines[0][0]
    cuts = sorted({start, end_ms, *(o for o, _ in mlines if start < o < end_ms),
                   *(o for o, _ in elines if start < o < end_ms)})
    for a, c in zip(cuts, cuts[1:]):
        if c - a < 1.0:
            continue
        name = stretch_problem(a, c, mlines[_governing(mlines, a)], elines[_governing(elines, a)], shift_ms)
        out[name] += (c - a) / 1000.0
    return out


def line_problems(mlines, elines) -> dict[str, int]:
    """How many times each line problem happens in one map."""
    out: dict[str, int] = defaultdict(int)
    if not mlines or not elines:
        return out
    changes = [(o, b) for (o, b), (_, pb) in zip(mlines[1:], mlines) if abs(b - pb) > BPM_BAR]
    ours = elines[1:]
    for offset, bpm in changes:
        reach = CHANGE_BEATS * 60000.0 / bpm
        near = [abs(o - offset) for o, _ in ours if abs(o - offset) <= reach]
        if not near:
            out["missed_change"] += 1
        elif min(near) > PHASE_MS:
            out["change_off"] += 1
    starts = [o for o, _ in mlines]
    for n in range(1, len(elines)):
        (offset, bpm), (po, pb) = elines[n], elines[n - 1]
        reach = CHANGE_BEATS * 60000.0 / bpm
        if abs(bpm - pb) > BPM_BAR and not any(abs(s - offset) <= reach for s in starts):
            out["phantom_change"] += 1
        step = 60000.0 / pb
        after = (offset - po) % step          # how far past the last beat of the old grid
        on_grid = min(after, step - after) <= TICK_ON_MS
        if not on_grid and after < TICK_SHARE * step:
            out["double_tick"] += 1
        elif on_grid and abs(bpm - pb) <= 0.01:
            out["redundant_line"] += 1
    return out


def end_of(m: dict) -> float:
    """The song's end in ms: its recorded duration, else 30 s after its last line."""
    if m.get("duration_s"):
        return float(m["duration_s"]) * 1000.0
    last = max([o for o, _ in map_lines(m)] + [float(o) for o, _ in m.get("lines") or []] + [0.0])
    return last + TAIL_S * 1000.0


def convention_of(maps: list[dict]) -> float:
    """The mappers' convention: the median signed error of right-tempo lines
    within 50 ms (stages.convention), 0 when there are none."""
    errors = [r["error_ms"] for m in maps for r in m["rows"]
              if r.get("octave") == 1 and r.get("bpm_error") is not None and r["bpm_error"] <= BPM_BAR
              and r.get("error_ms") is not None and abs(r["error_ms"]) <= 50]
    return statistics.median(errors) if errors else 0.0


def diagnose(maps: list[dict], shift_ms: float | None = None) -> dict:
    """Each problem's share of the songs' time and of the songs, every song
    weighing the same (its maps averaged)."""
    if shift_ms is None:
        shift_ms = convention_of(maps)
    songs: dict[str, list[dict]] = defaultdict(list)
    for m in maps:
        songs[m["folder"]].append(m)
    time_share = defaultdict(float)
    present = defaultdict(float)
    per_minute = defaultdict(float)
    line_present = defaultdict(float)
    unanswered = 0
    for folder, group in songs.items():
        song_time = defaultdict(float)
        song_lines = defaultdict(float)
        song_minutes = 0.0
        answered = [m for m in group if m.get("lines")]
        if not answered:
            unanswered += 1
            continue
        for m in answered:
            mlines = map_lines(m)
            elines = [(float(o), float(b)) for o, b in m["lines"]]
            secs = time_problems(mlines, elines, end_of(m), shift_ms)
            total = sum(secs.values()) or 1.0
            for k, v in secs.items():
                song_time[k] += v / total / len(answered)
            for k, v in line_problems(mlines, elines).items():
                song_lines[k] += v / len(answered)
            song_minutes += total / 60.0 / len(answered)
        for k, v in song_time.items():
            time_share[k] += v
            if k != "ok" and v >= 0.05:
                present[k] += 1
        for k, v in song_lines.items():
            per_minute[k] += v / max(song_minutes, 1e-6)
            if v > 0:
                line_present[k] += 1
    n = max(1, len(songs) - unanswered)
    return {
        "songs": len(songs), "unanswered": unanswered, "convention_ms": round(shift_ms, 1),
        "time": {k: round(100.0 * time_share[k] / n, 1) for k in PROBLEMS},
        "songs_with": {k: round(100.0 * present[k] / n, 1) for k in PROBLEMS if k != "ok"},
        "per_minute": {k: round(per_minute[k] / n, 2) for k in LINE_PROBLEMS},
        "songs_with_line": {k: round(100.0 * line_present[k] / n, 1) for k in LINE_PROBLEMS},
    }


def print_diagnosis(title: str, d: dict, base: dict | None = None) -> None:
    def delta(section: str, key: str) -> str:
        if not base:
            return ""
        was = base.get(section, {}).get(key)
        now = d[section][key]
        return "" if was is None else f"  ({now - was:+.1f})"

    print(f"\n  {title}: {d['songs']} songs ({d['unanswered']} unanswered), "
          f"convention {d['convention_ms']:+.1f} ms")
    print("    time problems, worst first      % of the time   % of songs (5 %+ of it)")
    ranked = sorted((k for k in PROBLEMS if k != "ok"), key=lambda k: -d["time"][k])
    for k in ranked:
        print(f"      {LABELS[k]:<30} {d['time'][k]:>6.1f}{delta('time', k):<9} {d['songs_with'][k]:>6.1f}")
    print(f"      {LABELS['ok']:<30} {d['time']['ok']:>6.1f}{delta('time', 'ok')}")
    print("    line problems, worst first      per minute      % of songs with one")
    for k in sorted(LINE_PROBLEMS, key=lambda k: -d["per_minute"][k]):
        print(f"      {LABELS[k]:<30} {d['per_minute'][k]:>6.2f}{delta('per_minute', k):<9} "
              f"{d['songs_with_line'][k]:>6.1f}")


def diagnose_report(report: dict, split: str | None = None) -> dict:
    """The diagnosis of a report, per split: dev's convention is used for both."""
    maps = report["maps"]
    dev = [m for m in maps if m.get("split") == "dev"]
    shift = convention_of(dev) if dev else convention_of(maps)
    out = {}
    for name in ("dev", "holdout"):
        part = [m for m in maps if m.get("split") == name]
        if part and (split is None or split == name):
            out[name] = diagnose(part, shift)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report", help="a stage report (bench/stages.py, or remote.py result --out)")
    parser.add_argument("--compare", help="an older report: each share's change beside it")
    parser.add_argument("--split", choices=("dev", "holdout"), help="one part only")
    parser.add_argument("--json", action="store_true", help="print the diagnosis as JSON")
    args = parser.parse_args(argv)
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    now = diagnose_report(report, args.split)
    base = diagnose_report(json.loads(Path(args.compare).read_text(encoding="utf-8")), args.split) \
        if args.compare else {}
    if args.json:
        print(json.dumps(now, indent=1))
        return 0
    stage = report.get("stage", {})
    print(f"{stage.get('title', '')} ({stage.get('id', '?')})")
    for name, d in now.items():
        print_diagnosis("held out" if name == "holdout" else name, d, base.get(name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
