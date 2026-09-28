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
use realfft::num_complex::Complex;
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
    map_frame_range(y, n_fft, hop, 0..frame_count(y.len(), hop), reduce)
}

/// [`map_frames`] over the frames in `frames` only: the same spectra the
/// whole-track transform has there, edges and padding included, for a
/// caller that reads a few frames around one moment.
pub fn map_frame_range<T, F>(
    y: &[f32],
    n_fft: usize,
    hop: usize,
    frames: std::ops::Range<usize>,
    reduce: F,
) -> Vec<T>
where
    T: Send,
    F: Fn(&[f64]) -> T + Sync,
{
    let pad = n_fft / 2;
    let window = hann_periodic(n_fft);
    let bins = n_fft / 2 + 1;

    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);

    frames
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
                // the signal is librosa's constant zero padding: the first
                // frames start in the left pad, the last few end in the right
                // one. None reads past it, since the last starts at
                // `(len / hop) * hop <= len`.
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

/// Complex STFT frames `frames` of `y`: exactly the spectra
/// [`map_frame_range`] reduces, kept before the magnitude is taken.
///
/// Phase is what an inverse transform needs, and a mask applied to these and
/// sent through [`istft`] gives back a signal rather than a picture. Held
/// whole, so this is for the few frames around a moment; a track's worth is
/// the gigabyte [`power_spectrogram`] warns about.
pub fn complex_frame_range(
    y: &[f32],
    n_fft: usize,
    hop: usize,
    frames: std::ops::Range<usize>,
) -> Vec<Vec<Complex<f64>>> {
    let pad = n_fft / 2;
    let window = hann_periodic(n_fft);
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);
    frames
        .into_par_iter()
        .map_init(
            || (fft.make_input_vec(), fft.make_output_vec()),
            |(input, output), frame| {
                let start = frame * hop;
                for (i, slot) in input.iter_mut().enumerate() {
                    let sample = (start + i)
                        .checked_sub(pad)
                        .and_then(|s| y.get(s))
                        .map_or(0.0, |&v| v as f64);
                    *slot = sample * window[i];
                }
                fft.process(input, output).expect("fft sizes are fixed");
                output.clone()
            },
        )
        .collect()
}

/// Overlap-add `frames` back into samples, the inverse of
/// [`complex_frame_range`].
///
/// `first` is the frame index the first row came from, and the result runs
/// from signal sample `first * hop - n_fft / 2` for `len` samples. Each frame
/// is windowed again on the way out and the sum is divided by the summed
/// window squares, which is what makes a Hann analysis window at this hop
/// reconstruct rather than modulate. Where no frame covers a sample — outside
/// the range, or at the very edges — the divisor is zero and the sample comes
/// back zero, said plainly rather than amplified by a floor.
pub fn istft(
    frames: &[Vec<Complex<f64>>],
    n_fft: usize,
    hop: usize,
    first: usize,
    len: usize,
) -> Vec<f32> {
    let pad = n_fft / 2;
    let window = hann_periodic(n_fft);
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_inverse(n_fft);
    let mut out = vec![0.0f64; len];
    let mut weight = vec![0.0f64; len];
    let mut spectrum = fft.make_input_vec();
    let mut samples = fft.make_output_vec();
    let start_sample = (first * hop) as i64 - pad as i64;
    for (row, frame) in frames.iter().enumerate() {
        if frame.len() != spectrum.len() {
            continue;
        }
        spectrum.copy_from_slice(frame);
        if fft.process(&mut spectrum, &mut samples).is_err() {
            continue;
        }
        let at = start_sample + (row * hop) as i64;
        for (i, (&sample, &w)) in samples.iter().zip(window.iter()).enumerate() {
            let index = at + i as i64;
            if index < 0 {
                continue;
            }
            let index = index as usize;
            if index >= len {
                break;
            }
            // realfft's inverse is unnormalised: dividing by n_fft here is
            // what makes a round trip give the samples back.
            out[index] += sample / n_fft as f64 * w;
            weight[index] += w * w;
        }
    }
    out.iter()
        .zip(weight.iter())
        .map(|(&v, &w)| if w > 1e-9 { (v / w) as f32 } else { 0.0 })
        .collect()
}

