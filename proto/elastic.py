"""Prototype: an elastic grid for tempo that actually changes continuously.

v3's model is `t(k) = offset + k*period`. It is exact when the tempo is
constant and has nothing to say when it is not: on a 120 -> 160 BPM ramp the
precision engine finds no fittable grid, falls back to the v2 tracker, and
emits an eight-section staircase. The timeline's Open Items propose fitting a
slowly-varying tempo curve instead. This measures whether that works.

The model generalises v3 by one idea — keep least squares, raise the degree:

    t(k) = c0 + c1*k + c2*k^2 + c3*k^3

Degree 1 *is* v3 (`dt/dk` constant). Degree 2 is a tempo linear in beat index,
which is exactly a ramp. It stays linear in the coefficients, so the IRLS
machinery v3 already trusts carries over; only the design matrix grows.

The part that is not obvious, and that the first attempt at this got wrong:
**you cannot seed it with a constant period.** Assigning beat indices with one
period over a 60 s ramp slips indices badly, and least squares cannot recover a
slipped index — the same failure mode the v3 timeline records for its coherence
phase sign. Seeded that way the fit returns degree 1 at 30 ms RMS and a tempo
17 BPM from truth.

So the pipeline is curve-first:

    1. sample the tempo locally   — short windows, each fitted by v3's own code
    2. normalise octaves          — a local window may lock an octave away
    3. fit period(t)              — low degree, weighted by window quality
    4. integrate to a beat grid   — this is what makes indices correct
    5. global polynomial LS in k  — the deliverable model, now properly seeded

Two things must be true for this to be worth building:

1. On a ramp it recovers the tempo curve, not a staircase.
2. On the 24 constant fixtures it does **not invent curvature**.

    python proto/elastic.py              # ramps + every constant fixture
    python proto/elastic.py --only ramp-120-160
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
import overtone as ta  # noqa: E402

#: Local tempo sampling. Ten seconds is long enough for v3's fit to be precise
#: and short enough that a ramp only moves a few BPM across it.
SAMPLE_WIDTH = 10.0
SAMPLE_HOP = 2.5
#: Reject a local window whose fit is worse than this fraction of its period.
SAMPLE_MAX_RMS_RATIO = 0.05
#: Same ladder v3 uses, as a fraction of the local period.
TOLERANCES = (0.30, 0.18, 0.10, 0.06, 0.04)
#: A higher degree must cut the weighted RMS residual by this fraction or the
#: lower degree wins. This is what stops the model bending to fit jitter.
DEGREE_GAIN = 0.15
MAX_DEGREE = 3


# ---------------------------------------------------------------------------
# 1-2. Local tempo samples, octave-normalised
# ---------------------------------------------------------------------------

def sample_tempo(times: np.ndarray, weights: np.ndarray,
                 width: float = SAMPLE_WIDTH,
                 hop: float = SAMPLE_HOP) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(centre times, periods, quality) from short v3 fits along the track."""
    t0, t1 = float(times[0]), float(times[-1])
    centres, periods, quality, residuals = [], [], [], []
    edge = t0
    while edge < t1 - 0.5 * width:
        lo, hi = edge, min(t1, edge + width)
        window = (times >= lo) & (times <= hi)
        if int(window.sum()) >= 10:
            seed = ta._seed_grid(times, weights, lo, hi, widths=(width, width * 0.6))
            if seed is not None:
                period, phase = ta._refine_grid(times[window], weights[window],
                                                seed[0], seed[1])[:2]
                share, coverage, rms = ta._grid_quality(times[window], weights[window],
                                                        period, phase)
                if period > 0:
                    centres.append(0.5 * (lo + hi))
                    periods.append(period)
                    quality.append(share * (0.25 + 0.75 * coverage))
                    residuals.append(rms)
        edge += hop
    if not periods:
        return np.zeros(0), np.zeros(0), np.zeros(0)

    p = np.asarray(periods, dtype=np.float64)
    q = np.asarray(quality, dtype=np.float64)
    c = np.asarray(centres, dtype=np.float64)
    r = np.asarray(residuals, dtype=np.float64)

    # A local window can lock an octave away from its neighbours, so octaves
    # have to be normalised. The reference must be **local**: a global one
    # assumes the whole track sits inside about half an octave, and a 90 -> 200
    # ramp spans 1.15 — measured, it "corrected" real tempo differences as
    # octave errors and came out 20 BPM wrong at both ends. Walking forward
    # against a running reference only assumes *adjacent* windows are within
    # half an octave of each other, which overlapping windows always are.
    reference = float(p[0])
    for i in range(p.size):
        factor = float(np.exp2(np.round(np.log2(p[i] / reference))))
        if factor > 0:
            p[i] = p[i] / factor
        # Follow the curve, but slowly enough that one bad window cannot drag
        # the reference onto a wrong octave for everything after it.
        reference = 0.65 * reference + 0.35 * p[i]

    # Residual quality is judged **after** normalisation, against the beat the
    # window actually implies. Judging it before threw away the whole slow head
    # of the 90 -> 200 ramp: those windows lock the 4x atom (the fixture has
    # attacks a quarter-beat apart there), so a 5 ms residual was being compared
    # against 5 % of a 166 ms atom instead of 5 % of a 667 ms beat. The curve
    # then had no samples before t = 18 s and had to extrapolate 17 s.
    keep = r <= SAMPLE_MAX_RMS_RATIO * p * 1000.0

    # Outliers relative to a locally smooth estimate, not to a global constant.
    if p.size >= 5:
        smooth = np.array([np.median(p[max(0, i - 2):i + 3]) for i in range(p.size)])
        keep &= np.abs(np.log2(p / np.maximum(smooth, 1e-9))) < 0.2
    return c[keep], p[keep], q[keep]


