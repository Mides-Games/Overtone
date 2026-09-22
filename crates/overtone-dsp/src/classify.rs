//! Section labels from structure: which repeated part is which.
//!
//! The structure stage finds *where* phrases change; this names them for the
//! hitsound engine's per-section profiles. Rules, in order, each cheap and
//! stated plainly because labelling pop form by heuristics is approximate
//! by nature (the learned labeller stays a Phase 9 experiment):
//!
//! 1. Segments sharing harmonic material (segment-mean chroma cosine at or
//!    above [`REPEAT_COSINE`]) belong to one repetition group.
//! 2. The loudest repeated group is the **Chorus** — but only when at least
//!    two groups repeat, because chorus-ness is relative (louder *than the
//!    verse*). A single repeated family defaults to **Verse**; crowning it
//!    Chorus from energy alone invents information.
//!    Loudness decides only *within* repetition — a loud one-off is a
//!    bridge, not a chorus.
//! 3. Unique edge segments are **Intro** (first, under [`INTRO_MAX_S`]) and
//!    **Outro** (last, any length).
//! 4. Any other unique segment is a **Bridge**.
//! 5. A track with a single segment is a **Verse**: the neutral default.
//!
//! Known approximations, recorded not hidden: a long opening maps to
//! Bridge, and two different quiet sections sharing chords merge into one
//! Verse group. Both need intent (or lyrics) no audio statistic carries.

use crate::chroma;

/// Cosine similarity at or above which two segments count as repetitions.
/// Same-chord repeats score ~1.0; triads a fourth apart ~0.3–0.5.
pub const REPEAT_COSINE: f64 = 0.90;
/// A unique opening longer than this is a section, not an introduction.
pub const INTRO_MAX_S: f64 = 12.0;

/// Pop-form role of one segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionKind {
    Intro,
    Verse,
    Chorus,
    Bridge,
    Outro,
}

/// One labelled span of the track.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LabeledSection {
    pub start: f64,
    pub end: f64,
    pub kind: SectionKind,
}

