//! Elastic grid for continuously varying tempo — DSP §B.1.
//!
//! v3's model is `t(k) = offset + k·period`: exact on constant tempo, silent
//! otherwise (a 120 → 160 ramp falls back to the tracker and comes out as an
//! 8-section staircase). The generalisation is one idea — keep least squares,
//! raise the degree:
//!
//! ```text
//! t(k) = c0 + c1·k + c2·k² + c3·k³
//! ```
//!
//! Degree 1 *is* v3. Degree 2 is a tempo linear in beat index — a ramp. It
//! stays linear in the coefficients, so the trusted IRLS machinery carries
//! over; only the design matrix grows.
//!
//! This is a direct port of `proto/elastic.py` (measured: 0.14–0.16 BPM
//! median error on realistic ramps against 8- and 13-section staircases, and
//! degree 1 with 0.00 % invented drift on 22 of 24 constant fixtures). The
//! verdict there governs the shape here: the elastic model lives **beside**
//! the piecewise fit with the residual as the selector, not in place of it.
//!
//! The non-obvious part, which the first prototype attempt got wrong: the
//! pipeline must be curve-first. Assigning beat indices with one constant
//! period across a ramp slips indices, and least squares cannot recover a
//! slipped index — the same failure mode as the coherence phase sign. So:
//!
//! ```text
//! 1. sample the tempo locally — short windows, each fitted by v3's own code
//! 2. normalise octaves         — against a running local reference
//! 3. fit period(t)             — low degree, weighted by window quality
//! 4. integrate to a beat grid  — this is what makes the indices correct
//! 5. global polynomial LS in k — the deliverable model, now properly seeded
//! ```

use crate::fit::{self, Grid};

/// Local tempo sampling: long enough for a precise v3 fit, short enough
/// that a ramp only moves a few BPM across the window.
pub const SAMPLE_WIDTH: f64 = 10.0;
pub const SAMPLE_HOP: f64 = 2.5;
/// A local window whose fit is worse than this fraction of its period is
/// not a sample, it is a coincidence.
pub const SAMPLE_MAX_RMS_RATIO: f64 = 0.05;
/// A higher degree must cut the weighted RMS by this fraction or the lower
/// degree wins. This is what stops the model bending to fit jitter.
///
/// Note the cliff this creates: on step-tempo fixtures the prototype sits
/// ~3 % from the threshold (13.479 vs 13.099 on change-128-142), so float
/// summation order alone can flip the digit — the port reproduces the
/// residuals to three decimals and still lands on the other side twice.
/// Gate the residuals and the selector outcome there, never the digit.
pub const DEGREE_GAIN: f64 = 0.15;
pub const MAX_DEGREE: usize = 3;

/// Weighted polynomial `period(t)`, with the sampled span it is valid on.
///
/// The curve is **never evaluated outside its samples**: clamping says "no
/// evidence out here". Extending with the edge slope was tried in the
/// prototype and made the extreme ramp worse (median 0.63 → 5.65 BPM).
#[derive(Debug, Clone)]
pub struct TempoCurve {
    pub first: f64,
    pub last: f64,
    pub span: f64,
    /// Lowest power first.
    pub coeffs: Vec<f64>,
}

impl TempoCurve {
    pub fn period_at(&self, t: f64) -> f64 {
        let clamped = t.clamp(self.first, self.last);
        polyval(&self.coeffs, (clamped - self.first) / self.span).max(1e-3)
    }
}

/// `t(k) = Σ c_i·u^i` with `u = (k − k0)/scale` for conditioning.
#[derive(Debug, Clone)]
pub struct Elastic {
    /// Lowest power first.
    pub c: Vec<f64>,
    pub k0: f64,
    pub scale: f64,
}

impl Elastic {
    pub fn degree(&self) -> usize {
        self.c.len().saturating_sub(1)
    }

    pub fn time_at(&self, k: f64) -> f64 {
        polyval(&self.c, (k - self.k0) / self.scale)
    }

