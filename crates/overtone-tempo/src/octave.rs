//! The octave decision: how many atoms make one beat, and which one is the
//! downbeat.
//!
//! The grid fit already knows the pulse to six decimals. What it cannot know
//! is which multiple of that pulse a human calls "the beat" — a 92 BPM song
//! with eighth-note hats is a valid 184 BPM map, and 225 BPM streams read as
//! 112.5 to any estimator carrying a perceptual prior. So this stage is
//! decided from **evidence**, never by blind multiplication:
//!
//! * **accent depth** — group attacks by index modulo `m`. If `m` atoms really
//!   make a beat, one class holds the kicks and another the filler, so the
//!   spread between the strongest and weakest class is large. `m = 1` scores
//!   zero by construction, which is right: an unsubdivided atom shows no
//!   accent.
//! * **tempogram hints** — a local autocorrelation of the onset envelope, read
//!   under a log-normal prior centred on 120 BPM. This resolves the one
//!   ambiguity accents cannot: "beat" versus "half-bar".
//!
//! This is the last stage with a librosa-shaped contract in the accuracy path,
//! and audit finding F-07 records that **nothing in v3 tests it** — the
//! accuracy benchmark normalises octaves away, so a change here could halve
//! every reported BPM with all 24 rows still green. The Python-side gate
//! `bench/gates.py bpm-snapshot` exists to catch exactly that, and the Rust
//! port is checked against v3's recorded `atoms_per_beat` per fixture.

use realfft::RealFftPlanner;

use crate::fit::Grid;

/// Atom counts a beat may be made of. Not every integer: 11 atoms per beat is
/// not a rhythm, it is a fit artefact.
pub const BEAT_MULTIPLES: [usize; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16];
/// Autocorrelation window, in coarse frames. librosa's default is 384; v3
/// passes 192 because it runs on a 4x decimated envelope.
const TEMPOGRAM_WIN: usize = 192;
/// The envelope is max-pooled by this much before the tempogram. A tempo hint
/// needs no more resolution than ~12 ms, and the full-rate tempogram cost v3
/// about ten seconds a track — almost all of its runtime.
const DECIMATE: usize = 4;
/// Tempo range the hints are read over, in BPM.
const HINT_RANGE: (f64, f64) = (40.0, 420.0);
/// Width of the Gaussian agreement in log2-tempo space. An octave away scores
/// about zero, which is the point.
const HINT_SIGMA: f64 = 0.35;

/// Max-pool the envelope, as v3 does before the tempogram.
fn decimate_max(env: &[f32], factor: usize) -> Vec<f32> {
    let usable = (env.len() / factor) * factor;
    if usable == 0 {
        return env.to_vec();
    }
    env[..usable]
        .chunks_exact(factor)
        .map(|chunk| chunk.iter().copied().fold(f32::NEG_INFINITY, f32::max))
        .collect()
}

/// Periodic Hann, the window librosa autocorrelates through.
fn hann_periodic(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos())
        .collect()
}

