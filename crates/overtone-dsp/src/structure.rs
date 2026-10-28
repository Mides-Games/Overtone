//! Musical structure: novelty curve, phrase boundaries, energy map.
//!
//! Harmony (chroma) and dynamics (windowed RMS) sampled every half second,
//! cosine self-similarity between windows, and a Foote checkerboard kernel
//! along the diagonal: where the future stops resembling the past, the
//! novelty curve peaks, and peaks are phrase boundaries. The energy map
//! rides alongside — verse/chorus contrast that harmony alone cannot see.
//!
//! [`phrases`] reads the same windows for sections instead: where the music
//! starts or stops repeating something heard elsewhere in the song. On
//! ranked maps the checkerboard's peaks sat no closer to a kiai start than
//! chance (11.6 % of kiai starts with an edge within 2 bars, 16.7 % by
//! chance, on 500 held-out songs); the repetition edges put one within 2
//! bars of 58.0 %, and 39.8 % of them sit near a kiai start or end (16.5 %
//! by chance). [`analyze`] stays as it was for the hitsound engine, whose
//! proposals were measured with its edges.
//!
//! Two deliberate scope cuts, both recorded rather than hidden. Downbeat
//! snapping belongs to the tempo layer, which owns grids; this crate is
//! tempoless, so boundaries sit on the 0.5 s feature grid. And timbre
//! (MFCC) does not enter the similarity: harmony plus dynamics segment
//! phrases, so a change of instrumentation over the same chords at the
//! same level is not a boundary this reads. Section classification
//! ([`crate::classify`]) labels the phrases from chroma and energy too.

use rayon::prelude::*;

use crate::{chroma, stft};

/// Feature hop in seconds. Half a second resolves 12 s phrases with room
/// to spare and keeps the similarity matrix small (a 6-minute track is
/// 720 windows, half a million cosine pairs).
pub const WIN_S: f64 = 0.5;
/// Checkerboard half-size in windows. Eight windows (4 s) each side sees a
/// full phrase neighbourhood without reaching past short sections.
pub const KERNEL_HALF: usize = 8;
/// Novelty peaks below this fraction of the global maximum are texture,
/// not structure.
pub const PEAK_FRACTION: f64 = 0.30;
/// Peaks closer than this merge into the stronger one. Four seconds is
/// below any phrase worth a red line and above any straddle wobble.
pub const MERGE_S: f64 = 4.0;

/// Seconds each window carries into its repetition fingerprint: the window
/// and the ones before it (delay embedding), so a repeat is a run of
/// chords, not one chord that recurs everywhere.
pub const EMBED_S: f64 = 1.5;
/// A window recurs with its nearest neighbours by that fingerprint, this
/// fraction of the song's windows, kept only where both are among each
/// other's nearest.
pub const NEIGHBOURS: f64 = 0.04;
/// Gaussian smoothing (sigma) of the time-lag matrix along time: one row
/// per window, one column per lag at which it recurs. On ranked maps 4 and
/// 5 s read within a point of F1 of each other and 3 s three points under;
/// smoothing along lag as well read no better.
pub const SMOOTH_TIME_S: f64 = 4.0;
/// A repetition edge stands this far over the moving median of its curve,
/// in units of the curve's maximum.
pub const EDGE_OVER_MEDIAN: f64 = 0.1;
/// How far either side of a window that moving median runs.
pub const MEDIAN_S: f64 = 14.0;
/// Lags per block: the smoothed time-lag matrix, windows squared in reals,
/// is built a block of lags at a time and never held whole; the
/// recurrences behind it are one bit a pair.
const LAG_BLOCK: usize = 64;

/// Phrase boundaries in seconds, plus the RMS energy map behind them.
#[derive(Debug, Clone)]
pub struct Structure {
    pub boundaries: Vec<f64>,
    pub energy: Vec<f64>,
    pub energy_hop: f64,
}

/// Per-window features (twelve chroma means plus the log-energy term), the
/// RMS lane and the windows' real length. `features` and `rms` are empty
/// for inputs shorter than two kernel widths.
struct Windows {
    features: Vec<Vec<f64>>,
    rms: Vec<f64>,
    win_s: f64,
}

