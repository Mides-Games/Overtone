//! Sample-resolution attack re-timing.
//!
//! This is the step that turns v2's 8.37 ms median offset error into v3's
//! 0.16 ms, and it is the one piece of the pipeline a reader is most likely to
//! dismiss as a detail. A spectral-flux peak is reported roughly one analysis
//! window *after* the physical attack — with `n_fft = 2048` that is about
//! 23 ms of window, and the measured bias was ~8 ms. Every attack is delayed
//! by about the same amount, so the fitted tempo survives it; the offset does
//! not, and an offset 8 ms late is audible in the osu! editor.
//!
//! So each coarse envelope time is refined on the **raw waveform**: walk the
//! local RMS energy back to where it crosses 20 % of its rise.
//!
//! Two guards carry more weight than they look like they do. The `1.6x` floor
//! check keeps the envelope time when there is no clear rise, rather than
//! snapping onto noise; and the `+ window` term converts the index of the
//! energy *window* back to the sample where that window began.

/// Re-time each attack. `times` are seconds; the result is seconds.
pub fn retime(y: &[f32], sr: u32, times: &[f64]) -> Vec<f64> {
    const BACK_S: f64 = 0.030;
    const AHEAD_S: f64 = 0.012;
    const RISE: f64 = 0.20;

    if times.is_empty() || y.is_empty() {
        return times.to_vec();
    }
    let sr_f = sr as f64;
    let window = ((0.0015 * sr_f).round() as usize).max(8); // 1.5 ms
    let back = (BACK_S * sr_f).round() as usize;
    let ahead = (AHEAD_S * sr_f).round() as usize;

    let mut out = times.to_vec();
    for (slot, &t) in out.iter_mut().zip(times) {
        let centre = (t * sr_f).round();
        if centre < 0.0 {
            continue;
        }
        let centre = centre as usize;
        let lo = centre.saturating_sub(back);
        let hi = (centre + ahead).min(y.len());
        if hi < lo + window * 3 {
            continue;
        }
        let seg = &y[lo..hi];

        // Energy in the window *ending* at each sample: the rise starts when
        // the window's trailing edge reaches the attack.
        //
        // `power` is `np.cumsum(seg * seg)` — inclusive, with no leading zero.
        // That detail is not cosmetic: a leading-zero prefix sum shifts the
        // whole energy array by one index, which moved every refined attack
        // one sample (0.0227 ms at 44.1 kHz) and, where a level crossing sat
        // near a boundary, flipped which index satisfied it and moved the
        // attack by ~28 ms. It showed up as 2 of 24 golden vectors diverging.
        let mut power = Vec::with_capacity(seg.len());
        let mut running = 0.0f64;
        for &sample in seg {
            let s = sample as f64;
            running += s * s;
            power.push(running);
        }
        if power.len() <= window {
            continue;
        }
        let energy: Vec<f64> = (0..power.len() - window)
            .map(|i| (power[i + window] - power[i]).max(0.0).sqrt())
            .collect();
        if energy.len() < 4 {
            continue;
        }

        // .rev(): the first of equal maxima, as v3's np.argmax.
        let top = energy
            .iter()
            .enumerate()
            .rev()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(i, _)| i)
            .unwrap_or(0);
        if top == 0 {
            continue;
        }
        let base = energy[..=top].iter().cloned().fold(f64::INFINITY, f64::min);
        let peak = energy[top];
        if peak <= base * 1.6 || peak <= 1e-7 {
            continue; // no clear attack: keep the envelope time
        }

        let level = base + RISE * (peak - base);
        let Some(j) = (0..=top).rev().find(|&i| energy[i] <= level) else {
            continue;
        };
        if j >= top {
            continue;
        }
        let span = energy[j + 1] - energy[j];
        let frac = if span > 1e-12 {
            ((level - energy[j]) / span).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let refined = (lo as f64 + j as f64 + frac + window as f64) / sr_f;
        if (refined - t).abs() <= BACK_S {
            *slot = refined;
        }
    }
    out
}

/// Sort by time and drop an attack that landed within 4 ms of its predecessor.
/// Re-timing can collide two neighbouring envelope peaks onto the same
/// physical attack; v3 keeps the earlier of the pair after sorting.
pub fn dedupe(times: &mut Vec<f64>, weights: &mut Vec<f32>) {
    let mut order: Vec<usize> = (0..times.len()).collect();
    order.sort_by(|&a, &b| times[a].total_cmp(&times[b]));
    let sorted_times: Vec<f64> = order.iter().map(|&i| times[i]).collect();
    let sorted_weights: Vec<f32> = order.iter().map(|&i| weights[i]).collect();

    times.clear();
    weights.clear();
    for (i, (&t, &w)) in sorted_times.iter().zip(&sorted_weights).enumerate() {
        if i == 0 || t - sorted_times[i - 1] > 0.004 {
            times.push(t);
            weights.push(w);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic attack: silence, then an exponentially decaying tone.
    fn attack_at(sr: u32, len: usize, onset: usize) -> Vec<f32> {
        let mut y = vec![0.0f32; len];
        for (i, v) in y.iter_mut().enumerate().skip(onset) {
            let t = (i - onset) as f64 / sr as f64;
            *v = ((2.0 * std::f64::consts::PI * 180.0 * t).sin() * (-t / 0.02).exp()) as f32;
        }
        y
    }

    #[test]
    fn retiming_removes_detector_latency() {
        let sr = 44_100;
        let onset = 10_000;
        let y = attack_at(sr, 30_000, onset);
        let truth = onset as f64 / sr as f64;
        // Hand the re-timer a time 8 ms late, which is the bias v2 shipped.
        let late = truth + 0.008;
        let fixed = retime(&y, sr, &[late])[0];
        assert!(
            (fixed - truth).abs() < 0.002,
            "truth {truth}, late {late}, fixed {fixed}"
        );
        assert!((fixed - truth).abs() < (late - truth).abs());
    }

    #[test]
    fn a_time_that_is_already_right_is_left_alone() {
        let sr = 44_100;
        let onset = 10_000;
        let y = attack_at(sr, 30_000, onset);
        let truth = onset as f64 / sr as f64;
        let fixed = retime(&y, sr, &[truth])[0];
        assert!((fixed - truth).abs() < 0.002);
    }

    #[test]
    fn noise_without_a_rise_keeps_the_envelope_time() {
        // Constant-amplitude noise has no 1.6x rise, so the guard must fire
        // and the input time must come back unchanged.
        let sr = 44_100;
        let y: Vec<f32> = (0..30_000)
            .map(|i| if i % 7 == 0 { 0.2 } else { -0.2 })
            .collect();
        let t = 0.3;
        assert_eq!(retime(&y, sr, &[t])[0], t);
    }

    #[test]
    fn dedupe_sorts_and_drops_collisions() {
        let mut times = vec![0.500, 0.100, 0.5005, 0.300];
        let mut weights = vec![1.0f32, 2.0, 3.0, 4.0];
        dedupe(&mut times, &mut weights);
        assert_eq!(times, vec![0.100, 0.300, 0.500]);
        assert_eq!(weights, vec![2.0, 4.0, 1.0]);
    }

    #[test]
    fn empty_input_is_not_a_special_case_for_the_caller() {
        assert!(retime(&[], 44_100, &[]).is_empty());
        assert!(retime(&vec![0.0; 100], 44_100, &[]).is_empty());
    }
}
