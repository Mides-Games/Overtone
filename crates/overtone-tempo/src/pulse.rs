//! Is the seed grid a pulse, or a coincidence? — v3 `_pulse_log10p` and
//! `_fit_pulse_gap`.
//!
//! The share gate (0.40) alone let sparse random attacks through: with 24-40
//! attacks in 30-40 s, the best of the seed search's grids cleared it in
//! 38-55 % of trials. No single statistic separates them from real music:
//!
//! ```text
//!                               random attacks      real music, worst case
//! chance of the inliers         down to 10^-5.47    as weak as 10^-1.30 (vocals off the grid)
//! envelope pulse gap            up to 0.105         as low as 0.035 (a rubato ballad)
//! ```
//!
//! Together they do: a grid is refused only when both are weak. Both are
//! computed exactly as v3 computes them, shuffles included, so the two
//! engines take the same decision on the same attacks and envelope.

use realfft::RealFftPlanner;

use crate::fit::Grid;

/// A grid whose inliers are likelier than this (log10) to be chance needs the
/// envelope to vouch for it.
pub const WEAK_PULSE_LOG10P: f64 = -6.0;
/// An envelope this much more periodic than itself shuffled vouches for it.
pub const STRONG_PULSE_GAP: f64 = 0.15;
/// Inlier tolerance, as a fraction of the period (with a 6 ms floor).
const TOL_RATIO: f64 = 0.12;
/// Shuffled copies the gap is measured against.
const SHUFFLES: u64 = 5;
/// One autocorrelation window every this many frames.
const STRIDE: usize = 16;
/// Autocorrelation window, in frames.
const WINDOW: usize = 384;

/// log10 of the chance that uniformly random attack times land this many
/// inliers on `grid`: a binomial tail with p = 2 * tol / period.
pub fn chance_log10(times: &[f64], grid: Grid) -> f64 {
    let n = times.len();
    if n == 0 || grid.period <= 0.0 {
        return 0.0;
    }
    let tol = (TOL_RATIO * grid.period).max(0.006);
    let p = (2.0 * tol / grid.period).min(1.0);
    let inliers = times
        .iter()
        .filter(|&&t| {
            let k = ((t - grid.phase) / grid.period).round();
            (t - (grid.phase + k * grid.period)).abs() <= tol
        })
        .count();
    if inliers == 0 || p >= 1.0 {
        return 0.0;
    }
    // log P(X >= inliers), summed in log space: the terms reach 1e-300.
    let mut ln_fact = vec![0.0f64; n + 1];
    for i in 1..=n {
        ln_fact[i] = ln_fact[i - 1] + (i as f64).ln();
    }
    let terms: Vec<f64> = (inliers..=n)
        .map(|j| {
            ln_fact[n] - ln_fact[j] - ln_fact[n - j]
                + j as f64 * p.ln()
                + (n - j) as f64 * (-p).ln_1p()
        })
        .collect();
    let top = terms.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let sum: f64 = terms.iter().map(|&v| (v - top).exp()).sum();
    (top + sum.ln()) / std::f64::consts::LN_10
}

/// SplitMix64 of `x` — v3 `_splitmix64`.
fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Median over the track of the best 0.2-1.5 s self-similarity of `onset` —
/// v3 `_pulse_clarity`: librosa's tempogram autocorrelation, one window every
/// `STRIDE` frames.
fn clarity(onset: &[f64], sr: u32, hop: usize) -> f64 {
    let n = onset.len();
    let half = WINDOW / 2;
    // numpy's linear_ramp padding down to zero at both outer edges.
    let mut padded = vec![0.0f64; n + 2 * half];
    for i in 0..half {
        padded[i] = i as f64 / half as f64 * onset[0];
        padded[n + half + i] = (half - 1 - i) as f64 / half as f64 * onset[n - 1];
    }
    padded[half..half + n].copy_from_slice(onset);
    let hann: Vec<f64> = (0..WINDOW)
        .map(|k| 0.5 - 0.5 * (std::f64::consts::TAU * k as f64 / WINDOW as f64).cos())
        .collect();
    let band: Vec<usize> = (0..WINDOW)
        .filter(|&k| {
            let lag = k as f64 * hop as f64 / sr as f64;
            (0.2..=1.5).contains(&lag)
        })
        .collect();
    if band.is_empty() {
        return 0.0;
    }
    let fft_len = (2 * WINDOW - 1).next_power_of_two();
    let mut planner = RealFftPlanner::<f64>::new();
    let forward = planner.plan_fft_forward(fft_len);
    let inverse = planner.plan_fft_inverse(fft_len);
    let mut input = forward.make_input_vec();
    let mut spectrum = forward.make_output_vec();
    let mut output = inverse.make_output_vec();
    let mut best = Vec::with_capacity(n.div_ceil(STRIDE));
    for start in (0..n).step_by(STRIDE) {
        input.fill(0.0);
        for (slot, (&value, &w)) in input
            .iter_mut()
            .zip(padded[start..start + WINDOW].iter().zip(&hann))
        {
            *slot = value * w;
        }
        let mut value = 0.0;
        if forward.process(&mut input, &mut spectrum).is_ok() {
            for bin in spectrum.iter_mut() {
                *bin = realfft::num_complex::Complex::new(bin.norm_sqr(), 0.0);
            }
            if inverse.process(&mut spectrum, &mut output).is_ok() {
                // Unnormalised inverse: dividing by the peak removes the scale.
                let peak = output[..WINDOW].iter().fold(0.0f64, |m, &v| m.max(v.abs()));
                if peak > 0.0 {
                    value = band
                        .iter()
                        .map(|&k| output[k] / peak)
                        .fold(f64::NEG_INFINITY, f64::max);
                }
            }
        }
        best.push(value);
    }
    best.sort_unstable_by(f64::total_cmp);
    let mid = best.len() / 2;
    if best.len() % 2 == 0 {
        0.5 * (best[mid - 1] + best[mid])
    } else {
        best[mid]
    }
}

