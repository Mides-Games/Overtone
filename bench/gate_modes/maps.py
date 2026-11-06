"""reference and assisted: hand-timed maps graded by the attacks, marked downbeats seed the grid."""
from __future__ import annotations

import sys
import zlib
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import benchmark as bm  # noqa: E402
import overtone as ta  # noqa: E402


# ---------------------------------------------------------------------------
# Reference timing — a hand-timed map, graded against the audio's attacks
# ---------------------------------------------------------------------------

#: The two ways a hand-timed map goes wrong: a line placed late, and a BPM
#: typed a little off, so the grid walks away from the music (0.1 % is 0.15
#: BPM at 150, about 1 ms of drift per second of span).
REFERENCE_SHIFT_MS = 10.0
REFERENCE_TEMPO_ERROR = 1.001


def reference() -> int:
    """Each corpus case timed four ways and graded by ``grade_reference_timing``.

    The true map (offsets rounded to whole ms, as a .osu stores them) must
    come back with nothing to check. The whole map 10 ms late must read as
    one shift of the map, within 1 ms, with no line flagged; on a case with
    several lines, moving only the last one must flag that line and no other.
    Every BPM 0.1 % high must flag every line for drift. Reuses
    ``bench/audio/``; the attacks are the engine's own.
    """
    print(f"{'case':<18} {'lines':>5} {'true map':>9} {'worst ms':>8}  {'map late':>8}  "
          f"{'one line':>8}  {'BPM +0.1 %':>10}  {'drift ms':>8}")
    print("-" * 88)
    failures = 0
    for name, kwargs in bm.CASES.items():
        path = bm.AUDIO_DIR / f"{name}.wav"
        if not path.exists():
            bm.build_track(path, seed=zlib.crc32(name.encode()), **kwargs)
        y, sr = ta._load_audio(path, lambda _message: None)
        times, weights, _env = ta._detect_attacks(y, sr, ta.FIT_HOP)
        rows = [(float(round(t * 1000.0)), bpm) for t, bpm in bm.truth_of(kwargs)]

        def grade(reds):
            return ta.grade_reference_timing({"timing": {"reds": reds}}, times, weights,
                                             kwargs["duration"])

        def keys(report):
            return {f["key"] for f in report["findings"]}

        true = grade(rows)
        worst = max((abs(line.get("offset_error_ms", np.nan)) for line in true["lines"]),
                    default=float("nan"))
        # Noise before the first line is a finding too, but not a timing one.
        clean = (all(line["verdict"] == "ok" for line in true["lines"])
                 and not keys(true) & {"ref_shift", "ref_split"})
        late = grade([(o + REFERENCE_SHIFT_MS, b) for o, b in rows])
        # Against what the true map reads: a shuffle's off-beats already pull
        # its reading 2 ms, and the shift must come on top of that, whole.
        shifted = (late["common_offset_ms"] is not None and true["common_offset_ms"] is not None
                   and abs(late["common_offset_ms"] - true["common_offset_ms"]
                           + REFERENCE_SHIFT_MS) <= 1.0
                   and "ref_split" not in keys(late)
                   and not any("offset" in line["issues"] for line in late["lines"]))
        one = "n/a"
        moved_ok = True
        if len(rows) > 1:
            moved = grade(rows[:-1] + [(rows[-1][0] + REFERENCE_SHIFT_MS, rows[-1][1])])
            flagged = ["offset" in line["issues"] for line in moved["lines"]]
            if len(rows) == 2:
                # Two lines apart have no majority: one is flagged and the
                # split is said, since the median cannot know which is right.
                moved_ok = sum(flagged) == 1 and "ref_split" in keys(moved)
                one = "split" if moved_ok else "missed"
            else:
                moved_ok = flagged == [False] * (len(rows) - 1) + [True]
                one = "flagged" if moved_ok else "missed"
        fast = grade([(o, b * REFERENCE_TEMPO_ERROR) for o, b in rows])
        drifting = sum("drift" in line["issues"] for line in fast["lines"])
        drift = min((abs(line.get("drift_ms", np.nan)) for line in fast["lines"]),
                    default=float("nan"))
        ok = clean and shifted and moved_ok and drifting == len(rows)
        failures += not ok
        verdicts = "/".join(line["verdict"] for line in true["lines"])
        print(f"{name:<18} {len(rows):>5} {'clean' if clean else verdicts:>9} {worst:>8.2f}  "
              f"{'one shift' if shifted else 'missed':>9}  {one:>8}  "
              f"{drifting:>6}/{len(rows):<3}  {drift:>8.1f}{'' if ok else '  FAIL'}")
    total = len(bm.CASES)
    print(f"\nreference: {total - failures}/{total} cases graded as timed")
    return 1 if failures else 0


# ---------------------------------------------------------------------------
# Assisted timing — two marked downbeats, the grid from the attacks
# ---------------------------------------------------------------------------

#: A person's marks, off the true downbeats as a hand in the editor would be.
ASSISTED_MARK_ERRORS_MS = (15.0, -20.0)
#: How far an assisted span may cross into a neighbouring section. Attacks cannot
#: tell two grids apart until they part by the growth's tolerance, 11 % of a
#: subdivision: at 200 -> 203.5 BPM that takes about six beats. So the span may
#: run that far past a change, plus one beat; into a neighbour an octave away
#: (175 -> 87.5) the grid is the same one and runs on, as F-11 describes.
ASSISTED_OVERSHOOT_BEATS = 1.0
ASSISTED_PART_TOLERANCE = 0.11


