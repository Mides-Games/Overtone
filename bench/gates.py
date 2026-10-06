"""Regression gates the accuracy benchmark cannot see.

``benchmark.py`` measures **precision** — given that a song has a pulse, how
close are the reported BPM and offset. It deliberately normalizes the octave,
and that leaves two blind spots wide enough to drive a rewrite through:

F-07  Nothing checks which octave was chosen. The tempogram-hint path
      (``_tempo_hints`` -> ``_hint_score`` -> ``_beat_from_atoms``) decides
      whether a track reads 112 or 225, and a change there could halve or
      double every track while all 24 benchmark rows stayed green.

F-11  Nothing checks whether a *density* change inside a reported section was
      noticed. ``_grow_sections`` computes coverage and throws it away
      (``share, _cov, rms = _grid_quality(...)``), so a region where the note
      rate halves is absorbed into its neighbour in silence.

So this file holds two gates:

    python bench/gates.py bpm-snapshot        # F-07: pin the absolute BPMs
    python bench/gates.py bpm-snapshot --update
    python bench/gates.py coverage            # F-11: find density changes
    python bench/gates.py measures            # per-section bars and downbeats
    python bench/gates.py signatures          # time-signature regions over one bar
    python bench/gates.py robustness          # the audit's edge-case probes
    python bench/gates.py reference           # hand-timed maps graded by the attacks
    python bench/gates.py assisted            # two marked downbeats seed the grid
    python bench/gates.py real-audio          # local songs keep analysing, readings pinned
    python bench/gates.py real-audio --update
     python bench/gates.py combine             # a compilation keeps every borrowed grid
     python bench/gates.py train               # a practice copy keeps every borrowed beat

Both exit non-zero on failure. Neither renders new audio for the main corpus —
they reuse ``bench/audio/`` — but ``coverage`` has two fixtures of its own,
kept *out* of ``benchmark.CASES`` on purpose so the headline "24/24" stays
exactly comparable to the numbers already published.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import soundfile as sf  # noqa: E402

import benchmark as bm  # noqa: E402
import fuzz_reader as fuzz  # noqa: E402  -- its mutants, for half-wrong sources
import overtone as ta  # noqa: E402
import overtone_combine as tc  # noqa: E402
import overtone_train as tr  # noqa: E402  -- the practice copy and its grid
import overtone_web as wb  # noqa: E402  -- the stage names the page shows

HERE = Path(__file__).resolve().parent
SNAPSHOT = HERE / "bpm_snapshot.json"
REAL_SNAPSHOT = HERE / "real_audio_snapshot.json"
PERF_SNAPSHOT = HERE / "perf_snapshot.json"
#: The real-audio smoke set: Corpus B tracks (bench/corpus_b.json names them
#: by folder, file and SHA-1; the audio is never committed), one or two per
#: path the engine takes on real music: a steady grid, a drifting live band,
#: a rubato intro, a signature change, an octave-swap and the fallback tracker.
REAL_AUDIO = ("take-you-down", "camisa-negra", "shinkou", "noble", "palette",
              "calm-down-juliet")

#: The snapshot pins absolute BPM. A tolerance this tight still absorbs
#: float-order noise between numpy/scipy releases while catching any octave
#: flip (which moves a BPM by a factor of two) and any real drift.
BPM_EPS = 0.01
#: Coverage is the fraction of grid slots carrying an attack. A sustained drop
#: this large means the note rate changed, not that a few hits were missed.
COVERAGE_DROP = 0.25


# ---------------------------------------------------------------------------
# F-07 — the octave is a decision, so pin it
# ---------------------------------------------------------------------------

def _analyse(name: str, audio_dir: Path, engine: str):
    path = audio_dir / f"{name}.wav"
    if not path.exists():
        bm.build_track(path, seed=zlib.crc32(name.encode()), **bm.CASES[name])
    return ta.analyze_audio(str(path), engine=engine)


def _reading(analysis) -> dict:
    """The octave-bearing facts, un-normalized. This is what must not drift."""
    return {
        "global_bpm": round(float(analysis.global_bpm), 4),
        "section_bpms": [round(float(s.bpm), 4) for s in analysis.sections],
        "point_bpms": [round(float(p.bpm), 4)
                       for p in ta.snap_timing_points(analysis.points)],
        "meter": str(analysis.meter),
        "meter_beats": int(analysis.meter_beats),
        "engine": str(analysis.engine),
    }


def bpm_snapshot(names: list[str], audio_dir: Path, engine: str, update: bool) -> int:
    baseline = {}
    if SNAPSHOT.exists():
        baseline = json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("cases", {})
    if not baseline and not update:
        print(f"No baseline at {SNAPSHOT.name}. Create it with --update, then commit it.")
        return 1

    current, failures = {}, []
    print(f"{'case':<18} {'global BPM':>11} {'sections':>9}  verdict")
    print("-" * 62)
    for name in names:
        reading = _reading(_analyse(name, audio_dir, engine))
        current[name] = reading
        want = baseline.get(name)
        if want is None:
            verdict = "new" if update else "NO BASELINE"
            if not update:
                failures.append(f"{name}: no baseline entry")
        else:
            problems = []
            if abs(reading["global_bpm"] - want["global_bpm"]) > BPM_EPS:
                ratio = reading["global_bpm"] / max(want["global_bpm"], 1e-9)
                octave = ""
                if abs(ratio - 2.0) < 0.02 or abs(ratio - 0.5) < 0.01:
                    octave = "  <-- OCTAVE FLIP"
                problems.append(
                    f"global BPM {want['global_bpm']} -> {reading['global_bpm']}{octave}")
            if reading["point_bpms"] != want["point_bpms"]:
                if len(reading["point_bpms"]) != len(want["point_bpms"]):
                    problems.append(
                        f"{len(want['point_bpms'])} red lines -> {len(reading['point_bpms'])}")
                else:
                    for got, expected in zip(reading["point_bpms"], want["point_bpms"]):
                        if abs(got - expected) > BPM_EPS:
                            problems.append(f"red line {expected} -> {got}")
            if reading["engine"] != want["engine"]:
                problems.append(f"engine {want['engine']} -> {reading['engine']}")
            if problems:
                failures.append(f"{name}: " + "; ".join(problems))
                verdict = "CHANGED: " + "; ".join(problems)
            else:
                verdict = "ok"
        print(f"{name:<18} {reading['global_bpm']:11.4f} "
              f"{len(reading['section_bpms']):9d}  {verdict}")

    if update:
        SNAPSHOT.write_text(
            json.dumps({
                "_comment": "Absolute reported BPMs, no octave normalization. "
                            "Regenerate with: python bench/gates.py bpm-snapshot --update",
                "engine": engine,
                "bpm_eps": BPM_EPS,
                "cases": current,
            }, indent=2) + "\n",
            encoding="utf-8")
        print(f"\nWrote {SNAPSHOT.name} ({len(current)} cases). Commit it.")
        return 0

    if failures:
        print(f"\n{len(failures)} case(s) changed their reading:")
        for line in failures:
            print(f"  {line}")
        print("\nIf a change is intended, say why in docs/timeline.md and re-run with --update.")
        return 1
    print(f"\n{len(names)}/{len(names)} readings unchanged.")
    return 0


# ---------------------------------------------------------------------------
# F-11 — coverage inside a reported section
# ---------------------------------------------------------------------------

#: Kept out of benchmark.CASES so the published 24-case corpus stays identical.
#: Both are continuous-grid density changes: every attack of the slow half
#: still lands on the fast half's grid, so `share` cannot see them and only
#: `coverage` can.
COVERAGE_CASES: dict[str, dict] = {
    "halftime-175-87.5": dict(sections=[(0.63, 175.0), (32.0, 87.5)], duration=64.0),
    "halftime-150-75": dict(sections=[(0.5, 150.0), (28.0, 75.0)], duration=56.0,
                            pad_hz=110),
    "doubletime-110-220": dict(sections=[(0.8, 110.0), (26.0, 220.0)], duration=56.0),
}


#: Subdivisions of the reported beat to measure coverage on. The signal does
#: not live on the beat grid: when the note rate halves, the slow half's
#: attacks still land on every beat, so beat-level coverage stays 1.000 for
#: the whole track. It shows up one or two subdivisions down, where the fast
#: half fills every slot and the slow half fills every other one.
SUBDIVISIONS = (1, 2, 4)


def coverage_profile(analysis, window_beats: int = 8) -> list[dict]:
    """Per-window grid statistics inside each reported section.

    Two independent signals, measured here because ``_grow_sections`` looks at
    neither in a way that can fire:

    * **coverage** on a subdivided grid — the fraction of slots carrying an
      attack. Halving the note rate halves it. ``_grow_sections`` computes
      coverage and discards it (``share, _cov, rms = _grid_quality(...)``).
    * **share** — the fraction of attack *energy* the grid explains.
      ``_grow_sections`` does read share, but only breaks when it falls
      *below* 0.55. Measured across these fixtures share barely moves at all
      (within ±0.07) and stays far above that break, so the one statistic the
      growth loop consults is structurally unable to notice the change.
    """
    out: list[dict] = []
    times, weights = analysis.attack_times, analysis.attack_weights
    if times.size == 0 or not analysis.sections:
        return out

    def split_of(values: np.ndarray) -> tuple[int, float]:
        """Index and signed drop of the cleanest high-then-low split."""
        best = (0, 0.0)
        for i in range(2, len(values) - 1):
            drop = float(values[:i].mean() - values[i:].mean())
            if abs(drop) > abs(best[1]):
                best = (i, drop)
        return best

    for n, section in enumerate(analysis.sections):
        span = window_beats * section.period
        if span <= 0 or section.end_s - section.start_s < 4 * span:
            continue
        best_entry = None
        for sub in SUBDIVISIONS:
            period = section.period / sub
            windows = []
            edge = section.start_s
            while edge + span <= section.end_s + 1e-9:
                mask = (times >= edge) & (times < edge + span)
                if int(mask.sum()) >= 4:
                    share, cov, rms = ta._grid_quality(times[mask], weights[mask],
                                                       period, section.phase)
                    windows.append({"at": round(edge, 2), "share": round(share, 3),
                                    "coverage": round(cov, 3), "rms_ms": round(rms, 2)})
                edge += span
            if len(windows) < 4:
                continue
            index, drop = split_of(np.array([w["coverage"] for w in windows]))
            _si, share_shift = split_of(np.array([w["share"] for w in windows]))
            entry = {
                "section": n,
                "subdivision": sub,
                "start_s": round(section.start_s, 2),
                "end_s": round(section.end_s, 2),
                "bpm": round(section.bpm, 4),
                "windows": windows,
                "split_at": windows[index]["at"] if index else None,
                "drop": round(abs(drop), 3),
                "share_shift": round(-share_shift, 3),
                "direction": "halves" if drop > 0 else "doubles",
            }
            if best_entry is None or entry["drop"] > best_entry["drop"]:
                best_entry = entry
        if best_entry is not None:
            out.append(best_entry)
    return out


def coverage(audio_dir: Path, engine: str, regen: bool) -> int:
    audio_dir.mkdir(parents=True, exist_ok=True)
    print("Density changes inside a single reported section.")
    print("Every attack of the slow half still lands on the fast half's grid, so")
    print("`share` stays far above the 0.55 growth break and cannot stop growth;")
    print("`coverage` on a subdivided grid halves, and that is the signal")
    print("`_grow_sections` computes and then discards.\n")
    failures = []
    for name, kwargs in COVERAGE_CASES.items():
        path = audio_dir / f"{name}.wav"
        if regen or not path.exists():
            bm.build_track(path, seed=zlib.crc32(name.encode()), **kwargs)
        analysis = ta.analyze_audio(str(path), engine=engine)
        points = ta.snap_timing_points(analysis.points)
        truth = bm.truth_of(kwargs)
        expected_changes = len({round(bpm, 4) for _t, bpm in truth})

        print(f"{name}")
        print(f"  truth            {expected_changes} distinct tempi, change at "
              f"{truth[1][0]:.2f}s -> {truth[1][1]:g} BPM"
              if len(truth) > 1 else "  truth            one tempo")
        print(f"  reported         {len(points)} red line(s) at "
              f"{[round(p.bpm, 3) for p in points]}")
        hints = ta.suggest_section_pulse(analysis)
        print(f"  pulse hints      {hints if hints else 'none'}")

        profiles = coverage_profile(analysis)
        found = False
        for profile in profiles:
            covs = [w["coverage"] for w in profile["windows"]]
            print(f"  section {profile['section']} ({profile['bpm']:g} BPM), "
                  f"grid at 1/{profile['subdivision']} of the beat")
            print(f"    coverage     {min(covs):.3f}..{max(covs):.3f}  "
                  f"drop {profile['drop']:.3f} ({profile['direction']}) "
                  f"at {profile['split_at']}s")
            shares = [w["share"] for w in profile["windows"]]
            print(f"    share        {min(shares):.3f}..{max(shares):.3f}  "
                  f"shifts {profile['share_shift']:+.3f} across the same split")
            print(f"                 never approaches the 0.55 break, so growth "
                  f"cannot stop on it")
            if profile["drop"] >= COVERAGE_DROP:
                found = True
        if not found:
            failures.append(f"{name}: no coverage drop >= {COVERAGE_DROP} was measurable")
            print("  VERDICT          no usable signal (gate failure)")
        elif len(points) < expected_changes and not hints:
            print("  VERDICT          signal is strong, and nothing surfaces it")
        else:
            print("  VERDICT          surfaced")
        print()

    if failures:
        print("Gate failed — the signal this gate exists to protect is gone:")
        for line in failures:
            print(f"  {line}")
        return 1
    print("Gate passed: a coverage drop is measurable in every fixture.")
    print("What v3 does with it is a separate question — see docs/01-audit-v3.md F-11.")
    return 0


# ---------------------------------------------------------------------------
# Per-section bars: the measure grid
# ---------------------------------------------------------------------------

#: The 24-case corpus cannot exercise this. `build_track` puts a hat on every
#: beat and varies the kick only between 1.0 and 0.8, so the downbeat contrast
#: lands near 1.05 against a 1.20 threshold, and `_meter_from_grid` correctly
#: refuses to claim a bar on every one of them. That is the fixtures having no
#: strong downbeat, not the detector failing — so these fixtures give it one.
MEASURE_CASES: dict[str, dict] = {
    "downbeat-4-4": {"bars": [(4, 24)], "bpm": 150.0},
    "downbeat-3-4": {"bars": [(3, 30)], "bpm": 150.0},
    "downbeat-4-then-3": {"bars": [(4, 20), (3, 24)], "bpm": 150.0},
}


def build_measures(path: Path, bars, bpm: float, sr: int = bm.SR) -> list[tuple[float, int]]:
    """Render a track with an unmistakable downbeat, and return its truth.

    Kick plus snare on beat one of every bar, a quiet hat elsewhere. That is
    what a bar sounds like when a human can hear it, and it is what the corpus
    fixtures deliberately do not have.
    """
    beat = 60.0 / bpm
    total_beats = sum(count * length for length, count in
                      [(length, count) for length, count in bars])
    buffer = np.zeros(int((total_beats + 8) * beat * sr), dtype=np.float32)
    truth: list[tuple[float, int]] = []
    t = 0.5
    for length, count in bars:
        truth.append((t, length))
        for _bar in range(count):
            for beat_in_bar in range(length):
                at = (t + beat_in_bar * beat) * sr
                if beat_in_bar == 0:
                    bm._place(buffer, bm.KICK, at, 1.0)
                    bm._place(buffer, bm.SNARE, at, 0.9)
                else:
                    bm._place(buffer, bm.HAT, at, 0.25)
            t += length * beat
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), buffer / max(peak, 1e-9) * 0.92, sr)
    return truth


def measures(audio_dir: Path, engine: str, regen: bool) -> int:
    audio_dir.mkdir(parents=True, exist_ok=True)
    print("Per-section time signature and downbeat anchoring.")
    print("A red line on a downbeat is what makes osu!'s bar lines agree with")
    print("the music; v3 anchored only the first line and wrote one meter for all.\n")
    print(f"{'case':<20} {'truth':>12} {'detected':>12}  {'anchored':>9}  verdict")
    print("-" * 68)

    failures = []
    for name, kwargs in MEASURE_CASES.items():
        path = audio_dir / f"{name}.wav"
        if regen or not path.exists():
            build_measures(path, **kwargs)
        truth = [length for length, _count in kwargs["bars"]]
        analysis = ta.analyze_audio(str(path), engine=engine)
        found = ta.section_measures(analysis.sections, analysis.attack_times,
                                    analysis.attack_weights)
        bars = [bar for _text, _down, bar in found]
        points = ta.snap_timing_points(analysis.points)

        # Every point that claims a bar must sit on one: an exact number of
        # bars from that section's own downbeat, which is
        # `phase + downbeat_class * period` -- not from the phase itself.
        anchored = True
        for point, section, (_text, downbeat, bar) in zip(points, analysis.sections, found):
            if not point.meter_known:
                continue
            anchor = section.phase + downbeat * section.period
            k = (point.offset_ms / 1000.0 - anchor) / (section.period * max(bar, 1))
            if abs(k - round(k)) > 0.02:
                anchored = False

        detected = [b for b in bars if b > 1]
        # Sections are split on *tempo*, so a time-signature change at a
        # constant tempo stays inside one section and only the first bar is
        # reported. That is a real gap against Tempora, which lets a user set
        # the signature per audio block regardless of tempo -- recorded here
        # rather than hidden, and gated on what is true today: the first
        # section's bar, read correctly, and every claimed bar anchored.
        first_ok = bool(detected) and detected[0] == truth[0]
        ok = first_ok and anchored
        note = ""
        if len(truth) > 1 and len(detected) < len(truth):
            note = (f"  (constant BEAT, changing bar length: {truth} -> {detected} "
                    f"-- see the `signatures` gate for the shape that is handled)")
        if not ok:
            failures.append(f"{name}: truth {truth}, detected {bars}, anchored {anchored}")
        print(f"{name:<20} {str(truth):>12} {str(bars):>12}  "
              f"{'yes' if anchored else 'NO':>9}  {'ok' if ok else 'MISS'}{note}")

    print()
    if failures:
        print("Gate failed:")
        for line in failures:
            print(f"  {line}")
        return 1
    print(f"{len(MEASURE_CASES)}/{len(MEASURE_CASES)} cases read their bar and anchored their")
    print("red line on a downbeat.")
    print()
    print("A signature change that keeps the BEAT and changes the bar's length")
    print("is still open. The opposite shape -- a constant bar with a changing")
    print("subdivision -- is handled; see the `signatures` gate.")
    return 0


# ---------------------------------------------------------------------------
# Time-signature regions over a constant bar
# ---------------------------------------------------------------------------

#: Taken from a real beatmap a user timed by hand in Tempora. Every red line
#: in it sits an exact multiple of 1200 ms from the first, and the beat length
#: alternates 200 / 400 / 300 ms -- which is 6, 3 and 4 beats to the *same*
#: 1200 ms bar. The song has no tempo change at all: the measure grid is
#: constant and only the time signature moves.
#:
#: v3 could not express that. Sections grow on measures per second, which
#: never changes here, so it reported one tempo for the whole track.
SIGNATURE_BAR = 1.200
SIGNATURE_FIRST = 0.168
#: (first bar index, beats in that bar)
SIGNATURE_REGIONS = [(0, 6), (17, 3), (33, 6), (49, 3), (57, 6), (84, 4)]
SIGNATURE_BARS = 100


def build_signatures(path: Path, sr: int = bm.SR) -> list[tuple[float, int]]:
    """Render the reference shape and return its truth as [(start_s, beats)]."""
    duration = SIGNATURE_FIRST + SIGNATURE_BARS * SIGNATURE_BAR + 2.0
    buffer = np.zeros(int(duration * sr), dtype=np.float32)

    def beats_at(bar_index: int) -> int:
        current = SIGNATURE_REGIONS[0][1]
        for start, beats in SIGNATURE_REGIONS:
            if bar_index >= start:
                current = beats
        return current

    for bar_index in range(SIGNATURE_BARS):
        beats = beats_at(bar_index)
        beat = SIGNATURE_BAR / beats
        bar_start = SIGNATURE_FIRST + bar_index * SIGNATURE_BAR
        for b in range(beats):
            at = (bar_start + b * beat) * sr
            if b == 0:
                bm._place(buffer, bm.KICK, at, 1.0)
                bm._place(buffer, bm.SNARE, at, 0.55)
            elif b * 2 == beats:
                bm._place(buffer, bm.SNARE, at, 0.85)
            else:
                bm._place(buffer, bm.HAT, at, 0.45)
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), buffer / max(peak, 1e-9) * 0.92, sr)
    return [(SIGNATURE_FIRST + start * SIGNATURE_BAR, beats)
            for start, beats in SIGNATURE_REGIONS]


def signatures(audio_dir: Path, engine: str, regen: bool) -> int:
    audio_dir.mkdir(parents=True, exist_ok=True)
    print("Time-signature regions over a constant bar.")
    print("Tempora's physical quantity is measures per second; BPM is a")
    print("presentation of it through the signature. A song can change")
    print("signature without changing tempo, and v3 could not express that.\n")

    path = audio_dir / "signature-changes.wav"
    if regen or not path.exists():
        truth = build_signatures(path)
    else:
        truth = [(SIGNATURE_FIRST + start * SIGNATURE_BAR, beats)
                 for start, beats in SIGNATURE_REGIONS]

    analysis = ta.analyze_audio(str(path), engine=engine)
    points = ta.snap_timing_points(analysis.points)

    print(f"{'#':>3}  {'offset':>12} {'truth':>12} {'error':>10}  "
          f"{'beats':>5} {'truth':>5}  {'bpm':>9}  verdict")
    print("-" * 76)
    failures = []
    if len(points) != len(truth):
        failures.append(f"{len(points)} red line(s), truth has {len(truth)}")
    for i in range(max(len(points), len(truth))):
        point = points[i] if i < len(points) else None
        want = truth[i] if i < len(truth) else None
        if point is None or want is None:
            print(f"{i+1:>3}  {'-' if point is None else point.offset_ms:>12}"
                  f"{'  (missing)' if point is None else '  (extra)'}")
            continue
        error_ms = point.offset_ms - want[0] * 1000.0
        ok = abs(error_ms) <= 5.0 and point.meter == want[1]
        if not ok:
            failures.append(f"line {i+1}: {error_ms:+.1f} ms, "
                            f"beats {point.meter} vs {want[1]}")
        print(f"{i+1:>3}  {point.offset_ms:>12.1f} {want[0]*1000:>12.1f} "
              f"{error_ms:>+9.1f}ms  {point.meter:>5} {want[1]:>5}  "
              f"{point.bpm:>9.3f}  {'ok' if ok else 'MISS'}")

    print()
    if failures:
        print("Gate failed:")
        for line in failures:
            print(f"  {line}")
        return 1
    print(f"{len(truth)}/{len(truth)} signature regions found, each red line on")
    print("its bar line and carrying its own meter.")
    print()
    print("Still open: a signature change that keeps the BEAT and changes the")
    print("bar's length (4/4 -> 3/4 at the same BPM) is a different shape and")
    print("is not detected -- see `measures`, case downbeat-4-then-3.")
    return 0


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Robustness — the audit's edge-case probes as one command (roadmap Phase 23)
# ---------------------------------------------------------------------------

#: What a refusal may raise. Anything else (IndexError, TypeError, ...) is a
#: crash dressed as an error, and the app would show a traceback.
CLEAN_ERRORS = (ValueError, RuntimeError, OSError)


def _write_wav(path: Path, y: np.ndarray, sr: int) -> None:
    import wave
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sr)
        out.writeframes((np.clip(y, -1.0, 1.0) * 32767).astype("<i2").tobytes())


def _clicks(sr: int, seconds: float, bpm: float = 150.0) -> np.ndarray:
    """Noise-burst clicks from 0.5 s, every fourth one louder."""
    y = np.zeros(int(seconds * sr))
    rng = np.random.default_rng(7)
    n = int(0.03 * sr)
    burst = np.exp(-np.arange(n) / (0.004 * sr))
    k, t = 0, 0.5
    while t < seconds - 0.2:
        start = int(t * sr)
        y[start:start + n] += (0.9 if k % 4 == 0 else 0.5) * burst * (rng.random(n) - 0.5)
        k, t = k + 1, t + 60.0 / bpm
    return y


def robustness() -> int:
    """Short, empty, junk and silent audio; odd sample rates; junk and
    read-only .osu files. Each must end in a clean refusal or a right answer,
    never a crash, and a failed write must leave the map byte-identical."""
    import os
    import stat
    import tempfile

    failures = 0

    def check(label: str, ok: bool, detail: str) -> None:
        nonlocal failures
        failures += 0 if ok else 1
        print(f"{label:<38} {'ok' if ok else 'FAIL'}  {detail}")

    def refused(label: str, call, must_say: str) -> None:
        try:
            out = call()
        except CLEAN_ERRORS as exc:
            check(label, must_say in str(exc), f"{type(exc).__name__}: {exc}"[:110])
        except Exception as exc:  # noqa: BLE001 -- the gate reports crashes
            check(label, False, f"crashed: {type(exc).__name__}: {exc}"[:110])
        else:
            check(label, False, f"answered instead of refusing: {out!r}"[:110])

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        _write_wav(folder / "short.wav", _clicks(44_100, 1.0), 44_100)
        (folder / "empty.wav").write_bytes(b"")
        (folder / "text.wav").write_text("not audio at all")
        _write_wav(folder / "silence.wav", np.zeros(44_100 * 5), 44_100)
        refused("audio: 1 s", lambda: ta.analyze_audio(str(folder / "short.wav")),
                "at least two seconds")
        refused("audio: empty file", lambda: ta.analyze_audio(str(folder / "empty.wav")),
                "empty")
        refused("audio: text named .wav", lambda: ta.analyze_audio(str(folder / "text.wav")),
                "Could not decode")
        refused("audio: missing file", lambda: ta.analyze_audio(str(folder / "nope.wav")),
                "No audio file")
        refused("audio: 5 s of silence", lambda: ta.analyze_audio(str(folder / "silence.wav")),
                "No rhythmic pulse")

        for sr in (8_000, 22_050, 32_000, 48_000, 96_000):
            path = folder / f"clicks-{sr}.wav"
            _write_wav(path, _clicks(sr, 12.0), sr)
            try:
                bpm = float(ta.analyze_audio(str(path)).global_bpm)
                check(f"audio: 150 BPM clicks at {sr} Hz", abs(bpm - 150.0) < 0.01,
                      f"{bpm:.4f} BPM")
            except Exception as exc:  # noqa: BLE001
                check(f"audio: 150 BPM clicks at {sr} Hz", False,
                      f"{type(exc).__name__}: {exc}"[:110])

        junk = {
            "empty.osu": b"",
            "binary.osu": bytes(range(256)) * 4,
            "utf16.osu": "osu file format v14\r\n\r\n[TimingPoints]\r\n0,500,4,1,0,100,1,0\r\n"
                         .encode("utf-16"),
            "nosections.osu": b"hello\r\n",
        }
        for name, data in junk.items():
            (folder / name).write_bytes(data)
            refused(f"osu: red lines of {name}",
                    lambda name=name: ta.read_osu_red_lines(str(folder / name)), "")
        bad = folder / "badlines.osu"
        bad.write_bytes(b"osu file format v14\r\n\r\n[TimingPoints]\r\nabc,def\r\n"
                        b"1e999,nan,4\r\n,,,,\r\n100,-50,4,1,0,100,0,0\r\n")
        try:
            lines = ta.read_osu_red_lines(str(bad))
            check("osu: junk timing lines skipped", lines == [], f"{lines!r}")
        except Exception as exc:  # noqa: BLE001
            check("osu: junk timing lines skipped", False, f"{type(exc).__name__}: {exc}"[:110])

        analysis = ta.analyze_audio(str(folder / "clicks-48000.wav"))
        good = (b"osu file format v14\r\n\r\n[General]\r\nAudioFilename: a.wav\r\n\r\n"
                b"[TimingPoints]\r\n500,400,4,1,0,100,1,0\r\n\r\n[HitObjects]\r\n"
                b"256,192,500,1,0,0:0:0:0:\r\n")
        locked = folder / "locked.osu"
        locked.write_bytes(good)
        os.chmod(locked, stat.S_IREAD)
        try:
            refused("osu: inject into a read-only map",
                    lambda: ta.inject_osu_timing_points(str(locked), analysis), "")
            check("osu: read-only map left byte-identical", locked.read_bytes() == good,
                  f"{len(locked.read_bytes())} bytes")
        finally:
            os.chmod(locked, stat.S_IWRITE | stat.S_IREAD)
        refused("osu: inject into a missing map",
                lambda: ta.inject_osu_timing_points(str(folder / "gone.osu"), analysis),
                "is not a file")

    print(f"\nrobustness: {'ok' if not failures else f'{failures} failure(s)'}")
    return 1 if failures else 0


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


# ---------------------------------------------------------------------------
# Real audio — a handful of local songs must keep analysing, never refused
# ---------------------------------------------------------------------------

def real_audio(names: list[str], update: bool) -> int:
    """The synthetic corpus is clean drums; a change can keep it green and
    still refuse a real song, or move its reading. These tracks must analyse
    (no refusal), on the same engine path, to the readings pinned in
    ``real_audio_snapshot.json`` (BPMs within ``BPM_EPS``, the same red lines).
    A track this machine does not hold, or holds changed, is skipped and named:
    the audio is the user's and never committed. None held: nothing checked,
    said so, and not a failure."""
    import corpus_b as cb
    manifest = {t["id"]: t for t in json.loads(cb.MANIFEST.read_text(encoding="utf-8"))["tracks"]}
    baseline = {}
    if REAL_SNAPSHOT.exists():
        baseline = json.loads(REAL_SNAPSHOT.read_text(encoding="utf-8")).get("tracks", {})
    current, failures, skipped = {}, [], []
    print(f"{'track':<18} {'engine':<10} {'global BPM':>11} {'lines':>6}  verdict")
    print("-" * 66)
    for name in names:
        found = cb.locate(manifest[name], cb.SONGS)
        if not found["ok"]:
            skipped.append(f"{name}: {found['reason']}")
            print(f"{name:<18} {'-':<10} {'-':>11} {'-':>6}  skipped ({found['reason']})")
            continue
        try:
            analysis = ta.analyze_audio(str(found["folder"] / manifest[name]["audio"]))
        except (ValueError, RuntimeError) as exc:
            failures.append(f"{name}: refused ({exc})")
            print(f"{name:<18} {'refused':<10} {'-':>11} {'-':>6}  REFUSED: {exc}")
            continue
        reading = _reading(analysis)
        current[name] = reading
        want = baseline.get(name)
        problems = []
        if want is None:
            if not update:
                problems.append("no baseline entry")
        else:
            if reading["engine"] != want["engine"]:
                problems.append(f"engine {want['engine']} -> {reading['engine']}")
            if abs(reading["global_bpm"] - want["global_bpm"]) > BPM_EPS:
                problems.append(f"global BPM {want['global_bpm']} -> {reading['global_bpm']}")
            got, expected = reading["point_bpms"], want["point_bpms"]
            if len(got) != len(expected):
                problems.append(f"{len(expected)} red lines -> {len(got)}")
            elif any(abs(a - b) > BPM_EPS for a, b in zip(got, expected)):
                problems.append("a red line's BPM moved")
        if update:
            verdict = "new" if want is None else "updated: " + "; ".join(problems) if problems else "ok"
        elif problems:
            failures.append(f"{name}: " + "; ".join(problems))
            verdict = "CHANGED: " + "; ".join(problems)
        else:
            verdict = "ok"
        print(f"{name:<18} {reading['engine']:<10} {reading['global_bpm']:11.4f} "
              f"{len(reading['point_bpms']):6d}  {verdict}")

    if update:
        if not current:
            print("\nNo track held here: nothing to pin.")
            return 1
        REAL_SNAPSHOT.write_text(
            json.dumps({
                "_comment": "Real songs (bench/corpus_b.json tracks) that must keep analysing, "
                            "never refused. Regenerate with: python bench/gates.py real-audio --update",
                "bpm_eps": BPM_EPS,
                "tracks": current,
            }, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8")
        print(f"\nWrote {REAL_SNAPSHOT.name} ({len(current)} tracks). Commit it.")
        return 0
    if skipped:
        print(f"\n{len(skipped)} skipped, not held here as the manifest names them.")
    if failures:
        print(f"\n{len(failures)} track(s) failed:")
        for line in failures:
            print(f"  {line}")
        print("\nIf a change is intended, say why in timeline.md and re-run with --update.")
        return 1
    checked = len(current)
    print(f"\nreal-audio: {checked}/{len(names)} tracks analysed as pinned"
          + ("" if checked else " (none held here: nothing checked)"))
    return 0


# ---------------------------------------------------------------------------
# Per-stage cost, against a pinned baseline
# ---------------------------------------------------------------------------

#: The cases the perf gate times, one per path the engine takes: the common
#: grid analysis, the long track where the heavy stages actually cost
#: something (its attacks and sections are most of the run), and a ramp, which
#: no grid fits, so the fallback tracker's stages are timed too.
PERF_CASES = ("edm-174", "long-6min", "_ramp")
#: Analyses per case. The fastest counts: noise on this machine only ever adds
#: (another process taking the core, a page fault, numba compiling on the
#: first analysis of the process), so the minimum is the closest thing to the
#: engine's own cost that can be measured from here. Two runs would do; three
#: costs little and makes the warm-up impossible to mistake for the cost.
PERF_RUNS = 3
#: The measurement runs **single-threaded, in a process of its own**. numpy's
#: and numba's pools are sized when they are imported, so this cannot be set
#: after gates.py has loaded them. It matters: with the pools free, attack
#: detection on edm-174 cost 1.72, 2.94 and 3.11 CPU seconds for identical
#: work as the pool grew and shrank (CPU over wall ran 2.06-3.60). Pinned,
#: CPU time is wall time and the same stage lands within 4 % run to run, which
#: is what makes a budget mean anything. It is the engine's cost that is being
#: held, not the machine's parallelism.
PERF_ENV = {"OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
            "NUMBA_NUM_THREADS": "1", "NUMEXPR_NUM_THREADS": "1"}
#: Set in the child, so it measures instead of spawning another child.
PERF_PINNED = "OVERTONE_PERF_PINNED"
#: Bumped when the snapshot's shape changes, so an old one is named rather
#: than read as the new one and compared against nonsense.
PERF_FORMAT = 1
#: A stage fails when its CPU time passes **both** bars: this many times the
#: baseline, and this many seconds over it. The factor alone would flag a
#: 20 ms stage that drifted to 50; the margin alone would let a 0.2 s stage
#: become 0.6. Both together catch what this gate is for -- a stage that grew
#: by an order, an accidental O(n^2), a lost early exit -- and leave the
#: machine's own third-of-a-run spread well inside.
PERF_FACTOR = 2.0
PERF_MARGIN_S = 0.30
#: Wall time is held too, and loosely. CPU time answers "is the engine doing
#: more work"; it says nothing about a stage that *waits* -- a lock, a poll, a
#: file read -- and the engine now checkpoints inside its loops, which is
#: exactly where a wait could appear. A sleep of one second inside a stage
#: passed the CPU bars untouched while this one catches it. It is wide because
#: wall time is the machine's: another process can take a third of a run.
PERF_WALL_FACTOR = 3.0
PERF_WALL_MARGIN_S = 1.00


def _perf_slower(was: dict[str, float], now: dict[str, float]) -> list[str]:
    """Which clocks say this stage got slower, worded for the report.

    A clock has to pass **both** its bars before it counts, so neither the
    clock's own step (Windows counts process CPU in 15.6 ms) nor the
    machine's ordinary spread can fail a stage by itself: on this machine a
    stage that did not change lands within about 1.1x of its baseline.
    """
    reasons = []
    if now["cpu"] > was["cpu"] * PERF_FACTOR and now["cpu"] > was["cpu"] + PERF_MARGIN_S:
        reasons.append(f"CPU {was['cpu']:.3f} -> {now['cpu']:.3f} s")
    if (now["wall"] > was["wall"] * PERF_WALL_FACTOR
            and now["wall"] > was["wall"] + PERF_WALL_MARGIN_S):
        reasons.append(f"wall {was['wall']:.3f} -> {now['wall']:.3f} s")
    return reasons


def _stage_times(path: Path, runs: int) -> tuple[str, dict[str, dict[str, float]]]:
    """The engine taken, and what each announced stage cost in CPU and in wall
    seconds, each the fastest of ``runs`` analyses.

    Stage boundaries are the engine's own progress messages, so this measures
    what the user is told is happening; a message no stage is named for is
    left out, which shows up as a stage gone rather than as time hidden. The
    first mark is the call itself, so ``total`` covers the decode and the
    stages together. Each clock takes its own minimum: they answer different
    questions and a run can be the fastest on one and not the other.
    """
    best: dict[str, dict[str, float]] = {}
    engine = ""
    for _ in range(runs):
        marks: list[tuple[str, float, float]] = [("", time.process_time(), time.perf_counter())]
        analysis = ta.analyze_audio(
            str(path),
            progress=lambda m: marks.append((m, time.process_time(), time.perf_counter())))
        marks.append(("", time.process_time(), time.perf_counter()))
        engine = str(analysis.engine)
        run: dict[str, dict[str, float]] = {}
        for (message, cpu0, wall0), (_next, cpu1, wall1) in zip(marks[1:], marks[2:]):
            name = wb.stage_id(message)
            if name is None:
                continue
            into = run.setdefault(name, {"cpu": 0.0, "wall": 0.0})
            into["cpu"] += cpu1 - cpu0
            into["wall"] += wall1 - wall0
        run["total"] = {"cpu": marks[-1][1] - marks[0][1],
                        "wall": marks[-1][2] - marks[0][2]}
        for name, clocks in run.items():
            kept = best.setdefault(name, dict(clocks))
            for clock, seconds in clocks.items():
                kept[clock] = min(kept[clock], seconds)
    return engine, best


def perf(names: list[str], audio_dir: Path, runs: int, update: bool) -> int:
    """Hold every stage of an analysis to the cost it had when pinned.

    The accuracy gates would all stay green if a stage became ten times
    slower; nothing else here would notice until someone waited. Times are the
    machine's, so the baseline is this machine's and the bars are wide: this
    catches a stage that grew by an order, not a percent.

    The timing itself happens in a single-threaded child process (see
    ``PERF_ENV``); this is still one command, which is what the repo asks of
    a gate.
    """
    if os.environ.get(PERF_PINNED) != "1":
        argv = [sys.executable, str(Path(__file__).resolve()), "perf",
                "--runs", str(runs), "--dir", str(audio_dir)]
        if update:
            argv.append("--update")
        if names != list(PERF_CASES):
            argv += ["--only", *names]
        return subprocess.call(argv, env={**os.environ, **PERF_ENV, PERF_PINNED: "1"})

    baseline = {}
    if PERF_SNAPSHOT.exists():
        pinned = json.loads(PERF_SNAPSHOT.read_text(encoding="utf-8"))
        if pinned.get("format") != PERF_FORMAT:
            if not update:
                print(f"{PERF_SNAPSHOT.name} was written in an older shape "
                      f"(format {pinned.get('format')}, this reads {PERF_FORMAT}). "
                      "Pin it again with --update and say so in timeline.md.")
                return 1
        else:
            baseline = pinned.get("cases", {})
    if not baseline and not update:
        print(f"No baseline at {PERF_SNAPSHOT.name}. Create it with --update, then commit it.")
        return 1

    current, failures = {}, []
    print(f"seconds per stage, fastest of {runs} run(s), single-threaded; a stage fails past "
          f"{PERF_FACTOR:g}x and +{PERF_MARGIN_S:g} s of CPU,\nor {PERF_WALL_FACTOR:g}x "
          f"and +{PERF_WALL_MARGIN_S:g} s of wall")
    print(f"\n{'case / stage':<26} {'CPU was':>8} {'now':>8} {'wall was':>9} {'now':>8}  verdict")
    print("-" * 72)
    for name in names:
        path = audio_dir / f"{name}.wav"
        if not path.exists():
            if name == "_ramp":
                bm.build_ramp(path, 120.0, 160.0, 60.0)
            else:
                bm.build_track(path, seed=zlib.crc32(name.encode()), **bm.CASES[name])
        engine, measured = _stage_times(path, runs)
        current[name] = {"engine": engine,
                         "stages": {stage: {c: round(s, 3) for c, s in clocks.items()}
                                    for stage, clocks in measured.items()}}
        want = baseline.get(name)
        print(f"{name} ({engine})")
        if want is None:
            for stage, clocks in measured.items():
                print(f"  {stage:<24} {'-':>8} {clocks['cpu']:>8.3f} {'-':>9} "
                      f"{clocks['wall']:>8.3f}  {'new' if update else 'NO BASELINE'}")
            if not update:
                failures.append(f"{name}: no baseline entry")
            continue
        if want["engine"] != engine:
            failures.append(f"{name}: engine {want['engine']} -> {engine}")
            print(f"  {'':<24} {'':>8} {'':>8} {'':>9} {'':>8}  "
                  f"ENGINE {want['engine']} -> {engine}")
        for stage, clocks in measured.items():
            was = want["stages"].get(stage)
            if was is None:
                print(f"  {stage:<24} {'-':>8} {clocks['cpu']:>8.3f} {'-':>9} "
                      f"{clocks['wall']:>8.3f}  new stage")
                continue
            slow = _perf_slower(was, clocks)
            for line in slow:
                failures.append(f"{name}/{stage}: {line}")
            print(f"  {stage:<24} {was['cpu']:>8.3f} {clocks['cpu']:>8.3f} "
                  f"{was['wall']:>9.3f} {clocks['wall']:>8.3f}  "
                  f"{'SLOWER' if slow else 'ok'}")
        for stage, was in want["stages"].items():
            if stage not in measured:
                failures.append(f"{name}/{stage}: stage gone")
                print(f"  {stage:<24} {was['cpu']:>8.3f} {'-':>8} {was['wall']:>9.3f} "
                      f"{'-':>8}  GONE")

    if update:
        PERF_SNAPSHOT.write_text(
            json.dumps({"_comment": "CPU and wall seconds per stage on the machine that "
                                    "pinned it, single-threaded; bench/gates.py perf "
                                    "--update rewrites it",
                        "format": PERF_FORMAT, "runs": runs, "cases": current}, indent=1) + "\n",
            encoding="utf-8")
        print(f"\nWrote {PERF_SNAPSHOT.name} for {len(current)} case(s). "
              "Say in timeline.md why the cost changed.")
        return 0
    if failures:
        print("\nperf FAILED:")
        for line in failures:
            print(f"  {line}")
        return 1
    print(f"\nperf: {len(names)} case(s), every stage inside its budget")
    return 0


# ---------------------------------------------------------------------------
# Compilation builder — what the shift has to preserve (Phase 25, row 25.17)
# ---------------------------------------------------------------------------

#: What the gate compiles, and why these three: a whole BPM; 222.222, whose
#: beat length is a repeating decimal, taken from the middle of its song so
#: its grid has to be pinned by the builder rather than carried; and a case
#: with four red lines, so the bookkeeping is not measured on one.
COMBINE_PLAN = ({"case": "edm-174", "sample": b"RIFFedm-174 clap"},
                {"case": "odd-222.22", "start_ms": 20000.0, "end_ms": 40000.0},
                {"case": "secs-4", "multiplier": "2.0", "sample": b"RIFFsecs-4 clap"})

#: Beats between two objects of a source map. Objects are stored whole, which
#: is how osu!stable writes them, so they sit up to half a millisecond off
#: their own beat before this builder touches anything.
COMBINE_BEATS_APART = 4

#: Mutants of a source map the gate throws at the reader. It must come back
#: with repairs or a refusal — never with anything but a ValueError.
COMBINE_MUTANTS = 60


def _combine_source(folder: Path, case: str, multiplier: str = "1.4",
                    sample: bytes | None = None) -> Path:
    """A map on ``case``'s own audio: the golden vector's red lines, circles on
    their beats from end to end, a green asking for custom sample index 3, a
    break and bookmarks. ``sample`` writes that index's file, so two sources
    can ask for one filename with two different sounds in it."""
    vector = json.loads((HERE / "golden" / f"{case}.json").read_text(encoding="utf-8"))
    points = [(float(p["offset_ms"]), float(p["bpm"]))
              for p in vector["result"]["points"] if float(p["bpm"]) > 0]
    end_ms = float(vector["result"]["duration_s"]) * 1000.0 - 500.0
    reds, objects = [], []
    for n, (offset, bpm) in enumerate(points):
        beat = 60000.0 / bpm
        stop = points[n + 1][0] if n + 1 < len(points) else end_ms
        reds.append(f"{offset:.3f},{beat:.12f},4,2,0,80,1,0")
        # One beat in, so rounding the object to a whole millisecond cannot
        # put it before the red line it belongs to.
        time = offset + beat
        while time < min(stop, end_ms):
            objects.append(f"100,100,{round(time)},1,0,0:0:0:0:")
            time += COMBINE_BEATS_APART * beat
    first, beat = points[0][0], 60000.0 / points[0][1]
    marks = [round(first + 16 * beat), round(first + 32 * beat)]
    folder.mkdir(parents=True, exist_ok=True)
    lines = ["osu file format v14", "",
             "[General]", f"AudioFilename: {case}.wav", f"PreviewTime: {marks[0]}",
             "Mode: 0", "StackLeniency: 0.7", "",
             "[Editor]", f"Bookmarks: {marks[0]},{marks[1]}", "",
             "[Metadata]", f"Title:{case}", "Artist:Overtone", "Creator:gates",
             f"Version:{case}", "Tags:gate", "",
             "[Difficulty]", "HPDrainRate:5", "CircleSize:4", "OverallDifficulty:7",
             "ApproachRate:9", f"SliderMultiplier:{multiplier}", "SliderTickRate:1", "",
             "[Events]", f"2,{marks[0] + 400},{marks[1] - 400}", "",
             "[TimingPoints]", *reds,
             f"{round(first + 8 * beat)},-125,4,3,3,60,0,1", "",
             "[HitObjects]", *objects, ""]
    path = folder / f"{case}.osu"
    path.write_bytes("\r\n".join(lines).encode("utf-8"))
    if sample is not None:
        (folder / "soft-hitclap3.wav").write_bytes(sample)
    return path


def _beat_lengths(beatmap: dict) -> set:
    """Every red line's beat length, exactly as the file writes it."""
    lines = next(s["lines"] for s in beatmap["sections"] if s["name"] == "TimingPoints")
    return {line.split(",")[1].strip() for line in lines
            if line.strip() and ta._is_red_line(line.strip())}


