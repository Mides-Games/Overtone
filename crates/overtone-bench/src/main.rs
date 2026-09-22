//! Validate the Rust engine against the v3 Python implementation, stage by
//! stage, on the committed golden vectors.
//!
//! The accuracy benchmark asks "is this tool correct". This asks a different
//! and, during a port, more useful question: "does this compute what the
//! original computed". A port can reach the right BPM through a wrong envelope
//! and a compensating peak-picker, and only a stage-by-stage diff catches it.
//!
//! ```text
//! cargo run -p overtone-bench --release -- golden
//! cargo run -p overtone-bench --release -- golden --only edm-174 shuffle-96
//! ```
//!
//! Vectors come from `bench/golden/*.json`, produced by
//! `python bench/golden.py dump`. The tolerances are the ones documented
//! there: attacks within 0.05 ms.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// 0.05 ms. Tight enough that a different computation fails, loose enough to
/// survive float-order differences between a NumPy expression and a loop.
const ATTACK_TOL_S: f64 = 5e-5;
/// 1e-6 s of period at 340 ms per beat is about 0.0002 BPM. This is the
/// tolerance for a *fitted* grid, which is a real invariant.
const PERIOD_TOL_S: f64 = 1e-6;
/// Candidate periods are compared loosely, and the candidate *list* is not
/// gated on at all. It is not a real invariant.
///
/// The sweep's frequency resolution is `0.2/span`, and where two adjacent grid
/// points score almost equally, a difference in floating-point summation order
/// (NumPy dispatches the dot product to BLAS; this crate sums in attack order)
/// moves the peak to the neighbouring index. Measured across the corpus that
/// shifts a candidate period by up to 4e-5 s — under one grid step — and its
/// *phase* by ~9e-4 s, because phase is `arg(z)/(2*pi*f)` and a 0.001 Hz shift
/// accumulates over a 29 s window. Meanwhile the grid those candidates seed
/// still refines to within 1e-10 s of v3's on all 24 fixtures.
///
/// So what is gated is the property that actually has to hold: **the candidate
/// list contains the grid v3 went on to seed**. Peak indices are an
/// implementation detail of the sweep; the answer being in the list is not.
const CANDIDATE_REL_TOL: f64 = 5e-3;

#[derive(Deserialize)]
struct Golden {
    case: String,
    attacks: GoldenAttacks,
    #[serde(default)]
    candidates: Vec<GoldenGrid>,
    #[serde(default)]
    seeds: Vec<Option<GoldenGrid>>,
    #[serde(default)]
    octave: Option<GoldenOctave>,
    #[serde(default)]
    atom_sections: Vec<GoldenSection>,
    #[serde(default)]
    beat_sections: Vec<GoldenSection>,
    #[serde(default)]
    settled_sections: Vec<GoldenSection>,
    #[serde(default)]
    meter: Option<GoldenMeter>,
    #[serde(default)]
    result: GoldenResult,
}

/// v3's global meter reading on the first settled section.
#[derive(Deserialize, Default)]
struct GoldenMeter {
    #[serde(default)]
    meter: String,
    #[serde(default)]
    downbeat_class: usize,
    #[serde(default)]
    bar_beats: usize,
}

#[derive(Deserialize, Default)]
struct GoldenResult {
    #[serde(default)]
    points: Vec<GoldenPoint>,
}

/// One snapped red line as the Python dump writes it.
#[derive(Deserialize, Default)]
struct GoldenPoint {
    #[serde(default)]
    offset_ms: f64,
    #[serde(default)]
    bpm: f64,
}

/// One constant-tempo region as the Python dump writes it.
#[derive(Deserialize)]
struct GoldenSection {
    #[serde(default)]
    start_s: f64,
    #[serde(default)]
    end_s: f64,
    #[serde(default)]
    period_s: f64,
    #[serde(default)]
    phase_s: f64,
    #[serde(default)]
    bpm: f64,
    #[serde(default)]
    residual_ms: f64,
}

/// v3's octave decision. The accuracy benchmark normalises octaves away, so
/// this is the only thing that can catch a change to it — audit finding F-07.
#[derive(Deserialize)]
struct GoldenOctave {
    atoms_per_beat: usize,
    first_class: usize,
}

