//! Constant-tempo section growth: `_grow_sections` and friends from v3.
//!
//! The seed grid knows the pulse at one point in the track. This stage walks
//! it forward while attacks keep landing on it, re-seeds the next region with
//! its own coherence scan (a period carried across a 128 → 142 BPM change
//! assigns wrong beat indices on the far side, and least squares cannot
//! recover a slipped index), merges neighbours that agree, and settles each
//! boundary on the beat where the two grids **cross** — a sharp minimum,
//! where a residual cost is flat because both grids fit at the change itself
//! (measured in v3: 0.9 % cost difference between correct and one-beat-early).
//!
//! v3 names kept in doc comments: `_grow_sections`, `_merge_sections`,
//! `_refit_span`, `_nearest_attack`, `_grid_reach`, `_tune_boundary`,
//! `_settle_boundaries`, `_phase_class`, `_beat_sections`.

use overtone_core::{GridSection, Seconds};

use crate::fit::{self, Grid};

/// Defaults from v3's `_grow_sections` signature.
pub const SEED_S: f64 = 8.0;
pub const STEP_S: f64 = 2.0;
/// Growth gate: extend while `share >= 0.55` and the chunk RMS stays below
/// 9 % of the local period. v3 computes coverage here and discards it
/// (audit F-11); the density prototype shows the signal is real, but the
/// port reproduces the gate as-is so the golden vectors match.
pub const GROW_SHARE_MIN: f64 = 0.55;
pub const GROW_RMS_RATIO: f64 = 0.09;
/// Rounds of boundary-search / refit alternation in `_settle_boundaries`.
pub const SETTLE_ROUNDS: usize = 2;

fn section_of(start: f64, end: f64, grid: Grid, q: fit::Quality) -> GridSection {
    GridSection {
        start: Seconds(start),
        end: Seconds(end),
        period: grid.period,
        phase: grid.phase,
        inliers: q.inliers,
        residual_ms: q.residual_ms,
        coverage: q.coverage,
    }
}

