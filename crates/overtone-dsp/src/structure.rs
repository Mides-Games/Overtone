//! Musical structure: novelty curve, phrase boundaries, energy map.
//!
//! Harmony (chroma) and dynamics (windowed RMS) sampled every half second,
//! cosine self-similarity between windows, and a Foote checkerboard kernel
//! along the diagonal: where the future stops resembling the past, the
//! novelty curve peaks, and peaks are phrase boundaries. The energy map
//! rides alongside — verse/chorus contrast that harmony alone cannot see.
//!
//! Two deliberate scope cuts, both recorded rather than hidden. Downbeat
//! snapping belongs to the tempo layer, which owns grids; this crate is
//! tempoless, so boundaries sit on the 0.5 s feature grid. And timbre
//! (MFCC) does not enter the similarity: harmony plus dynamics segment
//! phrases, timbre labels them — that labelling is section classification,
//! a separate row.

use crate::{chroma, stft};

/// Feature hop in seconds. Half a second resolves 12 s phrases with room
/// to spare and keeps the similarity matrix small (a 6-minute track is
/// 720 windows, half a million cosine pairs).
pub const WIN_S: f64 = 0.5;
/// Checkerboard half-size in windows. Eight windows (4 s) each side sees a
/// full phrase neighbourhood without reaching past short sections.
pub const KERNEL_HALF: usize = 8;
/// Novelty peaks below this fraction of the global maximum are texture,
/// not structure.
pub const PEAK_FRACTION: f64 = 0.30;
/// Peaks closer than this merge into the stronger one. Four seconds is
/// below any phrase worth a red line and above any straddle wobble.
pub const MERGE_S: f64 = 4.0;

/// Phrase boundaries in seconds, plus the RMS energy map behind them.
#[derive(Debug, Clone)]
pub struct Structure {
    pub boundaries: Vec<f64>,
    pub energy: Vec<f64>,
    pub energy_hop: f64,
}