    pub fn period_at(&self, k: f64) -> f64 {
        let u = (k - self.k0) / self.scale;
        let mut d = 0.0;
        // Derivative of Σ c_i u^i, evaluated directly.
        let mut pow = 1.0;
        for (i, &c) in self.c.iter().enumerate().skip(1) {
            d += i as f64 * c * pow;
            pow *= u;
        }
        d / self.scale
    }

    pub fn bpm_at(&self, k: f64) -> f64 {
        let p = self.period_at(k);
        if p.abs() < 1e-12 {
            f64::NAN
        } else {
            60.0 / p
        }
    }

    pub fn is_monotone(&self, k_lo: i64, k_hi: i64) -> bool {
        if k_hi <= k_lo {
            return false;
        }
        for i in 0..512 {
            let k = k_lo as f64 + (k_hi - k_lo) as f64 * i as f64 / 511.0;
            if self.period_at(k) <= 0.0 {
                return false;
            }
        }
        true
    }
}

/// Per-degree evidence, mirroring the prototype's report.
#[derive(Debug, Clone, Default)]
pub struct DegreeReport {
    pub rms_ms: Option<f64>,
    pub inliers: usize,
    pub bpm_first: f64,
    pub bpm_last: f64,
}

/// What `fit` measured, for gates and diagnostics.
#[derive(Debug, Clone, Default)]
pub struct ElasticReport {
    pub samples: usize,
    pub sampled_from: f64,
    pub sampled_to: f64,
    pub curve_bpm_first: f64,
    pub curve_bpm_last: f64,
    pub degrees: Vec<(usize, DegreeReport)>,
    pub chosen_degree: usize,
    pub rms_ms: f64,
    pub beat_indices: Vec<f64>,
}

/// Local tempo samples: `(centres, periods, quality)` from short v3 fits.
pub fn sample_tempo(times: &[f64], weights: &[f32]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let (mut centres, mut periods, mut quality, mut residuals) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    if times.is_empty() {
        return (centres, periods, quality);
    }
    let (t0, t1) = (times[0], times[times.len() - 1]);
    let widths = [SAMPLE_WIDTH, SAMPLE_WIDTH * 0.6];
    let mut edge = t0;
    while edge < t1 - 0.5 * SAMPLE_WIDTH {
        let hi = t1.min(edge + SAMPLE_WIDTH);
        let (w_times, w_weights) = fit::window(times, weights, edge, hi);
        if w_times.len() >= 10 {
            if let Some(seed) = crate::seed_grid(times, weights, edge, hi, None, &widths) {
                let (grid, _) = fit::refine(
                    &w_times,
                    &w_weights,
                    Grid {
                        period: seed.period,
                        phase: seed.phase,
                    },
                );
                let q = fit::quality(&w_times, &w_weights, grid);
                if grid.period > 0.0 {
                    centres.push(0.5 * (edge + hi));
                    periods.push(grid.period);
                    quality.push(crate::seed_score(&q));
                    residuals.push(q.residual_ms);
                }
            }
        }
        edge += SAMPLE_HOP;
    }
    if periods.is_empty() {
        return (centres, periods, quality);
    }

    // Octave normalisation against a running *local* reference: a global one
    // assumes the whole track sits inside half an octave, and the 90 → 200
    // ramp spans 1.15 — measured, it "corrected" real tempo differences and
    // came out 20 BPM wrong at both ends.
    let mut reference = periods[0];
    for p in periods.iter_mut() {
        let factor = (*p / reference).log2().round().exp2();
        if factor > 0.0 {
            *p /= factor;
        }
        reference = 0.65 * reference + 0.35 * *p;
    }

    // Residual quality is judged after normalisation, against the beat the
    // window actually implies — judging it before threw away the whole slow
    // head of the extreme ramp, whose windows lock the 4× atom.
    let mut keep: Vec<bool> = periods
        .iter()
        .zip(residuals.iter())
        .map(|(&p, &r)| r <= SAMPLE_MAX_RMS_RATIO * p * 1000.0)
        .collect();
    // Outliers against a locally smooth estimate, not a global constant.
    if periods.len() >= 5 {
        for (i, keep_i) in keep.iter_mut().enumerate() {
            let lo = i.saturating_sub(2);
            let hi = (i + 3).min(periods.len());
            let mut window = periods[lo..hi].to_vec();
            window.sort_by(f64::total_cmp);
            let smooth = window[window.len() / 2];
            if (periods[i] / smooth.max(1e-9)).log2().abs() >= 0.2 {
                *keep_i = false;
            }
        }
    }
    let (mut c, mut p, mut q) = (Vec::new(), Vec::new(), Vec::new());
    for (i, k) in keep.iter().enumerate() {
        if *k {
            c.push(centres[i]);
            p.push(periods[i]);
            q.push(quality[i]);
        }
    }
    (c, p, q)
}

