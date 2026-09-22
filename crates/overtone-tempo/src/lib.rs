//! The precision grid engine: coherence, least squares, seeding.
//!
//! This crate is deliberately the narrowest in the workspace. It takes attack
//! times and weights and returns fitted grids — no file handling, no audio
//! decoding, no configuration, nothing that could make a change here depend on
//! a change somewhere else. It is the code that produces 0.16 ms offsets, so
//! it has to be fuzzable, property-testable and benchmarkable on its own.
//!
//! See `docs/05-dsp-pipeline.md` Part A, sections A.5 to A.7.

pub mod coherence;
pub mod density;
pub mod fit;
pub mod octave;
pub mod points;
pub mod sections;

/// Crate version, written into exported `.osu` timing comments.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

use fit::{Grid, Quality};

/// Window widths tried when seeding, widest first. Each shrinks until a grid
/// actually locks, so a short region still gets a seed.
pub const SEED_WIDTHS: [f64; 3] = [30.0, 16.0, 9.0];
/// Narrower windows for section growth: a wide one straddles the very tempo
/// change the growth loop is looking for.
pub const GROWTH_WIDTHS: [f64; 3] = [12.0, 7.0, 4.5];
/// A candidate whose fit is worse than this fraction of its own period is not
/// a grid, it is a coincidence.
const MAX_SEED_RMS_RATIO: f64 = 0.09;
/// Stop shrinking the window once a candidate scores this well.
const GOOD_ENOUGH: f64 = 0.45;
/// Window the octave decision and the first seed are anchored on.
pub const SCAN_SPAN_S: f64 = 90.0;

/// The densest `SCAN_SPAN_S` of the track.
///
/// The scan deliberately does not start at the beginning: intros, outros and
/// breakdowns are the least informative places to decide what the beat is.
pub fn anchor_window(times: &[f64]) -> (f64, f64) {
    let lo = times.first().copied().unwrap_or(0.0);
    let hi = times.last().copied().unwrap_or(0.0);
    if hi - lo <= SCAN_SPAN_S {
        return (lo, hi.min(lo + SCAN_SPAN_S));
    }
    let step = SCAN_SPAN_S / 3.0;
    let mut anchor = lo;
    let mut best = 0usize;
    let mut edge = lo;
    while edge <= hi - SCAN_SPAN_S + 1e-9 {
        let count = times
            .iter()
            .filter(|&&t| t >= edge && t < edge + SCAN_SPAN_S)
            .count();
        if count > best {
            best = count;
            anchor = edge;
        }
        edge += step;
    }
    (anchor, hi.min(anchor + SCAN_SPAN_S))
}

/// Rank a candidate by `share × (0.25 + 0.75 · coverage)`.
///
/// This is the ranking v3's timeline is proudest of, and the reasoning is
/// worth keeping attached to the code: a grid twice too slow explains only
/// half the attack energy, so its *share* collapses; a grid twice too fast
/// fills only half its own slots, so its *coverage* collapses. Only the true
/// atom scores on both.
///
/// Two alternatives were tried and rejected in v3, and should not be
/// re-litigated during a port: taking the slowest strong coherence peak (a
/// uniform click track has near-flat coherence, and a half-density grid still
/// qualified, halving the tempo), and gating on `share >= 0.72` (which rejects
/// legitimately ornamented music — the shuffle fixture sits at 0.53 — while
/// still admitting the half-density case at 0.559).
#[inline]
pub fn seed_score(q: &Quality) -> f64 {
    q.share * (0.25 + 0.75 * q.coverage)
}

