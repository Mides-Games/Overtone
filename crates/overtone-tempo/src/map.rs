//! Full-track 2-D coherence map — DSP §B.3.
//!
//! v3 anchors the octave/seed scan on one densest 90 s window because the
//! sweep is expensive in NumPy. In Rust the same sweep is microseconds, so
//! this computes `R(t, f)` over the whole track on a sliding window. One
//! cost, three uses: better section seeds (the map *shows* where the pulse
//! changes before any growth loop), the timing confidence map as
//! first-class data, and the basis for replacing the tempogram (B.4).
//!
//! The frequency grid is fixed across windows (step `0.2 / MAP_WIDTH`, the
//! same lobe resolvability the candidate sweep uses) so columns compare.
//! Windows with fewer than 8 attacks carry no peak worth tracking and are
//! skipped rather than given a noisy ridge point.

use crate::coherence::{self, PERIOD_RANGE};

/// Sliding window width in seconds.
pub const MAP_WIDTH: f64 = 12.0;
/// Sliding window hop in seconds.
pub const MAP_HOP: f64 = 2.0;
/// A ridge jump counts as a pulse change past this many octaves. Peak-grid
/// resolution moves the ridge ~0.5 % on stable tracks; a 128 → 142 step is
/// 0.15 octaves; an octave flicker is 1.0. The threshold sits between real
/// changes and grid noise, far from octave ambiguity.
pub const RIDGE_JUMP_OCTAVES: f64 = 0.08;

/// `R(f)` columns over sliding windows: the surface the ridge runs on.
#[derive(Debug, Clone)]
pub struct CoherenceMap {
    /// Window centres in seconds.
    pub centres: Vec<f64>,
    /// Frequencies in Hz, shared by every column.
    pub freqs: Vec<f64>,
    /// One `R(f)` row per window.
    pub columns: Vec<Vec<f32>>,
}

/// One ridge sample: the pulse the map reads at that moment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RidgePoint {
    pub centre: f64,
    pub period: f64,
    pub coherence: f64,
}

/// Sweep the whole track. Empty when there is nothing to sweep.
pub fn build(times: &[f64], weights: &[f32]) -> CoherenceMap {
    build_with(times, weights, MAP_WIDTH, MAP_HOP)
}

pub fn build_with(times: &[f64], weights: &[f32], width: f64, hop: f64) -> CoherenceMap {
    let freqs = frequency_grid(width);
    let mut map = CoherenceMap { centres: Vec::new(), freqs, columns: Vec::new() };
    if times.is_empty() || width <= 0.0 || hop <= 0.0 {
        return map;
    }
    let (t0, t1) = (times[0], times[times.len() - 1]);
    let mut edge = t0;
    while edge + width <= t1 + 1e-9 {
        let (w_times, w_weights) = crate::fit::window(times, weights, edge, edge + width);
        if w_times.len() >= 8 {
            let column: Vec<f32> = coherence::sweep(&w_times, &w_weights, &map.freqs)
                .into_iter()
                .map(|r| r as f32)
                .collect();
            map.centres.push(edge + 0.5 * width);
            map.columns.push(column);
        }
        edge += hop;
    }
    map
}

/// Fixed frequency grid for one window width: `1/1.35 .. 1/0.055 Hz` at
/// `0.2/width` steps, the candidate sweep's own rule.
pub fn frequency_grid(width: f64) -> Vec<f64> {
    let (lo_f, hi_f) = (1.0 / PERIOD_RANGE.1, 1.0 / PERIOD_RANGE.0);
    let step = (0.2 / width).max(1e-4);
    let mut freqs = Vec::new();
    let mut f = lo_f;
    while f <= hi_f {
        freqs.push(f);
        f += step;
    }
    freqs
}

/// Follow the strongest peak through the map with octave continuity: each
/// window takes the local maximum nearest (in log2) to the previous ridge
/// among peaks above 0.3 of the column maximum. Without continuity a window
/// whose 2× harmonic momentarily wins would read as a tempo doubling; with
/// too strict a bar the ridge drops its multiple mid-ramp (measured on the
/// extreme ramp: three false jumps at a 0.5 bar) and the same misreading
/// happens. At a real step the old multiple collapses entirely, so
/// stickiness never hides one.
pub fn ridge(map: &CoherenceMap) -> Vec<RidgePoint> {
    let mut out = Vec::new();
    let mut prev_log: Option<f64> = None;
    for (centre, column) in map.centres.iter().zip(map.columns.iter()) {
        let col: Vec<f64> = column.iter().map(|&r| r as f64).collect();
        let peak = match peak_near(&col, &map.freqs, prev_log) {
            Some(p) => p,
            None => continue,
        };
        prev_log = Some((1.0 / map.freqs[peak]).log2());
        out.push(RidgePoint {
            centre: *centre,
            period: 1.0 / map.freqs[peak],
            coherence: col[peak],
        });
    }
    out
}

