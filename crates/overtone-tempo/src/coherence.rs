//! Weighted circular coherence: how well a candidate pulse rate explains the
//! phases of the detected attacks.
//!
//! ```text
//! R(f) = |Σ w·e^{2πi f t}| / Σ w
//! ```
//!
//! One O(N) statistic per frequency, so the whole plausible range can be swept
//! rather than trusting one tracker's guess.
//!
//! **The phase sign.** `z = Σ w·e^{2πi f t}` has `arg(z) = 2π f φ`, so
//! `φ = arg(z) / (2π f)` — *not* `−arg(z)`. v3's timeline records this as the
//! single largest source of error in the first working version of the engine:
//! every seed grid started in anti-phase, half a beat off, and iteratively
//! re-weighted least squares cannot recover from a slipped beat index. It gets
//! the first test in this file for that reason.

use overtone_dsp::peaks;
use rayon::prelude::*;

/// Plausible atomic pulse periods, in seconds. 0.055 s is 1091 BPM at the
/// atom level; 1.35 s is 44 BPM. Wider than any beat, because the *atom* may
/// be a subdivision of the beat.
pub const PERIOD_RANGE: (f64, f64) = (0.055, 1.35);
/// Cap the sweep on very dense audio; the strongest attacks carry the phase.
const MAX_SCAN_ONSETS: usize = 5000;
/// Cap the frequency grid. Only reachable with very wide seed windows.
const MAX_SCAN_FREQS: usize = 20_000;

/// A candidate atomic grid: period and phase in seconds, plus the coherence
/// that proposed it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candidate {
    pub period: f64,
    pub phase: f64,
    pub coherence: f64,
}

/// `R(f)` for every frequency in `freqs`.
pub fn sweep(times: &[f64], weights: &[f32], freqs: &[f64]) -> Vec<f64> {
    let total: f64 = weights.iter().map(|&w| w as f64).sum();
    if total <= 0.0 || times.is_empty() {
        return vec![0.0; freqs.len()];
    }
    freqs
        .par_iter()
        .map(|&f| {
            let mut cos_sum = 0.0f64;
            let mut sin_sum = 0.0f64;
            let omega = std::f64::consts::TAU * f;
            for (&t, &w) in times.iter().zip(weights) {
                let (sin, cos) = (omega * t).sin_cos();
                let w = w as f64;
                cos_sum += w * cos;
                sin_sum += w * sin;
            }
            cos_sum.hypot(sin_sum) / total
        })
        .collect()
}

/// Phase of the coherence vector at `f`, in seconds.
fn phase_at(times: &[f64], weights: &[f32], f: f64) -> f64 {
    let omega = std::f64::consts::TAU * f;
    let mut cos_sum = 0.0f64;
    let mut sin_sum = 0.0f64;
    for (&t, &w) in times.iter().zip(weights) {
        let (sin, cos) = (omega * t).sin_cos();
        let w = w as f64;
        cos_sum += w * cos;
        sin_sum += w * sin;
    }
    // arg(z) / (2π f). The sign here is the one that mattered.
    sin_sum.atan2(cos_sum) / omega
}

