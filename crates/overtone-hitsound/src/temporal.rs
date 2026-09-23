//! Temporal per-attack features (docs §2).
//!
//! Rise time, decay constant, sustain, zero-crossing rate and sub-attack
//! count, all read off a millisecond-smoothed amplitude envelope in the
//! [−10 ms, +120 ms] window, plus the chroma distance across the attack.
//! The sub-attack count is the clap detector: a flam of micro-transients
//! against a snare's single hit.

use realfft::RealFftPlanner;

use crate::{PRE_END_S, PRE_START_S, WIN_END_S, WIN_START_S};

/// Smoothing for the amplitude envelope, in samples (~0.7 ms at 44.1 kHz).
/// Kills sample ripple without moving onsets.
pub const SMOOTH_SAMPLES: usize = 32;

/// Lowest frequency that counts toward `chroma_change`: chords, not kicks.
pub const CHORD_FLOOR_HZ: f64 = 100.0;

/// Temporal evidence for one attack.
#[derive(Debug, Clone)]
pub struct Temporal {
    /// Seconds from 10 % to 90 % of peak, forward from the attack.
    pub rise_s: f64,
    /// Decay constant from a log-linear fit over 20–200 ms, in seconds.
    /// Infinite when nothing decays (sustain pedal down, analytically).
    pub decay_tau_s: f64,
    /// Seconds above 10 % of peak, looking 500 ms past the attack.
    /// Short hits read their decay; sustained ones saturate near 0.5.
    pub sustain_s: f64,
    /// Fraction of sign changes in the window.
    pub zcr: f64,
    /// Envelope peaks above 30 % of max in the first 30 ms, ≥ 2 ms apart.
    pub sub_attacks: usize,
    /// Cosine distance between pre-window and attack chroma: a chord change
    /// scores high, a drum hit near zero.
    pub chroma_change: f64,
}

/// Millisecond-smoothed absolute amplitude.
fn envelope(samples: &[f64]) -> Vec<f64> {
    let mut env = vec![0.0; samples.len()];
    let mut running = 0.0;
    for (i, &v) in samples.iter().enumerate() {
        running += v.abs();
        if i >= SMOOTH_SAMPLES {
            running -= samples[i - SMOOTH_SAMPLES].abs();
        }
        env[i] = running / SMOOTH_SAMPLES.min(i + 1) as f64;
    }
    env
}

/// Hann-periodic magnitude spectrum at `n_fft`, zero-padded as needed.
fn spectrum(samples: &[f64], n_fft: usize) -> Vec<f64> {
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut input = fft.make_input_vec();
    for (slot, &v) in input.iter_mut().zip(samples.iter()) {
        *slot = v;
    }
    let len = samples.len().min(n_fft);
    for (i, slot) in input[..len].iter_mut().enumerate() {
        *slot *= 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / len as f64).cos();
    }
    let mut output = fft.make_output_vec();
    fft.process(&mut input, &mut output)
        .expect("fft sizes are fixed");
    output.iter().map(|c| c.norm()).collect()
}