fn peak_near(col: &[f64], freqs: &[f64], prev_log: Option<f64>) -> Option<usize> {
    if col.is_empty() {
        return None;
    }
    let best = col.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if !(best > 1e-6) {
        return None;
    }
    let mut peaks = overtone_dsp::peaks::find_peaks(col, 2, None, None);
    if peaks.is_empty() {
        peaks = vec![col
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(i, _)| i)
            .unwrap_or(0)];
    }
    peaks.retain(|&i| col[i] >= 0.3 * best);
    if peaks.is_empty() {
        return None;
    }
    match prev_log {
        None => peaks.into_iter().max_by(|&a, &b| col[a].total_cmp(&col[b])),
        Some(prev) => peaks.into_iter().min_by(|&a, &b| {
            ((1.0 / freqs[a]).log2() - prev)
                .abs()
                .total_cmp(&((1.0 / freqs[b]).log2() - prev).abs())
        }),
    }
}

/// Centres where the ridge jumps past [`RIDGE_JUMP_OCTAVES`]: pulse changes
/// the growth loop would otherwise have to discover by walking into them.
///
/// Jumps to an exact octave are *excluded*, deliberately. After a genuine
/// halving the old period survives as a strong harmonic (every other attack
/// still aligns), so continuity can never separate "same multiple" from
/// "doubled" on R alone — that is F-11 again, and the density detector owns
/// it (it locates the doubletime case a window closer than the ridge ever
/// did). The ridge corroborates growth-level steps; it stays silent on
/// octave business, including its own mid-ramp multiple switches.
pub fn ridge_changes(ridge: &[RidgePoint]) -> Vec<f64> {
    let mut out = Vec::new();
    for pair in ridge.windows(2) {
        let jump = (pair[1].period.log2() - pair[0].period.log2()).abs();
        // Near an exact octave (of 1 or more) is density territory, not a
        // ridge change — but a small genuine step just above the resolution
        // floor is still one, so only integers ≥ 1 exclude.
        let near_octave = jump.round() >= 1.0 && (jump - jump.round()).abs() <= 0.12;
        if jump > RIDGE_JUMP_OCTAVES && !near_octave {
            out.push(pair[1].centre);
        }
    }
    out
}

