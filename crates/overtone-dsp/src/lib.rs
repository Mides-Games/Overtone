//! DSP kernels for Overtone. Pure functions over slices — no I/O, no state, no
//! globals, so every one of them is testable and benchmarkable on its own.
//!
//! The pipeline this crate owns, in order:
//!
//! ```text
//! samples -> power spectrogram -> mel -> dB -> rectified flux -> median
//!         -> onset envelope -> peak picking -> parabolic sub-frame
//!         -> sample-resolution re-timing -> attacks
//! ```
//!
//! Everything here is specified against the v3 Python implementation in
//! `docs/05-dsp-pipeline.md` Part A. Where a librosa or scipy default is
//! load-bearing, the module that reproduces it says so.

pub mod bandpass;
pub mod chroma;
pub mod classify;
pub mod envelope;
pub mod hpss;
pub mod mel;
pub mod mfcc;
pub mod multiband;
pub mod peaks;
pub mod retime;
pub mod stft;
pub mod structure;

use overtone_core::{Attack, Seconds, FIT_HOP, N_FFT};

/// Detect attacks: envelope, pick peaks, re-time on the raw waveform.
///
/// `retime = false` reproduces v3's `--no-refine`, which exists to diagnose
/// whether the snapping itself drifts.
pub fn detect_attacks(y: &[f32], sr: u32, hop: usize, retime_attacks: bool) -> (Vec<Attack>, Vec<f32>) {
    let env = envelope::onset_envelope(y, sr, hop, N_FFT);
    if env.len() < 8 {
        return (Vec::new(), env);
    }

    // v3: distance = 25 ms, floor = max(0.04, p55), prominence = 0.05, and a
    // bare-distance retry when nothing survives.
    let distance = ((0.025 * sr as f64 / hop as f64).round() as usize).max(1);
    let env64: Vec<f64> = env.iter().map(|&v| v as f64).collect();
    let floor = 0.04f64.max(envelope::percentile(&env64, 55.0));
    let mut picked = peaks::find_peaks(&env, distance, Some(0.05), Some(floor));
    if picked.is_empty() {
        picked = peaks::find_peaks(&env, distance, None, None);
    }
    if picked.is_empty() {
        return (Vec::new(), env);
    }

    let (frames, mut weights) = peaks::refine_parabolic(&env, &picked);
    let mut times: Vec<f64> = frames
        .iter()
        .map(|&f| f * hop as f64 / sr as f64)
        .collect();

    if retime_attacks {
        times = retime::retime(y, sr, &times);
        retime::dedupe(&mut times, &mut weights);
    }

    let attacks = times
        .into_iter()
        .zip(weights)
        .map(|(time, weight)| Attack {
            time: Seconds(time),
            weight,
        })
        .collect();
    (attacks, env)
}

/// [`detect_attacks`] at the engine's own hop.
pub fn detect_attacks_default(y: &[f32], sr: u32) -> (Vec<Attack>, Vec<f32>) {
    detect_attacks(y, sr, FIT_HOP, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A click track: one short impulse-like hit every `period` seconds.
    fn clicks(sr: u32, duration: f64, period: f64) -> Vec<f32> {
        let mut y = vec![0.0f32; (duration * sr as f64) as usize];
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
            t += period;
        }
        y
    }

    #[test]
    fn a_click_track_yields_one_attack_per_click() {
        let sr = 44_100;
        let period = 60.0 / 150.0;
        let y = clicks(sr, 12.0, period);
        let (attacks, _env) = detect_attacks_default(&y, sr);
        let expected = ((12.0 - 0.1 - 0.25) / period).floor() as usize + 1;
        assert!(
            (attacks.len() as i64 - expected as i64).abs() <= 1,
            "found {} attacks, expected about {expected}",
            attacks.len()
        );
    }

    #[test]
    fn attacks_land_on_the_clicks() {
        let sr = 44_100;
        let period = 60.0 / 150.0;
        let y = clicks(sr, 12.0, period);
        let (attacks, _) = detect_attacks_default(&y, sr);
        assert!(!attacks.is_empty());
        for attack in &attacks {
            let beats = (attack.time.get() - 0.25) / period;
            let error = (beats - beats.round()).abs() * period * 1000.0;
            assert!(error < 6.0, "attack at {:?} is {error:.2} ms off", attack.time);
        }
    }

    #[test]
    fn retiming_is_what_removes_the_bias() {
        // The same audio with and without re-timing: the un-refined attacks
        // must sit measurably later, which is the v2 bias this exists to fix.
        let sr = 44_100;
        let period = 60.0 / 150.0;
        let y = clicks(sr, 12.0, period);
        let (refined, _) = detect_attacks(&y, sr, FIT_HOP, true);
        let (coarse, _) = detect_attacks(&y, sr, FIT_HOP, false);
        let bias = |a: &[Attack]| -> f64 {
            let mut errors: Vec<f64> = a
                .iter()
                .map(|x| {
                    let beats = (x.time.get() - 0.25) / period;
                    (beats - beats.round()) * period * 1000.0
                })
                .collect();
            errors.sort_by(f64::total_cmp);
            errors[errors.len() / 2]
        };
        let refined_bias = bias(&refined).abs();
        let coarse_bias = bias(&coarse).abs();
        assert!(
            refined_bias < coarse_bias,
            "refined {refined_bias:.3} ms should beat coarse {coarse_bias:.3} ms"
        );
    }

    #[test]
    fn silence_produces_no_attacks() {
        let (attacks, _) = detect_attacks_default(&vec![0.0f32; 44_100 * 3], 44_100);
        assert!(attacks.is_empty());
    }
}