/// The windows both edge finders read.
fn windows(y: &[f32], sr: u32) -> Windows {
    let hop = (WIN_S * sr as f64).round() as usize;
    let n_fft = 2048;
    // Twelve classes per frame, reduced as each frame is computed: the
    // linear spectrogram of a 6-minute track is over a gigabyte.
    let chroma = stft::map_frames(y, n_fft, 128, |power| {
        chroma::chroma_frame(power, sr, n_fft)
    });
    // The windows' real length: `hop` samples, WIN_S only to rounding.
    let win_s = hop as f64 / sr as f64;
    // Windows, not STFT frames: the loop below indexes feature windows, so
    // a short track must bow out here rather than panic there.
    if hop == 0 || y.len().div_ceil(hop) < 2 * KERNEL_HALF + 1 {
        return Windows {
            features: Vec::new(),
            rms: Vec::new(),
            win_s,
        };
    }

    // Per-window features: mean chroma plus normalised log energy. The
    // energy term is what segments verse from chorus when the chords match.
    let mut peak_rms = 1e-9f64;
    let mut rms = Vec::new();
    let mut start = 0usize;
    while start < y.len() {
        let end = (start + hop).min(y.len());
        let energy: f64 = y[start..end]
            .iter()
            .map(|&v| (v as f64).powi(2))
            .sum::<f64>()
            / (end - start).max(1) as f64;
        peak_rms = peak_rms.max(energy.sqrt());
        rms.push(energy.sqrt());
        start = end;
    }
    let windows = rms.len();
    let mut features: Vec<Vec<f64>> = Vec::with_capacity(windows);
    for (w, &window_rms) in rms.iter().enumerate() {
        // The STFT frames whose centres (sample `f * 128`) fall inside the
        // window's samples. A fixed 172 frames per window is 0.49923 s, so
        // chroma ran ahead of the energy windows -- 0.37 s by four minutes,
        // a whole window late on the boundary.
        let lo = (w * hop).div_ceil(128).min(chroma.len());
        let hi = ((w + 1) * hop).div_ceil(128).min(chroma.len());
        let mut mean = [0.0f64; 12];
        if hi > lo {
            for frame in &chroma[lo..hi] {
                for (c, acc) in mean.iter_mut().enumerate() {
                    *acc += frame[c];
                }
            }
            let n = (hi - lo) as f64;
            for acc in mean.iter_mut() {
                *acc /= n;
            }
        }
        // Log-energy beside the chroma: 0 at silence, 1 at full scale,
        // logarithmic in between, so verse/chorus contrast survives next
        // to pitch content without drowning it. ln(1e-9) = -20.723.
        let r = (window_rms / peak_rms).clamp(0.0, 1.0);
        let mut vec = mean.to_vec();
        vec.push((1.0 + r.max(1e-9).ln() / 20.723).clamp(0.0, 1.0));
        features.push(vec);
    }
    Windows {
        features,
        rms,
        win_s,
    }
}