/// Mean tempogram column: the average, over time, of each frame's normalised
/// autocorrelation.
///
/// The per-column normalisation is why this cannot be simplified into "the
/// autocorrelation of the mean envelope" — each column is divided by its own
/// maximum before averaging, which is what stops a loud section dominating.
fn tempogram_mean(env: &[f32], win_length: usize) -> Vec<f64> {
    let n = env.len();
    if n == 0 || win_length < 2 {
        return vec![0.0; win_length.max(1)];
    }
    // `center=True` pads by win_length/2 on both sides with a *linear ramp*
    // down to zero — not zeros, not edge values.
    let pad = win_length / 2;
    let mut padded = vec![0.0f64; n + 2 * pad];
    let first = env[0] as f64;
    let last = env[n - 1] as f64;
    for i in 0..pad {
        // numpy's linear_ramp: from end_value at the outer edge to the array
        // value at the inner edge.
        let t = i as f64 / pad as f64;
        padded[i] = t * first;
        padded[n + pad + i] = (1.0 - (i + 1) as f64 / pad as f64) * last;
    }
    for (slot, &value) in padded[pad..pad + n].iter_mut().zip(env) {
        *slot = value as f64;
    }

    let window = hann_periodic(win_length);
    // Autocorrelation via FFT, on the next fast length for 2*win-1.
    let fft_len = (2 * win_length - 1).next_power_of_two();
    let mut planner = RealFftPlanner::<f64>::new();
    let forward = planner.plan_fft_forward(fft_len);
    let inverse = planner.plan_fft_inverse(fft_len);

    let mut input = forward.make_input_vec();
    let mut spectrum = forward.make_output_vec();
    let mut output = inverse.make_output_vec();
    let mut accumulator = vec![0.0f64; win_length];
    let mut columns = 0usize;

    for start in 0..n {
        if start + win_length > padded.len() {
            break;
        }
        input.fill(0.0);
        for (slot, (&value, &w)) in input
            .iter_mut()
            .zip(padded[start..start + win_length].iter().zip(&window))
        {
            *slot = value * w;
        }
        if forward.process(&mut input, &mut spectrum).is_err() {
            continue;
        }
        for bin in spectrum.iter_mut() {
            let power = bin.re * bin.re + bin.im * bin.im;
            *bin = realfft::num_complex::Complex::new(power, 0.0);
        }
        if inverse.process(&mut spectrum, &mut output).is_err() {
            continue;
        }
        // realfft's inverse is unnormalised; the per-column inf-norm below
        // divides the scale out anyway, so it only has to be consistent.
        let peak = output[..win_length]
            .iter()
            .fold(0.0f64, |m, &v| m.max(v.abs()));
        if peak <= 0.0 {
            continue;
        }
        for (slot, &value) in accumulator.iter_mut().zip(&output[..win_length]) {
            *slot += value / peak;
        }
        columns += 1;
    }

    if columns == 0 {
        return vec![0.0; win_length];
    }
    accumulator.iter().map(|&v| v / columns as f64).collect()
}

/// BPM of each autocorrelation lag. Lag 0 is infinite and is never used.
fn tempo_frequencies(bins: usize, hop: usize, sr: u32) -> Vec<f64> {
    (0..bins)
        .map(|lag| {
            if lag == 0 {
                f64::INFINITY
            } else {
                60.0 * sr as f64 / (hop as f64 * lag as f64)
            }
        })
        .collect()
}

/// Perceptual tempo hypotheses as `(bpm, weight)`, used **only** to choose the
/// octave.
pub fn tempo_hints(env: &[f32], sr: u32, hop: usize) -> Vec<(f64, f64)> {
    let coarse = decimate_max(env, DECIMATE);
    if coarse.len() < TEMPOGRAM_WIN {
        return Vec::new();
    }
    let step = hop * DECIMATE;
    let mut agg = tempogram_mean(&coarse, TEMPOGRAM_WIN);
    let freqs = tempo_frequencies(agg.len(), step, sr);

    // Keep the plausible tempo range, then normalise to a peak of one.
    let keep: Vec<usize> = (0..agg.len())
        .filter(|&i| freqs[i].is_finite() && freqs[i] >= HINT_RANGE.0 && freqs[i] <= HINT_RANGE.1)
        .collect();
    if keep.len() < 8 {
        return Vec::new();
    }
    let masked_freqs: Vec<f64> = keep.iter().map(|&i| freqs[i]).collect();
    let mut masked: Vec<f64> = keep.iter().map(|&i| agg[i].max(0.0)).collect();
    agg.clear();
    let peak = masked.iter().fold(0.0f64, |m, &v| m.max(v));
    if peak <= 1e-9 {
        return Vec::new();
    }
    for value in &mut masked {
        *value /= peak;
    }

    let picked = overtone_dsp::peaks::find_peaks(&masked, 3, Some(0.05), None);
    if picked.is_empty() {
        return Vec::new();
    }
    // librosa's tempo prior: log-normal in log2 space, centred on 120 BPM.
    let prior = |bpm: f64| (-0.5 * (bpm / 120.0).log2().powi(2)).exp();
    // .rev(): max_by keeps the last of equal maxima; v3's np.argmax the first.
    let best = picked
        .iter()
        .copied()
        .rev()
        .max_by(|&a, &b| {
            (masked[a] * prior(masked_freqs[a])).total_cmp(&(masked[b] * prior(masked_freqs[b])))
        })
        .expect("picked is non-empty");

    let mut hints = vec![(masked_freqs[best], 1.0)];
    // Then the most prominent peaks regardless of the prior, so a genuinely
    // fast track can still be read fast.
    let prominences = prominence_of(&masked, &picked);
    let mut order: Vec<usize> = (0..picked.len()).collect();
    // Ties in descending index, as v3's np.argsort(...)[::-1] leaves them.
    order.sort_by(|&a, &b| prominences[b].total_cmp(&prominences[a]).then(b.cmp(&a)));
    for &i in order.iter().take(5) {
        hints.push((masked_freqs[picked[i]], masked[picked[i]]));
    }
    hints
}