/// Weighted `period(t)` polynomial, lowest degree that earns its place.
pub fn fit_curve(
    centres: &[f64],
    periods: &[f64],
    quality: &[f64],
    max_degree: usize,
) -> Option<TempoCurve> {
    if centres.is_empty() {
        return None;
    }
    if centres.len() < 4 {
        let wsum: f64 = quality.iter().map(|&q| q.max(1e-6)).sum();
        let mean = centres
            .iter()
            .zip(periods.iter())
            .zip(quality.iter())
            .map(|((_, &p), &q)| p * q.max(1e-6))
            .sum::<f64>()
            / wsum.max(1e-9);
        return Some(TempoCurve {
            first: centres[0],
            last: centres[centres.len() - 1],
            span: 1.0,
            coeffs: vec![mean],
        });
    }
    let span = (centres[centres.len() - 1] - centres[0]).max(1e-9);
    let u: Vec<f64> = centres.iter().map(|&c| (c - centres[0]) / span).collect();
    let w: Vec<f64> = quality.iter().map(|&q| q.max(1e-9).sqrt()).collect();
    let mut best: Option<(Vec<f64>, f64)> = None;
    for degree in 0..=(max_degree.min(centres.len() - 2)) {
        let coeffs = polyfit(&u, periods, &w, degree)?;
        let rms = weighted_rms(&u, periods, &w, &coeffs);
        let better = match &best {
            None => true,
            Some((_, prev)) => rms < prev * (1.0 - DEGREE_GAIN),
        };
        if better {
            best = Some((coeffs, rms));
        }
    }
    best.map(|(coeffs, _)| TempoCurve {
        first: centres[0],
        last: centres[centres.len() - 1],
        span,
        coeffs,
    })
}

/// Beat times implied by `period(t)`: `t_{k+1} = t_k + period(t_k)`.
pub fn integrate_grid(curve: &TempoCurve, phase: f64, t_end: f64) -> Vec<f64> {
    let mut out = vec![phase];
    let mut guard = 0usize;
    while *out.last().unwrap() < t_end && guard < 200_000 {
        let step = curve.period_at(*out.last().unwrap());
        if !step.is_finite() || step <= 0.02 {
            break;
        }
        out.push(out.last().unwrap() + step);
        guard += 1;
    }
    out
}

/// Curve-first elastic fit. Returns the model plus what it measured.
pub fn fit(times: &[f64], weights: &[f32]) -> Option<(Elastic, ElasticReport)> {
    fit_with_degree(times, weights, MAX_DEGREE)
}