# ---------------------------------------------------------------------------
# 3-4. Tempo curve, then a beat grid by integration
# ---------------------------------------------------------------------------

def fit_curve(centres: np.ndarray, periods: np.ndarray, quality: np.ndarray,
              max_degree: int = 2) -> np.ndarray:
    """Weighted polynomial period(t), lowest degree that earns its place.

    Returns [t_first, t_last, span, *coeffs]. The first two are the edges of
    the region that actually carried samples, and ``curve_period_at`` clamps
    to them — see there for why that is not a detail.
    """
    if centres.size == 0:
        return np.zeros(0)
    if centres.size < 4:
        mean = float(np.average(periods, weights=np.maximum(quality, 1e-6)))
        return np.array([centres[0], centres[-1], 1.0, mean])
    span = max(float(np.ptp(centres)), 1e-9)
    u = (centres - centres[0]) / span
    best, best_rms = None, float("inf")
    for degree in range(0, min(max_degree, centres.size - 2) + 1):
        coeffs = np.polyfit(u, periods, degree, w=np.sqrt(np.maximum(quality, 1e-9)))
        resid = periods - np.polyval(coeffs, u)
        rms = float(np.sqrt(np.average(resid ** 2, weights=np.maximum(quality, 1e-9))))
        if best is None or rms < best_rms * (1.0 - DEGREE_GAIN):
            best, best_rms = coeffs, rms
    return np.array([centres[0], centres[-1], span, *best])


def curve_period_at(curve: np.ndarray, t) -> np.ndarray:
    """period(t), held constant outside the sampled span.

    Never evaluate the polynomial outside its data. Measured on the 90 -> 200
    ramp: the earliest window that can be fitted at all sits several seconds
    in, and a degree-2 curve run backwards from there reported 109 BPM where
    the truth is 90. Clamping says "no evidence out here", which is true.

    Extending with the edge slope instead was tried, since a ramp genuinely
    keeps ramping and the entire max error on every ramp fixture is edge
    behaviour rather than curve shape. It made the extreme fixture worse
    (median 0.63 -> 5.65 BPM: a steep edge slope fed the polynomial-in-k stage
    badly enough to flip its degree choice) and changed nothing on the other
    two. Dropped — see proto/README.md.
    """
    scalar = np.isscalar(t) or np.asarray(t).ndim == 0
    t = np.atleast_1d(np.asarray(t, dtype=np.float64))
    first, last, span = curve[0], curve[1], curve[2]
    clamped = np.clip(t, first, last)
    out = np.maximum(np.polyval(curve[3:], (clamped - first) / span), 1e-3)
    return float(out[0]) if scalar else out


