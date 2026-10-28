//! Ramps: the elastic curve as the fewest red lines (Phase 19).
//!
//! A continuously varying tempo is exact as a curve and unusable as one —
//! osu! plays red lines, constant tempo each. So each run of attacks
//! becomes the longest single grid that keeps every one of them within the
//! chosen drift, then the next run starts where it stopped. Longest-first
//! greedy is optimal here: with monotone coverage, no covering uses fewer
//! segments. Beat indices come from the elastic fit, which solved the hard
//! part (indices that do not slip on a ramp); the lines are ordinary
//! weighted least squares in beat index, closed form, no new machinery.
//!
//! The trade-off table runs the same greedy at several drifts, so the
//! caller sees count against drift instead of guessing one number.

/// Drift rungs for the trade-off table, in milliseconds.
pub const TRADEOFF_DRIFTS: [f64; 5] = [1.0, 2.0, 5.0, 10.0, 20.0];

/// Strong attacks only: at half the strongest weight or above, the same
/// bar `alignment_report` uses. Red lines anchor on beats, and beats are
/// kicks and snares, not ghost notes: weak attacks share their neighbour's
/// beat index, which would read as zero drift for standing still, and they
/// ride between the lines instead of placing them.
pub fn strong(times: &[f64], indices: &[f64], weights: &[f32]) -> (Vec<f64>, Vec<f64>, Vec<f32>) {
    let peak = weights.iter().copied().fold(0.0f32, f32::max);
    if !(peak > 0.0) {
        return (Vec::new(), Vec::new(), Vec::new());
    }
    let mut out = (Vec::new(), Vec::new(), Vec::new());
    for ((&t, &k), &w) in times.iter().zip(indices.iter()).zip(weights.iter()) {
        if w >= 0.5 * peak {
            out.0.push(t);
            out.1.push(k);
            out.2.push(w);
        }
    }
    out
}

/// One red line over a run of attacks.
#[derive(Debug, Clone)]
pub struct RampLine {
    /// Seconds of its first integer beat.
    pub offset_s: f64,
    pub bpm: f64,
    /// Beat-index span it covers.
    pub start_k: f64,
    pub end_k: f64,
    /// Worst attack distance from its grid, in milliseconds.
    pub max_drift_ms: f64,
    pub attacks: usize,
}

/// Weighted least squares of time on beat index: `(intercept, slope)`.
fn fit_line(ks: &[f64], times: &[f64], weights: &[f32]) -> Option<(f64, f64)> {
    let mut sw = 0.0;
    let mut sk = 0.0;
    let mut st = 0.0;
    for ((&k, &t), &w) in ks.iter().zip(times.iter()).zip(weights.iter()) {
        let w = w as f64;
        sw += w;
        sk += w * k;
        st += w * t;
    }
    if sw <= 0.0 {
        return None;
    }
    let k_mean = sk / sw;
    let t_mean = st / sw;
    let mut num = 0.0;
    let mut den = 0.0;
    for ((&k, &t), &w) in ks.iter().zip(times.iter()).zip(weights.iter()) {
        let w = w as f64;
        num += w * (k - k_mean) * (t - t_mean);
        den += w * (k - k_mean) * (k - k_mean);
    }
    if den <= 0.0 {
        return None;
    }
    let slope = num / den;
    if !(slope > 0.0) {
        return None;
    }
    Some((t_mean - slope * k_mean, slope))
}

/// Longest grids within `drift_ms`, back to back. Needs at least two
/// attacks with distinct indices per line; a lone trailing attack joins the
/// previous line's span rather than standing alone without a slope.
pub fn segment(
    times: &[f64],
    indices: &[f64],
    weights: &[f32],
    drift_ms: f64,
) -> Vec<RampLine> {
    assert_eq!(times.len(), indices.len());
    assert_eq!(times.len(), weights.len());
    let mut lines: Vec<RampLine> = Vec::new();
    let mut i = 0;
    while i < times.len() {
        let mut end = i;
        while end + 1 < times.len() {
            let (a, b) = match fit_line(&indices[i..end + 2], &times[i..end + 2], &weights[i..end + 2]) {
                Some(fit) => fit,
                None => break,
            };
            let worst = indices[i..end + 2]
                .iter()
                .zip(times[i..end + 2].iter())
                .map(|(&k, &t)| ((a + b * k - t).abs(), k))
                .fold(0.0f64, |worst, (d, _)| worst.max(d));
            if worst * 1000.0 > drift_ms {
                break;
            }
            end += 1;
        }
        if end == i {
            // One attack cannot set a tempo: it joins the previous line, or
            // stands slope-less when the run is a single attack.
            if let Some(last) = lines.last_mut() {
                last.end_k = last.end_k.max(indices[i]);
                last.attacks += 1;
            } else {
                lines.push(RampLine {
                    offset_s: times[i],
                    bpm: 0.0,
                    start_k: indices[i],
                    end_k: indices[i],
                    max_drift_ms: 0.0,
                    attacks: 1,
                });
            }
            i += 1;
            continue;
        }
        let (a, b) = fit_line(&indices[i..end + 1], &times[i..end + 1], &weights[i..end + 1])
            .expect("a run of two or more fits");
        let start_k = indices[i].floor();
        lines.push(RampLine {
            offset_s: a + b * start_k,
            bpm: 60.0 / b,
            start_k,
            end_k: indices[end],
            max_drift_ms: indices[i..end + 1]
                .iter()
                .zip(times[i..end + 1].iter())
                .map(|(&k, &t)| (a + b * k - t).abs() * 1000.0)
                .fold(0.0f64, f64::max),
            attacks: end + 1 - i,
        });
        i = end + 1;
    }
    lines
}

