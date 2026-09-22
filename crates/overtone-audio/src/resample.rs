//! Windowed-sinc resampling to the engine's 44.1 kHz.
//!
//! Written here rather than pulled from a crate for two reasons. rubato's
//! current major version moved to an audio-adapter buffer API that adds real
//! friction for a one-shot offline convert, and — more importantly — v3
//! resamples with soxr, which no Rust crate reproduces sample-for-sample
//! anyway. So a resampled file will differ slightly between v3 and v4 by
//! construction, and neither is wrong. What matters is that the filter is good
//! enough that the difference is inaudible and well below the onset
//! detector's resolution.
//!
//! Every benchmark fixture is already 44.1 kHz, so this path is not on the
//! accuracy-critical route; the guard against surprise is the SNR test below.

/// Kaiser window with the given beta, evaluated over `n` points.
fn kaiser(n: usize, beta: f64) -> Vec<f64> {
    fn bessel_i0(x: f64) -> f64 {
        // Series expansion; converges quickly for the |x| <= beta we use.
        let mut sum = 1.0;
        let mut term = 1.0;
        let half = x / 2.0;
        for k in 1..40 {
            term *= (half / k as f64) * (half / k as f64);
            sum += term;
            if term < 1e-18 * sum {
                break;
            }
        }
        sum
    }
    let denom = bessel_i0(beta);
    (0..n)
        .map(|i| {
            let t = 2.0 * i as f64 / (n - 1) as f64 - 1.0;
            bessel_i0(beta * (1.0 - t * t).max(0.0).sqrt()) / denom
        })
        .collect()
}

#[inline]
fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        let pix = std::f64::consts::PI * x;
        pix.sin() / pix
    }
}

/// Resample `y` from `from_sr` to `to_sr`. Returns `y` unchanged when the
/// rates already match, which is the common case and must cost nothing.
pub fn resample(y: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
    if from_sr == to_sr || y.is_empty() {
        return y.to_vec();
    }
    const HALF_TAPS: isize = 32; // 64-tap kernel
    const BETA: f64 = 9.0; // ~ -80 dB sidelobes

    let ratio = to_sr as f64 / from_sr as f64;
    // Anti-alias cutoff: below Nyquist of whichever rate is lower.
    let cutoff = 0.95 * ratio.min(1.0);
    let window = kaiser((2 * HALF_TAPS + 1) as usize, BETA);

    let out_len = ((y.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        // Position in the input, in input samples.
        let centre = n as f64 / ratio;
        let base = centre.floor() as isize;
        let mut acc = 0.0f64;
        let mut norm = 0.0f64;
        for tap in -HALF_TAPS..=HALF_TAPS {
            let index = base + tap;
            if index < 0 || index as usize >= y.len() {
                continue;
            }
            let distance = centre - index as f64;
            let w = window[(tap + HALF_TAPS) as usize] * cutoff * sinc(cutoff * distance);
            acc += w * y[index as usize] as f64;
            norm += w;
        }
        // Normalising by the realised kernel sum keeps the gain flat at the
        // edges, where taps fall outside the signal.
        out.push(if norm.abs() > 1e-12 {
            (acc / norm) as f32
        } else {
            0.0
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sr: u32, freq: f64, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin() as f32)
            .collect()
    }

    #[test]
    fn matching_rates_are_a_no_op() {
        let y = sine(44_100, 440.0, 1000);
        assert_eq!(resample(&y, 44_100, 44_100), y);
    }

    #[test]
    fn length_follows_the_ratio() {
        let y = sine(48_000, 440.0, 48_000);
        let out = resample(&y, 48_000, 44_100);
        let expected = (48_000.0 * 44_100.0 / 48_000.0) as usize;
        assert!((out.len() as i64 - expected as i64).abs() <= 1);
    }

    #[test]
    fn a_tone_survives_with_good_snr() {
        // 1 kHz is far below both Nyquists, so the converted tone should be
        // clean. Compare against an ideal tone at the target rate, skipping
        // the kernel's edge transient.
        let freq = 1000.0;
        let y = sine(48_000, freq, 48_000);
        let out = resample(&y, 48_000, 44_100);
        let ideal = sine(44_100, freq, out.len());
        let skip = 200;
        let (mut signal, mut noise) = (0.0f64, 0.0f64);
        for i in skip..out.len() - skip {
            let d = out[i] as f64 - ideal[i] as f64;
            signal += (ideal[i] as f64).powi(2);
            noise += d * d;
        }
        let snr_db = 10.0 * (signal / noise.max(1e-30)).log10();
        assert!(snr_db > 55.0, "SNR only {snr_db:.1} dB");
    }

    #[test]
    fn upsampling_does_not_blow_up_the_gain() {
        let y = sine(22_050, 440.0, 22_050);
        let out = resample(&y, 22_050, 44_100);
        let peak = out.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
        assert!((0.9..1.1).contains(&peak), "peak {peak}");
    }

    #[test]
    fn empty_input_stays_empty() {
        assert!(resample(&[], 48_000, 44_100).is_empty());
    }
}
