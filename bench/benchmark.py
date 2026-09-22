"""Accuracy benchmark for Overtone.

Synthesizes drum-machine tracks whose grid is known exactly, runs the analyzer
over them, and reports how far every reported section is from the truth. This is
the harness behind the numbers in the README, and the reason the v2 engine's
error floor was found at all — before it existed, "sounds about right" was the
only available measure.

    python bench/benchmark.py                 # full run
    python bench/benchmark.py --only swing shuffle
    python bench/benchmark.py --engine legacy # compare against the v2 tracker

Audio is generated into ``bench/audio/`` (git-ignored, ~250 MB) and reused on the
next run; pass ``--regen`` after changing a fixture. Every track is seeded from
its own name, so a subset run produces byte-identical audio to a full run.

Exit code is non-zero when any section misses its tolerance, so this can gate CI.

What it measures, and what it deliberately does not
---------------------------------------------------
It measures **precision**: given that a song has a pulse, how close are the
reported BPM and offset to the real ones. Every true section is checked, not just
the first — a tool can report the right global tempo and still put the second red
line on the wrong beat.

It does *not* score the **octave**. Whether a 92 BPM song with eighth-note hats
"is" 92 or 184 is a musical judgement, not an error; the scorer normalizes octaves
and prints which tracks were read at a different one so you can see the pattern.
Real-world recordings are also out of scope here: synthetic audio is what makes
sub-millisecond ground truth possible at all, and it is easier than real drums.
"""
from __future__ import annotations

import argparse
import math
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import timing_analyzer as ta  # noqa: E402

SR = 44100
AUDIO_DIR = Path(__file__).resolve().parent / "audio"

#: A section is "exact" inside these. 0.05 BPM is far tighter than a mapper can
#: hear; 5 ms is roughly where an offset starts to feel late on a hit circle.
BPM_TOLERANCE = 0.05
OFFSET_TOLERANCE_MS = 5.0


# ---------------------------------------------------------------------------
# Instruments
# ---------------------------------------------------------------------------

def _instruments(seed: int = 20240904):
    """One fixed drum kit, so a track's sound never depends on run order."""
    rng = np.random.default_rng(seed)

    n = int(0.18 * SR)
    t = np.arange(n) / SR
    sweep = 2 * np.pi * np.cumsum(120 * np.exp(-t / 0.03) + 45) / SR
    kick = (np.sin(sweep) * np.exp(-t / 0.055)
            + rng.standard_normal(n) * np.exp(-t / 0.0025) * 0.35).astype(np.float32) * 0.95

    n = int(0.16 * SR)
    t = np.arange(n) / SR
    snare = ((rng.standard_normal(n) * np.exp(-t / 0.045)) * 0.7
             + np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.03) * 0.5).astype(np.float32) * 0.7

    n = int(0.05 * SR)
    t = np.arange(n) / SR
    hat = (rng.standard_normal(n) * np.exp(-t / 0.008)).astype(np.float32) * 0.28
    return kick, snare, hat


KICK, SNARE, HAT = _instruments()


def _pad(freq: float, duration: float) -> np.ndarray:
    n = int(duration * SR)
    t = np.arange(n) / SR
    envelope = np.minimum(1.0, t / 0.4) * np.exp(-t / (duration * 0.8))
    wave = sum(np.sin(2 * np.pi * freq * h * t) / (h * 1.6) for h in (1, 2, 3))
    return (wave * envelope).astype(np.float32) * 0.18


def _place(buffer: np.ndarray, sample: np.ndarray, at: float, gain: float = 1.0) -> None:
    i = int(round(at))
    if i < 0:
        return
    end = min(len(buffer), i + len(sample))
    if end > i:
        buffer[i:end] += sample[:end - i] * gain


# ---------------------------------------------------------------------------
# Track synthesis
# ---------------------------------------------------------------------------

