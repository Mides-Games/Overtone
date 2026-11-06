use overtone_core::{Diagnostic, GridSection, TimingPoint};

use super::*;
use overtone_core::Seconds;

fn drum(atom: f64, phase: f64, from: f64, to: f64) -> (Vec<f64>, Vec<f32>) {
    let mut times = Vec::new();
    let mut weights = Vec::new();
    let mut k = ((from - phase) / atom).ceil() as i64;
    loop {
        let t = phase + k as f64 * atom;
        if t > to {
            break;
        }
        times.push(t);
        weights.push(if k.rem_euclid(4) == 0 { 1.0 } else { 0.5 });
        k += 1;
    }
    (times, weights)
}

fn beat_track(period: f64, phase: f64, beats: usize, downbeat_weight: f32) -> (Vec<f64>, Vec<f32>) {
    let times: Vec<f64> = (0..beats).map(|k| phase + k as f64 * period).collect();
    let weights: Vec<f32> = (0..beats)
        .map(|k| if k % 4 == 0 { downbeat_weight } else { 0.6 })
        .collect();
    (times, weights)
}

fn section_of(start: f64, end: f64, period: f64, phase: f64) -> GridSection {
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

/// Eighth-note attacks with accented beats, first beat at `start`.
fn eighths(bpm: f64, start: f64, to: f64) -> (Vec<f64>, Vec<f32>) {
    let atom = 30.0 / bpm;
    let mut times = Vec::new();
    let mut weights = Vec::new();
    let mut k = 0i64;
    loop {
        let t = start + k as f64 * atom;
        if t > to {
            break;
        }
        times.push(t);
        weights.push(if k % 2 == 0 { 1.0 } else { 0.45 });
        k += 1;
    }
    (times, weights)
}

#[test]
fn first_red_line_lands_on_the_beat_when_the_song_starts_on_the_atom_grid() {
    // Section 0 used to apply a beat class counted from the anchor seed's
    // phase, while its own phase came from a second seed that can sit a
    // whole atom away: the only red line landed on the off-beat, 250 ms
    // late at 120 BPM, on tracks that start on the eighth-note grid.
    for &(bpm, start) in &[
        (120.0, 0.5),
        (120.0, 1.0),
        (120.0, 0.25),
        (150.0, 0.6),
        (150.0, 0.4),
    ] {
        let (times, weights) = eighths(bpm, start, 40.0);
        let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
        let first = out.points.first().expect("a red line");
        let beat_ms = 60_000.0 / bpm;
        let k = (first.offset.get() - start * 1000.0) / beat_ms;
        let off = (k - k.round()).abs() * beat_ms;
        assert!(
            off < 5.0,
            "{bpm} BPM from {start} s: red line at {:.1} ms is {off:.1} ms off the beat",
            first.offset.get()
        );
    }
}

/// A heavy downbeat and light beats. `segments` = [(bpm, bars, beats)].
fn accented(segments: &[(f64, usize, usize)]) -> (Vec<f64>, Vec<f32>) {
    let (mut times, mut weights, mut t) = (Vec::new(), Vec::new(), 0.5);
    for &(bpm, bars, beats) in segments {
        for _ in 0..bars {
            for b in 0..beats {
                times.push(t);
                weights.push(if b == 0 { 1.0 } else { 0.25 });
                t += 60.0 / bpm;
            }
        }
    }
    (times, weights)
}

#[test]
fn a_real_tempo_change_leaves_the_meter_path() {
    // The bar was measured on one section and applied to the whole track:
    // 128 -> 150 BPM with an audible downbeat came out as one 128 BPM line.
    let (times, weights) = accented(&[(128.0, 24, 4), (150.0, 24, 4)]);
    let change = 0.5 + 24.0 * 4.0 * 60.0 / 128.0;
    let sections = [
        section_of(0.5, change, 60.0 / 128.0, 0.5),
        section_of(change, *times.last().unwrap(), 60.0 / 150.0, change),
    ];
    assert!(points_from_meter(&sections, &times, &weights, 1.0).is_none());
}

#[test]
fn a_signature_change_over_one_bar_still_uses_the_meter_path() {
    // 6/4 at 300 then 3/4 at 150 then 6/4: one 1.2 s bar, two notations.
    let (times, weights) = accented(&[(300.0, 12, 6), (150.0, 12, 3), (300.0, 12, 6)]);
    let first_end = 0.5 + 12.0 * 1.2;
    let sections = [
        section_of(0.5, first_end, 0.2, 0.5),
        section_of(first_end, *times.last().unwrap(), 0.4, first_end),
    ];
    let points = points_from_meter(&sections, &times, &weights, 1.0).expect("meter path");
    let meters: Vec<u32> = points.iter().map(|p| p.meter).collect();
    assert_eq!(meters, vec![6, 3, 6]);
}

#[test]
fn a_pulse_factor_does_not_drop_a_plausible_section() {
    // 60 BPM read at a quarter pulse is 15 BPM: outside 20..900, but the
    // music is not, so the red line must still be written.
    let sections = [section_of(0.5, 60.0, 1.0, 0.5)];
    let points = points_from_sections(&sections, 0.5, 12, 0, 1, 0.25, None);
    assert_eq!(points.len(), 1);
    assert!((points[0].bpm.get() - 15.0).abs() < 1e-9);
}

#[test]
fn a_change_red_line_takes_the_beat_just_before_the_start() {
    // The refit can leave the new grid's boundary beat microseconds before
    // the settled start; a bare ceil took the next beat, a whole beat late.
    let (p1, p2) = (60.0 / 132.0, 60.0 / 138.0);
    let change = 0.5 + 70.0 * p1;
    let sections = [
        section_of(0.5, change, p1, 0.5),
        section_of(change, change + 30.0, p2, change - 3e-5),
    ];
    let beat = points_from_sections(&sections, 0.5, 12, 0, 1, 1.0, None);
    assert!((beat[1].offset.get() - (change * 1000.0 - 0.03)).abs() < 1e-6);
    let bars = vec![("4/4".to_string(), 0usize, 4usize); 2];
    let bar = points_from_sections(&sections, 0.5, 12, 0, 4, 1.0, Some(&bars));
    assert!((bar[1].offset.get() - (change * 1000.0 - 0.03)).abs() < 1e-6);
}

#[test]
fn a_lone_click_before_the_music_keeps_the_grid() {
    // One attack at 0.3 s, then 150 BPM eighths from 8 s: growth used to
    // give up on its first seed window and report StageFailed ("a bug").
    let (mut times, mut weights) = eighths(150.0, 8.0, 70.0);
    times.insert(0, 0.3);
    weights.insert(0, 0.8);
    let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
    assert!(
        !out.diagnostics
            .iter()
            .any(|d| matches!(d, Diagnostic::StageFailed { .. })),
        "{:?}",
        out.diagnostics
    );
    let first = out.points.first().expect("a red line");
    assert!(
        (first.bpm.get() - 150.0).abs() < 0.01,
        "bpm {}",
        first.bpm.get()
    );
    let beat_ms = 400.0;
    let k = (first.offset.get() - 8000.0) / beat_ms;
    assert!(
        (k - k.round()).abs() * beat_ms < 2.0,
        "offset {}",
        first.offset.get()
    );
}

#[test]
fn confidence_is_one_on_a_tight_long_section() {
    let atom = 60.0 / 174.0 / 2.0;
    let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
    let grown = crate::sections::grow_sections(&times, &weights, atom, 0.4, 1.5, 12);
    assert_eq!(grown.len(), 1);
    assert!((section_confidence(&grown[0], 12) - 1.0).abs() < 1e-9);
}

#[test]
fn confidence_penalises_a_short_section() {
    let section = section_of(0.4, 1.1, 0.35, 0.4);
    let full = section_confidence(&section_of(0.4, 60.0, 0.35, 0.4), 12);
    assert!(section_confidence(&section, 12) < full);
}

#[test]
fn a_single_exact_section_gives_one_downbeat_point() {
    let atom = 60.0 / 174.0 / 2.0;
    let beat = atom * 2.0;
    let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
    let grown = crate::sections::grow_sections(&times, &weights, atom, 0.4, 3.0, 24);
    let beats = crate::sections::beat_sections(&grown, &times, &weights, 2, 0);
    let points = points_from_sections(&beats, times[0], 12, 0, 1, 1.0, None);
    assert_eq!(points.len(), 1, "got {points:?}");
    assert!((points[0].bpm.get() - 60.0 / beat).abs() < 1e-6);
    // No accent evidence: anchored to the beat through the first sound.
    assert!((points[0].offset.get() / 1000.0 - 0.4).abs() < 1e-9);
    assert!(!points[0].meter_known);
}

#[test]
fn subdivision_doubling_is_exact_and_keeps_the_offset() {
    // Property: reading the same grids at x2 doubles every BPM and moves
    // no offset. This is the x2/div2 identity the UI relies on.
    let atom = 60.0 / 174.0 / 2.0;
    let (times, weights) = drum(atom, 0.4, 0.4, 60.0);
    let grown = crate::sections::grow_sections(&times, &weights, atom, 0.4, 3.0, 24);
    let beats = crate::sections::beat_sections(&grown, &times, &weights, 2, 0);
    let once = points_from_sections(&beats, times[0], 12, 0, 1, 1.0, None);
    let twice = points_from_sections(&beats, times[0], 12, 0, 1, 2.0, None);
    assert_eq!(once.len(), twice.len());
    for (a, b) in once.iter().zip(twice.iter()) {
        assert!((b.bpm.get() - 2.0 * a.bpm.get()).abs() < 1e-9);
        assert!((b.offset.get() - a.offset.get()).abs() < 1e-9);
    }
}

#[test]
fn settled_boundaries_are_contiguous_and_monotone() {
    // Property: whatever growth found, settling leaves a partition —
    // no gaps, no overlaps, non-decreasing.
    let a1 = 60.0 / 128.0 / 2.0;
    let change = 0.4 + 128.0 * a1;
    let (mut times, mut weights) = drum(a1, 0.4, 0.4, change);
    let a2 = 60.0 / 142.0 / 2.0;
    let (t2, w2) = drum(a2, change, change, 60.0);
    times.extend(t2.iter().skip(1));
    weights.extend(w2.iter().skip(1));
    let grown = crate::sections::grow_sections(&times, &weights, a1, 0.4, 1.5, 12);
    let settled = crate::sections::settle_boundaries(&times, &weights, grown, SETTLE_ROUNDS);
    assert!(settled.len() >= 2);
    for pair in settled.windows(2) {
        assert!((pair[1].start.get() - pair[0].end.get()).abs() < 1e-9);
        assert!(pair[1].start.get() >= pair[0].start.get());
    }
    assert!((settled[0].start.get() - times[0]).abs() < 1e-9);
    assert!((settled.last().unwrap().end.get() - times[times.len() - 1]).abs() < 1e-9);
}

#[test]
fn a_one_window_signature_region_is_kept_wherever_the_song_starts() {
    // 32 bars of 4, 4 bars of 3 (exactly one window), 32 bars of 4. v3
    // kept that region by float rounding: never at a 1.2 s or 1.6 s bar
    // in 37 start offsets, 32 times in 37 at 1.875 s.
    for bar in [1.2, 1.6, 1.875] {
        for step in 0..37 {
            let phase = 0.25 + step as f64 * 0.0271;
            let (mut times, mut weights) = (Vec::new(), Vec::new());
            for n in 0..68 {
                let beats = if (32..36).contains(&n) { 3 } else { 4 };
                for k in 0..beats {
                    times.push(phase + n as f64 * bar + k as f64 * bar / beats as f64);
                    weights.push(if k == 0 { 1.0f32 } else { 0.6 });
                }
            }
            let found: Vec<usize> = meter_segments(&times, &weights, bar, phase)
                .iter()
                .map(|s| s.beats)
                .collect();
            assert_eq!(found, vec![4, 3, 4], "bar {bar}, start {phase}");
        }
    }
}

#[test]
fn a_proven_bar_anchors_the_red_line_to_a_downbeat() {
    // v3's test of the same name. The second section's downbeat sits two
    // beats after its start, so a beat-anchored line would land on the
    // wrong beat of the bar: downbeats at 9.5, 11.5, 13.5 ... -> 11.5.
    let sections = vec![
        section_of(0.0, 10.0, 0.5, 0.0),
        section_of(10.0, 20.0, 0.5, 9.0),
    ];
    let measures = vec![("4/4".to_string(), 0, 4), ("4/4".to_string(), 1, 4)];
    let points = points_from_sections(&sections, 0.0, 4, 0, 4, 1.0, Some(&measures));
    assert_eq!(points.len(), 2);
    assert!((points[1].offset.get() - 11_500.0).abs() < 1e-6);
    assert!(points[1].meter_known);
    assert_eq!(points[1].meter, 4);
}

#[test]
fn no_evidence_keeps_the_old_beat_anchoring() {
    // v3's test of the same name: with no proven bar the line goes to the
    // first beat at or after the start (beats 9.0, 9.5, 10.0 -> 10.0).
    let sections = vec![
        section_of(0.0, 10.0, 0.5, 0.0),
        section_of(10.0, 20.0, 0.5, 9.0),
    ];
    let measures = vec![("4/4".to_string(), 0, 1), ("4/4".to_string(), 0, 1)];
    let points = points_from_sections(&sections, 0.0, 4, 0, 1, 1.0, Some(&measures));
    assert!((points[1].offset.get() - 10_000.0).abs() < 1e-6);
    assert!(!points[1].meter_known);
}

#[test]
fn noise_before_the_music_does_not_start_the_grid() {
    // A beat grid from 0.42 s at 132 BPM, and one attack at 27 ms that is
    // 0.136 of a beat off it -- noise at the start of the file. It was the
    // "first sound", and the first red line landed on the grid beat before
    // the music (-34.65 ms on very-noisy-132).
    let period = 60.0 / 132.0;
    let section = GridSection {
        start: overtone_core::Seconds(0.027),
        end: overtone_core::Seconds(30.0),
        period,
        phase: 0.42,
        inliers: 60,
        residual_ms: 0.2,
        coverage: 1.0,
    };
    let mut times = vec![0.027];
    times.extend((0..60).map(|k| 0.42 + k as f64 * period));
    assert!((first_on_grid(&times, &section) - 0.42).abs() < 1e-12);
    // With nothing on the grid, the first attack is all there is.
    assert_eq!(first_on_grid(&[0.027], &section), 0.027);
}

#[test]
fn sparse_random_attacks_get_no_grid() {
    // About one attack a second for 30 s, at random: speech, ambient, an
    // FX clip. The best seed grid cleared the 0.40 share gate for about
    // half of these; its inliers are what chance gives, and the envelope
    // (a spike per attack) has no beat to vouch for it.
    let sr = 44_100;
    let hop = overtone_core::FIT_HOP;
    let mut given = Vec::new();
    for trial in 0..40u64 {
        let mut seed = trial * 7 + 1;
        let mut times: Vec<f64> = (0..30)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as f64 / (1u64 << 31) as f64 * 30.0
            })
            .collect();
        times.sort_by(f64::total_cmp);
        let weights = vec![0.8f32; times.len()];
        let mut env = vec![0.0f32; 32 * sr as usize / hop];
        for &t in &times {
            env[(t * sr as f64 / hop as f64) as usize] = 0.8;
        }
        let out = analyze_attacks(&times, &weights, &env, sr, 1.5, 12, true, 0.75);
        if !out.points.is_empty() || !out.settled_sections.is_empty() {
            given.push(trial);
        }
    }
    assert!(given.is_empty(), "grids given to random attacks: {given:?}");
}

