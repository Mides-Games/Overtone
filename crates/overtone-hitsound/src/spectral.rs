//! Spectral per-attack features (docs §2).
//!
//! One Hann-windowed FFT over [−10 ms, +120 ms] per attack (length rounded
//! up to a power of two), then everything as ratios: seven log-band
//! energies, centroid, two rolloffs, bandwidth, flatness, crest, and the
//! flux against the pre-window spectrum. Ratios keep the engine
//! loudness-invariant; the tests assert the same features from the same hit
//! at two master levels.

use realfft::RealFftPlanner;

use crate::{PRE_END_S, PRE_START_S, WIN_END_S, WIN_START_S};

/// Band edges in Hz, from the design doc — musical bands, not log-spaced:
/// sub reads kick fundamentals, high reads hats, air reads shimmer.
pub const BANDS: [(f64, f64); 7] = [
    (20.0, 60.0),
    (60.0, 120.0),
    (120.0, 400.0),
    (400.0, 2000.0),
    (2000.0, 6000.0),
    (6000.0, 11000.0),
    (11000.0, f64::INFINITY),
];

/// Spectral evidence for one attack.
#[derive(Debug, Clone)]
pub struct Spectral {
    /// Band power / total power, in doc band order.
    pub band_ratios: [f64; 7],
    /// Magnitude-weighted mean frequency in Hz.
    pub centroid: f64,
    /// Frequency below which 85 % / 95 % of the energy sits, in Hz.
    pub rolloff85: f64,
    pub rolloff95: f64,
    /// RMS spread around the centroid in Hz.
    pub bandwidth: f64,
    /// Geometric / arithmetic mean of power: ~1 for noise, ~0 for tones.
    pub flatness: f64,
    /// Peak / mean magnitude.
    pub crest: f64,
    /// Rectified attack-minus-pre magnitude change, over attack total.
    pub flux: f64,
}

/// Hann-periodic windowed magnitude spectrum of `samples`.
fn spectrum(samples: &[f64], sr: u32) -> (Vec<f64>, f64) {
    let n = samples.len().next_power_of_two().max(256);
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n);
    let mut input = fft.make_input_vec();
    for (slot, &v) in input.iter_mut().zip(samples.iter()) {
        *slot = v;
    }
    // Periodic Hann over the real length (not the padded length).
    let len = samples.len();
    for (i, slot) in input[..len].iter_mut().enumerate() {
        *slot *= 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / len as f64).cos();
    }
    let mut output = fft.make_output_vec();
    fft.process(&mut input, &mut output)
        .expect("fft sizes are fixed");
    let mags: Vec<f64> = output.iter().map(|c| c.norm()).collect();
    (mags, sr as f64 / n as f64)
}

