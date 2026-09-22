//! Analysis assembly: from fitted sections to the numbers a map shows.
//!
//! v3 names kept in doc comments: `_synth_beats`, `_local_bpm_curve`,
//! `_stability`, plus the `_assemble_analysis` reductions (duration-weighted
//! global BPM and residual). The per-section red lines themselves live in
//! [`crate::points`]; this module builds everything around them:
//!
//! * `beats` — the beat grid implied by the sections (the GUI trace),
//! * `local_bpms` — a genuine local-tempo trace from short least-squares
//!   fits, never from beat deltas (differencing jittery detections is the
//!   v2 error floor this engine exists to avoid),
//! * `global_bpm` — duration-weighted median across sections, so a long
//!   section counts for more than a short one,
//! * `stability` — 1 minus the MAD of the local curve relative to 3 %.

use overtone_core::GridSection;

/// Beat times implied by the fitted sections — v3 `_synth_beats`.
pub fn synth_beats(sections: &[GridSection], factor: f64) -> Vec<f64> {
    let mut beats = Vec::new();
    if !(factor > 0.0) {
        // v3 divides and crashes; an empty grid is the honest answer.
        return beats;
    }
    for section in sections {
        let period = section.period / factor;
        if !(period > 0.0) {
            continue;
        }
        let k0 = ((section.start.get() - section.phase) / period - 1e-9).ceil() as i64;
        let k1 = ((section.end.get() - section.phase) / period + 1e-9).floor() as i64;
        if k1 < k0 || k1 - k0 > 200_000 {
            continue;
        }
        for k in k0..=k1 {
            beats.push(section.phase + k as f64 * period);
        }
    }
    beats.sort_by(f64::total_cmp);
    beats
}

/// Local tempo at each beat — v3 `_local_bpm_curve`.
///
/// Each section first paints its own constant BPM; then every fourth beat
/// is re-measured by a single least-squares pass on the surrounding
/// attacks, accepted only inside [0.6×, 1.7×] of the section period
/// (an octave hop mid-measure is an artefact, not rubato); the samples are
/// interpolated back across the section, and beats no window could fit
/// inherit the median rather than zero.
pub fn local_bpm_curve(
    times: &[f64],
    weights: &[f32],
    sections: &[GridSection],
    beats: &[f64],
    factor: f64,
) -> Vec<f64> {
    let mut curve = vec![0.0f64; beats.len()];
    if beats.is_empty() {
        return curve;
    }
    for section in sections {
        let period = section.period / factor;
        if !(period > 0.0) {
            continue;
        }
        let idx: Vec<usize> = beats
            .iter()
            .enumerate()
            .filter(|(_, &t)| {
                t >= section.start.get() - 1e-9 && t <= section.end.get() + 1e-9
            })
            .map(|(i, _)| i)
            .collect();
        if idx.is_empty() {
            continue;
        }
        for &j in &idx {
            curve[j] = 60.0 / period;
        }
        let half = (4.0 * section.period).max(3.0);
        let mut sampled: Vec<usize> = Vec::new();
        for &j in idx.iter().step_by(4) {
            let t = beats[j];
            let (w_times, w_weights) = crate::fit::window(times, weights, t - half, t + half);
            if w_times.len() >= 8 {
                if let Some((grid, _)) = crate::fit::ls_pass(
                    &w_times,
                    &w_weights,
                    crate::fit::Grid { period: section.period, phase: section.phase },
                    0.12 * section.period,
                ) {
                    let local = grid.period / factor;
                    if (0.6 * period..=1.7 * period).contains(&local) {
                        curve[j] = 60.0 / local;
                    }
                }
            }
            sampled.push(j);
        }
        // Fill the sampled points across the section.
        if sampled.len() >= 2 {
            let xs: Vec<f64> = sampled.iter().map(|&j| beats[j]).collect();
            let ys: Vec<f64> = sampled.iter().map(|&j| curve[j]).collect();
            for &j in &idx {
                curve[j] = interp(beats[j], &xs, &ys);
            }
        }
    }
    let unset = curve.iter().any(|&v| v <= 0.0);
    let any_set = curve.iter().any(|&v| v > 0.0);
    if unset && any_set {
        let med = median(&curve.iter().copied().filter(|&v| v > 0.0).collect::<Vec<_>>());
        for v in curve.iter_mut().filter(|v| **v <= 0.0) {
            *v = med;
        }
    }
    curve
}

/// Stability of a local-BPM curve — v3 `_stability`.
pub fn stability(local: &[f64]) -> f64 {
    if local.len() < 2 {
        return 0.0;
    }
    let med = median(local);
    let mut dev: Vec<f64> = local.iter().map(|&v| (v - med).abs()).collect();
    dev.sort_by(f64::total_cmp);
    let mad = median(&dev);
    (1.0 - mad / (med * 0.03).max(0.4)).clamp(0.0, 1.0)
}

