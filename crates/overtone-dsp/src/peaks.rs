//! Peak picking with `scipy.signal.find_peaks` semantics.
//!
//! v3 calls `find_peaks(env, distance=d, prominence=0.05, height=floor)`, and
//! each of those three is a specific algorithm rather than a threshold:
//!
//! * a peak on a **plateau** of equal values is the plateau's midpoint, not
//!   its first sample;
//! * `distance` keeps the tallest peak first and evicts its neighbours, so it
//!   is not a simple left-to-right sweep;
//! * `prominence` is the drop to the lowest contour line — walk outward until
//!   a sample higher than the peak, take the minimum on the way, and use the
//!   *higher* of the two sides.
//!
//! Filters apply in scipy's order: maxima, height, distance, prominence.
//! Prominence is computed against the whole signal, so it does not depend on
//! which peaks survived the earlier filters.

/// Float kinds this module accepts. The onset envelope is `f32` (numpy's
/// `float32`, and the exact type matters for ties in peak picking); the
/// coherence curve is `f64`. Generalising here rather than duplicating the
/// algorithm keeps the two from drifting apart.
pub trait Sample: Copy + PartialOrd {
    fn as_f64(self) -> f64;
}

impl Sample for f32 {
    #[inline]
    fn as_f64(self) -> f64 {
        self as f64
    }
}

impl Sample for f64 {
    #[inline]
    fn as_f64(self) -> f64 {
        self
    }
}

#[inline]
fn cmp<T: Sample>(a: &T, b: &T) -> std::cmp::Ordering {
    a.as_f64().total_cmp(&b.as_f64())
}

/// Local maxima, with a plateau reported at its midpoint.
fn local_maxima<T: Sample>(x: &[T]) -> Vec<usize> {
    let mut peaks = Vec::new();
    if x.len() < 3 {
        return peaks;
    }
    let i_max = x.len() - 1;
    let mut i = 1;
    while i < i_max {
        if x[i - 1] < x[i] {
            let mut ahead = i + 1;
            while ahead < i_max && x[ahead] == x[i] {
                ahead += 1;
            }
            if x[ahead] < x[i] {
                peaks.push((i + ahead - 1) / 2);
                i = ahead;
            }
        }
        i += 1;
    }
    peaks
}

/// scipy's `_select_by_peak_distance`: tallest peak wins and suppresses every
/// neighbour closer than `distance`, then the next tallest among survivors.
fn select_by_distance<T: Sample>(peaks: &[usize], heights: &[T], distance: usize) -> Vec<bool> {
    let mut keep = vec![true; peaks.len()];
    if distance <= 1 {
        return keep;
    }
    let mut order: Vec<usize> = (0..peaks.len()).collect();
    // Ascending by height, then walked in reverse: the same traversal scipy
    // does, and it matters for ties.
    order.sort_by(|&a, &b| cmp(&heights[a], &heights[b]));
    for &j in order.iter().rev() {
        if !keep[j] {
            continue;
        }
        let mut k = j;
        while k > 0 {
            k -= 1;
            if peaks[j] - peaks[k] < distance {
                keep[k] = false;
            } else {
                break;
            }
        }
        let mut k = j + 1;
        while k < peaks.len() && peaks[k] - peaks[j] < distance {
            keep[k] = false;
            k += 1;
        }
    }
    keep
}

/// scipy's `peak_prominences` with the default unbounded window.
fn prominences<T: Sample>(x: &[T], peaks: &[usize]) -> Vec<f64> {
    peaks
        .iter()
        .map(|&peak| {
            let height = x[peak];
            let mut left_min = height.as_f64();
            let mut i = peak as isize;
            while i >= 0 && x[i as usize] <= height {
                left_min = left_min.min(x[i as usize].as_f64());
                i -= 1;
            }
            let mut right_min = height.as_f64();
            let mut i = peak;
            while i < x.len() && x[i] <= height {
                right_min = right_min.min(x[i].as_f64());
                i += 1;
            }
            height.as_f64() - left_min.max(right_min)
        })
        .collect()
}

/// `find_peaks` with the subset of filters v3 uses. `height` and `prominence`
/// are optional so the caller can reproduce v3's bare-`distance` retry.
pub fn find_peaks<T: Sample>(
    x: &[T],
    distance: usize,
    prominence: Option<f64>,
    height: Option<f64>,
) -> Vec<usize> {
    let mut peaks = local_maxima(x);
    if let Some(floor) = height {
        peaks.retain(|&p| x[p].as_f64() >= floor);
    }
    if !peaks.is_empty() && distance > 1 {
        let heights: Vec<T> = peaks.iter().map(|&p| x[p]).collect();
        let keep = select_by_distance(&peaks, &heights, distance);
        peaks = peaks
            .into_iter()
            .zip(keep)
            .filter_map(|(p, k)| k.then_some(p))
            .collect();
    }
    if let Some(min_prominence) = prominence {
        let values = prominences(x, &peaks);
        peaks = peaks
            .into_iter()
            .zip(values)
            .filter_map(|(p, value)| (value >= min_prominence).then_some(p))
            .collect();
    }
    peaks
}

