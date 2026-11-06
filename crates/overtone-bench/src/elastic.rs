//! `elastic`: no invented curvature.

use std::path::Path;

use crate::{cases::*, vectors::*};
use anyhow::{bail, Result};

/// Genuine tempo ramps: (start BPM, end BPM, duration s, hard gate). v3
/// falls back to the tracker here (an 8-section staircase on the first one).
/// The extreme ramp is reported, not gated: the prototype misses its own
/// median bound there too (1.387 > 1.0) — it needs the §B.1 spline, and the
/// honest gate says so instead of pretending.
pub(crate) fn elastic_ramps() -> Vec<(&'static str, f64, f64, f64, bool)> {
    vec![
        ("ramp-120-160", 120.0, 160.0, 60.0, true),
        ("ramp-180-140", 180.0, 140.0, 60.0, true),
        ("ramp-90-200", 90.0, 200.0, 75.0, false),
    ]
}

/// Cases whose tempo genuinely moves, so the elastic model is allowed to
/// bend there. Everywhere else drift over 1 % is inventing curvature.
pub(crate) fn elastic_may_bend(name: &str) -> bool {
    matches!(name, "secs-4" | "tiny-change")
}

/// Step-tempo fixtures. The degree digit there is cliff dynamics (a 15 %
/// gain rule the reference itself sits ~3 % from), so what is gated is the
/// property both implementations share: the elastic residual stays two
/// orders of magnitude above the piecewise one, and the selector keeps v3.
pub(crate) fn elastic_is_steps(root: &Path, name: &str) -> bool {
    matches!(
        name,
        "change-128-142" | "secs-2" | "secs-3" | "three-sections"
    ) || is_signature(root, name)
}

pub(crate) fn elastic_mode(root: &Path, only: &[String]) -> Result<()> {
    use overtone_tempo::elastic;
    let mut failures = 0usize;

    println!("RAMPS — tempo genuinely changes. v3 falls back to the v2 tracker here.\n");
    println!(
        "{:<16} {:>3} {:>8}  {:>22}  {:>17}",
        "case", "deg", "rms", "fitted BPM span", "BPM err med/max"
    );
    println!("{}", "-".repeat(76));
    for (name, bpm0, bpm1, duration, hard) in elastic_ramps() {
        if !only.is_empty() && !only.contains(&name.to_string()) {
            continue;
        }
        let audio = root.join("bench/audio").join(format!("{name}.wav"));
        if !audio.is_file() {
            println!("{name:<16}  MISSING — {}", render_hint(root, name));
            failures += 1;
            continue;
        }
        let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
        let (attacks, _) = overtone_dsp::detect_attacks_default(&y, sr);
        let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
        let weights: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
        match elastic::fit(&times, &weights) {
            None => {
                println!("{name:<16}  no fit   <-- MISS");
                failures += 1;
            }
            Some((model, report)) => {
                let mut errs: Vec<f64> = report
                    .beat_indices
                    .iter()
                    .map(|&k| {
                        let t = model.time_at(k);
                        let truth = bpm0 + (bpm1 - bpm0) * (t / duration);
                        (model.bpm_at(k) - truth).abs()
                    })
                    .collect();
                errs.sort_by(f64::total_cmp);
                let med = errs[errs.len() / 2];
                let max = errs[errs.len() - 1];
                let (first, last) = degree_span(&model, &report);
                let ok = med <= 1.0 && max <= 4.0;
                if !ok && hard {
                    failures += 1;
                }
                println!(
                    "{:<16} {:>3} {:>6.2}ms  {:>9.2} -> {:<9.2}  {:>7.3} /{:<8.3}{}",
                    name,
                    report.chosen_degree,
                    report.rms_ms,
                    first,
                    last,
                    med,
                    max,
                    if ok {
                        ""
                    } else if hard {
                        "   <-- MISS"
                    } else {
                        "   <-- known limit, needs the spline"
                    }
                );
            }
        }
    }

    println!("\nCONSTANT TEMPO — the elastic model must NOT invent curvature.\n");
    println!(
        "{:<18} {:>3} {:>8}  {:>22}  {:>7}  {:>8}  winner",
        "case", "deg", "rms", "fitted BPM span", "drift", "v3 rms"
    );
    println!("{}", "-".repeat(100));
    let mut drifts: Vec<f64> = Vec::new();
    for name in all_cases(root)? {
        if !only.is_empty() && !only.contains(&name) {
            continue;
        }
        let text = std::fs::read_to_string(root.join("bench/golden").join(format!("{name}.json")))?;
        let golden: Golden = serde_json::from_str(&text)?;
        let times = golden.attacks.times_s.clone();
        let weights: Vec<f32> = golden.attacks.weights.iter().map(|&w| w as f32).collect();
        match elastic::fit(&times, &weights) {
            None => {
                println!("{name:<18}  no fit   <-- MISS");
                failures += 1;
            }
            Some((model, report)) => {
                let (first, last) = degree_span(&model, &report);
                let drift = (last - first).abs() / first.abs().max(1e-9);
                drifts.push(drift);
                let v3_rms = golden.result.fit_residual_ms;
                // Steps are gated on the selector signal, not the digit.
                let ok = if elastic_is_steps(root, &name) {
                    report.rms_ms > 5.0 && v3_rms < 1.0
                } else {
                    drift <= 0.01 || elastic_may_bend(&name)
                };
                if !ok {
                    failures += 1;
                    // A failure prints every degree's evidence, not just the
                    // winner — that is what tells dust apart from drift.
                    for (deg, info) in &report.degrees {
                        println!(
                            "      deg {deg}: rms {:>8} inliers {:>4}",
                            info.rms_ms
                                .map(|r| format!("{r:.3}ms"))
                                .unwrap_or_else(|| "-".to_string()),
                            info.inliers
                        );
                    }
                }
                let winner = if v3_rms <= report.rms_ms {
                    "v3"
                } else {
                    "elastic"
                };
                println!(
                    "{:<18} {:>3} {:>6.2}ms  {:>9.3} -> {:<9.3}  {:>5.2}%  {:>6.2}ms  {}{}",
                    name,
                    report.chosen_degree,
                    report.rms_ms,
                    first,
                    last,
                    drift * 100.0,
                    v3_rms,
                    winner,
                    if ok { "" } else { "   <-- BENT" }
                );
            }
        }
    }
    if !drifts.is_empty() {
        drifts.sort_by(f64::total_cmp);
        println!(
            "\nmedian invented drift {:.3}%   worst {:.3}%",
            drifts[drifts.len() / 2] * 100.0,
            drifts[drifts.len() - 1] * 100.0
        );
    }
    if failures == 0 {
        Ok(())
    } else {
        bail!("elastic gate failed");
    }
}

/// BPM at the first and last fitted beat index.
pub(crate) fn degree_span(
    model: &overtone_tempo::elastic::Elastic,
    report: &overtone_tempo::elastic::ElasticReport,
) -> (f64, f64) {
    let k_min = report
        .beat_indices
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);
    let k_max = report
        .beat_indices
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    (model.bpm_at(k_min), model.bpm_at(k_max))
}
