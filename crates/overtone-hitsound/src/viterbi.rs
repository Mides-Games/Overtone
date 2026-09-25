//! Sequence labelling for hitsound proposals (H4c): Viterbi over objects.
//!
//! docs/06 section 6, second sum: a per-object argmax flickers with the
//! audio, so the assignment maximises emission plus transition over the
//! whole object list. Pairwise transitions only — anything wider (a finish
//! refractory over several objects) would break the Markov structure the
//! exact DP needs, so the refractory looks one step back and says so:
//!
//! - **switch cost**: changing bank or additions between adjacent objects
//!   costs, unless the new object opens a combo or a phrase edge falls
//!   between them;
//! - **stream consistency**: inside a true run (gaps under 0.15 s — 16ths,
//!   not 8ths: an 8th-note backbeat grid is decided hit by hit, and the
//!   gate below proved 0.25 smoothed it bare) a change costs the stream
//!   weight instead;
//! - **phrase symmetry**: the same slot one bar on takes the same sound for
//!   a bonus — bars that agree sound intentional;
//! - **finish refractory**: a finish right after a finish costs, because
//!   finish spam is the most common failure of automatic hitsounding.
//!
//! Forward-backward gives per-object marginals, correctly normalised, which
//! is where alternatives and confidences come from. O(n · 24²): trivial.

use crate::emission::Candidate;
use crate::profile::Profile;

/// One object in sequence order: when, whether it opens a combo, its bar
/// slot if the map's red lines place it, and whether a phrase edge falls
/// between it and the previous object.
#[derive(Debug, Clone)]
pub struct Step {
    pub time_s: f64,
    pub new_combo: bool,
    pub bar_slot: Option<(i64, i64)>,
    pub phrase_break_before: bool,
}

/// One decided object: the proposal, its marginal probability, and the
/// runner-up states with theirs, best first.
#[derive(Debug, Clone)]
pub struct Decision {
    pub state: usize,
    pub probability: f64,
    pub alternatives: Vec<(usize, f64)>,
}

/// Pairwise transition from `prev` to `curr`, in the profile's weights.
/// Positive bonds, negative costs — one number either way.
pub fn transition(
    prev: usize,
    curr: usize,
    states: &[Candidate],
    prev_step: &Step,
    step: &Step,
    profile: &Profile,
) -> f64 {
    // Finish refractory first: a finish right after a finish costs whether
    // the bank moved or not, because finish spam is the failure mode.
    let mut score = if states[curr].additions[1] && states[prev].additions[1] {
        -profile.finish_spacing
    } else {
        0.0
    };
    if prev == curr {
        // Staying still still bonds a repeated slot one bar on: choruses
        // repeat, and the DP should feel it. The refractory below already
        // fired for a held finish.
        return score + phrase_bonus(prev, curr, states, prev_step, step, profile);
    }
    let gap = (step.time_s - prev_step.time_s).max(0.0);
    let justified = step.new_combo || step.phrase_break_before;
    if !justified {
        score += if gap < 0.15 {
            -profile.stream_consistency
        } else {
            -profile.switch_cost
        };
    }
    score + phrase_bonus(prev, curr, states, prev_step, step, profile)
}

fn phrase_bonus(
    prev: usize,
    curr: usize,
    states: &[Candidate],
    prev_step: &Step,
    step: &Step,
    profile: &Profile,
) -> f64 {
    if states[prev] != states[curr] {
        return 0.0;
    }
    match (prev_step.bar_slot, step.bar_slot) {
        (Some((bar, slot)), Some((bar_now, slot_now)))
            if slot == slot_now && bar_now == bar + 1 =>
        {
            profile.phrase_symmetry
        }
        _ => 0.0,
    }
}