def integrate_grid(curve: np.ndarray, phase: float, t_end: float) -> np.ndarray:
    """Beat times implied by period(t): t_{k+1} = t_k + period(t_k)."""
    out = [float(phase)]
    guard = 0
    while out[-1] < t_end and guard < 200000:
        step = float(curve_period_at(curve, out[-1]))
        if not np.isfinite(step) or step <= 0.02:
            break
        out.append(out[-1] + step)
        guard += 1
    return np.asarray(out, dtype=np.float64)


# ---------------------------------------------------------------------------
# 5. Global polynomial least squares in k
# ---------------------------------------------------------------------------

class Elastic:
    """t(k) = sum(c_i * u^i), with u = (k - k0) / scale for conditioning."""

    def __init__(self, coeffs: np.ndarray, k0: float, scale: float):
        self.c = np.asarray(coeffs, dtype=np.float64)
        self.k0, self.scale = float(k0), float(scale)

    @property
    def degree(self) -> int:
        return self.c.size - 1

    def time_at(self, k):
        u = (np.asarray(k, dtype=np.float64) - self.k0) / self.scale
        return np.polyval(self.c[::-1], u)

    def period_at(self, k):
        u = (np.asarray(k, dtype=np.float64) - self.k0) / self.scale
        return np.polyder(np.poly1d(self.c[::-1]))(u) / self.scale

    def bpm_at(self, k):
        p = np.asarray(self.period_at(k), dtype=np.float64)
        return 60.0 / np.where(np.abs(p) < 1e-12, np.nan, p)

    def is_monotone(self, k_lo: int, k_hi: int) -> bool:
        if k_hi <= k_lo:
            return False
        return bool(np.all(self.period_at(np.linspace(k_lo, k_hi, 512)) > 0))


def _wls(k: np.ndarray, t: np.ndarray, w: np.ndarray, degree: int,
         k0: float, scale: float) -> Elastic | None:
    if k.size < degree + 3:
        return None
    u = (k - k0) / scale
    design = np.vander(u, degree + 1, increasing=True)
    sw = np.sqrt(np.maximum(w, 0.0))
    try:
        coeffs, *_ = np.linalg.lstsq(design * sw[:, None], t * sw, rcond=None)
    except np.linalg.LinAlgError:
        return None
    return Elastic(coeffs, k0, scale) if np.all(np.isfinite(coeffs)) else None