pub fn fit_with_degree(
    times: &[f64],
    weights: &[f32],
    max_degree: usize,
) -> Option<(Elastic, ElasticReport)> {
    if times.len() < 16 {
        return None;
    }
    let (centres, periods, quality) = sample_tempo(times, weights);
    if centres.is_empty() {
        return None;
    }
    let curve = fit_curve(&centres, &periods, &quality, 2)?;

    // Anchor the integrated grid on the first local fit's own phase, then let
    // least squares move it. Indices are what matter here, not phase.
    let lo = times[0];
    let hi = times[times.len() - 1].min(lo + SAMPLE_WIDTH);
    let seed = crate::seed_grid(times, weights, lo, hi, None, &[SAMPLE_WIDTH, 6.0])?;
    let phase =
        seed.phase + ((lo - seed.phase - 1e-9) / seed.period).ceil() * seed.period - seed.period;
    let grid = integrate_grid(&curve, phase, times[times.len() - 1] + 2.0);
    if grid.len() < 8 {
        return None;
    }

    // Indices from the integrated grid: the step that makes a curved model
    // fittable at all.
    let mut k_all = Vec::with_capacity(times.len());
    for &t in times {
        let idx = grid.partition_point(|&g| g < t).clamp(1, grid.len() - 1);
        let (left, right) = ((t - grid[idx - 1]).abs(), (t - grid[idx]).abs());
        k_all.push(if left <= right { idx - 1 } else { idx } as f64);
    }

    let mut sorted_k = k_all.clone();
    sorted_k.sort_by(f64::total_cmp);
    let mid = sorted_k[sorted_k.len() / 2];
    let k0 = if sorted_k.len() % 2 == 0 {
        0.5 * (mid + sorted_k[sorted_k.len() / 2 - 1])
    } else {
        mid
    };
    let ptp = sorted_k[sorted_k.len() - 1] - sorted_k[0];
    let scale = (ptp / 2.0).max(1.0);
    let w_all: Vec<f64> = weights.iter().map(|&w| w as f64).collect();

    let mut report = ElasticReport {
        samples: centres.len(),
        sampled_from: centres[0],
        sampled_to: centres[centres.len() - 1],
        curve_bpm_first: 60.0 / curve.period_at(times[0]),
        curve_bpm_last: 60.0 / curve.period_at(times[times.len() - 1]),
        ..ElasticReport::default()
    };

    let mut best: Option<(Elastic, f64)> = None;
    for degree in 1..=max_degree {
        let Some(mut model) = wls(&k_all, times, &w_all, degree, k0, scale) else {
            continue;
        };
        let mut alive = true;
        for &ratio in &fit::TOLERANCES {
            let mut inliers = Vec::with_capacity(times.len());
            for (i, &t) in times.iter().enumerate() {
                let period = model.period_at(k_all[i]).abs();
                let resid = (t - model.time_at(k_all[i])).abs();
                inliers.push(resid <= (ratio * period).max(0.006));
            }
            if inliers.iter().filter(|&&b| b).count() < degree + 8 {
                alive = false;
                break;
            }
            let (ki, ti, wi) = select(&k_all, times, &w_all, &inliers);
            match wls(&ki, &ti, &wi, degree, k0, scale) {
                Some(nxt) => model = nxt,
                None => {
                    alive = false;
                    break;
                }
            }
        }
        if !alive {
            continue;
        }
        let k_lo = k_all.iter().copied().fold(f64::INFINITY, f64::min) as i64 - 4;
        let k_hi = k_all.iter().copied().fold(f64::NEG_INFINITY, f64::max) as i64 + 4;
        if !model.is_monotone(k_lo, k_hi) {
            report.degrees.push((degree, DegreeReport::default()));
            continue;
        }
        let mut n = 0usize;
        let mut sum_w = 0.0;
        let mut sum_sq = 0.0;
        for (i, &t) in times.iter().enumerate() {
            let period = model.period_at(k_all[i]).abs();
            let resid = t - model.time_at(k_all[i]);
            if resid.abs() <= (0.12 * period).max(0.006) {
                n += 1;
                sum_w += w_all[i];
                sum_sq += w_all[i] * resid * resid;
            }
        }
        if n < degree + 8 {
            report.degrees.push((degree, DegreeReport::default()));
            continue;
        }
        let rms = (sum_sq / sum_w.max(1e-9)).sqrt() * 1000.0;
        let k_min = k_all.iter().copied().fold(f64::INFINITY, f64::min);
        let k_max = k_all.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        report.degrees.push((
            degree,
            DegreeReport {
                rms_ms: Some(rms),
                inliers: n,
                bpm_first: model.bpm_at(k_min),
                bpm_last: model.bpm_at(k_max),
            },
        ));
        let better = match &best {
            None => true,
            Some((_, prev)) => rms < prev * (1.0 - DEGREE_GAIN),
        };
        if better {
            best = Some((model, rms));
        }
    }

    let (model, rms) = best?;
    report.chosen_degree = model.degree();
    report.rms_ms = rms;
    report.beat_indices = k_all;
    Some((model, report))
}

