//! `resample`, `structure` and `bands`: measurements, not gates.

use std::path::Path;

use crate::cases::*;
use anyhow::{bail, Result};

/// Resampling speed, which no other mode sees: every fixture is already
/// 44.1 kHz, so the resampler never runs in them. Six minutes of a
/// three-tone signal at each common source rate, converted to 44.1 kHz.
pub(crate) fn resample_mode() -> Result<()> {
    let seconds = 360.0;
    let tau = std::f64::consts::TAU;
    for rate in [48_000u32, 96_000, 32_000, 22_050] {
        let n = (seconds * rate as f64) as usize;
        let y: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / rate as f64;
                (0.3 * (tau * 220.0 * t).sin()
                    + 0.2 * (tau * 3_000.0 * t).sin()
                    + 0.1 * (tau * 9_000.0 * t).sin()) as f32
            })
            .collect();
        let started = std::time::Instant::now();
        let out = overtone_audio::resample::resample(&y, rate, 44_100);
        let took = started.elapsed().as_secs_f64();
        println!(
            "{rate:>6} Hz -> 44100 Hz   {seconds:.0} s of audio in {took:>6.2} s   {} samples out",
            out.len()
        );
    }
    Ok(())
}

/// Phrase boundaries, section labels and band flux on one fixture: the
/// whole-track spectral analyses, which have no gate of their own yet. The
/// mode exists to be measured from outside -- peak memory is the process's
/// peak working set, which safe Rust cannot read about itself -- and to show
/// the boundaries on real audio. In PowerShell, after a release build:
///
/// ```text
/// $p = Start-Process target\release\overtone-bench.exe 'structure','long-6min' -NoNewWindow -PassThru; $m = 0; while (!$p.HasExited) { $p.Refresh(); $m = [math]::Max($m, $p.PeakWorkingSet64); sleep -m 20 }; "{0:N0} MB" -f ($m / 1MB)
/// ```
pub(crate) fn structure_mode(root: &Path, name: &str) -> Result<()> {
    let audio = root.join("bench/audio").join(format!("{name}.wav"));
    if !audio.is_file() {
        bail!("{name} is missing -- {}", render_hint(root, name));
    }
    let started = std::time::Instant::now();
    let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
    let decode_s = started.elapsed().as_secs_f64();
    let started = std::time::Instant::now();
    // The section edges `overtone-cli structure` prints: repetition, not
    // the novelty peaks the hitsound engine reads.
    let structure = overtone_dsp::structure::phrases(&y, sr);
    let structure_s = started.elapsed().as_secs_f64();
    let started = std::time::Instant::now();
    let sections = overtone_dsp::classify::classify(&y, sr, &structure.boundaries);
    let classify_s = started.elapsed().as_secs_f64();
    let started = std::time::Instant::now();
    let flux = overtone_dsp::multiband::band_flux(&y, sr, 128, 2048);
    let flux_s = started.elapsed().as_secs_f64();

    println!("{name}: {:.1} s of audio", y.len() as f64 / sr as f64);
    let bounds: Vec<String> = structure
        .boundaries
        .iter()
        .map(|b| format!("{b:.1}"))
        .collect();
    println!("boundaries  [{}]", bounds.join(", "));
    let labels: Vec<String> = sections
        .iter()
        .map(|s| format!("{:?} {:.1}-{:.1}", s.kind, s.start, s.end))
        .collect();
    println!("sections    {}", labels.join(" | "));
    println!(
        "band flux   {} frames x {} bands",
        flux.len(),
        flux.first().map_or(0, Vec::len)
    );
    println!(
        "decode {decode_s:.2}s + structure {structure_s:.2}s + classify {classify_s:.2}s \
         + band flux {flux_s:.2}s"
    );
    Ok(())
}

/// Per-band flux, summarised so the Python port can be held to it: this is a
/// **measurement**, not a gate — it prints what Rust reads and exits 0, and
/// `proto/band_lanes.py` prints the same from the port for a diff. Frames
/// and per-band totals catch an alignment or a band-edge error; the loudest
/// frame per band catches a rectification one.
pub(crate) fn bands_mode(root: &Path, only: &[String]) -> Result<()> {
    let names = if only.is_empty() {
        all_cases(root)?
    } else {
        only.to_vec()
    };
    println!("Per-band rectified dB flux: 7 log bands over 40 Hz - 11.025 kHz,");
    println!("on the onset envelope's own frames, hop 128, n_fft 2048.\n");
    println!(
        "{:<20} {:>7}  band totals (dB), then the loudest frame of each",
        "case", "frames"
    );
    println!("{}", "-".repeat(100));
    let mut missing = 0usize;
    for name in &names {
        let audio = root.join("bench/audio").join(format!("{name}.wav"));
        if !audio.is_file() {
            println!("{name:<20}  MISSING — {}", render_hint(root, name));
            missing += 1;
            continue;
        }
        let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
        let flux = overtone_dsp::multiband::band_flux(&y, sr, 128, 2048);
        let bands = overtone_dsp::multiband::BANDS;
        let mut totals = vec![0.0f64; bands];
        let mut peak_at = vec![(0usize, 0.0f32); bands];
        for (frame, row) in flux.iter().enumerate() {
            for b in 0..bands {
                totals[b] += row[b] as f64;
                if row[b] > peak_at[b].1 {
                    peak_at[b] = (frame, row[b]);
                }
            }
        }
        let sums: Vec<String> = totals.iter().map(|t| format!("{t:.3}")).collect();
        let peaks: Vec<String> = peak_at.iter().map(|(f, _)| f.to_string()).collect();
        println!(
            "{name:<20} {:>7}  [{}]  [{}]",
            flux.len(),
            sums.join(", "),
            peaks.join(", ")
        );
    }
    if missing > 0 {
        println!("\n{missing} case(s) have no audio: nothing was measured for them");
    }
    Ok(())
}
