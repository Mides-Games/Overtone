"""Prototype: detect a half- or double-time region inside one reported section.

Audit finding F-11. `_grow_sections` extends a section while `share` holds up,
and `share` cannot move across an exact 2x change because the grid is
continuous — every attack of the slow half still lands on the fast half's
grid. The statistic that *does* move is coverage, which the growth loop
computes and discards.

But coverage alone is not enough, and that is the interesting part. A drop, a
breakdown and a sparse bar all lower coverage too, and none of them is a pulse
change. The discriminator is **parity**: in a half-time region the occupied
grid indices all share one residue mod 2, while in a sparse or dropped region
they are scattered. So:

    coverage  ~0.5   says "half the slots are empty"
    parity    ~1.0   says "and it is every other one, not a random half"

Run it:

    python proto/density.py                  # all corpus fixtures + the 3 density ones
    python proto/density.py --only sparse-160

  Nothing here touches ``overtone.py``: this is a post-hoc detector over
a finished analysis, which is also the shape the v4 feature takes — a
bidirectional pulse hint with confidence, not a silent split.
"""
from __future__ import annotations

import argparse
import sys
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "bench"))

import benchmark as bm  # noqa: E402
import gates  # noqa: E402
import overtone as ta  # noqa: E402

#: Windows are sized in beats of the reported grid. Eight beats is two bars of
#: 4/4 — short enough to localise a change, long enough that one missed hit
#: does not move the statistics.
WINDOW_BEATS = 8
#: Subdivisions of the reported beat to test. The signal is invisible at the
#: beat itself: a half-time region still has an attack on every beat.
SUBDIVISIONS = (2, 4)
#: A window is "thinned" when at most this fraction of slots is filled...
COVERAGE_MAX = 0.70
#: ...and at least this fraction of the filled ones share a residue. Random
#: thinning gives ~0.5 for m=2; an exact half-time gives ~1.0.
PARITY_MIN = 0.85
#: Both sides of a proposed split must be this many windows long.
MIN_RUN = 2


def window_stats(times: np.ndarray, weights: np.ndarray, period: float,
                 phase: float, tol_ratio: float = 0.12) -> tuple[float, float, int]:
    """(coverage, parity concentration at m=2, inlier count) for one window."""
    if times.size == 0 or period <= 0:
        return 0.0, 0.0, 0
    k = np.round((times - phase) / period)
    resid = times - (phase + k * period)
    inlier = np.abs(resid) <= max(tol_ratio * period, 0.006)
    n = int(inlier.sum())
    if n < 4:
        return 0.0, 0.0, n
    ki = k[inlier].astype(np.int64)
    slots = float(np.ptp(ki)) + 1.0
    coverage = min(1.0, len(np.unique(ki)) / max(slots, 1.0))
    # Parity: of the slots that are filled, how concentrated are they on one
    # residue mod 2? Weighted by attack strength so a ghost note counts less.
    wi = weights[inlier].astype(float)
    cls = np.mod(ki, 2)
    totals = np.bincount(cls, weights=wi, minlength=2)
    parity = float(np.max(totals) / max(np.sum(totals), 1e-9))
    return coverage, parity, n


def scan(analysis, window_beats: int = WINDOW_BEATS) -> list[dict]:
    """Propose (time, factor) pulse changes inside each reported section."""
    out: list[dict] = []
    times, weights = analysis.attack_times, analysis.attack_weights
    if times.size == 0 or not analysis.sections:
        return out

    for n, section in enumerate(analysis.sections):
        span = window_beats * section.period
        if span <= 0 or section.end_s - section.start_s < (2 * MIN_RUN + 1) * span:
            continue
        best = None
        for sub in SUBDIVISIONS:
            period = section.period / sub
            rows = []
            edge = section.start_s
            while edge + span <= section.end_s + 1e-9:
                mask = (times >= edge) & (times < edge + span)
                coverage, parity, count = window_stats(
                    times[mask], weights[mask], period, section.phase)
                rows.append({"at": edge, "coverage": coverage,
                             "parity": parity, "n": count})
                edge += span
            if len(rows) < 2 * MIN_RUN + 1:
                continue
            # A window is thinned-but-regular: half the slots empty, and the
            # filled ones on one parity. That is a pulse change; a drop or a
            # sparse bar fails the parity half.
            thin = np.array([
                (r["coverage"] <= COVERAGE_MAX and r["parity"] >= PARITY_MIN
                 and r["n"] >= 4)
                for r in rows])
            # Longest run of thinned windows, and it must not be the whole
            # section (that means the subdivision guess is simply too fine).
            runs, start = [], None
            for i, flag in enumerate(thin):
                if flag and start is None:
                    start = i
                elif not flag and start is not None:
                    runs.append((start, i))
                    start = None
            if start is not None:
                runs.append((start, len(thin)))
            runs = [(a, b) for a, b in runs if b - a >= MIN_RUN]
            if not runs or all(b - a >= len(thin) - 1 for a, b in runs):
                continue
            a, b = max(runs, key=lambda r: r[1] - r[0])
            covs = np.array([r["coverage"] for r in rows])
            outside = np.r_[covs[:a], covs[b:]]
            if outside.size == 0 or float(outside.mean()) - float(covs[a:b].mean()) < 0.2:
                continue
            from_s = float(rows[a]["at"])
            to_s = float(rows[b - 1]["at"] + span)
            # The pulse change sits at whichever edge of the thinned run is not
            # also a section edge. A half-time drop thins the tail, so the
            # boundary is where the run starts; a double-time chorus thins the
            # *head*, so it is where the run ends.
            at_head = a == 0
            at_tail = b >= len(rows)
            boundary = to_s if (at_head and not at_tail) else from_s
            candidate = {
                "section": n,
                "subdivision": sub,
                "from_s": round(from_s, 3),
                "to_s": round(to_s, 3),
                "boundary_s": round(boundary, 3),
                "thin_side": "head" if at_head else ("tail" if at_tail else "mid"),
                "factor": 0.5,          # the thinned region reads half the rate
                "coverage_in": round(float(covs[a:b].mean()), 3),
                "coverage_out": round(float(outside.mean()), 3),
                "parity_in": round(float(np.mean([r["parity"] for r in rows[a:b]])), 3),
                "parity_out": round(float(np.mean(
                    [r["parity"] for r in list(rows[:a]) + list(rows[b:])])), 3),
                "windows": len(rows),
                "thinned": int(b - a),
            }
            score = (candidate["coverage_out"] - candidate["coverage_in"]) * \
                    candidate["parity_in"]
            candidate["score"] = round(float(score), 3)
            if best is None or candidate["score"] > best["score"]:
                best = candidate
        if best is not None:
            out.append(best)
    return out


