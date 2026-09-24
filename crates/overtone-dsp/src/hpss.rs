//! Harmonic/percussive source separation (Fitzgerald): median filtering.
//!
//! A sustained partial is a horizontal line on the spectrogram — a median
//! filter along time keeps it and erases transients. A click is a vertical
//! line — a median filter along frequency keeps it and erases partials.
//! Soft Wiener masks (`power = 2`) split each bin between the two, so the
//! decomposition is conservative by construction: H + P == S everywhere.
//!
//! The hitsound engine wants harmonic, percussive *and* residual; the
//! residual needs margin design this step deliberately skips (a complementary
//! mask pair leaves nothing over). Two-way now, residual open.

use rayon::prelude::*;

use crate::stft;

/// Median kernel along time, in frames. 33 frames at hop 128 is ~96 ms. A
/// transient is smeared across the 16 hops of the 2048-sample window, so
/// the kernel must be more than twice that for the smear to stay a minority
/// that cannot become the median. At 17 it barely exceeded the window, and
/// isolated hits read as sustained: a 2 ms click 0.885 percussive, a
/// 40 ms noise snare 0.55, a kick's body 0.12.
pub const KERNEL_TIME: usize = 33;
/// Median kernel along frequency, in bins. 17 bins at 2048-point FFT is
/// ~370 Hz: wide enough to erase a partial, narrow enough to keep formants.
pub const KERNEL_FREQ: usize = 17;

/// Harmonic and percussive power spectrograms, same shape as the input.
pub struct Separation {
    pub harmonic: Vec<Vec<f64>>,
    pub percussive: Vec<Vec<f64>>,
}

/// Separate with default kernels. The whole input is held several times
/// over, so this is for excerpts; a track is read through
/// [`separate_frames`].
pub fn separate(power: &[Vec<f64>]) -> Separation {
    separate_with(power, KERNEL_TIME, KERNEL_FREQ)
}

/// Separate with explicit odd kernels (even values are rounded up).
pub fn separate_with(power: &[Vec<f64>], kernel_time: usize, kernel_freq: usize) -> Separation {
    let frames = power.len();
    if frames == 0 {
        return Separation {
            harmonic: Vec::new(),
            percussive: Vec::new(),
        };
    }
    let bins = power[0].len();
    let kt = kernel_time | 1;
    let kf = kernel_freq | 1;

    let harm_med = median_axis_time(power, kt);
    let perc_med = median_axis_freq(power, kf);

    let mut harmonic = vec![vec![0.0; bins]; frames];
    let mut percussive = vec![vec![0.0; bins]; frames];
    for ((h_row, p_row), ((s_row, hm_row), pm_row)) in harmonic
        .iter_mut()
        .zip(percussive.iter_mut())
        .zip(power.iter().zip(harm_med.iter()).zip(perc_med.iter()))
    {
        for ((h, p), ((&s, &hm), &pm)) in h_row
            .iter_mut()
            .zip(p_row.iter_mut())
            .zip(s_row.iter().zip(hm_row.iter()).zip(pm_row.iter()))
        {
            // Wiener masks, power 2: conservative, H + P == S.
            let denom = (hm * hm + pm * pm).max(1e-12);
            *h = s * hm * hm / denom;
            *p = s * pm * pm / denom;
        }
    }
    Separation {
        harmonic,
        percussive,
    }
}

/// Harmonic and percussive power on STFT frames `frames` of `y` only,
/// exactly what [`separate`] of the whole track's spectrogram gives on
/// those frames. The frequency median and the masks are per frame; the time
/// median needs `KERNEL_TIME / 2` frames either side, so those are
/// transformed too and nothing else. Past either end of the track the
/// block stops where the track does, and the median clamps there as the
/// whole-track filter does.
///
/// The hitsound features read eight frames around each attack. A
/// whole-track separation held the linear spectrogram three times over
/// (input, harmonic, percussive, plus both medians): about 5 GB at six
/// minutes.
pub fn separate_frames(
    y: &[f32],
    n_fft: usize,
    hop: usize,
    frames: std::ops::Range<usize>,
) -> Separation {
    separate_frames_with(y, n_fft, hop, frames, KERNEL_TIME, KERNEL_FREQ)
}

