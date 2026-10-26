//! Synthetic labelled drum corpus: ground truth without a licence.
//!
//! Public drum-transcription datasets are mostly research-only, which makes
//! shipping weights trained on them a licensing question nobody wants. The
//! answer is the one the tempo benchmark already uses: synthesise, and emit
//! the label of every hit placed alongside the audio. [`render`] keeps one
//! schedule -- the classes cycle in order at a fixed spacing -- and varies
//! only velocity, pitch and decay; [`render_shuffled`] also varies the class
//! order, the spacing and the level, which is what a held-out evaluation
//! needs. The seed fixes everything, so a rerun reproduces a run bit-for-bit.
//!
//! Thirteen classes: eight drums (kick, snare, clap, closed and open hat,
//! tom, crash, ride), four pitched sources (bass, guitar, keys, vocal) and
//! `other` as soft sustained chord stabs — `other` is a real class that
//! fires often, and an attack the engine cannot characterise must never be
//! forced into a drum. Results on synthetic drums are an upper bound, as
//! the timeline states for tempo; the honest complement is a hand-labelled
//! set of real tracks.

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
    Ride,
    Bass,
    Guitar,
    Keys,
    Vocal,
}

impl HitClass {
    /// Lowercase name for evidence output (`hat_closed`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            HitClass::Kick => "kick",
            HitClass::Snare => "snare",
            HitClass::Clap => "clap",
            HitClass::HatClosed => "hat_closed",
            HitClass::HatOpen => "hat_open",
            HitClass::Tom => "tom",
            HitClass::Cymbal => "cymbal",
            HitClass::Other => "other",
            HitClass::Ride => "ride",
            HitClass::Bass => "bass",
            HitClass::Guitar => "guitar",
            HitClass::Keys => "keys",
            HitClass::Vocal => "vocal",
        }
    }

    pub const ALL: [HitClass; 13] = [
        HitClass::Kick,
        HitClass::Snare,
        HitClass::Clap,
        HitClass::HatClosed,
        HitClass::HatOpen,
        HitClass::Tom,
        HitClass::Cymbal,
        HitClass::Other,
        HitClass::Ride,
        HitClass::Bass,
        HitClass::Guitar,
        HitClass::Keys,
        HitClass::Vocal,
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

    pub fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
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
        let velocity = 0.7 + 0.3 * rng.next_f64();
        place(&mut samples, sr, t, class, velocity, &mut rng);
        hits.push(Hit {
            class,
            time_s: t,
            velocity,
        });
        t += spacing_s;
        k += 1;
    }
    peak_normalise(&mut samples);
    CorpusTrack { samples, sr, hits }
}

/// Like [`render`], but with a schedule of its own: each cycle plays the
/// classes in a seeded random order, each gap is drawn from `spacing_s`
/// (lo, hi), and velocity spans 0.5-1.0. Two seeds give two different
/// arrangements -- which [`render`] never does: its hits land at the same
/// times, in the same order, after the same neighbours, whatever the seed.
pub fn render_shuffled(
    sr: u32,
    duration_s: f64,
    spacing_s: (f64, f64),
    classes: &[HitClass],
    seed: u64,
) -> CorpusTrack {
    let n = (duration_s * sr as f64) as usize;
    let mut samples = vec![0.0f32; n];
    let mut rng = Rng::new(seed);
    let mut hits = Vec::new();
    let mut order: Vec<HitClass> = Vec::new();
    let mut t = 0.5;
    while t < duration_s - 0.5 {
        if order.is_empty() {
            order = classes.to_vec();
            for i in (1..order.len()).rev() {
                let j = ((rng.next_f64() * (i + 1) as f64) as usize).min(i);
                order.swap(i, j);
            }
        }
        let class = order.pop().expect("refilled above");
        let velocity = 0.5 + 0.5 * rng.next_f64();
        place(&mut samples, sr, t, class, velocity, &mut rng);
        hits.push(Hit {
            class,
            time_s: t,
            velocity,
        });
        t += spacing_s.0 + (spacing_s.1 - spacing_s.0) * rng.next_f64();
    }
    peak_normalise(&mut samples);
    CorpusTrack { samples, sr, hits }
}