def _governing(beatmap: dict, at_ms: float) -> tuple[float, float]:
    """The red line in force at a time, as ``(offset, beat length)``."""
    reds = sorted((p for p in (ta._timing_point_fields(line.strip())
                               for line in next(s["lines"] for s in beatmap["sections"]
                                                if s["name"] == "TimingPoints")
                               if line.strip() and not line.strip().startswith("//"))
                   if p is not None and p["red"] and p["beat_length"] > 0),
                  key=lambda p: p["time"])
    use = next((p for p in reversed(reds) if p["time"] <= at_ms + 1e-6), reds[0])
    return use["time"], use["beat_length"]


def combine(audio_dir: Path) -> int:
    """Three maps on three songs compiled into one, then measured against them.

    The claim the whole phase rests on is that an object keeps the place it
    had in its own segment and the grid under it keeps the phase its mapper
    set. So the gate recomputes both from the sources instead of believing the
    report: every object's offset from its segment's start, every red line's
    beat length digit for digit, the distance from each object to its own
    governing red line in beats, and the result's own snap audit — which is
    the question a mapper would actually ask of a compilation.

    Then the same reader is handed 60 mutants of a source map, because the
    tool this phase was asked against ends in a traceback on input that is
    merely ordinary.
    """
    import tempfile

    print("A compilation of three songs, measured against the maps it borrowed from.")
    print("Object offsets inside a segment, red-line beat lengths, the phase of each")
    print("object in its own beat, and the result's snap audit: a shift that moves")
    print("one of them is a shift that broke somebody's map.\n")
    failures: list[str] = []

    def check(label: str, ok: bool, detail: str) -> None:
        if not ok:
            failures.append(f"{label}: {detail}")
        print(f"  {label:<46} {'ok' if ok else 'FAIL'}  {detail}")

    def verdict() -> int:
        if failures:
            print("\ncombine FAILED:")
            for line in failures:
                print(f"  {line}")
            return 1
        print("\nGate passed: every borrowed object and every grid came through intact.")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        sources = []
        for spec in COMBINE_PLAN:
            case = spec["case"]
            audio = audio_dir / f"{case}.wav"
            if not audio.exists():
                bm.build_track(audio, seed=zlib.crc32(case.encode()), **bm.CASES[case])
            source = {"osu": str(_combine_source(Path(tmp) / case, case,
                                                 spec.get("multiplier", "1.4"),
                                                 spec.get("sample"))),
                      "audio": str(audio)}
            source.update({k: v for k, v in spec.items()
                           if k not in ("case", "multiplier", "sample")})
            sources.append(source)
        plan = tc.plan_compilation(sources)
        print(f"plan: {plan['totals']['segments']} segments, "
              f"{plan['totals']['duration_ms'] / 1000.0:.1f} s, "
              f"{plan['totals']['objects']} objects, "
              f"{plan['totals']['reds']} red lines, "
              f"{len(plan['repairs'])} repair(s)")
        for repair in plan["repairs"]:
            print(f"  repair   segment {repair['segment']}  {repair['code']}")
        check("the plan is usable", plan["usable"],
              "; ".join(r["code"] for r in plan["refusals"]) or "no refusals")
        if not plan["usable"]:
            return verdict()

        text, report = tc.combine_beatmap(plan, audio_name="combined.wav")
        out = Path(tmp) / "combined.osu"
        out.write_bytes(text.encode("utf-8"))
        built = ta.read_osu_beatmap(out)
        theirs = _beat_lengths(built)
        print()

        worst_place, worst_phase, written = 0.0, 0.0, 0
        for n, segment in enumerate(plan["segments"]):
            source = ta.read_osu_beatmap(segment["osu"])
            start, end = segment["range"]["start_ms"], segment["range"]["end_ms"]
            at, shift = segment["at_ms"], segment["shift_ms"]
            kept = sorted(float(o["time"]) for o in source["hitobjects"]
                          if start - 1e-6 <= float(o["time"]) <= end + 1e-6)
            mine = sorted(float(o["time"]) for o in built["hitobjects"]
                          if at - 1e-6 <= float(o["time"]) <= segment["ends_at_ms"] + 1e-6)
            place = max((abs((b - at) - (s - start)) for s, b in zip(kept, mine)),
                        default=0.0)
            phase = 0.0
            for source_time, built_time in zip(kept, mine):
                red, beat = _governing(source, source_time)
                built_red, built_beat = _governing(built, built_time)
                if abs(built_beat - beat) > 1e-9:
                    phase = float("inf")
                    break
                off = ((built_time - built_red) - (source_time - red) + beat / 2) % beat
                phase = max(phase, abs(off - beat / 2))
            worst_place, worst_phase = max(worst_place, place), max(worst_phase, phase)
            written += len(mine)
            print(f"segment {n} ({Path(segment['osu']).stem}): {len(kept)} objects, "
                  f"at {at / 1000.0:.1f} s, shift {shift:+.0f} ms, "
                  f"{'pinned' if start > _governing(source, start)[0] else 'carried'} grid")
            check(f"segment {n}: every object kept its place",
                  len(kept) == len(mine) and place <= 1e-9,
                  f"{len(mine)} written, worst {place:.2e} ms off")
            check(f"segment {n}: every object kept its phase", phase <= 0.001,
                  f"worst {phase:.2e} ms from its own beat")
            missing = _beat_lengths(source) - theirs
            check(f"segment {n}: its beat lengths, digit for digit", not missing,
                  f"{len(_beat_lengths(source))} beat length(s), {len(missing)} missing")

        print()
        check("every object of every segment was written",
              written == plan["totals"]["objects"],
              f"{written} of {plan['totals']['objects']}")
        audit = ta.snap_audit(built, duration_s=plan["totals"]["duration_ms"] / 1000.0)
        check("nothing came off the grid", bool(audit["ok"]) and not audit["unsnapped"],
              f"{len(audit.get('unsnapped', []))} unsnapped of {audit['objects']}")
        check("no object before its own grid", not audit["before_first_red"],
              f"{len(audit['before_first_red'])} before the first red line")
        check("no object past the audio", not audit["past_audio"],
              f"{len(audit['past_audio'] or [])} past "
              f"{plan['totals']['duration_ms'] / 1000.0:.1f} s")
        times = [float(o["time"]) for o in built["hitobjects"]]
        check("objects in time order", times == sorted(times), f"{len(times)} objects")
        check("the writer gives the text back", ta.beatmap_text(built) == text,
              f"{len(text)} characters")
        check("the result says what later rows still owe",
              {entry["row"] for entry in report["pending"]}
              == {"25.13"},
              ", ".join(sorted(entry["row"] for entry in report["pending"])))

        # The difficulty: one set of numbers, and the slider speed the
        # segments that did not choose them keep anyway.
        print()
        settled = report["difficulty"]
        print("difficulty: " + ", ".join(f"{field} {value:g}"
                                         for field, value in settled["values"].items()))
        lines = [row for row in next(s["lines"] for s in built["sections"]
                                     if s["name"] == "TimingPoints") if row.strip()]
        reds = [row for row in lines if ta._is_red_line(row)]
        greens = {round(float(row.split(",")[0]), 3): -100.0 / float(row.split(",")[1])
                  for row in lines if not ta._is_red_line(row)}
        floor = 0.0
        for n, segment in enumerate(plan["segments"]):
            ratio = settled["segments"][n]["sv_ratio"]
            mine = [float(row.split(",")[0]) for row in reds
                    if floor - 1e-6 <= float(row.split(",")[0]) <= segment["ends_at_ms"]]
            floor = segment["ends_at_ms"]
            if abs(ratio - 1.0) <= 1e-9:
                # These sources put their own green eight beats in, never on
                # a red line, so a green on one would be this builder's.
                check(f"segment {n}: its own multiplier, nothing added",
                      all(round(at, 3) not in greens for at in mine),
                      f"{len(mine)} red line(s), no green invented")
                continue
            held = [at for at in mine
                    if abs(greens.get(round(at, 3), 0.0) - ratio) <= 1e-6]
            check(f"segment {n}: every red is followed by its {ratio:.4g}x",
                  len(held) == len(mine) and bool(mine),
                  f"{len(held)} of {len(mine)} red line(s) carry it")
        differing = {field for row in settled["segments"]
                     for field in row["deviations"]}
        check("what a segment gave up is named", "slider_multiplier" in differing,
              ", ".join(sorted(differing)) or "nothing differs")
        check("a break covers every junction",
              report["junction_breaks"] == len(plan["junctions"]),
              f"{report['junction_breaks']} of {len(plan['junctions'])} junction(s), "
              f"{report['breaks']} break(s) in the file")
        check("a bookmark marks every segment",
              report["bookmarks"] >= len(plan["segments"]),
              f"{report['bookmarks']} bookmark(s) for "
              f"{len(plan['segments'])} segment(s)")

        # The hitsounds: two sources asked for one filename with two
        # different sounds in it, and both have to survive.
        print()
        samples = tc.sample_plan(plan)
        maps = [row["index_map"] for row in samples["segments"]]
        wanted = [set(row.values()) for row in maps]
        check("every segment got its own sample indices",
              all(not (a & b) for n, a in enumerate(wanted) for b in wanted[n + 1:]),
              f"{maps}")
        asked = [row.split(",")[4] for row in
                 next(s["lines"] for s in built["sections"]
                      if s["name"] == "TimingPoints") if row.strip()]
        check("the written lines ask for the new indices",
              set(asked) >= {str(v) for row in maps for v in row.values()},
              f"indices in the file: {sorted(set(asked))}")
        bank = Path(tmp) / "bank"
        copied = tc.build_samples(plan, bank, samples)
        names = sorted(path.name for path in bank.iterdir())
        bodies = {path.name: path.read_bytes() for path in bank.iterdir()}
        check("both custom samples were copied, neither replaced",
              len(names) == 2 and len(set(bodies.values())) == 2,
              f"{names}, {copied['copied']} copied, {copied['bytes']} bytes")
        check("no source folder was written to",
              all(not any(p.name.startswith("soft-hitclap") and p.name != "soft-hitclap3.wav"
                          for p in Path(source["osu"]).parent.iterdir())
                  for source in sources),
              "sources hold only their own samples")

        # The audio: lossless first, because it can be compared sample for
        # sample, then the format the builder actually writes.
        print()
        for name in ("wav", "mp3"):
            audio = Path(tmp) / f"combined.{name}"
            started = time.perf_counter()
            built = tc.build_audio(plan, audio, audio_format=name)
            spent = time.perf_counter() - started
            landed = tc.verify_audio(plan, audio)
            frame_ms = 1000.0 / built["sample_rate"]
            print(f"{name}: {built['duration_ms'] / 1000.0:.1f} s, "
                  f"{built['bytes'] / 1e6:.1f} MB, {built['sample_rate']} Hz "
                  f"x{built['channels']}, written in {spent:.1f} s, "
                  f"checked in {time.perf_counter() - started - spent:.1f} s")
            check(f"{name}: as long as the plan says",
                  abs(built["duration_ms"] - built["planned_ms"]) <= frame_ms,
                  f"{built['duration_ms']:.3f} ms written, "
                  f"{built['planned_ms']:.3f} planned")
            check(f"{name}: every segment landed where the plan put it",
                  landed["ok"], f"worst {landed['worst_shift_ms']} ms, peaks "
                  + ", ".join(f"{row['peak']}" for row in landed["segments"]))
            if name == "wav":
                # Nothing is normalised, filtered or mixed: past the 5 ms
                # declick ramp it is the sources' own samples.
                same = True
                for n, segment in enumerate(plan["segments"]):
                    rate = built["sample_rate"]
                    fade = int(round(built["segments"][n]["declick_ms"] * rate / 1000.0))
                    at = int(round(segment["at_ms"] * rate / 1000.0))
                    start = int(round(segment["range"]["start_ms"] * rate / 1000.0))
                    length = built["segments"][n]["frames"]
                    mine = sf.read(str(audio), dtype="float32", always_2d=True,
                                   start=at + fade, stop=at + length - fade)[0]
                    theirs = sf.read(segment["audio"]["path"], dtype="float32",
                                     always_2d=True, start=start + fade,
                                     stop=start + length - fade)[0]
                    same = same and mine.shape == theirs.shape \
                        and bool(np.array_equal(mine, theirs))
                check("wav: the samples written are the samples read", same,
                      "bit for bit past the declick ramp")
            print()

        # And the whole thing: a folder somebody could drop into osu!, with
        # the build checking itself afterwards.
        shown = tc.build_compilation(plan, Path(tmp) / "set", dry_run=True)
        check("a dry run writes nothing", not (Path(tmp) / "set").exists(),
              f"{len(shown['files'])} file(s) it would write")
        # The fourth check too (row 25.15): the attacks of the audio that was
        # built, against the red lines the compilation wrote.
        whole = tc.build_compilation(plan, Path(tmp) / "set", osz=True, grade=True)
        there = sorted(path.name for path in (Path(tmp) / "set").iterdir()
                       if path.suffix.lower() != ".osz")
        print(f"mapset: {whole['osu']}")
        print("        " + ", ".join(f"{entry['name']} ({entry['bytes']} B)"
                                     for entry in whole["files"]))
        check("the folder holds what the report says",
              there == sorted(entry["name"] for entry in whole["files"]),
              f"{len(there)} file(s)")
        check("the .osz holds them flat",
              bool(whole["osz"]) and whole["osz"]["bytes"] > 0,
              f"{whole['osz']['name']} ({whole['osz']['bytes']} B)")
        credits = (Path(tmp) / "set" / tc.CREDITS_NAME).read_text(encoding="utf-8")
        check("every mapper is credited",
              all(mapper in credits for mapper in whole["metadata"]["mappers"]),
              ", ".join(whole["metadata"]["mappers"]) or "no mapper named in any source")
        checks = whole["checks"]
        check("the build checks itself and passes", bool(checks["ok"]),
              f"snap {checks['snap']}, audio {checks['audio']['worst_shift_ms']} ms, "
              f"round trip {checks['round_trip']}")
        graded = checks["grade"]
        check("every red line still sits on the built audio's attacks",
              bool(graded) and bool(graded["ok"])
              and not (graded["counts"] or {}).get("check"),
              f"{graded['counts'] if graded else None}, worst "
              f"{graded['worst_ms'] if graded else None} ms, shift "
              f"{graded['common_offset_ms'] if graded else None} ms")

        print()
        rng = random.Random(7)
        seed_text = Path(sources[0]["osu"]).read_bytes().decode("utf-8")
        read, refused, crashed = 0, 0, 0
        for n in range(COMBINE_MUTANTS):
            mutant = Path(tmp) / f"mutant{n}.osu"
            mutant.write_bytes(fuzz.mutate(seed_text, rng))
            try:
                segment = tc.read_segment(mutant, audio=sources[0]["audio"])
            except ValueError:
                refused += 1
            except Exception as exc:  # noqa: BLE001 -- the gate reports crashes
                crashed += 1
                print(f"  mutant {n}: {type(exc).__name__}: {exc}"[:110])
            else:
                read += 1
                refused += 0 if segment["usable"] else 1
        check(f"{COMBINE_MUTANTS} mutant maps read or refused", crashed == 0,
              f"{read} read ({refused} of them refused), {crashed} crashed")

    return verdict()


