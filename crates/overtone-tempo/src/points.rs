//! Timing points from fitted sections: meter, confidence, red lines.
//!
//! v3 names kept in doc comments: `_section_confidence`, `section_measures`,
//! `detect_bar`, `meter_segments`, `_settle_meter_boundary`,
//! `points_from_meter`, `_points_from_sections`, `snap_timing_points`,
//! `osu_timing_text`. The v3.2/v3.3 additions (per-section meter, measure-grid
//! points) are part of this port, not optional extras: the golden vectors pin
//! `meter`, and `result.points` is compared stage by stage.
//!
//! The physical model for the meter path is Tempora's: measures per second is
//! the quantity, BPM its presentation through the signature
//! (`MpsToBpm(mps) = mps * 60 * beats_per_bar`).

use overtone_core::{Diagnostic, GridSection, TimingPoint};

use crate::fit::{self, Grid};

/// Beats a bar may hold. Not every integer: 11 beats to a bar is not a time
/// signature, it is a fit artefact — v3 `BAR_MULTIPLES`.
pub const BAR_MULTIPLES: [usize; 9] = [2, 3, 4, 5, 6, 7, 8, 9, 12];
/// Beats-per-bar a *region* may be written in — v3 `BEATS_PER_BAR`.
pub const BEATS_PER_BAR: [usize; 6] = [2, 3, 4, 6, 8, 12];
/// A bar is only claimed when its downbeat stands out by this much.
pub const BAR_CONTRAST: f64 = 1.20;
/// A meter region must hold at least this many bars to be worth a red line.
pub const MIN_METER_BARS: usize = 4;
/// Rounds of boundary-search / refit alternation (matches sections).
pub const SETTLE_ROUNDS: usize = 2;

/// Confidence of one section — v3 `_section_confidence`.
pub fn section_confidence(section: &GridSection, persistence: usize) -> f64 {
    let beat_ms = section.period * 1000.0;
    if beat_ms <= 0.0 {
        return 0.0;
    }
    let tightness = 1.0 - (section.residual_ms / (0.06 * beat_ms).max(2.0)).min(1.0);
    let beats = ((section.end.get() - section.start.get()) / section.period).max(1.0);
    let length_bonus = (beats / (persistence as f64 * 3.0).max(1.0)).min(1.0);
    (0.55 * tightness + 0.30 * (section.coverage * 1.15).min(1.0) + 0.15 * length_bonus)
        .clamp(0.0, 1.0)
}

/// Per-section `(meter text, downbeat class, beats per bar)` — v3
/// `section_measures`. Each section is measured on its own attacks; a section
/// whose accents prove nothing reports bar `1` ("anchor to a beat, not a
/// bar").
pub fn section_measures(
    sections: &[GridSection],
    times: &[f64],
    weights: &[f32],
) -> Vec<(String, usize, usize)> {
    let mut out = Vec::with_capacity(sections.len());
    for section in sections {
        let (w_times, w_weights) = windowed(times, weights, |t| {
            t >= section.start.get() - section.period && t <= section.end.get() + section.period
        });
        if w_times.len() < 12 {
            out.push(("4/4".to_string(), 0, 1));
            continue;
        }
        let (text, downbeat, bar) = crate::octave::meter_from_grid(
            &w_times,
            &w_weights,
            Grid {
                period: section.period,
                phase: section.phase,
            },
        );
        out.push((text.to_string(), downbeat, bar));
    }
    out
}

/// A proven bar: `(bar_seconds, bar_phase, beats_in_bar, contrast)` — v3
/// `detect_bar`. `None` when the accents prove nothing; refusing is the right
/// answer then, because an invented bar moves every red line.
pub fn detect_bar(
    times: &[f64],
    weights: &[f32],
    period: f64,
    phase: f64,
) -> Option<(f64, f64, usize, f64)> {
    if times.len() < 16 || period <= 0.0 {
        return None;
    }
    let mut ks: Vec<f64> = Vec::new();
    let mut ws: Vec<f64> = Vec::new();
    for (&t, &w) in times.iter().zip(weights.iter()) {
        let k = ((t - phase) / period).round();
        if (t - (phase + k * period)).abs() <= 0.15 * period {
            ks.push(k);
            ws.push(w as f64);
        }
    }
    if ks.len() < 16 {
        return None;
    }
    let span = ks.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        - ks.iter().copied().fold(f64::INFINITY, f64::min);

    let mut best: Option<(f64, f64, usize, f64)> = None;
    for m in BAR_MULTIPLES {
        if span < m as f64 * 4.0 {
            continue;
        }
        let mut totals = vec![0.0f64; m];
        let mut counts = vec![0usize; m];
        for (&k, &w) in ks.iter().zip(ws.iter()) {
            let c = k.rem_euclid(m as f64) as usize % m;
            totals[c] += w;
            counts[c] += 1;
        }
        let means: Vec<f64> = (0..m)
            .map(|c| totals[c] / counts[c].max(1) as f64)
            .collect();
        let r = argmax(&means);
        let mean_all = means.iter().sum::<f64>() / m as f64;
        let contrast = means[r] / mean_all.max(1e-9);
        // Strongest downbeat wins; longest-bar was tried and is wrong (a
        // four-bar hypermeasure outscores the true bar). Near-ties go to the
        // shorter reading, the one a mapper writes.
        if contrast < BAR_CONTRAST {
            continue;
        }
        let replace = match best {
            None => true,
            Some((_, _, _, c)) => contrast > c * 1.05,
        };
        if replace {
            best = Some((period * m as f64, phase + r as f64 * period, m, contrast));
        }
    }
    best
}

