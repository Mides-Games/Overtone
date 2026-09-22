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

/// Power spectrogram `|STFT|^2`, frames along the outer axis.
///
/// Returns `frames` rows of `n_fft / 2 + 1` bins. Row-major by frame because
/// every consumer walks frames in order, and because it makes the rayon split
/// trivial.
pub fn power_spectrogram(y: &[f32], n_fft: usize, hop: usize) -> Vec<Vec<f64>> {
    let frames = frame_count(y.len(), hop);
    let pad = n_fft / 2;
    let window = hann_periodic(n_fft);
    let bins = n_fft / 2 + 1;

    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);

    // Explicit zero padding rather than index arithmetic at the edges: it is
    // the same cost once, and it removes a whole class of off-by-one bug from
    // the hot loop.
    let mut padded = vec![0.0f64; y.len() + 2 * pad];
    for (dst, &src) in padded[pad..pad + y.len()].iter_mut().zip(y) {
        *dst = src as f64;
    }

    (0..frames)
        .into_par_iter()
        .map_init(
            || (fft.make_input_vec(), fft.make_output_vec()),
            |(input, output), frame| {
                let start = frame * hop;
                for (i, slot) in input.iter_mut().enumerate() {
                    // A frame can run past the padded end on the last few
                    // frames; librosa pads there too.
                    *slot = padded.get(start + i).copied().unwrap_or(0.0) * window[i];
                }
                fft.process(input, output).expect("fft sizes are fixed");
                let mut row = vec![0.0f64; bins];
                for (slot, value) in row.iter_mut().zip(output.iter()) {
                    *slot = value.re * value.re + value.im * value.im;
                }
                row
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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

/// Mel power spectrogram, computed one frame at a time so the linear
/// spectrogram is never materialised.
///
/// This matters for memory, not just speed: a 6-minute track at hop 128 is
/// ~124k frames, and holding `124k x 1025` f64 bins is over a gigabyte. The
/// mel result is `124k x 128`, about 127 MB, and the FFT output for a single
/// frame stays in cache.
pub fn mel_power_spectrogram(y: &[f32], n_fft: usize, hop: usize, bank: &MelBank) -> Vec<Vec<f64>> {
    let frames = frame_count(y.len(), hop);
    let pad = n_fft / 2;
    let window = hann_periodic(n_fft);
    let bins = n_fft / 2 + 1;
    let n_mels = bank.len();

    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);

    let mut padded = vec![0.0f64; y.len() + 2 * pad];
    for (dst, &src) in padded[pad..pad + y.len()].iter_mut().zip(y) {
        *dst = src as f64;
    }

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
                let start = frame * hop;
                for (i, slot) in input.iter_mut().enumerate() {
                    *slot = padded.get(start + i).copied().unwrap_or(0.0) * window[i];
                }
                fft.process(input, output).expect("fft sizes are fixed");
                for (slot, value) in power.iter_mut().zip(output.iter()) {
                    *slot = value.re * value.re + value.im * value.im;
                }
                let mut row = vec![0.0f64; n_mels];
                bank.project(power, &mut row);
                row
            },
        )
        .collect()
}
