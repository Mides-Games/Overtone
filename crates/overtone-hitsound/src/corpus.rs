//! Synthetic labelled drum corpus: ground truth without a licence.
//!
//! Public drum-transcription datasets are mostly research-only, which makes
//! shipping weights trained on them a licensing question nobody wants. The
//! answer is the one the tempo benchmark already uses: synthesise, and emit
//! the label of every hit placed alongside the audio. Tempo, velocity, mix
//! balance and overlap density vary per render; the seed fixes everything,
//! so a rerun reproduces a run bit-for-bit.
//!
//! Eight classes (seven drums plus `other` as sustained chord stabs —
//! `other` is a real class that fires often, and an attack the engine
//! cannot characterise must never be forced into a drum). Results on
//! synthetic drums are an upper bound, as the timeline states for tempo;
//! the honest complement is a hand-labelled set of real tracks.

use std::collections::HashMap;

/// Instrument classes the templates decide between.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HitClass {
    Kick,
    Snare,
    Clap,
    HatClosed,
    HatOpen,
    Tom,
    Cymbal,
    Other,
}

impl HitClass {
    pub const ALL: [HitClass; 8] = [
        HitClass::Kick,
        HitClass::Snare,
        HitClass::Clap,
        HitClass::HatClosed,
        HitClass::HatOpen,
        HitClass::Tom,
        HitClass::Cymbal,
        HitClass::Other,
    ];
}

/// One placed hit: what, when, and how loud.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub class: HitClass,
    pub time_s: f64,
    pub velocity: f64,
}

/// Deterministic stream of uniform [0, 1) draws.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1);
        ((self.0 >> 33) as f64 / (1u64 << 31) as f64).clamp(0.0, 1.0)
    }
}

/// A rendered track: audio plus the label of every hit in it.
pub struct CorpusTrack {
    pub samples: Vec<f32>,
    pub sr: u32,
    pub hits: Vec<Hit>,
}

/// Render `classes` cycling at `spacing_s` over `duration_s`, with per-hit
/// velocity, pitch and decay jitter drawn from `seed`. Every number below
/// is a drum recipe, not a sample: variations stay musical (kicks 55–65 Hz,
/// snares 180–220 Hz plus noise) so the corpus teaches timbre, not trivia.
pub fn render(
    sr: u32,
    duration_s: f64,
    spacing_s: f64,
    classes: &[HitClass],
    seed: u64,
) -> CorpusTrack {
    let n = (duration_s * sr as f64) as usize;
    let mut samples = vec![0.0f32; n];
    let mut rng = Rng::new(seed);
    let mut hits = Vec::new();
    let mut t = 0.5;
    let mut k = 0usize;
    while t < duration_s - 0.5 {
        let class = classes[k % classes.len()];
        let velocity = 0.7 + 0.3 * rng.next();
        place(&mut samples, sr, t, class, velocity, &mut rng);
        hits.push(Hit { class, time_s: t, velocity });
        t += spacing_s;
        k += 1;
    }
    peak_normalise(&mut samples);
    CorpusTrack { samples, sr, hits }
}

