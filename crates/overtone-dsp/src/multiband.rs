//! Multi-band spectral flux: one onset function per band, not one for the
//! whole spectrum.
//!
//! The default envelope answers "did anything start". The hitsound engine
//! and band-limited re-timing need "WHAT started, and where": a kick moves
//! the sub band, a hat the top, and a broadband click moves all seven. So
//! this splits 40 Hz – 11.025 kHz (the mel path's own range) into 7
//! log-spaced bands and reports rectified dB flux per band, on the same
//! frames, pad and hop as the default envelope so the two align sample for
//! sample.
//!
//! Values are absolute dB flux — bands are mutually comparable, and no
//! per-band normalisation invents peaks in a silent band. Input is assumed
//! peak-normalised, exactly like the rest of the analysis path.

use crate::stft;

/// Band edges in Hz: seven log-spaced bands over the mel path's range, so
/// both front ends cover the same spectrum, each 2.23 times the last --
/// 40, 89, 199, 445, 992, 2214, 4940, 11025. They are not the hitsound
/// features' musical bands (sub 20-60 Hz up to air 11 kHz+, docs/06 §2,
/// `overtone_hitsound::spectral::BANDS`): band `i` here is not band `i`
/// there, and nothing above 11.025 kHz moves any band here, a cymbal's
/// air shimmer included.
pub const BANDS: usize = 7;
pub const BAND_LO_HZ: f64 = 40.0;
pub const BAND_HI_HZ: f64 = 11_025.0;

pub fn band_edges() -> [f64; BANDS + 1] {
    let mut edges = [0.0; BANDS + 1];
    for (i, slot) in edges.iter_mut().enumerate() {
        *slot = BAND_LO_HZ * (BAND_HI_HZ / BAND_LO_HZ).powf(i as f64 / BANDS as f64);
    }
    edges[BANDS] = BAND_HI_HZ;
    edges
}

/// Per-band rectified dB flux, `frames` rows of [`BANDS`] values.
///
/// Pipeline per frame: power spectrum → band energies → global dB floor →
/// rectified differences. The dB floor is global (`top_db = 80` under the
/// peak band energy) for the same reason as the default path: one loud
/// transient raises the floor everywhere, and chunked recomputation would
/// otherwise diverge.
pub fn band_flux(y: &[f32], sr: u32, hop: usize, n_fft: usize) -> Vec<Vec<f32>> {
    let edges = band_edges();
    let bin_hz = sr as f64 / n_fft as f64;
    // Inclusive bin ranges per band, computed once.
    let mut ranges = [(0usize, 0usize); BANDS];
    for (b, range) in ranges.iter_mut().enumerate() {
        let lo = ((edges[b] / bin_hz).floor() as usize).max(1);
        let hi = ((edges[b + 1] / bin_hz).ceil() as usize).min(n_fft / 2 + 1);
        *range = (lo, hi.max(lo + 1));
    }

    // Band energies straight from each frame's power spectrum, never the
    // whole spectrogram; then the global dB floor.
    let mut energy: Vec<Vec<f64>> = stft::map_frames(y, n_fft, hop, |row| {
        ranges
            .iter()
            .map(|&(lo, hi)| row[lo..hi].iter().sum::<f64>())
            .collect()
    });
    let frames = energy.len();
    if frames < 2 {
        return Vec::new();
    }
    db_floor(&mut energy);

    // Rectified differences, front-padded like the default envelope so a
    // peak at row k means the same audio moment in both curves.
    let pad = 1 + n_fft / (2 * hop);
    let mut out = vec![vec![0.0f32; BANDS]; pad.min(frames)];
    for frame in 1..frames {
        let mut row = vec![0.0f32; BANDS];
        for b in 0..BANDS {
            row[b] = (energy[frame][b] - energy[frame - 1][b]).max(0.0) as f32;
        }
        out.push(row);
    }
    out.truncate(frames);
    while out.len() < frames {
        out.push(vec![0.0f32; BANDS]);
    }
    out
}