/// scipy-compatible prominence, reused from the DSP crate's peak picker.
fn prominence_of(x: &[f64], peaks: &[usize]) -> Vec<f64> {
    peaks
        .iter()
        .map(|&peak| {
            let height = x[peak];
            let mut left = height;
            let mut i = peak as isize;
            while i >= 0 && x[i as usize] <= height {
                left = left.min(x[i as usize]);
                i -= 1;
            }
            let mut right = height;
            let mut i = peak;
            while i < x.len() && x[i] <= height {
                right = right.min(x[i]);
                i += 1;
            }
            height - left.max(right)
        })
        .collect()
}

/// Gaussian agreement between a candidate BPM and the hints, in log2 space.
pub fn hint_score(hints: &[(f64, f64)], bpm: f64) -> f64 {
    let mut best = 0.0f64;
    for &(hint, weight) in hints {
        if hint <= 0.0 {
            continue;
        }
        let distance = (bpm / hint).log2().abs();
        let score = weight * (-(distance * distance) / (2.0 * HINT_SIGMA * HINT_SIGMA)).exp();
        best = best.max(score);
    }
    best
}

/// `(atoms per beat, which atom class carries the accent)`.
pub fn beat_from_atoms(
    times: &[f64],
    weights: &[f32],
    grid: Grid,
    hints: &[(f64, f64)],
    prefer_map_bpm: bool,
) -> (usize, usize) {
    let inlier: Vec<usize> = (0..times.len())
        .filter(|&i| {
            let k = ((times[i] - grid.phase) / grid.period).round();
            (times[i] - (grid.phase + k * grid.period)).abs() <= 0.15 * grid.period
        })
        .collect();
    if inlier.len() < 8 {
        return (1, 0);
    }
    let k: Vec<i64> = inlier
        .iter()
        .map(|&i| ((times[i] - grid.phase) / grid.period).round() as i64)
        .collect();
    let w: Vec<f64> = inlier.iter().map(|&i| weights[i] as f64).collect();
    let k_min = *k.iter().min().unwrap();
    let k_max = *k.iter().max().unwrap();

    let mut best = (1usize, 0usize, f64::NEG_INFINITY);
    for &m in &BEAT_MULTIPLES {
        let bpm = 60.0 / (grid.period * m as f64);
        if !(55.0..=420.0).contains(&bpm) {
            continue;
        }
        let mut totals = vec![0.0f64; m];
        let mut counts = vec![0usize; m];
        for (&index, &weight) in k.iter().zip(&w) {
            let class = index.rem_euclid(m as i64) as usize;
            totals[class] += weight;
            counts[class] += 1;
        }
        let means: Vec<f64> = (0..m)
            .map(|c| {
                if counts[c] > 0 {
                    totals[c] / counts[c] as f64
                } else {
                    0.0
                }
            })
            .collect();
        // .rev(): max_by keeps the last of equal maxima; np.argmax the first.
        let (r, &top) = means
            .iter()
            .enumerate()
            .rev()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .expect("m >= 1");
        let low = means.iter().copied().fold(f64::INFINITY, f64::min);
        // Accent *depth*, not a ratio to the mean: if m atoms really make a
        // beat, one class holds the kicks and another the filler.
        let depth = (top - low) / top.max(1e-9);
        let beats = (k_max - k_min) as f64 / m as f64 + 1.0;
        let coverage = (counts[r] as f64 / beats.max(1.0)).min(1.0);
        let in_range = (120.0..=300.0).contains(&bpm);

        let score = 0.95 * hint_score(hints, bpm)
            + 0.85 * (depth / 0.35).min(1.0)
            + 0.70 * coverage
            // osu! is mapped at 120-300 BPM; when the accent evidence is
            // equally happy either way, this is what breaks the tie.
            + if prefer_map_bpm && in_range { 0.40 } else { 0.0 }
            - 0.45 * (90.0f64 / bpm).log2().max(0.0)
            - 0.45 * (bpm / 340.0).log2().max(0.0);

        if score > best.2 {
            best = (m, r, score);
        }
    }
    (best.0, best.1)
}