/// Viterbi over `emissions` (one score vector per object, in a shared state
/// order) with `steps` beside them. Returns one decision per object; an
/// empty run decides nothing.
pub fn decide(
    emissions: &[Vec<f64>],
    states: &[Candidate],
    steps: &[Step],
    profile: &Profile,
) -> Vec<Decision> {
    assert_eq!(emissions.len(), steps.len());
    if emissions.is_empty() {
        return Vec::new();
    }
    let n_states = states.len();
    // Forward pass in log space: best log-score per state, with backpointers.
    // The first row starts from 0, not -inf: there is no previous state to
    // pay a transition to, and -inf would poison the whole lattice.
    let mut best = vec![0.0; n_states];
    let mut back: Vec<Vec<usize>> = Vec::with_capacity(emissions.len());
    for (i, scores) in emissions.iter().enumerate() {
        let mut next = vec![f64::NEG_INFINITY; n_states];
        let mut row = vec![0usize; n_states];
        for (curr, &emit) in scores.iter().enumerate() {
            let (value, arg) = (0..n_states)
                .map(|prev| {
                    let trans = if i == 0 {
                        0.0
                    } else {
                        transition(prev, curr, states, &steps[i - 1], &steps[i], profile)
                    };
                    (best[prev] + trans, prev)
                })
                .max_by(|a, b| a.0.total_cmp(&b.0))
                .unwrap_or((f64::NEG_INFINITY, 0));
            next[curr] = value + emit;
            row[curr] = arg;
        }
        best = next;
        back.push(row);
    }
    // Best path backwards.
    let mut path = vec![0usize; emissions.len()];
    path[emissions.len() - 1] = (0..n_states)
        .max_by(|&a, &b| best[a].total_cmp(&best[b]))
        .unwrap_or(0);
    for i in (1..emissions.len()).rev() {
        path[i - 1] = back[i][path[i]];
    }
    // Forward-backward for marginals: log-alpha, log-beta, normalised.
    let log_add = |a: f64, b: f64| {
        if a == f64::NEG_INFINITY {
            return b;
        }
        if b == f64::NEG_INFINITY {
            return a;
        }
        let (hi, lo) = if a > b { (a, b) } else { (b, a) };
        hi + (1.0 + (lo - hi).exp()).ln()
    };
    let mut alpha = vec![vec![f64::NEG_INFINITY; n_states]; emissions.len()];
    for (s, row) in alpha[0].iter_mut().enumerate() {
        *row = emissions[0][s];
    }
    for i in 1..emissions.len() {
        for curr in 0..n_states {
            let mut acc = f64::NEG_INFINITY;
            for prev in 0..n_states {
                acc = log_add(
                    acc,
                    alpha[i - 1][prev]
                        + transition(prev, curr, states, &steps[i - 1], &steps[i], profile),
                );
            }
            alpha[i][curr] = acc + emissions[i][curr];
        }
    }
    let mut beta = vec![vec![f64::NEG_INFINITY; n_states]; emissions.len()];
    for row in beta[emissions.len() - 1].iter_mut() {
        *row = 0.0;
    }
    for i in (0..emissions.len() - 1).rev() {
        for prev in 0..n_states {
            let mut acc = f64::NEG_INFINITY;
            for curr in 0..n_states {
                acc = log_add(
                    acc,
                    transition(prev, curr, states, &steps[i], &steps[i + 1], profile)
                        + emissions[i + 1][curr]
                        + beta[i + 1][curr],
                );
            }
            beta[i][prev] = acc;
        }
    }
    let total = (0..n_states).fold(f64::NEG_INFINITY, |acc, s| log_add(acc, alpha[emissions.len() - 1][s]));
    path.iter()
        .enumerate()
        .map(|(i, &state)| {
            let mut marginals: Vec<(usize, f64)> = (0..n_states)
                .map(|s| (s, (alpha[i][s] + beta[i][s] - total).exp()))
                .collect();
            marginals.sort_by(|a, b| b.1.total_cmp(&a.1));
            let probability = marginals
                .iter()
                .find(|&&(s, _)| s == state)
                .map(|&(_, p)| p)
                .unwrap_or(0.0);
            marginals.retain(|&(s, _)| s != state);
            marginals.truncate(2);
            Decision {
                state,
                probability,
                alternatives: marginals,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emission::Candidate;
    use crate::profile::tests::balanced;

    fn states() -> Vec<Candidate> {
        Candidate::all().into_iter().take(3).collect()
    }

    fn step(time_s: f64) -> Step {
        Step {
            time_s,
            new_combo: false,
            bar_slot: None,
            phrase_break_before: false,
        }
    }

    /// Exhaustive best path on a tiny chain: the DP must equal brute force.
    #[test]
    fn viterbi_equals_brute_force() {
        let profile = balanced();
        let states = states();
        let emissions = vec![
            vec![0.1, 0.9, 0.2],
            vec![0.8, 0.3, 0.4],
            vec![0.2, 0.2, 0.9],
        ];
        let steps = vec![step(0.0), step(0.5), step(1.0)];
        let decisions = decide(&emissions, &states, &steps, &profile);
        // Brute force over 3^3 paths.
        let mut best = (f64::NEG_INFINITY, vec![0usize; 3]);
        for a in 0..3 {
            for b in 0..3 {
                for c in 0..3 {
                    let path = [a, b, c];
                    let mut total = emissions[0][a] + emissions[1][b] + emissions[2][c];
                    total += transition(a, b, &states, &steps[0], &steps[1], &profile);
                    total += transition(b, c, &states, &steps[1], &steps[2], &profile);
                    if total > best.0 {
                        best = (total, path.to_vec());
                    }
                }
            }
        }
        let found: Vec<usize> = decisions.iter().map(|d| d.state).collect();
        assert_eq!(found, best.1);
    }

    #[test]
    fn marginals_sum_to_one_and_favour_the_path() {
        let profile = balanced();
        let states = states();
        let emissions = vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]];
        let steps = vec![step(0.0), step(2.0)];
        let decisions = decide(&emissions, &states, &steps, &profile);
        for decision in &decisions {
            let total: f64 = decision.probability
                + decision.alternatives.iter().map(|&(_, p)| p).sum::<f64>();
            assert!((total - 1.0).abs() < 1e-9, "marginals normalise");
        }
        assert_eq!(decisions[0].state, 0);
        assert_eq!(decisions[1].state, 1);
    }

    #[test]
    fn a_finish_right_after_a_finish_costs() {
        let profile = balanced();
        let states = states();
        // State 7 is drum+finish? Find a finish state and a bare one.
        let finish = states.iter().position(|s| s.additions == [false, true, false]).unwrap();
        let bare = states.iter().position(|s| s.additions == [false, false, false]).unwrap();
        let steps = vec![step(0.0), step(1.0)];
        let stay = transition(finish, finish, &states, &steps[0], &steps[1], &profile);
        let leave = transition(finish, bare, &states, &steps[0], &steps[1], &profile);
        assert!(stay < leave, "refractory outweighs the stay: {stay} vs {leave}");
    }

    #[test]
    fn a_new_combo_waives_the_switch_cost() {
        let profile = balanced();
        let states = states();
        let plain = step(1.0);
        let mut combo = step(1.0);
        combo.new_combo = true;
        let cost = transition(0, 2, &states, &step(0.0), &plain, &profile);
        let waived = transition(0, 2, &states, &step(0.0), &combo, &profile);
        assert!(cost < 0.0 && waived == 0.0, "{cost} vs {waived}");
    }

    #[test]
    fn an_empty_run_decides_nothing() {
        let profile = balanced();
        assert!(decide(&[], &states(), &[], &profile).is_empty());
    }

    /// H4d synthetic gate: a grid-composed arrangement (150 BPM, kicks on and
    /// off beats, snares on backbeats, a crash opening bar 3), bare circles
    /// on every hit. Exact truth where the templates separate: drum-bare
    /// kick, drum-clap snare, normal-finish crash. Hats read kick-like
    /// (closed-hat held-out F1 0.40, a template limit, not a pipeline one),
    /// so they assert the honest remainder: a percussive bare bank, no
    /// additions. A miss names its class.
    #[test]
    fn grid_arrangement_decides_the_profiles_sounds() {
        use crate::{baked, corpus, emission as em, evidence, map};
        use overtone_core::GridSection;
        use overtone_core::Seconds;
        // Eighth-note slots from 0.5 s at 150 BPM: kicks on beats and
        // off-beats, snares on the backbeats (slots 2 and 6 of 8), closed
        // hats on two off-beats.
        let cycle = [
            corpus::HitClass::Kick,
            corpus::HitClass::HatClosed,
            corpus::HitClass::Snare,
            corpus::HitClass::Kick,
            corpus::HitClass::Kick,
            corpus::HitClass::HatClosed,
            corpus::HitClass::Snare,
            corpus::HitClass::Kick,
        ];
        let track = corpus::render(44_100, 5.0, 0.2, &cycle, 4);
        assert_eq!(track.hits.len(), 20, "eight slots a bar over two bars plus");
        let crash = corpus::render(44_100, 1.2, 10.0, &[corpus::HitClass::Cymbal], 9);
        assert_eq!(crash.hits.len(), 1);
        // The crash replaces the kick opening bar 3 (2.1 s): one hit a slot.
        // Its render starts at 0.5 s, so the shift lands the hit, not the
        // buffer start, on the downbeat. The replaced kick is muted first.
        let shift = ((2.1 - 0.5) * 44_100.0) as usize;
        let mut samples = track.samples.clone();
        for (i, s) in samples.iter_mut().enumerate() {
            let t = i as f64 / 44_100.0;
            if (t - 2.1).abs() < 0.06 {
                *s = 0.0;
            }
        }
        samples.resize(samples.len().max(shift + crash.samples.len()), 0.0);
        for (i, &s) in crash.samples.iter().enumerate() {
            samples[shift + i] += s;
        }
        let peak = samples.iter().copied().fold(0.0f32, f32::max);
        for s in samples.iter_mut() {
            *s /= peak.max(1e-6);
        }
        let mut hits: Vec<corpus::Hit> = track
            .hits
            .iter()
            .filter(|h| (h.time_s - 2.1).abs() > 1e-9 && (h.time_s - 2.3).abs() > 1e-9)
            .copied()
            .collect();
        // A rest on the 8th after the crash: its ring owns that window, and
        // no gate should ask who plays under a cymbal wash.
        hits.push(corpus::Hit {
            class: corpus::HitClass::Cymbal,
            time_s: 2.1,
            velocity: 1.0,
        });
        hits.sort_by(|a, b| a.time_s.total_cmp(&b.time_s));
        assert_eq!(hits.len(), 19);

        let templates = baked::templates();
        let period = 0.4;
        let sections = vec![GridSection {
            start: Seconds(0.5),
            end: Seconds(5.0),
            period,
            phase: 0.5,
            inliers: hits.len(),
            residual_ms: 0.0,
            coverage: 1.0,
        }];
        let times: Vec<f64> = hits.iter().map(|h| h.time_s).collect();
        let weights = vec![1.0f32; hits.len()];
        let roles = crate::role::analyze(&samples, 44_100, &times, &weights, &sections, &[(0, 4)], &[]);
        let reds = vec![map::TimingPoint {
            offset: 500.0,
            beat_len: 400.0,
            meter: 4,
            sample_set: 1,
            sample_index: 0,
            volume: 70,
            uninherited: true,
        }];
        let placed = map::bar_slots(
            &reds,
            &times.iter().map(|t| t * 1000.0).collect::<Vec<_>>(),
        );
        let profile = balanced();
        let states = em::Candidate::all();
        let mut emissions = Vec::new();
        let mut steps = Vec::new();
        for ((hit, time_s), (role, place)) in
            hits.iter().zip(times.iter()).zip(roles.iter().zip(placed.iter()))
        {
            let features = crate::template::extract(&samples, 44_100, *time_s);
            let attack = evidence::AttackEvidence {
                time_s: *time_s,
                weight: 1.0,
                features,
                classes: vec![],
                role: role.clone(),
            };
            let attack = evidence::AttackEvidence {
                classes: crate::template::classify(&templates, &attack.features)
                    .into_iter()
                    .map(|(class, probability)| evidence::ClassEvidence {
                        class,
                        probability,
                        score: 0.0,
                        terms: vec![],
                    })
                    .collect(),
                ..attack
            };
            let object = map::HitObject {
                x: 256,
                y: 192,
                time: time_s * 1000.0,
                new_combo: false,
                hit_sound: 0,
                kind: map::ObjectKind::Circle,
                sample: map::HitSample {
                    normal_set: 0,
                    addition_set: 0,
                    index: 0,
                    volume: 0,
                    file: String::new(),
                },
            };
            let scored = em::emission(&object, Some(&attack), em::Bank::Normal, &profile);
            emissions.push(
                states
                    .iter()
                    .map(|wanted| {
                        scored
                            .iter()
                            .find(|row| row.candidate == *wanted)
                            .map_or(f64::NEG_INFINITY, |row| row.score)
                    })
                    .collect::<Vec<_>>(),
            );
            steps.push(Step {
                time_s: *time_s,
                new_combo: false,
                bar_slot: match *place {
                    (bar, Some(slot), _) => Some((bar, slot)),
                    _ => None,
                },
                phrase_break_before: false,
            });
            let _ = hit;
        }
        let decisions = decide(&emissions, &states, &steps, &profile);
        let expected = [
            (corpus::HitClass::Kick, "DRUM"),
            (corpus::HitClass::Snare, "DRUM-clap"),
            (corpus::HitClass::Cymbal, "NORMAL-finish"),
        ];
        for (decision, hit) in decisions.iter().zip(hits.iter()) {
            let state = &states[decision.state];
            let got = state.name();
            eprintln!("{:?} at {:.1} s -> {got} p={:.2}", hit.class, hit.time_s, decision.probability);
            if hit.class == corpus::HitClass::HatClosed {
                // Template-weak class: no additions, percussive bank.
                assert!(
                    state.additions == [false, false, false]
                        && (state.bank == em::Bank::Drum || state.bank == em::Bank::Soft),
                    "hat misproposed as {got}"
                );
                continue;
            }
            let (_, want) = expected.iter().find(|&&(c, _)| c == hit.class).unwrap();
            assert_eq!(&got, want, "{:?} misproposed", hit.class);
        }
    }
}