/// Global `top_db = 80` floor under the peak band energy, mirroring the
/// default envelope's `power_to_db` (which stays private to its module:
/// this is three lines, and sharing it would couple the two front ends).
fn db_floor(energy: &mut [Vec<f64>]) {
    const AMIN: f64 = 1e-10;
    const TOP_DB: f64 = 80.0;
    let mut peak = f64::NEG_INFINITY;
    for row in energy.iter_mut() {
        for value in row.iter_mut() {
            *value = 10.0 * value.max(AMIN).log10();
            if *value > peak {
                peak = *value;
            }
        }
    }
    if peak.is_finite() {
        let floor = peak - TOP_DB;
        for row in energy.iter_mut() {
            for value in row.iter_mut() {
                if *value < floor {
                    *value = floor;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sustained tone switching frequency at `at`, with a short crossfade so
    /// the switch itself carries no click. Narrowband by construction — and
    /// the honest separation case: falling energy is rectified away, so only
    /// the new tone's band may crest, whatever the attack splatters.
    fn switch(sr: u32, duration: f64, from_hz: f64, to_hz: f64, at: f64) -> Vec<f32> {
        let mut y = vec![0.0f32; (duration * sr as f64) as usize];
        for (i, slot) in y.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            // 30 ms raised-cosine crossfade around the switch.
            let fade = ((t - at) / 0.03 * 0.5 + 0.5).clamp(0.0, 1.0);
            let fade = 0.5 - 0.5 * (std::f64::consts::PI * fade).cos();
            let a = (2.0 * std::f64::consts::PI * from_hz * t).sin() * (1.0 - fade);
            let b = (2.0 * std::f64::consts::PI * to_hz * t).sin() * fade;
            *slot = (0.5 * (a + b)) as f32;
        }
        let peak = y.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        y.iter().map(|v| v / peak * 0.99).collect()
    }

    /// Short decaying sine hit. Its attack transient is broadband — that is
    /// physics, not a bug — so this fixture documents the transient case,
    /// not band isolation.
    fn burst(sr: u32, duration: f64, freq: f64, at: f64) -> Vec<f32> {
        let mut y = vec![0.0f32; (duration * sr as f64) as usize];
        let start = (at * sr as f64) as usize;
        for i in 0..(0.5 * sr as f64) as usize {
            if start + i >= y.len() {
                break;
            }
            let dt = i as f64 / sr as f64;
            let attack = 0.5 - 0.5 * (std::f64::consts::PI * (dt / 0.01).min(1.0)).cos();
            y[start + i] += ((2.0 * std::f64::consts::PI * freq * dt).sin()
                * attack
                * (-dt / 0.2).exp()) as f32;
        }
        let peak = y.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        y.iter().map(|v| v / peak * 0.99).collect()
    }

    /// Peak flux per band over the whole envelope.
    fn band_peaks(env: &[Vec<f32>]) -> [f64; BANDS] {
        let mut peaks = [0.0f64; BANDS];
        for row in env {
            for (b, &v) in row.iter().enumerate() {
                peaks[b] = peaks[b].max(v as f64);
            }
        }
        peaks
    }

    #[test]
    fn band_edges_cover_the_mel_range() {
        let edges = band_edges();
        assert_eq!(edges.len(), BANDS + 1);
        assert!((edges[0] - BAND_LO_HZ).abs() < 1e-9);
        assert!((edges[BANDS] - BAND_HI_HZ).abs() < 1e-9);
        for pair in edges.windows(2) {
            assert!(pair[1] > pair[0]);
            // Log-spaced over 40–11025 Hz in 7 bands: each ~2.23x the last.
            assert!(
                (pair[1] / pair[0] - 2.23).abs() < 0.05,
                "{} vs {}",
                pair[0],
                pair[1]
            );
        }
    }

    /// Which band holds `freq`, for asserting switch targets.
    fn band_of(freq: f64) -> usize {
        let edges = band_edges();
        edges
            .windows(2)
            .position(|pair| freq >= pair[0] && freq < pair[1])
            .unwrap_or(BANDS - 1)
    }

    #[test]
    fn a_switch_crests_only_in_the_new_tones_band() {
        // 60 Hz to 8 kHz at t = 2 s. The falling 60 Hz energy is rectified
        // away everywhere, so every other band must stay near silent while
        // the new band crests — whatever any attack transient splatters.
        let y = switch(44_100, 4.0, 60.0, 8000.0, 2.0);
        let env = band_flux(&y, 44_100, 128, 2048);
        // Peak over a ±100 ms window around the switch, per band.
        let lo = ((1.9 * 44_100.0 / 128.0) as usize).min(env.len() - 1);
        let hi = ((2.1 * 44_100.0 / 128.0) as usize).min(env.len() - 1);
        let mut peaks = [0.0f64; BANDS];
        for row in &env[lo..=hi] {
            for (b, &v) in row.iter().enumerate() {
                peaks[b] = peaks[b].max(v as f64);
            }
        }
        let target = band_of(8000.0);
        assert_eq!(target, BANDS - 1);
        // The new band must be the unique argmax with real margin: only it
        // receives new energy, everything else sees crossfade interference
        // and a rising global floor (measured runner-up: band 2 at ~1/4 of
        // the peak, so the bar sits at half with 2x headroom).
        let mut order: Vec<usize> = (0..BANDS).collect();
        order.sort_by(|&a, &b| peaks[b].total_cmp(&peaks[a]));
        assert_eq!(order[0], target, "peaks {peaks:.2?}");
        assert!(peaks[order[0]] > 2.0 * peaks[order[1]], "peaks {peaks:.2?}");
    }

    #[test]
    fn a_falling_tone_leaves_no_flux_behind() {
        // The mirror guarantee: where energy only decays, rectification
        // yields exact zeros, not small numbers.
        let y = switch(44_100, 4.0, 8000.0, 60.0, 2.0);
        let env = band_flux(&y, 44_100, 128, 2048);
        let lo = ((2.05 * 44_100.0 / 128.0) as usize).min(env.len() - 1);
        let hi = ((2.4 * 44_100.0 / 128.0) as usize).min(env.len() - 1);
        // Past the switch, the 8 kHz band holds only decaying energy.
        let top = band_of(8000.0);
        let late: f64 = env[lo..=hi]
            .iter()
            .map(|row| row[top] as f64)
            .fold(0.0, f64::max);
        assert!(
            late < 1e-9,
            "decaying band flux {late} should rectify to zero"
        );
    }

    #[test]
    fn a_burst_rolls_off_and_hits_the_floor() {
        // Broadband transient, measured peaks [23, 21, 14, 6, 3, 0, 0]:
        // attack splatter decays with frequency while the global floor
        // (peak − 80 dB) holds the far bands at exact zero. Both halves are
        // structural — splatter rolls off, the floor clips — so both are
        // pinned: argmax at the fundamental, monotone down, silence above.
        let y = burst(44_100, 4.0, 60.0, 1.0);
        let peaks = band_peaks(&band_flux(&y, 44_100, 128, 2048));
        let mut order: Vec<usize> = (0..BANDS).collect();
        order.sort_by(|&a, &b| peaks[b].total_cmp(&peaks[a]));
        assert_eq!(order[0], 0, "peaks {peaks:.2?}");
        for pair in peaks.windows(2) {
            assert!(pair[0] >= pair[1], "peaks {peaks:.2?}");
        }
        assert_eq!(peaks[BANDS - 1], 0.0);
        assert_eq!(peaks[BANDS - 2], 0.0);
    }

    #[test]
    fn band_peaks_align_with_the_burst() {
        let y = burst(44_100, 4.0, 60.0, 1.0);
        let env = band_flux(&y, 44_100, 128, 2048);
        let peak_frame = env
            .iter()
            .enumerate()
            .max_by(|a, b| a.1[0].total_cmp(&b.1[0]))
            .map(|(i, _)| i)
            .unwrap();
        let peak_t = peak_frame as f64 * 128.0 / 44_100.0;
        assert!(
            (peak_t - 1.0).abs() < 0.05,
            "band-0 peak at {peak_t:.3}s, burst at 1.0s"
        );
    }

    #[test]
    fn silence_is_silent_in_every_band() {
        let env = band_flux(&vec![0.0f32; 44_100], 44_100, 128, 2048);
        assert!(env.iter().flatten().all(|&v| v == 0.0));
    }
}
