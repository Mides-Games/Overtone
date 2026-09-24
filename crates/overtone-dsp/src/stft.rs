//! Short-time Fourier transform matching `librosa.stft` for the parameters the
//! onset envelope uses.
//!
//! The details that matter, all librosa defaults that v3 never names:
//! periodic Hann (`fftbins=True`, so the denominator is `N`, not `N - 1`),
//! `center=True` with `pad_mode="constant"` — the signal is zero-padded by
//! `n_fft / 2` on both sides — and `win_length = n_fft`, which makes librosa's
//! `pad_center` a no-op.
//!
//! Frame count follows from the padding: `1 + len(y) / hop`.

use rayon::prelude::*;
use realfft::RealFftPlanner;

use crate::mel::MelBank;

/// Periodic Hann window, as `scipy.signal.get_window("hann", n, fftbins=True)`
/// produces it. The symmetric variant (denominator `n - 1`) is a different
/// window and would change every magnitude slightly.
pub fn hann_periodic(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos())
        .collect()
}

/// Number of frames `librosa.stft(center=True)` produces.
#[inline]
pub fn frame_count(len: usize, hop: usize) -> usize {
    1 + len / hop
}

/// Each frame's power spectrum `|STFT|^2`, handed to `reduce` as soon as it
/// is computed; the reductions come back in frame order.
///
/// This is how a whole track is analysed without holding its linear
/// spectrogram. A 6-minute track at hop 128 is ~124k frames, and
/// `124k x 1025` f64 bins is over a gigabyte -- more than ten on a
/// one-hour mix. A reduction keeps what its consumer needs (128 mel bands,
/// 12 chroma classes, 7 band energies), and one frame's spectrum stays in
/// cache. The zero padding is read through the index, not copied: a padded
/// f64 copy of the signal was another 127 MB at six minutes.
pub fn map_frames<T, F>(y: &[f32], n_fft: usize, hop: usize, reduce: F) -> Vec<T>
where
    T: Send,
    F: Fn(&[f64]) -> T + Sync,
{
    let frames = frame_count(y.len(), hop);
    let pad = n_fft / 2;
    let window = hann_periodic(n_fft);
    let bins = n_fft / 2 + 1;

    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);

    (0..frames)
        .into_par_iter()
        .map_init(
            || {
                (
                    fft.make_input_vec(),
                    fft.make_output_vec(),
                    vec![0.0f64; bins],
                )
            },
            |(input, output, power), frame| {
                // Frame `frame` reads padded samples `frame * hop ..` on, that
                // is signal samples from `frame * hop - n_fft / 2`. Outside
                // the signal is librosa's constant zero padding, including
                // past the end on the last few frames.
                let start = frame * hop;
                for (i, slot) in input.iter_mut().enumerate() {
                    let sample = (start + i)
                        .checked_sub(pad)
                        .and_then(|s| y.get(s))
                        .map_or(0.0, |&v| v as f64);
                    *slot = sample * window[i];
                }
                fft.process(input, output).expect("fft sizes are fixed");
                for (slot, value) in power.iter_mut().zip(output.iter()) {
                    *slot = value.re * value.re + value.im * value.im;
                }
                reduce(power)
            },
        )
        .collect()
}

/// Power spectrogram `|STFT|^2`, frames along the outer axis.
///
/// Returns `frames` rows of `n_fft / 2 + 1` bins, which is over a gigabyte
/// for a 6-minute track at hop 128. For short excerpts and tests; a
/// whole-track analysis reduces each frame through [`map_frames`] instead.
pub fn power_spectrogram(y: &[f32], n_fft: usize, hop: usize) -> Vec<Vec<f64>> {
    map_frames(y, n_fft, hop, <[f64]>::to_vec)
}

/// Mel power spectrogram, projected frame by frame so the linear spectrogram
/// is never materialised: `124k x 128` bins for six minutes, about 127 MB.
pub fn mel_power_spectrogram(y: &[f32], n_fft: usize, hop: usize, bank: &MelBank) -> Vec<Vec<f64>> {
    let n_mels = bank.len();
    map_frames(y, n_fft, hop, |power| {
        let mut row = vec![0.0f64; n_mels];
        bank.project(power, &mut row);
        row
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_read_the_padding_exactly_as_a_padded_copy() {
        // The implementation map_frames replaced: an explicit zero-padded
        // f64 copy of the whole signal. A length that is not a multiple of
        // the hop runs the last frames past the end of the padding too.
        let y: Vec<f32> = (0..10_001)
            .map(|i| ((i as f64 * 0.37).sin() * 0.8 + (i as f64 * 0.011).cos() * 0.1) as f32)
            .collect();
        let (n_fft, hop) = (2048, 128);
        let pad = n_fft / 2;
        let mut padded = vec![0.0f64; y.len() + 2 * pad];
        for (dst, &src) in padded[pad..pad + y.len()].iter_mut().zip(&y) {
            *dst = src as f64;
        }
        let window = hann_periodic(n_fft);
        let fft = RealFftPlanner::<f64>::new().plan_fft_forward(n_fft);
        let (mut input, mut output) = (fft.make_input_vec(), fft.make_output_vec());
        let got = power_spectrogram(&y, n_fft, hop);
        assert_eq!(got.len(), frame_count(y.len(), hop));
        for (frame, row) in got.iter().enumerate() {
            for (i, slot) in input.iter_mut().enumerate() {
                *slot = padded.get(frame * hop + i).copied().unwrap_or(0.0) * window[i];
            }
            fft.process(&mut input, &mut output).unwrap();
            let want: Vec<f64> = output.iter().map(|c| c.re * c.re + c.im * c.im).collect();
            assert_eq!(row, &want, "frame {frame}");
        }
    }

    #[test]
    fn hann_is_periodic_not_symmetric() {
        let w = hann_periodic(8);
        // Periodic: w[0] == 0 and no second zero at the end (w[7] != 0).
        assert!((w[0] - 0.0).abs() < 1e-12);
        assert!(w[7] > 0.0, "symmetric window would end at 0");
        // Symmetric hann(8) would have w[4] == 1.0; periodic peaks at w[4] too
        // but the shoulders differ. Check a known value: w[2] = 0.5.
        assert!((w[2] - 0.5).abs() < 1e-12);
    }

    #[test]
    fn frame_count_matches_librosa_centred_padding() {
        assert_eq!(frame_count(0, 128), 1);
        assert_eq!(frame_count(128, 128), 2);
        assert_eq!(frame_count(44_100, 128), 1 + 344);
    }

    #[test]
    fn a_pure_tone_lands_in_one_bin() {
        let sr = 44_100.0;
        let freq = sr * 64.0 / 2048.0; // exactly bin 64
        let y: Vec<f32> = (0..8192)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32)
            .collect();
        let spec = power_spectrogram(&y, 2048, 128);
        // Pick a frame well inside the signal so the padding does not leak.
        let row = &spec[20];
        let peak = row
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        assert_eq!(peak, 64);
    }

    #[test]
    fn silence_is_silent() {
        let spec = power_spectrogram(&vec![0.0f32; 4096], 2048, 128);
        assert!(spec.iter().flatten().all(|&v| v == 0.0));
    }
}