def build_track(path: Path, sections, duration, *, hats=True, swing=0.0,
                jitter_ms=0.0, pad_hz=0.0, noise=0.0, drop=(), sparse=(),
                seed=0) -> list[tuple[float, float]]:
    """Render a track and return its ground truth as [(start_s, bpm)].

    ``sections`` is [(earliest_start_s, bpm)]; the grid is continuous across
    them, so a change lands on the first beat at or after its start — which is
    what the returned truth records, not the requested time.
    """
    rng = np.random.default_rng(seed)
    buffer = np.zeros(int(duration * SR) + SR, dtype=np.float32)
    truth: list[tuple[float, float]] = []
    t, beat, si = sections[0][0], 0, 0
    truth.append((t, sections[0][1]))
    while t < duration:
        while si + 1 < len(sections) and t >= sections[si + 1][0] - 1e-9:
            si += 1
            truth.append((t, sections[si][1]))
            beat = 0
        bpm = sections[si][1]
        step = 60.0 / bpm
        in_drop = any(a <= t < b for a, b in drop)
        in_sparse = any(a <= t < b for a, b in sparse)
        jitter = rng.normal(0, jitter_ms / 1000.0) if jitter_ms else 0.0
        at = (t + jitter) * SR
        if not in_drop:
            if beat % 4 in (0, 2) and not (in_sparse and beat % 4 != 0):
                _place(buffer, KICK, at, 1.0 if beat % 4 == 0 else 0.8)
            if beat % 4 in (1, 3) and not in_sparse:
                _place(buffer, SNARE, at, 0.9)
            if hats and not in_sparse:
                _place(buffer, HAT, at, 0.7)
                _place(buffer, HAT, (t + step / 2 + swing * step) * SR, 0.5)
        if pad_hz and beat % 8 == 0 and not in_drop:
            _place(buffer, _pad(pad_hz, step * 8), at, 1.0)
        t += step
        beat += 1
    if noise:
        buffer += rng.standard_normal(len(buffer)).astype(np.float32) * noise
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), buffer[:int(duration * SR)] / max(peak, 1e-9) * 0.92, SR)
    return truth


def build_ramp(path: Path, bpm0: float, bpm1: float, duration: float) -> None:
    """Linearly accelerating tempo: no fixed grid exists anywhere in it."""
    buffer = np.zeros(int(duration * SR) + SR, dtype=np.float32)
    t, beat = 0.5, 0
    while t < duration:
        bpm = bpm0 + (bpm1 - bpm0) * (t / duration)
        _place(buffer, KICK if beat % 4 in (0, 2) else SNARE, t * SR, 1.0)
        _place(buffer, HAT, t * SR, 0.6)
        t += 60.0 / bpm
        beat += 1
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), buffer[:int(duration * SR)] / max(peak, 1e-9) * 0.9, SR)


def build_ambient(path: Path, duration: float, seed: int = 11) -> None:
    """Overlapping pads, no percussion: nothing to fit a grid to."""
    rng = np.random.default_rng(seed)
    buffer = np.zeros(int(duration * SR) + SR, dtype=np.float32)
    t = 0.0
    while t < duration:
        _place(buffer, _pad(220 * (1 + 0.2 * rng.standard_normal()), 3.0), t * SR)
        t += 2.0 + rng.random()
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), buffer[:int(duration * SR)] / max(peak, 1e-9) * 0.9, SR)


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

CASES: dict[str, dict] = {}


def case(name: str, **kwargs) -> None:
    CASES[name] = kwargs


# -- plain tempos, including ones that are not round numbers ----------------
case("edm-174", sections=[(0.4315, 174.0)], duration=60.0, pad_hz=110)
case("stream-225", sections=[(0.353, 225.0)], duration=60.0)
case("odd-222.22", sections=[(1.2071, 222.2222)], duration=60.0)
case("decimal-128.37", sections=[(2.4816, 128.37)], duration=60.0, pad_hz=130)
case("slow-92", sections=[(0.75, 92.0)], duration=60.0, pad_hz=98)
case("fast-300", sections=[(0.2, 300.0)], duration=45.0, hats=False)
case("lead-silence", sections=[(9.7331, 155.0)], duration=70.0, pad_hz=120)
case("long-6min", sections=[(0.8123, 186.0)], duration=360.0, pad_hz=110)

# -- degraded or awkward performances ---------------------------------------
case("noisy-140", sections=[(0.611, 140.0)], duration=60.0, noise=0.02, pad_hz=147)
case("very-noisy-132", sections=[(0.42, 132.0)], duration=60.0, noise=0.08, pad_hz=104)
case("jitter-150", sections=[(0.5, 150.0)], duration=60.0, jitter_ms=3.5)
case("heavy-jitter-168", sections=[(0.5, 168.0)], duration=60.0, jitter_ms=8.0)
case("swing-120", sections=[(0.9, 120.0)], duration=60.0, swing=0.08)
case("shuffle-96", sections=[(0.7, 96.0)], duration=60.0, swing=0.16, pad_hz=110)