/// Weighted least squares for `t(k) = Σ c_i·u^i`, or `None` when there is
/// too little to fit. Tiny systems (≤ 4 unknowns): normal equations with
/// partial-pivot elimination are plenty.
/// Index loops on purpose: the matrix steps read one row of `a` while
/// writing another, which iterators can only say through split borrows.
#[allow(clippy::needless_range_loop)]
fn wls(k: &[f64], t: &[f64], w: &[f64], degree: usize, k0: f64, scale: f64) -> Option<Elastic> {
    if k.len() < degree + 3 {
        return None;
    }
    let n = degree + 1;
    let mut a = vec![vec![0.0; n + 1]; n];
    for (&ki, (&ti, &wi)) in k.iter().zip(t.iter().zip(w.iter())) {
        let u = (ki - k0) / scale;
        let sw = wi.max(0.0).sqrt();
        let mut pow = 1.0;
        let mut row = vec![0.0; n];
        for cell in row.iter_mut() {
            *cell = sw * pow;
            pow *= u;
        }
        for r in 0..n {
            for c in r..n {
                a[r][c] += row[r] * row[c];
            }
            a[r][n] += row[r] * sw * ti;
        }
    }
    for r in 0..n {
        for c in 0..r {
            a[r][c] = a[c][r];
        }
    }
    let coeffs = solve_symmetric(&mut a)?;
    if coeffs.iter().all(|c| c.is_finite()) {
        Some(Elastic {
            c: coeffs,
            k0,
            scale,
        })
    } else {
        None
    }
}

/// Weighted polynomial fit of `y` over the abscissa `u`, lowest power first.
/// Weights enter as `sqrt` (the same `w` the caller passes to `weighted_rms`
/// squared), matching `np.polyfit(u, y, deg, w=...)`.
/// Index loops on purpose: the matrix steps read one row of `a` while
/// writing another, which iterators can only say through split borrows.
#[allow(clippy::needless_range_loop)]
fn polyfit(u: &[f64], y: &[f64], w: &[f64], degree: usize) -> Option<Vec<f64>> {
    if u.len() < degree + 1 {
        return None;
    }
    let n = degree + 1;
    let mut a = vec![vec![0.0; n + 1]; n];
    for ((&ui, &yi), &wi) in u.iter().zip(y.iter()).zip(w.iter()) {
        let sw = wi.max(0.0).sqrt();
        let mut pow = 1.0;
        let mut row = vec![0.0; n];
        for cell in row.iter_mut() {
            *cell = sw * pow;
            pow *= ui;
        }
        for r in 0..n {
            for c in r..n {
                a[r][c] += row[r] * row[c];
            }
            a[r][n] += row[r] * sw * yi;
        }
    }
    for r in 0..n {
        for c in 0..r {
            a[r][c] = a[c][r];
        }
    }
    let coeffs = solve_symmetric(&mut a)?;
    coeffs.iter().all(|c| c.is_finite()).then_some(coeffs)
}