#[test]
fn a_sparse_pulse_keeps_its_grid() {
    // One attack a second, with a third as many again off the grid: the
    // inliers are far beyond chance, so the envelope is never consulted.
    // (The off-grid attacks near a beat pull the fit by ~0.01 BPM.)
    let mut times: Vec<f64> = (0..30).map(|k| 0.25 + k as f64).collect();
    let mut seed = 3u64;
    for _ in 0..10 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        times.push(0.6 + (seed >> 33) as f64 / (1u64 << 31) as f64 * 28.0);
    }
    times.sort_by(f64::total_cmp);
    let weights = vec![0.8f32; times.len()];
    let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
    assert!(!out.points.is_empty(), "got {:?}", out.diagnostics);
    let bpm = out.points[0].bpm.get();
    assert!(
        [60.0, 120.0].iter().any(|b| (bpm - b).abs() < 0.05),
        "got {bpm}"
    );
}

#[test]
fn white_noise_gets_no_grid_and_says_so() {
    // Uniform random attacks: no pulse explains more than chance, so the
    // share gate (0.40) refuses long before any grid is fitted. This pins
    // audit F-08's honest half: the legacy tracker answered 127.68 BPM
    // here, and nothing in Rust may ever invent that answer again.
    let mut seed = 7u64;
    let mut times: Vec<f64> = (0..600)
        .map(|_| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 33) as f64 / (1u64 << 31) as f64 * 60.0
        })
        .collect();
    times.sort_by(f64::total_cmp);
    let weights = vec![0.8f32; times.len()];
    let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
    assert!(out.points.is_empty());
    assert!(out.settled_sections.is_empty());
    assert!(
        matches!(
            out.diagnostics.as_slice(),
            [Diagnostic::NoCoherentPulse { .. }]
        ),
        "got {:?}",
        out.diagnostics
    );
}