# -- thin or missing percussion ---------------------------------------------
case("with-drop-180", sections=[(0.4, 180.0)], duration=70.0, drop=[(30.0, 36.0)], pad_hz=120)
case("sparse-160", sections=[(0.55, 160.0)], duration=60.0, sparse=[(20.0, 30.0)])
case("breakdown-175", sections=[(0.36, 175.0)], duration=90.0,
     drop=[(40.0, 52.0)], sparse=[(52.0, 64.0)], pad_hz=110)

# -- tempo changes -----------------------------------------------------------
case("change-128-142", sections=[(0.4, 128.0), (30.0, 142.0)], duration=60.0)
case("change-175-87.5", sections=[(0.63, 175.0), (32.0, 87.5)], duration=64.0)
case("secs-2", sections=[(0.4, 128.0), (30.0, 142.0)], duration=60.0, pad_hz=110)
case("secs-3", sections=[(0.31, 145.0), (24.0, 152.0), (46.0, 145.0)], duration=68.0)
case("secs-4", sections=[(1.111, 170.0), (20.0, 174.0), (38.0, 180.0), (56.0, 174.0)],
     duration=76.0, pad_hz=98)
case("three-sections", sections=[(0.31, 145.0), (24.0, 152.0), (46.0, 145.0)], duration=68.0)
case("tiny-change", sections=[(0.5, 200.0), (32.0, 203.5)], duration=64.0)


def truth_of(kwargs: dict) -> list[tuple[float, float]]:
    """Ground truth without re-rendering audio (cheap enough to always recompute)."""
    sections, duration = kwargs["sections"], kwargs["duration"]
    out, t, si = [], sections[0][0], 0
    out.append((t, sections[0][1]))
    while t < duration:
        while si + 1 < len(sections) and t >= sections[si + 1][0] - 1e-9:
            si += 1
            out.append((t, sections[si][1]))
        t += 60.0 / sections[si][1]
    return out


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score(kwargs: dict, analysis) -> tuple[float, float, int, int, str]:
    """Worst BPM and offset error over every true section.

    For each moment a tempo change happens, find the red line that *governs*
    that moment and ask two questions: is its BPM right (up to an octave), and
    does its grid pass through the true beat.
    """
    truth = truth_of(kwargs)
    points = ta.snap_timing_points(analysis.points)
    if not points:
        return math.inf, math.inf, 0, len(truth), "no points"
    worst_bpm = worst_offset = 0.0
    octaves: set[str] = set()
    for start, bpm in truth:
        governing = points[0]
        for point in points:
            # Half a beat of slack: a red line placed exactly on the change is
            # not "late" because of floating point.
            if point.offset_ms / 1000.0 <= start + 0.5 * 60.0 / bpm:
                governing = point
        ratio = governing.bpm / bpm if bpm > 0 else 1.0
        octave = 2 ** round(math.log2(ratio)) if ratio > 0 else 1
        worst_bpm = max(worst_bpm, abs(governing.bpm / octave - bpm))
        step = 60.0 / bpm
        beats = (governing.offset_ms / 1000.0 - start) / step
        worst_offset = max(worst_offset, abs(beats - round(beats)) * step * 1000.0)
        if octave != 1:
            octaves.add(f"x{octave:g}")
    return worst_bpm, worst_offset, len(points), len(truth), ",".join(sorted(octaves))


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run(names: list[str], engine: str, regen: bool, audio_dir: Path) -> int:
    audio_dir.mkdir(parents=True, exist_ok=True)
    print(f"{'case':<18} {'bpm_err':>9} {'offset_ms':>9} {'sec':>4}/{'exp':<4} {'time':>6}  note")
    print("-" * 76)
    misses, bpm_errors, offset_errors = 0, [], []
    for name in names:
        kwargs = CASES[name]
        path = audio_dir / f"{name}.wav"
        if regen or not path.exists():
            # crc32, not hash(): Python randomizes string hashing per process,
            # and a fixture that changes between runs is not a fixture.
            build_track(path, seed=zlib.crc32(name.encode()), **kwargs)
        started = time.perf_counter()
        try:
            analysis = ta.analyze_audio(str(path), engine=engine)
        except Exception as exc:  # noqa: BLE001 — a crash is a benchmark result
            print(f"{name:<18} {'ERROR':>9}  {type(exc).__name__}: {exc}")
            misses += 1
            continue
        elapsed = time.perf_counter() - started
        bpm_error, offset_error, found, expected, note = score(kwargs, analysis)
        ok = bpm_error < BPM_TOLERANCE and offset_error < OFFSET_TOLERANCE_MS
        misses += 0 if ok else 1
        bpm_errors.append(bpm_error)
        offset_errors.append(offset_error)
        print(f"{name:<18} {bpm_error:9.4f} {offset_error:9.2f} {found:4d}/{expected:<4d} "
              f"{elapsed:6.1f}  {note}{'' if ok else '   <-- MISS'}")
    if bpm_errors:
        print(f"\nwithin {BPM_TOLERANCE} BPM and {OFFSET_TOLERANCE_MS:.0f} ms: "
              f"{len(bpm_errors) - misses}/{len(bpm_errors)}")
        print(f"median BPM error {np.median(bpm_errors):.4f}   "
              f"median offset error {np.median(offset_errors):.2f} ms")
    return misses


