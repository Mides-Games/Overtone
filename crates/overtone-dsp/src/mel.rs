//! Slaney mel scale and filterbank, matching `librosa.filters.mel` exactly.
//!
//! "Exactly" is load-bearing. The onset envelope is the median across 128 mel
//! bands, so a different mel basis changes every peak height, which changes
//! which peaks survive picking, which moves attacks. A wrong basis does not
//! produce an obviously wrong answer — it produces a slightly worse one, which
//! is the failure mode this whole port is built to catch.
//!
//! Extracted from the installed librosa 1.0.0 (`filters.py::mel`,
//! `core/convert.py::{hz_to_mel, mel_to_hz, mel_frequencies, fft_frequencies}`)
//! rather than from memory. Defaults that v3 relies on without naming them:
//! `htk=false` (Slaney), `norm="slaney"` (area), `fmin=0`.

/// Slaney mel: linear below 1 kHz, logarithmic above.
pub fn hz_to_mel(hz: f64) -> f64 {
    const F_MIN: f64 = 0.0;
    const F_SP: f64 = 200.0 / 3.0;
    const MIN_LOG_HZ: f64 = 1000.0;
    let min_log_mel = (MIN_LOG_HZ - F_MIN) / F_SP;
    let logstep = 6.4f64.ln() / 27.0;
    if hz >= MIN_LOG_HZ {
        min_log_mel + (hz / MIN_LOG_HZ).ln() / logstep
    } else {
        (hz - F_MIN) / F_SP
    }
}

/// Inverse of [`hz_to_mel`].
pub fn mel_to_hz(mel: f64) -> f64 {
    const F_MIN: f64 = 0.0;
    const F_SP: f64 = 200.0 / 3.0;
    const MIN_LOG_HZ: f64 = 1000.0;
    let min_log_mel = (MIN_LOG_HZ - F_MIN) / F_SP;
    let logstep = 6.4f64.ln() / 27.0;
    if mel >= min_log_mel {
        MIN_LOG_HZ * ((mel - min_log_mel) * logstep).exp()
    } else {
        F_MIN + F_SP * mel
    }
}

/// `n` mel band edges, uniformly spaced in mel between `fmin` and `fmax`.
pub fn mel_frequencies(n: usize, fmin: f64, fmax: f64) -> Vec<f64> {
    let (lo, hi) = (hz_to_mel(fmin), hz_to_mel(fmax));
    (0..n)
        .map(|i| {
            // numpy's linspace: endpoints exact, no accumulated step error.
            let t = if n == 1 {
                0.0
            } else {
                i as f64 / (n - 1) as f64
            };
            mel_to_hz(lo + t * (hi - lo))
        })
        .collect()
}

/// Centre frequency of each real FFT bin.
pub fn fft_frequencies(sr: u32, n_fft: usize) -> Vec<f64> {
    let bins = n_fft / 2 + 1;
    (0..bins)
        .map(|i| {
            let t = if bins == 1 {
                0.0
            } else {
                i as f64 / (bins - 1) as f64
            };
            t * (sr as f64 / 2.0)
        })
        .collect()
}

/// Triangular mel filterbank, `n_mels` rows by `n_fft/2 + 1` columns,
/// Slaney-area-normalised.
pub fn filterbank(sr: u32, n_fft: usize, n_mels: usize, fmin: f64, fmax: f64) -> Vec<Vec<f64>> {
    let fftfreqs = fft_frequencies(sr, n_fft);
    let mel_f = mel_frequencies(n_mels + 2, fmin, fmax);
    let fdiff: Vec<f64> = mel_f.windows(2).map(|w| w[1] - w[0]).collect();

    let mut weights = vec![vec![0.0f64; fftfreqs.len()]; n_mels];
    for i in 0..n_mels {
        for (j, &f) in fftfreqs.iter().enumerate() {
            // ramps[i][j] = mel_f[i] - fftfreqs[j]
            let lower = -(mel_f[i] - f) / fdiff[i];
            let upper = (mel_f[i + 2] - f) / fdiff[i + 1];
            weights[i][j] = lower.min(upper).max(0.0);
        }
        // Slaney normalisation: each filter integrates to the same area, so a
        // wide high-frequency band does not dominate the median.
        let enorm = 2.0 / (mel_f[i + 2] - mel_f[i]);
        for value in &mut weights[i] {
            *value *= enorm;
        }
    }
    weights
}