/// Analyse the attack at `attack_s` in `y`.
pub fn analyze(y: &[f32], sr: u32, attack_s: f64) -> Spectral {
    let attack = crate::window_samples(y, sr, attack_s, WIN_START_S, WIN_END_S);
    let pre = crate::window_samples(y, sr, attack_s, PRE_START_S, PRE_END_S);
    let (mag, bin_hz) = spectrum(&attack, sr);
    let (pre_mag, _) = spectrum(&pre, sr);
    let total: f64 = mag.iter().map(|&m| m * m).sum();

    let mut band_ratios = [0.0f64; 7];
    if total > 0.0 {
        for (b, &(lo, hi)) in BANDS.iter().enumerate() {
            let energy: f64 = mag
                .iter()
                .enumerate()
                .filter(|&(i, _)| {
                    let f = i as f64 * bin_hz;
                    f >= lo && f < hi
                })
                .map(|(_, &m)| m * m)
                .sum();
            band_ratios[b] = energy / total;
        }
    }

    let mag_sum: f64 = mag.iter().sum();
    let centroid = if mag_sum > 0.0 {
        mag.iter()
            .enumerate()
            .map(|(i, &m)| i as f64 * bin_hz * m)
            .sum::<f64>()
            / mag_sum
    } else {
        0.0
    };
    let rolloff = |q: f64| -> f64 {
        if total <= 0.0 {
            return 0.0;
        }
        let mut acc = 0.0;
        for (i, &m) in mag.iter().enumerate() {
            acc += m * m;
            if acc >= q * total {
                return i as f64 * bin_hz;
            }
        }
        (mag.len() - 1) as f64 * bin_hz
    };
    let bandwidth = if mag_sum > 0.0 {
        (mag.iter()
            .enumerate()
            .map(|(i, &m)| {
                let d = i as f64 * bin_hz - centroid;
                d * d * m
            })
            .sum::<f64>()
            / mag_sum)
            .sqrt()
    } else {
        0.0
    };
    let flatness = {
        let n = mag.len() as f64;
        let (mut log_sum, mut count) = (0.0, 0usize);
        for &m in &mag {
            if m > 0.0 {
                log_sum += m.ln();
                count += 1;
            }
        }
        if count == 0 {
            0.0
        } else {
            (log_sum / n).exp() / (mag_sum / n).max(1e-12)
        }
    };
    let crest = if mag_sum > 0.0 && !mag.is_empty() {
        mag.iter().copied().fold(0.0f64, f64::max) / (mag_sum / mag.len() as f64)
    } else {
        0.0
    };
    let flux = {
        let n = mag.len().max(pre_mag.len());
        let mut num = 0.0;
        for i in 0..n {
            let a = mag.get(i).copied().unwrap_or(0.0);
            let p = pre_mag.get(i).copied().unwrap_or(0.0);
            num += (a - p).max(0.0);
        }
        num / mag_sum.max(1e-12)
    };

    Spectral {
        band_ratios,
        centroid,
        rolloff85: rolloff(0.85),
        rolloff95: rolloff(0.95),
        bandwidth,
        flatness,
        crest,
        flux,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kick(sr: u32, at: f64) -> Vec<f32> {
        hitting(sr, 6.0, at, 60.0, 0.0, 0.02)
    }

    fn noise_hat(sr: u32, at: f64) -> Vec<f32> {
        hitting(sr, 6.0, at, 0.0, 1.0, 0.005)
    }

    /// Sine hit at `freq` plus white-noise burst of `noise` amplitude, both
    /// decaying, in a 6 s buffer at `at`. Either component may be zero.
    fn hitting(sr: u32, seconds: f64, at: f64, freq: f64, noise: f64, decay: f64) -> Vec<f32> {
        let mut seed = 4242u64;
        let mut rng = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        let n = (seconds * sr as f64) as usize;
        let start = (at * sr as f64) as usize;
        let mut y = vec![0.0f32; n];
        for i in start..n {
            let dt = (i - start) as f64 / sr as f64;
            let env = (-dt / decay).exp();
            let tone = if freq > 0.0 {
                (2.0 * std::f64::consts::PI * freq * dt).sin()
            } else {
                0.0
            };
            y[i] = (tone * env + noise * rng() * (-dt / 0.01).exp().min(1.0) * env) as f32;
        }
        let peak = y.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        y.iter().map(|v| v / peak * 0.99).collect()
    }

    #[test]
    fn kick_energy_sits_low_hat_energy_sits_high() {
        let sr = 44_100;
        let kick = analyze(&kick(sr, 2.0), sr, 2.0);
        assert!(
            kick.band_ratios[0] + kick.band_ratios[1] > 0.7,
            "kick bands: {:?}",
            kick.band_ratios
        );
        let hat = analyze(&noise_hat(sr, 2.0), sr, 2.0);
        assert!(
            hat.band_ratios[5] + hat.band_ratios[6] > 0.6,
            "hat bands: {:?}",
            hat.band_ratios
        );
        assert!(kick.centroid < 500.0, "kick centroid {}", kick.centroid);
        assert!(hat.centroid > 4000.0, "hat centroid {}", hat.centroid);
        assert!(
            kick.rolloff85 < hat.rolloff85,
            "rolloff {} vs {}",
            kick.rolloff85,
            hat.rolloff85
        );
    }

    #[test]
    fn noise_is_flat_tone_is_not() {
        let sr = 44_100;
        let hat = analyze(&noise_hat(sr, 2.0), sr, 2.0);
        let kick = analyze(&kick(sr, 2.0), sr, 2.0);
        assert!(
            hat.flatness > 5.0 * kick.flatness.max(1e-6),
            "flatness {} vs {}",
            hat.flatness,
            kick.flatness
        );
    }

    #[test]
    fn ratios_survive_mastering() {
        // Same hit at two levels: loudness-invariant ratios must agree.
        let sr = 44_100;
        let loud = analyze(&kick(sr, 2.0), sr, 2.0);
        let mut y = kick(sr, 2.0);
        for v in &mut y {
            *v *= 0.25;
        }
        let quiet = analyze(&y, sr, 2.0);
        for (a, b) in loud.band_ratios.iter().zip(quiet.band_ratios.iter()) {
            assert!((a - b).abs() < 0.02, "{a} vs {b}");
        }
        assert!((loud.centroid - quiet.centroid).abs() < 5.0);
    }

    #[test]
    fn silence_analyses_to_zeros() {
        let s = analyze(&vec![0.0f32; 44_100 * 2], 44_100, 1.0);
        assert_eq!(s.band_ratios, [0.0; 7]);
        assert_eq!(s.centroid, 0.0);
        assert_eq!(s.flux, 0.0);
    }
}