/// Count against drift, cheapest first: what fewer lines cost in drift.
pub fn tradeoff(times: &[f64], indices: &[f64], weights: &[f32]) -> Vec<(f64, usize)> {
    TRADEOFF_DRIFTS.iter()
        .map(|&drift| (drift, segment(times, indices, weights, drift).len()))
        .collect()
}

/// The selector beside the piecewise fit: ramps when the elastic model bent
/// (degree 2 or more) and its residual beats the piecewise one, in the same
/// milliseconds — or when the piecewise fit found no sections at all, and
/// there is nothing to beat. Anything else, and the red lines the sections
/// already read stand.
pub fn recommend(
    elastic_degree: usize,
    elastic_rms_ms: f64,
    piecewise_sections: usize,
    piecewise_rms_ms: f64,
) -> bool {
    elastic_degree >= 2 && (piecewise_sections == 0 || elastic_rms_ms < piecewise_rms_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(n: usize, period: f64, phase: f64) -> (Vec<f64>, Vec<f64>, Vec<f32>) {
        let times: Vec<f64> = (0..n).map(|k| phase + k as f64 * period).collect();
        let indices: Vec<f64> = (0..n).map(|k| k as f64).collect();
        (times.clone(), indices, vec![1.0f32; n])
    }

    #[test]
    fn constant_tempo_is_one_line_with_the_exact_bpm() {
        let (times, indices, weights) = grid(200, 0.4, 10.0);
        let lines = segment(&times, &indices, &weights, 5.0);
        assert_eq!(lines.len(), 1);
        assert!((lines[0].bpm - 150.0).abs() < 1e-9);
        assert!(lines[0].max_drift_ms < 1e-9);
        assert_eq!(lines[0].attacks, 200);
    }

    #[test]
    fn a_linear_ramp_splits_and_every_attack_holds_the_drift() {
        // 120 -> 160 BPM over 60 s: period 0.5 s falling to 0.375 s.
        let n = 400;
        let times: Vec<f64> = (0..n)
            .map(|k| {
                let period = 0.5 - 0.125 * k as f64 / n as f64;
                k as f64 * period
            })
            .collect();
        let indices: Vec<f64> = (0..n).map(|k| k as f64).collect();
        let weights = vec![1.0f32; n];
        let lines = segment(&times, &indices, &weights, 5.0);
        assert!(lines.len() > 1 && lines.len() < 40, "{}", lines.len());
        for line in &lines {
            assert!(line.max_drift_ms <= 5.0 + 1e-9, "{line:?}");
        }
        let covered: usize = lines.iter().map(|l| l.attacks).sum();
        assert_eq!(covered, n);
        assert!(lines.first().unwrap().bpm < lines.last().unwrap().bpm);
    }

    #[test]
    fn tradeoff_costs_fewer_lines_for_more_drift() {
        let (times, indices, weights) = grid(200, 0.4, 10.0);
        let table = tradeoff(&times, &indices, &weights);
        assert_eq!(table.len(), TRADEOFF_DRIFTS.len());
        assert!(table.windows(2).all(|w| w[0].1 >= w[1].1));
        assert!(table.iter().all(|&(_, count)| count == 1));
    }

    #[test]
    fn too_few_attacks_decide_nothing() {
        assert!(segment(&[], &[], &[], 5.0).is_empty());
        assert!(segment(&[1.0], &[0.0], &[1.0], 5.0).len() <= 1);
    }

    #[test]
    fn the_selector_reads_degree_and_residual() {
        assert!(recommend(2, 3.0, 4, 8.0));
        assert!(recommend(3, 4.0, 0, 0.0));
        assert!(!recommend(1, 3.0, 4, 8.0));
        assert!(!recommend(2, 9.0, 4, 8.0));
        assert!(!recommend(0, 0.0, 0, 0.0));
    }

    #[test]
    fn strong_keeps_beats_and_drops_ghost_notes() {
        let (times, indices, weights) = (
            vec![0.5, 0.7, 0.9],
            vec![1.0, 1.0, 2.0],
            vec![0.9f32, 0.2, 0.8],
        );
        let (t, k, w) = strong(&times, &indices, &weights);
        assert_eq!((t, k, w), (vec![0.5, 0.9], vec![1.0, 2.0], vec![0.9, 0.8]));
        assert!(strong(&[], &[], &[]).0.is_empty());
    }
}
