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
//! - **stream consistency**: inside a fast run (gap under 0.25 s) a change
//!   costs the stream weight instead;
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
        score += if gap < 0.25 {
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
}
