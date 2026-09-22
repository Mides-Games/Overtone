//! Zero-phase bandpass bank matched to the multi-band flux bands.
//!
//! Re-timing an attack on the full-band waveform smears it: a hat landing
//! on top of a kick moves the 20 % rise the walker looks for. Filtering the
//! attack's own band out first removes the smear — but an IIR filter shifts
//! phase, and a per-band phase shift is a per-band offset bias, which is
//! worse than the smear. So every band is filtered forward *and* backward
//! (filtfilt): zero phase distortion by construction, at the price of a
//! squared magnitude response (skirts twice as steep — welcome here).
//!
//! Filters are RBJ constant-peak-gain bandpasses, one biquad per band,
//! Direct Form I in f64. Edges come from [`crate::multiband::band_edges`]
//! so the waveforms agree with the flux that picks the band.

use crate::multiband::{self, BANDS};

/// Reflection padding for filtfilt edges, in samples. Biquad ringing at
/// these Qs dies within dozens of samples; a thousand is plenty.
pub const EDGE_PAD: usize = 1024;

/// One RBJ section (bandpass or gentle lowpass). Coefficients stay
/// private; design through [`design_bank`] or [`Biquad::lowpass`].
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    /// Bandpass with 0 dB peak gain (RBJ cookbook).
    fn bandpass(fc_hz: f64, q: f64, sr: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * fc_hz / sr;
        let alpha = w0.sin() / (2.0 * q);
        let (b0, b1, b2) = (alpha, 0.0, -alpha);
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * w0.cos();
        let a2 = 1.0 - alpha;
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// Gentle lowpass (RBJ, Q = 0.5, no resonance): minimal ringing for
    /// its isolation. This — not a narrow band — is the honest retiming
    /// filter for low attacks: a narrow band rings longer than the smear
    /// it removes (measured +9 ms late), a band submix pre-rings early
    /// (−4.5 ms); the gentle lowpass halves a 2 ms smear. See the test.
    pub fn lowpass(fc_hz: f64, q: f64, sr: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * fc_hz / sr;
        let alpha = w0.sin() / (2.0 * q);
        let (b0, b1, b2) = (
            (1.0 - w0.cos()) / 2.0,
            1.0 - w0.cos(),
            (1.0 - w0.cos()) / 2.0,
        );
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * w0.cos();
        let a2 = 1.0 - alpha;
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    fn run(&self, input: &[f64], output: &mut [f64]) {
        debug_assert_eq!(input.len(), output.len());
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for (o, &x) in output.iter_mut().zip(input) {
            let y = self.b0 * x + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            *o = y;
        }
    }
}

/// Design the seven bandpass sections for `sr` from the flux band edges:
/// centre `sqrt(lo·hi)`, `Q = fc / bandwidth`.
pub fn design_bank(sr: u32) -> Vec<Biquad> {
    let edges = multiband::band_edges();
    (0..BANDS)
        .map(|b| {
            let (lo, hi) = (edges[b], edges[b + 1]);
            let fc = (lo * hi).sqrt();
            let q = fc / (hi - lo).max(1e-9);
            Biquad::bandpass(fc, q, sr as f64)
        })
        .collect()
}

/// Zero-phase filter one signal — one forward pass plus one backward pass
/// on the reversed output — with reflected edges so the ends do not ring
/// into the music.
pub fn filtfilt(section: &Biquad, y: &[f32]) -> Vec<f32> {
    if y.len() < 8 {
        return y.to_vec();
    }
    let pad = EDGE_PAD.min(y.len() / 4).max(4);
    let mut ext = Vec::with_capacity(y.len() + 2 * pad);
    for i in (1..=pad).rev() {
        ext.push(2.0 * y[0] as f64 - y[i.min(y.len() - 1)] as f64);
    }
    ext.extend(y.iter().map(|&v| v as f64));
    for i in 1..=pad {
        let j = y.len().saturating_sub(i + 1);
        ext.push(2.0 * y[y.len() - 1] as f64 - y[j] as f64);
    }
    // One forward-backward pair: the backward pass runs on the reversed
    // forward output, then reverses back. Magnitude squares, phase cancels.
    let mut buf = vec![0.0; ext.len()];
    let mut tmp = vec![0.0; ext.len()];
    section.run(&ext, &mut buf);
    buf.reverse();
    section.run(&buf, &mut tmp);
    tmp.reverse();
    tmp[pad..tmp.len() - pad]
        .iter()
        .map(|&v| v as f32)
        .collect()
}

/// Band-limited waveforms, one per flux band, same length as the input.
pub fn band_waveforms(y: &[f32], sr: u32) -> Vec<Vec<f32>> {
    let bank = design_bank(sr);
    bank.iter().map(|section| filtfilt(section, y)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sr: u32, seconds: f64, freq: f64) -> Vec<f32> {
        (0..(seconds * sr as f64) as usize)
            .map(|i| {
                (0.5 * (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin()) as f32
            })
            .collect()
    }

    fn rms(y: &[f32]) -> f64 {
        (y.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / y.len().max(1) as f64).sqrt()
    }

    #[test]
    fn design_covers_the_bands() {
        let bank = design_bank(44_100);
        assert_eq!(bank.len(), BANDS);
        // Band 0 (40–89 Hz): fc ~60 Hz, Q ~1.2. Top band (~4.9–11 kHz):
        // fc ~7.4 kHz. Coefficients finite, filters stable by RBJ
        // construction for any positive Q.
        for section in &bank {
            for &c in &[section.b0, section.b1, section.b2, section.a1, section.a2] {
                assert!(c.is_finite());
            }
        }
    }

    #[test]
    fn in_band_passes_out_of_band_dies() {
        let sr = 44_100;
        let section = design_bank(sr)[0];
        // 60 Hz in band 0 (~unity: filtfilt squares the 0 dB peak to 1).
        let in_band = sine(sr, 2.0, 60.0);
        let in_rms = rms(&in_band);
        let out_rms = rms(&filtfilt(&section, &in_band));
        assert!(
            (out_rms / in_rms - 1.0).abs() < 0.15,
            "in-band ratio {}",
            out_rms / in_rms
        );
        // 5 kHz, four octaves up: must be well buried.
        let out_of_band = sine(sr, 2.0, 5000.0);
        let ratio = rms(&filtfilt(&section, &out_of_band)) / rms(&out_of_band);
        assert!(ratio < 0.05, "out-of-band leaks at {ratio}");
    }

    #[test]
    fn zero_phase_holds_an_impulse_in_place() {
        let sr = 44_100;
        let section = design_bank(sr)[2];
        let mut y = vec![0.0f32; 8192];
        y[4096] = 1.0;
        let out = filtfilt(&section, &y);
        let peak = out
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .map(|(i, _)| i)
            .unwrap();
        // Symmetric response centred on the impulse: zero phase distortion.
        assert!((peak as i64 - 4096).abs() <= 1, "peak at {peak}");
    }

    #[test]
    fn band_limited_retiming_beats_full_band_under_a_hat() {
        // B.6's core claim: a hat landing on a kick moves the full-band
        // 20 % rise the walker looks for. Kick onset at 1.0 s, hat 5 ms
        // later and louder; the coarse time arrives 8 ms late as usual.
        let sr = 44_100;
        let mut y = vec![0.0f32; (3.0 * sr as f64) as usize];
        let kick = (1.0 * sr as f64) as usize;
        for (i, v) in y.iter_mut().enumerate().skip(kick) {
            let dt = (i - kick) as f64 / sr as f64;
            *v += ((2.0 * std::f64::consts::PI * 60.0 * dt).sin() * (-dt / 0.02).exp()) as f32;
        }
        let hat = kick + (0.003 * sr as f64) as usize;
        for (i, v) in y.iter_mut().enumerate().skip(hat) {
            let dt = (i - hat) as f64 / sr as f64;
            if dt > 0.03 {
                break;
            }
            *v += (3.0 * (2.0 * std::f64::consts::PI * 6000.0 * dt).sin() * (-dt / 0.005).exp())
                as f32;
        }
        let peak = y.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        for v in &mut y {
            *v /= peak;
        }
        let truth = 1.0;
        let coarse = truth + 0.008;
        let full = crate::retime::retime(&y, sr, &[coarse])[0];
        // Full-band must demonstrably smear, or this test proves nothing.
        assert!(
            full - truth > 0.001,
            "no smear to fix: full {full:.5} vs truth {truth}"
        );
        let gentle = Biquad::lowpass(800.0, 0.5, sr as f64);
        let lowpassed = filtfilt(&gentle, &y);
        let fixed = crate::retime::retime(&lowpassed, sr, &[coarse])[0];
        // Halves the smear with headroom: 0.96 ms vs 1.86 ms measured.
        // Tried and dropped: narrow band 0 (+9 ms late — ringing outlasts
        // the smear) and a 0-2 submix (−4.5 ms early — skirt pre-ring).
        assert!(
            (fixed - truth).abs() < 0.0015,
            "lowpassed {fixed:.5} vs truth {truth}"
        );
        assert!(
            fixed < full,
            "lowpassed {fixed:.5} should beat full {full:.5}"
        );
    }

    #[test]
    fn bank_returns_seven_aligned_waveforms() {
        let sr = 44_100;
        let y = sine(sr, 1.0, 60.0);
        let bands = band_waveforms(&y, sr);
        assert_eq!(bands.len(), BANDS);
        for band in &bands {
            assert_eq!(band.len(), y.len());
        }
        // The 60 Hz sine lives in band 0; every other band holds leakage.
        let energy: Vec<f64> = bands
            .iter()
            .map(|b| b.iter().map(|&v| (v as f64).powi(2)).sum::<f64>())
            .collect();
        let top = energy
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(i, _)| i)
            .unwrap();
        assert_eq!(top, 0, "energies {energy:.2?}");
    }

    #[test]
    fn silence_stays_silent() {
        let bank = design_bank(44_100);
        for section in &bank {
            assert!(filtfilt(section, &vec![0.0f32; 4096])
                .iter()
                .all(|&v| v == 0.0));
        }
    }
}
