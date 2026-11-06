//! `density`: density changes found, and none invented.

use std::path::Path;

use crate::cases::*;
use anyhow::{bail, Result};

pub(crate) fn density_mode(root: &Path, only: &[String]) -> Result<()> {
    // Every fixture the manifest marks for this gate, coverage ones included:
    // required, not optional, since one skipped for being unrendered would let
    // the gate pass with less measured than its documented count.
    let names = density_cases(root)?;
    let names: Vec<String> = if only.is_empty() {
        names
    } else {
        only.to_vec()
    };
    println!("Density-change detector: coverage says 'half the slots are empty',");
    println!("parity says 'and it is every other one'. Both are required.\n");
    println!(
        "{:<20} {:>6}  {:>6}  {:>8}  {:>12}  {:>14}",
        "case", "truth", "thin", "at", "cov in/out", "parity in/out"
    );
    println!("{}", "-".repeat(82));
    let mut expected = 0usize;
    let mut hits = 0usize;
    let mut false_positives = 0usize;
    let mut worst_err = 0.0f64;
    let mut misses: Vec<String> = Vec::new();
    let mut missing = 0usize;
    for name in &names {
        if is_signature(root, name) {
            println!("{name:<20}  (signature steps: judged by `gates.py signatures`)");
            continue;
        }
        let audio = root.join("bench/audio").join(format!("{name}.wav"));
        if !audio.is_file() {
            println!("{name:<20}  MISSING — {}", render_hint(root, name));
            missing += 1;
            continue;
        }
        let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
        let (attacks, env) = overtone_dsp::detect_attacks_default(&y, sr);
        let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
        let w32: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
        let pipeline =
            overtone_tempo::points::analyze_attacks(&times, &w32, &env, sr, 1.5, 12, true, 0.75);
        let hints =
            overtone_tempo::density::scan_sections(&pipeline.settled_sections, &times, &w32);
        let truth = density_truth(name);
        // Only count it as expected when the engine merged the change into
        // one section: two red lines mean there is nothing left to find.
        let should_fire = truth.is_some() && pipeline.settled_sections.len() == 1;
        if should_fire {
            expected += 1;
        }
        // .rev(): the first of equal scores, as the prototype's max().
        let best = hints
            .iter()
            .rev()
            .max_by(|a, b| a.score.total_cmp(&b.score));
        if let Some(found) = best {
            println!(
                "{:<20} {:>6}  {:>6}  {:>7.1}s  {:>5.2}/{:<5.2}  {:>5.2}/{:<5.2}",
                name,
                truth
                    .map(|(_, r)| format!("{r}"))
                    .unwrap_or_else(|| "-".into()),
                match found.side {
                    overtone_tempo::density::ThinSide::Head => "head",
                    overtone_tempo::density::ThinSide::Tail => "tail",
                    overtone_tempo::density::ThinSide::Mid => "mid",
                },
                found.boundary_s,
                found.coverage_in,
                found.coverage_out,
                found.parity_in,
                found.parity_out,
            );
        } else {
            println!(
                "{:<20} {:>6}  {:>6}  {:>8}  {:>12}  {:>14}",
                name,
                truth
                    .map(|(_, r)| format!("{r}"))
                    .unwrap_or_else(|| "-".into()),
                "no",
                "-",
                "-",
                "-"
            );
        }
        if should_fire {
            match best {
                Some(found) => {
                    let err = (found.boundary_s - truth.unwrap().0).abs();
                    if err <= 4.0 {
                        hits += 1;
                        worst_err = worst_err.max(err);
                    } else {
                        misses.push(format!("{name} (fired {err:.1}s off)"));
                    }
                }
                None => misses.push(name.to_string()),
            }
        } else if best.is_some() {
            false_positives += 1;
            misses.push(format!("{name} (FALSE POSITIVE)"));
        }
    }
    println!("\ndetected {hits}/{expected} real density changes (worst {worst_err:.2}s off)");
    println!("false positives: {false_positives}");
    if !misses.is_empty() {
        println!("missed: {}", misses.join(", "));
    }
    if missing > 0 {
        bail!("{missing} case(s) have no audio: nothing was measured for them");
    }
    // The documented gate is 4/4: with a case gone, 0/0 would read as a pass.
    if only.is_empty() && expected != DENSITY_TRUTH_CASES {
        bail!("{expected} truth case(s) needed a hint; the gate is {DENSITY_TRUTH_CASES}");
    }
    if hits == expected && false_positives == 0 {
        Ok(())
    } else {
        bail!("density gate failed");
    }
}