fn place(buf: &mut [f32], sr: u32, at: f64, class: HitClass, velocity: f64, rng: &mut Rng) {
    let start = (at * sr as f64) as usize;
    // (tone freq, tone decay, tone amp, noise amp, noise decay, extra flams)
    let (freq, decay, tone_amp, noise_amp, noise_decay, flams): (f64, f64, f64, f64, f64, usize) =
        match class {
            HitClass::Kick => (
                55.0 + 10.0 * rng.next_f64(),
                0.020 + 0.008 * rng.next_f64(),
                1.0,
                0.0,
                0.005,
                0,
            ),
            HitClass::Snare => (180.0 + 40.0 * rng.next_f64(), 0.050, 0.7, 0.5, 0.010, 0),
            HitClass::Clap => (200.0, 0.030, 0.3, 0.8, 0.004, 3),
            HitClass::HatClosed => (0.0, 0.030, 0.0, 1.0, 0.008, 0),
            HitClass::HatOpen => (0.0, 0.150, 0.0, 1.0, 0.030, 0),
            HitClass::Tom => (0.0, 0.150, 0.0, 0.1, 0.010, 0),
            HitClass::Cymbal => (0.0, 0.800, 0.0, 0.0, 0.200, 0),
            HitClass::Other => (0.0, 0.400, 0.0, 0.0, 0.100, 0),
            // Fully bespoke branches below; the tuple carries silence.
            HitClass::Ride
            | HitClass::Bass
            | HitClass::Guitar
            | HitClass::Keys
            | HitClass::Vocal => (0.0, 0.300, 0.0, 0.0, 0.100, 0),
        };
    // The "metallic" voices get plain white noise here, with no partials:
    // the hats are nothing else, and the crash adds its own branch below
    // (a slower noise wash under four inharmonic partials from 1.6 kHz).
    // `other` is a soft major triad stab (pitched, sustained,
    // unpercussive). Ride, bass, guitar, keys and vocal render fully in
    // their own branches below — the generic loop stays silent for them.
    let metallic = matches!(
        class,
        HitClass::Cymbal | HitClass::HatClosed | HitClass::HatOpen
    );
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
            let n = rng.next_f64() * 2.0 - 1.0;
            // Metallic voices override only the amplitude; their decay is
            // already per class in the table (cymbal 0.2 s, hats 30/8 ms).
            let amp = if metallic { 0.6 } else { noise_amp };
            v += amp * n * (-dt / noise_decay).exp();
        }
        buf[start + i] += (v * velocity) as f32;
    }
    // Bespoke voices render in their own loops below. They used to sit
    // inside the generic per-sample loop, which re-ran them per sample:
    // a tom cost 1.4B iterations (wrong audio and a hang in one).
    if matches!(class, HitClass::Other) {
        // Soft C-major stab: C4+E4+G4 with real harmonic series, slow
        // attack, long sustain. Pure sines carry no harmonicity and
        // read as unpitched - no real sustained instrument sounds so
        // pure, and the templates rightly refuse it.
        for j in 0..hit_len {
            if start + j >= buf.len() {
                break;
            }
            let dt = j as f64 / sr as f64;
            let attack = 0.5 - 0.5 * (std::f64::consts::PI * (dt / 0.15).min(1.0)).cos();
            let mut v = 0.0;
            for &f in &[261.63, 329.63, 392.0] {
                for (h, amp) in [(1.0, 0.3), (2.0, 0.15), (3.0, 0.08)] {
                    v += amp * (2.0 * std::f64::consts::PI * f * h * dt).sin();
                }
            }
            v *= attack * (-dt / 0.4).exp();
            buf[start + j] += (v * velocity) as f32;
        }
    }
    if matches!(class, HitClass::Cymbal) {
        // Real crash: broadband noise wash with slow decay under
        // inharmonic shimmer voiced high (a crash lives at 3-8 kHz,
        // not at 800 Hz). The wash carries the high/air energy the
        // template reads; partials alone read as mid-heavy snare.
        for j in 0..hit_len {
            if start + j >= buf.len() {
                break;
            }
            let dt = j as f64 / sr as f64;
            let mut v = 0.0;
            for &ratio in &[1.0, 1.483, 2.09, 2.94] {
                v += 0.2 * (2.0 * std::f64::consts::PI * 1600.0 * ratio * dt).sin();
            }
            v = v * (-dt / 0.8).exp() + 1.0 * (rng.next_f64() * 2.0 - 1.0) * (-dt / 0.25).exp();
            buf[start + j] += (v * velocity) as f32;
        }
    }
    // Crack and partials render in their own loops AFTER the generic
    // voice: nesting them per sample re-ran them per sample (a tom cost
    // 1.4B iterations and 53k overdubs — wrong audio and a hang in one).
    // Value-assigning voices above stay inline: reassignment is idempotent.
    if matches!(class, HitClass::Snare) {
        // Wires: broadband crack on top of the body, without which the
        // recipe is a tom and the templates rightly say so.
        for i in 0..(0.02 * sr as f64) as usize {
            if start + i >= buf.len() {
                break;
            }
            let dt = i as f64 / sr as f64;
            buf[start + i] += (0.5
                * (2.0 * std::f64::consts::PI * 3200.0 * dt).sin()
                * (-dt / 0.008).exp()
                * velocity) as f32;
        }
    }
    if matches!(class, HitClass::Tom) {
        // Real toms ring a series, not a sine: the upper partials feed
        // the low-mid band and lock the HPS fundamental. A pure sine
        // reads an octave down and starves its own template.
        let root = 90.0 + 20.0 * rng.next_f64();
        let decay = 0.150 + 0.05 * rng.next_f64();
        for i in 0..(0.6 * sr as f64) as usize {
            if start + i >= buf.len() {
                break;
            }
            let dt = i as f64 / sr as f64;
            let mut partials = 0.0;
            for (h, amp) in [(1.0, 0.9), (2.0, 0.5), (3.0, 0.25)] {
                partials += amp * (2.0 * std::f64::consts::PI * root * h * dt).sin();
            }
            buf[start + i] += (partials * (-dt / decay).exp() * velocity) as f32;
        }
    }
    if matches!(class, HitClass::Ride) {
        // Metallic ping with a mid decay: a crash cut to a third, plus
        // a clear ping partial the crash buries in shimmer.
        for j in 0..hit_len {
            if start + j >= buf.len() {
                break;
            }
            let dt = j as f64 / sr as f64;
            let mut v = 0.0;
            for &(ratio, amp) in &[(1.0, 0.45), (1.51, 0.25), (2.09, 0.2)] {
                v += amp * (2.0 * std::f64::consts::PI * 620.0 * ratio * dt).sin();
            }
            v = v * (-dt / 0.3).exp() + 0.3 * (rng.next_f64() * 2.0 - 1.0) * (-dt / 0.02).exp();
            buf[start + j] += (v * velocity) as f32;
        }
    }
    if matches!(class, HitClass::Bass) {
        // Low sustained E with harmonics: pitched like a kick, long
        // like a pad. Decay, not punch, separates them.
        let f0 = 41.0 + 7.0 * rng.next_f64();
        for j in 0..hit_len {
            if start + j >= buf.len() {
                break;
            }
            let dt = j as f64 / sr as f64;
            let mut v = 0.0;
            for (h, amp) in [(1.0, 0.9), (2.0, 0.5), (3.0, 0.25)] {
                v += amp * (2.0 * std::f64::consts::PI * f0 * h * dt).sin();
            }
            v *= (-dt / 0.45).exp();
            buf[start + j] += (v * velocity) as f32;
        }
    }
    if matches!(class, HitClass::Guitar) {
        // Power chord with a pick attack: E2+B2+E3, fast bite, singing
        // sustain. No hammer noise - that belongs to keys.
        for j in 0..hit_len {
            if start + j >= buf.len() {
                break;
            }
            let dt = j as f64 / sr as f64;
            let attack = 0.5 - 0.5 * (std::f64::consts::PI * (dt / 0.008).min(1.0)).cos();
            let mut v = 0.0;
            for &f in &[82.41, 123.47, 164.81] {
                v += 0.35 * (2.0 * std::f64::consts::PI * f * dt).sin();
            }
            v *= attack * (-dt / 0.45).exp();
            buf[start + j] += (v * velocity) as f32;
        }
    }
    if matches!(class, HitClass::Keys) {
        // Piano-ish: C4 chord, hammer noise up front, highs dying first
        // (per-partial decay quickening with frequency).
        for j in 0..hit_len {
            if start + j >= buf.len() {
                break;
            }
            let dt = j as f64 / sr as f64;
            let mut v = 0.0;
            for (h, base) in [(1.0, 261.63), (2.0, 261.63), (3.0, 261.63), (4.0, 261.63)] {
                let f = base * h;
                v +=
                    0.3 / h * (2.0 * std::f64::consts::PI * f * dt).sin() * (-dt / (0.5 / h)).exp();
            }
            v += 0.4 * (rng.next_f64() * 2.0 - 1.0) * (-dt / 0.005).exp();
            buf[start + j] += (v * velocity) as f32;
        }
    }
    if matches!(class, HitClass::Vocal) {
        // Vowel "ah": formant bumps, gentle 5 Hz vibrato, soft attack,
        // sustained. Root varies per take; the formants do not, which
        // is what makes it a vowel and not a note.
        let root = 240.0 + 40.0 * rng.next_f64();
        let bump = |f: f64, c: f64| (-((f - c) / 220.0).powi(2)).exp();
        // Phase-integrated vibrato: sin(2π·f(t)·t) with varying f(t)
        // is FM garbage spraying kilohertz, not vibrato. The phase is
        // the closed-form integral instead: 2π·f·(t + depth·(1-cos)/w).
        let omega = 2.0 * std::f64::consts::PI * 5.0;
        for j in 0..hit_len {
            if start + j >= buf.len() {
                break;
            }
            let dt = j as f64 / sr as f64;
            let attack = 0.5 - 0.5 * (std::f64::consts::PI * (dt / 0.08).min(1.0)).cos();
            let mut v = 0.0;
            for h in 1..=10 {
                let f = root * h as f64;
                let phase = 2.0 * std::f64::consts::PI * f * dt
                    + 2.0 * std::f64::consts::PI * f * 0.02 * (1.0 - (omega * dt).cos()) / omega;
                v += (0.4 * bump(f, 500.0) + 0.4 * bump(f, 1500.0) + 0.4 * bump(f, 2500.0) + 0.05)
                    * phase.sin();
            }
            v *= attack * (-dt / 0.6).exp() * 0.15;
            buf[start + j] += (v * velocity) as f32;
        }
    }
    // Clap flams: two extra noise bursts 8 and 16 ms later.
    for f in 0..flams.min(2) {
        let extra = start + ((0.008 * (f + 1) as f64) * sr as f64) as usize;
        for i in 0..(0.02 * sr as f64) as usize {
            if extra + i >= buf.len() {
                break;
            }
            let dt = i as f64 / sr as f64;
            buf[extra + i] +=
                (0.7 * (rng.next_f64() * 2.0 - 1.0) * (-dt / 0.004).exp() * velocity) as f32;
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
