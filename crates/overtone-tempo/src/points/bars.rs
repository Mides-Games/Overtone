//! Section confidence, measures and the bar a section plays.

use overtone_core::GridSection;

use crate::fit::Grid;

use super::*;

/// Confidence of one section — v3 `_section_confidence`.
pub fn section_confidence(section: &GridSection, persistence: usize) -> f64 {
    let beat_ms = section.period * 1000.0;
    if beat_ms <= 0.0 {
        return 0.0;
    }
    let tightness = 1.0 - (section.residual_ms / (0.06 * beat_ms).max(2.0)).min(1.0);
    let beats = ((section.end.get() - section.start.get()) / section.period).max(1.0);
    let length_bonus = (beats / (persistence as f64 * 3.0).max(1.0)).min(1.0);
    (0.55 * tightness + 0.30 * (section.coverage * 1.15).min(1.0) + 0.15 * length_bonus)
        .clamp(0.0, 1.0)
}

/// Per-section `(meter text, downbeat class, beats per bar)` — v3
/// `section_measures`. Each section is measured on its own attacks; a section
/// whose accents prove nothing reports bar `1` ("anchor to a beat, not a
/// bar").
pub fn section_measures(
    sections: &[GridSection],
    times: &[f64],
    weights: &[f32],
) -> Vec<(String, usize, usize)> {
    let mut out = Vec::with_capacity(sections.len());
    for section in sections {
        let (w_times, w_weights) = windowed(times, weights, |t| {
            t >= section.start.get() - section.period && t <= section.end.get() + section.period
        });
        if w_times.len() < 12 {
            out.push(("4/4".to_string(), 0, 1));
            continue;
        }
        let (text, downbeat, bar) = crate::octave::meter_from_grid(
            &w_times,
            &w_weights,
            Grid {
                period: section.period,
                phase: section.phase,
            },
        );
        out.push((text.to_string(), downbeat, bar));
    }
    out
}

/// A proven bar: `(bar_seconds, bar_phase, beats_in_bar, contrast)` — v3
/// `detect_bar`. `None` when the accents prove nothing; refusing is the right
/// answer then, because an invented bar moves every red line.
pub fn detect_bar(
    times: &[f64],
    weights: &[f32],
    period: f64,
    phase: f64,
) -> Option<(f64, f64, usize, f64)> {
    if times.len() < 16 || period <= 0.0 {
        return None;
    }
    let mut ks: Vec<f64> = Vec::new();
    let mut ws: Vec<f64> = Vec::new();
    for (&t, &w) in times.iter().zip(weights.iter()) {
        let k = ((t - phase) / period).round();
        if (t - (phase + k * period)).abs() <= 0.15 * period {
            ks.push(k);
            ws.push(w as f64);
        }
    }
    if ks.len() < 16 {
        return None;
    }
    let span = ks.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        - ks.iter().copied().fold(f64::INFINITY, f64::min);

    let mut best: Option<(f64, f64, usize, f64)> = None;
    for m in BAR_MULTIPLES {
        if span < m as f64 * 4.0 {
            continue;
        }
        let mut totals = vec![0.0f64; m];
        let mut counts = vec![0usize; m];
        for (&k, &w) in ks.iter().zip(ws.iter()) {
            let c = k.rem_euclid(m as f64) as usize % m;
            totals[c] += w;
            counts[c] += 1;
        }
        let means: Vec<f64> = (0..m)
            .map(|c| totals[c] / counts[c].max(1) as f64)
            .collect();
        let r = argmax(&means);
        let mean_all = means.iter().sum::<f64>() / m as f64;
        let contrast = means[r] / mean_all.max(1e-9);
        // Strongest downbeat wins; longest-bar was tried and is wrong (a
        // four-bar hypermeasure outscores the true bar). Near-ties go to the
        // shorter reading, the one a mapper writes.
        if contrast < BAR_CONTRAST {
            continue;
        }
        let replace = match best {
            None => true,
            Some((_, _, _, c)) => contrast > c * 1.05,
        };
        if replace {
            best = Some((period * m as f64, phase + r as f64 * period, m, contrast));
        }
    }
    best
}