fn weighted_rms(u: &[f64], y: &[f64], w: &[f64], coeffs: &[f64]) -> f64 {
    let mut num = 0.0;
    let mut den = 0.0;
    for ((&ui, &yi), &wi) in u.iter().zip(y.iter()).zip(w.iter()) {
        // Here w already carries the sqrt: np.average(resid**2, weights=w²).
        let r = yi - polyval(coeffs, ui);
        num += wi * wi * r * r;
        den += wi * wi;
    }
    (num / den.max(1e-9)).sqrt()
}

fn polyval(coeffs: &[f64], x: f64) -> f64 {
    let mut out = 0.0;
    for &c in coeffs.iter().rev() {
        out = out * x + c;
    }
    out
}

/// Gaussian elimination with partial pivoting on a symmetric augmented
/// `(n × (n+1))` system, solved in place.
/// Index loops on purpose: the matrix steps read one row of `a` while
/// writing another, which iterators can only say through split borrows.
#[allow(clippy::needless_range_loop)]
fn solve_symmetric(a: &mut [Vec<f64>]) -> Option<Vec<f64>> {
    let n = a.len();
    for col in 0..n {
        let mut pivot = col;
        for row in col + 1..n {
            if a[row][col].abs() > a[pivot][col].abs() {
                pivot = row;
            }
        }
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        for row in 0..n {
            if row == col {
                continue;
            }
            let factor = a[row][col] / a[col][col];
            if factor != 0.0 {
                for c in col..=n {
                    a[row][c] -= factor * a[col][c];
                }
            }
        }
    }
    (0..n)
        .map(|i| {
            let v = a[i][n] / a[i][i];
            v.is_finite().then_some(v)
        })
        .collect()
}