def fit(times: np.ndarray, weights: np.ndarray,
        max_degree: int = MAX_DEGREE) -> tuple[Elastic, dict] | None:
    """Curve-first elastic fit. Returns (model, report)."""
    if times.size < 16:
        return None
    centres, periods, quality = sample_tempo(times, weights)
    if centres.size == 0:
        return None
    curve = fit_curve(centres, periods, quality)

    # Anchor the integrated grid on the first local fit's own phase, then let
    # the least-squares stage move it. Indices are what matter here, not phase.
    lo = float(times[0])
    hi = min(float(times[-1]), lo + SAMPLE_WIDTH)
    seed = ta._seed_grid(times, weights, lo, hi, widths=(SAMPLE_WIDTH, 6.0))
    if seed is None:
        return None
    phase = seed[1] + np.ceil((lo - seed[1] - 1e-9) / seed[0]) * seed[0] - seed[0]
    grid = integrate_grid(curve, phase, float(times[-1]) + 2.0)
    if grid.size < 8:
        return None

    # Indices from the integrated grid: this is the step that makes a curved
    # model fittable at all.
    idx = np.clip(np.searchsorted(grid, times), 1, grid.size - 1)
    left = np.abs(times - grid[idx - 1])
    right = np.abs(times - grid[idx])
    k_all = np.where(left <= right, idx - 1, idx).astype(np.float64)

    k0 = float(np.median(k_all))
    scale = max(1.0, float(np.ptp(k_all)) / 2.0)
    report: dict = {
        "samples": int(centres.size),
        "sampled_from": round(float(centres[0]), 2),
        "sampled_to": round(float(centres[-1]), 2),
        "unsampled_head_s": round(float(centres[0] - times[0]), 2),
        "unsampled_tail_s": round(float(times[-1] - centres[-1]), 2),
        "curve_bpm_first": round(60.0 / float(curve_period_at(curve, times[0])), 3),
        "curve_bpm_last": round(60.0 / float(curve_period_at(curve, times[-1])), 3),
        "degrees": {},
    }

    best, best_rms = None, float("inf")
    for degree in range(1, max_degree + 1):
        model = _wls(k_all, times, weights, degree, k0, scale)
        if model is None:
            continue
        k = k_all.copy()
        for ratio in TOLERANCES:
            period = np.abs(model.period_at(k))
            resid = times - model.time_at(k)
            inlier = np.abs(resid) <= np.maximum(ratio * period, 0.006)
            if int(inlier.sum()) < degree + 8:
                break
            nxt = _wls(k[inlier], times[inlier], weights[inlier], degree, k0, scale)
            if nxt is None:
                break
            model = nxt
        k_lo, k_hi = int(np.min(k_all)) - 4, int(np.max(k_all)) + 4
        if not model.is_monotone(k_lo, k_hi):
            report["degrees"][degree] = {"rms_ms": None, "note": "non-monotone"}
            continue
        period = np.abs(model.period_at(k_all))
        resid = times - model.time_at(k_all)
        inlier = np.abs(resid) <= np.maximum(0.12 * period, 0.006)
        n = int(inlier.sum())
        if n < degree + 8:
            report["degrees"][degree] = {"rms_ms": None, "note": "too few inliers"}
            continue
        w = weights[inlier].astype(float)
        rms = float(np.sqrt(float(w @ (resid[inlier] ** 2)) / max(float(np.sum(w)), 1e-9))) * 1000.0
        report["degrees"][degree] = {
            "rms_ms": round(rms, 3), "inliers": n,
            "bpm_first": round(float(model.bpm_at(np.min(k_all))), 3),
            "bpm_last": round(float(model.bpm_at(np.max(k_all))), 3),
        }
        if best is None or rms < best_rms * (1.0 - DEGREE_GAIN):
            best, best_rms = model, rms

    if best is None:
        return None
    report["chosen_degree"] = best.degree
    report["rms_ms"] = round(best_rms, 3)
    report["k_all"] = k_all
    return best, report


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------

RAMPS = {
    "ramp-120-160": (120.0, 160.0, 60.0),
    "ramp-180-140": (180.0, 140.0, 60.0),
    "ramp-90-200": (90.0, 200.0, 75.0),
}


def _attacks(path: Path) -> tuple[np.ndarray, np.ndarray]:
    y, sr = ta._load_audio(str(path), lambda _m: None)
    times, weights, _env = ta._detect_attacks(y, sr, ta.FIT_HOP)
    return times, weights


