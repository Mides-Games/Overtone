//! Mel-frequency cepstral coefficients: timbre in thirteen numbers.
//!
//! Log mel energies through a DCT-II, per frame. Chroma hears *which notes*;
//! MFCC hears *what sounds like what* — the verse playing the same chords
//! with different instrumentation still looks different. Kept for the
//! structure and hitsound stages that need timbre similarity; the novelty
//! curve itself runs on chroma plus energy.
//!
//! Conventions: 20 mel bands (wide enough to be cheap, narrow enough to
//! resolve formants), natural log with a 1e-10 floor, orthonormal DCT-II,
//! all 13 coefficients kept including the 0th (log energy). Deterministic,
//! no state, no I/O.

use crate::mel;

/// Mel bands feeding the cepstrum.
pub const N_MFCC_MELS: usize = 20;
/// Cepstral coefficients kept, 0th included.
pub const N_MFCC: usize = 13;

/// MFCC matrix: one 13-vector per frame.
pub fn mfcc(y: &[f32], sr: u32, hop: usize, n_fft: usize) -> Vec<[f64; N_MFCC]> {
    let bank = mel::MelBank::new(sr, n_fft, N_MFCC_MELS, 0.0, sr as f64 / 2.0);
    let spec = crate::stft::mel_power_spectrogram(y, n_fft, hop, &bank);
    spec.iter().map(|row| frame_mfcc(row)).collect()
}

fn frame_mfcc(mel_energies: &[f64]) -> [f64; N_MFCC] {
    debug_assert_eq!(mel_energies.len(), N_MFCC_MELS);
    let log: Vec<f64> = mel_energies.iter().map(|&e| e.max(1e-10).ln()).collect();
    dct_ii(&log)
}

/// Orthonormal DCT-II, first [`N_MFCC`] outputs.
fn dct_ii(input: &[f64]) -> [f64; N_MFCC] {
    let n = input.len() as f64;
    let mut out = [0.0f64; N_MFCC];
    for (k, slot) in out.iter_mut().enumerate() {
        let mut sum = 0.0;
        for (i, &x) in input.iter().enumerate() {
            sum += x * (std::f64::consts::PI * k as f64 * (2 * i + 1) as f64 / (2.0 * n)).cos();
        }
        let scale = if k == 0 { (1.0 / n).sqrt() } else { (2.0 / n).sqrt() };
        *slot = sum * scale;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thirteen_coefficients_per_frame() {
        let y = vec![0.0f32; 44_100];
        let out = mfcc(&y, 44_100, 512, 2048);
        assert!(!out.is_empty());
        assert_eq!(out[0].len(), N_MFCC);
    }

    #[test]
    fn silence_maps_to_log_floor_with_zero_ac() {
        // Constant log spectrum: DCT carries everything in the 0th, AC is
        // exactly zero. Silence must be a stable, boring point — never NaN.
        let y = vec![0.0f32; 44_100];
        for frame in mfcc(&y, 44_100, 512, 2048) {
            assert!(frame.iter().all(|v| v.is_finite()));
            for &v in &frame[1..] {
                assert!(v.abs() < 1e-9, "AC leakage {v}");
            }
        }
    }

    #[test]
    fn different_timbres_read_different() {
        // Same pitch (220 Hz), different spectra: sine vs square-ish stack.
        // A timbre descriptor that cannot tell them apart is decoration.
        let sr = 44_100;
        let sine: Vec<f32> = (0..sr)
            .map(|i| (0.5 * (2.0 * std::f64::consts::PI * 220.0 * i as f64 / sr as f64).sin()) as f32)
            .collect();
        let rich: Vec<f32> = (0..sr)
            .map(|i| {
                let t = i as f64 / sr as f64;
                (0.4 * (2.0 * std::f64::consts::PI * 220.0 * t).sin()
                    + 0.25 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()
                    + 0.2 * (2.0 * std::f64::consts::PI * 660.0 * t).sin()
                    + 0.15 * (2.0 * std::f64::consts::PI * 880.0 * t).sin()) as f32
            })
            .collect();
        let mean = |y: &[f32]| {
            let frames = mfcc(y, sr, 512, 2048);
            let mid = &frames[frames.len() / 3..2 * frames.len() / 3];
            let mut acc = [0.0f64; N_MFCC];
            for f in mid {
                for (c, a) in acc.iter_mut().enumerate() {
                    *a += f[c];
                }
            }
            acc.map(|v| v / mid.len() as f64)
        };
        let (a, b) = (mean(&sine), mean(&rich));
        let dist: f64 = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| (x - y).powi(2))
            .sum::<f64>()
            .sqrt();
        assert!(dist > 1.0, "timbres indistinguishable: {dist}");
    }

    #[test]
    fn same_input_twice_is_bit_stable() {
        let y: Vec<f32> = (0..8192)
            .map(|i| (0.3 * (2.0 * std::f64::consts::PI * 330.0 * i as f64 / 44_100.0).sin()) as f32)
            .collect();
        assert_eq!(mfcc(&y, 44_100, 512, 2048), mfcc(&y, 44_100, 512, 2048));
    }
}
