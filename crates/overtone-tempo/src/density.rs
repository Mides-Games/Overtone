//! Half/double-time regions inside one reported section — audit F-11.
//!
//! `_grow_sections` extends while `share` holds, and `share` cannot move
//! across an exact 2× change because the grid is continuous: every attack of
//! the slow half still lands on the fast half's grid. What moves is
//! **coverage** on a subdivided grid — which the growth loop computes and
//! discards.
//!
//! Coverage alone is not enough: a drop, a breakdown and a sparse bar lower
//! it too. The discriminator is **parity**: in a half-time region the filled
//! slots share one residue mod 2; in a sparse region they are scattered.
//!
//! ```text
//! coverage ~0.5   "half the slots are empty"
//! parity   ~1.0   "and it is every other one, not a random half"
//! ```
//!
//! This is a direct port of `proto/density.py` (measured: 4/4 real changes,
//! 0 false positives out of 23, worst localisation one 8-beat window), and
//! the deliverable is what DSP §B.2 specifies: a **bidirectional** pulse
//! hint with confidence, surfaced rather than silently split — mapping the
//! whole track at the reported BPM stays defensible, so nothing here changes
//! any BPM by itself.

use overtone_core::GridSection;

/// Windows are sized in beats of the reported grid: eight beats is two bars
/// of 4/4 — short enough to localise, long enough that one missed hit does
/// not move the statistics.
pub const WINDOW_BEATS: usize = 8;
/// Subdivisions of the reported beat to test. The signal is invisible at the
/// beat itself: a half-time region still has an attack on every beat.
pub const SUBDIVISIONS: [usize; 2] = [2, 4];
/// A window is thinned-but-regular when at most this fraction of slots is
/// filled and at least `PARITY_MIN` of the filled weight shares a residue.
pub const COVERAGE_MAX: f64 = 0.70;
pub const PARITY_MIN: f64 = 0.85;
/// Both sides of a proposed split must be this many windows long.
pub const MIN_RUN: usize = 2;

/// Which side of the section thinned out. A half-time drop thins the tail; a
/// double-time chorus thins the head.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinSide {
    Head,
    Tail,
    Mid,
}

/// One proposed pulse change inside a reported section.
#[derive(Debug, Clone, PartialEq)]
pub struct PulseHint {
    pub section: usize,
    pub subdivision: usize,
    pub from_s: f64,
    pub to_s: f64,
    /// Where the pulse changes: whichever edge of the thinned run is not a
    /// section edge. Reporting the run's start unconditionally put the
    /// double-time case 25.6 s off in the prototype.
    pub boundary_s: f64,
    pub side: ThinSide,
    /// The thinned region reads half the reported rate.
    pub factor: f64,
    pub coverage_in: f64,
    pub coverage_out: f64,
    pub parity_in: f64,
    pub parity_out: f64,
    pub windows: usize,
    pub thinned: usize,
    /// `(coverage_out - coverage_in) * parity_in`: how much emptier the thin
    /// side is, weighted by how regular it is.
    pub score: f64,
}

/// `(coverage, parity concentration at m=2, inlier count)` for one window.
pub fn window_stats(times: &[f64], weights: &[f32], period: f64, phase: f64) -> (f64, f64, usize) {
    if times.is_empty() || period <= 0.0 {
        return (0.0, 0.0, 0);
    }
    let mut ks: Vec<i64> = Vec::new();
    let mut ws: Vec<f64> = Vec::new();
    for (&t, &w) in times.iter().zip(weights.iter()) {
        let k = ((t - phase) / period).round();
        if (t - (phase + k * period)).abs() <= (0.12 * period).max(0.006) {
            ks.push(k as i64);
            ws.push(w as f64);
        }
    }
    let n = ks.len();
    if n < 4 {
        return (0.0, 0.0, n);
    }
    let (k_min, k_max) = ks
        .iter()
        .fold((i64::MAX, i64::MIN), |(lo, hi), &k| (lo.min(k), hi.max(k)));
    let slots = (k_max - k_min) as f64 + 1.0;
    let mut unique = ks.clone();
    unique.sort_unstable();
    unique.dedup();
    let coverage = (unique.len() as f64 / slots.max(1.0)).min(1.0);
    // Parity weighted by attack strength, so a ghost note counts less.
    let mut totals = [0.0f64; 2];
    for (&k, &w) in ks.iter().zip(ws.iter()) {
        totals[k.rem_euclid(2) as usize] += w;
    }
    let parity = totals[0].max(totals[1]) / (totals[0] + totals[1]).max(1e-9);
    (coverage, parity, n)
}

/// Propose pulse changes inside every reported section long enough to hold
/// them — `proto/density.py::scan`.
pub fn scan_sections(sections: &[GridSection], times: &[f64], weights: &[f32]) -> Vec<PulseHint> {
    let mut out = Vec::new();
    for (n, section) in sections.iter().enumerate() {
        if let Some(hint) = scan_section(n, section, times, weights) {
            out.push(hint);
        }
    }
    out
}