/// One time-signature region: `(start_s, end_s, beats_in_bar, score)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeterSegment {
    pub start: f64,
    pub end: f64,
    pub beats: usize,
    pub score: f64,
}

/// Split a track into regions by how the bar is subdivided — v3
/// `meter_segments`. Windows are scored with the same `share × coverage` the
/// seeder uses: a grid twice too fine fills half its own slots, one too
/// coarse leaves attacks off it.
pub fn meter_segments(
    times: &[f64],
    weights: &[f32],
    bar: f64,
    bar_phase: f64,
) -> Vec<MeterSegment> {
    meter_segments_with(times, weights, bar, bar_phase, 4)
}

fn meter_segments_with(
    times: &[f64],
    weights: &[f32],
    bar: f64,
    bar_phase: f64,
    window_bars: usize,
) -> Vec<MeterSegment> {
    if times.len() < 16 || bar <= 0.0 {
        return Vec::new();
    }
    let start = times[0];
    let stop = times[times.len() - 1];
    let span = window_bars as f64 * bar;
    if stop - start < 2.0 * span {
        return Vec::new();
    }

    let mut windows: Vec<(f64, usize, f64)> = Vec::new();
    let mut edge = bar_phase + ((start - bar_phase) / bar).floor() * bar;
    while edge + span <= stop + 1e-9 {
        let (w_times, w_weights) = windowed(times, weights, |t| t >= edge && t < edge + span);
        if w_times.len() >= 6 {
            let mut scored: Vec<(f64, usize)> = Vec::new();
            for beats in BEATS_PER_BAR {
                let q = fit::quality(
                    &w_times,
                    &w_weights,
                    Grid {
                        period: bar / beats as f64,
                        phase: bar_phase,
                    },
                );
                scored.push((q.share * q.coverage, beats));
            }
            scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.cmp(&a.1)));
            windows.push((edge, scored[0].1, scored[0].0));
        }
        edge += span;
    }
    if windows.len() < 2 {
        return Vec::new();
    }

    // Merge agreeing neighbours, drop runs too short to be a signature change.
    let mut runs: Vec<(f64, f64, usize, Vec<f64>)> = Vec::new();
    for (edge, beats, score) in windows {
        if let Some(last) = runs.last_mut() {
            if last.2 == beats {
                last.1 = edge + span;
                last.3.push(score);
                continue;
            }
        }
        runs.push((edge, edge + span, beats, vec![score]));
    }
    let merged: Vec<(f64, f64, usize, Vec<f64>)> = runs
        .into_iter()
        // Whole windows, as v3 counts them: one window's length in seconds IS
        // MIN_METER_BARS bars, and comparing the two was an ulp coin flip.
        .filter(|r| r.3.len() * window_bars >= MIN_METER_BARS)
        .collect();
    if merged.len() < 2 {
        return Vec::new();
    }
    let mut out: Vec<MeterSegment> = Vec::new();
    for (n, run) in merged.iter().enumerate() {
        let end = if n + 1 < merged.len() {
            merged[n + 1].0
        } else {
            stop
        };
        let mean = run.3.iter().sum::<f64>() / run.3.len() as f64;
        out.push(MeterSegment {
            start: run.0,
            end,
            beats: run.2,
            score: mean,
        });
    }
    for n in 1..out.len() {
        let settled = settle_meter_boundary(
            times,
            weights,
            bar,
            bar_phase,
            out[n - 1].beats,
            out[n].beats,
            out[n].start,
            window_bars,
        );
        out[n - 1].end = settled;
        out[n].start = settled;
    }
    out
}

/// First bar reading as the new signature — v3 `_settle_meter_boundary`.
/// Takes the first bar where the new signature wins *and keeps winning*:
/// a single ambiguous bar at a transition must not move the red line.
#[allow(clippy::too_many_arguments)]
pub fn settle_meter_boundary(
    times: &[f64],
    weights: &[f32],
    bar: f64,
    bar_phase: f64,
    left_beats: usize,
    right_beats: usize,
    rough: f64,
    window_bars: usize,
) -> f64 {
    if left_beats == right_beats || bar <= 0.0 {
        return rough;
    }
    let reads_as = |index: i64| -> Option<usize> {
        let lo = bar_phase + index as f64 * bar;
        let (w_times, w_weights) = windowed(times, weights, |t| t >= lo && t < lo + bar);
        if w_times.len() < 3 {
            return None;
        }
        let mut scores = [0.0f64; 2];
        for (i, &beats) in [left_beats, right_beats].iter().enumerate() {
            let q = fit::quality(
                &w_times,
                &w_weights,
                Grid {
                    period: bar / beats as f64,
                    phase: bar_phase,
                },
            );
            scores[i] = q.share * q.coverage;
        }
        if (scores[0] - scores[1]).abs() < 1e-9 {
            return None;
        }
        Some(if scores[1] > scores[0] {
            right_beats
        } else {
            left_beats
        })
    };
    let centre = ((rough - bar_phase) / bar).round() as i64;
    for step in -(window_bars as i64)..=(window_bars as i64) {
        let index = centre + step;
        if reads_as(index) == Some(right_beats) && reads_as(index + 1) != Some(left_beats) {
            return bar_phase + index as f64 * bar;
        }
    }
    rough
}

