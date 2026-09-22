//! Musical role: where an attack sits in the music, independent of what it
//! sounds like (docs §4). Carries as much decision weight as instrument
//! evidence: a snare-like attack on beat 2 or 4 is almost certainly the
//! backbeat; the same profile on a 16th is a ghost note.
//!
//! Inputs are grids (sections), attacks and structure boundaries — no
//! `.osu`, so this runs on audio alone. Every signal is a pure function,
//! tested separately; [`analyze`] assembles them per attack.

use overtone_core::GridSection;

/// Metrical weight ladder for 4/4-ish bars. Downbeat first, half-bar next,
/// quarter beats after, then subdivisions. Values are ordinals that the
/// decision weights calibrate, not probabilities.
pub fn metrical_weight(beat_in_bar: i64, bar_beats: usize, division: u32) -> f64 {
    if division > 4 {
        return 0.10; // 16ths and finer: ghost-note territory.
    }
    if division > 1 {
        return 0.25; // off-beats (8ths, triplets).
    }
    let pos = beat_in_bar.rem_euclid(bar_beats.max(1) as i64);
    if pos == 0 {
        1.0
    } else if bar_beats >= 4 && pos == (bar_beats / 2) as i64 {
        0.7 // beat 3 of 4 (or the middle of a longer bar).
    } else {
        0.5 // beats 2 and 4, and every other quarter.
    }
}

/// Subdivision of the beat an attack sits on: 1/1, 1/2, 1/3, 1/4, 1/6 or
/// 1/8, from the fitted grid, exactly. Returns the division plus the
/// residual in milliseconds — a 16th that is 30 ms off is a flam, not a
/// 16th, and the residual is how the decision knows.
pub fn grid_position(t: f64, period: f64, phase: f64) -> (u32, f64) {
    const DIVISIONS: [u32; 6] = [1, 2, 3, 4, 6, 8];
    if !(period > 0.0) {
        return (1, 0.0);
    }
    let beat = (t - phase) / period;
    let mut best = (1u32, f64::INFINITY);
    for &d in &DIVISIONS {
        let slots = beat * d as f64;
        let residual_beats = (slots - slots.round()).abs() / d as f64;
        if residual_beats < best.1 {
            best = (d, residual_beats);
        }
    }
    (best.0, best.1 * period * 1000.0)
}

/// Role of one attack in the music.
#[derive(Debug, Clone, PartialEq)]
pub struct Role {
    /// Beat subdivision the attack sits on (1, 2, 3, 4, 6 or 8).
    pub division: u32,
    /// Distance off that subdivision slot, in milliseconds.
    pub grid_residual_ms: f64,
    /// Metrical weight: downbeat 1.0 down to 16ths 0.10.
    pub metrical_weight: f64,
    /// Bars since the phrase start (fractional).
    pub bars_since_phrase_start: f64,
    /// Bars to the phrase end (fractional).
    pub bars_to_phrase_end: f64,
    /// Seconds to the nearest tempo-section boundary.
    pub section_boundary_s: f64,
    /// Local 2 s RMS as a percentile of the track (0..1).
    pub local_energy: f64,
    /// Attack weight against its ±2 s neighbourhood (0..~2).
    pub accent: f64,
    /// Attacks per second in ±2 s.
    pub density: f64,
}