#: The rate the gate copies at. 1.37x is off every simple fraction, so a copy
#: that merely divides and rounds each timestamp on its own lands a
#: millisecond off the new grid — which is the decay this phase exists to
#: avoid, and what the beat-phase rows below would catch.
TRAIN_RATE = 1.37

#: The worst a copy may sit from the beat it was on. Whole-millisecond times
#: round by up to half a millisecond each side of their red line's own
#: rounding, so 1.0 ms is the rounding bound, not a number tuned to a
#: fixture; in beats it is that bound over the shortest scaled beat here.
TRAIN_WORST_MS = 1.0
TRAIN_WORST_BEATS = 0.01

#: Mutants of a source map the gate throws at the plan. It must come back
#: with repairs or a refusal — never with anything but a ValueError.
TRAIN_MUTANTS = 60


def _train_source(folder: Path) -> Path:
    """One map on its own audio: two tempi (so a target BPM must choose), a
    green asking for a custom sample, a spinner, a slider, a break and
    bookmarks. ``BeatmapID``/``BeatmapSetID`` are already blank and ``Tags``
    already carry the copy's own words, so at 1.0x the only line that may
    move is the version."""
    folder.mkdir(parents=True, exist_ok=True)
    lines = ["osu file format v14", "",
             "[General]", "AudioFilename: train.wav", "PreviewTime: 8000",
             "Mode: 0", "StackLeniency: 0.7", "",
             "[Editor]", "Bookmarks: 4000,8000", "",
             "[Metadata]", "Title:train", "Artist:Overtone", "Creator:gates",
             "Version:train", "Tags:gate gates 1x practice", "BeatmapID:0",
             "BeatmapSetID:-1", "",
             "[Difficulty]", "HPDrainRate:5", "CircleSize:4", "OverallDifficulty:7",
             "ApproachRate:9", "SliderMultiplier:1.4", "SliderTickRate:1", "",
             "[Events]", "2,3000,4000", "",
             "[TimingPoints]", "1000,400,4,2,0,80,1,0", "2000,-100,4,2,1,70,0,1",
             "20000,500,4,2,0,80,1,0", "",
             "[HitObjects]", "100,100,1400,1,0,0:0:0:0:",
             "200,200,2000,2,0,L|300:200,1,100,0|0,0:0|0:0,0:0:0:0:",
             "256,192,5000,12,0,7000,0:0:0:0:", "64,64,21000,1,0,0:0:0:0:", ""]
    path = folder / "train.osu"
    path.write_bytes("\r\n".join(lines).encode("utf-8"))
    return path