fn place(buf: &mut [f32], sr: u32, at: f64, class: HitClass, velocity: f64, rng: &mut Rng) {
    let start = (at * sr as f64) as usize;
    // (tone freq, tone decay, tone amp, noise amp, noise decay, extra flams)
    let (freq, decay, tone_amp, noise_amp, noise_decay, flams): (f64, f64, f64, f64, f64, usize) =
        match class {
            HitClass::Kick => (55.0 + 10.0 * rng.next(), 0.020 + 0.008 * rng.next(), 1.0, 0.0, 0.005, 0),
            HitClass::Snare => (180.0 + 40.0 * rng.next(), 0.050, 0.7, 0.5, 0.010, 0),
            HitClass::Clap => (200.0, 0.030, 0.3, 0.8, 0.004, 3),
            HitClass::HatClosed => (0.0, 0.030, 0.0, 1.0, 0.008, 0),
            HitClass::HatOpen => (0.0, 0.150, 0.0, 1.0, 0.030, 0),
            HitClass::Tom => (90.0 + 20.0 * rng.next(), 0.150 + 0.05 * rng.next(), 0.9, 0.1, 0.010, 0),
            HitClass::Cymbal => (0.0, 0.800, 0.0, 0.0, 0.200, 0),
            HitClass::Other => (0.0, 0.400, 0.0, 0.0, 0.100, 0),
        };
    // Cymbals and hats are noise coloured by rough metallic partials;
    // `other` is a soft major triad stab (pitched, sustained, unpercussive).
    let metallic = matches!(class, HitClass::Cymbal | HitClass::HatClosed | HitClass::HatOpen);
    let hit_len = (1.2 * sr as f64) as usize;
    for i in 0..hit_len {
        if start + i >= buf.len() {
            break;
        }
        let dt = i as f64 / sr as f64;
        let mut v = 0.0;
        if tone_amp > 0.0 && freq > 0.0 {
            v += tone_amp * (2.0 * std::f64::consts::PI * freq * dt).sin() * (-dt / decay).exp();
        }
        if noise_amp > 0.0 || metallic {
            let n = rng.next() * 2.0 - 1.0;
            let amp = if metallic { 0.6 } else { noise_amp };
            let dec = if metallic { noise_decay } else { noise_decay };
            v += amp * n * (-dt / dec).exp();
        }
        if matches!(class, HitClass::Other) {
            // Soft C-major stab: C4+E4+G4, slow attack, long sustain.
            let attack = 0.5 - 0.5 * (std::f64::consts::PI * (dt / 0.15).min(1.0)).cos();
            v = 0.0;
            for &f in &[261.63, 329.63, 392.0] {
                v += 0.3 * (2.0 * std::f64::consts::PI * f * dt).sin();
            }
            v *= attack * (-dt / 0.4).exp();
        }
        if matches!(class, HitClass::Cymbal) {
            // Inharmonic shimmer: partials at non-integer ratios.
            v = 0.0;
            for &ratio in &[1.0, 1.483, 2.09, 2.94] {
                v += 0.25 * (2.0 * std::f64::consts::PI * 800.0 * ratio * dt).sin();
            }
            v *= (-dt / 0.8).exp() * (0.5 + 0.5 * rng.next());
        }
        buf[start + i] += (v * velocity) as f32;
    }
    // Clap flams: two extra noise bursts 8 and 16 ms later.
    for f in 0..flams.min(2) {
        let extra = start + ((0.008 * (f + 1) as f64) * sr as f64) as usize;
        for i in 0..(0.02 * sr as f64) as usize {
            if extra + i >= buf.len() {
                break;
            }
            let dt = i as f64 / sr as f64;
            buf[extra + i] += (0.7 * (rng.next() * 2.0 - 1.0) * (-dt / 0.004).exp() * velocity) as f32;
        }
    }
}

/// Class counts per track, for balancing assertions.
pub fn class_counts(hits: &[Hit]) -> HashMap<HitClass, usize> {
    let mut counts = HashMap::new();
    for hit in hits {
        *counts.entry(hit.class).or_insert(0) += 1;
    }
    counts
}

fn peak_normalise(buf: &mut [f32]) {
    let peak = buf.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
    for v in buf.iter_mut() {
        *v = *v / peak * 0.99;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_is_deterministic_per_seed() {
        let a = render(44_100, 8.0, 0.5, &HitClass::ALL, 11);
        let b = render(44_100, 8.0, 0.5, &HitClass::ALL, 11);
        assert_eq!(a.samples, b.samples);
        assert_eq!(a.hits, b.hits);
        let c = render(44_100, 8.0, 0.5, &HitClass::ALL, 12);
        assert_ne!(a.samples, c.samples);
    }

    #[test]
    fn every_class_gets_hits() {
        let track = render(44_100, 20.0, 0.5, &HitClass::ALL, 11);
        let counts = class_counts(&track.hits);
        for class in HitClass::ALL {
            assert!(
                counts.get(&class).copied().unwrap_or(0) >= 2,
                "class {class:?} missing: {counts:?}"
            );
        }
        // Labels stay inside the audio.
        for hit in &track.hits {
            assert!(hit.time_s >= 0.0 && hit.time_s < 20.0);
        }
    }

    #[test]
    fn hits_are_peak_normalised() {
        let track = render(44_100, 8.0, 0.5, &HitClass::ALL, 11);
        let peak = track.samples.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        assert!((peak - 0.99).abs() < 1e-6);
    }
}
