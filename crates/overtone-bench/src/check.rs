//! `golden`: every stage of every case against v3, and `candidates`, its debug aid.

use std::path::Path;

use crate::{cases::*, diff::*, vectors::*};
use anyhow::{bail, Context, Result};

/// Pearson correlation. Weights are envelope heights, which carry the same
/// information in both implementations but not bit-identically once the
/// envelope has been through a different summation order.
pub(crate) fn correlation(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    if n < 2 {
        return f64::NAN;
    }
    let (a, b) = (&a[..n], &b[..n]);
    let mean_a = a.iter().sum::<f64>() / n as f64;
    let mean_b = b.iter().sum::<f64>() / n as f64;
    let mut num = 0.0;
    let mut da = 0.0;
    let mut db = 0.0;
    for i in 0..n {
        let x = a[i] - mean_a;
        let y = b[i] - mean_b;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if da <= 0.0 || db <= 0.0 {
        return f64::NAN;
    }
    num / (da * db).sqrt()
}

pub(crate) fn check_case(root: &Path, name: &str) -> Result<Report> {
    let vector_path = root.join("bench/golden").join(format!("{name}.json"));
    let text = std::fs::read_to_string(&vector_path)
        .with_context(|| format!("reading {}", vector_path.display()))?;
    let golden: Golden = serde_json::from_str(&text)
        .with_context(|| format!("parsing {}", vector_path.display()))?;
    let missing = golden.missing_stages();
    if !missing.is_empty() {
        bail!(
            "{} carries no {} stage; a skipped stage fails rather than passing unseen",
            vector_path.display(),
            missing.join(", ")
        );
    }

    let audio = root.join("bench/audio").join(format!("{name}.wav"));
    if !audio.exists() {
        bail!(
            "{} is missing. Run `python bench/golden.py dump` first — it renders the audio.",
            audio.display()
        );
    }
    let started = std::time::Instant::now();
    let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
    let decode_s = started.elapsed().as_secs_f64();
    let started = std::time::Instant::now();
    let (attacks, env) = overtone_dsp::detect_attacks_default(&y, sr);
    let attacks_s = started.elapsed().as_secs_f64();

    let ours: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
    let our_weights: Vec<f64> = attacks.iter().map(|a| a.weight as f64).collect();
    let our_w32: Vec<f32> = attacks.iter().map(|a| a.weight).collect();

    // Pair by nearest neighbour rather than by index: one extra or missing
    // attack should show up as a count mismatch, not as every later attack
    // appearing wildly wrong.
    let mut matched = 0usize;
    let mut worst_ms = 0.0f64;
    let mut worst_at = 0.0f64;
    let mut worst_weight_err = 0.0f64;
    for (want, &want_weight) in golden.attacks.times_s.iter().zip(&golden.attacks.weights) {
        let want = *want;
        let mut best = f64::INFINITY;
        let mut nearest = 0usize;
        for (i, &got) in ours.iter().enumerate() {
            let d = (got - want).abs();
            if d < best {
                best = d;
                nearest = i;
            }
        }
        if best <= ATTACK_TOL_S {
            matched += 1;
            worst_weight_err = worst_weight_err.max((our_weights[nearest] - want_weight).abs());
        }
        if best > worst_ms / 1000.0 {
            worst_ms = best * 1000.0;
            worst_at = want;
        }
    }

    // Coherence candidates, on the window v3's first sweep used: the widest
    // seed width inside the anchor window.
    let (anchor_lo, anchor_hi) = overtone_tempo::anchor_window(&ours);
    let span = overtone_tempo::SEED_WIDTHS[0].min(anchor_hi - anchor_lo);
    let (w_times, w_weights) =
        overtone_tempo::fit::window(&ours, &our_w32, anchor_lo, anchor_lo + span);
    let got_candidates = overtone_tempo::coherence::candidates(&w_times, &w_weights, 10);

    // The anchor seed: the first `_seed_grid` call v3 records. Two things are
    // checked against it — that our refined seed matches, and that the raw
    // candidate list contained it in the first place.
    let mut seed_period_err = 0.0f64;
    let mut seed_phase_ms = 0.0f64;
    let mut seed_in_candidates = true;
    if let Some(Some(want)) = golden.seeds.first() {
        seed_in_candidates = got_candidates
            .iter()
            .any(|c| (c.period - want.period_s).abs() <= CANDIDATE_REL_TOL * want.period_s);
        match overtone_tempo::seed_grid(
            &ours,
            &our_w32,
            anchor_lo,
            anchor_hi,
            None,
            &overtone_tempo::SEED_WIDTHS,
        ) {
            Some(grid) => {
                seed_period_err = (grid.period - want.period_s).abs();
                seed_phase_ms = (grid.phase - want.phase_s).abs() * 1000.0;
            }
            None => {
                seed_period_err = f64::INFINITY;
                seed_phase_ms = f64::INFINITY;
            }
        }
    }

    // The octave decision, on the same anchor window and seed v3 used. This
    // is the stage audit finding F-07 says nothing in v3 tests.
    let mut octave_expected = 0usize;
    let mut octave_found = 0usize;
    let mut class_expected = 0usize;
    let mut class_found = 0usize;
    if let (Some(want), Some(Some(seed))) = (&golden.octave, golden.seeds.first()) {
        octave_expected = want.atoms_per_beat;
        class_expected = want.first_class;
        let hints = overtone_tempo::octave::tempo_hints(&env, sr, overtone_core::FIT_HOP);
        let (aw_times, aw_weights) =
            overtone_tempo::fit::window(&ours, &our_w32, anchor_lo, anchor_hi);
        let (m, class) = overtone_tempo::octave::beat_from_atoms(
            &aw_times,
            &aw_weights,
            overtone_tempo::fit::Grid {
                period: seed.period_s,
                phase: seed.phase_s,
            },
            &hints,
            true,
        );
        octave_found = m;
        class_found = class;
    }

    // End-to-end precision driver (`_precision_engine` + the
    // `_assemble_analysis` filters at factor 1): seed, octave, grow,
    // beat-convert, settle, meter, points. Defaults match `analyze_audio`:
    // min_delta 1.5, persistence 12, min_confidence 0.75.
    let started = std::time::Instant::now();
    let pipeline =
        overtone_tempo::points::analyze_attacks(&ours, &our_w32, &env, 44_100, 1.5, 12, true, 0.75);
    let tempo_s = started.elapsed().as_secs_f64();
    let atom = diff_sections(
        "atom_sections",
        &pipeline.atom_sections,
        &golden.atom_sections,
    );
    let beat = diff_sections(
        "beat_sections",
        &pipeline.beat_sections,
        &golden.beat_sections,
    );
    let settled = diff_sections(
        "settled_sections",
        &pipeline.settled_sections,
        &golden.settled_sections,
    );

    // Global meter, as `_precision_engine` reads it off the first settled
    // section — the only octave-adjacent stage v3 tests never pinned (F-07).
    let mut meter_diff: Option<String> = None;
    if let Some(want) = &golden.meter {
        if pipeline.meter_text != want.meter
            || pipeline.downbeat != want.downbeat_class
            || pipeline.meter_beats != want.bar_beats
        {
            meter_diff = Some(format!(
                "meter: {}/{}/{} -> {}/{}/{}",
                want.meter,
                want.downbeat_class,
                want.bar_beats,
                pipeline.meter_text,
                pipeline.downbeat,
                pipeline.meter_beats
            ));
        }
    }
    // Snapped red lines, the actual product. Tolerances match golden.py:
    // offsets within 0.05 ms, BPM within 0.001.
    let mut points_diff: Option<String> = None;
    if pipeline.points.len() != golden.result.points.len() {
        points_diff = Some(format!(
            "points: {} red lines -> {}",
            golden.result.points.len(),
            pipeline.points.len()
        ));
    } else {
        let mut worst_off = 0.0f64;
        let mut worst_bpm = 0.0f64;
        let mut worst_conf = 0.0f64;
        let mut meters_differ = 0usize;
        for (got, want) in pipeline.points.iter().zip(golden.result.points.iter()) {
            worst_off = worst_off.max((got.offset.get() - want.offset_ms).abs());
            worst_bpm = worst_bpm.max((got.bpm.get() - want.bpm).abs());
            // Confidence and the proven bar were never compared: a red line
            // could lose its bar, or its confidence, with the gate green.
            worst_conf = worst_conf.max((got.confidence - want.confidence).abs());
            if got.meter as usize != want.meter || got.meter_known != want.meter_known {
                meters_differ += 1;
            }
        }
        if worst_off > 0.05 || worst_bpm > 1e-3 || worst_conf > 1e-3 || meters_differ > 0 {
            points_diff = Some(format!(
                "points: worst offset {worst_off:.4}ms, worst bpm {worst_bpm:.6},                  worst confidence {worst_conf:.5}, {meters_differ} meter(s) differ"
            ));
        }
    }

    // Duration-weighted global BPM, as `_assemble_analysis` reduces it.
    let global_bpm_err = (pipeline.global_bpm - golden.result.global_bpm).abs();

    Ok(Report {
        case: golden.case,
        decode_s,
        attacks_s,
        tempo_s,
        seed_in_candidates,
        octave_expected,
        octave_found,
        class_expected,
        class_found,
        seed_period_err,
        seed_phase_ms,
        expected: golden.attacks.count,
        found: ours.len(),
        matched,
        worst_ms,
        worst_at,
        env_frames_expected: golden.attacks.envelope_frames,
        env_frames_found: env.len(),
        weight_correlation: correlation(&our_weights, &golden.attacks.weights),
        env_sum_err: (env.iter().map(|&v| v as f64).sum::<f64>() - golden.attacks.envelope_sum)
            .abs(),
        worst_weight_err,
        atom,
        beat,
        settled,
        meter_diff,
        points_diff,
        global_bpm_err,
    })
}

/// Debug aid: print the coherence candidates beside v3's, for one case.
pub(crate) fn candidates_mode(root: &Path, name: &str) -> Result<()> {
    let text = std::fs::read_to_string(root.join("bench/golden").join(format!("{name}.json")))?;
    let golden: Golden = serde_json::from_str(&text)?;
    let (y, sr) = overtone_audio::load(&root.join("bench/audio").join(format!("{name}.wav")))
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let (attacks, _) = overtone_dsp::detect_attacks_default(&y, sr);
    let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
    let w: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
    let (lo, hi) = overtone_tempo::anchor_window(&times);
    let span = overtone_tempo::SEED_WIDTHS[0].min(hi - lo);
    let (wt, ww) = overtone_tempo::fit::window(&times, &w, lo, lo + span);
    println!(
        "anchor {lo:.6}..{hi:.6}  span {span:.6}  attacks in window {}",
        wt.len()
    );
    let got = overtone_tempo::coherence::candidates(&wt, &ww, 10);
    println!(
        "{:<4} {:>14} {:>14} {:>10}   {:>14} {:>14}",
        "#", "v3 period", "rust period", "d period", "v3 phase", "rust phase"
    );
    for i in 0..golden.candidates.len().max(got.len()) {
        let want = golden.candidates.get(i);
        let mine = got.get(i);
        let dp = match (want, mine) {
            (Some(a), Some(b)) => format!("{:10.2e}", (a.period_s - b.period).abs()),
            _ => "-".to_string(),
        };
        println!(
            "{:<4} {:>14} {:>14} {:>10}   {:>14} {:>14}",
            i,
            want.map(|c| format!("{:.9}", c.period_s))
                .unwrap_or_else(|| "-".into()),
            mine.map(|c| format!("{:.9}", c.period))
                .unwrap_or_else(|| "-".into()),
            dp,
            want.map(|c| format!("{:.7}", c.phase_s))
                .unwrap_or_else(|| "-".into()),
            mine.map(|c| format!("{:.7}", c.phase))
                .unwrap_or_else(|| "-".into()),
        );
    }
    Ok(())
}

/// The golden-vector check: every case, stage by stage, against v3.
pub(crate) fn golden_mode(root: &Path, args: &[String]) -> Result<()> {
    let only: Vec<String> = args
        .iter()
        .skip_while(|a| *a != "--only")
        .skip(1)
        .cloned()
        .collect();
    let names = if only.is_empty() {
        all_cases(&root)?
    } else {
        only
    };
    if names.is_empty() {
        bail!("no golden vectors found. Run `python bench/golden.py dump`.");
    }

    println!("Stage-by-stage diff against the v3 Python engine.");
    println!(
        "Tolerance: attacks within {:.3} ms.\n",
        ATTACK_TOL_S * 1000.0
    );
    println!(
        "{:<18} {:>8} {:>8} {:>10} {:>3} {:>10} {:>7} {:>8}  verdict",
        "case", "attacks", "matched", "worst", "in", "seed dP", "octave", "analyse"
    );
    println!("{}", "-".repeat(92));

    let mut failures = 0usize;
    let mut total_decode = 0.0f64;
    let mut total_attacks = 0.0f64;
    let mut total_tempo = 0.0f64;
    for name in &names {
        match check_case(&root, name) {
            Ok(report) => {
                let verdict = if report.ok() {
                    "ok".to_string()
                } else {
                    failures += 1;
                    let mut why = Vec::new();
                    if report.found != report.expected {
                        why.push("count".to_string());
                    }
                    if report.env_frames_found != report.env_frames_expected {
                        why.push(format!(
                            "env {} vs {}",
                            report.env_frames_found, report.env_frames_expected
                        ));
                    }
                    if report.env_sum_err > ENV_SUM_TOL {
                        why.push(format!("envelope sum {:.4} off", report.env_sum_err));
                    }
                    if report.worst_weight_err > WEIGHT_TOL {
                        why.push(format!("a weight {:.2e} off", report.worst_weight_err));
                    }
                    if report.weight_correlation <= 0.999 {
                        why.push(format!("weights r={:.4}", report.weight_correlation));
                    }
                    if !report.seed_in_candidates {
                        why.push("seed not among candidates".to_string());
                    }
                    if report.octave_found != report.octave_expected {
                        why.push(format!(
                            "OCTAVE {} -> {} atoms/beat",
                            report.octave_expected, report.octave_found
                        ));
                    }
                    if report.class_found != report.class_expected {
                        why.push(format!(
                            "accent class {} -> {}",
                            report.class_expected, report.class_found
                        ));
                    }
                    if report.seed_period_err > PERIOD_TOL_S {
                        why.push(format!("seed period {:.2e}s off", report.seed_period_err));
                    }
                    if report.seed_phase_ms > ATTACK_TOL_S * 1000.0 {
                        why.push(format!("seed phase {:.4}ms off", report.seed_phase_ms));
                    }
                    for diff in [&report.atom, &report.beat, &report.settled] {
                        if let Some(text) = diff.describe() {
                            why.push(text);
                        }
                    }
                    if let Some(text) = &report.meter_diff {
                        why.push(text.clone());
                    }
                    if let Some(text) = &report.points_diff {
                        why.push(text.clone());
                    }
                    if report.global_bpm_err > 1e-3 {
                        why.push(format!("global bpm {:.4} off", report.global_bpm_err));
                    }
                    if report.matched != report.expected {
                        why.push(format!(
                            "{} unmatched",
                            report.expected.saturating_sub(report.matched)
                        ));
                    }
                    format!(
                        "DIFF: {} (worst at {:.3}s)",
                        why.join(", "),
                        report.worst_at
                    )
                };
                total_decode += report.decode_s;
                total_attacks += report.attacks_s;
                total_tempo += report.tempo_s;
                println!(
                    "{:<18} {:>8} {:>8} {:>8.4}ms {:>3} {:>10.2e} {:>7} {:>7.3}s  {verdict}",
                    report.case,
                    report.expected,
                    report.matched,
                    report.worst_ms,
                    if report.seed_in_candidates { "y" } else { "N" },
                    report.seed_period_err,
                    format!("{}/{}", report.octave_found, report.octave_expected),
                    report.attacks_s + report.tempo_s,
                );
            }
            Err(e) => {
                failures += 1;
                println!("{name:<18}  ERROR: {e:#}");
            }
        }
    }

    println!();
    // All three, because Python's figure times the whole analyze_audio call:
    // attack detection alone once stood in for "the corpus analyses in 2.5 s".
    println!(
        "decode {total_decode:.2}s + attacks {total_attacks:.2}s + tempo {total_tempo:.2}s \
         = {:.2}s, the whole pipeline",
        total_decode + total_attacks + total_tempo
    );
    if failures == 0 {
        println!(
            "{}/{} cases match the v3 engine attack for attack.",
            names.len(),
            names.len()
        );
        Ok(())
    } else {
        println!("{failures}/{} cases diverge.", names.len());
        bail!("golden-vector check failed");
    }
}
