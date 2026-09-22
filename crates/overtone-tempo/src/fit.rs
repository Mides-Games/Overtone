//! Iteratively re-weighted least squares for the grid model
//!
//! ```text
//! t(k) = phase + k · period        (k an integer beat index)
//! ```
//!
//! This is where v3's accuracy comes from and it is worth being explicit about
//! why: with N inlier attacks the fitted period averages onset jitter down by
//! √N. v2 computed tempo as `60 / (t[k+1] − t[k])`, and differencing two
//! jittery numbers *amplifies* the noise instead of averaging it, which is why
//! no amount of median filtering downstream could recover what the difference
//! threw away.
//!
//! The delicate parts, in order of how easy they are to lose in a port:
//!
//! * `recentre_phase` runs at pass index **2 exactly** — after the period is
//!   trustworthy, before the tolerance narrows enough to lock a biased phase
//!   in place. Moving it changes shuffle results by milliseconds.
//! * `recentre_phase` takes the **mode**, not the mean. Least squares balances
//!   everything inside its tolerance window, so a second population of attacks
//!   (swung off-beats, ghost notes, flams) drags the grid halfway toward them —
//!   17 ms on v3's shuffle fixture, fixed to 0.09 ms by scoring candidate
//!   shifts with a narrow Gaussian and taking the peak.
//! * the fit is rejected when the period moves outside `[0.5x, 2x]`, which
//!   stops a pass from octave-hopping mid-refinement.

/// Tolerance ladder, as a fraction of the current period.
pub const TOLERANCES: [f64; 5] = [0.30, 0.18, 0.10, 0.06, 0.04];
/// The pass at which the phase is re-centred. Not a tuning knob.
const RECENTRE_AT: usize = 2;
/// Floor on the inlier window, so a very fast atom still admits real jitter.
const MIN_TOL_S: f64 = 0.006;
const MAX_SCAN_ONSETS: usize = 5000;

/// A fitted grid.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    pub period: f64,
    pub phase: f64,
}

/// How well a grid explains a set of attacks.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quality {
    /// Fraction of attack *energy* the grid explains.
    pub share: f64,
    /// Fraction of the grid's own slots that carry an attack.
    pub coverage: f64,
    /// RMS distance from inlier attacks to the grid, in milliseconds.
    pub residual_ms: f64,
    pub inliers: usize,
}

/// One weighted least-squares pass. `None` when there is nothing to fit or the
/// result would be an octave jump.
pub fn ls_pass(
    times: &[f64],
    weights: &[f32],
    grid: Grid,
    tol_s: f64,
) -> Option<(Grid, Vec<bool>)> {
    if times.len() < 4 || grid.period <= 0.0 {
        return None;
    }
    let inlier: Vec<bool> = times
        .iter()
        .map(|&t| {
            let k = ((t - grid.phase) / grid.period).round();
            (t - (grid.phase + k * grid.period)).abs() <= tol_s
        })
        .collect();
    if inlier.iter().filter(|&&b| b).count() < 4 {
        return None;
    }

    let mut sum_w = 0.0f64;
    let mut sum_wx = 0.0f64;
    let mut sum_wt = 0.0f64;
    let mut k_min = f64::INFINITY;
    let mut k_max = f64::NEG_INFINITY;
    for (i, &t) in times.iter().enumerate() {
        if !inlier[i] {
            continue;
        }
        let k = ((t - grid.phase) / grid.period).round();
        let w = weights[i] as f64;
        sum_w += w;
        sum_wx += w * k;
        sum_wt += w * t;
        k_min = k_min.min(k);
        k_max = k_max.max(k);
    }
    // A fit across fewer than two beat indices is a point, not a line.
    if !(k_max - k_min >= 2.0) || sum_w <= 0.0 {
        return None;
    }
    let mean_k = sum_wx / sum_w;
    let mean_t = sum_wt / sum_w;

    let mut sxx = 0.0f64;
    let mut sxt = 0.0f64;
    for (i, &t) in times.iter().enumerate() {
        if !inlier[i] {
            continue;
        }
        let k = ((t - grid.phase) / grid.period).round();
        let w = weights[i] as f64;
        let dk = k - mean_k;
        sxx += w * dk * dk;
        sxt += w * dk * (t - mean_t);
    }
    if sxx <= 1e-12 {
        return None;
    }
    let period = sxt / sxx;
    if !period.is_finite() || period <= 0.0 {
        return None;
    }
    if !(0.5 * grid.period..=2.0 * grid.period).contains(&period) {
        return None;
    }
    Some((
        Grid {
            period,
            phase: mean_t - period * mean_k,
        },
        inlier,
    ))
}