/// [`separate_frames`] with explicit kernels.
pub fn separate_frames_with(
    y: &[f32],
    n_fft: usize,
    hop: usize,
    frames: std::ops::Range<usize>,
    kernel_time: usize,
    kernel_freq: usize,
) -> Separation {
    let total = stft::frame_count(y.len(), hop);
    let lo = frames.start.min(total);
    let hi = frames.end.min(total).max(lo);
    if hi == lo {
        return Separation {
            harmonic: Vec::new(),
            percussive: Vec::new(),
        };
    }
    let half = (kernel_time | 1) / 2;
    let (from, to) = (lo.saturating_sub(half), (hi + half).min(total));
    let block = stft::map_frame_range(y, n_fft, hop, from..to, <[f64]>::to_vec);
    let mut sep = separate_with(&block, kernel_time, kernel_freq);
    let keep = lo - from..hi - from;
    Separation {
        harmonic: sep.harmonic.drain(keep.clone()).collect(),
        percussive: sep.percussive.drain(keep).collect(),
    }
}

/// Median filter along the time axis, per bin. Edge-replicated: the window
/// clamps to the available frames rather than inventing zeros.
fn median_axis_time(power: &[Vec<f64>], kernel: usize) -> Vec<Vec<f64>> {
    let frames = power.len();
    let bins = power[0].len();
    let half = kernel / 2;
    (0..frames)
        .into_par_iter()
        .map(|f| {
            let mut row = vec![0.0; bins];
            let mut window = Vec::with_capacity(kernel);
            for (b, slot) in row.iter_mut().enumerate() {
                window.clear();
                for df in 0..kernel {
                    let ff = (f + df).saturating_sub(half).min(frames - 1);
                    window.push(power[ff][b]);
                }
                window.sort_unstable_by(f64::total_cmp);
                *slot = window[window.len() / 2];
            }
            row
        })
        .collect()
}