/// A period/phase pair as the Python dump writes it.
#[derive(Deserialize)]
struct GoldenGrid {
    period_s: f64,
    phase_s: f64,
}

#[derive(Deserialize)]
struct GoldenAttacks {
    count: usize,
    times_s: Vec<f64>,
    weights: Vec<f64>,
    envelope_frames: usize,
}

/// Boundaries become red lines, so a moved boundary is a moved red line.
/// 5 ms is the benchmark's own offset tolerance.
const BOUNDARY_TOL_S: f64 = 5e-3;

struct SectionDiff {
    name: &'static str,
    expected: usize,
    found: usize,
    worst_period_err: f64,
    worst_phase_ms: f64,
    worst_bpm_err: f64,
    worst_residual_err: f64,
    worst_boundary_err: f64,
}

impl SectionDiff {
    fn ok(&self) -> bool {
        self.expected == self.found
            && self.worst_period_err <= PERIOD_TOL_S
            && self.worst_phase_ms <= ATTACK_TOL_S * 1000.0
            && self.worst_bpm_err <= 1e-3
            && self.worst_residual_err <= 0.05
            && self.worst_boundary_err <= BOUNDARY_TOL_S
    }

    fn describe(&self) -> Option<String> {
        if self.expected != self.found {
            return Some(format!(
                "{}: {} sections -> {}",
                self.name, self.expected, self.found
            ));
        }
        let mut bits = Vec::new();
        if self.worst_period_err > PERIOD_TOL_S {
            bits.push(format!("period {:.2e}s off", self.worst_period_err));
        }
        if self.worst_phase_ms > ATTACK_TOL_S * 1000.0 {
            bits.push(format!("phase {:.4}ms off", self.worst_phase_ms));
        }
        if self.worst_bpm_err > 1e-3 {
            bits.push(format!("bpm {:.4} off", self.worst_bpm_err));
        }
        if self.worst_residual_err > 0.05 {
            bits.push(format!("residual {:.4}ms off", self.worst_residual_err));
        }
        if self.worst_boundary_err > BOUNDARY_TOL_S {
            bits.push(format!("boundary {:.3}s off", self.worst_boundary_err));
        }
        if bits.is_empty() {
            None
        } else {
            Some(format!("{}: {}", self.name, bits.join(", ")))
        }
    }
}

fn diff_sections(
    name: &'static str,
    got: &[overtone_core::GridSection],
    want: &[GoldenSection],
) -> SectionDiff {
    let mut diff = SectionDiff {
        name,
        expected: want.len(),
        found: got.len(),
        worst_period_err: 0.0,
        worst_phase_ms: 0.0,
        worst_bpm_err: 0.0,
        worst_residual_err: 0.0,
        worst_boundary_err: 0.0,
    };
    if got.len() != want.len() {
        return diff;
    }
    for (g, w) in got.iter().zip(want.iter()) {
        diff.worst_period_err = diff.worst_period_err.max((g.period - w.period_s).abs());
        diff.worst_phase_ms = diff
            .worst_phase_ms
            .max((g.phase - w.phase_s).abs() * 1000.0);
        let bpm = if g.period > 0.0 { 60.0 / g.period } else { 0.0 };
        diff.worst_bpm_err = diff.worst_bpm_err.max((bpm - w.bpm).abs());
        diff.worst_residual_err = diff
            .worst_residual_err
            .max((g.residual_ms - w.residual_ms).abs());
        diff.worst_boundary_err = diff
            .worst_boundary_err
            .max((g.start.get() - w.start_s).abs())
            .max((g.end.get() - w.end_s).abs());
    }
    diff
}

struct Report {
    case: String,
    decode_s: f64,
    analyse_s: f64,
    candidates: usize,
    seed_in_candidates: bool,
    octave_expected: usize,
    octave_found: usize,
    class_expected: usize,
    class_found: usize,
    seed_period_err: f64,
    seed_phase_ms: f64,
    expected: usize,
    found: usize,
    matched: usize,
    worst_ms: f64,
    worst_at: f64,
    env_frames_expected: usize,
    env_frames_found: usize,
    weight_correlation: f64,
    atom: SectionDiff,
    beat: SectionDiff,
    settled: SectionDiff,
    meter_diff: Option<String>,
    points_diff: Option<String>,
}