def train(audio_dir: Path) -> int:
    """One map at 1.0x and at 1.37x, measured against the map it came from.

    The claim the whole phase rests on is that an object keeps the beat it
    had: the rate goes on the **grid**, so the gate recomputes each object's
    beat phase from the source instead of believing the report. A 1.0x copy
    changes nothing bar the version line; at 1.37x every object sits on the
    beat it sat on to a pinned bound; the AR/OD round trips hold; a target
    BPM on two tempi refuses until the tempo it means is picked; and 60
    mutants of the source either read or refuse without a traceback. Then the
    song: resampled in process at 1.37x, the folder built to MP3 with an
    `.osz`, and the written red line graded against the written audio.
    """
    import tempfile

    print("A practice copy of one map, measured against the map it came from.")
    print("The 1.0x round trip, every beat phase at 1.37x, the AR/OD round")
    print("trips, a target BPM refused on two tempi, and the fuzzed sources.\n")
    failures: list[str] = []

    def check(label: str, ok: bool, detail: str) -> None:
        if not ok:
            failures.append(f"{label}: {detail}")
        print(f"  {label:<46} {'ok' if ok else 'FAIL'}  {detail}")

    def verdict() -> int:
        if failures:
            print("\ntrain FAILED:")
            for line in failures:
                print(f"  {line}")
            return 1
        print("\nGate passed: the copy kept every beat it borrowed.")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        source = _train_source(Path(tmp) / "source")
        before = source.read_bytes()

        plan = tr.plan_practice(source, rate=1.0)
        check("the 1.0x plan is usable", plan["usable"],
              "; ".join(r["code"] for r in plan["refusals"]) or "no refusals")
        if not plan["usable"]:
            return verdict()
        text, report = tr.practice_beatmap(plan)
        after = text.encode("utf-8")
        changed = [line for line in
                   __import__("difflib").unified_diff(
                       before.decode("utf-8").split("\r\n"),
                       text.split("\r\n"), lineterm="")
                   if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))]
        check("1.0x changes nothing bar the version line",
              all(line.startswith("+Version:") or line == "-Version:train"
                  for line in changed) and len(changed) == 2,
              f"{len(changed)} line(s) differ")
        check("1.0x keeps every beat exactly",
              report["worst_beat_error"] == 0.0 and report["worst_ms_error"] == 0.0,
              f"{report['worst_beat_error']:.2e} beats, {report['worst_ms_error']:.2e} ms")

        plan = tr.plan_practice(source, rate=TRAIN_RATE)
        check(f"the {TRAIN_RATE:g}x plan is usable", plan["usable"],
              "; ".join(r["code"] for r in plan["refusals"]) or "no refusals")
        if not plan["usable"]:
            return verdict()
        text, report = tr.practice_beatmap(plan)
        check(f"every object kept its beat at {TRAIN_RATE:g}x",
              report["worst_beat_error"] <= TRAIN_WORST_BEATS
              and report["worst_ms_error"] <= TRAIN_WORST_MS,
              f"worst {report['worst_beat_error']:.2e} beats, "
              f"{report['worst_ms_error']:.2e} ms")
        out = Path(tmp) / "copy.osu"
        out.write_bytes(text.encode("utf-8"))
        built = ta.read_osu_beatmap(out)
        audit = ta.snap_audit(built, duration_s=21000.0 / TRAIN_RATE / 1000.0 + 2.0)
        check("nothing came off the grid", bool(audit["ok"]) and not audit["unsnapped"],
              f"{len(audit.get('unsnapped', []))} unsnapped of {audit['objects']}")
        check("the writer gives the text back", ta.beatmap_text(built) == text,
              f"{len(text)} characters")
        reds = sorted(float(line.split(",")[1]) for line in
                      next(s["lines"] for s in built["sections"]
                           if s["name"] == "TimingPoints")
                      if line.strip() and ta._is_red_line(line.strip()))
        check("both beat lengths scaled exactly",
              len(reds) == 2 and all(abs(got - want) < 5e-7
                                     for got, want in zip(
                                         reds, sorted([400.0 / TRAIN_RATE, 500.0 / TRAIN_RATE]))),
              f"{reds}")

        print()
        round_tripped = True
        for ar in [float(a) / 2 for a in range(0, 21)]:
            if abs(tr.ms_to_ar(tr.ar_to_ms(ar)) - ar) > 1e-9:
                round_tripped = False
        for od in [float(o) / 2 for o in range(0, 21)]:
            if abs(tr.ms_to_od(tr.od_to_ms(od)) - od) > 1e-9:
                round_tripped = False
        check("the AR/OD round trips hold", round_tripped, "AR/OD 0-10 in halves")

        refused = tr.plan_practice(source, target_bpm=200)
        codes = {r["code"] for r in refused["refusals"]}
        check("a target BPM on two tempi refuses until one is picked",
              not refused["usable"] and "ambiguous_target" in codes,
              "; ".join(sorted(codes)) or "usable")
        picked = tr.plan_practice(source, target_bpm=200, from_bpm=120)
        check("picking the tempo resolves the rate", picked["usable"]
              and abs(picked["rate"] - 200.0 / 120.0) < 1e-9,
              f"rate {picked['rate']}" if picked["usable"] else
              "; ".join(r["code"] for r in picked["refusals"]))

        print()
        rng = random.Random(7)
        seed_text = source.read_bytes().decode("utf-8")
        read, refused_count, crashed = 0, 0, 0
        for n in range(TRAIN_MUTANTS):
            mutant = Path(tmp) / f"mutant{n}.osu"
            mutant.write_bytes(fuzz.mutate(seed_text, rng))
            try:
                practice = tr.plan_practice(mutant, rate=TRAIN_RATE)
            except ValueError:
                refused_count += 1
            except Exception as exc:  # noqa: BLE001 -- the gate reports crashes
                crashed += 1
                print(f"  mutant {n}: {type(exc).__name__}: {exc}"[:110])
            else:
                read += 1
                refused_count += 0 if practice["usable"] else 1
        check(f"{TRAIN_MUTANTS} mutant maps read or refused", crashed == 0,
              f"{read} read ({refused_count} of them refused), {crashed} crashed")

        # And the song: resampled in process, the copy graded against it.
        print()
        song = Path(tmp) / "song"
        song.mkdir()
        rate_hz = 44100
        y = np.zeros(rate_hz * 20, dtype="float32")
        n = int(0.04 * rate_hz)
        t = np.arange(n) / rate_hz
        kick = (np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.006)).astype("float32")
        at = 1.0
        while at < 19.0:
            y[int(at * rate_hz):int(at * rate_hz) + n] += kick
            at += 0.4
        sf.write(str(song / "song.wav"), y, rate_hz)
        step = int(round(0.4 * 4 * 1000))
        (song / "clicks.osu").write_bytes("\r\n".join(
            ["osu file format v14", "",
             "[General]", "AudioFilename: song.wav", "AudioLeadIn: 0",
             "PreviewTime: 1000", "Mode: 0", "",
             "[Editor]", "Bookmarks: 1000", "",
             "[Metadata]", "Title:Clicks", "Artist:Overtone", "Creator:gates",
             "Version:150", "Tags:gate", "BeatmapID:0", "BeatmapSetID:-1", "",
             "[Difficulty]", "HPDrainRate:5", "CircleSize:4", "OverallDifficulty:7",
             "ApproachRate:9", "SliderMultiplier:1.4", "SliderTickRate:1", "",
             "[Events]", "",
             "[TimingPoints]", "1000,400,4,2,0,80,1,0", "",
             "[HitObjects]",
             *[f"100,100,{t},1,0,0:0:0:0:" for t in range(1400, 19000, step)],
             ""]).encode("utf-8"))
        audio_plan = tr.plan_practice(song / "clicks.osu", rate=TRAIN_RATE)
        check(f"the click map plans at {TRAIN_RATE:g}x", audio_plan["usable"],
              "; ".join(r["code"] for r in audio_plan["refusals"]) or "no refusals")
        if not audio_plan["usable"]:
            return verdict()
        whole = tr.build_practice(audio_plan, Path(tmp) / "set", audio_format="mp3",
                                  osz=True, grade=True)
        there = sorted(path.name for path in (Path(tmp) / "set").iterdir()
                       if path.suffix.lower() != ".osz")
        check("the folder holds what the report says",
              there == sorted(entry["name"] for entry in whole["files"]),
              f"{len(there)} file(s)")
        check("the .osz holds them flat",
              bool(whole["osz"]) and whole["osz"]["bytes"] > 0,
              f"{whole['osz']['name']} ({whole['osz']['bytes']} B)")
        checks = whole["checks"]
        check("the build checks itself and passes", bool(checks["ok"]),
              f"audio shift {checks['audio']['shift_ms']} ms, "
              f"round trip {checks['round_trip']}")
        check("the encoder delay is nothing to compensate",
              bool(checks["audio"]["gapless"].get("present")),
              f"LAME delay {checks['audio']['gapless'].get('delay_ms')} ms, "
              f"shift {checks['audio']['shift_ms']} ms")
        graded = checks["grade"]
        check("every red line still sits on the resampled attacks",
              bool(graded) and bool(graded["ok"])
              and not (graded["counts"] or {}).get("check"),
              f"{graded['counts'] if graded else None}, worst "
              f"{graded['worst_ms'] if graded else None} ms, shift "
              f"{graded['common_offset_ms'] if graded else None} ms")

    return verdict()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("gate",
                        choices=("bpm-snapshot", "coverage", "measures", "signatures",
                                 "robustness", "reference", "assisted", "real-audio",
                                 "perf", "combine", "train"))
    parser.add_argument("--only", nargs="*", metavar="CASE",
                        help="bpm-snapshot / real-audio / perf: run just these cases")
    parser.add_argument("--update", action="store_true",
                        help="bpm-snapshot / real-audio / perf: rewrite the baseline")
    parser.add_argument("--runs", type=int, default=PERF_RUNS,
                        help=f"perf: analyses per case, the fastest counting (default {PERF_RUNS})")
    parser.add_argument("--regen", action="store_true", help="re-render fixtures")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"),
                        default="auto")
    parser.add_argument("--dir", default=str(bm.AUDIO_DIR))
    args = parser.parse_args()

    if args.gate == "robustness":
        raise SystemExit(robustness())
    if args.gate == "reference":
        raise SystemExit(reference())
    if args.gate == "assisted":
        raise SystemExit(assisted())
    if args.gate == "real-audio":
        names = args.only or list(REAL_AUDIO)
        unknown = [n for n in names if n not in REAL_AUDIO]
        if unknown:
            print(f"Unknown track(s): {', '.join(unknown)}")
            raise SystemExit(2)
        raise SystemExit(real_audio(names, args.update))
    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)
    if args.gate == "perf":
        names = args.only or list(PERF_CASES)
        unknown = [n for n in names if n not in PERF_CASES]
        if unknown:
            print(f"Unknown case(s): {', '.join(unknown)}\nAvailable: {', '.join(PERF_CASES)}")
            raise SystemExit(2)
        if args.runs < 1:
            print("--runs must be at least 1")
            raise SystemExit(2)
        raise SystemExit(perf(names, audio_dir, args.runs, args.update))
    if args.gate == "combine":
        raise SystemExit(combine(audio_dir))
    if args.gate == "train":
        raise SystemExit(train(audio_dir))
    if args.gate == "bpm-snapshot":
        names = args.only or list(bm.CASES)
        unknown = [n for n in names if n not in bm.CASES]
        if unknown:
            print(f"Unknown case(s): {', '.join(unknown)}")
            raise SystemExit(2)
        raise SystemExit(bpm_snapshot(names, audio_dir, args.engine, args.update))
    if args.gate == "measures":
        raise SystemExit(measures(audio_dir, args.engine, args.regen))
    if args.gate == "signatures":
        raise SystemExit(signatures(audio_dir, args.engine, args.regen))
    raise SystemExit(coverage(audio_dir, args.engine, args.regen))


if __name__ == "__main__":
    main()