/// Segment audio into phrases. Empty on silence or inputs shorter than two
/// kernel widths.
///
/// The checkerboard needs [`KERNEL_HALF`] windows on each side of a
/// boundary, so novelty exists only from 4 s after the start to 4-4.5 s
/// before the end, and no boundary is ever reported in those end spans
/// (leading silence included). A change inside one is lost, or read on the
/// span's edge: measured on a 40 s track, a chord change at 2 s came out at
/// 4.0 s, one at 38 s was lost, and one at 37 s came out at 35.5 s.
pub fn analyze(y: &[f32], sr: u32) -> Structure {
    let Windows {
        features,
        rms,
        win_s,
    } = windows(y, sr);
    if features.is_empty() {
        return Structure {
            boundaries: Vec::new(),
            energy: Vec::new(),
            energy_hop: win_s,
        };
    }
    let windows = features.len();

    // Cosine self-similarity.
    let norms: Vec<f64> = features
        .iter()
        .map(|v| v.iter().map(|&x| x * x).sum::<f64>().sqrt())
        .collect();
    let sim = |a: usize, b: usize| -> f64 {
        if norms[a] <= 0.0 || norms[b] <= 0.0 {
            return 0.0;
        }
        features[a]
            .iter()
            .zip(features[b].iter())
            .map(|(&x, &y)| x * y)
            .sum::<f64>()
            / (norms[a] * norms[b])
    };

    // Foote novelty: homogeneity within past/future minus across. The
    // early return above guarantees windows >= 2*K+1, so every index below
    // is in range — no saturating arithmetic needed here.
    let mut novelty = vec![0.0f64; windows];
    for (i, slot) in novelty
        .iter_mut()
        .enumerate()
        .take(windows - KERNEL_HALF)
        .skip(KERNEL_HALF)
    {
        let (mut within, mut across) = (0.0, 0.0);
        let (mut n_within, mut n_across) = (0usize, 0usize);
        for a in i - KERNEL_HALF..i {
            for b in i - KERNEL_HALF..i {
                within += sim(a, b);
                n_within += 1;
            }
            for b in i..i + KERNEL_HALF {
                across += sim(a, b);
                n_across += 1;
            }
        }
        for a in i..i + KERNEL_HALF {
            for b in i..i + KERNEL_HALF {
                within += sim(a, b);
                n_within += 1;
            }
        }
        *slot = within / n_within.max(1) as f64 - across / n_across.max(1) as f64;
    }

    // Peak-pick, threshold relative to the global max, merge neighbours.
    let peak = novelty.iter().copied().fold(0.0f64, f64::max);
    let mut found: Vec<usize> = if peak > 1e-9 {
        crate::peaks::find_peaks(&novelty, 2, None, Some(PEAK_FRACTION * peak))
    } else {
        Vec::new()
    };
    found.sort_unstable();
    // No edge filtering: novelty is zero outside the kernel's reach, so no
    // peak can land within KERNEL_HALF windows of either end.
    let merged = merge_close(&found, &novelty, (MERGE_S / WIN_S).round() as usize);
    Structure {
        boundaries: merged.iter().map(|&i| i as f64 * win_s).collect(),
        energy: rms,
        energy_hop: win_s,
    }
}

/// Section edges where repetition starts or stops (structure features,
/// Serrà et al. 2012), for the Structure view. Empty on silence or inputs
/// shorter than two kernel widths; the same blind spans at either end as
/// [`analyze`], and the same energy lane.
///
/// Each window's fingerprint is its features over [`EMBED_S`]; windows
/// recur where their fingerprints are mutual nearest neighbours. Laid out
/// by lag (row: window, column: how far ahead, around the song, it
/// recurs) and smoothed along time, a row changes where a section begins
/// or ends: the lags at which the song repeats itself change there. The
/// curve is how much each row differs from the one before; an edge is a
/// peak over the curve's moving median by [`EDGE_OVER_MEDIAN`], merged at
/// [`MERGE_S`].
///
/// What it reads is the set of lags at which each window recurs, so a part
/// that differs from another only in level is the same part to it: one
/// held chord played quiet and loud by turns (12/24/36 s) gives a single
/// edge, between the halves. The measure that chose it is ranked maps'
/// kiai (timeline.md).
pub fn phrases(y: &[f32], sr: u32) -> Structure {
    let Windows {
        features,
        rms,
        win_s,
    } = windows(y, sr);
    if features.is_empty() {
        return Structure {
            boundaries: Vec::new(),
            energy: Vec::new(),
            energy_hop: win_s,
        };
    }
    let curve = repetition_curve(&features, win_s);
    Structure {
        boundaries: repetition_edges(&curve, win_s)
            .iter()
            .map(|&i| i as f64 * win_s)
            .collect(),
        energy: rms,
        energy_hop: win_s,
    }
}