/// Sub-frame peak positions by parabolic interpolation, plus the raw envelope
/// height at each peak (v3 uses the un-interpolated height as the weight).
///
/// The shift is clamped to half a frame: a parabola through three samples of a
/// noisy envelope can otherwise place the vertex outside the bracket entirely.
pub fn refine_parabolic<T: Sample>(x: &[T], peaks: &[usize]) -> (Vec<f64>, Vec<T>) {
    let mut frames = Vec::with_capacity(peaks.len());
    let mut weights = Vec::with_capacity(peaks.len());
    for &p in peaks {
        let mut frame = p as f64;
        if p > 0 && p + 1 < x.len() {
            let (a, b, c) = (x[p - 1].as_f64(), x[p].as_f64(), x[p + 1].as_f64());
            let denom = a - 2.0 * b + c;
            if denom.abs() > 1e-9 {
                frame += (0.5 * (a - c) / denom).clamp(-0.5, 0.5);
            }
        }
        frames.push(frame);
        weights.push(x[p]);
    }
    (frames, weights)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plateau_peak_is_reported_at_its_midpoint() {
        // scipy puts the peak of a flat top at (left + right) / 2, floored.
        let x = [0.0, 1.0, 1.0, 1.0, 0.0];
        assert_eq!(local_maxima(&x), vec![2]);
        let x = [0.0, 1.0, 1.0, 0.0];
        assert_eq!(local_maxima(&x), vec![1]);
    }

    #[test]
    fn edges_are_never_peaks() {
        assert!(local_maxima(&[5.0, 1.0, 1.0]).is_empty());
        assert!(local_maxima(&[1.0, 1.0, 5.0]).is_empty());
    }

    #[test]
    fn distance_keeps_the_tallest_not_the_first() {
        // Two peaks 2 apart with distance 5: the taller one must survive, and
        // a naive left-to-right sweep would keep the first instead.
        let x = [0.0, 1.0, 0.0, 9.0, 0.0];
        let peaks = find_peaks(&x, 5, None, None);
        assert_eq!(peaks, vec![3]);
    }

    #[test]
    fn prominence_uses_the_higher_saddle() {
        // Peak at 2 (value 5). Left side drops to 0; right side only drops to
        // 4 before rising to 6. Prominence is 5 - max(0, 4) = 1.
        let x = [0.0, 1.0, 5.0, 4.0, 6.0, 0.0];
        let values = prominences(&x, &[2]);
        assert!((values[0] - 1.0).abs() < 1e-6, "got {}", values[0]);
    }

    #[test]
    fn prominence_filter_drops_a_shoulder() {
        let x = [0.0, 1.0, 5.0, 4.0, 6.0, 0.0];
        // Two maxima: the shoulder at 2 (prominence 1, since the dip to its
        // right only reaches 4 before rising past it) and the true peak at 4
        // (prominence 6, clear to the floor on both sides).
        assert_eq!(find_peaks(&x, 1, Some(0.5), None), vec![2, 4]);
        assert_eq!(find_peaks(&x, 1, Some(2.0), None), vec![4]);
        assert!(find_peaks(&x, 1, Some(7.0), None).is_empty());
    }

    #[test]
    fn height_filter_runs_before_distance() {
        // If height ran after distance, the tall-but-suppressed peak would
        // have already evicted its neighbour and we would get nothing.
        let x = [0.0, 3.0, 0.0, 9.0, 0.0];
        assert_eq!(find_peaks(&x, 5, None, Some(5.0)), vec![3]);
        assert_eq!(find_peaks(&x, 5, None, Some(1.0)), vec![3]);
    }

    #[test]
    fn parabolic_shift_finds_an_offset_vertex() {
        // Samples from a parabola whose vertex sits a quarter frame right of
        // the middle sample.
        let f = |t: f64| -(t - 0.25) * (t - 0.25);
        let x: Vec<f32> = [-1.0, 0.0, 1.0]
            .iter()
            .map(|&t| f(t) as f32 + 2.0)
            .collect();
        let (frames, _) = refine_parabolic(&x, &[1]);
        assert!((frames[0] - 1.25).abs() < 1e-3, "got {}", frames[0]);
    }

    #[test]
    fn parabolic_shift_is_clamped() {
        // A near-flat denominator must not fling the vertex across the signal.
        let x = [1.0f32, 1.000_001, 0.999_999];
        let (frames, _) = refine_parabolic(&x, &[1]);
        assert!((frames[0] - 1.0).abs() <= 0.5);
    }
}