def run_degenerate(audio_dir: Path, engine: str) -> None:
    """Inputs with no answer. Nothing here should hang, crash, or bluff."""
    print("\n-- degenerate inputs (must degrade honestly, not invent an answer) --")
    audio_dir.mkdir(parents=True, exist_ok=True)

    ramp = audio_dir / "_ramp.wav"
    if not ramp.exists():
        build_ramp(ramp, 120.0, 160.0, 60.0)
    analysis = ta.analyze_audio(str(ramp), engine=engine)
    print(f"  tempo ramp 120->160 : engine={analysis.engine} sections={len(analysis.points)} "
          f"bpm={[round(p.bpm, 1) for p in analysis.points][:6]}")

    ambient = audio_dir / "_ambient.wav"
    if not ambient.exists():
        build_ambient(ambient, 45.0)
    try:
        analysis = ta.analyze_audio(str(ambient), engine=engine)
        print(f"  pads, no percussion : engine={analysis.engine} "
              f"global={analysis.global_bpm:.2f} sections={len(analysis.points)}")
    except Exception as exc:  # noqa: BLE001
        print(f"  pads, no percussion : {type(exc).__name__}: {exc}")

    silence = audio_dir / "_silence.wav"
    sf.write(str(silence), np.zeros(SR * 6, dtype=np.float32), SR)
    try:
        analysis = ta.analyze_audio(str(silence), engine=engine)
        print(f"  pure silence        : engine={analysis.engine} bpm={analysis.global_bpm:.2f}")
    except Exception as exc:  # noqa: BLE001
        print(f"  pure silence        : {type(exc).__name__}: {exc}")

    noise = audio_dir / "_noise.wav"
    if not noise.exists():
        rng = np.random.default_rng(5)
        sf.write(str(noise), (rng.standard_normal(SR * 20) * 0.2).astype(np.float32), SR)
    try:
        analysis = ta.analyze_audio(str(noise), engine=engine)
        print(f"  white noise         : engine={analysis.engine} bpm={analysis.global_bpm:.2f}")
    except Exception as exc:  # noqa: BLE001
        print(f"  white noise         : {type(exc).__name__}: {exc}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", metavar="CASE",
                        help="run just these cases (default: all)")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"), default="auto",
                        help="analyzer engine (default auto); 'legacy' reproduces v2")
    parser.add_argument("--regen", action="store_true", help="re-render the audio fixtures")
    parser.add_argument("--dir", default=str(AUDIO_DIR), help="where to keep the audio")
    parser.add_argument("--no-degenerate", action="store_true",
                        help="skip the no-answer inputs")
    parser.add_argument("--list", action="store_true", help="print the case names and exit")
    args = parser.parse_args()

    if args.list:
        print("\n".join(CASES))
        return
    names = args.only or list(CASES)
    unknown = [name for name in names if name not in CASES]
    if unknown:
        print(f"Unknown case(s): {', '.join(unknown)}\nAvailable: {', '.join(CASES)}")
        raise SystemExit(2)

    audio_dir = Path(args.dir)
    misses = run(names, args.engine, args.regen, audio_dir)
    if not args.no_degenerate:
        run_degenerate(audio_dir, args.engine)
    if misses:
        print(f"\n{misses} case(s) outside tolerance")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
