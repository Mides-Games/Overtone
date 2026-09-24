//! `overtone-cli`: the v4 engine behind one command, for the app to run as a
//! sidecar (roadmap Phase 22) and for scripts.
//!
//! ```text
//! overtone-cli analyze song.mp3              # [TimingPoints] lines
//! overtone-cli analyze song.mp3 --json       # v3's report shape
//! overtone-cli analyze song.mp3 --decimals 3 # lazer keeps fractional ms
//! ```
//!
//! stdout carries the result and nothing else; progress and errors go to
//! stderr, so a caller can pipe the red lines straight into a file.
//!
//! The JSON keeps the keys of v3's `analysis_report` (the Python CLI's
//! `--json`) wherever the v4 engine computes the same thing, so the app can
//! read either engine. Two differences, both deliberate: v3's `findings`
//! (timing validation) is not ported yet, and an empty list would claim
//! "checked, nothing found", so the key is absent; and `diagnostics` says why
//! the engine refused, where v3 falls back to its beat tracker instead.
//!
//! Exit codes: 0 a grid was found; 3 the engine refused (no grid in this
//! audio, reason on stderr and in `diagnostics`); 1 the file could not be
//! loaded; 2 the command line is wrong.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use overtone_core::Diagnostic;
use serde_json::{json, Value};

const USAGE: &str = "usage: overtone-cli analyze <audio> [--json] [--decimals N] \
[--min-delta BPM] [--persistence BEATS] [--min-confidence C] [--no-map-bpm]";

