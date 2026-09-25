//! `overtone-cli`: the v4 engine behind one command, for the app to run as a
//! sidecar (roadmap Phase 22) and for scripts.
//!
//! ```text
//! overtone-cli analyze song.mp3              # [TimingPoints] lines
//! overtone-cli analyze song.mp3 --json       # v3's report shape
//! overtone-cli analyze song.mp3 --decimals 3 # lazer keeps fractional ms
//! overtone-cli analyze song.mp3 --full       # + the evidence an app needs
//! overtone-cli structure song.mp3            # phrases, labels, energy (JSON)
//! overtone-cli hitsound-evidence song.mp3  # per attack: class probabilities
//!                                          # with each term's contribution,
//!                                          # and its musical role (JSON)
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
//! `structure` prints phrase boundaries, the section labels with the evidence
//! each rests on (repetition group, repeats, level), and the energy lane
//! behind them. It is tempoless, as the DSP crate is: boundaries sit on the
//! 0.5 s feature grid, and snapping them to downbeats is the caller's job,
//! since the caller holds the grid.
//!
//! `hitsound-evidence` prints what the hitsound decision (H4) gets about
//! every attack: the 13 class probabilities with each term's contribution
//! (feature, value, response shape, fitted weight behind it), and the
//! attack's musical role (grid slot, metrical weight, phrase position,
//! accent, density). The weights are the baked calibrated fit, loaded in
//! under a millisecond. It exits 0 even when the tempo engine finds no
//! grid: the instrument half never needed one, and the role degrades to
//! nulls where there is no grid to sit on.
//!
//! Exit codes: 0 a grid was found (for `structure`, the audio was read; for
//! `hitsound-evidence`, the evidence was printed); 3
//! the engine refused (no grid in this audio, reason on stderr and in
//! `diagnostics`); 1 the file could not be loaded; 2 the command line is
//! wrong.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use overtone_core::Diagnostic;
use serde_json::{json, Value};

const USAGE: &str = "usage: overtone-cli analyze <audio> [--json | --full] [--decimals N] \
[--min-delta BPM] [--persistence BEATS] [--min-confidence C] [--no-map-bpm]\n       \
overtone-cli structure <audio>\n       \
overtone-cli hitsound-evidence <audio>";

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
    let found = s::analyze(&y, sr);
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

/// `hitsound-evidence <audio>`: per-attack class probabilities with each
/// term's contribution, and the attack's role, as JSON. Exit 1 when the
/// audio cannot be read, 2 on a bad command; 0 otherwise, grid or no grid.
fn hitsound_evidence(args: &[String]) -> ExitCode {
    use overtone_hitsound::{baked, evidence as ev};
    let audio = match args {
        [path] if !path.starts_with("--") => PathBuf::from(path),
        _ => {
            eprintln!("overtone-cli: hitsound-evidence takes one audio file\n{USAGE}");
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
    let (attacks, env) = overtone_dsp::detect_attacks_default(&y, sr);
    let times: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
    let weights: Vec<f32> = attacks.iter().map(|a| a.weight).collect();
    let attacks_s = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let out = overtone_tempo::points::analyze_attacks(
        &times, &weights, &env, sr, 1.5, 12, true, 0.75,
    );
    let tempo_s = started.elapsed().as_secs_f64();
    let measures =
        overtone_tempo::points::section_measures(&out.settled_sections, &times, &weights);
    let bars: Vec<(usize, usize)> =
        measures.iter().map(|&(_, downbeat, bar)| (downbeat, bar)).collect();

    let started = Instant::now();
    let found = overtone_dsp::structure::analyze(&y, sr);
    let structure_s = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let templates = baked::templates();
    let rows = ev::evidence(
        &y,
        sr,
        &times,
        &weights,
        &out.settled_sections,
        &bars,
        &found.boundaries,
        &templates,
    );
    let evidence_s = started.elapsed().as_secs_f64();

    let role_json = |role: &overtone_hitsound::role::Role| {
        json!({
            "division": role.division,
            "grid_residual_ms": role.grid_residual_ms,
            "metrical_weight": role.metrical_weight,
            "bars_since_phrase_start": role.bars_since_phrase_start,
            "bars_to_phrase_end": role.bars_to_phrase_end,
            "section_boundary_s": role.section_boundary_s,
            "local_energy": role.local_energy,
            "accent": role.accent,
            "density": role.density,
        })
    };
    let report = json!({
        "source": source(&audio),
        "duration": y.len() as f64 / sr as f64,
        "attacks": rows.iter().map(|row| json!({
            "time_s": row.time_s,
            "weight": row.weight,
            "role": role_json(&row.role),
            "classes": row.classes.iter().map(|class| json!({
                "class": class.class.as_str(),
                "probability": class.probability,
                "score": class.score,
                "terms": class.terms.iter().map(|term| {
                    let (kind, knots) = term.response.describe();
                    json!({
                        "feature": term.feature.as_str(),
                        "value": term.value,
                        "response": {"kind": kind, "knots": knots},
                        "contribution": term.contribution,
                    })
                }).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "sections": out.settled_sections.iter().zip(measures.iter()).map(|(s, m)| json!({
            "start_s": s.start.get(),
            "end_s": s.end.get(),
            "period_s": s.period,
            "phase_s": s.phase,
            "downbeat": m.1,
            "beats_per_bar": m.2,
        })).collect::<Vec<_>>(),
        "phrase_edges": found.boundaries,
        "templates": "baked",
        "version": overtone_tempo::VERSION,
        "timings_s": {"decode": decode_s, "attacks": attacks_s, "tempo": tempo_s,
                      "structure": structure_s, "evidence": evidence_s},
    });
    println!("{report}");
    eprintln!(
        "overtone-cli: {} attacks with evidence; attacks {attacks_s:.2} s + tempo {tempo_s:.2} s + structure {structure_s:.2} s + evidence {evidence_s:.2} s",
        rows.len()
    );
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("structure") {
        return structure(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("hitsound-evidence") {
        return hitsound_evidence(&args[1..]);
    }
    match parse(&args) {
        Ok(options) => analyze(&options),
        Err(message) => {
            eprintln!("overtone-cli: {message}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