/// How close, in beats, every section's beat must divide the measured bar
/// for the whole track to be one bar in several notations — v3 `BAR_TILE_TOL`.
pub const BAR_TILE_TOL: f64 = 0.02;

/// Red lines from the measure grid, one per signature region — v3
/// `points_from_meter`. `None` when the track gives no reason: no provable
/// bar, a single signature, or a forced subdivision (`factor != 1`).
pub fn points_from_meter(
    sections: &[GridSection],
    times: &[f64],
    weights: &[f32],
    factor: f64,
) -> Option<Vec<TimingPoint>> {
    if sections.is_empty() || times.len() < 16 || factor != 1.0 {
        return None;
    }
    // .rev(): the first of equally long sections, as v3's max() keeps it.
    let primary = sections
        .iter()
        .rev()
        .max_by(|a, b| (a.end.get() - a.start.get()).total_cmp(&(b.end.get() - b.start.get())))?;
    let (bar, bar_phase, _, _) = detect_bar(times, weights, primary.period, primary.phase)?;
    // The bar is measured on one section and applied to the whole track, so
    // every section's beat must tile it. A signature change over a constant
    // bar does (1.2 s / 0.4 s = 3); a real tempo change does not
    // (128 -> 150 BPM: 1.875 s / 0.4 s = 4.69) and used to be replaced by one
    // red line at the first tempo. A tempo change is the section path's job.
    let tiles = sections.iter().all(|section| {
        let beats = bar / section.period;
        beats.round() >= 1.0 && (beats - beats.round()).abs() <= BAR_TILE_TOL
    });
    if !tiles {
        return None;
    }
    let segments = meter_segments(times, weights, bar, bar_phase);
    if segments.len() < 2 {
        return None;
    }
    let mut points = Vec::with_capacity(segments.len());
    for (n, seg) in segments.iter().enumerate() {
        let bpm = (60.0 / bar) * seg.beats as f64;
        if !(20.0..=900.0).contains(&bpm) {
            return None;
        }
        let mut point = TimingPoint::new(seg.start * 1000.0, bpm, seg.score.clamp(0.0, 1.0), n);
        point.meter = seg.beats as u32;
        point.meter_known = true;
        points.push(point);
    }
    Some(points)
}

/// The first attack `section`'s grid counts as its own (within 0.12 of a
/// beat) — v3 `_first_on_grid`. The first red line is placed from the first
/// sound; with no bar to anchor it, an off-grid attack before the music (noise
/// from 0 s, a stray click) put it on the grid beat before the music began.
pub fn first_on_grid(times: &[f64], section: &GridSection) -> f64 {
    let tol = 0.12 * section.period;
    times
        .iter()
        .copied()
        .find(|&t| {
            let k = ((t - section.phase) / section.period).round();
            (t - (section.phase + k * section.period)).abs() <= tol
        })
        .or_else(|| times.first().copied())
        .unwrap_or(section.start.get())
}

/// Fitted grids into red lines, each on a (down)beat of its own grid — v3
/// `_points_from_sections`.
#[allow(clippy::too_many_arguments)]
pub fn points_from_sections(
    sections: &[GridSection],
    first_sound: f64,
    persistence: usize,
    downbeat_class: usize,
    meter: usize,
    factor: f64,
    measures: Option<&[(String, usize, usize)]>,
) -> Vec<TimingPoint> {
    let mut points = Vec::new();
    for (n, section) in sections.iter().enumerate() {
        let period = section.period / factor;
        if !period.is_finite() || period <= 0.0 {
            continue;
        }
        let bpm = 60.0 / period;
        // The plausibility range reads the section's own tempo, not the one a
        // pulse factor presents — v3 `_points_from_sections`.
        if !(20.0..=900.0).contains(&(60.0 / section.period)) {
            continue;
        }
        // Per-section bar, falling back to the global reading for section 0.
        let (section_downbeat, section_bar) = match measures {
            Some(list) if n < list.len() => (list[n].1, list[n].2),
            _ if n == 0 => (downbeat_class, meter),
            _ => (0, 1),
        };
        let known = section_bar > 1;

        let offset = if n == 0 {
            let anchor = section.phase + section_downbeat as f64 * section.period;
            let span = section.period * (1.max(section_bar) as f64);
            let start = section.start.get().max(first_sound) - 0.25 * period;
            let mut offset = anchor + ((start - anchor) / span - 1e-9).ceil() * span;
            while offset < first_sound - 0.55 * period {
                offset += span;
            }
            offset
        } else if known {
            let anchor = section.phase + section_downbeat as f64 * section.period;
            let span = section.period * section_bar as f64;
            // Quarter-period slack, as section 0 has: the refit can leave the
            // boundary beat microseconds before the settled start, and a bare
            // ceil then put the red line a whole beat (or bar) late.
            anchor + ((section.start.get() - 0.25 * period - anchor) / span - 1e-9).ceil() * span
        } else {
            let anchor = section.phase;
            anchor + ((section.start.get() - 0.25 * period - anchor) / period - 1e-9).ceil() * period
        };
        let mut point = TimingPoint::new(
            offset * 1000.0,
            bpm,
            section_confidence(section, persistence),
            n,
        );
        point.meter = if known { 1.max(section_bar) as u32 } else { 4 };
        point.meter_known = known;
        points.push(point);
    }
    points
}

