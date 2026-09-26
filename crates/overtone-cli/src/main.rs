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
//! overtone-cli hitsound song.mp3 map.osu  # per object: the proposed sound
//!                       [--profile P.json] # with alternatives and terms (JSON)
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
//! `hitsound` proposes the sound of every object of a map: bank plus
//! additions per decidable point (circles, slider heads, repeats and tails,
//! spinner ends, holds), with the runner-up alternatives, their marginal
//! probabilities, the emission terms plus the incoming transition behind
//! each choice, and what was heard under it (the matched attack's three
//! likeliest instruments and its place in the bar; null over silence).
//! Slider ticks take nothing — the format has no field for them — and
//! bodies are left as they are; both are H5's to write. A tail follows the
//! object landing under it, if any, else stays bare. Volume and sample
//! index are not proposed: they are the mapper's, set by hand in H5.
//! `--profile` reads another profile file; the baked `balanced` one decides
//! otherwise.
//!
//! `ramps` turns the elastic tempo curve into the fewest red lines that
//! keep every attack within the chosen drift: longest grids back to back,
//! with the count-against-drift trade-off beside them so `--drift` is
//! chosen seeing prices, and `--max-lines` caps the count by taking the
//! cheapest drift that fits. It exits 0 with the lines even on constant
//! tempo (one line); only audio too short to fit on refuses, with a note.
//!
//! Exit codes: 0 a grid was found (for `structure`, the audio was read; for
//! `hitsound-evidence`, the evidence was printed; for `hitsound`, the map
//! was proposed; for `ramps`, the lines were fitted); 3
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
overtone-cli hitsound-evidence <audio>\n       \
overtone-cli hitsound <audio> <map.osu> [--profile <path>]\n       \
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