/// scipy.ndimage's Gaussian: radius `int(4 sigma + 0.5)` windows, weights
/// summing to one.
fn gaussian(sigma: f64) -> Vec<f64> {
    let radius = (4.0 * sigma + 0.5) as usize;
    let weights: Vec<f64> = (0..=2 * radius)
        .map(|i| {
            let x = i as f64 - radius as f64;
            (-0.5 * x * x / (sigma * sigma)).exp()
        })
        .collect();
    let sum: f64 = weights.iter().sum();
    weights.into_iter().map(|w| w / sum).collect()
}

/// Which windows recur with which: row `i` holds bit `j` when `i` and `j`
/// are among each other's `NEIGHBOURS` nearest by cosine over the delay
/// embedding. Ties at the k-th similarity are all kept.
fn recurrences(features: &[Vec<f64>], win_s: f64) -> Vec<Vec<u64>> {
    let n = features.len();
    let depth = ((EMBED_S / win_s).round() as usize).max(1);
    // Window i with the depth-1 before it; before the first, the first.
    let embedded: Vec<Vec<f64>> = (0..n)
        .map(|i| {
            let mut v = Vec::with_capacity(features[0].len() * depth);
            for j in 0..depth {
                v.extend_from_slice(&features[i.saturating_sub(j)]);
            }
            v
        })
        .collect();
    let norms: Vec<f64> = embedded
        .iter()
        .map(|v| v.iter().map(|&x| x * x).sum::<f64>().sqrt())
        .collect();
    let sim = |a: usize, b: usize| -> f64 {
        if norms[a] <= 0.0 || norms[b] <= 0.0 {
            return 0.0;
        }
        embedded[a]
            .iter()
            .zip(&embedded[b])
            .map(|(&x, &y)| x * y)
            .sum::<f64>()
            / (norms[a] * norms[b])
    };
    let k = ((NEIGHBOURS * n as f64).round() as usize).clamp(1, n - 1);
    // Each window's k-th highest similarity to another window; the pairs
    // are computed twice rather than held, n^2 of them on an hour-long mix.
    let kth: Vec<f64> = (0..n)
        .into_par_iter()
        .map(|i| {
            let mut row: Vec<f64> = (0..n).filter(|&j| j != i).map(|j| sim(i, j)).collect();
            let (_, value, _) = row.select_nth_unstable_by(k - 1, |a, b| b.total_cmp(a));
            *value
        })
        .collect();
    let words = n.div_ceil(64);
    (0..n)
        .into_par_iter()
        .map(|i| {
            let mut bits = vec![0u64; words];
            for j in (0..n).filter(|&j| j != i) {
                let s = sim(i, j);
                if s >= kth[i] && s >= kth[j] {
                    bits[j / 64] |= 1u64 << (j % 64);
                }
            }
            bits
        })
        .collect()
}

/// How much the smoothed time-lag row of each window differs from the one
/// before, over its maximum between the first and last [`KERNEL_HALF`]
/// windows, the spans the checkerboard of [`analyze`] cannot place an edge
/// in either. The curve keeps its values there: zeroed, the first window
/// past them turned into a peak whenever the curve fell from it (299 of
/// 3738 edges on ranked maps, 3 of them near a kiai change).
fn repetition_curve(features: &[Vec<f64>], win_s: f64) -> Vec<f64> {
    let n = features.len();
    let rows = recurrences(features, win_s);
    let recurs = |i: usize, j: usize| rows[i][j / 64] >> (j % 64) & 1 == 1;
    let along_time = gaussian(SMOOTH_TIME_S / win_s);
    let reach = along_time.len() / 2;
    // Per block of lags: the lag columns, smoothed along time (the first
    // and last rows held), and each row's squared step from the row before.
    // The blocks come back in order and are summed in order, so the curve
    // does not depend on the thread count.
    let firsts: Vec<usize> = (0..n).step_by(LAG_BLOCK).collect();
    let steps: Vec<Vec<f64>> = firsts
        .into_par_iter()
        .map(|first| {
            let width = LAG_BLOCK.min(n - first);
            let mut by_lag = vec![0.0f64; n * width];
            for (i, row) in by_lag.chunks_exact_mut(width).enumerate() {
                for (c, slot) in row.iter_mut().enumerate() {
                    if recurs(i, (i + first + c) % n) {
                        *slot = 1.0;
                    }
                }
            }
            let mut step = vec![0.0f64; n];
            let mut previous = vec![0.0f64; width];
            for (i, slot) in step.iter_mut().enumerate() {
                for (c, last) in previous.iter_mut().enumerate() {
                    let mut acc = 0.0;
                    for (e, &w) in along_time.iter().enumerate() {
                        let t = (i + e).saturating_sub(reach).min(n - 1);
                        acc += w * by_lag[t * width + c];
                    }
                    if i > 0 {
                        *slot += (acc - *last).powi(2);
                    }
                    *last = acc;
                }
            }
            step
        })
        .collect();
    let mut curve = vec![0.0f64; n];
    for step in &steps {
        for (slot, v) in curve.iter_mut().zip(step) {
            *slot += v;
        }
    }
    for v in curve.iter_mut() {
        *v = v.sqrt();
    }
    let peak = curve[placeable(n)]
        .iter()
        .copied()
        .fold(0.0f64, f64::max);
    if peak > 0.0 {
        for v in curve.iter_mut() {
            *v /= peak;
        }
    }
    curve
}