/// Fit an atomic grid on the window starting at `lo`.
///
/// `prior_period` keeps consecutive regions on the same octave: real tempo
/// changes are small, octave flips are artefacts.
pub fn seed_grid(
    times: &[f64],
    weights: &[f32],
    lo: f64,
    hi: f64,
    prior_period: Option<f64>,
    widths: &[f64],
) -> Option<Grid> {
    let mut best_pool: Vec<(Grid, f64)> = Vec::new();
    let mut best_score = 0.0f64;

    for &width in widths {
        let span = width.min(hi - lo);
        if span < 4.0 {
            continue;
        }
        let (w_times, w_weights) = fit::window(times, weights, lo, lo + span);
        if w_times.len() < 10 {
            continue;
        }
        let mut pool: Vec<(Grid, f64)> = Vec::new();
        for candidate in coherence::candidates(&w_times, &w_weights, 10) {
            let (grid, _) = fit::refine(
                &w_times,
                &w_weights,
                Grid {
                    period: candidate.period,
                    phase: candidate.phase,
                },
            );
            let q = fit::quality(&w_times, &w_weights, grid);
            if q.residual_ms > MAX_SEED_RMS_RATIO * grid.period * 1000.0 {
                continue;
            }
            pool.push((grid, seed_score(&q)));
        }
        if pool.is_empty() {
            continue;
        }
        let top = pool.iter().map(|(_, s)| *s).fold(f64::NEG_INFINITY, f64::max);
        if top > best_score {
            best_pool = pool;
            best_score = top;
        }
        if top >= GOOD_ENOUGH {
            break; // a real grid locked; no need to shrink
        }
    }

    if best_pool.is_empty() {
        return None;
    }
    // Near-ties go to the slowest grid — it is the fundamental, and it keeps
    // the beat reachable. With a prior, to whichever stays on the same octave.
    let mut near: Vec<(Grid, f64)> = best_pool
        .into_iter()
        .filter(|(_, s)| *s >= 0.92 * best_score)
        .collect();
    match prior_period {
        Some(prior) if prior > 0.0 => near.sort_by(|a, b| {
            let key = |g: &Grid| {
                let octaves = ((g.period / prior).log2().abs() * 100.0).round() / 100.0;
                (octaves, -g.period)
            };
            let (ka, kb) = (key(&a.0), key(&b.0));
            ka.0.total_cmp(&kb.0).then(ka.1.total_cmp(&kb.1))
        }),
        _ => near.sort_by(|a, b| b.0.period.total_cmp(&a.0.period)),
    }
    near.first().map(|(grid, _)| *grid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drum_grid(atom: f64, phase: f64, duration: f64) -> (Vec<f64>, Vec<f32>) {
        let mut times = Vec::new();
        let mut weights = Vec::new();
        let mut k = 0usize;
        loop {
            let t = phase + k as f64 * atom;
            if t > duration {
                break;
            }
            times.push(t);
            // Accented every fourth atom, as a kick/hat pattern would be.
            weights.push(if k % 4 == 0 { 1.0 } else { 0.5 });
            k += 1;
        }
        (times, weights)
    }

    #[test]
    fn seeding_finds_the_atom_on_a_clean_grid() {
        let atom = 60.0 / 174.0 / 2.0; // eighth notes at 174 BPM
        let (times, weights) = drum_grid(atom, 0.4315, 60.0);
        let grid = seed_grid(&times, &weights, 0.0, 30.0, None, &SEED_WIDTHS)
            .expect("a clean grid must seed");
        // The atom, or an exact multiple of it — the octave is decided later.
        let ratio = grid.period / atom;
        assert!(
            (ratio - ratio.round()).abs() < 0.01 && ratio.round() >= 1.0,
            "period {} is not a multiple of the atom {atom}",
            grid.period
        );
    }

    #[test]
    fn seed_score_rejects_a_grid_twice_too_slow() {
        // Half the attacks fall off a doubled grid, so share collapses.
        let (times, weights) = drum_grid(0.2, 0.0, 40.0);
        let truth = fit::quality(&times, &weights, Grid { period: 0.2, phase: 0.0 });
        let slow = fit::quality(&times, &weights, Grid { period: 0.4, phase: 0.0 });
        assert!(
            seed_score(&truth) > seed_score(&slow),
            "truth {:?} vs slow {:?}",
            truth,
            slow
        );
    }

    #[test]
    fn seed_score_rejects_a_grid_twice_too_fast() {
        // Every attack is still on a halved grid, so share stays high and
        // coverage is what rejects it.
        let (times, weights) = drum_grid(0.2, 0.0, 40.0);
        let truth = fit::quality(&times, &weights, Grid { period: 0.2, phase: 0.0 });
        let fast = fit::quality(&times, &weights, Grid { period: 0.1, phase: 0.0 });
        assert!(fast.share > 0.99, "share cannot see it: {fast:?}");
        assert!(
            seed_score(&truth) > seed_score(&fast),
            "truth {:?} vs fast {:?}",
            truth,
            fast
        );
    }

    #[test]
    fn seeding_gives_up_on_random_times() {
        let mut seed = 99u64;
        let times: Vec<f64> = (0..300)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as f64 / (1u64 << 31) as f64 * 30.0
            })
            .collect();
        let mut sorted = times.clone();
        sorted.sort_by(f64::total_cmp);
        let weights = vec![1.0f32; sorted.len()];
        // It may still return something, but it must not claim a good score.
        if let Some(grid) = seed_grid(&sorted, &weights, 0.0, 30.0, None, &SEED_WIDTHS) {
            let q = fit::quality(&sorted, &weights, grid);
            assert!(
                seed_score(&q) < GOOD_ENOUGH,
                "noise scored {} as a grid",
                seed_score(&q)
            );
        }
    }

    #[test]
    fn a_prior_keeps_the_octave_stable() {
        let (times, weights) = drum_grid(0.25, 0.0, 40.0);
        let with_prior = seed_grid(&times, &weights, 0.0, 30.0, Some(0.25), &SEED_WIDTHS)
            .expect("seeds");
        let ratio = with_prior.period / 0.25;
        assert!(
            (ratio - 1.0).abs() < 0.05,
            "prior 0.25 gave {} ({}x)",
            with_prior.period,
            ratio
        );
    }
}
