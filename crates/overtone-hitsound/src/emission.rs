//! Emission scores: what one object should sound like (H4b).
//!
//! docs/06 section 6, first sum: instrument evidence through the profile's
//! affinity, metrical appropriateness through the role, combo emphasis
//! through the map context, and the mapper's own sounds as a prior. Volume
//! and sample index are not decided here — H5 takes them with the energy
//! term, which therefore waits with it — so candidates are bank plus
//! additions: 3 banks by 8 subsets, 24 states, small enough that no pruning
//! can hide a decision. Every score itemises its terms, because H4's
//! explanations replay them and a sum that does not add up is a visible bug.

use crate::evidence::AttackEvidence;
use crate::map::HitObject;
use crate::profile::{Addition, Bank, Profile};

/// One proposed sound: bank plus additions. Normal is the absence of
/// additions, as the format reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Candidate {
    pub bank: Bank,
    pub additions: [bool; 3],
}

impl Candidate {
    fn additions_list(self) -> Vec<Addition> {
        let all = [Addition::Whistle, Addition::Finish, Addition::Clap];
        all.into_iter()
            .zip(self.additions)
            .filter(|&(_, present)| present)
            .map(|(addition, _)| addition)
            .collect()
    }

    pub fn additions_bits(self) -> u8 {
        Addition::bits(&self.additions_list())
    }

    pub fn name(self) -> String {
        let mut text = self.bank.as_str().to_uppercase();
        for addition in self.additions_list() {
            text.push('-');
            text.push_str(addition.as_str());
        }
        text
    }

    /// All 24 states: every bank by every addition subset.
    pub fn all() -> Vec<Candidate> {
        let mut out = Vec::with_capacity(24);
        for bank in [Bank::Normal, Bank::Soft, Bank::Drum] {
            for mask in 0u8..8 {
                out.push(Candidate {
                    bank,
                    additions: [
                        mask & 1 != 0,
                        mask & 2 != 0,
                        mask & 4 != 0,
                    ],
                });
            }
        }
        out
    }
}

/// The hitSound bits as an addition set, in whistle/finish/clap order.
pub fn decode_additions(bits: u8) -> [bool; 3] {
    [bits & 2 != 0, bits & 4 != 0, bits & 8 != 0]
}

/// The object's explicit bank, if it names one: 0 inherits, and inheritance
/// is not a vote.
pub fn explicit_bank(normal_set: i64) -> Option<Bank> {
    match normal_set {
        1 => Some(Bank::Normal),
        2 => Some(Bank::Soft),
        3 => Some(Bank::Drum),
        _ => None,
    }
}

/// Metrical appropriateness of one addition set: finishes want the
/// downbeat, claps want an on-beat, whistles want off it. Starting points,
/// not measurements — the synthetic and real gates judge them, and the
/// timeline will say if they move.
fn role_fit(additions: &[Addition], division: Option<u32>, weight: Option<f64>) -> f64 {
    let (division, weight) = match (division, weight) {
        (Some(d), Some(w)) => (d, w),
        _ => return 0.0,
    };
    let mut fit = 0.0;
    for addition in additions {
        fit += match addition {
            Addition::Finish if division == 1 && weight >= 0.8 => 1.0,
            Addition::Finish if division == 1 => 0.2,
            Addition::Finish => -0.3,
            Addition::Clap if division == 1 => 0.6,
            Addition::Clap if division == 2 => 0.1,
            Addition::Clap => -0.2,
            Addition::Whistle if division >= 2 => 0.4,
            Addition::Whistle => -0.1,
        };
    }
    fit
}

/// Combo emphasis: a new combo asks for weight, a bare one answers it.
fn context_fit(new_combo: bool, has_addition: bool) -> f64 {
    match (new_combo, has_addition) {
        (true, true) => 1.0,
        (true, false) => -0.5,
        _ => 0.0,
    }
}