/// One mel band, stored as the contiguous run of FFT bins it actually
/// touches. A triangular filter is zero almost everywhere: across the 128
/// bands at n_fft = 2048 the average run is a few dozen bins out of 1025, so
/// the dense form does roughly 50x the arithmetic for the same result.
///
/// Measured before this existed: the 6-minute fixture took 13.0 s and the
/// whole corpus 62 s, against Python's 5.0 s and 21.6 s. The dense projection
/// was the entire difference.
#[derive(Debug, Clone)]
pub struct MelBand {
    pub start: usize,
    pub weights: Vec<f64>,
}

/// Sparse mel filterbank.
#[derive(Debug, Clone)]
pub struct MelBank {
    pub bands: Vec<MelBand>,
}

impl MelBank {
    pub fn new(sr: u32, n_fft: usize, n_mels: usize, fmin: f64, fmax: f64) -> Self {
        let dense = filterbank(sr, n_fft, n_mels, fmin, fmax);
        let bands = dense
            .into_iter()
            .map(|row| {
                let start = row.iter().position(|&w| w > 0.0).unwrap_or(0);
                let end = row.iter().rposition(|&w| w > 0.0).map_or(start, |i| i + 1);
                MelBand {
                    start,
                    weights: row[start..end].to_vec(),
                }
            })
            .collect();
        Self { bands }
    }

    /// Project one power spectrum into `out`, which must hold one slot per band.
    #[inline]
    pub fn project(&self, power: &[f64], out: &mut [f64]) {
        for (band, slot) in self.bands.iter().zip(out.iter_mut()) {
            let bins = &power[band.start..band.start + band.weights.len()];
            *slot = band
                .weights
                .iter()
                .zip(bins)
                .map(|(&w, &p)| w * p)
                .sum();
        }
    }

    pub fn len(&self) -> usize {
        self.bands.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bands.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mel_scale_is_slaney_not_htk() {
        // The two scales agree at 0 and diverge above 1 kHz. HTK would give
        // 2595*log10(1+1000/700) = 999.99 mel at 1 kHz; Slaney gives 15.
        assert!((hz_to_mel(0.0) - 0.0).abs() < 1e-12);
        assert!((hz_to_mel(1000.0) - 15.0).abs() < 1e-9);
        assert!((hz_to_mel(200.0) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn mel_round_trips() {
        for hz in [0.0, 100.0, 999.9, 1000.0, 1000.1, 4000.0, 11025.0] {
            let back = mel_to_hz(hz_to_mel(hz));
            assert!((back - hz).abs() < 1e-6, "{hz} -> {back}");
        }
    }

    #[test]
    fn filterbank_has_the_shape_librosa_has() {
        let fb = filterbank(44_100, 2048, 128, 0.0, 11_025.0);
        assert_eq!(fb.len(), 128);
        assert_eq!(fb[0].len(), 1025);
        // Every filter must respond somewhere, or the median across bands is
        // being dragged by dead channels. librosa warns in this case; we test.
        for (i, row) in fb.iter().enumerate() {
            let peak = row.iter().cloned().fold(0.0f64, f64::max);
            assert!(peak > 0.0, "mel band {i} is empty");
        }
    }

    #[test]
    fn sparse_bank_matches_the_dense_one() {
        let dense = filterbank(44_100, 2048, 128, 0.0, 11_025.0);
        let sparse = MelBank::new(44_100, 2048, 128, 0.0, 11_025.0);
        // A spectrum that is not flat, so a mis-aligned `start` cannot pass.
        let power: Vec<f64> = (0..1025).map(|i| (i as f64 * 0.37).sin().abs() + 0.1).collect();
        let want: Vec<f64> = dense
            .iter()
            .map(|row| row.iter().zip(&power).map(|(&w, &p)| w * p).sum())
            .collect();
        let mut got = vec![0.0; sparse.len()];
        sparse.project(&power, &mut got);
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert!((g - w).abs() <= 1e-9 * w.abs().max(1.0), "band {i}: {g} vs {w}");
        }
    }

    #[test]
    fn sparse_bank_is_actually_sparse() {
        let sparse = MelBank::new(44_100, 2048, 128, 0.0, 11_025.0);
        let taps: usize = sparse.bands.iter().map(|b| b.weights.len()).sum();
        let dense = 128 * 1025;
        assert!(taps * 10 < dense, "{taps} taps vs {dense} dense");
    }

    #[test]
    fn filterbank_is_slaney_normalised() {
        // Area normalisation means narrow low bands get large weights and wide
        // high bands get small ones. Without it the ratio would be ~1.
        let fb = filterbank(44_100, 2048, 128, 0.0, 11_025.0);
        let low = fb[1].iter().cloned().fold(0.0f64, f64::max);
        let high = fb[120].iter().cloned().fold(0.0f64, f64::max);
        assert!(low > high * 5.0, "low {low} vs high {high}");
    }
}