def run_ramps(audio_dir: Path, ramps: dict) -> int:
    print("RAMPS — tempo genuinely changes. v3 falls back to the v2 tracker here.\n")
    print(f"{'case':<16} {'deg':>3} {'rms':>8}  {'fitted BPM span':>22}  "
          f"{'BPM err med/max':>17}  {'v3':>16}")
    print("-" * 94)
    failures = 0
    for name, (bpm0, bpm1, duration) in ramps.items():
        path = audio_dir / f"{name}.wav"
        if not path.exists():
            bm.build_ramp(path, bpm0, bpm1, duration)
        times, weights = _attacks(path)
        fitted = fit(times, weights)
        analysis = ta.analyze_audio(str(path))
        v3 = f"{analysis.engine}, {len(analysis.points)} sec"
        if fitted is None:
            print(f"{name:<16}  no fit{'':>62}{v3:>16}   <-- MISS")
            failures += 1
            continue
        model, report = fitted
        k = report["k_all"]
        t_hat = model.time_at(k)
        got = model.bpm_at(k)
        truth = bpm0 + (bpm1 - bpm0) * (t_hat / duration)
        err = np.abs(got - truth)
        med, mx = float(np.median(err)), float(np.max(err))
        chosen = report["degrees"][report["chosen_degree"]]
        ok = med <= 1.0 and mx <= 4.0
        failures += 0 if ok else 1
        print(f"{name:<16} {report['chosen_degree']:>3} {report['rms_ms']:>6.2f}ms  "
              f"{chosen['bpm_first']:>9.2f} -> {chosen['bpm_last']:<9.2f}  "
              f"{med:>7.3f} /{mx:<8.3f}  {v3:>16}{'' if ok else '   <-- MISS'}")
    print()
    return failures


def run_constant(names: list[str], audio_dir: Path) -> int:
    print("CONSTANT TEMPO — the elastic model must NOT invent curvature.\n")
    print(f"{'case':<18} {'deg':>3} {'rms':>8}  {'fitted BPM span':>22}  "
          f"{'drift':>7}  {'v3 BPM':>10} {'v3 rms':>8}  winner")
    print("-" * 100)
    failures, drifts = 0, []
    for name in names:
        path = audio_dir / f"{name}.wav"
        if not path.exists():
            bm.build_track(path, seed=zlib.crc32(name.encode()), **bm.CASES[name])
        times, weights = _attacks(path)
        fitted = fit(times, weights)
        if fitted is None:
            print(f"{name:<18}  no fit   <-- MISS")
            failures += 1
            continue
        model, report = fitted
        chosen = report["degrees"][report["chosen_degree"]]
        first, last = chosen["bpm_first"], chosen["bpm_last"]
        drift = abs(last - first) / max(abs(first), 1e-9)
        drifts.append(drift)
        analysis = ta.analyze_audio(str(path))
        ok = drift <= 0.01
        failures += 0 if ok else 1
        # The selector: whichever model explains the attacks better wins. This
        # is the measurement that decides elastic-vs-piecewise, so print it.
        v3_rms = float(analysis.fit_residual_ms)
        winner = "v3" if v3_rms <= report["rms_ms"] else "elastic"
        print(f"{name:<18} {report['chosen_degree']:>3} {report['rms_ms']:>6.2f}ms  "
              f"{first:>9.3f} -> {last:<9.3f}  {drift * 100:>5.2f}%  "
              f"{analysis.global_bpm:>10.3f} {v3_rms:>6.2f}ms  {winner}"
              f"{'' if ok else '   <-- BENT'}")
    if drifts:
        print(f"\nmedian invented drift {np.median(drifts) * 100:.3f}%   "
              f"worst {max(drifts) * 100:.3f}%")
    return failures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", metavar="CASE")
    parser.add_argument("--dir", default=str(bm.AUDIO_DIR))
    args = parser.parse_args()
    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)

    if args.only:
        ramps = {n: RAMPS[n] for n in args.only if n in RAMPS}
        constants = [n for n in args.only if n in bm.CASES]
        unknown = [n for n in args.only if n not in RAMPS and n not in bm.CASES]
        if unknown:
            print(f"Unknown case(s): {', '.join(unknown)}")
            raise SystemExit(2)
    else:
        ramps, constants = dict(RAMPS), list(bm.CASES)

    failures = 0
    if ramps:
        failures += run_ramps(audio_dir, ramps)
    if constants:
        failures += run_constant(constants, audio_dir)
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