#[test]
fn sparse_pads_get_no_grid_and_say_so() {
    // Seventeen scattered attacks: not enough evidence to fit anything.
    let times: Vec<f64> = (0..17).map(|k| k as f64 * 2.63 + 0.4).collect();
    let weights = vec![0.3f32; times.len()];
    let out = analyze_attacks(&times, &weights, &[], 44_100, 1.5, 12, true, 0.75);
    assert!(out.points.is_empty());
    assert!(
        matches!(
            out.diagnostics.as_slice(),
            [Diagnostic::TooFewAttacks {
                found: 17,
                needed: 24
            }]
        ),
        "got {:?}",
        out.diagnostics
    );
}

#[test]
fn silence_gets_no_grid_and_says_so() {
    let out = analyze_attacks(&[], &[], &[], 44_100, 1.5, 12, true, 0.75);
    assert!(out.points.is_empty());
    assert!(
        matches!(
            out.diagnostics.as_slice(),
            [Diagnostic::TooFewAttacks {
                found: 0,
                needed: 24
            }]
        ),
        "got {:?}",
        out.diagnostics
    );
}

#[test]
fn snapping_only_nudges_onto_the_previous_grid() {
    let a = TimingPoint::new(1000.0, 120.0, 0.9, 0);
    // 500 ms later is exactly one beat at 120 BPM: snaps exactly.
    let b = TimingPoint::new(1500.2, 140.0, 0.9, 1);
    let snapped = snap_timing_points(&[a, b]);
    assert!((snapped[1].offset.get() - 1500.0).abs() < 1e-9);
    // Far off the grid (200 ms > a quarter beat of 125 ms): left alone.
    let c = TimingPoint::new(1700.0, 140.0, 0.9, 1);
    let snapped = snap_timing_points(&[a, c]);
    assert!((snapped[1].offset.get() - 1700.0).abs() < 1e-9);
}

