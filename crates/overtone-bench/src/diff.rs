//! Section-by-section diffs and the per-case report.

use crate::vectors::*;

/// The envelope itself, which the gate used to dump but never read: correlation
/// on the weights alone passed a symmetric Hann window that moves the sum by
/// 0.6-7.1. Measured float noise against v3's float32 sum: at most 0.00098
/// (long-6min), 0.00033 on every other fixture.
pub(crate) const ENV_SUM_TOL: f64 = 2e-3;
/// Each matched attack's weight against v3's, stored to 5 decimals: measured
/// at most 5.4e-6, the rounding itself. Correlation alone allowed ~1.5 %.
pub(crate) const WEIGHT_TOL: f64 = 2e-5;

/// Boundaries become red lines, so a moved boundary is a moved red line.
/// 5 ms is the benchmark's own offset tolerance.
pub(crate) const BOUNDARY_TOL_S: f64 = 5e-3;

/// A grown region ends on an attack time where a tempo step falls on its
/// edge (secs-3, three-sections, change-128-142), and whether `t <= end`
/// keeps that attack is a float tie: v3 drops it, Rust keeps it. One count;
/// before growth counted the refinement's own mask it was up to 62.
pub(crate) const INLIER_TOL: usize = 1;

pub(crate) struct SectionDiff {
    pub(crate) name: &'static str,
    pub(crate) expected: usize,
    pub(crate) found: usize,
    pub(crate) worst_period_err: f64,
    pub(crate) worst_phase_ms: f64,
    pub(crate) worst_bpm_err: f64,
    pub(crate) worst_residual_err: f64,
    pub(crate) worst_boundary_err: f64,
    /// Attacks on the grid, counted as v3 counts them at that stage. Never
    /// compared until the audit found growth counting another way.
    pub(crate) worst_inliers_err: usize,
}

impl SectionDiff {
    pub(crate) fn ok(&self) -> bool {
        self.expected == self.found
            && self.worst_period_err <= PERIOD_TOL_S
            && self.worst_phase_ms <= ATTACK_TOL_S * 1000.0
            && self.worst_bpm_err <= 1e-3
            && self.worst_residual_err <= 0.05
            && self.worst_boundary_err <= BOUNDARY_TOL_S
            && self.worst_inliers_err <= INLIER_TOL
    }

    pub(crate) fn describe(&self) -> Option<String> {
        if self.expected != self.found {
            return Some(format!(
                "{}: {} sections -> {}",
                self.name, self.expected, self.found
            ));
        }
        let mut bits = Vec::new();
        if self.worst_period_err > PERIOD_TOL_S {
            bits.push(format!("period {:.2e}s off", self.worst_period_err));
        }
        if self.worst_phase_ms > ATTACK_TOL_S * 1000.0 {
            bits.push(format!("phase {:.4}ms off", self.worst_phase_ms));
        }
        if self.worst_bpm_err > 1e-3 {
            bits.push(format!("bpm {:.4} off", self.worst_bpm_err));
        }
        if self.worst_residual_err > 0.05 {
            bits.push(format!("residual {:.4}ms off", self.worst_residual_err));
        }
        if self.worst_boundary_err > BOUNDARY_TOL_S {
            bits.push(format!("boundary {:.3}s off", self.worst_boundary_err));
        }
        if self.worst_inliers_err > INLIER_TOL {
            bits.push(format!("inliers off by {}", self.worst_inliers_err));
        }
        if bits.is_empty() {
            None
        } else {
            Some(format!("{}: {}", self.name, bits.join(", ")))
        }
    }
}

pub(crate) fn diff_sections(
    name: &'static str,
    got: &[overtone_core::GridSection],
    want: &[GoldenSection],
) -> SectionDiff {
    let mut diff = SectionDiff {
        name,
        expected: want.len(),
        found: got.len(),
        worst_period_err: 0.0,
        worst_phase_ms: 0.0,
        worst_bpm_err: 0.0,
        worst_residual_err: 0.0,
        worst_boundary_err: 0.0,
        worst_inliers_err: 0,
    };
    if got.len() != want.len() {
        return diff;
    }
    for (g, w) in got.iter().zip(want.iter()) {
        diff.worst_period_err = diff.worst_period_err.max((g.period - w.period_s).abs());
        diff.worst_phase_ms = diff
            .worst_phase_ms
            .max((g.phase - w.phase_s).abs() * 1000.0);
        let bpm = if g.period > 0.0 { 60.0 / g.period } else { 0.0 };
        diff.worst_bpm_err = diff.worst_bpm_err.max((bpm - w.bpm).abs());
        diff.worst_residual_err = diff
            .worst_residual_err
            .max((g.residual_ms - w.residual_ms).abs());
        diff.worst_boundary_err = diff
            .worst_boundary_err
            .max((g.start.get() - w.start_s).abs())
            .max((g.end.get() - w.end_s).abs());
        diff.worst_inliers_err = diff.worst_inliers_err.max(g.inliers.abs_diff(w.inliers));
    }
    diff
}

pub(crate) struct Report {
    pub(crate) case: String,
    pub(crate) decode_s: f64,
    /// Attack detection (envelope, peaks, re-timing).
    pub(crate) attacks_s: f64,
    /// The tempo pipeline: seed, octave, sections, meter, points.
    pub(crate) tempo_s: f64,
    pub(crate) seed_in_candidates: bool,
    pub(crate) octave_expected: usize,
    pub(crate) octave_found: usize,
    pub(crate) class_expected: usize,
    pub(crate) class_found: usize,
    pub(crate) seed_period_err: f64,
    pub(crate) seed_phase_ms: f64,
    pub(crate) expected: usize,
    pub(crate) found: usize,
    pub(crate) matched: usize,
    pub(crate) worst_ms: f64,
    pub(crate) worst_at: f64,
    pub(crate) env_frames_expected: usize,
    pub(crate) env_frames_found: usize,
    pub(crate) weight_correlation: f64,
    /// |sum of our envelope - v3's|.
    pub(crate) env_sum_err: f64,
    /// Largest |our weight - v3's| over matched attacks.
    pub(crate) worst_weight_err: f64,
    pub(crate) atom: SectionDiff,
    pub(crate) beat: SectionDiff,
    pub(crate) settled: SectionDiff,
    pub(crate) meter_diff: Option<String>,
    pub(crate) points_diff: Option<String>,
    pub(crate) global_bpm_err: f64,
}

impl Report {
    pub(crate) fn ok(&self) -> bool {
        self.found == self.expected
            && self.matched == self.expected
            && self.worst_ms <= ATTACK_TOL_S * 1000.0
            && self.env_frames_found == self.env_frames_expected
            && self.seed_in_candidates
            && self.octave_found == self.octave_expected
            && self.class_found == self.class_expected
            && self.weight_correlation > 0.999
            && self.env_sum_err <= ENV_SUM_TOL
            && self.worst_weight_err <= WEIGHT_TOL
            && self.seed_period_err <= PERIOD_TOL_S
            && self.seed_phase_ms <= ATTACK_TOL_S * 1000.0
            && self.atom.ok()
            && self.beat.ok()
            && self.settled.ok()
            && self.meter_diff.is_none()
            && self.points_diff.is_none()
            && self.global_bpm_err <= 1e-3
    }
}