/// Assemble the role of every attack.
///
/// `sections` are beat-level fitted grids, `downbeat`/`bar_beats` the global
/// meter reading, `phrase_edges` structure boundaries (plus track start/end
/// are implied), `weights` the attack weights parallel to `times`.
pub fn analyze(
    y: &[f32],
    sr: u32,
    times: &[f64],
    weights: &[f32],
    sections: &[GridSection],
    downbeat: usize,
    bar_beats: usize,
    phrase_edges: &[f64],
) -> Vec<Role> {
    // Track RMS distribution over 2 s windows, for the energy percentile.
    let win = (2.0 * sr as f64) as usize;
    let mut buckets = Vec::new();
    if win > 0 {
        let mut i = 0usize;
        while i < y.len() {
            let end = (i + win).min(y.len());
            let rms = (y[i..end].iter().map(|&v| (v as f64).powi(2)).sum::<f64>()
                / (end - i).max(1) as f64)
                .sqrt();
            buckets.push(rms);
            i += win.max(1);
        }
        buckets.sort_by(f64::total_cmp);
    }

    times
        .iter()
        .enumerate()
        .map(|(idx, &t)| {
            let section = section_at(sections, t);
            let (division, grid_residual_ms, beat_in_bar, bar_len) = match section {
                Some(s) if s.period > 0.0 => {
                    let (d, r) = grid_position(t, s.period, s.phase);
                    let beat = ((t - s.phase) / s.period).round() as i64;
                    let bar = (s.period * bar_beats.max(1) as f64).max(1e-9);
                    (d, r, beat - downbeat as i64, bar)
                }
                _ => (1, 0.0, 0, 1.0),
            };
            let metrical_weight = metrical_weight(beat_in_bar, bar_beats, division);

            // Phrase edges with implied track start/end.
            let (since, to) = phrase_position(t, phrase_edges, bar_len);

            let section_boundary_s = sections
                .iter()
                .flat_map(|s| [s.start.get(), s.end.get()])
                .map(|e| (t - e).abs())
                .fold(f64::INFINITY, f64::min);

            // Local neighbourhood: ±2 s of attacks.
            let mut local_w: Vec<f64> = Vec::new();
            let mut count = 0usize;
            for (&ot, &ow) in times.iter().zip(weights.iter()) {
                if (ot - t).abs() <= 2.0 {
                    local_w.push(ow as f64);
                    count += 1;
                }
            }
            local_w.sort_by(f64::total_cmp);
            let median = percentile_of_sorted(&local_w, 50.0);
            let p90 = percentile_of_sorted(&local_w, 90.0);
            let w = weights.get(idx).copied().unwrap_or(0.0) as f64;
            let accent = ((w - median) / (p90 - median).max(1e-9)).clamp(0.0, 2.0);
            let density = count as f64 / 4.0;

            let local_energy = if buckets.is_empty() {
                0.0
            } else {
                let centre = (t * sr as f64) as usize;
                let lo = centre.saturating_sub(win / 2);
                let hi = (centre + win / 2).min(y.len()).max(lo + 1);
                let rms = (y[lo..hi].iter().map(|&v| (v as f64).powi(2)).sum::<f64>()
                    / (hi - lo) as f64)
                    .sqrt();
                buckets.partition_point(|&b| b < rms) as f64 / buckets.len() as f64
            };

            Role {
                division,
                grid_residual_ms,
                metrical_weight,
                bars_since_phrase_start: since,
                bars_to_phrase_end: to,
                section_boundary_s,
                local_energy,
                accent,
                density,
            }
        })
        .collect()
}

/// The section governing time `t`: the last one whose span contains it.
fn section_at(sections: &[GridSection], t: f64) -> Option<GridSection> {
    sections
        .iter()
        .filter(|s| t >= s.start.get() - 1e-9 && t <= s.end.get() + 1e-9)
        .last()
        .copied()
}

/// Bars since the phrase start and to the phrase end, in units of `bar_len`
/// seconds. Edges imply the track bounds on both sides.
fn phrase_position(t: f64, edges: &[f64], bar_len: f64) -> (f64, f64) {
    let bar_len = bar_len.max(1e-9);
    let mut prev = 0.0f64;
    let mut next = f64::INFINITY;
    for &e in edges {
        if e <= t + 1e-9 && e > prev {
            prev = e;
        }
        if e > t + 1e-9 && e < next {
            next = e;
        }
    }
    let since = (t - prev) / bar_len;
    let to = if next.is_finite() { (next - t) / bar_len } else { since };
    (since.max(0.0), to.max(0.0))
}