/// How far snapping may move a change onto the previous grid — v3
/// `SNAP_TOLERANCE_MS`. Section changes sit 0.005-0.026 ms off it; anything
/// further is where the music put the change.
pub const SNAP_TOLERANCE_MS: f64 = 1.0;

/// Remove rounding noise between a change and the previous grid — v3
/// `snap_timing_points`. The engine places no hand-edited points, so there is
/// no manual flag to honour here.
pub fn snap_timing_points(points: &[TimingPoint]) -> Vec<TimingPoint> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut snapped: Vec<TimingPoint> = vec![points[0]];
    for point in points.iter().skip(1) {
        let previous = *snapped.last().unwrap();
        if previous.bpm.get() <= 0.0 {
            snapped.push(*point);
            continue;
        }
        let beat_length = 60000.0 / previous.bpm.get();
        let beat_count = ((point.offset.get() - previous.offset.get()) / beat_length)
            .round()
            .max(1.0);
        let offset = previous.offset.get() + beat_count * beat_length;
        if (offset - point.offset.get()).abs() > SNAP_TOLERANCE_MS {
            snapped.push(*point);
            continue;
        }
        let mut moved = *point;
        moved.offset = overtone_core::Millis(offset);
        snapped.push(moved);
    }
    snapped
}

/// Full red-line assembly mirroring `_assemble_analysis` at `factor = 1`:
/// measure grid wins when it applies, else per-section placement, then the
/// confidence and convergence filters, then snapping.
#[allow(clippy::too_many_arguments)]
pub fn assemble_points(
    sections: &[GridSection],
    times: &[f64],
    weights: &[f32],
    first_sound: f64,
    persistence: usize,
    downbeat: usize,
    meter_beats: usize,
    min_delta: f64,
    min_confidence: f64,
) -> Vec<TimingPoint> {
    let points = match points_from_meter(sections, times, weights, 1.0) {
        Some(meter_points) => meter_points,
        None => {
            let measures = section_measures(sections, times, weights);
            points_from_sections(
                sections,
                first_sound,
                persistence,
                downbeat,
                meter_beats,
                1.0,
                Some(&measures),
            )
        }
    };
    let mut kept: Vec<TimingPoint> = points
        .iter()
        .copied()
        .filter(|p| p.confidence >= min_confidence)
        .collect();
    if kept.is_empty() && !points.is_empty() {
        // .rev(): the first of equally confident points, as v3's max().
        let best = points
            .iter()
            .rev()
            .max_by(|a, b| a.confidence.total_cmp(&b.confidence))
            .unwrap();
        kept.push(*best);
    }
    // Two sections can converge once each is refitted on its own attacks.
    let mut final_points: Vec<TimingPoint> = Vec::new();
    for point in kept {
        match final_points.last() {
            Some(last) if (point.bpm.get() - last.bpm.get()).abs() < min_delta => {}
            _ => final_points.push(point),
        }
    }
    snap_timing_points(&final_points)
}

/// Uninherited (red) timing points as `.osu` `[TimingPoints]` rows — v3
/// `osu_timing_text`. Offsets are whole milliseconds by default, the 12-decimal
/// beat length is exact, and each line carries the bar its own section proved
/// (falling back to the analysis meter, never to a hard-coded 4).
pub fn osu_timing_text(points: &[TimingPoint], analysis_meter: &str, decimals: u32) -> String {
    let mut rows = vec![format!("// Generated by Overtone v{}", crate::VERSION)];
    let fallback = analysis_meter
        .split('/')
        .next()
        .and_then(|s| s.parse::<i64>().ok())
        .map(|m| m.clamp(1, 16) as u32)
        .unwrap_or(4)
        .max(1);
    for p in snap_timing_points(points) {
        if !p.bpm.get().is_finite() || p.bpm.get() <= 0.0 || !p.offset.get().is_finite() {
            continue;
        }
        let beat_length = 60000.0 / p.bpm.get();
        let offset = if decimals > 0 {
            format!("{:.*}", decimals as usize, p.offset.get())
        } else {
            format!("{}", p.offset.get().round() as i64)
        };
        let meter = if p.meter_known {
            p.meter.clamp(1, 16)
        } else {
            fallback
        };
        rows.push(format!("{offset},{beat_length:.12},{meter},1,0,100,1,0"));
    }
    rows.join("\n")
}

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
    let settled = crate::sections::settle_boundaries(times, &w32, beats.clone(), SETTLE_ROUNDS);
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

