//! Pitch-class (chroma) profiles from the power spectrogram.
//!
//! Each STFT bin folds into one of twelve semitone classes (12-TET, A=440,
//! C=0), weighted by magnitude. Frames are L1-normalised — a chroma vector
//! sums to 1, silence maps to zeros — so cosine similarity between frames
//! measures harmonic content, never loudness. Loudness lives in the energy
//! map beside it, deliberately separate.
//!
//! This is new construction, not a v3 port: v3 never computed chroma. The
//! convention choices (magnitude weighting, L1 frames, full-range bins) are
//! pinned by the tests below, not by any external contract.

/// A440, the tuning everything folds against.
pub const A4_HZ: f64 = 440.0;
/// Pitch classes C..B as indices 0..11.
pub const CLASSES: usize = 12;

/// Chroma matrix: one L1-normalised 12-vector per frame. `power` rows hold
/// `n_fft/2 + 1` bins from [`crate::stft::power_spectrogram`].
pub fn chroma(power: &[Vec<f64>], sr: u32, n_fft: usize) -> Vec<[f64; CLASSES]> {
    let bin_hz = sr as f64 / n_fft as f64;
    power
        .iter()
        .map(|row| {
            let mut classes = [0.0f64; CLASSES];
            for (bin, &energy) in row.iter().enumerate().skip(1) {
                if energy <= 0.0 {
                    continue;
                }
                let freq = bin as f64 * bin_hz;
                let midi = (69.0 + 12.0 * (freq / A4_HZ).log2()).round() as i64;
                classes[midi.rem_euclid(12) as usize] += energy.sqrt();
            }
            let total: f64 = classes.iter().sum();
            if total > 0.0 {
                for value in &mut classes {
                    *value /= total;
                }
            }
            classes
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stft;

    fn tone(sr: u32, seconds: f64, freq: f64) -> Vec<f32> {
        (0..(seconds * sr as f64) as usize)
            .map(|i| (0.5 * (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin()) as f32)
            .collect()
    }

    fn mean_chroma(y: &[f32], sr: u32) -> [f64; CLASSES] {
        let spec = stft::power_spectrogram(y, 2048, 128);
        // Middle third: past the start transient, before the end padding.
        let third = spec.len() / 3;
        let mid = &spec[third..2 * third];
        let mut acc = [0.0f64; CLASSES];
        for frame in chroma(mid, sr, 2048) {
            for (c, acc) in acc.iter_mut().enumerate() {
                *acc += frame[c];
            }
        }
        let n = mid.len() as f64;
        acc.map(|v| v / n)
    }

    #[test]
    fn a440_lands_on_class_9() {
        // MIDI 69 -> 69 mod 12 = 9.
        let mean = mean_chroma(&tone(44_100, 2.0, 440.0), 44_100);
        let top = mean
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(c, _)| c)
            .unwrap();
        assert_eq!(top, 9, "A should dominate, got {mean:.3?}");
        assert!(mean[9] > 0.5, "A should hold the majority: {mean:.3?}");
    }

    #[test]
    fn middle_c_lands_on_class_0() {
        let mean = mean_chroma(&tone(44_100, 2.0, 261.63), 44_100);
        let top = mean
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(c, _)| c)
            .unwrap();
        assert_eq!(top, 0, "C should dominate, got {mean:.3?}");
    }

    #[test]
    fn a_major_triad_shows_its_three_classes() {
        // A + C# + E: classes 9, 1, 4.
        let y: Vec<f32> = (0..(2.0 * 44_100.0) as usize)
            .map(|i| {
                let t = i as f64 / 44_100.0;
                (0.3 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()
                    + 0.3 * (2.0 * std::f64::consts::PI * 554.37 * t).sin()
                    + 0.3 * (2.0 * std::f64::consts::PI * 659.25 * t).sin()) as f32
            })
            .collect();
        let mean = mean_chroma(&y, 44_100);
        let mut order: Vec<usize> = (0..CLASSES).collect();
        order.sort_by(|&a, &b| mean[b].total_cmp(&mean[a]));
        // The three triad classes must lead, in any order among near-ties.
        // Adjacent-class leakage is inherent (C catches C#'s skirt), so the
        // structural bar is present-above-absent, strictly, with no margin
        // factor invented on top.
        let mut top = order[..3].to_vec();
        top.sort_unstable();
        assert_eq!(top, vec![1, 4, 9], "triad classes: {mean:.3?}");
        assert!(
            mean[order[2]] > mean[order[3]],
            "an absent class outranks a present one: {mean:.3?}"
        );
    }

    #[test]
    fn frames_normalise_and_silence_maps_to_zero() {
        let spec = stft::power_spectrogram(&tone(44_100, 1.0, 440.0), 2048, 128);
        for frame in chroma(&spec, 44_100, 2048) {
            let sum: f64 = frame.iter().sum();
            assert!((sum - 1.0).abs() < 1e-9 || sum == 0.0);
        }
        let silent = stft::power_spectrogram(&vec![0.0f32; 8192], 2048, 128);
        for frame in chroma(&silent, 44_100, 2048) {
            assert!(frame.iter().all(|&v| v == 0.0));
        }
    }
}