/// How much more periodic the fitting envelope is than itself, shuffled —
/// v3 `_fit_pulse_gap`. `env` is at `hop`; it is max-pooled in pairs first.
/// Shuffling keeps the loudness distribution and destroys any rhythm, so
/// noise scores about zero and music clearly above it.
pub fn envelope_gap(env: &[f32], sr: u32, hop: usize) -> f64 {
    let onset: Vec<f64> = env
        .chunks_exact(2)
        .map(|pair| pair[0].max(pair[1]) as f64)
        .collect();
    if onset.len() < 64 || !onset.iter().any(|&v| v > 0.0) {
        return 0.0;
    }
    let hop = 2 * hop;
    let mut shuffled = 0.0;
    for shuffle in 0..SHUFFLES {
        let mut order: Vec<usize> = (0..onset.len()).collect();
        order.sort_by_key(|&i| splitmix64(i as u64 + (shuffle << 32)));
        let frames: Vec<f64> = order.iter().map(|&i| onset[i]).collect();
        shuffled += clarity(&frames, sr, hop);
    }
    clarity(&onset, sr, hop) - shuffled / SHUFFLES as f64
}

/// True when chance explains the grid's inliers and the envelope agrees.
pub fn is_chance(times: &[f64], grid: Grid, env: &[f32], sr: u32, hop: usize) -> bool {
    chance_log10(times, grid) > WEAK_PULSE_LOG10P && envelope_gap(env, sr, hop) < STRONG_PULSE_GAP
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix_matches_the_reference_sequence() {
        // SplitMix64 seeded at 0, as v3's numpy version prints it.
        assert_eq!(splitmix64(0), 0xE220_A839_7B1D_CDAF);
        assert_eq!(splitmix64(1), 0x910A_2DEC_8902_5CC1);
    }

    /// Thirty attack times from an LCG, seed 7, over 30 s.
    fn scattered() -> Vec<f64> {
        let mut seed = 7u64;
        (0..30)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as f64 / (1u64 << 31) as f64 * 30.0
            })
            .collect()
    }

    #[test]
    fn chance_matches_v3_and_tells_a_grid_from_scattered_times() {
        let grid = Grid {
            period: 0.8,
            phase: 0.1,
        };
        let regular: Vec<f64> = (0..30).map(|k| k as f64 * 0.8 + 0.1).collect();
        // 30 of 30 inliers at p = 0.24: log10(0.24^30).
        assert!((chance_log10(&regular, grid) - 30.0 * 0.24f64.log10()).abs() < 1e-9);
        // v3 `_pulse_log10p` (scipy's binomial tail) on the same times.
        assert!((chance_log10(&scattered(), grid) - -0.055861299894949396).abs() < 1e-9);
        assert_eq!(chance_log10(&[], grid), 0.0);
    }

    #[test]
    fn envelope_gap_matches_v3() {
        let sr = 44_100;
        let hop = 128;
        // A 120 BPM beat over a quiet floor: clearly periodic.
        let frames = 60 * sr as usize / hop;
        let period = 0.5 * sr as f64 / hop as f64;
        let beat: Vec<f32> = (0..frames)
            .map(|i| if (i as f64 % period) < 1.0 { 1.0 } else { 0.02 })
            .collect();
        // The scattered attacks as spikes: nothing periodic about them.
        let mut spikes = vec![0.0f32; 32 * sr as usize / hop];
        for t in scattered() {
            spikes[(t * sr as f64 / hop as f64) as usize] = 0.8;
        }
        // v3 `_fit_pulse_gap` on the same envelopes.
        assert!((envelope_gap(&beat, sr, hop) - 0.37622450492124215).abs() < 1e-9);
        assert!((envelope_gap(&spikes, sr, hop) - -0.03131919972257452).abs() < 1e-9);
        assert!(envelope_gap(&beat, sr, hop) > STRONG_PULSE_GAP);
        assert!(envelope_gap(&spikes, sr, hop) < STRONG_PULSE_GAP);
        assert_eq!(envelope_gap(&vec![0.0; frames], sr, hop), 0.0);
        assert_eq!(envelope_gap(&[], sr, hop), 0.0);
    }
}