/// Label the segments implied by `boundaries` (plus track start/end).
/// Empty in, empty out.
pub fn classify(y: &[f32], sr: u32, boundaries: &[f64]) -> Vec<LabeledSection> {
    let duration = y.len() as f64 / sr as f64;
    let mut edges: Vec<f64> = vec![0.0];
    edges.extend(boundaries.iter().copied());
    edges.push(duration);
    // Sort before dedup: dedup only collapses neighbours, and an unsorted
    // caller must not produce zero-length spans downstream.
    edges.sort_by(f64::total_cmp);
    edges.dedup();
    if edges.len() < 2 {
        return Vec::new();
    }
    let spans: Vec<(f64, f64)> = edges.windows(2).map(|w| (w[0], w[1])).collect();
    if spans.len() == 1 {
        return vec![LabeledSection {
            start: spans[0].0,
            end: spans[0].1,
            kind: SectionKind::Verse,
        }];
    }

    // Segment-mean chroma plus mean energy, on the structure grid.
    let n_fft = 2048;
    let spec = crate::stft::power_spectrogram(y, n_fft, 128);
    let chroma = chroma::chroma(&spec, sr, n_fft);
    // Segment seconds to STFT frame indices (128 hop).
    let to_frame = |t: f64| t * sr as f64 / 128.0;
    let mut signatures: Vec<[f64; 12]> = Vec::new();
    let mut energies: Vec<f64> = Vec::new();
    for &(start, end) in &spans {
        let lo = (to_frame(start).floor() as usize).min(chroma.len());
        let hi = (to_frame(end).ceil() as usize).min(chroma.len());
        let mut mean = [0.0f64; 12];
        let mut count = 0usize;
        if hi > lo {
            for frame in &chroma[lo..hi] {
                for (c, acc) in mean.iter_mut().enumerate() {
                    *acc += frame[c];
                }
                count += 1;
            }
            if count > 0 {
                for acc in mean.iter_mut() {
                    *acc /= count as f64;
                }
            }
        }
        signatures.push(mean);
        let s0 = (start * sr as f64) as usize;
        let s1 = (end * sr as f64).min(y.len() as f64) as usize;
        let energy = if s1 > s0 {
            y[s0..s1].iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / (s1 - s0) as f64
        } else {
            0.0
        };
        energies.push(energy);
    }

    // Repetition groups by transitive closure over the cosine threshold.
    let n = spans.len();
    let mut group: Vec<usize> = (0..n).collect();
    let cosine = |a: usize, b: usize| -> f64 {
        let (na, nb): (f64, f64) = (
            signatures[a].iter().map(|&x| x * x).sum::<f64>().sqrt(),
            signatures[b].iter().map(|&x| x * x).sum::<f64>().sqrt(),
        );
        if na <= 0.0 || nb <= 0.0 {
            return 0.0;
        }
        signatures[a]
            .iter()
            .zip(signatures[b].iter())
            .map(|(&x, &y)| x * y)
            .sum::<f64>()
            / (na * nb)
    };
    for a in 0..n {
        for b in a + 1..n {
            if cosine(a, b) >= REPEAT_COSINE {
                let (ga, gb) = (group[a], group[b]);
                for g in group.iter_mut() {
                    if *g == gb {
                        *g = ga;
                    }
                }
            }
        }
    }
    let mut group_energy: std::collections::HashMap<usize, (f64, usize)> =
        std::collections::HashMap::new();
    for (i, &g) in group.iter().enumerate() {
        let entry = group_energy.entry(g).or_insert((0.0, 0));
        entry.0 += energies[i];
        entry.1 += 1;
    }
    let mut group_mean: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
    for (&g, &(sum, count)) in group_energy.iter() {
        group_mean.insert(g, sum / count.max(1) as f64);
    }
    let mut group_size: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for &g in group.iter() {
        *group_size.entry(g).or_insert(0) += 1;
    }
    let repeated: Vec<usize> = group_mean
        .keys()
        .copied()
        .filter(|&g| group_size.get(&g).copied().unwrap_or(0) >= 2)
        .collect();
    let chorus_group = (repeated.len() >= 2)
        .then(|| {
            repeated
                .iter()
                .max_by(|&&a, &&b| {
                    group_mean
                        .get(&a)
                        .copied()
                        .unwrap_or(0.0)
                        .total_cmp(&group_mean.get(&b).copied().unwrap_or(0.0))
                })
                .copied()
        })
        .flatten();

    spans
        .iter()
        .enumerate()
        .map(|(i, &(start, end))| {
            let g = group[i];
            let repeated = group_size.get(&g).copied().unwrap_or(0) >= 2;
            let kind = if repeated {
                if chorus_group == Some(g) {
                    SectionKind::Chorus
                } else {
                    SectionKind::Verse
                }
            } else if i == 0 && end - start < INTRO_MAX_S {
                SectionKind::Intro
            } else if i == n - 1 {
                SectionKind::Outro
            } else {
                SectionKind::Bridge
            };
            LabeledSection { start, end, kind }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sustained triad, peak-normalised with the track.
    fn chord(sr: u32, root: f64, major: bool, amp: f64, seconds: f64) -> Vec<f32> {
        let third = root * if major { 1.2599 } else { 1.1892 };
        let fifth = root * 1.4983;
        let n = (seconds * sr as f64) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / sr as f64;
                let attack = 0.5 - 0.5 * (std::f64::consts::PI * (t / 0.1).min(1.0)).cos();
                (amp * attack
                    * ((2.0 * std::f64::consts::PI * root * t).sin()
                        + 0.6 * (2.0 * std::f64::consts::PI * third * t).sin()
                        + 0.6 * (2.0 * std::f64::consts::PI * fifth * t).sin()
                        + 0.3 * (2.0 * std::f64::consts::PI * root * 2.0 * t).sin()))
                    as f32
            })
            .collect()
    }

    fn concat(parts: &[Vec<f32>]) -> Vec<f32> {
        let mut out = Vec::new();
        for part in parts {
            out.extend_from_slice(part);
        }
        let peak = out.iter().map(|v| v.abs()).fold(0.0f32, f32::max).max(1e-9);
        out.iter().map(|v| v / peak * 0.99).collect()
    }

    fn kinds(y: &[f32], sr: u32, boundaries: &[f64]) -> Vec<SectionKind> {
        classify(y, sr, boundaries).iter().map(|s| s.kind).collect()
    }

    #[test]
    fn intro_verse_chorus_verse_chorus() {
        // I(8 s, quiet Am) V(16 s C) C(16 s F, loud) V C.
        let sr = 44_100;
        let intro = chord(sr, 220.0, false, 0.2, 8.0);
        let verse = chord(sr, 261.63, true, 0.3, 16.0);
        let chorus = chord(sr, 174.61, true, 0.6, 16.0);
        let y = concat(&[intro, verse.clone(), chorus.clone(), verse, chorus]);
        assert_eq!(
            kinds(&y, sr, &[8.0, 24.0, 40.0, 56.0]),
            vec![
                SectionKind::Intro,
                SectionKind::Verse,
                SectionKind::Chorus,
                SectionKind::Verse,
                SectionKind::Chorus,
            ]
        );
    }

    #[test]
    fn verse_verse_chorus_bridge_chorus() {
        // Repetition is the only signal the rules read, so the verse must
        // actually repeat: V V C B C. A one-off opening is a bridge by the
        // same rules, and rightly so — nothing marks it a verse.
        let sr = 44_100;
        let verse = chord(sr, 261.63, true, 0.3, 12.0);
        let chorus = chord(sr, 174.61, true, 0.6, 12.0);
        let bridge = chord(sr, 196.0, true, 0.42, 12.0);
        let y = concat(&[verse.clone(), verse, chorus.clone(), bridge, chorus]);
        assert_eq!(
            kinds(&y, sr, &[12.0, 24.0, 36.0, 48.0]),
            vec![
                SectionKind::Verse,
                SectionKind::Verse,
                SectionKind::Chorus,
                SectionKind::Bridge,
                SectionKind::Chorus,
            ]
        );
    }

    #[test]
    fn verse_verse_outro() {
        // V(12 s C) V(12 s C) O(8 s Am, quiet, unique, last).
        let sr = 44_100;
        let verse = chord(sr, 261.63, true, 0.3, 12.0);
        let outro = chord(sr, 220.0, false, 0.2, 8.0);
        let y = concat(&[verse.clone(), verse, outro]);
        assert_eq!(
            kinds(&y, sr, &[12.0, 24.0]),
            vec![SectionKind::Verse, SectionKind::Verse, SectionKind::Outro]
        );
    }

    #[test]
    fn single_span_defaults_to_verse() {
        let y = chord(44_100, 261.63, true, 0.4, 12.0);
        assert_eq!(kinds(&y, 44_100, &[]), vec![SectionKind::Verse]);
    }
}