/// One scored candidate with its itemised terms: `(name, value)` in the
/// order the formula adds them.
#[derive(Debug, Clone)]
pub struct Scored {
    pub candidate: Candidate,
    pub score: f64,
    pub terms: Vec<(&'static str, f64)>,
}

/// Score every candidate for one object: the instrument likelihoods of its
/// matched attack through the profile's affinity, plus role, context and
/// prior. `attack` is `None` past any detected attack — then only the prior
/// speaks, which is exactly the honest answer for a sound over silence.
pub fn emission(
    object: &HitObject,
    attack: Option<&AttackEvidence>,
    map_default_bank: Bank,
    profile: &Profile,
) -> Vec<Scored> {
    let existing_bank = explicit_bank(object.sample.normal_set);
    let mut out = Vec::with_capacity(24);
    for candidate in Candidate::all() {
        let additions = candidate.additions_list();
        // Instrument evidence: each class votes its probability times the
        // affinity weight of the rows this candidate matches. `inherit`
        // rows resolve to the object's own bank, else the map default.
        let mut affinity = 0.0;
        if let Some(attack) = attack {
            for class in &attack.classes {
                let probability = class.probability;
                if probability <= 0.0 {
                    continue;
                }
                for row in &profile.affinity[&class.class] {
                    let bank = match row.bank {
                        Bank::Inherit => existing_bank.unwrap_or(map_default_bank),
                        bank => bank,
                    };
                    if bank == candidate.bank && row.additions == additions {
                        affinity += probability * row.weight;
                    }
                }
            }
        }
        let role = attack.map_or(0.0, |attack| {
            role_fit(
                &additions,
                attack.role.division,
                attack.role.metrical_weight,
            )
        });
        let context = context_fit(object.new_combo, !additions.is_empty());
        let prior = if decode_additions(object.hit_sound) == candidate.additions
            && existing_bank.map_or(true, |bank| bank == candidate.bank)
        {
            1.0
        } else {
            0.0
        };
        let score = affinity
            + profile.role_weight * role
            + profile.context_weight * context
            + profile.prior_weight * prior;
        out.push(Scored {
            candidate,
            score,
            terms: vec![
                ("affinity", affinity),
                ("role", profile.role_weight * role),
                ("context", profile.context_weight * context),
                ("prior", profile.prior_weight * prior),
            ],
        });
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score));
    out
}

/// Nearest attack time to `target_s` within `tolerance_s`, by binary
/// search — the P-5 match, for deciding per object.
pub fn match_attack(times: &[f64], target_s: f64, tolerance_s: f64) -> Option<usize> {
    if times.is_empty() {
        return None;
    }
    let mut low = 0usize;
    let mut high = times.len();
    while low < high {
        let mid = (low + high) / 2;
        if times[mid] < target_s {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    [low.checked_sub(1), Some(low)]
        .into_iter()
        .flatten()
        .filter(|&i| i < times.len() && (times[i] - target_s).abs() <= tolerance_s)
        .min_by(|&a, &b| {
            (times[a] - target_s)
                .abs()
                .total_cmp(&(times[b] - target_s).abs())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::tests::balanced;

    fn circle(hit_sound: u8) -> HitObject {
        HitObject {
            x: 256,
            y: 192,
            time: 1.0,
            new_combo: false,
            hit_sound,
            kind: crate::map::ObjectKind::Circle,
            sample: crate::map::HitSample {
                normal_set: 0,
                addition_set: 0,
                index: 0,
                volume: 0,
                file: String::new(),
            },
        }
    }

    #[test]
    fn terms_replay_the_score() {
        let profile = balanced();
        let scored = emission(&circle(0), None, Bank::Normal, &profile);
        assert_eq!(scored.len(), 24);
        for row in &scored {
            let replay: f64 = row.terms.iter().map(|&(_, v)| v).sum();
            assert!(
                (replay - row.score).abs() < 1e-9,
                "itemised terms are the score"
            );
        }
        // Sorted best first, and the silent prior keeps normal bare on top.
        assert!(scored.windows(2).all(|w| w[0].score >= w[1].score));
    }

    #[test]
    fn the_mapper_prior_moves_exactly_its_weight() {
        let profile = balanced();
        let bare = emission(&circle(0), None, Bank::Normal, &profile);
        let clapped = emission(&circle(8), None, Bank::Normal, &profile);
        let top = |rows: &[Scored]| {
            rows.iter()
                .find(|r| r.candidate.additions == [false, false, true])
                .expect("a clap candidate")
                .score
        };
        assert!((top(&clapped) - top(&bare) - profile.prior_weight).abs() < 1e-9);
    }

    #[test]
    fn match_attack_takes_the_nearest_inside_tolerance() {
        let times = [1.0, 2.0, 3.0];
        assert_eq!(match_attack(&times, 2.04, 0.05), Some(1));
        assert_eq!(match_attack(&times, 2.06, 0.05), None);
        assert_eq!(match_attack(&[], 1.0, 0.05), None);
    }

    #[test]
    fn hit_sound_bits_decode_in_whistle_finish_clap_order() {
        assert_eq!(decode_additions(0), [false, false, false]);
        assert_eq!(decode_additions(14), [true, true, true]);
        assert_eq!(decode_additions(8), [false, false, true]);
        assert_eq!(Addition::bits(&[Addition::Finish]), 4);
    }
}