fn windowed(
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

fn argmax(values: &[f64]) -> usize {
    let mut best = 0usize;
    for (i, &v) in values.iter().enumerate() {
        if v > values[best] {
            best = i;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use overtone_core::Seconds;

    fn drum(atom: f64, phase: f64, from: f64, to: f64) -> (Vec<f64>, Vec<f32>) {
        let mut times = Vec::new();
        let mut weights = Vec::new();
        let mut k = ((from - phase) / atom).ceil() as i64;
        loop {
            let t = phase + k as f64 * atom;
            if t > to {
                break;
            }
            times.push(t);
            weights.push(if k.rem_euclid(4) == 0 { 1.0 } else { 0.5 });
            k += 1;
        }
        (times, weights)
    }

    fn beat_track(
        period: f64,
        phase: f64,
        beats: usize,
        downbeat_weight: f32,
    ) -> (Vec<f64>, Vec<f32>) {
        let times: Vec<f64> = (0..beats).map(|k| phase + k as f64 * period).collect();
        let weights: Vec<f32> = (0..beats)
            .map(|k| if k % 4 == 0 { downbeat_weight } else { 0.6 })
            .collect();
        (times, weights)
    }

    fn section_of(start: f64, end: f64, period: f64, phase: f64) -> GridSection {
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

    /// Eighth-note attacks with accented beats, first beat at `start`.
    fn eighths(bpm: f64, start: f64, to: f64) -> (Vec<f64>, Vec<f32>) {
        let atom = 30.0 / bpm;
        let mut times = Vec::new();
        let mut weights = Vec::new();
        let mut k = 0i64;
        loop {
            let t = start + k as f64 * atom;
            if t > to {
                break;
            }
            times.push(t);
            weights.push(if k % 2 == 0 { 1.0 } else { 0.45 });
            k += 1;
        }
        (times, weights)
    }

    #[test]
    fn first_red_line_lands_on_the_beat_when_the_song_starts_on_the_atom_grid() {
        // Section 0 used to apply a beat class counted from the anchor seed's
        // phase, while its own phase came from a second seed that can sit a
        // whole atom away: the only red line landed on the off-beat, 250 ms
        // late at 120 BPM, on tracks that start on the eighth-note grid.
        for &(bpm, start) in &[(120.0, 0.5), (120.0, 1.0), (120.0, 0.25), (150.0, 0.6), (150.0, 0.4)] {
            let (times, weights) = eighths(bpm, start, 40.0);
            let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
            let first = out.points.first().expect("a red line");
            let beat_ms = 60_000.0 / bpm;
            let k = (first.offset.get() - start * 1000.0) / beat_ms;
            let off = (k - k.round()).abs() * beat_ms;
            assert!(
                off < 5.0,
                "{bpm} BPM from {start} s: red line at {:.1} ms is {off:.1} ms off the beat",
                first.offset.get()
            );
        }
    }

    /// A heavy downbeat and light beats. `segments` = [(bpm, bars, beats)].
    fn accented(segments: &[(f64, usize, usize)]) -> (Vec<f64>, Vec<f32>) {
        let (mut times, mut weights, mut t) = (Vec::new(), Vec::new(), 0.5);
        for &(bpm, bars, beats) in segments {
            for _ in 0..bars {
                for b in 0..beats {
                    times.push(t);
                    weights.push(if b == 0 { 1.0 } else { 0.25 });
                    t += 60.0 / bpm;
                }
            }
        }
        (times, weights)
    }

    #[test]
    fn a_real_tempo_change_leaves_the_meter_path() {
        // The bar was measured on one section and applied to the whole track:
        // 128 -> 150 BPM with an audible downbeat came out as one 128 BPM line.
        let (times, weights) = accented(&[(128.0, 24, 4), (150.0, 24, 4)]);
        let change = 0.5 + 24.0 * 4.0 * 60.0 / 128.0;
        let sections = [
            section_of(0.5, change, 60.0 / 128.0, 0.5),
            section_of(change, *times.last().unwrap(), 60.0 / 150.0, change),
        ];
        assert!(points_from_meter(&sections, &times, &weights, 1.0).is_none());
    }

    #[test]
    fn a_signature_change_over_one_bar_still_uses_the_meter_path() {
        // 6/4 at 300 then 3/4 at 150 then 6/4: one 1.2 s bar, two notations.
        let (times, weights) = accented(&[(300.0, 12, 6), (150.0, 12, 3), (300.0, 12, 6)]);
        let first_end = 0.5 + 12.0 * 1.2;
        let sections = [
            section_of(0.5, first_end, 0.2, 0.5),
            section_of(first_end, *times.last().unwrap(), 0.4, first_end),
        ];
        let points = points_from_meter(&sections, &times, &weights, 1.0).expect("meter path");
        let meters: Vec<u32> = points.iter().map(|p| p.meter).collect();
        assert_eq!(meters, vec![6, 3, 6]);
    }

    #[test]
    fn a_pulse_factor_does_not_drop_a_plausible_section() {
        // 60 BPM read at a quarter pulse is 15 BPM: outside 20..900, but the
        // music is not, so the red line must still be written.
        let sections = [section_of(0.5, 60.0, 1.0, 0.5)];
        let points = points_from_sections(&sections, 0.5, 12, 0, 1, 0.25, None);
        assert_eq!(points.len(), 1);
        assert!((points[0].bpm.get() - 15.0).abs() < 1e-9);
    }

    #[test]
    fn a_change_red_line_takes_the_beat_just_before_the_start() {
        // The refit can leave the new grid's boundary beat microseconds before
        // the settled start; a bare ceil took the next beat, a whole beat late.
        let (p1, p2) = (60.0 / 132.0, 60.0 / 138.0);
        let change = 0.5 + 70.0 * p1;
        let sections = [
            section_of(0.5, change, p1, 0.5),
            section_of(change, change + 30.0, p2, change - 3e-5),
        ];
        let beat = points_from_sections(&sections, 0.5, 12, 0, 1, 1.0, None);
        assert!((beat[1].offset.get() - (change * 1000.0 - 0.03)).abs() < 1e-6);
        let bars = vec![("4/4".to_string(), 0usize, 4usize); 2];
        let bar = points_from_sections(&sections, 0.5, 12, 0, 4, 1.0, Some(&bars));
        assert!((bar[1].offset.get() - (change * 1000.0 - 0.03)).abs() < 1e-6);
    }

    #[test]
    fn a_lone_click_before_the_music_keeps_the_grid() {
        // One attack at 0.3 s, then 150 BPM eighths from 8 s: growth used to
        // give up on its first seed window and report StageFailed ("a bug").
        let (mut times, mut weights) = eighths(150.0, 8.0, 70.0);
        times.insert(0, 0.3);
        weights.insert(0, 0.8);
        let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
        assert!(
            !out.diagnostics.iter().any(|d| matches!(d, Diagnostic::StageFailed { .. })),
            "{:?}",
            out.diagnostics
        );
        let first = out.points.first().expect("a red line");
        assert!((first.bpm.get() - 150.0).abs() < 0.01, "bpm {}", first.bpm.get());
        let beat_ms = 400.0;
        let k = (first.offset.get() - 8000.0) / beat_ms;
        assert!((k - k.round()).abs() * beat_ms < 2.0, "offset {}", first.offset.get());
    }

    #[test]
    fn confidence_is_one_on_a_tight_long_section() {
        let atom = 60.0 / 174.0 / 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let grown = crate::sections::grow_sections(&times, &weights, atom, 0.4, 1.5, 12);
        assert_eq!(grown.len(), 1);
        assert!((section_confidence(&grown[0], 12) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn confidence_penalises_a_short_section() {
        let section = section_of(0.4, 1.1, 0.35, 0.4);
        let full = section_confidence(&section_of(0.4, 60.0, 0.35, 0.4), 12);
        assert!(section_confidence(&section, 12) < full);
    }

    #[test]
    fn a_single_exact_section_gives_one_downbeat_point() {
        let atom = 60.0 / 174.0 / 2.0;
        let beat = atom * 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let grown = crate::sections::grow_sections(&times, &weights, atom, 0.4, 3.0, 24);
        let beats = crate::sections::beat_sections(&grown, &times, &weights, 2, 0);
        let points = points_from_sections(&beats, times[0], 12, 0, 1, 1.0, None);
        assert_eq!(points.len(), 1, "got {points:?}");
        assert!((points[0].bpm.get() - 60.0 / beat).abs() < 1e-6);
        // No accent evidence: anchored to the beat through the first sound.
        assert!((points[0].offset.get() / 1000.0 - 0.4).abs() < 1e-9);
        assert!(!points[0].meter_known);
    }

    #[test]
    fn subdivision_doubling_is_exact_and_keeps_the_offset() {
        // Property: reading the same grids at x2 doubles every BPM and moves
        // no offset. This is the x2/div2 identity the UI relies on.
        let atom = 60.0 / 174.0 / 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let grown = crate::sections::grow_sections(&times, &weights, atom, 0.4, 3.0, 24);
        let beats = crate::sections::beat_sections(&grown, &times, &weights, 2, 0);
        let once = points_from_sections(&beats, times[0], 12, 0, 1, 1.0, None);
        let twice = points_from_sections(&beats, times[0], 12, 0, 1, 2.0, None);
        assert_eq!(once.len(), twice.len());
        for (a, b) in once.iter().zip(twice.iter()) {
            assert!((b.bpm.get() - 2.0 * a.bpm.get()).abs() < 1e-9);
            assert!((b.offset.get() - a.offset.get()).abs() < 1e-9);
        }
    }

    #[test]
    fn settled_boundaries_are_contiguous_and_monotone() {
        // Property: whatever growth found, settling leaves a partition —
        // no gaps, no overlaps, non-decreasing.
        let a1 = 60.0 / 128.0 / 2.0;
        let change = 0.4 + 128.0 * a1;
        let (mut times, mut weights) = drum(a1, 0.4, 0.4, change);
        let a2 = 60.0 / 142.0 / 2.0;
        let (t2, w2) = drum(a2, change, change, 60.0);
        times.extend(t2.iter().skip(1));
        weights.extend(w2.iter().skip(1));
        let grown = crate::sections::grow_sections(&times, &weights, a1, 0.4, 1.5, 12);
        let settled = crate::sections::settle_boundaries(&times, &weights, grown, SETTLE_ROUNDS);
        assert!(settled.len() >= 2);
        for pair in settled.windows(2) {
            assert!((pair[1].start.get() - pair[0].end.get()).abs() < 1e-9);
            assert!(pair[1].start.get() >= pair[0].start.get());
        }
        assert!((settled[0].start.get() - times[0]).abs() < 1e-9);
        assert!((settled.last().unwrap().end.get() - times[times.len() - 1]).abs() < 1e-9);
    }

    #[test]
    fn a_one_window_signature_region_is_kept_wherever_the_song_starts() {
        // 32 bars of 4, 4 bars of 3 (exactly one window), 32 bars of 4. v3
        // kept that region by float rounding: never at a 1.2 s or 1.6 s bar
        // in 37 start offsets, 32 times in 37 at 1.875 s.
        for bar in [1.2, 1.6, 1.875] {
            for step in 0..37 {
                let phase = 0.25 + step as f64 * 0.0271;
                let (mut times, mut weights) = (Vec::new(), Vec::new());
                for n in 0..68 {
                    let beats = if (32..36).contains(&n) { 3 } else { 4 };
                    for k in 0..beats {
                        times.push(phase + n as f64 * bar + k as f64 * bar / beats as f64);
                        weights.push(if k == 0 { 1.0f32 } else { 0.6 });
                    }
                }
                let found: Vec<usize> = meter_segments(&times, &weights, bar, phase)
                    .iter()
                    .map(|s| s.beats)
                    .collect();
                assert_eq!(found, vec![4, 3, 4], "bar {bar}, start {phase}");
            }
        }
    }

    #[test]
    fn noise_before_the_music_does_not_start_the_grid() {
        // A beat grid from 0.42 s at 132 BPM, and one attack at 27 ms that is
        // 0.136 of a beat off it -- noise at the start of the file. It was the
        // "first sound", and the first red line landed on the grid beat before
        // the music (-34.65 ms on very-noisy-132).
        let period = 60.0 / 132.0;
        let section = GridSection {
            start: overtone_core::Seconds(0.027),
            end: overtone_core::Seconds(30.0),
            period,
            phase: 0.42,
            inliers: 60,
            residual_ms: 0.2,
            coverage: 1.0,
        };
        let mut times = vec![0.027];
        times.extend((0..60).map(|k| 0.42 + k as f64 * period));
        assert!((first_on_grid(&times, &section) - 0.42).abs() < 1e-12);
        // With nothing on the grid, the first attack is all there is.
        assert_eq!(first_on_grid(&[0.027], &section), 0.027);
    }

    #[test]
    fn sparse_random_attacks_get_no_grid() {
        // About one attack a second for 30 s, at random: speech, ambient, an
        // FX clip. The best seed grid cleared the 0.40 share gate for about
        // half of these; its inliers are what chance gives, and the envelope
        // (a spike per attack) has no beat to vouch for it.
        let sr = 44_100;
        let hop = overtone_core::FIT_HOP;
        let mut given = Vec::new();
        for trial in 0..40u64 {
            let mut seed = trial * 7 + 1;
            let mut times: Vec<f64> = (0..30)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    (seed >> 33) as f64 / (1u64 << 31) as f64 * 30.0
                })
                .collect();
            times.sort_by(f64::total_cmp);
            let weights = vec![0.8f32; times.len()];
            let mut env = vec![0.0f32; 32 * sr as usize / hop];
            for &t in &times {
                env[(t * sr as f64 / hop as f64) as usize] = 0.8;
            }
            let out = analyze_attacks(&times, &weights, &env, sr, 1.5, 12, true, 0.75);
            if !out.points.is_empty() || !out.settled_sections.is_empty() {
                given.push(trial);
            }
        }
        assert!(given.is_empty(), "grids given to random attacks: {given:?}");
    }

    #[test]
    fn a_sparse_pulse_keeps_its_grid() {
        // One attack a second, with a third as many again off the grid: the
        // inliers are far beyond chance, so the envelope is never consulted.
        // (The off-grid attacks near a beat pull the fit by ~0.01 BPM.)
        let mut times: Vec<f64> = (0..30).map(|k| 0.25 + k as f64).collect();
        let mut seed = 3u64;
        for _ in 0..10 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            times.push(0.6 + (seed >> 33) as f64 / (1u64 << 31) as f64 * 28.0);
        }
        times.sort_by(f64::total_cmp);
        let weights = vec![0.8f32; times.len()];
        let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
        assert!(!out.points.is_empty(), "got {:?}", out.diagnostics);
        let bpm = out.points[0].bpm.get();
        assert!(
            [60.0, 120.0].iter().any(|b| (bpm - b).abs() < 0.05),
            "got {bpm}"
        );
    }

    #[test]
    fn white_noise_gets_no_grid_and_says_so() {
        // Uniform random attacks: no pulse explains more than chance, so the
        // share gate (0.40) refuses long before any grid is fitted. This pins
        // audit F-08's honest half: the legacy tracker answered 127.68 BPM
        // here, and nothing in Rust may ever invent that answer again.
        let mut seed = 7u64;
        let mut times: Vec<f64> = (0..600)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as f64 / (1u64 << 31) as f64 * 60.0
            })
            .collect();
        times.sort_by(f64::total_cmp);
        let weights = vec![0.8f32; times.len()];
        let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
        assert!(out.points.is_empty());
        assert!(out.settled_sections.is_empty());
        assert!(
            matches!(
                out.diagnostics.as_slice(),
                [Diagnostic::NoCoherentPulse { .. }]
            ),
            "got {:?}",
            out.diagnostics
        );
    }

    #[test]
    fn sparse_pads_get_no_grid_and_say_so() {
        // Seventeen scattered attacks: not enough evidence to fit anything.
        let times: Vec<f64> = (0..17).map(|k| k as f64 * 2.63 + 0.4).collect();
        let weights = vec![0.3f32; times.len()];
        let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
        assert!(out.points.is_empty());
        assert!(
            matches!(
                out.diagnostics.as_slice(),
                [Diagnostic::TooFewAttacks {
                    found: 17,
                    needed: 24
                }]
            ),
            "got {:?}",
            out.diagnostics
        );
    }

    #[test]
    fn silence_gets_no_grid_and_says_so() {
        let out = analyze_attacks(&[], &[], &[], 44_100, 1.5, 12, true, 0.75);
        assert!(out.points.is_empty());
        assert!(
            matches!(
                out.diagnostics.as_slice(),
                [Diagnostic::TooFewAttacks {
                    found: 0,
                    needed: 24
                }]
            ),
            "got {:?}",
            out.diagnostics
        );
    }

    #[test]
    fn snapping_only_nudges_onto_the_previous_grid() {
        let a = TimingPoint::new(1000.0, 120.0, 0.9, 0);
        // 500 ms later is exactly one beat at 120 BPM: snaps exactly.
        let b = TimingPoint::new(1500.2, 140.0, 0.9, 1);
        let snapped = snap_timing_points(&[a, b]);
        assert!((snapped[1].offset.get() - 1500.0).abs() < 1e-9);
        // Far off the grid (200 ms > a quarter beat of 125 ms): left alone.
        let c = TimingPoint::new(1700.0, 140.0, 0.9, 1);
        let snapped = snap_timing_points(&[a, c]);
        assert!((snapped[1].offset.get() - 1700.0).abs() < 1e-9);
    }

    #[test]
    fn osu_text_writes_whole_ms_and_the_proved_meter() {
        let mut a = TimingPoint::new(400.4, 174.0, 1.0, 0);
        a.meter = 3;
        a.meter_known = true;
        let b = TimingPoint::new(900.6, 174.0, 1.0, 0);
        let text = osu_timing_text(&[a, b], "4/4", 0);
        let rows: Vec<&str> = text.lines().collect();
        assert_eq!(rows.len(), 3);
        assert!(rows[1].starts_with("400,"));
        assert!(rows[1].contains(",3,1,0,100,1,0"));
        // Unknown bar falls back to the analysis meter, never a hard-coded 4.
        assert!(rows[2].starts_with("901,"));
        assert!(rows[2].contains(",4,1,0,100,1,0"));
        let lazer = osu_timing_text(&[a], "3/4", 3);
        assert!(lazer.lines().nth(1).unwrap().starts_with("400.400,"));
    }

    #[test]
    fn detect_bar_finds_four_and_refuses_uniform() {
        let (times, weights) = beat_track(0.5, 1.0, 40, 1.0);
        let found = detect_bar(&times, &weights, 0.5, 1.0).expect("a bar is provable");
        assert_eq!(found.2, 4);
        assert!((found.0 - 2.0).abs() < 1e-9);
        let (flat_times, _) = beat_track(0.5, 1.0, 40, 0.6);
        let flat_weights = vec![0.5f32; 40];
        assert!(detect_bar(&flat_times, &flat_weights, 0.5, 1.0).is_none());
    }

    #[test]
    fn meter_regions_split_a_constant_bar_with_two_signatures() {
        // The v3.3 reference shape: the bar never changes length (1.2 s) but
        // the subdivision moves 6/4 -> 4/4. Tempo growth sees one section;
        // the measure grid must still place two red lines.
        let mut times = Vec::new();
        let mut weights = Vec::new();
        for b in 0..10 {
            for j in 0..6 {
                times.push(b as f64 * 1.2 + j as f64 * 0.2);
                weights.push(if j == 0 { 1.2 } else { 0.6 });
            }
        }
        for b in 0..10 {
            for j in 0..4 {
                times.push(12.0 + b as f64 * 1.2 + j as f64 * 0.3);
                weights.push(if j == 0 { 1.2 } else { 0.6 });
            }
        }
        let sections = vec![section_of(times[0], times[times.len() - 1], 0.1, 0.0)];
        let points = points_from_meter(&sections, &times, &weights, 1.0)
            .expect("two signatures over one bar");
        assert_eq!(points.len(), 2, "got {points:?}");
        assert!((points[0].bpm.get() - 300.0).abs() < 1e-6);
        assert!((points[1].bpm.get() - 200.0).abs() < 1e-6);
        assert!((points[0].offset.get() / 1000.0 - 0.0).abs() < 1e-6);
        assert!((points[1].offset.get() / 1000.0 - 12.0).abs() < 1e-6);
        assert!(points.iter().all(|p| p.meter_known));
    }

    #[test]
    fn per_section_meter_comes_from_each_section() {
        let (t1, w1) = beat_track(0.5, 1.0, 40, 1.0);
        let sections = vec![
            section_of(t1[0], t1[t1.len() - 1], 0.5, 1.0),
            section_of(t1[t1.len() - 1], t1[t1.len() - 1] + 2.0, 0.5, 1.0),
        ];
        let mut times = t1.clone();
        let mut weights = w1.clone();
        times.extend([21.5, 22.0]);
        weights.extend([0.5, 0.5]);
        let measures = section_measures(&sections, &times, &weights);
        assert_eq!(measures.len(), 2);
        assert_eq!(measures[0].0, "4/4");
        assert_eq!(measures[0].2, 4);
        // Too few attacks: unknown bar, anchor to a beat.
        assert_eq!(measures[1], ("4/4".to_string(), 0, 1));
    }
}