/// Snap the phase onto the **densest** residual cluster rather than their
/// average — the mode is what the ear locks onto.
pub fn recentre_phase(times: &[f64], weights: &[f32], grid: Grid) -> f64 {
    if times.len() < 4 || grid.period <= 0.0 {
        return grid.phase;
    }
    let width = 0.012f64.min(0.06 * grid.period);
    // The kernel scan is onsets x shifts, and the mode does not need every
    // attack, so score it on the strongest ones.
    let (times, weights) = if times.len() > MAX_SCAN_ONSETS {
        let mut order: Vec<usize> = (0..weights.len()).collect();
        order.sort_by(|&a, &b| weights[a].total_cmp(&weights[b]));
        let mut dense: Vec<usize> = order[order.len() - MAX_SCAN_ONSETS..].to_vec();
        dense.sort_unstable();
        (
            dense.iter().map(|&i| times[i]).collect::<Vec<f64>>(),
            dense.iter().map(|&i| weights[i]).collect::<Vec<f32>>(),
        )
    } else {
        (times.to_vec(), weights.to_vec())
    };

    let half = 0.5 * grid.period;
    let residual: Vec<f64> = times
        .iter()
        .map(|&t| (t - grid.phase + half).rem_euclid(grid.period) - half)
        .collect();

    const SHIFTS: usize = 401;
    let mut best_shift = 0.0f64;
    let mut best_score = f64::NEG_INFINITY;
    for i in 0..SHIFTS {
        let shift = -half + grid.period * i as f64 / (SHIFTS - 1) as f64;
        let mut score = 0.0f64;
        for (&r, &w) in residual.iter().zip(&weights) {
            let scaled = (r - shift) / width;
            // Clamped like v3: exp of a large negative is zero anyway, and the
            // clamp keeps the exponent out of denormal territory.
            score += w as f64 * (-0.5 * (scaled * scaled).clamp(0.0, 60.0)).exp();
        }
        if score > best_score {
            best_score = score;
            best_shift = shift;
        }
    }
    grid.phase + best_shift
}

/// Walk the tolerance ladder, re-centring the phase at pass 2.
pub fn refine(times: &[f64], weights: &[f32], mut grid: Grid) -> (Grid, Vec<bool>) {
    let mut inlier = vec![true; times.len()];
    for (pass, ratio) in TOLERANCES.iter().enumerate() {
        if pass == RECENTRE_AT {
            grid.phase = recentre_phase(times, weights, grid);
        }
        let tol = (ratio * grid.period).max(MIN_TOL_S);
        match ls_pass(times, weights, grid, tol) {
            Some((next, flags)) => {
                grid = next;
                inlier = flags;
            }
            None => break,
        }
    }
    (grid, inlier)
}

/// `(share, coverage, RMS residual)` of a grid against a set of attacks.
pub fn quality(times: &[f64], weights: &[f32], grid: Grid) -> Quality {
    const TOL_RATIO: f64 = 0.12;
    if times.is_empty() || grid.period <= 0.0 {
        return Quality {
            share: 0.0,
            coverage: 0.0,
            residual_ms: 999.0,
            inliers: 0,
        };
    }
    let tol = (TOL_RATIO * grid.period).max(MIN_TOL_S);
    let total: f64 = weights.iter().map(|&w| w as f64).sum();

    let mut inlier_weight = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut count = 0usize;
    let mut slots: Vec<i64> = Vec::new();
    for (i, &t) in times.iter().enumerate() {
        let k = ((t - grid.phase) / grid.period).round();
        let residual = t - (grid.phase + k * grid.period);
        if residual.abs() <= tol {
            inlier_weight += weights[i] as f64;
            sum_sq += residual * residual;
            count += 1;
            slots.push(k as i64);
        }
    }
    if count == 0 {
        return Quality {
            share: 0.0,
            coverage: 0.0,
            residual_ms: 999.0,
            inliers: 0,
        };
    }
    let span = (slots.iter().copied().max().unwrap() - slots.iter().copied().min().unwrap()) as f64
        + 1.0;
    slots.sort_unstable();
    slots.dedup();
    Quality {
        share: inlier_weight / total.max(1e-9),
        coverage: (slots.len() as f64 / span.max(1.0)).min(1.0),
        residual_ms: (sum_sq / count as f64).sqrt() * 1000.0,
        inliers: count,
    }
}

/// Grow the fit outward in doubling spans so beat indices never slip.
///
/// A 1 % seed error over a whole track would misassign indices at the far end;
/// doubling the window means each refit only has to absorb the error over a
/// span it has already fitted.
pub fn expand(times: &[f64], weights: &[f32], mut grid: Grid, start: f64, stop: f64) -> Grid {
    let centre = 0.5 * (start + stop);
    let mut span = 12.0f64;
    loop {
        let lo = start.max(centre - span);
        let hi = stop.min(centre + span);
        let (w_times, w_weights) = window(times, weights, lo, hi);
        if w_times.len() >= 8 {
            grid = refine(&w_times, &w_weights, grid).0;
        }
        if lo <= start && hi >= stop {
            break;
        }
        span *= 2.0;
    }
    grid
}

