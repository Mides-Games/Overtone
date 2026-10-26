//! `overtone-cli`: the v4 engine behind one command, for the app to run as a
//! sidecar (roadmap Phase 22) and for scripts.
//!
//! ```text
//! overtone-cli analyze song.mp3              # [TimingPoints] lines
//! overtone-cli analyze song.mp3 --json       # v3's report shape
//! overtone-cli analyze song.mp3 --decimals 3 # lazer keeps fractional ms
//! overtone-cli analyze song.mp3 --full       # + the evidence an app needs
//! overtone-cli structure song.mp3            # phrases, labels, energy (JSON)
//! overtone-cli ramps song.mp3 [--drift MS] # the elastic curve as the fewest
//!                       [--max-lines N]    # red lines within the drift (JSON)
//! ```
//!
//! `--full` adds what v3's `Analysis` carries beside the red lines: the
//! fitting envelope and its hop, the attacks and their weights, the beat
//! grid, the local BPM curve, the bar, and the red lines before export
//! snapping. With it the app can build the same result object from either
//! engine.
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
//! `structure` prints section boundaries, the section labels with the
//! evidence each rests on (repetition group, repeats, level), and the energy
//! lane behind them. The boundaries are where the song starts or stops
//! repeating itself (`structure::phrases`), not novelty peaks. It is
//! tempoless, as the DSP crate is: boundaries
//! sit on the 0.5 s feature grid, and snapping them to downbeats is the
//! caller's job, since the caller holds the grid.
//!
//! `ramps` turns the elastic tempo curve into the fewest red lines that
//! keep every attack within the chosen drift: longest grids back to back,
//! with the count-against-drift trade-off beside them so `--drift` is
//! chosen seeing prices, and `--max-lines` caps the count by taking the
//! cheapest drift that fits. It exits 0 with the lines even on constant
//! tempo (one line); only audio too short to fit on refuses, with a note.
//!
//! Exit codes: 0 a grid was found (for `structure`, the audio was read; for
//! `ramps`, the lines were fitted); 3 the engine refused (no grid in this
//! audio, reason on stderr and in `diagnostics`); 1 a file could not be
//! loaded; 2 the command line is wrong.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use overtone_core::Diagnostic;
use serde_json::{json, Value};

const USAGE: &str = "usage: overtone-cli analyze <audio> [--json | --full] [--decimals N] \
[--min-delta BPM] [--persistence BEATS] [--min-confidence C] [--no-map-bpm]\n       \
overtone-cli structure <audio>\n       \
overtone-cli ramps <audio> [--drift <ms>] [--max-lines <n>] [--decimals <n>]";

/// The v3 CLI's defaults, which the golden vectors were dumped with.
struct Options {
    audio: PathBuf,
    json: bool,
    full: bool,
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
        full: false,
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
            "--full" => {
                options.json = true;
                options.full = true;
            }
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
                "period_s": s.period,
                "phase_s": s.phase,
                "residual_ms": s.residual_ms,
                "coverage": s.coverage,
                "inliers": s.inliers,
            })).collect::<Vec<_>>(),
            "diagnostics": out.diagnostics.iter().map(diagnostic_json).collect::<Vec<_>>(),
            "version": overtone_tempo::VERSION,
            "timings_s": {"decode": decode_s, "attacks": attacks_s, "tempo": tempo_s},
        });
        let mut report = report;
        if options.full {
            report["evidence"] = json!({
                "hop": overtone_core::FIT_HOP,
                "sample_rate": sr,
                "onset": env,
                "attack_times": times,
                "attack_weights": weights,
                "beats": out.beats,
                "local_bpms": out.local_bpms,
                "meter_beats": out.meter_beats,
                "downbeat_class": out.downbeat,
                "points": out.points.iter().map(|p| json!({
                    "offset_ms": p.offset.get(),
                    "bpm": p.bpm.get(),
                    "confidence": p.confidence,
                    "section": p.section,
                    "meter": p.meter,
                    "meter_known": p.meter_known,
                })).collect::<Vec<_>>(),
            });
        }
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

