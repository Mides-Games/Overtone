//! Hitsound analysis: what the music is doing at each attack, defensibly.
//!
//! Pipeline (docs/06-hitsound-engine.md): per-attack features → instrument
//! likelihoods → (object context and Viterbi come later, with the `.osu`
//! reader) → explanations. Every decision itemises its evidence, because a
//! mapper who disagrees must see *why* before overriding.
//!
//! This crate starts where the tempo engine stops: it takes audio plus
//! attack times and characterises each attack. Loudness invariance is a
//! standing rule — ratios, never absolutes — so a mastered track and its
//! demo read the same.

pub mod spectral;
pub mod temporal;

/// Analysis windows around each attack, in seconds (docs §2).
pub const PRE_START_S: f64 = -0.060;
pub const PRE_END_S: f64 = -0.010;
pub const WIN_START_S: f64 = -0.010;
pub const WIN_END_S: f64 = 0.120;

/// Samples for `[from_s, to_s)` around `attack_s`, zero-padded past the ends
/// so edge attacks analyse instead of panicking.
pub(crate) fn window_samples(y: &[f32], sr: u32, attack_s: f64, from_s: f64, to_s: f64) -> Vec<f64> {
    let start = ((attack_s + from_s) * sr as f64).round() as i64;
    let end = ((attack_s + to_s) * sr as f64).round() as i64;
    (start..end.max(start))
        .map(|i| {
            if i < 0 || i as usize >= y.len() {
                0.0
            } else {
                y[i as usize] as f64
            }
        })
        .collect()
}
