//! Per-attack evidence for the hitsound decision (P-4): class probabilities
//! with each term's contribution, and the attack's musical role.
//!
//! One row per attack, from the audio alone plus the tempo engine's grids:
//! features ([`extract`](crate::template::extract)) read through every
//! template's terms, normalised by softmax
//! ([`classify`](crate::template::classify)), beside the
//! [`role`](crate::role::analyze) the grid and the phrases give it. A mapper
//! who disagrees with H4 reads this row and sees why; every number replays
//! from the shapes in [`Template`](crate::template::Template), never from a
//! hidden model. Plain data, no serialiser: the CLI maps it to JSON.

use overtone_core::GridSection;

use crate::corpus::HitClass;
use crate::role::{self, Role};
use crate::template::{self, Feature, Features, Response, Template};

/// One term's contribution: the feature's value read through its response,
/// times the fitted weight. The class score is the bias plus these.
#[derive(Debug, Clone)]
pub struct TermEvidence {
    pub feature: Feature,
    pub value: f64,
    pub response: Response,
    pub contribution: f64,
}

/// One class for one attack: its softmax probability, its raw score, and
/// every term behind the score, in template order.
#[derive(Debug, Clone)]
pub struct ClassEvidence {
    pub class: HitClass,
    pub probability: f64,
    pub score: f64,
    pub terms: Vec<TermEvidence>,
}

/// Everything H4 gets about one attack: when, how strong, what it sounds
/// like, and where it sits in the music.
#[derive(Debug, Clone)]
pub struct AttackEvidence {
    pub time_s: f64,
    pub weight: f32,
    pub features: Features,
    pub classes: Vec<ClassEvidence>,
    pub role: Role,
}

/// Assemble the evidence rows. `sections` with `bars` are the tempo
/// engine's fitted grids and their `(downbeat class, beats per bar)`, as the
/// tempo crate's `section_measures` reads them; `phrase_edges` are structure
/// boundaries. Empty grids are fine —
/// the role degrades to `None`s where there is no grid to sit on, and the
/// instrument half never needed one.
#[allow(clippy::too_many_arguments)]
pub fn evidence(
    y: &[f32],
    sr: u32,
    times: &[f64],
    weights: &[f32],
    sections: &[GridSection],
    bars: &[(usize, usize)],
    phrase_edges: &[f64],
    templates: &[Template],
) -> Vec<AttackEvidence> {
    let roles = role::analyze(y, sr, times, weights, sections, bars, phrase_edges);
    times
        .iter()
        .zip(weights.iter())
        .zip(roles.into_iter())
        .map(|((&time_s, &weight), role)| {
            let features = template::extract(y, sr, time_s);
            let scores: Vec<f64> = templates.iter().map(|t| t.score(&features)).collect();
            let peak = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let exps: Vec<f64> = scores.iter().map(|&s| (s - peak).exp()).collect();
            let total: f64 = exps.iter().sum();
            let classes = templates
                .iter()
                .zip(scores.iter())
                .zip(exps.iter())
                .map(|((template, &score), &e)| ClassEvidence {
                    class: template.class,
                    probability: e / total.max(1e-12),
                    score,
                    terms: template
                        .terms
                        .iter()
                        .map(|term| {
                            let value = features.value(term.feature);
                            TermEvidence {
                                feature: term.feature,
                                value,
                                response: term.response,
                                contribution: term.weight
                                    * term.response.apply(value),
                            }
                        })
                        .collect(),
                })
                .collect();
            AttackEvidence {
                time_s,
                weight,
                features,
                classes,
                role,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus;

    /// Rendered hits, one per class: the reported contributions replay the
    /// reported scores, term for term, so an explanation built on them
    /// explains the computation and not a copy of it.
    #[test]
    fn contributions_replay_the_scores() {
        let track = corpus::render_shuffled(44_100, 6.0, (0.22, 0.45), &HitClass::ALL, 21);
        let templates = template::initial_templates();
        let rows = evidence(
            &track.samples,
            track.sr,
            &track.hits.iter().map(|h| h.time_s).collect::<Vec<_>>(),
            &track.hits.iter().map(|_| 1.0f32).collect::<Vec<_>>(),
            &[],
            &[],
            &[],
            &templates,
        );
        assert_eq!(rows.len(), track.hits.len());
        for row in &rows {
            assert_eq!(row.classes.len(), templates.len());
            let probs: f64 = row.classes.iter().map(|c| c.probability).sum();
            assert!((probs - 1.0).abs() < 1e-9, "probabilities sum to {probs}");
            for class in &row.classes {
                let replay: f64 = class.terms.iter().map(|t| t.contribution).sum();
                let template = templates
                    .iter()
                    .find(|t| t.class == class.class)
                    .expect("one template per class");
                assert!(
                    (template.bias + replay - class.score).abs() < 1e-9,
                    "bias plus contributions is the score"
                );
            }
        }
    }
}