/// Mean ridge coherence: how pulse-like the whole track reads. Near 1 on a
/// grid, near the noise floor on unmetered audio — the future no-grid
/// verdict will gate on this rather than on a tracker's confidence.
pub fn mean_ridge_coherence(ridge: &[RidgePoint]) -> f64 {
    if ridge.is_empty() {
        return 0.0;
    }
    ridge.iter().map(|p| p.coherence).sum::<f64>() / ridge.len() as f64
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
    fn a_constant_grid_reads_flat_and_confident() {
        let atom = 60.0 / 174.0 / 2.0;
        let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
        let map = build(&times, &weights);
        assert!(map.centres.len() >= 20, "only {} windows", map.centres.len());
        let ridge = ridge(&map);
        assert_eq!(ridge.len(), map.centres.len());
        // R peaks at the pulse and at every multiple of it, so the ridge may
        // sit on a harmonic — what matters is that it sits on ONE multiple,
        // stably, with high coherence. Absolute pulse resolution is the
        // octave stage's job, not the map's.
        for p in &ridge {
            let multiple = (atom / p.period).round();
            assert!(
                (atom / p.period - multiple).abs() < 0.03 && (1.0..=4.0).contains(&multiple),
                "ridge {} vs atom {atom}",
                p.period
            );
        }
        let multiples: Vec<f64> = ridge.iter().map(|p| (atom / p.period).round()).collect();
        assert!(
            multiples.windows(2).all(|w| w[0] == w[1]),
            "ridge flickers between multiples: {multiples:?}"
        );
        assert!(mean_ridge_coherence(&ridge) > 0.9);
        assert!(ridge_changes(&ridge).is_empty());
    }

    #[test]
    fn a_step_shows_exactly_one_change() {
        let a1 = 60.0 / 128.0 / 2.0;
        let change = 0.4 + 128.0 * a1;
        let (mut times, mut weights) = drum(a1, 0.4, 0.4, change);
        let a2 = 60.0 / 142.0 / 2.0;
        let (t2, w2) = drum(a2, change, change, 60.0);
        times.extend(t2.iter().skip(1));
        weights.extend(w2.iter().skip(1));
        let map = build(&times, &weights);
        let ridge = ridge(&map);
        let changes = ridge_changes(&ridge);
        assert_eq!(changes.len(), 1, "got {changes:?}");
        assert!(
            (changes[0] - change).abs() <= MAP_WIDTH,
            "change {} vs truth {change}",
            changes[0]
        );
        // Each side reads a stable multiple of its own atom.
        for (atom, left) in [(a1, true), (a2, false)] {
            let points: Vec<&RidgePoint> = ridge
                .iter()
                .filter(|p| {
                    if left {
                        p.centre < change - MAP_WIDTH
                    } else {
                        p.centre > change + MAP_WIDTH
                    }
                })
                .collect();
            assert!(!points.is_empty());
            for p in &points {
                let multiple = (atom / p.period).round();
                assert!(
                    (atom / p.period - multiple).abs() < 0.03,
                    "ridge {} vs atom {atom}",
                    p.period
                );
            }
        }
    }

    #[test]
    fn a_ramp_slopes_without_jumps() {
        // 120 -> 160 BPM over 60 s: the ridge must follow the slope and
        // never mistake it for a step.
        let mut times = vec![0.4];
        while *times.last().unwrap() < 60.0 {
            let t = *times.last().unwrap();
            times.push(t + 60.0 / (120.0 + 40.0 * t / 60.0));
        }
        times.pop();
        let weights = vec![1.0f32; times.len()];
        let map = build(&times, &weights);
        let ridge = ridge(&map);
        assert!(ridge.len() >= 10);
        assert!(ridge_changes(&ridge).is_empty());
        let first = ridge[0].period;
        let last = ridge[ridge.len() - 1].period;
        assert!(first > last, "periods should shrink as tempo rises");
        assert!((60.0 / first - 120.0).abs() < 6.0, "BPM {}", 60.0 / first);
        assert!((60.0 / last - 160.0).abs() < 6.0, "BPM {}", 60.0 / last);
    }

    #[test]
    fn an_exact_halving_is_not_a_ridge_change() {
        // Same atom throughout, half the note rate after the change: the
        // ridge stays put by construction, and the density detector owns
        // this shape. Pin it so a future threshold tweak cannot steal it.
        let beat = 60.0 / 175.0;
        let mut times: Vec<f64> = Vec::new();
        let mut weights: Vec<f32> = Vec::new();
        let mut t = 0.0;
        while t < 32.0 {
            times.push(t);
            weights.push(0.7);
            t += beat / 2.0;
        }
        let mut k = (32.0 / beat).ceil() as i64;
        while k as f64 * beat < 64.0 {
            times.push(k as f64 * beat);
            weights.push(1.0);
            k += 1;
        }
        let map = build(&times, &weights);
        let ridge = ridge(&map);
        assert!(ridge.len() >= 10);
        assert!(ridge_changes(&ridge).is_empty());
    }

    #[test]
    fn noise_reads_weak() {
        let mut seed = 42u64;
        let mut times: Vec<f64> = (0..600)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as f64 / (1u64 << 31) as f64 * 60.0
            })
            .collect();
        times.sort_by(f64::total_cmp);
        let weights = vec![1.0f32; times.len()];
        let map = build(&times, &weights);
        let ridge = ridge(&map);
        assert!(
            mean_ridge_coherence(&ridge) < 0.4,
            "coherence {}",
            mean_ridge_coherence(&ridge)
        );
    }

    #[test]
    fn empty_input_maps_to_nothing() {
        let map = build(&[], &[]);
        assert!(map.centres.is_empty());
        assert!(ridge(&map).is_empty());
        assert!(ridge_changes(&[]).is_empty());
        assert_eq!(mean_ridge_coherence(&[]), 0.0);
    }
}
