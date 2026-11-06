"""coverage (audit F-11): density changes inside a section are measurable."""
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

from gate_modes.common import COVERAGE_DROP  # noqa: E402


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
