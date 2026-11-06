//! `nogrid`: noise, pads and silence refused.

use std::path::Path;

use crate::cases::*;
use anyhow::{bail, Result};

/// Inputs with no answer. Nothing here may hang, crash, or bluff: no
/// sections, no red lines, and a diagnostic that names the refusal.
/// Mirrors `benchmark.py`'s degenerate section, which caught v3's legacy
/// tracker answering 127.68 BPM to white noise.
pub(crate) fn nogrid_mode(root: &Path) -> Result<()> {
    use overtone_core::Diagnostic;
    let cases = ["_noise", "_ambient", "_silence"];
    println!(
        "{:<10} {:>8}  {:>9}  {:>8}  verdict",
        "case", "attacks", "sections", "points"
    );
    println!("{}", "-".repeat(56));
    let mut failures = 0usize;
    let mut ran = 0usize;
    for name in cases {
        let audio = root.join("bench/audio").join(format!("{name}.wav"));
        if !audio.is_file() {
            println!("{name:<10}  MISSING — {}", render_hint(root, name));
            failures += 1;
            continue;
        }
        ran += 1;
        let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
        let (attacks, env) = overtone_dsp::detect_attacks_default(&y, sr);
        let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
        let w32: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
        let pipeline =
            overtone_tempo::points::analyze_attacks(&times, &w32, &env, sr, 1.5, 12, true, 0.75);
        let honest = pipeline.points.is_empty()
            && pipeline.settled_sections.is_empty()
            && matches!(
                pipeline.diagnostics.as_slice(),
                [Diagnostic::NoCoherentPulse { .. } | Diagnostic::TooFewAttacks { .. }]
            );
        if !honest {
            failures += 1;
        }
        println!(
            "{:<10} {:>8}  {:>9}  {:>8}  {} {:?}",
            name,
            attacks.len(),
            pipeline.settled_sections.len(),
            pipeline.points.len(),
            if honest { "refused" } else { "BLUFFED" },
            pipeline.diagnostics,
        );
    }
    if ran == 0 {
        bail!("no degenerate audio found");
    }
    if failures == 0 {
        Ok(())
    } else {
        bail!("no-grid gate failed");
    }
}