/// Median filter along the frequency axis, per frame.
fn median_axis_freq(power: &[Vec<f64>], kernel: usize) -> Vec<Vec<f64>> {
    let half = kernel / 2;
    power
        .par_iter()
        .map(|row| {
            let bins = row.len();
            let mut out = vec![0.0; bins];
            let mut window = Vec::with_capacity(kernel);
            for (b, slot) in out.iter_mut().enumerate() {
                window.clear();
                for dk in 0..kernel {
                    let kk = (b + dk).saturating_sub(half).min(bins - 1);
                    window.push(row[kk]);
                }
                window.sort_unstable_by(f64::total_cmp);
                *slot = window[window.len() / 2];
            }
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stft;

    /// Sustained 440 Hz sine under decaying 160 Hz clicks every 0.4 s.
    fn mix(sr: u32, duration: f64) -> Vec<f32> {
        let mut y = vec![0.0f32; (duration * sr as f64) as usize];
        for (i, slot) in y.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            *slot = (0.4 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32;
        }
        let mut t = 0.25;
        while t < duration - 0.1 {
            let start = (t * sr as f64) as usize;
            for i in 0..(0.04 * sr as f64) as usize {
                if start + i >= y.len() {
                    break;
                }
                let dt = i as f64 / sr as f64;
                y[start + i] +=
                    ((2.0 * std::f64::consts::PI * 160.0 * dt).sin() * (-dt / 0.006).exp()) as f32;
            }
            t += 0.4;
        }
        let peak = y.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        y.iter().map(|v| v / peak * 0.99).collect()
    }

    /// Share of each component's energy in the bins around `freq` (±60 Hz),
    /// summed over frames past the first 0.5 s (past the start transient).
    fn band_shares(sep: &Separation, sr: u32, n_fft: usize, freq: f64) -> (f64, f64) {
        let bin = (freq * n_fft as f64 / sr as f64).round() as usize;
        let lo = bin.saturating_sub(3);
        let hi = (bin + 3).min(n_fft / 2);
        let skip = (0.5 * sr as f64 / 128.0) as usize;
        let (mut h, mut p) = (0.0, 0.0);
        for f in skip..sep.harmonic.len() {
            for b in lo..=hi {
                h += sep.harmonic[f][b];
                p += sep.percussive[f][b];
            }
        }
        (h, p)
    }

    #[test]
    fn a_few_frames_separate_exactly_as_the_whole_track_does() {
        let y = mix(44_100, 3.0);
        let spec = stft::power_spectrogram(&y, 2048, 128);
        let whole = separate(&spec);
        let total = spec.len();
        // Interior, both ends of the track, and a range running past it.
        for range in [
            400..408,
            0..8,
            3..11,
            total - 8..total,
            total - 3..total + 5,
        ] {
            let local = separate_frames(&y, 2048, 128, range.clone());
            let hi = range.end.min(total);
            assert_eq!(local.harmonic, whole.harmonic[range.start..hi], "{range:?}");
            assert_eq!(
                local.percussive,
                whole.percussive[range.start..hi],
                "{range:?}"
            );
        }
        assert!(separate_frames(&y, 2048, 128, total + 1..total + 9)
            .harmonic
            .is_empty());
    }

    /// Isolated hits every 0.5 s, and the percussive share over the eight
    /// frames around each that the hitsound feature reads.
    fn hit_share(decay_s: f64) -> f64 {
        let sr = 44_100u32;
        let mut y = vec![0.0f32; 4 * sr as usize];
        let mut seed = 99u64;
        let mut hits = Vec::new();
        let mut t0 = 0.3;
        while t0 < 3.6 {
            let start = (t0 * sr as f64) as usize;
            for i in 0..(0.4 * sr as f64) as usize {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let noise = ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5;
                let t = i as f64 / sr as f64;
                y[start + i] += (1.6 * noise * (-t / decay_s).exp()) as f32;
            }
            hits.push((t0 * sr as f64 / 128.0).round() as usize);
            t0 += 0.5;
        }
        let (mut p, mut all) = (0.0, 0.0);
        for frame in hits {
            let sep = separate_frames(&y, 2048, 128, frame - 4..frame + 4);
            for (h_row, p_row) in sep.harmonic.iter().zip(&sep.percussive) {
                for (h, pp) in h_row.iter().zip(p_row) {
                    p += pp;
                    all += h + pp;
                }
            }
        }
        p / all
    }

    #[test]
    fn an_isolated_hit_reads_as_percussive() {
        // With a 17-frame time kernel, barely past the 16-hop window a
        // transient smears over, a click read 0.885 and a snare 0.55.
        let click = hit_share(0.002);
        let snare = hit_share(0.040);
        assert!(click > 0.99, "2 ms click {click:.3}");
        assert!(snare > 0.80, "40 ms snare {snare:.3}");
    }

    #[test]
    fn masks_are_conservative() {
        // H + P == S bin for bin: energy is split, never created. Bins
        // holding less than a millionth of the peak are skipped: an isolated
        // blip in a sea of zeros is erased by *both* medians (correctly —
        // it is neither a line nor a transient), and relative error against
        // ~zero measures nothing.
        let y = mix(44_100, 2.5);
        let spec = stft::power_spectrogram(&y, 2048, 128);
        let peak = spec.iter().flatten().copied().fold(0.0f64, f64::max);
        let sep = separate(&spec);
        let mut worst = 0.0f64;
        for (s_row, (h_row, p_row)) in spec
            .iter()
            .zip(sep.harmonic.iter().zip(sep.percussive.iter()))
            .step_by(37)
        {
            for ((&s, &h), &p) in s_row.iter().zip(h_row.iter()).zip(p_row.iter()) {
                if s > 1e-6 * peak {
                    worst = worst.max((h + p - s).abs() / s);
                }
            }
        }
        assert!(worst < 1e-9, "created energy: {worst}");
    }

    #[test]
    fn a_sustained_partial_is_harmonic() {
        let y = mix(44_100, 2.5);
        let spec = stft::power_spectrogram(&y, 2048, 128);
        let sep = separate(&spec);
        let (h, p) = band_shares(&sep, 44_100, 2048, 440.0);
        assert!(h > 9.0 * p, "sine {h} vs {p} should be ~all harmonic");
    }

    #[test]
    fn clicks_are_percussive() {
        let y = mix(44_100, 2.5);
        let spec = stft::power_spectrogram(&y, 2048, 128);
        let sep = separate(&spec);
        // Click band far from the sine (2–4 kHz): transients must dominate.
        let (mut h, mut p) = (0.0, 0.0);
        let skip = (0.5 * 44_100.0 / 128.0) as usize;
        for f in skip..sep.harmonic.len() {
            for b in 93..186 {
                h += sep.harmonic[f][b];
                p += sep.percussive[f][b];
            }
        }
        assert!(p > 3.0 * h, "clicks percussive {p} vs harmonic {h}");
    }

    #[test]
    fn pure_tone_has_no_percussive_residue() {
        let y: Vec<f32> = (0..44_100 * 2)
            .map(|i| {
                (0.5 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / 44_100.0).sin()) as f32
            })
            .collect();
        let spec = stft::power_spectrogram(&y, 2048, 128);
        let sep = separate(&spec);
        let total_p: f64 = sep.percussive.iter().flatten().sum();
        let total_s: f64 = spec.iter().flatten().sum();
        assert!(total_p < 0.05 * total_s, "residue {total_p} of {total_s}");
    }

    #[test]
    fn silence_separates_to_silence() {
        let spec = stft::power_spectrogram(&vec![0.0f32; 8192], 2048, 128);
        let sep = separate(&spec);
        assert!(sep.harmonic.iter().flatten().all(|&v| v == 0.0));
        assert!(sep.percussive.iter().flatten().all(|&v| v == 0.0));
    }
}