def assisted() -> int:
    """Every section of every corpus case, marked the way a person would.

    Two downbeats a quarter into the section (clear of the drops in its
    middle), one bar apart and then four, each mark 15-20 ms off. The grid must
    come back within the benchmark's bar (0.05 BPM, 5 ms off the true beats),
    cover the section, and stop within a beat of where its grid and the
    neighbour's part. White noise, pads and silence, marked the
    same way, must be refused.
    """
    print(f"{'case':<18} {'sec':>3} {'bars':>4}  {'bpm err':>8} {'ms err':>7} "
          f"{'covers':>7} {'over s':>6}  verdict")
    print("-" * 72)
    failures = 0
    rows = 0
    for name, kwargs in bm.CASES.items():
        path = bm.AUDIO_DIR / f"{name}.wav"
        if not path.exists():
            bm.build_track(path, seed=zlib.crc32(name.encode()), **kwargs)
        y, sr = ta._load_audio(path, lambda _message: None)
        times, weights, _env = ta._detect_attacks(y, sr, ta.FIT_HOP)
        truth = bm.truth_of(kwargs)
        ends = [t for t, _bpm in truth[1:]] + [kwargs["duration"]]
        for n, ((start, bpm), end) in enumerate(zip(truth, ends)):
            beat = 60.0 / bpm
            for bars in (1, 4):
                rows += 1
                # Whole bars into the section, so the marks sit on true downbeats.
                span_beats = int((end - start) / beat)
                k = 4 * max(0, (span_beats // 4) // 4)
                first = start + k * beat
                second = first + 4 * bars * beat
                if second > end - beat:
                    print(f"{name:<18} {n + 1:>3} {bars:>4}  section too short for these marks")
                    continue
                fit = ta.assisted_grid(times, weights,
                                       first * 1000.0 + ASSISTED_MARK_ERRORS_MS[0],
                                       second * 1000.0 + ASSISTED_MARK_ERRORS_MS[1], bars, 4)
                if not fit["ok"]:
                    failures += 1
                    print(f"{name:<18} {n + 1:>3} {bars:>4}  REFUSED {fit['reason']}  FAIL")
                    continue
                ratio = fit["bpm"] / bpm
                bpm_err = abs(fit["bpm"] - bpm)
                phase = (fit["offset_ms"] / 1000.0 - start) / beat
                ms_err = abs(phase - round(phase)) * beat * 1000.0
                lo, hi = fit["start_ms"] / 1000.0, fit["end_ms"] / 1000.0
                covers = (min(hi, end) - max(lo, start)) / (end - start)
                over = max(0.0, start - lo, hi - end)
                allowed = ASSISTED_OVERSHOOT_BEATS * beat
                neighbours = [truth[i][1] for i in (n - 1, n + 1) if 0 <= i < len(truth)]
                for other in neighbours:
                    octave = 2.0 ** round(float(np.log2(other / bpm)))
                    rel = abs(other / (octave * bpm) - 1.0)
                    part = np.inf if rel < 1e-9 else ASSISTED_PART_TOLERANCE / rel
                    allowed = max(allowed, (ASSISTED_OVERSHOOT_BEATS + part) * beat)
                ok = (abs(ratio - 1.0) < 0.01 and bpm_err <= bm.BPM_TOLERANCE
                      and ms_err <= bm.OFFSET_TOLERANCE_MS and covers >= 0.9
                      and over <= allowed + 1e-6)
                failures += not ok
                print(f"{name:<18} {n + 1:>3} {bars:>4}  {bpm_err:8.4f} {ms_err:7.2f} "
                      f"{covers:7.1%} {over:6.2f}  {'ok' if ok else 'FAIL'}")

    print("\n-- no pulse: marks must be refused --")
    for label, audio in (("white noise", "_noise.wav"), ("pads", "_ambient.wav")):
        path = bm.AUDIO_DIR / audio
        if not path.exists():
            print(f"  {label:<12} missing {audio}: run bench/benchmark.py first  FAIL")
            failures += 1
            continue
        y, sr = ta._load_audio(path, lambda _message: None)
        times, weights, _env = ta._detect_attacks(y, sr, ta.FIT_HOP)
        fit = ta.assisted_grid(times, weights, 2000.0, 3600.0, 1, 4)
        refused = not fit["ok"]
        failures += not refused
        print(f"  {label:<12} {'refused: ' + fit['reason'] if refused else 'ANSWERED'}"
              f"{'' if refused else '  FAIL'}")
    silent = ta.assisted_grid(np.zeros(0), np.zeros(0), 2000.0, 3600.0, 1, 4)
    failures += silent["ok"]
    print(f"  {'silence':<12} {'refused: ' + silent['reason'] if not silent['ok'] else 'ANSWERED  FAIL'}")
    print(f"\nassisted: {'ok' if not failures else f'{failures} failure(s)'} "
          f"({rows} marked sections)")
    return 1 if failures else 0