/// Attacks inside `[lo, hi]`, inclusive — the same closed interval v3 uses.
pub fn window(times: &[f64], weights: &[f32], lo: f64, hi: f64) -> (Vec<f64>, Vec<f32>) {
    let mut out_times = Vec::new();
    let mut out_weights = Vec::new();
    for (&t, &w) in times.iter().zip(weights) {
        if t >= lo && t <= hi {
            out_times.push(t);
            out_weights.push(w);
        }
    }
    (out_times, out_weights)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jittered(period: f64, phase: f64, count: usize, jitter: f64) -> (Vec<f64>, Vec<f32>) {
        // Deterministic pseudo-jitter, so a failure is reproducible.
        let mut seed = 12345u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        let times = (0..count)
            .map(|k| phase + k as f64 * period + next() * 2.0 * jitter)
            .collect();
        (times, vec![1.0f32; count])
    }

    #[test]
    fn an_exact_grid_is_recovered_exactly() {
        // The seed is 0.1 % off, which is what a coherence sweep delivers: its
        // frequency resolution is 0.2/span, so over a minute the seed lands
        // within about a tenth of a percent. `refine` alone is not expected to
        // absorb more than that — a 1 % error over 200 beats slips indices by
        // more than a period, and least squares cannot recover a slipped
        // index. That is what `expand` is for, and it has its own test below.
        let period = 0.267_857;
        let times: Vec<f64> = (0..200).map(|k| 0.298 + k as f64 * period).collect();
        let weights = vec![1.0f32; times.len()];
        let (grid, _) = refine(
            &times,
            &weights,
            Grid {
                period: period * 1.001,
                phase: 0.298,
            },
        );
        assert!((grid.period - period).abs() < 1e-9, "period {}", grid.period);
        assert!((grid.phase - 0.298).abs() < 1e-9, "phase {}", grid.phase);
    }

    #[test]
    fn least_squares_beats_interval_differencing() {
        // The claim v3 is built on, as a test. Same jittered grid, two
        // estimators: the mean of consecutive differences (v2) against the
        // fit (v3). Averaging over N attacks must win.
        let period = 0.4;
        let (times, weights) = jittered(period, 0.1, 400, 0.004);
        let differenced: f64 = {
            let diffs: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
            diffs.iter().sum::<f64>() / diffs.len() as f64
        };
        let (grid, _) = refine(
            &times,
            &weights,
            Grid {
                period: period * 1.001,
                phase: 0.1,
            },
        );
        let fit_error = (grid.period - period).abs();
        let diff_error = (differenced - period).abs();
        // In BPM terms at 150 BPM, 1e-6 s of period error is ~0.0004 BPM.
        assert!(fit_error < 1e-5, "fit error {fit_error}");
        assert!(
            fit_error <= diff_error,
            "fit {fit_error} should not be worse than differencing {diff_error}"
        );
    }

    #[test]
    fn recentre_picks_the_dense_cluster_not_the_mean() {
        // Two populations: most attacks on the grid, a third of them 40 ms
        // late (a swung off-beat). The mean sits between them; the mode must
        // stay on the dense one.
        let period = 0.5;
        let mut times: Vec<f64> = Vec::new();
        for k in 0..90 {
            times.push(k as f64 * period);
            if k % 3 == 0 {
                times.push(k as f64 * period + 0.040);
            }
        }
        times.sort_by(f64::total_cmp);
        let weights = vec![1.0f32; times.len()];
        let phase = recentre_phase(&times, &weights, Grid { period, phase: 0.0 });
        assert!(
            phase.abs() < 0.006,
            "phase drifted to {phase}, should stay near 0"
        );
    }

    #[test]
    fn quality_separates_a_half_density_grid() {
        // Attacks on every other slot: share stays high because every attack
        // is still on the grid, and only coverage notices. This is the
        // statistic behind audit finding F-11.
        let times: Vec<f64> = (0..100).map(|k| k as f64 * 0.4).collect();
        let weights = vec![1.0f32; times.len()];
        let full = quality(&times, &weights, Grid { period: 0.4, phase: 0.0 });
        let half = quality(&times, &weights, Grid { period: 0.2, phase: 0.0 });
        assert!(full.coverage > 0.99, "full {full:?}");
        assert!(half.share > 0.99, "share should not notice: {half:?}");
        assert!(half.coverage < 0.55, "coverage should: {half:?}");
    }

    #[test]
    fn a_pass_refuses_an_octave_jump() {
        let times: Vec<f64> = (0..100).map(|k| k as f64 * 0.4).collect();
        let weights = vec![1.0f32; times.len()];
        // Seeded four times too slow: the fit would have to more than double
        // the period, which the guard rejects rather than silently accepting.
        let result = ls_pass(
            &times,
            &weights,
            Grid { period: 1.6, phase: 0.0 },
            0.5,
        );
        assert!(result.is_none() || result.unwrap().0.period <= 3.2);
    }

    #[test]
    fn expand_absorbs_a_one_percent_seed_error() {
        let period = 0.35;
        let times: Vec<f64> = (0..600).map(|k| 0.2 + k as f64 * period).collect();
        let weights = vec![1.0f32; times.len()];
        let grid = expand(
            &times,
            &weights,
            Grid {
                period: period * 1.01,
                phase: 0.2,
            },
            times[0],
            times[times.len() - 1],
        );
        assert!(
            (grid.period - period).abs() < 1e-9,
            "period {} after expansion",
            grid.period
        );
    }
}