/// Grow constant-tempo regions forward — v3 `_grow_sections`.
///
/// `period`/`phase` seed the first region's octave only; every region runs
/// its own `_seed_grid` scan (narrow windows: a wide one straddles the very
/// tempo change the loop is looking for). Returns atom-level sections;
/// convert with [`beat_sections`] and settle with [`settle_boundaries`].
pub fn grow_sections(
    times: &[f64],
    weights: &[f32],
    period: f64,
    phase: f64,
    min_delta: f64,
    persistence: usize,
) -> Vec<GridSection> {
    grow_sections_with(
        times,
        weights,
        period,
        phase,
        min_delta,
        persistence,
        SEED_S,
        STEP_S,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn grow_sections_with(
    times: &[f64],
    weights: &[f32],
    period: f64,
    phase: f64,
    min_delta: f64,
    persistence: usize,
    seed_s: f64,
    step_s: f64,
) -> Vec<GridSection> {
    if times.len() < 8 {
        return Vec::new();
    }
    let mut sections: Vec<GridSection> = Vec::new();
    let mut start = times[0];
    let finish = times[times.len() - 1];
    let mut prior = period;
    let mut phase = phase;
    let mut guard = 0usize;
    // Every counted pass ends at or past its seed window, so it moves `start`
    // on by `seed_s` or to the end: the track needs at most this many passes
    // and the guard only backs that up — v3 `_grow_sections`. A fixed 64
    // stopped a 15-minute mix at 576 s and left the rest with no section.
    let limit = 64usize.max(((finish - start) / seed_s).ceil() as usize + 2);
    while start < finish - 1.0 && guard < limit {
        guard += 1;
        let seed_hi = finish.min(start + seed_s.max(12.0 * prior));
        let fresh = crate::seed_grid(
            times,
            weights,
            start,
            seed_hi,
            Some(prior),
            &crate::GROWTH_WIDTHS,
        );
        let (mut local_period, mut local_phase) = match fresh {
            Some(grid) => (grid.period, grid.phase),
            None => {
                let (s_times, s_weights) =
                    masked(times, weights, |t| t >= start - 0.5 * prior && t <= seed_hi);
                if s_times.len() < 6 {
                    // Too few attacks to seed from here (a lone click, a
                    // count-in, a quiet intro): move on to the next attack
                    // instead of giving up on the whole track. Skips do not
                    // count against the guard; start only moves forward.
                    match times.iter().find(|&&t| t > start) {
                        Some(&next) => {
                            start = next;
                            guard -= 1;
                            continue;
                        }
                        None => break,
                    }
                }
                let (grid, _) = fit::refine(
                    &s_times,
                    &s_weights,
                    Grid {
                        period: prior,
                        phase,
                    },
                );
                (grid.period, grid.phase)
            }
        };
        let mut edge = seed_hi;
        while edge < finish {
            let nxt = finish.min(edge + step_s.max(4.0 * local_period));
            let (c_times, c_weights) = masked(times, weights, |t| t > edge && t <= nxt);
            if c_times.len() < 3 {
                edge = nxt;
                continue;
            }
            let grid = Grid {
                period: local_period,
                phase: local_phase,
            };
            let q = fit::quality_with_tol(&c_times, &c_weights, grid, 0.11);
            if q.share < GROW_SHARE_MIN || q.residual_ms > GROW_RMS_RATIO * local_period * 1000.0 {
                break;
            }
            let (w_times, w_weights) = masked(times, weights, |t| {
                t >= start - 0.5 * local_period && t <= nxt
            });
            let (grid, _) = fit::refine(&w_times, &w_weights, grid);
            local_period = grid.period;
            local_phase = grid.phase;
            edge = nxt;
        }
        let end = edge;
        let (w_times, w_weights) = masked(times, weights, |t| {
            t >= start - 0.5 * local_period && t <= end
        });
        let grid = Grid {
            period: local_period,
            phase: local_phase,
        };
        // The inlier count is the refinement's own mask, as v3 keeps it; the
        // quality pass counts at a looser tolerance. Only the golden gate
        // reads it, and it never compared it until the audit.
        let (grid, mask) = fit::refine(&w_times, &w_weights, grid);
        let q = fit::quality(&w_times, &w_weights, grid);
        let inliers = mask.iter().filter(|&&kept| kept).count();
        sections.push(section_of(start, end, grid, fit::Quality { inliers, ..q }));
        prior = grid.period;
        phase = grid.phase;
        if end <= start + 1e-6 {
            break;
        }
        start = end;
    }
    merge_sections(times, weights, sections, min_delta, persistence)
}

/// Fuse neighbours that share a tempo; drop regions too short to trust —
/// v3 `_merge_sections`.
pub fn merge_sections(
    times: &[f64],
    weights: &[f32],
    sections: Vec<GridSection>,
    min_delta: f64,
    persistence: usize,
) -> Vec<GridSection> {
    if sections.is_empty() {
        return Vec::new();
    }
    let bpm_of = |s: &GridSection| {
        if s.period > 0.0 {
            60.0 / s.period
        } else {
            0.0
        }
    };
    let mut merged: Vec<GridSection> = vec![sections[0]];
    for section in sections.iter().skip(1) {
        let last = merged.len() - 1;
        let previous = merged[last];
        let same = (section_bpm(section) - bpm_of(&previous)).abs() < min_delta;
        let tiny = section.end.get() - section.start.get() < persistence as f64 * section.period;
        if same || tiny {
            let fused = refit_span(
                times,
                weights,
                previous.start.get(),
                section.end.get(),
                previous.period,
                previous.phase,
            )
            .unwrap_or(previous);
            merged[last] = fused;
        } else {
            merged.push(*section);
        }
    }
    // A tail region can still be too short after fusing; fold it backwards.
    while merged.len() > 1 {
        let last = merged[merged.len() - 1];
        if last.end.get() - last.start.get() >= persistence as f64 * last.period {
            break;
        }
        let previous = merged[merged.len() - 2];
        let fused = refit_span(
            times,
            weights,
            previous.start.get(),
            last.end.get(),
            previous.period,
            previous.phase,
        )
        .unwrap_or(previous);
        merged.pop();
        merged.pop();
        merged.push(fused);
    }
    return merged;

    fn section_bpm(s: &GridSection) -> f64 {
        if s.period > 0.0 {
            60.0 / s.period
        } else {
            0.0
        }
    }
}

/// Least-squares refit of one span — v3 `_refit_span`.
///
/// Tight margins: a section fitted across even a couple of the neighbour's
/// bars picks up a phase error of several milliseconds.
pub fn refit_span(
    times: &[f64],
    weights: &[f32],
    start: f64,
    end: f64,
    period: f64,
    phase: f64,
) -> Option<GridSection> {
    let (w_times, w_weights) = masked(times, weights, |t| {
        t >= start - 0.15 * period && t <= end + 0.15 * period
    });
    if w_times.len() < 6 {
        return None;
    }
    let grid = fit::expand(
        &w_times,
        &w_weights,
        Grid { period, phase },
        start - period,
        end + period,
    );
    let q = fit::quality(&w_times, &w_weights, grid);
    let tol = 0.12 * grid.period;
    let mut inliers = 0usize;
    for &t in &w_times {
        let k = ((t - grid.phase) / grid.period).round();
        if (t - (grid.phase + k * grid.period)).abs() <= tol {
            inliers += 1;
        }
    }
    Some(section_of(start, end, grid, fit::Quality { inliers, ..q }))
}

/// Distance to the closest attack (`inf` when there are none) — v3
/// `_nearest_attack`.
pub fn nearest_attack(times: &[f64], moment: f64) -> f64 {
    if times.is_empty() {
        return f64::INFINITY;
    }
    let i = times.partition_point(|&t| t < moment);
    let mut best = f64::INFINITY;
    if i > 0 {
        best = best.min((times[i - 1] - moment).abs());
    }
    if i < times.len() {
        best = best.min((times[i] - moment).abs());
    }
    best
}

/// Walk a grid until its beats stop finding attacks — v3 `_grid_reach`.
pub fn grid_reach(
    times: &[f64],
    period: f64,
    phase: f64,
    anchor: f64,
    limit: f64,
    backwards: bool,
    tolerance: f64,
) -> f64 {
    grid_reach_with_misses(times, period, phase, anchor, limit, backwards, tolerance, 1)
}

#[allow(clippy::too_many_arguments)]
fn grid_reach_with_misses(
    times: &[f64],
    period: f64,
    phase: f64,
    anchor: f64,
    limit: f64,
    backwards: bool,
    tolerance: f64,
    allowed_misses: usize,
) -> f64 {
    let step = if backwards { -period } else { period };
    let mut beat = phase + ((anchor - phase) / period).round() * period;
    let mut last = beat;
    let mut misses = 0usize;
    loop {
        beat += step;
        if (backwards && beat < limit) || (!backwards && beat > limit) {
            break;
        }
        if nearest_attack(times, beat) <= tolerance {
            last = beat;
            misses = 0;
        } else {
            misses += 1;
            if misses > allowed_misses {
                break;
            }
        }
    }
    last
}

/// Place the split on the beat where the old grid stops explaining the music
/// — v3 `_tune_boundary`. See the module docs for why the crossing, not a
/// residual cost, is sharp.
pub fn tune_boundary(times: &[f64], left: GridSection, right: GridSection) -> f64 {
    tune_boundary_with_reach(times, left, right, 10.0)
}

fn window_of(section: &GridSection) -> f64 {
    (0.06 * section.period).min((4.0 * section.residual_ms / 1000.0).max(0.010))
}

pub fn tune_boundary_with_reach(
    times: &[f64],
    left: GridSection,
    right: GridSection,
    reach: f64,
) -> f64 {
    if left.period <= 0.0 || right.period <= 0.0 {
        return right.start.get();
    }
    let span = reach
        .min(0.45 * (left.end.get() - left.start.get()))
        .min(0.45 * (right.end.get() - right.start.get()));
    if span <= 2.0 * left.period {
        return right.start.get();
    }
    let lo = (left.start.get() + left.period).max(right.start.get() - span);
    let hi = (right.end.get() - right.period).min(right.start.get() + span);
    if hi <= lo {
        return right.start.get();
    }
    let earliest = grid_reach(
        times,
        right.period,
        right.phase,
        hi.min(right.start.get() + 2.0 * right.period),
        lo,
        true,
        window_of(&right),
    );
    let latest = grid_reach(
        times,
        left.period,
        left.phase,
        lo.max(left.end.get() - 2.0 * left.period),
        hi,
        false,
        window_of(&left),
    );
    let mut span_lo = lo.max(earliest.min(latest) - 2.0 * right.period);
    let mut span_hi = hi.min(earliest.max(latest) + 2.0 * right.period);
    if span_hi < span_lo {
        span_lo = lo;
        span_hi = hi;
    }
    let k0 = ((span_lo - right.phase) / right.period - 1e-9).ceil() as i64;
    let k1 = ((span_hi - right.phase) / right.period + 1e-9).floor() as i64;
    if k1 < k0 {
        return right.start.get().clamp(lo, hi);
    }
    let mut best = right.phase + k0 as f64 * right.period;
    let mut best_drift = drift_of(best, &left);
    for k in (k0 + 1)..=k1 {
        let beat = right.phase + k as f64 * right.period;
        let drift = drift_of(beat, &left);
        if drift < best_drift {
            best_drift = drift;
            best = beat;
        }
    }
    best.clamp(lo, hi)
}

fn drift_of(beat: f64, left: &GridSection) -> f64 {
    (beat - (left.phase + ((beat - left.phase) / left.period).round() * left.period)).abs()
}

/// Alternate boundary search and per-section refit until both agree — v3
/// `_settle_boundaries`.
pub fn settle_boundaries(
    times: &[f64],
    weights: &[f32],
    mut sections: Vec<GridSection>,
    rounds: usize,
) -> Vec<GridSection> {
    if sections.len() < 2 {
        return sections;
    }
    for _ in 0..rounds {
        for i in 0..sections.len() - 1 {
            let split = tune_boundary(times, sections[i], sections[i + 1]);
            let left = sections[i];
            let right = sections[i + 1];
            sections[i] = GridSection {
                end: Seconds(split),
                ..left
            };
            sections[i + 1] = GridSection {
                start: Seconds(split),
                ..right
            };
        }
        let mut refitted: Vec<GridSection> = Vec::with_capacity(sections.len());
        for section in &sections {
            let fitted = refit_span(
                times,
                weights,
                section.start.get(),
                section.end.get(),
                section.period,
                section.phase,
            );
            refitted.push(fitted.unwrap_or(*section));
        }
        sections = refitted;
    }
    sections
}

/// Which atom class inside a beat carries the accents — v3 `_phase_class`.
pub fn phase_class(times: &[f64], weights: &[f32], period: f64, phase: f64, m: usize) -> usize {
    if m <= 1 || period <= 0.0 {
        return 0;
    }
    let mut classes: Vec<(f64, usize)> = Vec::new();
    let mut counts = vec![0usize; m];
    let mut totals = vec![0.0f64; m];
    for (&t, &w) in times.iter().zip(weights.iter()) {
        let k = ((t - phase) / period).round();
        if (t - (phase + k * period)).abs() > 0.15 * period {
            continue;
        }
        // Python's np.mod is non-negative; Rust's % is not.
        let c = k.rem_euclid(m as f64) as usize % m;
        counts[c] += 1;
        totals[c] += w as f64;
        let _ = &mut classes;
    }
    let total_inliers: usize = counts.iter().sum();
    if total_inliers < 4 {
        return 0;
    }
    let mut best = 0usize;
    let mut best_mean = f64::NEG_INFINITY;
    for c in 0..m {
        let mean = totals[c] / counts[c].max(1) as f64;
        if mean > best_mean {
            best_mean = mean;
            best = c;
        }
    }
    best
}

/// Convert atomic sections to beat-level ones — v3 `_beat_sections`.
pub fn beat_sections(
    atom_sections: &[GridSection],
    times: &[f64],
    weights: &[f32],
    m: usize,
    first_class: usize,
) -> Vec<GridSection> {
    let mut out = Vec::with_capacity(atom_sections.len());
    for (n, section) in atom_sections.iter().enumerate() {
        let (w_times, w_weights) = masked(times, weights, |t| {
            t >= section.start.get() - section.period && t <= section.end.get() + section.period
        });
        let r = if n == 0 {
            first_class
        } else {
            phase_class(&w_times, &w_weights, section.period, section.phase, m)
        };
        out.push(GridSection {
            start: section.start,
            end: section.end,
            period: section.period * m as f64,
            phase: section.phase + r as f64 * section.period,
            inliers: section.inliers,
            residual_ms: section.residual_ms,
            coverage: section.coverage,
        });
    }
    out
}

fn masked(
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn growth_covers_a_fifteen_minute_mix() {
        // 120 and 127 BPM alternating every 9 s for 15 minutes: growth stopped
        // after 64 passes, at 576.5 s, and the last 323 s had no section.
        let mut times = Vec::new();
        let mut t = 0.5f64;
        while t < 900.0 {
            times.push(t);
            let bpm = if ((t - 0.5) / 9.0).floor() as i64 % 2 == 0 {
                120.0
            } else {
                127.0
            };
            t += 60.0 / bpm;
        }
        let weights = vec![0.8f32; times.len()];
        let sections = grow_sections(&times, &weights, 0.5, 0.5, 1.5, 12);
        assert!(sections.len() > 64, "{} sections", sections.len());
        let last = sections.last().unwrap().end.get();
        assert!(
            last > times[times.len() - 1] - 1.0,
            "last section ends at {last}"
        );
    }

    #[test]
    fn a_constant_track_grows_one_section() {
        let atom = 60.0 / 174.0 / 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let sections = grow_sections(&times, &weights, atom, 0.4, 1.5, 12);
        assert_eq!(sections.len(), 1, "got {sections:?}");
        assert!(
            (sections[0].period - atom).abs() < 1e-9,
            "period {}",
            sections[0].period
        );
        assert!((sections[0].start.get() - times[0]).abs() < 1e-9);
        assert!((sections[0].end.get() - times[times.len() - 1]).abs() < 1e-9);
    }

    #[test]
    fn an_abrupt_change_grows_two_sections() {
        // 128 BPM atoms for 30 s, then 142 BPM atoms. Each side re-seeds
        // itself; the rough edge lands within a growth step of the change.
        let a1 = 60.0 / 128.0 / 2.0;
        let change = 30.0;
        let (mut times, mut weights) = drum(a1, 0.4, 0.4, change);
        let a2 = 60.0 / 142.0 / 2.0;
        // Start the second grid on the change so the crossing is exact.
        let (t2, w2) = drum(a2, change, change, 60.0);
        times.extend(t2.iter().skip(1));
        weights.extend(w2.iter().skip(1));
        let sections = grow_sections(&times, &weights, a1, 0.4, 1.5, 12);
        assert_eq!(sections.len(), 2, "got {sections:?}");
        assert!(
            (sections[0].period - a1).abs() < 1e-6,
            "first {}",
            sections[0].period
        );
        assert!(
            (sections[1].period - a2).abs() < 1e-6,
            "second {}",
            sections[1].period
        );
        assert!(
            (sections[0].end.get() - change).abs() < 6.0,
            "boundary {} vs change {change}",
            sections[0].end.get()
        );
    }

    #[test]
    fn merge_fuses_neighbours_at_the_same_tempo() {
        let atom = 60.0 / 174.0 / 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let mk = |start: f64, end: f64| {
            let grid = Grid {
                period: atom,
                phase: 0.4,
            };
            let (w, ww) = masked(&times, &weights, |t| t >= start && t <= end);
            let (grid, _) = fit::refine(&w, &ww, grid);
            let q = fit::quality(&w, &ww, grid);
            section_of(start, end, grid, q)
        };
        let sections = vec![mk(0.4, 30.0), mk(30.0, 59.9)];
        let merged = merge_sections(&times, &weights, sections, 1.5, 12);
        assert_eq!(merged.len(), 1, "got {merged:?}");
    }

    #[test]
    fn tune_boundary_finds_the_grid_crossing() {
        let a1 = 60.0 / 128.0 / 2.0;
        // The change must sit on the old grid: at a real tempo change the two
        // grids share a beat, and the crossing is only sharp because of it.
        let change = 0.4 + 126.0 * a1;
        let (mut times, mut weights) = drum(a1, 0.4, 0.4, 60.0);
        let a2 = 60.0 / 142.0 / 2.0;
        let (t2, w2) = drum(a2, change, change, 60.0);
        times.extend(t2.iter().skip(1));
        weights.extend(w2.iter().skip(1));
        // Rough sections straddling the change, as the growth loop leaves them.
        let left = section_of(
            0.4,
            change + 3.0,
            Grid {
                period: a1,
                phase: 0.4,
            },
            fit::quality(
                &times,
                &weights,
                Grid {
                    period: a1,
                    phase: 0.4,
                },
            ),
        );
        let right = section_of(
            change - 3.0,
            60.0,
            Grid {
                period: a2,
                phase: change,
            },
            fit::quality(
                &times,
                &weights,
                Grid {
                    period: a2,
                    phase: change,
                },
            ),
        );
        let split = tune_boundary(&times, left, right);
        assert!(
            (split - change).abs() < a2,
            "split {split} vs change {change}"
        );
    }

    #[test]
    fn settle_keeps_a_single_section_put() {
        let atom = 60.0 / 174.0 / 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let sections = grow_sections(&times, &weights, atom, 0.4, 1.5, 12);
        let settled = settle_boundaries(&times, &weights, sections.clone(), SETTLE_ROUNDS);
        assert_eq!(settled.len(), sections.len());
        assert!((settled[0].period - sections[0].period).abs() < 1e-9);
    }

    #[test]
    fn beat_sections_multiply_the_period_and_shift_the_phase() {
        let atom = 60.0 / 174.0 / 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let sections = grow_sections(&times, &weights, atom, 0.4, 1.5, 12);
        let beats = beat_sections(&sections, &times, &weights, 2, 0);
        assert_eq!(beats.len(), 1);
        assert!((beats[0].period - 2.0 * atom).abs() < 1e-9);
        assert!((beats[0].start.get() - sections[0].start.get()).abs() < 1e-9);
    }
}
