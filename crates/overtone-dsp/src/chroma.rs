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

/// Pitch class of a frequency, 12-TET against [`A4_HZ`].
fn class_of(freq: f64) -> usize {
    let midi = (69.0 + 12.0 * (freq / A4_HZ).log2()).round() as i64;
    midi.rem_euclid(12) as usize
}

/// Chroma matrix: one L1-normalised 12-vector per frame. `power` rows hold
/// `n_fft/2 + 1` bins from [`crate::stft::power_spectrogram`].
///
/// Above the frequency where one bin is narrower than a semitone, each bin
/// folds into the class of its centre. Below it (about 362 Hz at 2048/44.1 k,
/// 181 Hz at 4096) a bin spans more than a semitone, and folding by centre
/// put A1 on F and E2 on F — 24 of the 36 notes from E1 to D#4 landed on the
/// wrong class. There, only spectral peaks count: each is placed at its
/// frequency interpolated from the log power of its two neighbours (a
/// Gaussian fit, near-exact for the Hann window), carrying its lobe's
/// magnitude.
pub fn chroma(power: &[Vec<f64>], sr: u32, n_fft: usize) -> Vec<[f64; CLASSES]> {
    power
        .iter()
        .map(|row| chroma_frame(row, sr, n_fft))
        .collect()
}

/// One frame of [`chroma`], from that frame's `n_fft/2 + 1` power bins. A
/// whole track passes it to [`crate::stft::map_frames`], so only the twelve
/// classes of each frame are ever held.
pub fn chroma_frame(row: &[f64], sr: u32, n_fft: usize) -> [f64; CLASSES] {
    let bin_hz = sr as f64 / n_fft as f64;
    let resolved_hz = bin_hz / (2f64.powf(1.0 / 12.0) - 1.0);
    let mut classes = [0.0f64; CLASSES];
    for (bin, &energy) in row.iter().enumerate().skip(1) {
        if energy <= 0.0 {
            continue;
        }
        let freq = bin as f64 * bin_hz;
        if freq >= resolved_hz {
            classes[class_of(freq)] += energy.sqrt();
            continue;
        }
        let (left, right) = (row[bin - 1], row.get(bin + 1).copied().unwrap_or(0.0));
        if energy <= left || energy < right {
            continue; // lobe tail: its peak carries it
        }
        let offset = if left > 0.0 && right > 0.0 {
            let (a, b, c) = (left.ln(), energy.ln(), right.ln());
            let curve = a - 2.0 * b + c;
            if curve < 0.0 {
                (0.5 * (a - c) / curve).clamp(-0.5, 0.5)
            } else {
                0.0
            }
        } else {
            0.0
        };
        let peak_hz = (bin as f64 + offset) * bin_hz;
        if peak_hz > 0.0 {
            classes[class_of(peak_hz)] += left.sqrt() + energy.sqrt() + right.sqrt();
        }
    }
    let total: f64 = classes.iter().sum();
    if total > 0.0 {
        for value in &mut classes {
            *value /= total;
        }
    }
    classes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stft;

    fn tone(sr: u32, seconds: f64, freq: f64) -> Vec<f32> {
        (0..(seconds * sr as f64) as usize)
            .map(|i| {
                (0.5 * (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin()) as f32
            })
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
    fn bass_notes_land_on_their_own_class() {
        // Below ~362 Hz a 21.5 Hz bin is wider than a semitone, so folding
        // each bin by its centre frequency put A1 (55 Hz) on F and E2 on F:
        // 24 of these 36 notes came out on the wrong class.
        let mut wrong = Vec::new();
        for midi in 28..=63 {
            let freq = A4_HZ * 2f64.powf((midi as f64 - 69.0) / 12.0);
            let mean = mean_chroma(&tone(44_100, 2.0, freq), 44_100);
            let top = mean
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(c, _)| c)
                .unwrap();
            if top != (midi % 12) as usize {
                wrong.push((midi, top));
            }
        }
        assert!(
            wrong.is_empty(),
            "notes on the wrong class (midi, got): {wrong:?}"
        );
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
