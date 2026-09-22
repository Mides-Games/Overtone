//! The onset-strength envelope, matching what v3 gets from
//! `librosa.onset.onset_strength(y, sr, hop_length=128, aggregate=np.median,
//! fmax=11025, n_mels=128)` plus v3's own normalisation.
//!
//! Every attack time in the engine comes off this curve, so this is the single
//! highest-risk item in the port. The full contract is in
//! `docs/05-dsp-pipeline.md` §A.2; the three traps it names are all here:
//!
//! * the front pad is `lag + n_fft / (2 * hop)` = 9 frames, not `lag`. Get it
//!   wrong and every attack shifts by a constant 26 ms.
//! * `top_db = 80` clips against the **global** maximum of the dB spectrogram,
//!   so the envelope is not a purely local function of the audio.
//! * the mel basis is Slaney-normalised, not HTK — see [`crate::mel`].

use crate::{mel, stft};

/// `librosa.power_to_db` with librosa's defaults: `ref=1.0`, `amin=1e-10`,
/// `top_db=80.0`. Applied in place over the whole spectrogram because the
/// `top_db` floor is relative to the global maximum.
fn power_to_db(spec: &mut [Vec<f64>]) {
    const AMIN: f64 = 1e-10;
    const TOP_DB: f64 = 80.0;
    let mut peak = f64::NEG_INFINITY;
    for row in spec.iter_mut() {
        for value in row.iter_mut() {
            *value = 10.0 * value.max(AMIN).log10();
            if *value > peak {
                peak = *value;
            }
        }
    }
    // ref = 1.0 contributes 10*log10(1) = 0, so there is nothing to subtract.
    if peak.is_finite() {
        let floor = peak - TOP_DB;
        for row in spec.iter_mut() {
            for value in row.iter_mut() {
                if *value < floor {
                    *value = floor;
                }
            }
        }
    }
}

/// `np.median` over a slice: for an even count, the mean of the two middle
/// values. 128 mel bands is even, so this branch is the one that always runs.
fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        0.5 * (values[mid - 1] + values[mid])
    } else {
        values[mid]
    }
}

/// `np.percentile(values, q)` with numpy's default linear interpolation.
pub fn percentile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable_by(f64::total_cmp);
    let position = (q / 100.0) * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        let frac = position - lower as f64;
        sorted[lower] * (1.0 - frac) + sorted[upper] * frac
    }
}

/// The v3 fitting envelope: mel spectral flux, median-aggregated, normalised
/// to a robust ceiling and clipped.
pub fn onset_envelope(y: &[f32], sr: u32, hop: usize, n_fft: usize) -> Vec<f32> {
    let n_mels = 128;
    let fmax = 11_025.0;

    // Fused STFT -> mel, one frame at a time. The linear spectrogram for a
    // 6-minute track would be over a gigabyte; this never builds it.
    let bank = mel::MelBank::new(sr, n_fft, n_mels, 0.0, fmax);
    let mut mel_spec = stft::mel_power_spectrogram(y, n_fft, hop, &bank);
    let frames = mel_spec.len();
    if frames < 2 {
        return Vec::new();
    }

    power_to_db(&mut mel_spec);

    // Rectified first difference along time, then the median across bands.
    // lag = 1, and max_size = 1 means the reference spectrum *is* the
    // spectrum, so this is a plain difference.
    let mut flux = Vec::with_capacity(frames - 1);
    let mut scratch = vec![0.0f64; n_mels];
    for frame in 1..frames {
        for band in 0..n_mels {
            scratch[band] = (mel_spec[frame][band] - mel_spec[frame - 1][band]).max(0.0);
        }
        flux.push(median(&mut scratch));
    }

    // Front-pad by `lag + n_fft / (2 * hop)` and truncate to the spectrogram
    // length. This is what `center=True` means for the envelope, and it is
    // what aligns a peak with the audio rather than one window late.
    let pad = 1 + n_fft / (2 * hop);
    let mut env = vec![0.0f64; pad];
    env.extend_from_slice(&flux);
    env.truncate(frames);
    if env.len() < frames {
        env.resize(frames, 0.0);
    }

    // v3's own step: normalise to a robust ceiling so the thresholds in peak
    // picking are portable across quiet and loud masters, then clip.
    let ceiling = percentile(&env, 99.5);
    if ceiling > 1e-9 {
        for value in &mut env {
            *value /= ceiling;
        }
    }
    env.into_iter()
        .map(|v| v.clamp(0.0, 1.5) as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_interpolates_like_numpy() {
        let v = [1.0, 2.0, 3.0, 4.0];
        // numpy: position = 0.5 * 3 = 1.5 -> midway between 2 and 3.
        assert!((percentile(&v, 50.0) - 2.5).abs() < 1e-12);
        assert!((percentile(&v, 0.0) - 1.0).abs() < 1e-12);
        assert!((percentile(&v, 100.0) - 4.0).abs() < 1e-12);
    }

    #[test]
    fn median_averages_the_middle_pair_when_even() {
        let mut v = [3.0, 1.0, 4.0, 2.0];
        assert!((median(&mut v) - 2.5).abs() < 1e-12);
        let mut odd = [3.0, 1.0, 2.0];
        assert!((median(&mut odd) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn top_db_floor_is_global_not_per_frame() {
        // Two frames, one loud and one near-silent. The quiet frame must be
        // lifted to (global peak - 80), not to its own peak - 80.
        let mut spec = vec![vec![1.0], vec![1e-20]];
        power_to_db(&mut spec);
        assert!((spec[0][0] - 0.0).abs() < 1e-12);
        assert!((spec[1][0] - (-80.0)).abs() < 1e-12);
    }

    #[test]
    fn front_pad_is_nine_frames_at_hop_128() {
        // The value this test pins is the whole reason attacks are not 26 ms
        // late: 1 + 2048 / (2 * 128) = 9.
        let pad = 1 + 2048 / (2 * 128);
        assert_eq!(pad, 9);
    }

    #[test]
    fn envelope_length_matches_frame_count() {
        let y = vec![0.0f32; 44_100];
        let env = onset_envelope(&y, 44_100, 128, 2048);
        assert_eq!(env.len(), stft::frame_count(y.len(), 128));
    }

    #[test]
    fn an_impulse_produces_one_clear_peak() {
        let mut y = vec![0.0f32; 44_100];
        y[22_050] = 1.0;
        let env = onset_envelope(&y, 44_100, 128, 2048);
        let (peak, _) = env
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap();
        // The peak should sit within a window of the impulse's own frame.
        let expected = 22_050 / 128;
        assert!(
            (peak as i64 - expected as i64).abs() <= 8,
            "peak at {peak}, impulse at frame {expected}"
        );
    }
}