fn select(k: &[f64], t: &[f64], w: &[f64], keep: &[bool]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut ko = Vec::new();
    let mut to = Vec::new();
    let mut wo = Vec::new();
    for (i, &flag) in keep.iter().enumerate() {
        if flag {
            ko.push(k[i]);
            to.push(t[i]);
            wo.push(w[i]);
        }
    }
    (ko, to, wo)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact linear ramp in time: bpm(t) = bpm0 + (bpm1-bpm0)·t/duration.
    /// The LCG matches the calibration script bit-for-bit, so a stream can
    /// be replayed through the Python prototype for parity checks.
    fn ramp_attacks(bpm0: f64, bpm1: f64, duration: f64, jitter: f64) -> (Vec<f64>, Vec<f32>) {
        ramp_attacks_seeded(bpm0, bpm1, duration, jitter, 777)
    }

    fn ramp_attacks_seeded(
        bpm0: f64,
        bpm1: f64,
        duration: f64,
        jitter: f64,
        seed: u64,
    ) -> (Vec<f64>, Vec<f32>) {
        let mut seed = seed;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        let mut times = vec![0.4];
        while *times.last().unwrap() < duration {
            let t = *times.last().unwrap();
            let bpm = bpm0 + (bpm1 - bpm0) * (t / duration);
            times.push(t + 60.0 / bpm + next() * 2.0 * jitter);
        }
        times.pop();
        (times.clone(), vec![1.0f32; times.len()])
    }

    fn exact_grid(period: f64, phase: f64, duration: f64) -> (Vec<f64>, Vec<f32>) {
        let n = ((duration - phase) / period) as usize;
        let times: Vec<f64> = (0..n).map(|k| phase + k as f64 * period).collect();
        (times.clone(), vec![1.0f32; times.len()])
    }

    fn median_bpm_error(
        model: &Elastic,
        report: &ElasticReport,
        bpm0: f64,
        bpm1: f64,
        duration: f64,
    ) -> (f64, f64) {
        let mut errs: Vec<f64> = report
            .beat_indices
            .iter()
            .map(|&k| {
                let t = model.time_at(k);
                let truth = bpm0 + (bpm1 - bpm0) * (t / duration);
                (model.bpm_at(k) - truth).abs()
            })
            .collect();
        errs.sort_by(f64::total_cmp);
        let med = errs[errs.len() / 2];
        (med, errs[errs.len() - 1])
    }

    #[test]
    fn a_realistic_ramp_recovers_the_curve() {
        let (times, weights) = ramp_attacks(120.0, 160.0, 60.0, 0.002);
        let (model, report) = fit(&times, &weights).expect("a ramp must fit");
        assert!(model.degree() >= 2, "degree {}", model.degree());
        let (med, max) = median_bpm_error(&model, &report, 120.0, 160.0, 60.0);
        assert!(med <= 1.0, "median {med}");
        assert!(max <= 4.0, "max {max}");
        assert!(report.rms_ms < 5.0, "rms {}", report.rms_ms);
    }

    #[test]
    fn a_constant_grid_stays_flat() {
        let (times, weights) = exact_grid(60.0 / 174.0, 0.4, 60.0);
        let (model, report) = fit(&times, &weights).expect("a grid must fit");
        assert_eq!(model.degree(), 1);
        let first = model.bpm_at(report.beat_indices[0]);
        let last = model.bpm_at(report.beat_indices[report.beat_indices.len() - 1]);
        assert!((last - first).abs() / first < 1e-9, "{first} -> {last}");
    }

    #[test]
    fn a_step_comes_back_bad_so_the_selector_picks_piecewise() {
        // Whatever degree survives a step, its residual must be far above
        // anything a usable fit reports: that gap is the selector signal,
        // and it is what both implementations agree on. (Degree choice on a
        // step is cliff dynamics — the prototype itself bends on an exact
        // step and stays flat on noisy ones — so it is gated on real audio
        // by the bench elastic mode instead.)
        let a1 = 60.0 / 128.0;
        let change = 0.4 + 64.0 * a1;
        let (mut times, mut weights) = exact_grid(a1, 0.4, change);
        let a2 = 60.0 / 142.0;
        let (t2, w2) = exact_grid(a2, change, 60.0);
        times.extend(t2.iter().skip(1));
        weights.extend(w2.iter().skip(1));
        let (model, report) = fit(&times, &weights).expect("steps must fit");
        assert!(
            report.rms_ms > 10.0,
            "rms {} should say 'use the piecewise fit'",
            report.rms_ms
        );
        // Survival implies monotonicity — fit rejects the rest — but state
        // it: a non-monotone "tempo curve" is never a valid answer.
        let klo = report
            .beat_indices
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min) as i64;
        let khi = report
            .beat_indices
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max) as i64;
        assert!(model.is_monotone(klo, khi));
    }

    #[test]
    fn the_curve_holds_constant_past_its_samples() {
        let curve = TempoCurve {
            first: 5.0,
            last: 55.0,
            span: 50.0,
            coeffs: vec![0.4, 0.001],
        };
        assert!((curve.period_at(0.0) - curve.period_at(5.0)).abs() < 1e-12);
        assert!((curve.period_at(90.0) - curve.period_at(55.0)).abs() < 1e-12);
    }

    #[test]
    fn too_few_attacks_refuses() {
        let (times, weights) = exact_grid(0.5, 0.0, 5.0);
        assert!(times.len() < 16);
        assert!(fit(&times, &weights).is_none());
    }

    #[test]
    fn jitter_does_not_bend_a_constant_grid() {
        // Parity-pinned: this LCG stream (seed 8) makes the prototype choose
        // degree 1 at 3.446 ms, so the port must land in the same place.
        // Sparse quarter-note streams are cliff territory for degree choice
        // in *both* implementations — the no-curvature gate that matters
        // runs on real dense audio in the bench elastic mode.
        let (times, weights) = ramp_attacks_seeded(150.0, 150.0, 60.0, 0.004, 8);
        let (model, report) = fit(&times, &weights).expect("must fit");
        assert_eq!(model.degree(), 1, "{:?}", report.degrees);
        assert!(
            (report.rms_ms - 3.446).abs() < 0.1,
            "rms {} vs prototype 3.446",
            report.rms_ms
        );
    }
}