#[test]
fn osu_text_rounds_and_falls_back_as_v3_does() {
    // Python's round() takes half to even: 1000.5 -> 1000, 5251.5 ->
    // 5252. The two points sit far enough apart that snapping leaves
    // both alone.
    let a = TimingPoint::new(1000.5, 120.0, 1.0, 0);
    let b = TimingPoint::new(5251.5, 140.0, 1.0, 1);
    let text = osu_timing_text(&[a, b], "4/4", 0);
    let rows: Vec<&str> = text.lines().collect();
    assert!(rows[1].starts_with("1000,"), "{}", rows[1]);
    assert!(rows[2].starts_with("5252,"), "{}", rows[2]);
    // A proved bar of 0 is no bar: v3 writes the analysis meter
    // (`int(meter or fallback)`), not 1.
    let mut c = TimingPoint::new(400.0, 174.0, 1.0, 0);
    c.meter = 0;
    c.meter_known = true;
    let text = osu_timing_text(&[c], "3/4", 0);
    assert!(
        text.lines().nth(1).unwrap().contains(",3,1,0,100,1,0"),
        "{text}"
    );
}

#[test]
fn osu_text_writes_whole_ms_and_the_proved_meter() {
    let mut a = TimingPoint::new(400.4, 174.0, 1.0, 0);
    a.meter = 3;
    a.meter_known = true;
    let b = TimingPoint::new(900.6, 174.0, 1.0, 0);
    let text = osu_timing_text(&[a, b], "4/4", 0);
    let rows: Vec<&str> = text.lines().collect();
    assert_eq!(rows.len(), 3);
    assert!(rows[1].starts_with("400,"));
    assert!(rows[1].contains(",3,1,0,100,1,0"));
    // Unknown bar falls back to the analysis meter, never a hard-coded 4.
    assert!(rows[2].starts_with("901,"));
    assert!(rows[2].contains(",4,1,0,100,1,0"));
    let lazer = osu_timing_text(&[a], "3/4", 3);
    assert!(lazer.lines().nth(1).unwrap().starts_with("400.400,"));
}