/// Segment audio into phrases. Empty on silence or inputs shorter than two
/// kernel widths.
pub fn analyze(y: &[f32], sr: u32) -> Structure {
    let hop = (WIN_S * sr as f64).round() as usize;
    let n_fft = 2048;
    let spec = stft::power_spectrogram(y, n_fft, 128);
    let chroma = chroma::chroma(&spec, sr, n_fft);
    // STFT frames (128 hop) grouped into WIN_S windows.
    let per = ((WIN_S * sr as f64) / 128.0).round() as usize;
    // Windows, not STFT frames: the loop below indexes feature windows, so
    // a short track must bow out here rather than panic there.
    if per == 0 || y.len().div_ceil(hop.max(1)) < 2 * KERNEL_HALF + 1 {
        return Structure {
            boundaries: Vec::new(),
            energy: Vec::new(),
            energy_hop: WIN_S,
        };
    }

    // Per-window features: mean chroma plus normalised log energy. The
    // energy term is what segments verse from chorus when the chords match.
    let mut peak_rms = 1e-9f64;
    let mut rms = Vec::new();
    let mut start = 0usize;
    while start < y.len() {
        let end = (start + hop).min(y.len());
        let energy: f64 = y[start..end]
            .iter()
            .map(|&v| (v as f64).powi(2))
            .sum::<f64>()
            / (end - start).max(1) as f64;
        peak_rms = peak_rms.max(energy.sqrt());
        rms.push(energy.sqrt());
        start = end;
    }
    let windows = rms.len();
    let mut features: Vec<Vec<f64>> = Vec::with_capacity(windows);
    for (w, &window_rms) in rms.iter().enumerate() {
        let lo = (w * per).min(chroma.len());
        let hi = ((w + 1) * per).min(chroma.len());
        let mut mean = [0.0f64; 12];
        if hi > lo {
            for frame in &chroma[lo..hi] {
                for (c, acc) in mean.iter_mut().enumerate() {
                    *acc += frame[c];
                }
            }
            let n = (hi - lo) as f64;
            for acc in mean.iter_mut() {
                *acc /= n;
            }
        }
        // Log-energy beside the chroma: 0 at silence, 1 at full scale,
        // logarithmic in between, so verse/chorus contrast survives next
        // to pitch content without drowning it. ln(1e-9) = -20.723.
        let r = (window_rms / peak_rms).clamp(0.0, 1.0);
        let mut vec = mean.to_vec();
        vec.push((1.0 + r.max(1e-9).ln() / 20.723).clamp(0.0, 1.0));
        features.push(vec);
    }

    // Cosine self-similarity.
    let norms: Vec<f64> = features
        .iter()
        .map(|v| v.iter().map(|&x| x * x).sum::<f64>().sqrt())
        .collect();
    let sim = |a: usize, b: usize| -> f64 {
        if norms[a] <= 0.0 || norms[b] <= 0.0 {
            return 0.0;
        }
        features[a]
            .iter()
            .zip(features[b].iter())
            .map(|(&x, &y)| x * y)
            .sum::<f64>()
            / (norms[a] * norms[b])
    };

    // Foote novelty: homogeneity within past/future minus across. The
    // early return above guarantees windows >= 2*K+1, so every index below
    // is in range — no saturating arithmetic needed here.
    let mut novelty = vec![0.0f64; windows];
    for (i, slot) in novelty
        .iter_mut()
        .enumerate()
        .take(windows - KERNEL_HALF)
        .skip(KERNEL_HALF)
    {
        let (mut within, mut across) = (0.0, 0.0);
        let (mut n_within, mut n_across) = (0usize, 0usize);
        for a in i - KERNEL_HALF..i {
            for b in i - KERNEL_HALF..i {
                within += sim(a, b);
                n_within += 1;
            }
            for b in i..i + KERNEL_HALF {
                across += sim(a, b);
                n_across += 1;
            }
        }
        for a in i..i + KERNEL_HALF {
            for b in i..i + KERNEL_HALF {
                within += sim(a, b);
                n_within += 1;
            }
        }
        *slot = within / n_within.max(1) as f64 - across / n_across.max(1) as f64;
    }

    // Peak-pick, threshold relative to the global max, merge neighbours.
    let peak = novelty.iter().copied().fold(0.0f64, f64::max);
    let mut found: Vec<usize> = if peak > 1e-9 {
        crate::peaks::find_peaks(&novelty, 2, None, Some(PEAK_FRACTION * peak))
    } else {
        Vec::new()
    };
    found.sort_unstable();
    let mut merged: Vec<usize> = Vec::new();
    let merge_win = (MERGE_S / WIN_S).round() as usize;
    for i in found {
        if let Some(&last) = merged.last() {
            if i - last < merge_win {
                if novelty[i] > novelty[last] {
                    merged.pop();
                } else {
                    continue;
                }
            }
        }
        merged.push(i);
    }
    // The track start is a boundary only if the music starts there; a
    // leading silence is not a phrase. Drop index-0 artefacts.
    merged.retain(|&i| i > 1);
    Structure {
        boundaries: merged.iter().map(|&i| i as f64 * WIN_S).collect(),
        energy: rms,
        energy_hop: WIN_S,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sustained triad with a short attack, peak-normalised with the track.
    fn chord(sr: u32, root: f64, major: bool, amp: f64, seconds: f64) -> Vec<f32> {
        let third = root * if major { 1.2599 } else { 1.1892 };
        let fifth = root * 1.4983;
        let n = (seconds * sr as f64) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / sr as f64;
                let attack = 0.5 - 0.5 * (std::f64::consts::PI * (t / 0.1).min(1.0)).cos();
                (amp * attack
                    * ((2.0 * std::f64::consts::PI * root * t).sin()
                        + 0.6 * (2.0 * std::f64::consts::PI * third * t).sin()
                        + 0.6 * (2.0 * std::f64::consts::PI * fifth * t).sin()
                        + 0.3 * (2.0 * std::f64::consts::PI * root * 2.0 * t).sin()))
                    as f32
            })
            .collect()
    }

    fn concat(parts: &[Vec<f32>]) -> Vec<f32> {
        let mut out = Vec::new();
        for part in parts {
            out.extend_from_slice(part);
        }
        let peak = out.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        out.iter().map(|v| v / peak * 0.99).collect()
    }

    /// ABAB, 16 s phrases: quiet Am vs loud F major. Truth at 16/32/48.
    fn abab(sr: u32) -> (Vec<f32>, Vec<f64>) {
        let a = chord(sr, 220.0, false, 0.25, 16.0);
        let b = chord(sr, 174.61, true, 0.6, 16.0);
        (
            concat(&[a.clone(), b.clone(), a, b]),
            vec![16.0, 32.0, 48.0],
        )
    }

    /// Same C-major chord throughout, dynamics alternate every 12 s over
    /// 48 s. Harmony contributes nothing here — the energy term alone must
    /// segment it. Truth at 12/24/36.
    fn dynamics_only(sr: u32) -> (Vec<f32>, Vec<f64>) {
        let quiet = chord(sr, 261.63, true, 0.22, 12.0);
        let loud = chord(sr, 261.63, true, 0.6, 12.0);
        (
            concat(&[quiet.clone(), loud.clone(), quiet, loud]),
            vec![12.0, 24.0, 36.0],
        )
    }

    fn check_boundaries(found: &[f64], truth: &[f64]) {
        assert_eq!(
            found.len(),
            truth.len(),
            "expected {} boundaries, got {found:?}",
            truth.len()
        );
        for (f, t) in found.iter().zip(truth.iter()) {
            assert!(
                (f - t).abs() <= 1.5,
                "boundary {f:.2}s vs truth {t:.2}s in {found:?}"
            );
        }
    }

    #[test]
    fn abab_segments_by_harmony_and_dynamics() {
        let (y, truth) = abab(44_100);
        let structure = analyze(&y, 44_100);
        check_boundaries(&structure.boundaries, &truth);
    }

    #[test]
    fn dynamics_alone_still_segments() {
        let (y, truth) = dynamics_only(44_100);
        let structure = analyze(&y, 44_100);
        check_boundaries(&structure.boundaries, &truth);
    }

    #[test]
    fn energy_map_follows_loudness() {
        let (y, _) = abab(44_100);
        let structure = analyze(&y, 44_100);
        // Windows 4..28 sit inside the quiet A (16 s at 0.5 s hops, past the
        // attack); windows 36..60 inside the loud B.
        let quiet: f64 = structure.energy[8..32].iter().sum::<f64>() / 24.0;
        let loud: f64 = structure.energy[36..60].iter().sum::<f64>() / 24.0;
        assert!(loud > 2.0 * quiet, "loud {loud:.4} vs quiet {quiet:.4}");
    }

    #[test]
    fn silence_has_no_structure() {
        let structure = analyze(&vec![0.0f32; 44_100 * 10], 44_100);
        assert!(structure.boundaries.is_empty());
    }

    #[test]
    fn short_audio_bows_out_instead_of_panicking() {
        // Fewer windows than two kernel widths: the novelty loop would
        // index past the feature vector. Regression test from the audit.
        for seconds in [1, 3, 8] {
            let y = chord(44_100, 220.0, true, 0.4, seconds as f64);
            let structure = analyze(&y, 44_100);
            assert!(structure.boundaries.is_empty(), "{seconds}s");
        }
    }
}