fn scan_section(
    index: usize,
    section: &GridSection,
    times: &[f64],
    weights: &[f32],
) -> Option<PulseHint> {
    let span = WINDOW_BEATS as f64 * section.period;
    if span <= 0.0 || section.end.get() - section.start.get() < (2 * MIN_RUN + 1) as f64 * span {
        return None;
    }
    let mut best: Option<PulseHint> = None;
    for sub in SUBDIVISIONS {
        let period = section.period / sub as f64;
        let mut rows: Vec<(f64, f64, f64, usize)> = Vec::new();
        let mut edge = section.start.get();
        while edge + span <= section.end.get() + 1e-9 {
            let (w_times, w_weights) = windowed(times, weights, |t| t >= edge && t < edge + span);
            let (coverage, parity, count) =
                window_stats(&w_times, &w_weights, period, section.phase);
            rows.push((edge, coverage, parity, count));
            edge += span;
        }
        if rows.len() < 2 * MIN_RUN + 1 {
            continue;
        }
        let thin: Vec<bool> = rows
            .iter()
            .map(|&(_, cov, par, n)| cov <= COVERAGE_MAX && par >= PARITY_MIN && n >= 4)
            .collect();
        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut start: Option<usize> = None;
        for (i, &flag) in thin.iter().enumerate() {
            if flag && start.is_none() {
                start = Some(i);
            } else if !flag && start.is_some() {
                runs.push((start.take().unwrap(), i));
            }
        }
        if let Some(a) = start.take() {
            runs.push((a, thin.len()));
        }
        runs.retain(|&(a, b)| b - a >= MIN_RUN);
        if runs.is_empty() || runs.iter().all(|&(a, b)| b - a >= rows.len() - 1) {
            continue;
        }
        // .rev(): the first of equally long runs, as the prototype's max().
        let &(a, b) = runs.iter().rev().max_by_key(|&&(a, b)| b - a).unwrap();
        let covs: Vec<f64> = rows.iter().map(|&(_, c, _, _)| c).collect();
        let outside: Vec<f64> = covs[..a].iter().chain(covs[b..].iter()).copied().collect();
        if outside.is_empty() {
            continue;
        }
        let mean_in = covs[a..b].iter().sum::<f64>() / (b - a) as f64;
        let mean_out = outside.iter().sum::<f64>() / outside.len() as f64;
        if mean_out - mean_in < 0.2 {
            continue;
        }
        let from_s = rows[a].0;
        let to_s = rows[b - 1].0 + span;
        let at_head = a == 0;
        let at_tail = b >= rows.len();
        let boundary = if at_head && !at_tail { to_s } else { from_s };
        let parity_in = rows[a..b].iter().map(|&(_, _, p, _)| p).sum::<f64>() / (b - a) as f64;
        let par_rows: Vec<f64> = rows[..a]
            .iter()
            .chain(rows[b..].iter())
            .map(|&(_, _, p, _)| p)
            .collect();
        let parity_out = par_rows.iter().sum::<f64>() / par_rows.len() as f64;
        let score = proto_score(mean_out, mean_in, parity_in);
        let candidate = PulseHint {
            section: index,
            subdivision: sub,
            from_s,
            to_s,
            boundary_s: boundary,
            side: if at_head {
                ThinSide::Head
            } else if at_tail {
                ThinSide::Tail
            } else {
                ThinSide::Mid
            },
            factor: 0.5,
            coverage_in: mean_in,
            coverage_out: mean_out,
            parity_in,
            parity_out,
            windows: rows.len(),
            thinned: b - a,
            score,
        };
        if best
            .as_ref()
            .is_none_or(|prev| candidate.score > prev.score)
        {
            best = Some(candidate);
        }
    }
    best
}