/// Candidate atomic pulses in ascending period: fastest first. Of the
/// strong peaks the *slowest* `keep` are kept, then widened, and the widened
/// list is sorted by period -- v3 `_coherence_candidates` does the same,
/// though both used to say "slowest first".
///
/// `R` is high at the atomic pulse *and at every multiple of it*, so the
/// candidate list is deliberately widened to ×1..×4 of each peak: the slower
/// reading still contains every attack, and it keeps swung or shuffled music —
/// which has no clean sub-beat grid — fittable at all.
pub fn candidates(times: &[f64], weights: &[f32], keep: usize) -> Vec<Candidate> {
    if times.len() < 8 {
        return Vec::new();
    }
    // Dense audio: score the phase on the strongest attacks. Deliberately a
    // separate binding from `keep`, which counts candidates — conflating the
    // two was a latent panic in v3 (audit F-01).
    let (times, weights) = if times.len() > MAX_SCAN_ONSETS {
        let mut order: Vec<usize> = (0..weights.len()).collect();
        order.sort_by(|&a, &b| weights[a].total_cmp(&weights[b]));
        let mut dense: Vec<usize> = order[order.len() - MAX_SCAN_ONSETS..].to_vec();
        dense.sort_unstable();
        (
            dense.iter().map(|&i| times[i]).collect::<Vec<f64>>(),
            dense.iter().map(|&i| weights[i]).collect::<Vec<f32>>(),
        )
    } else {
        (times.to_vec(), weights.to_vec())
    };

    let span = times[times.len() - 1] - times[0];
    if span <= 1.0 {
        return Vec::new();
    }
    let lo_f = 1.0 / PERIOD_RANGE.1;
    let hi_f = 1.0 / PERIOD_RANGE.0;
    // Keeps the coherence lobe resolvable: its width scales as 1/span.
    let step = (0.2 / span).max(1e-4);
    let count = ((hi_f - lo_f) / step).ceil() as usize;
    if count < 4 {
        return Vec::new();
    }
    let freqs: Vec<f64> = if count > MAX_SCAN_FREQS {
        (0..MAX_SCAN_FREQS)
            .map(|i| lo_f + (hi_f - lo_f) * i as f64 / (MAX_SCAN_FREQS - 1) as f64)
            .collect()
    } else {
        (0..count).map(|i| lo_f + step * i as f64).collect()
    };

    let curve = sweep(&times, &weights, &freqs);
    let mut picked = peaks::find_peaks(&curve, 2, None, None);
    if picked.is_empty() {
        // .rev(): the first of equal maxima, as np.argmax.
        let best = curve
            .iter()
            .enumerate()
            .rev()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(i, _)| i);
        picked = best.into_iter().collect();
    }
    let best = picked
        .iter()
        .map(|&i| curve[i])
        .fold(f64::NEG_INFINITY, f64::max);
    if best <= 1e-6 {
        return Vec::new();
    }
    let mut strong: Vec<usize> = picked
        .into_iter()
        .filter(|&i| curve[i] >= 0.55 * best)
        .collect();
    strong.sort_by(|&a, &b| freqs[a].total_cmp(&freqs[b]));
    strong.truncate(keep);

    let raw: Vec<Candidate> = strong
        .into_iter()
        .map(|i| {
            let f = freqs[i];
            let period = 1.0 / f;
            let phase = phase_at(&times, &weights, f).rem_euclid(period);
            Candidate {
                period,
                phase,
                coherence: curve[i],
            }
        })
        .collect();

    let mut widened: Vec<Candidate> = Vec::new();
    for candidate in &raw {
        for multiple in 1..=4u32 {
            let slower = candidate.period * multiple as f64;
            if slower > PERIOD_RANGE.1 * 1.6 {
                continue;
            }
            if widened.iter().all(|k| (slower - k.period).abs() > 0.004) {
                widened.push(Candidate {
                    period: slower,
                    phase: candidate.phase.rem_euclid(slower),
                    coherence: candidate.coherence,
                });
            }
        }
    }
    widened.sort_by(|a, b| a.period.total_cmp(&b.period));
    widened
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(period: f64, phase: f64, count: usize) -> (Vec<f64>, Vec<f32>) {
        (
            (0..count).map(|k| phase + k as f64 * period).collect(),
            vec![1.0f32; count],
        )
    }

    #[test]
    fn coherence_phase_has_the_right_sign() {
        // The regression test v3's timeline calls its single largest error
        // source. A grid at 0.5 s starting at 0.123 s must report phase 0.123,
        // not 0.377 (which is what negating arg(z) gives).
        let (times, weights) = grid(0.5, 0.123, 64);
        let f = 2.0;
        let phase = phase_at(&times, &weights, f).rem_euclid(0.5);
        assert!(
            (phase - 0.123).abs() < 1e-6,
            "phase came back {phase}, expected 0.123 — sign is inverted"
        );
    }

    #[test]
    fn coherence_is_one_on_a_perfect_grid() {
        let (times, weights) = grid(0.4, 0.0, 100);
        let r = sweep(&times, &weights, &[2.5]);
        assert!((r[0] - 1.0).abs() < 1e-9, "got {}", r[0]);
    }

    #[test]
    fn coherence_is_low_off_the_grid() {
        let (times, weights) = grid(0.4, 0.0, 100);
        // 1.7 Hz is not a multiple of 2.5 Hz and not a sub-multiple.
        let r = sweep(&times, &weights, &[1.7]);
        assert!(r[0] < 0.2, "got {}", r[0]);
    }

    #[test]
    fn coherence_peaks_at_multiples_too() {
        // This is exactly why candidates must be widened rather than trusted:
        // R is just as high at 2x the true rate.
        let (times, weights) = grid(0.4, 0.0, 100);
        let r = sweep(&times, &weights, &[2.5, 5.0, 7.5]);
        for value in r {
            assert!(value > 0.99, "got {value}");
        }
    }

    #[test]
    fn candidates_include_the_true_period() {
        let (times, weights) = grid(0.4, 0.07, 150);
        let found = candidates(&times, &weights, 10);
        assert!(!found.is_empty());
        assert!(
            found.iter().any(|c| (c.period - 0.4).abs() < 0.01),
            "no candidate near 0.4 s in {:?}",
            found.iter().map(|c| c.period).collect::<Vec<_>>()
        );
    }

    #[test]
    fn candidates_come_back_in_ascending_period() {
        let (times, weights) = grid(0.25, 0.0, 200);
        let found = candidates(&times, &weights, 10);
        assert!(found.windows(2).all(|w| w[0].period <= w[1].period));
    }

    #[test]
    fn too_few_attacks_yields_nothing() {
        let (times, weights) = grid(0.4, 0.0, 5);
        assert!(candidates(&times, &weights, 10).is_empty());
    }

    #[test]
    fn a_short_span_yields_nothing() {
        // Ten attacks inside one second: the coherence lobe is wider than the
        // whole search range, so there is nothing to resolve.
        let (times, weights) = grid(0.05, 0.0, 10);
        assert!(candidates(&times, &weights, 10).is_empty());
    }
}
