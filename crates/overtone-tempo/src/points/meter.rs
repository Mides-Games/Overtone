//! Meter regions: where the bar changes, settled, and their red lines.

use overtone_core::{GridSection, TimingPoint};

use crate::fit::{self, Grid};

use super::*;

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

pub(crate) fn meter_segments_with(
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