/// Duration-weighted global BPM — the `_assemble_analysis` reduction.
pub fn global_bpm(sections: &[GridSection], factor: f64) -> f64 {
    if sections.is_empty() {
        return 0.0;
    }
    let bpms: Vec<f64> = sections
        .iter()
        .map(|s| if s.period > 0.0 { 60.0 * factor / s.period } else { 0.0 })
        .collect();
    let durations: Vec<f64> = sections
        .iter()
        .map(|s| (s.end.get() - s.start.get()).max(1e-6))
        .collect();
    overtone_core::weighted_median(&bpms, &durations)
}

/// Duration-weighted mean grid residual in ms.
pub fn fit_residual_ms(sections: &[GridSection]) -> f64 {
    if sections.is_empty() {
        return 0.0;
    }
    let total: f64 = sections
        .iter()
        .map(|s| (s.end.get() - s.start.get()).max(1e-6))
        .sum();
    sections
        .iter()
        .map(|s| s.residual_ms * (s.end.get() - s.start.get()).max(1e-6))
        .sum::<f64>()
        / total.max(1e-9)
}

/// Median with numpy's even-count rule (mean of the middle pair).
fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        0.5 * (sorted[mid - 1] + sorted[mid])
    } else {
        sorted[mid]
    }
}

/// Piecewise-linear interpolation over increasing `xs`.
fn interp(x: f64, xs: &[f64], ys: &[f64]) -> f64 {
    debug_assert_eq!(xs.len(), ys.len());
    if xs.is_empty() {
        return 0.0;
    }
    if x <= xs[0] {
        return ys[0];
    }
    if x >= xs[xs.len() - 1] {
        return ys[ys.len() - 1];
    }
    let i = xs.partition_point(|&v| v < x).saturating_sub(1);
    let i = i.min(xs.len() - 2);
    let t = (x - xs[i]) / (xs[i + 1] - xs[i]).max(1e-12);
    ys[i] + t * (ys[i + 1] - ys[i])
}

#[cfg(test)]
mod tests {
    use super::*;
    use overtone_core::Seconds;

    fn section(start: f64, end: f64, period: f64, phase: f64) -> GridSection {
        GridSection {
            start: Seconds(start),
            end: Seconds(end),
            period,
            phase,
            inliers: 0,
            residual_ms: 0.0,
            coverage: 1.0,
        }
    }

    #[test]
    fn synth_beats_cover_the_section_on_its_grid() {
        let sections = vec![section(0.4, 10.0, 0.5, 0.4)];
        let beats = synth_beats(&sections, 1.0);
        assert_eq!(beats.len(), 20, "got {beats:?}");
        assert!((beats[0] - 0.4).abs() < 1e-9);
        assert!((beats[19] - 9.9).abs() < 1e-9);
    }

    #[test]
    fn synth_beats_double_with_the_factor() {
        let sections = vec![section(0.4, 10.0, 0.5, 0.4)];
        let once = synth_beats(&sections, 1.0);
        let twice = synth_beats(&sections, 2.0);
        assert_eq!(twice.len(), 2 * once.len() - 1);
        // Every second doubled beat lands on a plain one.
        for (i, &b) in once.iter().enumerate() {
            assert!((twice[2 * i] - b).abs() < 1e-9, "{b} vs {}", twice[2 * i]);
        }
    }

    #[test]
    fn local_curve_is_flat_on_an_exact_grid() {
        let period = 60.0 / 150.0;
        let times: Vec<f64> = (0..150).map(|k| 0.4 + k as f64 * period).collect();
        let weights = vec![1.0f32; times.len()];
        let sections = vec![section(times[0], times[times.len() - 1], period, 0.4)];
        let beats = synth_beats(&sections, 1.0);
        let curve = local_bpm_curve(&times, &weights, &sections, &beats, 1.0);
        assert_eq!(curve.len(), beats.len());
        for &bpm in &curve {
            assert!((bpm - 150.0).abs() < 1e-6, "bpm {bpm}");
        }
        assert!((stability(&curve) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn stability_punishes_wobble() {
        let flat = vec![150.0; 40];
        let wobbly: Vec<f64> = (0..40).map(|k| if k % 2 == 0 { 140.0 } else { 160.0 }).collect();
        assert!(stability(&flat) > stability(&wobbly));
        assert_eq!(stability(&[150.0]), 0.0);
        assert_eq!(stability(&[]), 0.0);
    }

    #[test]
    fn global_bpm_follows_the_long_section() {
        // 10 s at 128 BPM, 50 s at 142 BPM: the long one wins the median.
        let sections = vec![section(0.0, 10.0, 60.0 / 128.0, 0.0), section(10.0, 60.0, 60.0 / 142.0, 10.0)];
        assert!((global_bpm(&sections, 1.0) - 142.0).abs() < 1e-9);
        assert!((global_bpm(&[], 1.0) - 0.0).abs() < 1e-12);
    }

    #[test]
    fn residual_averages_by_duration() {
        let mut a = section(0.0, 10.0, 0.5, 0.0);
        let mut b = section(10.0, 40.0, 0.5, 0.0);
        a.residual_ms = 1.0;
        b.residual_ms = 3.0;
        assert!((fit_residual_ms(&[a, b]) - 2.5).abs() < 1e-9);
    }
}