/// The v3 CLI's defaults, which the golden vectors were dumped with.
struct Options {
    audio: PathBuf,
    json: bool,
    decimals: u32,
    min_delta: f64,
    persistence: usize,
    min_confidence: f64,
    prefer_map_bpm: bool,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut rest = args.iter();
    match rest.next().map(String::as_str) {
        Some("analyze") => {}
        Some(other) => return Err(format!("unknown command {other:?}")),
        None => return Err("no command".into()),
    }
    let mut options = Options {
        audio: PathBuf::new(),
        json: false,
        decimals: 0,
        min_delta: 1.5,
        persistence: 12,
        min_confidence: 0.75,
        prefer_map_bpm: true,
    };
    let mut audio: Option<PathBuf> = None;
    while let Some(arg) = rest.next() {
        let mut value = |flag: &str| {
            rest.next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match arg.as_str() {
            "--json" => options.json = true,
            "--no-map-bpm" => options.prefer_map_bpm = false,
            "--decimals" => {
                options.decimals = number(&value(arg)?, arg)?;
                if options.decimals > 6 {
                    return Err("--decimals goes up to 6".into());
                }
            }
            "--min-delta" => options.min_delta = number(&value(arg)?, arg)?,
            "--persistence" => options.persistence = number(&value(arg)?, arg)?,
            "--min-confidence" => options.min_confidence = number(&value(arg)?, arg)?,
            flag if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            path => {
                if audio.replace(PathBuf::from(path)).is_some() {
                    return Err("one audio file at a time".into());
                }
            }
        }
    }
    options.audio = audio.ok_or("no audio file")?;
    Ok(options)
}

fn number<T: std::str::FromStr>(text: &str, flag: &str) -> Result<T, String> {
    text.parse()
        .map_err(|_| format!("{flag} expects a number, got {text:?}"))
}

fn diagnostic_json(d: &Diagnostic) -> Value {
    match d {
        Diagnostic::TooFewAttacks { found, needed } => {
            json!({"kind": "too_few_attacks", "found": found, "needed": needed})
        }
        Diagnostic::NoCoherentPulse { best_share } => {
            json!({"kind": "no_coherent_pulse", "best_share": best_share})
        }
        Diagnostic::LargeGridResidual { residual_ms } => {
            json!({"kind": "large_grid_residual", "residual_ms": residual_ms})
        }
        Diagnostic::StageFailed { stage, detail } => {
            json!({"kind": "stage_failed", "stage": stage, "detail": detail})
        }
    }
}

fn describe(d: &Diagnostic) -> String {
    match d {
        Diagnostic::TooFewAttacks { found, needed } => {
            format!("too few attacks to fit a grid ({found}, needs {needed})")
        }
        Diagnostic::NoCoherentPulse { best_share } => format!(
            "no steady pulse: the best grid explains {:.0} % of the attacks",
            best_share * 100.0
        ),
        Diagnostic::LargeGridResidual { residual_ms } => {
            format!("the music does not sit on a fixed grid ({residual_ms:.1} ms residual)")
        }
        Diagnostic::StageFailed { stage, detail } => format!("stage {stage} failed: {detail}"),
    }
}

fn analyze(options: &Options) -> ExitCode {
    let started = Instant::now();
    let (y, sr) = match overtone_audio::load(&options.audio) {
        Ok(loaded) => loaded,
        Err(e) => {
            eprintln!("overtone-cli: cannot load {}: {e}", options.audio.display());
            if options.json {
                println!(
                    "{}",
                    json!({"source": source(&options.audio), "error": e.to_string()})
                );
            }
            return ExitCode::from(1);
        }
    };
    let decode_s = started.elapsed().as_secs_f64();
    eprintln!(
        "overtone-cli: {} ({:.1} s of audio) decoded in {decode_s:.2} s",
        options.audio.display(),
        y.len() as f64 / sr as f64
    );

    let started = Instant::now();
    let (attacks, env) = overtone_dsp::detect_attacks_default(&y, sr);
    let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
    let weights: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
    let attacks_s = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let out = overtone_tempo::points::analyze_attacks(
        &times,
        &weights,
        &env,
        sr,
        options.min_delta,
        options.persistence,
        options.prefer_map_bpm,
        options.min_confidence,
    );
    let tempo_s = started.elapsed().as_secs_f64();
    let refused = out.points.is_empty();
    for d in &out.diagnostics {
        eprintln!("overtone-cli: {}", describe(d));
    }

    if options.json {
        let snapped = overtone_tempo::points::snap_timing_points(&out.points);
        let found = |v: f64| if refused { Value::Null } else { json!(v) };
        let report = json!({
            "source": source(&options.audio),
            "duration": y.len() as f64 / sr as f64,
            "global_bpm": found(out.global_bpm),
            "stability": found(out.stability),
            "meter": out.meter_text,
            "engine": if refused { "refused" } else { "precision" },
            "subdivision": 1.0,
            "residual_ms": found(out.fit_residual_ms),
            "points": snapped.iter().map(|p| json!({
                "offset_ms": p.offset.get(),
                "bpm": p.bpm.get(),
                "confidence": p.confidence,
                "meter": p.meter,
                "meter_known": p.meter_known,
            })).collect::<Vec<_>>(),
            "sections": out.settled_sections.iter().map(|s| json!({
                "start_s": s.start.get(),
                "end_s": s.end.get(),
                "bpm": if s.period > 0.0 { 60.0 / s.period } else { 0.0 },
                "residual_ms": s.residual_ms,
                "coverage": s.coverage,
                "inliers": s.inliers,
            })).collect::<Vec<_>>(),
            "diagnostics": out.diagnostics.iter().map(diagnostic_json).collect::<Vec<_>>(),
            "version": overtone_tempo::VERSION,
            "timings_s": {"decode": decode_s, "attacks": attacks_s, "tempo": tempo_s},
        });
        println!("{report}");
    } else if !refused {
        println!(
            "{}",
            overtone_tempo::points::osu_timing_text(&out.points, &out.meter_text, options.decimals)
        );
    }
    eprintln!(
        "overtone-cli: attacks {attacks_s:.2} s + tempo {tempo_s:.2} s{}",
        if refused { ", no grid" } else { "" }
    );
    if refused {
        ExitCode::from(3)
    } else {
        ExitCode::SUCCESS
    }
}

fn source(path: &Path) -> String {
    path.display().to_string()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args) {
        Ok(options) => analyze(&options),
        Err(message) => {
            eprintln!("overtone-cli: {message}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