fn kind_name(kind: overtone_dsp::classify::SectionKind) -> &'static str {
    use overtone_dsp::classify::SectionKind;
    match kind {
        SectionKind::Intro => "intro",
        SectionKind::Verse => "verse",
        SectionKind::Chorus => "chorus",
        SectionKind::Bridge => "bridge",
        SectionKind::Outro => "outro",
    }
}

/// `structure <audio>`: phrases, labels with their evidence, and the energy
/// lane, as JSON. Exit 1 when the audio cannot be read, 2 on a bad command.
fn structure(args: &[String]) -> ExitCode {
    use overtone_dsp::{classify as c, structure as s};
    let audio = match args {
        [path] if !path.starts_with("--") => PathBuf::from(path),
        _ => {
            eprintln!("overtone-cli: structure takes one audio file\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let started = Instant::now();
    let (y, sr) = match overtone_audio::load(&audio) {
        Ok(loaded) => loaded,
        Err(e) => {
            eprintln!("overtone-cli: cannot load {}: {e}", audio.display());
            println!(
                "{}",
                json!({"source": source(&audio), "error": e.to_string()})
            );
            return ExitCode::from(1);
        }
    };
    let decode_s = started.elapsed().as_secs_f64();
    let started = Instant::now();
    let found = s::phrases(&y, sr);
    let structure_s = started.elapsed().as_secs_f64();
    let started = Instant::now();
    let sections = c::classify(&y, sr, &found.boundaries);
    let classify_s = started.elapsed().as_secs_f64();
    let report = json!({
        "source": source(&audio),
        "duration": y.len() as f64 / sr as f64,
        "boundaries": found.boundaries,
        "sections": sections.iter().map(|x| json!({
            "start_s": x.start,
            "end_s": x.end,
            "kind": kind_name(x.kind),
            "group": x.group,
            "repeats": x.repeats,
            "level_db": x.level_db,
        })).collect::<Vec<_>>(),
        "energy": found.energy,
        "energy_hop": found.energy_hop,
        "rules": {
            "window_s": s::WIN_S,
            "edge_blind_s": s::KERNEL_HALF as f64 * s::WIN_S,
            "merge_s": s::MERGE_S,
            "embed_s": s::EMBED_S,
            "neighbours": s::NEIGHBOURS,
            "smooth_time_s": s::SMOOTH_TIME_S,
            "median_s": s::MEDIAN_S,
            "edge_over_median": s::EDGE_OVER_MEDIAN,
            "repeat_cosine": c::REPEAT_COSINE,
            "split_power_ratio": c::SPLIT_POWER_RATIO,
            "intro_max_s": c::INTRO_MAX_S,
        },
        "version": overtone_tempo::VERSION,
        "timings_s": {"decode": decode_s, "structure": structure_s, "classify": classify_s},
    });
    println!("{report}");
    eprintln!(
        "overtone-cli: {} sections; structure {structure_s:.2} s + classify {classify_s:.2} s",
        sections.len()
    );
    ExitCode::SUCCESS
}

fn source(path: &Path) -> String {
    path.display().to_string()
}

/// `ramps <audio>`: the elastic curve as the fewest red lines within the
/// drift, with the trade-off beside them. Exit 1 when the audio cannot be
/// read, 2 on a bad command, 3 when too few attacks fit anything.
fn ramps(args: &[String]) -> ExitCode {
    let mut audio: Option<PathBuf> = None;
    let mut drift_ms = 5.0;
    let mut max_lines: Option<usize> = None;
    let mut decimals = 0u32;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let value = |rest: &mut std::slice::Iter<String>, flag: &str| {
            rest.next().cloned().ok_or_else(|| format!("{flag} needs a value"))
        };
        let bad_number = |flag: &str, text: &str| {
            eprintln!("overtone-cli: {flag} expects a number, got {text:?}\n{USAGE}");
            true
        };
        match arg.as_str() {
            "--drift" => {
                let text = match value(&mut rest, arg) {
                    Ok(text) => text,
                    Err(message) => {
                        eprintln!("overtone-cli: {message}\n{USAGE}");
                        return ExitCode::from(2);
                    }
                };
                drift_ms = match text.parse() {
                    Ok(v) => v,
                    Err(_) => {
                        bad_number(arg, &text);
                        return ExitCode::from(2);
                    }
                };
                if !(drift_ms > 0.0) {
                    eprintln!("overtone-cli: --drift takes a positive number of ms\n{USAGE}");
                    return ExitCode::from(2);
                }
            }
            "--max-lines" => {
                let text = match value(&mut rest, arg) {
                    Ok(text) => text,
                    Err(message) => {
                        eprintln!("overtone-cli: {message}\n{USAGE}");
                        return ExitCode::from(2);
                    }
                };
                max_lines = match text.parse::<usize>() {
                    Ok(v) => Some(v),
                    Err(_) => {
                        bad_number(arg, &text);
                        return ExitCode::from(2);
                    }
                };
                if max_lines == Some(0) {
                    eprintln!("overtone-cli: --max-lines takes 1 or more\n{USAGE}");
                    return ExitCode::from(2);
                }
            }
            "--decimals" => {
                let text = match value(&mut rest, arg) {
                    Ok(text) => text,
                    Err(message) => {
                        eprintln!("overtone-cli: {message}\n{USAGE}");
                        return ExitCode::from(2);
                    }
                };
                decimals = match text.parse() {
                    Ok(v) => v,
                    Err(_) => {
                        bad_number(arg, &text);
                        return ExitCode::from(2);
                    }
                };
                if decimals > 6 {
                    eprintln!("overtone-cli: --decimals goes up to 6\n{USAGE}");
                    return ExitCode::from(2);
                }
            }
            flag if flag.starts_with("--") => {
                eprintln!("overtone-cli: unknown option {flag}\n{USAGE}");
                return ExitCode::from(2);
            }
            path => {
                if audio.replace(PathBuf::from(path)).is_some() {
                    eprintln!("overtone-cli: ramps takes one audio file\n{USAGE}");
                    return ExitCode::from(2);
                }
            }
        }
    }
    let Some(audio) = audio else {
        eprintln!("overtone-cli: ramps takes one audio file\n{USAGE}");
        return ExitCode::from(2);
    };
    let song = match analyse_audio(&audio) {
        Ok(song) => song,
        Err(e) => {
            eprintln!("overtone-cli: cannot load {}: {e}", audio.display());
            println!("{}", json!({"source": source(&audio), "error": e}));
            return ExitCode::from(1);
        }
    };
    let started = Instant::now();
    let fitted = overtone_tempo::elastic::fit(&song.times, &song.weights);
    let elastic_s = started.elapsed().as_secs_f64();
    let Some((elastic, report)) = fitted else {
        println!(
            "{}",
            json!({"source": source(&audio), "lines": [],
                   "error": "too few attacks to fit a curve on"})
        );
        return ExitCode::from(3);
    };
    let started = Instant::now();
    let table = {
        let (times, indices, weights) = overtone_tempo::ramps::strong(&song.times, &report.beat_indices, &song.weights);
        overtone_tempo::ramps::tradeoff(&times, &indices, &weights)
    };
    let mut drift_ms = drift_ms;
    if let Some(cap) = max_lines {
        // The cheapest drift whose count fits the cap; past the table's
        // coarsest rung the count stands, and the lines say which rung won.
        if let Some(&(rung, _)) = table.iter().find(|&&(_, count)| count <= cap) {
            drift_ms = rung;
        }
    }
    let (times, indices, weights) =
        overtone_tempo::ramps::strong(&song.times, &report.beat_indices, &song.weights);
    let lines = overtone_tempo::ramps::segment(&times, &indices, &weights, drift_ms);
    let ramps_s = started.elapsed().as_secs_f64();
    let factor = 10f64.powi(decimals as i32);
    let line_json = |line: &overtone_tempo::ramps::RampLine| {
        json!({
            "offset_s": line.offset_s,
            "offset_ms": (line.offset_s * 1000.0 * factor).round() / factor,
            "bpm": line.bpm,
            "start_k": line.start_k,
            "end_k": line.end_k,
            "max_drift_ms": line.max_drift_ms,
            "attacks": line.attacks,
        })
    };
    let report_json = json!({
        "source": source(&audio),
        "duration": song.y.len() as f64 / song.sr as f64,
        "drift_ms": drift_ms,
        "attacks": song.times.len(),
        "strong_attacks": times.len(),
        "lines": lines.iter().map(line_json).collect::<Vec<_>>(),
        "tradeoff": table.iter().map(|&(rung, count)| json!({"drift_ms": rung, "lines": count})).collect::<Vec<_>>(),
        "elastic": {
            "degree": elastic.degree(),
            "rms_ms": report.rms_ms,
            "bpm_first": report.curve_bpm_first,
            "bpm_last": report.curve_bpm_last,
        },
        "piecewise": {
            "sections": song.out.settled_sections.len(),
            "residual_ms": song.out.fit_residual_ms,
        },
        "recommend_ramps": overtone_tempo::ramps::recommend(
            elastic.degree(), report.rms_ms,
            song.out.settled_sections.len(), song.out.fit_residual_ms),
        "version": overtone_tempo::VERSION,
        "timings_s": {"decode": song.decode_s, "attacks": song.attacks_s, "tempo": song.tempo_s,
                      "structure": song.structure_s, "elastic": elastic_s, "ramps": ramps_s},
    });
    println!("{report_json}");
    eprintln!(
        "overtone-cli: {} red lines within {drift_ms} ms; elastic {elastic_s:.2} s + ramps {ramps_s:.2} s",
        lines.len()
    );
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("structure") {
        return structure(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("ramps") {
        return ramps(&args[1..]);
    }
    match parse(&args) {
        Ok(options) => analyze(&options),
        Err(message) => {
            eprintln!("overtone-cli: {message}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// Audio through attacks, tempo and structure: the front half of `ramps`,
/// timed per stage like `analyze`.
struct SongAnalysis {
    y: Vec<f32>,
    sr: u32,
    times: Vec<f64>,
    weights: Vec<f32>,
    out: overtone_tempo::points::PipelineOutput,
    decode_s: f64,
    attacks_s: f64,
    tempo_s: f64,
    structure_s: f64,
}

fn analyse_audio(audio: &Path) -> Result<SongAnalysis, String> {
    let started = Instant::now();
    let (y, sr) = match overtone_audio::load(audio) {
        Ok(loaded) => loaded,
        Err(e) => return Err(e.to_string()),
    };
    let decode_s = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let (attacks, env) = overtone_dsp::detect_attacks_default(&y, sr);
    let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
    let weights: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
    let attacks_s = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let out = overtone_tempo::points::analyze_attacks(
        &times, &weights, &env, sr, 1.5, 12, true, 0.75,
    );
    let tempo_s = started.elapsed().as_secs_f64();

    // Nothing here reads the phrases any more, but the stage stays and is
    // timed: `ramps` reports its timings, and the report keeps its shape.
    let started = Instant::now();
    let _phrases = overtone_dsp::structure::analyze(&y, sr);
    let structure_s = started.elapsed().as_secs_f64();

    Ok(SongAnalysis {
        y,
        sr,
        times,
        weights,
        out,
        decode_s,
        attacks_s,
        tempo_s,
        structure_s,
    })
}