fn percentile_of_sorted(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let pos = (q / 100.0) * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        sorted[lo] * (hi as f64 - pos) + sorted[hi] * (pos - lo as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use overtone_core::Seconds;

    fn section(start: f64, end: f64, period: f64, phase: f64) -> GridSection {
        GridSection {
            start: Seconds(start),
            end: Seconds(end),
            period,
            phase,
            inliers: 0,
            residual_ms: 0.0,
            coverage: 1.0,
        }
    }

    #[test]
    fn grid_position_names_the_subdivision() {
        // 0.5 s beats from t = 0: on-beat, half, triplet, 16th.
        let (d, r) = grid_position(2.0, 0.5, 0.0);
        assert_eq!((d, r < 1e-9), (1, true));
        let (d, _) = grid_position(2.25, 0.5, 0.0);
        assert_eq!(d, 2);
        let (d, _) = grid_position(2.0 + 0.5 / 3.0, 0.5, 0.0);
        assert_eq!(d, 3);
        // 15 ms past the 16th slot: division 4 or 8 (the two nearest —
        // a triplet slot sits 27 ms away, so this is unambiguous), and
        // the residual must read the true distance either way.
        let (d, r) = grid_position(2.0 + 0.5 / 4.0 + 0.015, 0.5, 0.0);
        assert!((r - 15.0).abs() < 2.0, "residual {r}");
        assert!(d == 4 || d == 8, "division {d}");
    }

    #[test]
    fn metrical_weight_orders_downbeat_first() {
        // 4/4, downbeat class 0: beat 0 > beat 2 > beats 1,3 > 8ths > 16ths.
        assert_eq!(metrical_weight(0, 4, 1), 1.0);
        assert_eq!(metrical_weight(2, 4, 1), 0.7);
        assert_eq!(metrical_weight(1, 4, 1), 0.5);
        assert_eq!(metrical_weight(3, 4, 1), 0.5);
        assert_eq!(metrical_weight(0, 4, 2), 0.25);
        assert_eq!(metrical_weight(0, 4, 8), 0.10);
    }

    #[test]
    fn phrase_position_counts_bars_from_edges() {
        // Edges at 0/16/32, 2 s bars: t = 20 is 2 bars in, 6 to go.
        let (since, to) = phrase_position(20.0, &[0.0, 16.0, 32.0], 2.0);
        assert!((since - 2.0).abs() < 1e-9);
        assert!((to - 6.0).abs() < 1e-9);
    }

    #[test]
    fn analyze_marks_backbeats_and_ghosts() {
        // 120 BPM 4/4 from t = 0, two bars: kicks on quarters (1.0), hats
        // on 8ths (0.5), one ghost 16th (0.3). Audio is silent (energy 0);
        // the metrical assertions do not need samples.
        let sr = 44_100;
        let y = vec![0.0f32; (4.0 * sr as f64) as usize];
        let period = 0.5;
        let times: Vec<f64> = vec![0.0, 0.25, 0.5, 0.75, 1.0, 1.125, 1.5, 2.0, 2.5, 3.0, 3.5];
        // Varied weights: the accent metric divides by the local spread,
        // which is zero when every neighbour carries the same weight.
        let weights: Vec<f32> = vec![1.0, 0.45, 1.0, 0.55, 1.0, 0.3, 0.9, 0.8, 1.0, 0.7, 0.6];
        let sections = vec![section(0.0, 4.0, period, 0.0)];
        let roles = analyze(&y, sr, &times, &weights, &sections, 0, 4, &[0.0, 2.0, 4.0]);
        // t = 1.0 is beat 3 (index 4): heavier than beat 2, on the beat.
        assert_eq!(roles[4].metrical_weight, 0.7);
        assert_eq!(roles[4].division, 1);
        // t = 0.5 is beat 2 (index 2): plain quarter weight.
        assert_eq!(roles[2].metrical_weight, 0.5);
        // Ghost 16th at 1.125: fine division, light weight.
        assert_eq!(roles[5].division, 4);
        assert_eq!(roles[5].metrical_weight, 0.25);
        // Kick accents above hats around them.
        assert!(roles[2].accent > roles[1].accent);
        // Section boundary distance: t = 0 sits on one.
        assert!(roles[0].section_boundary_s < 1e-9);
        // Phrase edges at 0/2/4 with 2 s bars: t = 1 is half a bar in.
        assert!((roles[4].bars_since_phrase_start - 0.5).abs() < 1e-9);
        // Density over ±2 s around t = 1: ten attacks (3.5 is out).
        assert!((roles[4].density - 10.0 / 4.0).abs() < 1e-9);
    }
}