/// The windows an edge may sit on: past the first [`KERNEL_HALF`] and
/// before the last, as for the checkerboard.
fn placeable(n: usize) -> std::ops::Range<usize> {
    KERNEL_HALF..n.saturating_sub(KERNEL_HALF).max(KERNEL_HALF)
}

/// The moving median of `values` over `2 half + 1` windows, the ends held
/// (scipy.ndimage.median_filter, mode "nearest").
fn moving_median(values: &[f64], half: usize) -> Vec<f64> {
    let n = values.len();
    let mut window = Vec::with_capacity(2 * half + 1);
    (0..n)
        .map(|i| {
            window.clear();
            window.extend(
                (0..=2 * half).map(|d| values[(i + d).saturating_sub(half).min(n - 1)]),
            );
            let (_, median, _) = window.select_nth_unstable_by(half, f64::total_cmp);
            *median
        })
        .collect()
}

/// Peaks of the repetition curve over its moving median by
/// [`EDGE_OVER_MEDIAN`] on the windows an edge may sit on, merged at
/// [`MERGE_S`]: window indices, ascending.
fn repetition_edges(curve: &[f64], win_s: f64) -> Vec<usize> {
    let span = placeable(curve.len());
    if curve[span.clone()].iter().all(|&v| v <= 0.0) {
        return Vec::new();
    }
    let base = moving_median(curve, (MEDIAN_S / win_s).round() as usize);
    let found: Vec<usize> = crate::peaks::find_peaks(curve, 2, None, None)
        .into_iter()
        .filter(|&i| span.contains(&i) && curve[i] > base[i] + EDGE_OVER_MEDIAN)
        .collect();
    merge_close(&found, curve, (MERGE_S / win_s).round() as usize)
}