impl Report {
    fn ok(&self) -> bool {
        self.found == self.expected
            && self.matched == self.expected
            && self.worst_ms <= ATTACK_TOL_S * 1000.0
            && self.env_frames_found == self.env_frames_expected
            && self.seed_in_candidates
            && self.octave_found == self.octave_expected
            && self.class_found == self.class_expected
            && self.weight_correlation > 0.999
            && self.seed_period_err <= PERIOD_TOL_S
            && self.seed_phase_ms <= ATTACK_TOL_S * 1000.0
            && self.atom.ok()
            && self.beat.ok()
            && self.settled.ok()
            && self.meter_diff.is_none()
            && self.points_diff.is_none()
    }
}

/// Find the repository root by walking up for the things this tool needs.
///
/// Deliberately resolved at runtime. `CARGO_MANIFEST_DIR` is baked in at
/// compile time, so a binary built before the project folder was renamed went
/// looking for its fixtures under the old absolute path — which is exactly
/// what happened when this project was renamed to Overtone. Searching from the
/// working directory first, then from the executable, keeps the binary
/// relocatable and makes it work from any subdirectory.
fn repo_root() -> Result<PathBuf> {
    fn looks_like_root(dir: &Path) -> bool {
        dir.join("Cargo.toml").is_file() && dir.join("bench").join("golden").is_dir()
    }
    fn walk_up(start: &Path) -> Option<PathBuf> {
        let mut dir = Some(start);
        while let Some(current) = dir {
            if looks_like_root(current) {
                return Some(current.to_path_buf());
            }
            dir = current.parent();
        }
        None
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = walk_up(&cwd) {
            return Ok(root);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent().and_then(walk_up) {
            return Ok(root);
        }
    }
    // Last resort, and the one that breaks on a rename — so it is last.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent().and_then(Path::parent) {
        if looks_like_root(root) {
            return Ok(root.to_path_buf());
        }
    }
    bail!(
        "could not find the repository root (a directory with Cargo.toml and \
         bench/golden/) from {:?} or the executable's path",
        std::env::current_dir().ok()
    )
}

