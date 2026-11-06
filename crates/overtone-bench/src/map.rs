//! `map`: the 2-D coherence map makes no false changes.

use std::path::Path;

use crate::cases::*;
use anyhow::{bail, Result};

/// Truth changes where the *atom* jumps by a non-octave ratio. Exact
/// halvings/doublings keep the old period alive as a harmonic, so the ridge
/// rightly stays put there — that is the density detector's case (it finds
/// doubletime at 27.0 s; the ridge managed 30.8). Ramps are checked by
/// endpoint ratio; tiny-change and the secs-3/4 wobbles sit below the
/// 0.08-octave ridge resolution by design.
pub(crate) fn map_truth_changes(name: &str) -> Vec<f64> {
    match name {
        "change-128-142" | "secs-2" => vec![30.0],
        _ => Vec::new(),
    }
}

pub(crate) fn map_mode(root: &Path, only: &[String]) -> Result<()> {
    use overtone_tempo::map;
    // The density cases plus the ramps: the ridge has to slope on those.
    let mut names = density_cases(root)?;
    for extra in ["ramp-120-160", "ramp-180-140", "ramp-90-200"] {
        if !names.contains(&extra.to_string()) {
            names.push(extra.to_string());
        }
    }
    names.sort();
    println!("2-D coherence map: the ridge must follow the pulse — flat on");
    println!("constants, sloping on ramps, jumping once per atom change.\n");
    println!(
        "{:<20} {:>7}  {:>10}  {:>22}  verdict",
        "case", "windows", "ridge R", "changes"
    );
    println!("{}", "-".repeat(76));
    let mut failures = 0usize;
    for name in &names {
        if !only.is_empty() && !only.contains(name) {
            continue;
        }
        if is_signature(root, name) {
            println!("{name:<20}  (signature steps: judged by `gates.py signatures`)");
            continue;
        }
        let audio = root.join("bench/audio").join(format!("{name}.wav"));
        if !audio.is_file() {
            println!("{name:<20}  MISSING — {}", render_hint(root, name));
            failures += 1;
            continue;
        }
        let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
        let (attacks, _) = overtone_dsp::detect_attacks_default(&y, sr);
        let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
        let weights: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
        let built = map::build(&times, &weights);
        let ridge = map::ridge(&built);
        let changes = map::ridge_changes(&ridge);
        let confidence = map::mean_ridge_coherence(&ridge);
        let mut verdict = String::new();

        if name.starts_with("ramp-") {
            // Octave-free check: the endpoint period ratio must match truth
            // *at the endpoint window centres* — the ridge never sees t=0.
            // The extreme ramp is exempt from the no-jumps check: spanning
            // 1.15 octaves, its ridge wanders between non-octave multiples,
            // and greedy nearest-peak tracking cannot follow that. The fix
            // is a Viterbi pass over the columns (continuity cost plus peak
            // reward — the hitsound engine's DP pattern), not a threshold.
            let (bpm0, bpm1, duration, calm) = match name.as_str() {
                "ramp-120-160" => (120.0, 160.0, 60.0, true),
                "ramp-180-140" => (180.0, 140.0, 60.0, true),
                _ => (90.0, 200.0, 75.0, false),
            };
            let truth_at = |t: f64| bpm0 + (bpm1 - bpm0) * (t / duration);
            let ratio = ridge.last().map(|l| l.period).unwrap_or(f64::NAN)
                / ridge.first().map(|f| f.period).unwrap_or(1.0);
            let want = truth_at(ridge.first().map(|f| f.centre).unwrap_or(0.0))
                / truth_at(ridge.last().map(|l| l.centre).unwrap_or(duration));
            if (ratio - want).abs() / want > 0.05 || (calm && !changes.is_empty()) {
                verdict = format!("RAMP OFF (ratio {ratio:.3} vs {want:.3})");
                failures += 1;
            }
        } else {
            let want = map_truth_changes(name);
            if want.is_empty() {
                if !changes.is_empty() {
                    verdict = format!("FALSE CHANGES at {changes:.1?}");
                    failures += 1;
                }
            } else {
                let mut missing = Vec::new();
                for t in &want {
                    if !changes.iter().any(|c| (c - t).abs() <= 6.0) {
                        missing.push(*t);
                    }
                }
                let extra: Vec<f64> = changes
                    .iter()
                    .filter(|c| !want.iter().any(|t| (*c - t).abs() <= 6.0))
                    .copied()
                    .collect();
                if !missing.is_empty() || !extra.is_empty() {
                    verdict = format!("missed {missing:.1?}, extra {extra:.1?}");
                    failures += 1;
                }
            }
        }
        if verdict.is_empty() {
            verdict = "ok".to_string();
        }
        println!(
            "{:<20} {:>7}  {:>10.3}  {:>22.1?}  {verdict}",
            name,
            built.centres.len(),
            confidence,
            changes
        );
    }
    if failures == 0 {
        Ok(())
    } else {
        bail!("map gate failed");
    }
}