/// The prototype's score: coverage and parity rounded to three decimals,
/// then their product rounded again, and the subdivisions compared on that
/// (the first of equal scores stays). The port compared the raw product, so
/// two subdivisions within rounding of each other could pick the other one.
fn proto_score(mean_out: f64, mean_in: f64, parity_in: f64) -> f64 {
    let round3 = |x: f64| (x * 1000.0).round() / 1000.0;
    round3((round3(mean_out) - round3(mean_in)) * round3(parity_in))
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

#[cfg(test)]
mod tests {
    use super::*;
    use overtone_core::Seconds;

    /// Eighth-note grid at `beat`, halving to quarters at `change`.
    fn halftime_stream(beat: f64, change: f64, end: f64) -> (Vec<f64>, Vec<f32>) {
        let mut times = Vec::new();
        let mut weights = Vec::new();
        let mut t = 0.0;
        while t < change {
            times.push(t);
            weights.push(if (t / beat).round() as i64 % 2 == 0 {
                1.0
            } else {
                0.5
            });
            t += beat / 2.0;
        }
        let mut k = (change / beat).ceil() as i64;
        while k as f64 * beat < end {
            times.push(k as f64 * beat);
            weights.push(1.0);
            k += 1;
        }
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

    #[test]
    fn a_halftime_tail_is_found_where_it_starts() {
        let beat = 60.0 / 175.0;
        let (times, weights) = halftime_stream(beat, 32.0, 64.0);
        let sections = vec![section_of(times[0], times[times.len() - 1], beat, 0.0)];
        let hints = scan_sections(&sections, &times, &weights);
        assert_eq!(hints.len(), 1, "got {hints:?}");
        let hint = &hints[0];
        assert_eq!(hint.side, ThinSide::Tail);
        assert!(
            (hint.boundary_s - 32.0).abs() <= WINDOW_BEATS as f64 * beat,
            "boundary {} vs truth 32.0",
            hint.boundary_s
        );
        assert!(hint.coverage_out - hint.coverage_in >= 0.2);
        assert!(hint.parity_in >= PARITY_MIN);
    }

    #[test]
    fn a_doubletime_head_is_found_where_it_ends() {
        // Slow quarters, then fast eighths: the thinned run is the head.
        let beat = 60.0 / 220.0;
        let change = 26.0;
        let mut times: Vec<f64> = Vec::new();
        let mut weights: Vec<f32> = Vec::new();
        let mut k = 0i64;
        while k as f64 * beat * 2.0 < change {
            times.push(k as f64 * beat * 2.0);
            weights.push(1.0);
            k += 1;
        }
        // The fast half doubles the note rate on the same beat grid.
        // Start it on a subdivided slot: least squares cannot recover a
        // slipped index, and neither can this detector.
        let mut t = (change / (beat / 2.0)).ceil() * (beat / 2.0);
        while t < 56.0 {
            times.push(t);
            weights.push(0.7);
            t += beat / 2.0;
        }
        let sections = vec![section_of(times[0], times[times.len() - 1], beat, 0.0)];
        let hints = scan_sections(&sections, &times, &weights);
        assert_eq!(hints.len(), 1, "got {hints:?}");
        assert_eq!(hints[0].side, ThinSide::Head);
        assert!(
            (hints[0].boundary_s - change).abs() <= WINDOW_BEATS as f64 * beat,
            "boundary {} vs truth {change}",
            hints[0].boundary_s
        );
    }

    #[test]
    fn scores_compare_as_the_prototype_rounds_them() {
        // Raw 0.4500 against 0.45018: the prototype rounds both to 0.450 and
        // keeps the first subdivision; raw, the second would win.
        let first = proto_score(0.9, 0.4, 0.9);
        let second = proto_score(0.9002, 0.4, 0.9);
        assert_eq!(first, 0.45);
        assert_eq!(second, first);
        assert!(0.9002f64 - 0.4 > 0.9 - 0.4);
    }

    #[test]
    fn a_six_second_drop_is_not_a_pulse_change() {
        // Constant eighths with a hole. The hole's windows are empty, and an
        // empty window is not a thinned one: under four attacks it has no
        // parity to read and fails the count floor as well, so either guard
        // alone keeps this quiet. (It said scattered parity rejected it; the
        // parity guard is what a_sparse_region_is_not_a_pulse_change pins.)
        let beat = 60.0 / 180.0;
        let mut times = Vec::new();
        let mut weights = Vec::new();
        let mut t = 0.0;
        while t < 60.0 {
            if !(20.0..26.0).contains(&t) {
                times.push(t);
                weights.push(0.8);
            }
            t += beat / 2.0;
        }
        let sections = vec![section_of(times[0], times[times.len() - 1], beat, 0.0)];
        assert!(scan_sections(&sections, &times, &weights).is_empty());
    }

    #[test]
    fn a_sparse_region_is_not_a_pulse_change() {
        // Every third attack kept: thin-looking coverage, scattered parity.
        let beat = 60.0 / 160.0;
        let mut times = Vec::new();
        let mut weights = Vec::new();
        let mut i = 0usize;
        let mut t = 0.0;
        while t < 60.0 {
            if t < 20.0 || t >= 30.0 || i % 3 == 0 {
                times.push(t);
                weights.push(0.8);
            }
            i += 1;
            t += beat / 2.0;
        }
        let sections = vec![section_of(times[0], times[times.len() - 1], beat, 0.0)];
        assert!(scan_sections(&sections, &times, &weights).is_empty());
    }

    #[test]
    fn swung_offbeats_do_not_fire() {
        // Beats plus swung hats at two-thirds: the offbeats miss the
        // subdivided slots, so every window thins uniformly — which reads as
        // "subdivision too fine", not a change.
        let beat = 60.0 / 96.0;
        let mut times = Vec::new();
        let mut weights = Vec::new();
        let mut t = 0.0;
        while t < 60.0 {
            times.push(t);
            weights.push(1.0);
            times.push(t + beat * 2.0 / 3.0);
            weights.push(0.4);
            t += beat;
        }
        let sections = vec![section_of(times[0], times[times.len() - 1], beat, 0.0)];
        assert!(scan_sections(&sections, &times, &weights).is_empty());
    }

    #[test]
    fn short_sections_are_left_alone() {
        let beat = 60.0 / 174.0;
        let (times, weights) = halftime_stream(beat, 4.0, 8.0);
        let sections = vec![section_of(times[0], times[times.len() - 1], beat, 0.0)];
        assert!(scan_sections(&sections, &times, &weights).is_empty());
    }
}
