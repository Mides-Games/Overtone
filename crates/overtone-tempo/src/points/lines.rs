//! Red lines from sections: phase, snapping, assembly and the osu! text.

use overtone_core::{GridSection, TimingPoint};

use super::*;

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
            anchor
                + ((section.start.get() - 0.25 * period - anchor) / period - 1e-9).ceil() * period
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
            // Half to even, as Python's round(): half away from zero wrote
            // 1001 where v3 writes 1000.
            format!("{}", p.offset.get().round_ties_even() as i64)
        };
        // A proved bar of 0 is no bar: v3 takes `meter or fallback`, so it
        // writes the analysis meter where clamping wrote 1.
        let meter = if p.meter_known && p.meter > 0 {
            p.meter.clamp(1, 16)
        } else {
            fallback
        };
        rows.push(format!("{offset},{beat_length:.12},{meter},1,0,100,1,0"));
    }
    rows.join("\n")
}