/// Pearson correlation. Weights are envelope heights, which carry the same
/// information in both implementations but not bit-identically once the
/// envelope has been through a different summation order.
fn correlation(a: &[f64], b: &[f64]) -> f64 {
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

fn check_case(root: &Path, name: &str) -> Result<Report> {
    let vector_path = root.join("bench/golden").join(format!("{name}.json"));
    let text = std::fs::read_to_string(&vector_path)
        .with_context(|| format!("reading {}", vector_path.display()))?;
    let golden: Golden = serde_json::from_str(&text)
        .with_context(|| format!("parsing {}", vector_path.display()))?;

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
    let analyse_s = started.elapsed().as_secs_f64();

    let ours: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
    let our_weights: Vec<f64> = attacks.iter().map(|a| a.weight as f64).collect();
    let our_w32: Vec<f32> = attacks.iter().map(|a| a.weight).collect();

    // Pair by nearest neighbour rather than by index: one extra or missing
    // attack should show up as a count mismatch, not as every later attack
    // appearing wildly wrong.
    let mut matched = 0usize;
    let mut worst_ms = 0.0f64;
    let mut worst_at = 0.0f64;
    for &want in &golden.attacks.times_s {
        let mut best = f64::INFINITY;
        for &got in &ours {
            let d = (got - want).abs();
            if d < best {
                best = d;
            }
        }
        if best <= ATTACK_TOL_S {
            matched += 1;
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
    let pipeline = overtone_tempo::points::analyze_attacks(
        &ours,
        &our_w32,
        &env,
        44_100,
        1.5,
        12,
        true,
        0.75,
    );
    let atom = diff_sections("atom_sections", &pipeline.atom_sections, &golden.atom_sections);
    let beat = diff_sections("beat_sections", &pipeline.beat_sections, &golden.beat_sections);
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
        for (got, want) in pipeline.points.iter().zip(golden.result.points.iter()) {
            worst_off = worst_off.max((got.offset.get() - want.offset_ms).abs());
            worst_bpm = worst_bpm.max((got.bpm.get() - want.bpm).abs());
        }
        if worst_off > 0.05 || worst_bpm > 1e-3 {
            points_diff = Some(format!(
                "points: worst offset {worst_off:.4}ms, worst bpm {worst_bpm:.6}"
            ));
        }
    }

    Ok(Report {
        case: golden.case,
        decode_s,
        analyse_s,
        candidates: got_candidates.len(),
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
        atom,
        beat,
        settled,
        meter_diff,
        points_diff,
    })
}

fn all_cases(root: &Path) -> Result<Vec<String>> {
    let dir = root.join("bench/golden");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .with_context(|| format!("listing {}", dir.display()))?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            (path.extension()? == "json")
                .then(|| path.file_stem()?.to_str().map(str::to_owned))
                .flatten()
        })
        .collect();
    names.sort();
    Ok(names)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("golden");
    let root = repo_root()?;
    if mode == "candidates" {
        // Debug aid: print the coherence candidates beside v3's, for one case.
        let name = args.get(1).context("usage: candidates <case>")?;
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
        println!("anchor {lo:.6}..{hi:.6}  span {span:.6}  attacks in window {}", wt.len());
        let got = overtone_tempo::coherence::candidates(&wt, &ww, 10);
        println!("{:<4} {:>14} {:>14} {:>10}   {:>14} {:>14}", "#", "v3 period", "rust period", "d period", "v3 phase", "rust phase");
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
                want.map(|c| format!("{:.9}", c.period_s)).unwrap_or_else(|| "-".into()),
                mine.map(|c| format!("{:.9}", c.period)).unwrap_or_else(|| "-".into()),
                dp,
                want.map(|c| format!("{:.7}", c.phase_s)).unwrap_or_else(|| "-".into()),
                mine.map(|c| format!("{:.7}", c.phase)).unwrap_or_else(|| "-".into()),
            );
        }
        return Ok(());
    }
    if mode != "golden" {
        bail!("usage: overtone-bench golden [--only CASE...] | candidates <case>");
    }
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
    println!("Tolerance: attacks within {:.3} ms.\n", ATTACK_TOL_S * 1000.0);
    println!(
        "{:<18} {:>8} {:>8} {:>10} {:>3} {:>10} {:>7} {:>8}  verdict",
        "case", "attacks", "matched", "worst", "in", "seed dP", "octave", "analyse"
    );
    println!("{}", "-".repeat(92));

    let mut failures = 0usize;
    let mut total_decode = 0.0f64;
    let mut total_analyse = 0.0f64;
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
                    if report.matched != report.expected {
                        why.push(format!(
                            "{} unmatched",
                            report.expected.saturating_sub(report.matched)
                        ));
                    }
                    format!("DIFF: {} (worst at {:.3}s)", why.join(", "), report.worst_at)
                };
                total_decode += report.decode_s;
                total_analyse += report.analyse_s;
                println!(
                    "{:<18} {:>8} {:>8} {:>8.4}ms {:>3} {:>10.2e} {:>7} {:>7.3}s  {verdict}",
                    report.case,
                    report.expected,
                    report.matched,
                    report.worst_ms,
                    if report.seed_in_candidates { "y" } else { "N" },
                    report.seed_period_err,
                    format!("{}/{}", report.octave_found, report.octave_expected),
                    report.analyse_s,
                );
            }
            Err(e) => {
                failures += 1;
                println!("{name:<18}  ERROR: {e:#}");
            }
        }
    }

    println!();
    println!(
        "decode {total_decode:.2}s + analyse {total_analyse:.2}s = {:.2}s of real work",
        total_decode + total_analyse
    );
    if failures == 0 {
        println!("{}/{} cases match the v3 engine attack for attack.", names.len(), names.len());
        Ok(())
    } else {
        println!("{failures}/{} cases diverge.", names.len());
        bail!("golden-vector check failed");
    }
}