/// [`istft`] into buffers the caller owns, so a track can be rebuilt a block
/// at a time: each call adds its frames' contribution to `out` and their
/// squared window to `weight`, and the caller divides once at the end. A
/// per-block divide would leave a seam at every boundary, since the frames
/// either side of one share the samples between them.
pub fn istft_into(
    frames: &[Vec<Complex<f64>>],
    n_fft: usize,
    hop: usize,
    first: usize,
    out: &mut [f64],
    weight: &mut [f64],
) {
    let pad = n_fft / 2;
    let window = hann_periodic(n_fft);
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_inverse(n_fft);
    let mut spectrum = fft.make_input_vec();
    let mut samples = fft.make_output_vec();
    let start_sample = (first * hop) as i64 - pad as i64;
    for (row, frame) in frames.iter().enumerate() {
        if frame.len() != spectrum.len() {
            continue;
        }
        spectrum.copy_from_slice(frame);
        if fft.process(&mut spectrum, &mut samples).is_err() {
            continue;
        }
        let at = start_sample + (row * hop) as i64;
        for (i, (&sample, &w)) in samples.iter().zip(window.iter()).enumerate() {
            let index = at + i as i64;
            if index < 0 {
                continue;
            }
            let index = index as usize;
            if index >= out.len() {
                break;
            }
            out[index] += sample / n_fft as f64 * w;
            weight[index] += w * w;
        }
    }
}

/// Finish an overlap-add: `out` divided by `weight`, zero where nothing
/// covered the sample.
pub fn overlap_finish(out: &[f64], weight: &[f64]) -> Vec<f32> {
    out.iter()
        .zip(weight.iter())
        .map(|(&v, &w)| if w > 1e-9 { (v / w) as f32 } else { 0.0 })
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
    fn a_signal_survives_the_round_trip_through_its_frames() {
        // Analysis, then synthesis, with nothing done in between: the samples
        // come back. Everything the percussive features do sits between those
        // two, so this is the check that the pair is a pair.
        let sr = 44_100.0;
        let y: Vec<f32> = (0..8192)
            .map(|i| {
                let t = i as f64 / sr;
                (0.6 * (std::f64::consts::TAU * 220.0 * t).sin()
                    + 0.3 * (std::f64::consts::TAU * 1310.0 * t).sin()) as f32
            })
            .collect();
        let (n_fft, hop) = (2048, 128);
        let frames = frame_count(y.len(), hop);
        let spectra = complex_frame_range(&y, n_fft, hop, 0..frames);
        let back = istft(&spectra, n_fft, hop, 0, y.len());
        // The first and last half-window are covered by fewer frames; inside,
        // the reconstruction is the signal.
        let edge = n_fft;
        let worst = y[edge..y.len() - edge]
            .iter()
            .zip(&back[edge..y.len() - edge])
            .map(|(&a, &b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-4, "worst sample differs by {worst}");
    }

    #[test]
    fn a_frame_range_comes_back_where_it_was_taken_from() {
        let y: Vec<f32> = (0..4096).map(|i| ((i % 97) as f32 / 97.0) - 0.5).collect();
        let (n_fft, hop) = (512, 128);
        // Frames 8..24 cover signal samples 8*128 - 256 .. 24*128 + 256.
        let spectra = complex_frame_range(&y, n_fft, hop, 8..24);
        let from = 8 * hop - n_fft / 2;
        let back = istft(&spectra, n_fft, hop, 8, y.len());
        let inside = from + n_fft..(24 * hop) - n_fft / 2;
        let worst = inside
            .clone()
            .map(|i| (y[i] - back[i]).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-4, "worst sample differs by {worst}");
        // Outside the frames it says zero rather than guessing.
        assert_eq!(back[0], 0.0);
        assert_eq!(back[y.len() - 1], 0.0);
    }

    #[test]
    fn silence_and_an_empty_range_are_not_special_cases() {
        assert!(istft(&[], 512, 128, 0, 64).iter().all(|&v| v == 0.0));
        let quiet = vec![0.0f32; 2048];
        let spectra = complex_frame_range(&quiet, 512, 128, 0..4);
        assert!(istft(&spectra, 512, 128, 0, quiet.len())
            .iter()
            .all(|&v| v.abs() < 1e-9));
    }

    #[test]
    fn frames_read_the_padding_exactly_as_a_padded_copy() {
        // The implementation map_frames replaced: an explicit zero-padded
        // f64 copy of the whole signal. The copy is indexed directly: the
        // last frame starts at `(len / hop) * hop <= len` and so ends inside
        // the right-hand padding, even at a length that is not a multiple
        // of the hop (10,001 here: frame 78 ends at 12,031 of 12,049).
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
                *slot = padded[frame * hop + i] * window[i];
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