# ---------------------------------------------------------------------------

def _truth_change(kwargs: dict) -> tuple[float, float] | None:
    """(time, ratio) of the first 2x-or-0.5x relationship in the ground truth."""
    truth = bm.truth_of(kwargs)
    for i in range(1, len(truth)):
        prev, cur = truth[i - 1][1], truth[i][1]
        ratio = cur / prev
        if abs(ratio - 0.5) < 1e-6 or abs(ratio - 2.0) < 1e-6:
            return truth[i][0], ratio
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", metavar="CASE")
    parser.add_argument("--dir", default=str(bm.AUDIO_DIR))
    args = parser.parse_args()

    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)

    cases: dict[str, dict] = {}
    cases.update({n: k for n, k in gates.COVERAGE_CASES.items()})
    cases.update(bm.CASES)
    names = args.only or list(cases)
    unknown = [n for n in names if n not in cases]
    if unknown:
        print(f"Unknown case(s): {', '.join(unknown)}")
        raise SystemExit(2)

    print("Density-change detector: coverage says 'half the slots are empty',")
    print("parity says 'and it is every other one'. Both are required.\n")
    print(f"{'case':<20} {'truth':>9}  {'thin':>6}  {'at':>8}  "
          f"{'cov in/out':>12}  {'parity in/out':>14}")
    print("-" * 82)

    expected_hits, hits, false_positives, misses = 0, 0, 0, []
    for name in names:
        path = audio_dir / f"{name}.wav"
        if not path.exists():
            bm.build_track(path, seed=zlib.crc32(name.encode()), **cases[name])
        analysis = ta.analyze_audio(str(path))
        found = scan(analysis)
        change = _truth_change(cases[name])
        # Only count it as expected when the engine merged the change into one
        # section: if it already reported two red lines there is nothing to find.
        should_fire = change is not None and len(analysis.sections) == 1
        expected_hits += 1 if should_fire else 0

        if found:
            best = max(found, key=lambda c: c["score"])
            fired, at = best["thin_side"], f"{best['boundary_s']:.1f}s"
            cov = f"{best['coverage_in']:.2f}/{best['coverage_out']:.2f}"
            par = f"{best['parity_in']:.2f}/{best['parity_out']:.2f}"
        else:
            best, fired, at, cov, par = None, "no", "-", "-", "-"

        truth_text = f"{change[1]:g}x" if change else "-"
        flag = ""
        if should_fire and best is not None:
            error = abs(best["boundary_s"] - change[0])
            if error <= 4.0:
                hits += 1
                flag = f"  ok, {error:+.2f}s from truth"
            else:
                misses.append(f"{name} (fired {error:.1f}s off)")
                flag = f"  FIRED {error:.1f}s OFF"
        elif should_fire:
            misses.append(name)
            flag = "  MISS"
        elif best is not None:
            false_positives += 1
            flag = "  FALSE POSITIVE"

        print(f"{name:<20} {truth_text:>9}  {fired:>5}  {at:>8}  {cov:>12}  {par:>14}{flag}")

    print(f"\ndetected {hits}/{expected_hits} real density changes")
    print(f"false positives: {false_positives}/{len(names) - expected_hits}")
    if misses:
        print(f"missed: {', '.join(misses)}")
    raise SystemExit(0 if (hits == expected_hits and false_positives == 0) else 1)


if __name__ == "__main__":
    main()
