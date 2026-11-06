//! The whole tempo stage on one track's attacks.

use overtone_core::{Diagnostic, GridSection, TimingPoint};

use crate::fit::{self, Grid};

use super::*;

/// What the pipeline refused to do, and why — carried on the result so a
/// caller can tell "this audio has no grid" from "the engine crashed"
/// (audit F-08).
pub struct PipelineOutput {
    pub points: Vec<TimingPoint>,
    pub atom_sections: Vec<GridSection>,
    pub beat_sections: Vec<GridSection>,
    pub settled_sections: Vec<GridSection>,
    pub meter_text: String,
    pub downbeat: usize,
    pub meter_beats: usize,
    pub atoms_per_beat: usize,
    pub first_class: usize,
    /// Beat grid implied by the settled sections (the GUI trace).
    pub beats: Vec<f64>,
    /// Local tempo at each beat, from short least-squares fits.
    pub local_bpms: Vec<f64>,
    /// Duration-weighted global BPM.
    pub global_bpm: f64,
    /// Stability of the local curve: 1 is a metronome.
    pub stability: f64,
    /// Duration-weighted grid residual in ms.
    pub fit_residual_ms: f64,
    pub diagnostics: Vec<Diagnostic>,
}

/// End-to-end precision driver over already-detected attacks: seed, octave,
/// grow, beat-convert, settle, meter, points — v3 `_precision_engine` plus
/// the `_assemble_analysis` filters at `factor = 1`.
#[allow(clippy::too_many_arguments)]
pub fn analyze_attacks(
    times: &[f64],
    weights: &[f32],
    env: &[f32],
    sr: u32,
    min_delta: f64,
    persistence: usize,
    prefer_map_bpm: bool,
    min_confidence: f64,
) -> PipelineOutput {
    let empty = |diagnostics: Vec<Diagnostic>| PipelineOutput {
        points: Vec::new(),
        atom_sections: Vec::new(),
        beat_sections: Vec::new(),
        settled_sections: Vec::new(),
        meter_text: "4/4".to_string(),
        downbeat: 0,
        meter_beats: 4,
        atoms_per_beat: 1,
        first_class: 0,
        beats: Vec::new(),
        local_bpms: Vec::new(),
        global_bpm: 0.0,
        stability: 0.0,
        fit_residual_ms: 0.0,
        diagnostics,
    };
    if times.len() < 24 {
        return empty(vec![Diagnostic::TooFewAttacks {
            found: times.len(),
            needed: 24,
        }]);
    }
    let (anchor, anchor_hi) = crate::anchor_window(times);
    let Some(seed) = crate::seed_grid(times, weights, anchor, anchor_hi, None, &crate::SEED_WIDTHS)
    else {
        return empty(vec![Diagnostic::NoCoherentPulse { best_share: 0.0 }]);
    };
    let (w_times, w_weights) = crate::fit::window(times, weights, anchor, anchor_hi);
    let share = fit::quality(
        &w_times,
        &w_weights,
        Grid {
            period: seed.period,
            phase: seed.phase,
        },
    )
    .share;
    if share < 0.40 {
        return empty(vec![Diagnostic::NoCoherentPulse { best_share: share }]);
    }
    let seed_grid = Grid {
        period: seed.period,
        phase: seed.phase,
    };
    if crate::pulse::is_chance(&w_times, seed_grid, env, sr, overtone_core::FIT_HOP) {
        // Chance explains the grid's inliers and the envelope agrees.
        return empty(vec![Diagnostic::NoCoherentPulse { best_share: share }]);
    }

    let hints = crate::octave::tempo_hints(env, sr, overtone_core::FIT_HOP);
    let (w2_times, w2_weights) = crate::fit::window(times, weights, anchor, anchor_hi);
    let (m, first_class) = crate::octave::beat_from_atoms(
        &w2_times,
        &w2_weights,
        Grid {
            period: seed.period,
            phase: seed.phase,
        },
        &hints,
        prefer_map_bpm,
    );

    let atom = crate::sections::grow_sections(
        times,
        weights,
        seed.period,
        seed.phase,
        (min_delta * m as f64).max(1e-3),
        (persistence * m).max(2),
    );
    if atom.is_empty() {
        return empty(vec![Diagnostic::StageFailed {
            stage: "sections".to_string(),
            detail: "growth found no sections".to_string(),
        }]);
    }
    // first_class counts atoms from the anchor seed's phase, but section 0 was
    // seeded again inside grow_sections and its phase can sit whole atoms
    // away; applied as-is, the class then names the off-beat. Re-express it in
    // section 0's own frame, rounding halves as the Python reference does.
    let shift = ((atom[0].phase - seed.phase) / seed.period + 0.5).floor() as i64;
    let first_class = (first_class as i64 - shift).rem_euclid(m.max(1) as i64) as usize;
    let w32: Vec<f32> = weights.to_vec();
    let beats = crate::sections::beat_sections(&atom, times, &w32, m.max(1), first_class);
    let one = crate::sections::one_octave(beats.clone(), times, &w32);
    let settled = crate::sections::settle_boundaries(times, &w32, one, SETTLE_ROUNDS);
    let (meter_text, downbeat, meter_beats) = match settled.first() {
        Some(first) => {
            let (text, down, bar) = crate::octave::meter_from_grid(
                times,
                &w32,
                Grid {
                    period: first.period,
                    phase: first.phase,
                },
            );
            (text.to_string(), down, bar)
        }
        None => ("4/4".to_string(), 0, 1),
    };
    let first_sound = settled
        .first()
        .map_or(times[0], |first| first_on_grid(times, first));
    let points = assemble_points(
        &settled,
        times,
        &w32,
        first_sound,
        persistence,
        downbeat,
        meter_beats,
        min_delta,
        min_confidence,
    );
    let beat_times = crate::analysis::synth_beats(&settled, 1.0);
    let local = crate::analysis::local_bpm_curve(times, &w32, &settled, &beat_times, 1.0);
    let global_bpm = crate::analysis::global_bpm(&settled, 1.0);
    let stability = crate::analysis::stability(&local);
    let fit_residual_ms = crate::analysis::fit_residual_ms(&settled);
    PipelineOutput {
        points,
        atom_sections: atom,
        beat_sections: beats,
        settled_sections: settled,
        meter_text,
        downbeat,
        meter_beats,
        atoms_per_beat: m,
        first_class,
        beats: beat_times,
        local_bpms: local,
        global_bpm,
        stability,
        fit_residual_ms,
        diagnostics: Vec::new(),
    }
}

pub(crate) fn windowed(
    times: &[f64],
    weights: &[f32],
    mut keep: impl FnMut(f64) -> bool,
) -> (Vec<f64>, Vec<f32>) {
    let mut out_times = Vec::new();
    let mut out_weights = Vec::new();
    for (&t, &w) in times.iter().zip(weights.iter()) {
        if keep(t) {
            out_times.push(t);
            out_weights.push(w);
        }
    }
    (out_times, out_weights)
}

pub(crate) fn argmax(values: &[f64]) -> usize {
    let mut best = 0usize;
    for (i, &v) in values.iter().enumerate() {
        if v > values[best] {
            best = i;
        }
    }
    best
}