/// `hitsound <audio> <map.osu> [--profile <path>]`: the proposed sound of
/// every decidable point, with alternatives and the terms behind each
/// choice, as JSON. Exit 1 when the audio, the map or the profile cannot be
/// read, 2 on a bad command; 0 otherwise, grid or no grid.
fn hitsound(args: &[String]) -> ExitCode {
    use overtone_hitsound::{baked, emission as em, evidence as ev, map, profile::Profile, viterbi as vit};
    let mut rest = args.iter();
    let mut audio: Option<PathBuf> = None;
    let mut map_path: Option<PathBuf> = None;
    let mut profile_path: Option<PathBuf> = None;
    while let Some(arg) = rest.next() {
        if arg == "--profile" {
            match rest.next() {
                Some(path) => profile_path = Some(PathBuf::from(path)),
                None => {
                    eprintln!("overtone-cli: --profile needs a value\n{USAGE}");
                    return ExitCode::from(2);
                }
            }
        } else if arg.starts_with("--") {
            eprintln!("overtone-cli: unknown option {arg}\n{USAGE}");
            return ExitCode::from(2);
        } else if audio.is_none() {
            audio = Some(PathBuf::from(arg));
        } else if map_path.is_none() {
            map_path = Some(PathBuf::from(arg));
        } else {
            eprintln!("overtone-cli: hitsound takes one audio file and one map\n{USAGE}");
            return ExitCode::from(2);
        }
    }
    let (Some(audio), Some(map_path)) = (audio, map_path) else {
        eprintln!("overtone-cli: hitsound takes one audio file and one map\n{USAGE}");
        return ExitCode::from(2);
    };
    let fail = |message: String| {
        println!("{}", json!({"source": source(&audio), "map": source(&map_path), "error": message}));
        ExitCode::from(1)
    };
    let profile_text = match &profile_path {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) => return fail(format!("cannot read profile {}: {e}", path.display())),
        },
        None => include_str!("../../../profiles/balanced.json").to_string(),
    };
    let profile = match Profile::parse(&profile_text) {
        Ok(profile) => profile,
        Err(e) => return fail(e),
    };
    let song = match analyse_audio(&audio) {
        Ok(song) => song,
        Err(e) => {
            eprintln!("overtone-cli: cannot load {}: {e}", audio.display());
            return fail(format!("cannot load {}: {e}", audio.display()));
        }
    };
    let map_text = match std::fs::read(&map_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => return fail(format!("cannot read {}: {e}", map_path.display())),
    };
    let beatmap = map::parse(&map_text);

    let started = Instant::now();
    let templates = baked::templates();
    let rows = ev::evidence(
        &song.y, song.sr, &song.times, &song.weights,
        &song.out.settled_sections,
        &song.measures.iter().map(|&(_, downbeat, bar)| (downbeat, bar)).collect::<Vec<_>>(),
        &song.boundaries, &templates,
    );
    let evidence_s = started.elapsed().as_secs_f64();
    let ev_times: Vec<f64> = rows.iter().map(|row| row.time_s).collect();

    let started = Instant::now();
    let (units, is_tail) = units_of(&beatmap);
    let times_ms: Vec<f64> = units.iter().map(|unit| unit.time_ms).collect();
    let placed = map::bar_slots(&beatmap.timing, &times_ms);
    let default_bank = match beatmap.sample_set {
        2 => em::Bank::Soft,
        3 => em::Bank::Drum,
        _ => em::Bank::Normal,
    };
    // Chain units decide by Viterbi; tails follow the object under them.
    let chain: Vec<usize> = (0..units.len()).filter(|&i| !is_tail[i]).collect();
    let order = em::Candidate::all();
    let mut steps = Vec::with_capacity(chain.len());
    let mut matrices: Vec<Vec<f64>> = Vec::with_capacity(chain.len());
    let mut scored_rows: Vec<Vec<em::Scored>> = Vec::with_capacity(chain.len());
    let mut matched: Vec<Option<usize>> = Vec::with_capacity(chain.len());
    for (position, &i) in chain.iter().enumerate() {
        let unit = &units[i];
        let found = em::match_attack(&ev_times, unit.time_ms / 1000.0, 0.05);
        matched.push(found);
        let attack = found.map(|a| &rows[a]);
        let object = map::HitObject {
            x: 0,
            y: 0,
            time: unit.time_ms,
            new_combo: unit.new_combo,
            hit_sound: unit.hit_sound,
            kind: map::ObjectKind::Circle,
            sample: map::HitSample {
                normal_set: unit.normal_set,
                addition_set: 0,
                index: 0,
                volume: 0,
                file: String::new(),
            },
        };
        let scored = em::emission(&object, attack, default_bank, &profile);
        matrices.push(
            order
                .iter()
                .map(|wanted| {
                    scored.iter().find(|row| row.candidate == *wanted).map_or(f64::NEG_INFINITY, |row| row.score)
                })
                .collect(),
        );
        scored_rows.push(scored);
        let break_before = position > 0
            && song.boundaries.iter().any(|&edge| {
                edge * 1000.0 > units[chain[position - 1]].time_ms && edge * 1000.0 <= unit.time_ms
            });
        let bar_slot = match placed[i] {
            (bar, Some(slot), _) => Some((bar, slot)),
            _ => None,
        };
        steps.push(vit::Step {
            time_s: unit.time_ms / 1000.0,
            new_combo: unit.new_combo,
            bar_slot,
            phrase_break_before: break_before,
        });
    }
    let decisions = vit::decide(&matrices, &order, &steps, &profile);
    // Chain position per unit, so the output walk is linear, not quadratic.
    let mut position_of: Vec<Option<usize>> = vec![None; units.len()];
    for (position, &i) in chain.iter().enumerate() {
        position_of[i] = Some(position);
    }
    // Tails follow the decided object landing under them, if any.
    let mut tail_state: Vec<Option<usize>> = vec![None; units.len()];
    let mut tail_follows: Vec<Option<usize>> = vec![None; units.len()];
    for (position, &i) in chain.iter().enumerate() {
        tail_state[i] = Some(decisions[position].state);
    }
    for (i, unit) in units.iter().enumerate() {
        if !is_tail[i] {
            continue;
        }
        let under = chain
            .iter()
            .filter(|&&j| units[j].time_ms >= unit.time_ms && units[j].time_ms - unit.time_ms <= 50.0)
            .min_by(|&&a, &&b| {
                units[a].time_ms.total_cmp(&units[b].time_ms)
            });
        if let Some(&j) = under {
            tail_follows[i] = Some(j);
            tail_state[i] = tail_state[j];
        }
    }
    let decide_s = started.elapsed().as_secs_f64();

    let candidate_json = |state: usize| {
        let candidate = order[state];
        let names: Vec<&str> = candidate
            .additions
            .iter()
            .zip(["whistle", "finish", "clap"])
            .filter(|&(&present, _)| present)
            .map(|(_, name)| name)
            .collect();
        json!({"bank": candidate.bank.as_str(), "additions": names, "bits": em::Addition::bits(
            &candidate.additions.iter().zip([em::Addition::Whistle, em::Addition::Finish, em::Addition::Clap])
                .filter(|&(&present, _)| present).map(|(_, a)| a).collect::<Vec<_>>(),
        )})
    };
    let bare = order
        .iter()
        .position(|c| c.additions == [false, false, false] && c.bank == em::Bank::Normal)
        .expect("a bare normal candidate");
    // What the engine heard under a decided sound, for the explanation: the
    // matched attack's likeliest instruments and its place in the bar. Null
    // over silence, where only the prior spoke.
    let heard_json = |found: Option<usize>| match found {
        Some(a) => {
            let row = &rows[a];
            let mut classes: Vec<&ev::ClassEvidence> = row.classes.iter().collect();
            classes.sort_by(|x, y| y.probability.total_cmp(&x.probability));
            json!({
                "time_ms": row.time_s * 1000.0,
                "classes": classes.iter().take(3).map(|c| json!({
                    "class": c.class.as_str(), "probability": c.probability,
                })).collect::<Vec<_>>(),
                "division": row.role.division,
                "metrical_weight": row.role.metrical_weight,
            })
        }
        None => Value::Null,
    };
    let proposals: Vec<Value> = units
        .iter()
        .enumerate()
        .map(|(i, unit)| {
            let (state, probability, alternatives, terms, transition_in, follows, heard) =
                if is_tail[i] {
                    let follows = tail_follows[i].map(|j| json!(units[j].object));
                    match tail_state[i] {
                        Some(state) => (
                            state,
                            Value::Null,
                            Vec::new(),
                            Vec::new(),
                            Value::Null,
                            follows.unwrap_or(Value::Null),
                            Value::Null,
                        ),
                        None => (bare, Value::Null, Vec::new(), Vec::new(), Value::Null, Value::Null,
                                 Value::Null),
                    }
                } else {
                    let position = position_of[i].expect("chain covers it");
                    let decision = &decisions[position];
                    let winner = &scored_rows[position]
                        .iter()
                        .find(|row| row.candidate == order[decision.state])
                        .expect("every state scored");
                    let transition_in = if position == 0 {
                        Value::Null
                    } else {
                        json!(vit::transition(
                            decisions[position - 1].state,
                            decision.state,
                            &order,
                            &steps[position - 1],
                            &steps[position],
                            &profile,
                        ))
                    };
                    (
                        decision.state,
                        json!(decision.probability),
                        decision
                            .alternatives
                            .iter()
                            .map(|&(s, p)| {
                                let mut proposal = candidate_json(s);
                                proposal["probability"] = json!(p);
                                proposal
                            })
                            .collect::<Vec<_>>(),
                        winner
                            .terms
                            .iter()
                            .map(|&(name, value)| {
                                let mut term = serde_json::Map::with_capacity(1);
                                term.insert(name.to_string(), json!(value));
                                Value::Object(term)
                            })
                            .collect::<Vec<_>>(),
                        transition_in,
                        Value::Null,
                        heard_json(matched[position]),
                    )
                };
            let mut proposal = candidate_json(state);
            proposal["probability"] = probability;
            json!({
                "object": unit.object,
                "part": unit.part,
                "edge": unit.edge,
                "time_ms": unit.time_ms,
                "proposal": proposal,
                "alternatives": alternatives,
                "terms": terms,
                "transition_in": transition_in,
                "tail": is_tail[i],
                "follows": follows,
                "heard": heard,
            })
        })
        .collect();
    let report = json!({
        "source": source(&audio),
        "map": source(&map_path),
        "duration": song.y.len() as f64 / song.sr as f64,
        "units": proposals,
        "templates": "baked",
        "profile": profile_path.map(|p| source(&p)).unwrap_or_else(|| "balanced".to_string()),
        "version": overtone_tempo::VERSION,
        "timings_s": {"decode": song.decode_s, "attacks": song.attacks_s, "tempo": song.tempo_s,
                      "structure": song.structure_s, "evidence": evidence_s, "decide": decide_s},
    });
    println!("{report}");
    eprintln!(
        "overtone-cli: {} proposals; evidence {evidence_s:.2} s + decide {decide_s:.2} s",
        proposals.len()
    );
    ExitCode::SUCCESS
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
    if args.first().map(String::as_str) == Some("hitsound-evidence") {
        return hitsound_evidence(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("hitsound") {
        return hitsound(&args[1..]);
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

/// Audio through attacks, tempo and structure: the shared front half of
/// `hitsound-evidence` and `hitsound`, timed per stage like `analyze`.
struct SongAnalysis {
    y: Vec<f32>,
    sr: u32,
    times: Vec<f64>,
    weights: Vec<f32>,
    out: overtone_tempo::points::PipelineOutput,
    measures: Vec<(String, usize, usize)>,
    boundaries: Vec<f64>,
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
    let measures =
        overtone_tempo::points::section_measures(&out.settled_sections, &times, &weights);

    let started = Instant::now();
    let found = overtone_dsp::structure::analyze(&y, sr);
    let structure_s = started.elapsed().as_secs_f64();

    Ok(SongAnalysis {
        y,
        sr,
        times,
        weights,
        out,
        measures,
        boundaries: found.boundaries,
        decode_s,
        attacks_s,
        tempo_s,
        structure_s,
    })
}

/// One decidable point of a map: a circle, a slider edge, a spinner end or
/// a hold, with the sound it carries now.
#[derive(Clone)]
struct Unit {
    object: usize,
    part: &'static str,
    edge: Option<usize>,
    time_ms: f64,
    hit_sound: u8,
    normal_set: i64,
    new_combo: bool,
}

/// The decidable points of a parsed map, in time order with tail flags
/// beside them. The head always exists; repeats and the tail need a slider
/// span, and tails are flagged for the follow-under post-pass rather than
/// decided.
fn units_of(map: &overtone_hitsound::map::Beatmap) -> (Vec<Unit>, Vec<bool>) {
    use overtone_hitsound::map::ObjectKind;
    let mut paired: Vec<(Unit, bool)> = Vec::new();
    for (n, object) in map.objects.iter().enumerate() {
        let base = Unit {
            object: n,
            part: "circle",
            edge: None,
            time_ms: object.time,
            hit_sound: object.hit_sound,
            normal_set: object.sample.normal_set,
            new_combo: object.new_combo,
        };
        match &object.kind {
            ObjectKind::Circle => paired.push((base, false)),
            ObjectKind::Hold { .. } => paired.push((Unit { part: "hold", ..base.clone() }, false)),
            ObjectKind::Spinner { end_time } => {
                paired.push((Unit { part: "spinner_end", time_ms: *end_time, ..base.clone() }, false));
            }
            ObjectKind::Slider { slides, length, edge_sounds, edge_sets } => {
                let at_edge = |k: usize| {
                    (
                        edge_sounds.get(k).copied().unwrap_or(object.hit_sound),
                        edge_sets
                            .get(k)
                            .map(|&(normal, _)| normal)
                            .unwrap_or(object.sample.normal_set),
                    )
                };
                let (bits, normal) = at_edge(0);
                paired.push((
                    Unit { part: "head", edge: Some(0), hit_sound: bits, normal_set: normal, ..base.clone() },
                    false,
                ));
                if let Some(span) = overtone_hitsound::map::slider_span(
                    &map.timing,
                    map.slider_multiplier,
                    object.time,
                    *length,
                ) {
                    for k in 1..=*slides as usize {
                        let last = k == *slides as usize;
                        let (bits, normal) = at_edge(k);
                        paired.push((
                            Unit {
                                part: if last { "tail" } else { "repeat" },
                                edge: Some(k),
                                time_ms: object.time + k as f64 * span,
                                hit_sound: bits,
                                normal_set: normal,
                                new_combo: false,
                                ..base.clone()
                            },
                            last,
                        ));
                    }
                }
            }
            ObjectKind::Unparsed => {}
        }
    }
    paired.sort_by(|a, b| {
        a.0.time_ms
            .total_cmp(&b.0.time_ms)
            .then_with(|| a.0.object.cmp(&b.0.object))
    });
    paired.into_iter().unzip()
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
    let song = match analyse_audio(&audio) {
        Ok(song) => song,
        Err(e) => {
            eprintln!("overtone-cli: cannot load {}: {e}", audio.display());
            println!(
                "{}",
                json!({"source": source(&audio), "error": e})
            );
            return ExitCode::from(1);
        }
    };
    let SongAnalysis {
        y,
        sr,
        times,
        weights,
        out,
        measures,
        boundaries,
        decode_s,
        attacks_s,
        tempo_s,
        structure_s,
    } = song;
    let bars: Vec<(usize, usize)> =
        measures.iter().map(|&(_, downbeat, bar)| (downbeat, bar)).collect();

    let started = Instant::now();
    let templates = baked::templates();
    let rows = ev::evidence(
        &y,
        sr,
        &times,
        &weights,
        &out.settled_sections,
        &bars,
        &boundaries,
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
        "phrase_edges": boundaries,
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