/// A 4-beat bar's downbeat must also out-weigh the beat half a bar away — v3
/// `HALF_BAR_CONTRAST`. The onset envelope favours broadband hits, so a snare
/// on 2 and 4 (or, at double tempo, on every other "beat") can out-weigh the
/// kick on 1; a pattern that repeats every half bar cannot say which half
/// starts the bar. On 88 ranked maps, the 9 claimed bars below 1.25 all
/// missed the map's downbeat.
pub const HALF_BAR_CONTRAST: f64 = 1.25;

/// `(meter, downbeat class, beats per bar to snap to)`.
///
/// The third value is the bar length **only when the accents prove one**;
/// otherwise it is 1, meaning "align the first red line to a beat, not a bar".
/// Guessing a bar without evidence would push the first offset up to three
/// beats past the first sound.
pub fn meter_from_grid(times: &[f64], weights: &[f32], grid: Grid) -> (&'static str, usize, usize) {
    let inlier: Vec<(i64, f64)> = times
        .iter()
        .enumerate()
        .filter_map(|(i, &t)| {
            let k = ((t - grid.phase) / grid.period).round();
            ((t - (grid.phase + k * grid.period)).abs() <= 0.15 * grid.period)
                .then(|| (k as i64, weights[i] as f64))
        })
        .collect();
    if inlier.len() < 12 {
        return ("4/4", 0, 1);
    }
    let k_min = inlier.iter().map(|(k, _)| *k).min().unwrap();
    let k_max = inlier.iter().map(|(k, _)| *k).max().unwrap();

    let mut best = (4usize, 0usize, 0.0f64);
    let mut best_means = vec![1.0f64; 4];
    for meter in [4usize, 3] {
        if (k_max - k_min) < (meter as i64) * 4 {
            continue;
        }
        let mut totals = vec![0.0f64; meter];
        let mut counts = vec![0usize; meter];
        for &(k, w) in &inlier {
            let class = k.rem_euclid(meter as i64) as usize;
            totals[class] += w;
            counts[class] += 1;
        }
        let means: Vec<f64> = (0..meter)
            .map(|c| {
                if counts[c] > 0 {
                    totals[c] / counts[c] as f64
                } else {
                    0.0
                }
            })
            .collect();
        // .rev(): max_by keeps the last of equal maxima; np.argmax the first.
        let (r, &top) = means
            .iter()
            .enumerate()
            .rev()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .expect("meter >= 1");
        let mean_of_means = means.iter().sum::<f64>() / meter as f64;
        let contrast = top / mean_of_means.max(1e-9);
        if contrast > best.2 {
            best = (meter, r, contrast);
            best_means = means;
        }
    }
    if best.2 < 1.20 {
        // No usable accent: do not move the offset.
        return ("4/4", 0, 1);
    }
    if best.0 % 2 == 0 {
        let opposite = best_means[(best.1 + best.0 / 2) % best.0];
        if best_means[best.1] < HALF_BAR_CONTRAST * opposite {
            // The accent repeats every half bar.
            return ("4/4", 0, 1);
        }
    }
    (if best.0 == 4 { "4/4" } else { "3/4" }, best.1, best.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Atoms with an accent every `m`-th one, as a kick/hat pattern would be.
    fn accented(atom: f64, m: usize, count: usize, offset: usize) -> (Vec<f64>, Vec<f32>) {
        let times = (0..count).map(|k| k as f64 * atom).collect();
        let weights = (0..count)
            .map(|k| if k % m == offset { 1.0f32 } else { 0.35 })
            .collect();
        (times, weights)
    }

    #[test]
    fn accent_depth_finds_two_atoms_per_beat() {
        // Eighth notes at 150 BPM: the atom is 0.2 s, the beat is 0.4 s.
        let (times, weights) = accented(0.2, 2, 300, 0);
        let (m, class) = beat_from_atoms(
            &times,
            &weights,
            Grid {
                period: 0.2,
                phase: 0.0,
            },
            &[(150.0, 1.0)],
            true,
        );
        assert_eq!(m, 2, "expected 2 atoms per beat, got {m}");
        assert_eq!(class, 0);
    }

    #[test]
    fn accent_depth_finds_the_offset_class() {
        let (times, weights) = accented(0.2, 4, 400, 1);
        let (m, class) = beat_from_atoms(
            &times,
            &weights,
            Grid {
                period: 0.2,
                phase: 0.0,
            },
            &[(75.0, 1.0)],
            false,
        );
        assert_eq!(m, 4);
        assert_eq!(class, 1, "the accent sits on class 1");
    }

    #[test]
    fn an_unaccented_grid_stays_at_one_atom_per_beat() {
        // Every atom equally loud: there is no accent evidence, so m = 1 --
        // which scores zero depth by construction, and that is correct.
        let times: Vec<f64> = (0..300).map(|k| k as f64 * 0.4).collect();
        let weights = vec![1.0f32; times.len()];
        let (m, _) = beat_from_atoms(
            &times,
            &weights,
            Grid {
                period: 0.4,
                phase: 0.0,
            },
            &[(150.0, 1.0)],
            true,
        );
        assert_eq!(m, 1);
    }

    #[test]
    fn hint_score_falls_off_by_an_octave() {
        let hints = [(150.0, 1.0)];
        assert!(hint_score(&hints, 150.0) > 0.99);
        assert!(
            hint_score(&hints, 300.0) < 0.05,
            "an octave away must be ~0"
        );
        assert!(hint_score(&hints, 75.0) < 0.05);
    }

    #[test]
    fn hint_score_takes_the_best_hint() {
        let hints = [(90.0, 0.4), (180.0, 1.0)];
        assert!(hint_score(&hints, 180.0) > hint_score(&hints, 90.0));
    }

    #[test]
    fn map_preference_breaks_a_tie_towards_osu_range() {
        // A grid whose accents are equally happy at 1 or 2 atoms per beat, and
        // no hints at all. With the preference on, the in-range reading wins.
        let (times, weights) = accented(0.15, 2, 400, 0);
        let (with, _) = beat_from_atoms(
            &times,
            &weights,
            Grid {
                period: 0.15,
                phase: 0.0,
            },
            &[],
            true,
        );
        // 0.15 s atoms: m=1 is 400 BPM, m=2 is 200 BPM (in range).
        assert_eq!(with, 2);
    }

    #[test]
    fn meter_refuses_to_guess_without_accents() {
        let times: Vec<f64> = (0..200).map(|k| k as f64 * 0.5).collect();
        let weights = vec![1.0f32; times.len()];
        let (meter, downbeat, bar) = meter_from_grid(
            &times,
            &weights,
            Grid {
                period: 0.5,
                phase: 0.0,
            },
        );
        assert_eq!(meter, "4/4");
        assert_eq!(downbeat, 0);
        assert_eq!(bar, 1, "no accent evidence must mean 'snap to a beat'");
    }

    #[test]
    fn meter_finds_four_four_when_the_downbeat_is_accented() {
        let (times, weights) = accented(0.5, 4, 200, 0);
        let (meter, downbeat, bar) = meter_from_grid(
            &times,
            &weights,
            Grid {
                period: 0.5,
                phase: 0.0,
            },
        );
        assert_eq!(meter, "4/4");
        assert_eq!(downbeat, 0);
        assert_eq!(bar, 4);
    }

    /// Four-beat cycles with these class weights (±3 %), 64 bars at 0.25 s.
    fn cycles(class_weights: &[f64]) -> (Vec<f64>, Vec<f32>) {
        let mut seed = 0u64;
        let n = 64 * class_weights.len();
        let times = (0..n).map(|k| 0.5 + k as f64 * 0.25).collect();
        let weights = (0..n)
            .map(|k| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let jitter = 0.97 + 0.06 * ((seed >> 33) as f64 / (1u64 << 31) as f64);
                (class_weights[k % class_weights.len()] * jitter) as f32
            })
            .collect();
        (times, weights)
    }

    #[test]
    fn a_backbeat_is_not_a_downbeat() {
        // Kick-beats 1.05, snare-beats 1.25, off-beats 0.85: 1.25 over the
        // mean, but only 1.19 over the class half a bar away.
        let grid = Grid {
            period: 0.25,
            phase: 0.5,
        };
        let (times, weights) = cycles(&[1.05, 0.85, 1.25, 0.85]);
        assert_eq!(meter_from_grid(&times, &weights, grid), ("4/4", 0, 1));
        let (times, weights) = cycles(&[1.0, 1.0, 1.5, 1.0]);
        assert_eq!(meter_from_grid(&times, &weights, grid), ("4/4", 2, 4));
        let (times, weights) = cycles(&[1.5, 1.0, 1.0]);
        assert_eq!(meter_from_grid(&times, &weights, grid), ("3/4", 0, 3));
    }

    #[test]
    fn ties_go_to_the_first_class_as_in_v3() {
        // Iterator::max_by keeps the last of equal maxima, np.argmax the
        // first. Expected values are v3's own answers on the same input.
        let times: Vec<f64> = (0..300).map(|k| k as f64 * 0.2).collect();
        let ones = vec![1.0f32; times.len()];
        let grid = Grid {
            period: 0.2,
            phase: 0.0,
        };
        assert_eq!(
            beat_from_atoms(&times, &ones, grid, &[(150.0, 1.0)], true),
            (2, 0)
        );
        assert_eq!(
            beat_from_atoms(&times, &ones, grid, &[(75.0, 1.0)], true),
            (4, 0)
        );
        assert_eq!(
            crate::sections::phase_class(&times, &ones, grid.period, grid.phase, 4),
            0
        );
        // Two strongest classes tied in a 3-beat bar: v3 says ('3/4', 0, 3).
        let (times, weights) = cycles(&[2.0, 2.0, 0.5]);
        let grid = Grid {
            period: 0.25,
            phase: 0.5,
        };
        assert_eq!(meter_from_grid(&times, &weights, grid), ("3/4", 0, 3));
    }

    #[test]
    fn meter_finds_three_four() {
        let (times, weights) = accented(0.5, 3, 200, 0);
        let (meter, _downbeat, bar) = meter_from_grid(
            &times,
            &weights,
            Grid {
                period: 0.5,
                phase: 0.0,
            },
        );
        assert_eq!(meter, "3/4");
        assert_eq!(bar, 3);
    }

    #[test]
    fn decimate_takes_the_maximum_not_the_mean() {
        let env = [0.0f32, 1.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0];
        assert_eq!(decimate_max(&env, 4), vec![1.0, 0.2]);
    }

    #[test]
    fn phase_class_locates_the_accent() {
        let (times, weights) = accented(0.2, 4, 400, 2);
        let class = crate::sections::phase_class(&times, &weights, 0.2, 0.0, 4);
        assert_eq!(class, 2);
    }
}