pub fn analyze(y: &[f32], sr: u32, attack_s: f64) -> Temporal {
    let attack: Vec<f64> = crate::window_samples(y, sr, attack_s, WIN_START_S, WIN_END_S);
    let pre: Vec<f64> = crate::window_samples(y, sr, attack_s, PRE_START_S, PRE_END_S);
    let env = envelope(&attack);
    let peak = env.iter().copied().fold(0.0f64, f64::max);

    let rise_s = if peak <= 0.0 {
        0.0
    } else {
        let t10 = env
            .iter()
            .position(|&v| v >= 0.10 * peak)
            .unwrap_or(env.len());
        let t90 = env
            .iter()
            .skip(t10)
            .position(|&v| v >= 0.90 * peak)
            .map(|i| i + t10)
            .unwrap_or_else(|| {
                env.iter()
                    .enumerate()
                    .max_by(|a, b| a.1.total_cmp(b.1))
                    .map(|(i, _)| i)
                    .unwrap_or(env.len())
            });
        (t90.saturating_sub(t10)) as f64 / sr as f64
    };

    let decay_tau_s = {
        let lo = (0.020 * sr as f64) as usize;
        let hi = (0.200 * sr as f64).min(env.len() as f64) as usize;
        let mut xs = Vec::new();
        let mut ys = Vec::new();
        for (i, &v) in env.iter().enumerate().take(hi).skip(lo) {
            if v > 0.05 * peak && peak > 0.0 {
                xs.push(i as f64 / sr as f64);
                ys.push(v.ln());
            }
        }
        if xs.len() >= 8 {
            let n = xs.len() as f64;
            let (sx, sy): (f64, f64) = (xs.iter().sum(), ys.iter().sum());
            let sxx: f64 = xs.iter().map(|&x| x * x).sum();
            let sxy: f64 = xs.iter().zip(ys.iter()).map(|(&x, &y)| x * y).sum();
            let slope = (n * sxy - sx * sy) / (n * sxx - sx * sx).max(1e-12);
            if slope < -1e-9 {
                -1.0 / slope
            } else {
                f64::INFINITY
            }
        } else {
            f64::INFINITY
        }
    };

    // Sustain reads past the analysis window (up to 500 ms past the
    // attack): inside 130 ms every sustained sound saturates identically,
    // which made the feature a constant. Same smoothed envelope, longer
    // look — zero-crossings must not vote, so raw samples are out.
    let sustain_s = if peak <= 0.0 {
        0.0
    } else {
        let long = crate::window_samples(y, sr, attack_s, WIN_START_S, 0.500);
        let env_long = envelope(&long);
        env_long.iter().filter(|&&v| v >= 0.10 * peak).count() as f64 / sr as f64
    };

    let zcr = {
        let mut crossings = 0usize;
        for pair in attack.windows(2) {
            if (pair[0] < 0.0) != (pair[1] < 0.0) {
                crossings += 1;
            }
        }
        crossings as f64 / attack.len().max(1) as f64
    };

    let sub_attacks = if peak <= 0.0 {
        0
    } else {
        // Prominence, not a flat threshold: noise bursts wiggle above any
        // fixed fraction of peak, but only real flams stand out from their
        // surroundings. Same scipy-semantics picker as the onset stage, on
        // a syllabic-scale envelope — the millisecond smoothing keeps tone
        // ripple (a 200 Hz partial peaks every 5 ms), which is cycles, not
        // flams.
        let wide = 128usize.min(env.len());
        let mut slow = vec![0.0; env.len()];
        let mut running = 0.0;
        for (i, &v) in env.iter().enumerate() {
            running += v;
            if i >= wide {
                running -= env[i - wide];
            }
            slow[i] = running / wide.min(i + 1) as f64;
        }
        let slow_peak = slow.iter().copied().fold(0.0f64, f64::max);
        let first_30ms = ((0.030 * sr as f64) as usize).min(slow.len());
        let distance = ((0.002 * sr as f64).round() as usize).max(1);
        overtone_dsp::peaks::find_peaks(
            &slow[..first_30ms],
            distance,
            Some(0.25 * slow_peak),
            Some(0.30 * slow_peak),
        )
        .len()
    };

    let chroma_change = {
        let n_fft = 4096;
        let mag = spectrum(&attack, n_fft);
        let pre_mag = spectrum(&pre, n_fft);
        // A chord change is read from the harmonic register. Below
        // CHORD_FLOOR_HZ sits a kick's fundamental (40-100 Hz), which chroma
        // now places on its true note: left in, a kick on a sustained pad
        // reads as a new pitch class and the feature fires on drums.
        let floor_bin = (CHORD_FLOOR_HZ * n_fft as f64 / sr as f64).ceil() as usize;
        // Fold both into chroma via the DSP crate and read the distance.
        let rows: Vec<Vec<f64>> = [&mag, &pre_mag]
            .iter()
            .map(|m| {
                m.iter()
                    .enumerate()
                    .map(|(bin, &v)| if bin < floor_bin { 0.0 } else { v * v })
                    .collect()
            })
            .collect();
        let chroma = overtone_dsp::chroma::chroma(&rows, sr, n_fft);
        if chroma.len() == 2 {
            let (a, b) = (&chroma[1], &chroma[0]);
            let dot: f64 = a.iter().zip(b.iter()).map(|(&x, &y)| x * y).sum();
            let (na, nb): (f64, f64) = (
                a.iter().map(|&x| x * x).sum::<f64>().sqrt(),
                b.iter().map(|&x| x * x).sum::<f64>().sqrt(),
            );
            if na > 0.0 && nb > 0.0 {
                (1.0 - dot / (na * nb)).clamp(0.0, 1.0)
            } else {
                0.0
            }
        } else {
            0.0
        }
    };

    Temporal {
        rise_s,
        decay_tau_s,
        sustain_s,
        zcr,
        sub_attacks,
        chroma_change,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decaying tone hit in a buffer, plus optional white-noise burst.
    fn hit(sr: u32, at: f64, freq: f64, decay: f64, noise: f64, seed: u64) -> Vec<f32> {
        let mut rng = seed;
        let mut roll = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((rng >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        let n = (3.0 * sr as f64) as usize;
        let start = (at * sr as f64) as usize;
        let mut y = vec![0.0f32; n];
        for (i, v) in y.iter_mut().enumerate().skip(start) {
            let dt = (i - start) as f64 / sr as f64;
            *v = ((2.0 * std::f64::consts::PI * freq * dt).sin() * (-dt / decay).exp()
                + noise * roll() * (-dt / 0.01).exp()) as f32;
        }
        let peak = y.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        y.iter().map(|v| v / peak * 0.99).collect()
    }

    /// Three noise flams 8 ms apart: a clap.
    fn clap(sr: u32, at: f64) -> Vec<f32> {
        let mut rng = 99u64;
        let mut roll = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((rng >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        let n = (3.0 * sr as f64) as usize;
        let mut y = vec![0.0f32; n];
        for k in 0..3 {
            let start = (at * sr as f64) as usize + k * (0.008 * sr as f64) as usize;
            let burst = (0.03 * sr as f64) as usize;
            for (i, v) in y.iter_mut().enumerate().skip(start).take(burst) {
                let dt = (i - start) as f64 / sr as f64;
                *v += (roll() * (-dt / 0.004).exp()) as f32;
            }
        }
        let peak = y.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        y.iter().map(|v| v / peak * 0.99).collect()
    }

    #[test]
    fn rise_separates_click_from_swell() {
        let sr = 44_100;
        let fast = analyze(&hit(sr, 1.0, 200.0, 0.05, 0.0, 1), sr, 1.0);
        assert!(fast.rise_s < 0.005, "fast rise {}", fast.rise_s);
        // Slow swell: 300 ms attack lives mostly past the rise window.
        let mut y = vec![0.0f32; (3.0 * sr as f64) as usize];
        for (i, slot) in y.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            if t >= 1.0 {
                let dt = t - 1.0;
                let attack = 0.5 - 0.5 * (std::f64::consts::PI * (dt / 0.3).min(1.0)).cos();
                *slot = (0.5 * (2.0 * std::f64::consts::PI * 220.0 * t).sin() * attack) as f32;
            }
        }
        let slow = analyze(&y, sr, 1.0);
        assert!(
            slow.rise_s > 10.0 * fast.rise_s.max(1e-4),
            "slow {}",
            slow.rise_s
        );
    }

    #[test]
    fn decay_tau_reads_the_envelope() {
        let sr = 44_100;
        let snappy = analyze(&hit(sr, 1.0, 200.0, 0.05, 0.0, 1), sr, 1.0);
        assert!(
            (0.01..0.12).contains(&snappy.decay_tau_s),
            "tau {}",
            snappy.decay_tau_s
        );
        let long = analyze(&hit(sr, 1.0, 80.0, 0.30, 0.0, 1), sr, 1.0);
        assert!(long.decay_tau_s > 0.15, "tau {}", long.decay_tau_s);
    }

    #[test]
    fn zcr_separates_tone_from_noise() {
        let sr = 44_100;
        let tone = analyze(&hit(sr, 1.0, 220.0, 0.2, 0.0, 1), sr, 1.0);
        // Sustained breath noise under the tone: the window stays noisy, so
        // the rate must read noise-like throughout, not just at the attack.
        let n = (3.0 * sr as f64) as usize;
        let start = (1.0 * sr as f64) as usize;
        let mut y = vec![0.0f32; n];
        let mut rng = 5u64;
        for (i, v) in y.iter_mut().enumerate().skip(start) {
            let dt = (i - start) as f64 / sr as f64;
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let noise = ((rng >> 33) as f64 / (1u64 << 31) as f64) - 0.5;
            *v = (0.3 * (2.0 * std::f64::consts::PI * 220.0 * dt).sin() * (-dt / 0.2).exp()
                + 0.6 * noise * (-dt / 0.3).exp()) as f32;
        }
        let noisy = analyze(&y, sr, 1.0);
        assert!(
            noisy.zcr > 10.0 * tone.zcr.max(1e-4),
            "{} vs {}",
            noisy.zcr,
            tone.zcr
        );
    }

    #[test]
    fn sustain_separates_hit_from_pad() {
        let sr = 44_100;
        let hit = analyze(&hit(sr, 1.0, 200.0, 0.05, 0.0, 1), sr, 1.0);
        assert!(hit.sustain_s < 0.15, "hit {}", hit.sustain_s);
        // Sustained chord: still ringing at the end of the look.
        let n = (3.0 * sr as f64) as usize;
        let mut y = vec![0.0f32; n];
        for (i, slot) in y.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            if t >= 1.0 {
                *slot = (0.4 * (2.0 * std::f64::consts::PI * 261.63 * t).sin()) as f32;
            }
        }
        let pad = analyze(&y, sr, 1.0);
        assert!(pad.sustain_s > 0.4, "pad {}", pad.sustain_s);
    }

    #[test]
    fn sub_attacks_count_the_flam() {
        let sr = 44_100;
        let clap_t = analyze(&clap(sr, 1.0), sr, 1.0);
        assert!(
            (2..=4).contains(&clap_t.sub_attacks),
            "clap {}",
            clap_t.sub_attacks
        );
        let snare = analyze(&hit(sr, 1.0, 200.0, 0.05, 0.5, 1), sr, 1.0);
        assert_eq!(snare.sub_attacks, 1, "snare {}", snare.sub_attacks);
    }

    #[test]
    fn chroma_change_fires_on_chords_not_drums() {
        let sr = 44_100;
        // Same chord before and after: kick over a sustained pad.
        let mut y = vec![0.0f32; (3.0 * sr as f64) as usize];
        for (i, slot) in y.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            *slot = (0.2 * (2.0 * std::f64::consts::PI * 130.81 * t).sin()) as f32;
        }
        let kick_at = (1.0 * sr as f64) as usize;
        for (i, v) in y.iter_mut().enumerate().skip(kick_at) {
            let dt = (i - kick_at) as f64 / sr as f64;
            if dt > 0.2 {
                break;
            }
            *v +=
                (0.8 * (2.0 * std::f64::consts::PI * 55.0 * dt).sin() * (-dt / 0.03).exp()) as f32;
        }
        let same = analyze(&y, sr, 1.0);
        // New chord at the attack: C major pad under an F major stab.
        let mut z = vec![0.0f32; (3.0 * sr as f64) as usize];
        for (i, slot) in z.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            if t < 1.0 {
                *slot = (0.2 * (2.0 * std::f64::consts::PI * 261.63 * t).sin()) as f32;
            } else {
                let dt = t - 1.0;
                let attack = 0.5 - 0.5 * (std::f64::consts::PI * (dt / 0.05).min(1.0)).cos();
                *slot = (0.5
                    * attack
                    * ((2.0 * std::f64::consts::PI * 174.61 * t).sin()
                        + 0.5 * (2.0 * std::f64::consts::PI * 220.0 * t).sin()))
                    as f32;
            }
        }
        let changed = analyze(&z, sr, 1.0);
        assert!(same.chroma_change < 0.3, "same {}", same.chroma_change);
        assert!(
            changed.chroma_change > 2.0 * same.chroma_change.max(0.05),
            "changed {} vs same {}",
            changed.chroma_change,
            same.chroma_change
        );
    }
}
