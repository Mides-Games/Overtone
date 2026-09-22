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

Both exit non-zero on failure. Neither renders new audio for the main corpus —
they reuse ``bench/audio/`` — but ``coverage`` has two fixtures of its own,
kept *out* of ``benchmark.CASES`` on purpose so the headline "24/24" stays
exactly comparable to the numbers already published.
"""
from __future__ import annotations

import argparse
import json
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import soundfile as sf  # noqa: E402

import benchmark as bm  # noqa: E402
import timing_analyzer as ta  # noqa: E402

HERE = Path(__file__).resolve().parent
SNAPSHOT = HERE / "bpm_snapshot.json"

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
        print("\nIf a change is intended, say why in timeline.md and re-run with --update.")
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
            note = f"  (meter change at constant tempo not split: {truth} -> {detected})"
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
    print("red line on a downbeat. A meter change without a tempo change is a")
    print("known gap -- see the note above and docs/07-roadmap.md Phase 5.")
    return 0


# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("gate", choices=("bpm-snapshot", "coverage", "measures"))
    parser.add_argument("--only", nargs="*", metavar="CASE",
                        help="bpm-snapshot: run just these cases")
    parser.add_argument("--update", action="store_true",
                        help="bpm-snapshot: rewrite the baseline")
    parser.add_argument("--regen", action="store_true", help="re-render fixtures")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"),
                        default="auto")
    parser.add_argument("--dir", default=str(bm.AUDIO_DIR))
    args = parser.parse_args()

    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)
    if args.gate == "bpm-snapshot":
        names = args.only or list(bm.CASES)
        unknown = [n for n in names if n not in bm.CASES]
        if unknown:
            print(f"Unknown case(s): {', '.join(unknown)}")
            raise SystemExit(2)
        raise SystemExit(bpm_snapshot(names, audio_dir, args.engine, args.update))
    if args.gate == "measures":
        raise SystemExit(measures(audio_dir, args.engine, args.regen))
    raise SystemExit(coverage(audio_dir, args.engine, args.regen))


if __name__ == "__main__":
    main()