/// Keep the strongest of any peaks closer than `window`, strongest first:
/// a peak is dropped only when a stronger kept one lies within `window` of
/// it. Ties go to the earlier peak. `peaks` ascend; so does the result.
///
/// A left-to-right chain that compared each peak with the last kept one
/// let a middle peak knock out its left neighbour and then lose to its
/// right one, dropping a boundary a whole window from anything kept.
fn merge_close(peaks: &[usize], novelty: &[f64], window: usize) -> Vec<usize> {
    let mut by_strength = peaks.to_vec();
    // Stable: equal novelty keeps ascending order, so the earlier wins.
    by_strength.sort_by(|&a, &b| novelty[b].total_cmp(&novelty[a]));
    let mut kept: Vec<usize> = Vec::new();
    for i in by_strength {
        if kept.iter().all(|&k| k.abs_diff(i) >= window) {
            kept.push(i);
        }
    }
    kept.sort_unstable();
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sustained triad with a short attack, peak-normalised with the track.
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

    /// ABAB, 16 s phrases: quiet Am vs loud F major. Truth at 16/32/48.
    fn abab(sr: u32) -> (Vec<f32>, Vec<f64>) {
        let a = chord(sr, 220.0, false, 0.25, 16.0);
        let b = chord(sr, 174.61, true, 0.6, 16.0);
        (
            concat(&[a.clone(), b.clone(), a, b]),
            vec![16.0, 32.0, 48.0],
        )
    }

    /// Same C-major chord throughout, dynamics alternate every 12 s over
    /// 48 s. Harmony contributes nothing here — the energy term alone must
    /// segment it. Truth at 12/24/36.
    fn dynamics_only(sr: u32) -> (Vec<f32>, Vec<f64>) {
        let quiet = chord(sr, 261.63, true, 0.22, 12.0);
        let loud = chord(sr, 261.63, true, 0.6, 12.0);
        (
            concat(&[quiet.clone(), loud.clone(), quiet, loud]),
            vec![12.0, 24.0, 36.0],
        )
    }

    fn check_boundaries(found: &[f64], truth: &[f64]) {
        assert_eq!(
            found.len(),
            truth.len(),
            "expected {} boundaries, got {found:?}",
            truth.len()
        );
        for (f, t) in found.iter().zip(truth.iter()) {
            assert!(
                (f - t).abs() <= 1.5,
                "boundary {f:.2}s vs truth {t:.2}s in {found:?}"
            );
        }
    }

    #[test]
    fn abab_segments_by_harmony_and_dynamics() {
        let (y, truth) = abab(44_100);
        let structure = analyze(&y, 44_100);
        check_boundaries(&structure.boundaries, &truth);
    }

    #[test]
    fn dynamics_alone_still_segments() {
        let (y, truth) = dynamics_only(44_100);
        let structure = analyze(&y, 44_100);
        check_boundaries(&structure.boundaries, &truth);
    }

    #[test]
    fn energy_map_follows_loudness() {
        let (y, _) = abab(44_100);
        let structure = analyze(&y, 44_100);
        // Windows 4..28 sit inside the quiet A (16 s at 0.5 s hops, past the
        // attack); windows 36..60 inside the loud B.
        let quiet: f64 = structure.energy[8..32].iter().sum::<f64>() / 24.0;
        let loud: f64 = structure.energy[36..60].iter().sum::<f64>() / 24.0;
        assert!(loud > 2.0 * quiet, "loud {loud:.4} vs quiet {quiet:.4}");
    }

    #[test]
    fn a_late_chord_change_lands_on_its_own_window() {
        // Four minutes of Am, then F major at the same level: only harmony
        // moves. Grouping a fixed 172 STFT frames per window (0.49923 s)
        // let chroma run 0.37 s ahead of the 0.5 s windows by 240 s, and
        // the boundary came out a window late.
        let y = concat(&[
            chord(44_100, 220.0, false, 0.4, 240.0),
            chord(44_100, 174.61, true, 0.4, 10.0),
        ]);
        let structure = analyze(&y, 44_100);
        let late: Vec<f64> = structure
            .boundaries
            .iter()
            .copied()
            .filter(|&b| b > 200.0)
            .collect();
        assert_eq!(late.len(), 1, "{:?}", structure.boundaries);
        assert!(
            (late[0] - 240.0).abs() < 0.25,
            "boundary {} vs 240.0",
            late[0]
        );
    }

    #[test]
    fn merging_never_drops_a_peak_far_from_every_kept_one() {
        // Peaks 3 s apart, each stronger than the last: 10 and 22 are 6 s
        // apart, past MERGE_S, and both are boundaries. The chain let 16
        // knock out 10, then lost 16 to 22, and kept only 22.
        let mut novelty = vec![0.0; 40];
        novelty[10] = 0.5;
        novelty[16] = 0.7;
        novelty[22] = 1.0;
        let window = (MERGE_S / WIN_S).round() as usize;
        assert_eq!(merge_close(&[10, 16, 22], &novelty, window), vec![10, 22]);
        // Closer than the window, the stronger stays; at a tie the earlier.
        assert_eq!(merge_close(&[10, 16], &novelty, window), vec![16]);
        novelty[16] = 0.5;
        assert_eq!(merge_close(&[10, 16], &novelty, window), vec![10]);
    }

    #[test]
    fn no_boundary_lands_within_the_kernel_of_either_end() {
        // Chord changes 2 s from each end and one mid-track, 40 s in all.
        // The kernel reaches 4 s either side, so the edge changes cannot
        // be placed: the first is read on the span's edge, 2 s late, the
        // last is lost. Recorded as measured, not as right.
        let sr = 44_100;
        let y = concat(&[
            chord(sr, 220.0, false, 0.4, 2.0),
            chord(sr, 174.61, true, 0.4, 18.0),
            chord(sr, 261.63, true, 0.4, 18.0),
            chord(sr, 196.0, true, 0.4, 2.0),
        ]);
        let reach = KERNEL_HALF as f64 * WIN_S;
        let found = analyze(&y, sr).boundaries;
        for &b in &found {
            assert!(b >= reach && b <= 40.0 - reach, "{b} in {found:?}");
        }
        assert_eq!(found, vec![4.0, 20.0]);
    }

    #[test]
    fn silence_has_no_structure() {
        let structure = analyze(&vec![0.0f32; 44_100 * 10], 44_100);
        assert!(structure.boundaries.is_empty());
        assert!(phrases(&vec![0.0f32; 44_100 * 10], 44_100).boundaries.is_empty());
    }

    #[test]
    fn short_audio_bows_out_instead_of_panicking() {
        // Fewer windows than two kernel widths: the novelty loop would
        // index past the feature vector. Regression test from the audit.
        for seconds in [1, 3, 8] {
            let y = chord(44_100, 220.0, true, 0.4, seconds as f64);
            let structure = analyze(&y, 44_100);
            assert!(structure.boundaries.is_empty(), "{seconds}s");
            assert!(phrases(&y, 44_100).boundaries.is_empty(), "{seconds}s");
        }
    }

    /// A part of a song: one triad per feature window, root and quality
    /// drawn from `seed`, so a part played again is the same part.
    fn part(sr: u32, seed: u64, seconds: f64, amp: f64) -> Vec<f32> {
        let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
        let mut out = Vec::new();
        for _ in 0..(seconds / WIN_S).round() as usize {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let root = 110.0 * 2f64.powf((state % 24) as f64 / 12.0);
            out.extend(chord(sr, root, (state >> 8) & 1 == 0, amp, WIN_S));
        }
        out
    }

    /// An 8 s intro heard once, then A B C A C B: 12 s parts, each
    /// returning once at its own distance (36, 48 and 24 s), so every edge
    /// changes the lags at which the song repeats. `a_level` is the second
    /// A's. Truth at 8/20/32/44/56/68.
    fn song(sr: u32, a_level: f64) -> (Vec<f32>, Vec<f64>) {
        let (a, b, c) = (part(sr, 1, 12.0, 0.1), part(sr, 2, 12.0, 0.2), part(sr, 3, 12.0, 0.4));
        (
            concat(&[
                part(sr, 9, 8.0, 0.1),
                a,
                b.clone(),
                c.clone(),
                part(sr, 1, 12.0, a_level),
                c,
                b,
            ]),
            vec![8.0, 20.0, 32.0, 44.0, 56.0, 68.0],
        )
    }

    #[test]
    fn repetition_edges_read_the_checkerboard_abab_too() {
        let (y, truth) = abab(44_100);
        check_boundaries(&phrases(&y, 44_100).boundaries, &truth);
    }

    #[test]
    fn a_change_of_level_alone_is_not_a_repetition_edge() {
        // One held chord, quiet and loud by turns: every window recurs with
        // the whole song, loud or quiet, so the lags change only between
        // the halves. Recorded as measured, not as right: the checkerboard
        // reads this (dynamics_alone_still_segments).
        let (y, _truth) = dynamics_only(44_100);
        let found = phrases(&y, 44_100).boundaries;
        assert_eq!(found.len(), 1, "{found:?}");
        assert!((found[0] - 24.0).abs() <= 1.5, "{found:?}");
    }

    #[test]
    fn repetition_edges_find_where_each_part_returns() {
        let (y, truth) = song(44_100, 0.1);
        let found = phrases(&y, 44_100);
        check_boundaries(&found.boundaries, &truth);
        // The same energy lane as the checkerboard's.
        assert_eq!(found.energy, analyze(&y, 44_100).energy);
    }

    #[test]
    fn a_part_that_returns_louder_is_still_the_same_part() {
        // The second A at three times the level: its windows still find the
        // first A's, so the edges stay where the parts change.
        let (y, truth) = song(44_100, 0.3);
        check_boundaries(&phrases(&y, 44_100).boundaries, &truth);
    }

    #[test]
    fn repetition_edges_stay_out_of_the_kernel_spans_at_either_end() {
        // Parts that change 2 s from either end, and returning parts
        // between them so that repetition has something to read.
        let sr = 44_100;
        let y = concat(&[
            part(sr, 3, 2.0, 0.4),
            part(sr, 1, 14.0, 0.4),
            part(sr, 2, 14.0, 0.4),
            part(sr, 1, 14.0, 0.4),
            part(sr, 4, 2.0, 0.4),
        ]);
        let reach = KERNEL_HALF as f64 * WIN_S;
        let found = phrases(&y, sr).boundaries;
        assert!(!found.is_empty());
        for &b in &found {
            assert!(b >= reach && b <= 46.0 - reach, "{b} in {found:?}");
        }
    }

    /// The time-lag matrix whole, for the blocked build to be checked
    /// against.
    fn dense_curve(features: &[Vec<f64>], win_s: f64) -> Vec<f64> {
        let n = features.len();
        let rows = recurrences(features, win_s);
        let lag: Vec<Vec<f64>> = (0..n)
            .map(|i| {
                (0..n)
                    .map(|l| {
                        let j = (i + l) % n;
                        f64::from((rows[i][j / 64] >> (j % 64) & 1) as u8)
                    })
                    .collect()
            })
            .collect();
        let g = gaussian(SMOOTH_TIME_S / win_s);
        let r = g.len() / 2;
        let smooth: Vec<Vec<f64>> = (0..n)
            .map(|i| {
                (0..n)
                    .map(|l| {
                        g.iter()
                            .enumerate()
                            .map(|(e, w)| w * lag[(i + e).saturating_sub(r).min(n - 1)][l])
                            .sum()
                    })
                    .collect()
            })
            .collect();
        let mut curve: Vec<f64> = (0..n)
            .map(|i| {
                if i == 0 {
                    return 0.0;
                }
                (0..n)
                    .map(|l| (smooth[i][l] - smooth[i - 1][l]).powi(2))
                    .sum::<f64>()
                    .sqrt()
            })
            .collect();
        let peak = curve[KERNEL_HALF..n - KERNEL_HALF]
            .iter()
            .copied()
            .fold(0.0f64, f64::max);
        for v in curve.iter_mut() {
            *v /= peak;
        }
        curve
    }

    #[test]
    fn the_blocked_lag_matrix_reads_as_the_whole_one() {
        // 150 windows cross two block edges and wrap around the song; a
        // part at 20..50 returns at 90..120, the rest is noise.
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut noise = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut features: Vec<Vec<f64>> =
            (0..150).map(|_| (0..13).map(|_| noise()).collect()).collect();
        for i in 20..50 {
            features[i + 70] = features[i].iter().map(|v| v * 1.01).collect();
        }
        let blocked = repetition_curve(&features, WIN_S);
        let whole = dense_curve(&features, WIN_S);
        for (i, (a, b)) in blocked.iter().zip(&whole).enumerate() {
            assert!((a - b).abs() < 1e-9, "window {i}: {a} against {b}");
        }
        assert!(blocked.iter().any(|&v| v > 0.0));
    }

    #[test]
    fn the_moving_median_holds_the_ends() {
        let values = [5.0, 1.0, 4.0, 2.0, 3.0];
        // Windows of three: [5 5 1] [5 1 4] [1 4 2] [4 2 3] [2 3 3].
        assert_eq!(moving_median(&values, 1), vec![5.0, 4.0, 2.0, 3.0, 3.0]);
    }
}