#[test]
fn detect_bar_finds_four_and_refuses_uniform() {
    let (times, weights) = beat_track(0.5, 1.0, 40, 1.0);
    let found = detect_bar(&times, &weights, 0.5, 1.0).expect("a bar is provable");
    assert_eq!(found.2, 4);
    assert!((found.0 - 2.0).abs() < 1e-9);
    let (flat_times, _) = beat_track(0.5, 1.0, 40, 0.6);
    let flat_weights = vec![0.5f32; 40];
    assert!(detect_bar(&flat_times, &flat_weights, 0.5, 1.0).is_none());
}

#[test]
fn meter_regions_split_a_constant_bar_with_two_signatures() {
    // The v3.3 reference shape: the bar never changes length (1.2 s) but
    // the subdivision moves 6/4 -> 4/4. Tempo growth sees one section;
    // the measure grid must still place two red lines.
    let mut times = Vec::new();
    let mut weights = Vec::new();
    for b in 0..10 {
        for j in 0..6 {
            times.push(b as f64 * 1.2 + j as f64 * 0.2);
            weights.push(if j == 0 { 1.2 } else { 0.6 });
        }
    }
    for b in 0..10 {
        for j in 0..4 {
            times.push(12.0 + b as f64 * 1.2 + j as f64 * 0.3);
            weights.push(if j == 0 { 1.2 } else { 0.6 });
        }
    }
    let sections = vec![section_of(times[0], times[times.len() - 1], 0.1, 0.0)];
    let points =
        points_from_meter(&sections, &times, &weights, 1.0).expect("two signatures over one bar");
    assert_eq!(points.len(), 2, "got {points:?}");
    assert!((points[0].bpm.get() - 300.0).abs() < 1e-6);
    assert!((points[1].bpm.get() - 200.0).abs() < 1e-6);
    assert!((points[0].offset.get() / 1000.0 - 0.0).abs() < 1e-6);
    assert!((points[1].offset.get() / 1000.0 - 12.0).abs() < 1e-6);
    assert!(points.iter().all(|p| p.meter_known));
}

#[test]
fn per_section_meter_comes_from_each_section() {
    let (t1, w1) = beat_track(0.5, 1.0, 40, 1.0);
    let sections = vec![
        section_of(t1[0], t1[t1.len() - 1], 0.5, 1.0),
        section_of(t1[t1.len() - 1], t1[t1.len() - 1] + 2.0, 0.5, 1.0),
    ];
    let mut times = t1.clone();
    let mut weights = w1.clone();
    times.extend([21.5, 22.0]);
    weights.extend([0.5, 0.5]);
    let measures = section_measures(&sections, &times, &weights);
    assert_eq!(measures.len(), 2);
    assert_eq!(measures[0].0, "4/4");
    assert_eq!(measures[0].2, 4);
    // Too few attacks: unknown bar, anchor to a beat.
    assert_eq!(measures[1], ("4/4".to_string(), 0, 1));
}
