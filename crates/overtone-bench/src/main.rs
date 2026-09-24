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
//! cargo run -p overtone-bench --release -- structure long-6min
//! cargo run -p overtone-bench --release -- resample
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
    #[serde(default)]
    fit_residual_ms: f64,
    #[serde(default)]
    global_bpm: f64,
}

/// One snapped red line as the Python dump writes it.
#[derive(Deserialize, Default)]
struct GoldenPoint {
    #[serde(default)]
    offset_ms: f64,
    #[serde(default)]
    bpm: f64,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    meter: usize,
    #[serde(default)]
    meter_known: bool,
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
    inliers: usize,
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
    /// Sum of v3's onset envelope, to 4 decimals.
    envelope_sum: f64,
}

/// The envelope itself, which the gate used to dump but never read: correlation
/// on the weights alone passed a symmetric Hann window that moves the sum by
/// 0.6-7.1. Measured float noise against v3's float32 sum: at most 0.00098
/// (long-6min), 0.00033 on every other fixture.
const ENV_SUM_TOL: f64 = 2e-3;
/// Each matched attack's weight against v3's, stored to 5 decimals: measured
/// at most 5.4e-6, the rounding itself. Correlation alone allowed ~1.5 %.
const WEIGHT_TOL: f64 = 2e-5;

/// Boundaries become red lines, so a moved boundary is a moved red line.
/// 5 ms is the benchmark's own offset tolerance.
const BOUNDARY_TOL_S: f64 = 5e-3;

/// A grown region ends on an attack time where a tempo step falls on its
/// edge (secs-3, three-sections, change-128-142), and whether `t <= end`
/// keeps that attack is a float tie: v3 drops it, Rust keeps it. One count;
/// before growth counted the refinement's own mask it was up to 62.
const INLIER_TOL: usize = 1;

struct SectionDiff {
    name: &'static str,
    expected: usize,
    found: usize,
    worst_period_err: f64,
    worst_phase_ms: f64,
    worst_bpm_err: f64,
    worst_residual_err: f64,
    worst_boundary_err: f64,
    /// Attacks on the grid, counted as v3 counts them at that stage. Never
    /// compared until the audit found growth counting another way.
    worst_inliers_err: usize,
}

impl SectionDiff {
    fn ok(&self) -> bool {
        self.expected == self.found
            && self.worst_period_err <= PERIOD_TOL_S
            && self.worst_phase_ms <= ATTACK_TOL_S * 1000.0
            && self.worst_bpm_err <= 1e-3
            && self.worst_residual_err <= 0.05
            && self.worst_boundary_err <= BOUNDARY_TOL_S
            && self.worst_inliers_err <= INLIER_TOL
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
        if self.worst_inliers_err > INLIER_TOL {
            bits.push(format!("inliers off by {}", self.worst_inliers_err));
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
        worst_inliers_err: 0,
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
        diff.worst_inliers_err = diff.worst_inliers_err.max(g.inliers.abs_diff(w.inliers));
    }
    diff
}

struct Report {
    case: String,
    decode_s: f64,
    /// Attack detection (envelope, peaks, re-timing).
    attacks_s: f64,
    /// The tempo pipeline: seed, octave, sections, meter, points.
    tempo_s: f64,
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
    /// |sum of our envelope - v3's|.
    env_sum_err: f64,
    /// Largest |our weight - v3's| over matched attacks.
    worst_weight_err: f64,
    atom: SectionDiff,
    beat: SectionDiff,
    settled: SectionDiff,
    meter_diff: Option<String>,
    points_diff: Option<String>,
    global_bpm_err: f64,
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
            && self.env_sum_err <= ENV_SUM_TOL
            && self.worst_weight_err <= WEIGHT_TOL
            && self.seed_period_err <= PERIOD_TOL_S
            && self.seed_phase_ms <= ATTACK_TOL_S * 1000.0
            && self.atom.ok()
            && self.beat.ok()
            && self.settled.ok()
            && self.meter_diff.is_none()
            && self.points_diff.is_none()
            && self.global_bpm_err <= 1e-3
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
    let attacks_s = started.elapsed().as_secs_f64();

    let ours: Vec<f64> = attacks.iter().map(|a| a.time.get()).collect();
    let our_weights: Vec<f64> = attacks.iter().map(|a| a.weight as f64).collect();
    let our_w32: Vec<f32> = attacks.iter().map(|a| a.weight).collect();

    // Pair by nearest neighbour rather than by index: one extra or missing
    // attack should show up as a count mismatch, not as every later attack
    // appearing wildly wrong.
    let mut matched = 0usize;
    let mut worst_ms = 0.0f64;
    let mut worst_at = 0.0f64;
    let mut worst_weight_err = 0.0f64;
    for (want, &want_weight) in golden.attacks.times_s.iter().zip(&golden.attacks.weights) {
        let want = *want;
        let mut best = f64::INFINITY;
        let mut nearest = 0usize;
        for (i, &got) in ours.iter().enumerate() {
            let d = (got - want).abs();
            if d < best {
                best = d;
                nearest = i;
            }
        }
        if best <= ATTACK_TOL_S {
            matched += 1;
            worst_weight_err = worst_weight_err.max((our_weights[nearest] - want_weight).abs());
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
    let started = std::time::Instant::now();
    let pipeline =
        overtone_tempo::points::analyze_attacks(&ours, &our_w32, &env, 44_100, 1.5, 12, true, 0.75);
    let tempo_s = started.elapsed().as_secs_f64();
    let atom = diff_sections(
        "atom_sections",
        &pipeline.atom_sections,
        &golden.atom_sections,
    );
    let beat = diff_sections(
        "beat_sections",
        &pipeline.beat_sections,
        &golden.beat_sections,
    );
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
        let mut worst_conf = 0.0f64;
        let mut meters_differ = 0usize;
        for (got, want) in pipeline.points.iter().zip(golden.result.points.iter()) {
            worst_off = worst_off.max((got.offset.get() - want.offset_ms).abs());
            worst_bpm = worst_bpm.max((got.bpm.get() - want.bpm).abs());
            // Confidence and the proven bar were never compared: a red line
            // could lose its bar, or its confidence, with the gate green.
            worst_conf = worst_conf.max((got.confidence - want.confidence).abs());
            if got.meter as usize != want.meter || got.meter_known != want.meter_known {
                meters_differ += 1;
            }
        }
        if worst_off > 0.05 || worst_bpm > 1e-3 || worst_conf > 1e-3 || meters_differ > 0 {
            points_diff = Some(format!(
                "points: worst offset {worst_off:.4}ms, worst bpm {worst_bpm:.6},                  worst confidence {worst_conf:.5}, {meters_differ} meter(s) differ"
            ));
        }
    }

    // Duration-weighted global BPM, as `_assemble_analysis` reduces it.
    let global_bpm_err = (pipeline.global_bpm - golden.result.global_bpm).abs();

    Ok(Report {
        case: golden.case,
        decode_s,
        attacks_s,
        tempo_s,
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
        env_sum_err: (env.iter().map(|&v| v as f64).sum::<f64>() - golden.attacks.envelope_sum)
            .abs(),
        worst_weight_err,
        atom,
        beat,
        settled,
        meter_diff,
        points_diff,
        global_bpm_err,
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

/// (change time, ratio) of the exact 2x relationships the detector should find.
/// The three coverage cases live outside the 24-case corpus so the published
/// numbers stay comparable; `change-175-87.5` is in it.
fn density_truth(name: &str) -> Option<(f64, f64)> {
    match name {
        "halftime-175-87.5" => Some((32.0, 0.5)),
        "halftime-150-75" => Some((28.0, 0.5)),
        "doubletime-110-220" => Some((26.0, 2.0)),
        "change-175-87.5" => Some((32.0, 0.5)),
        _ => None,
    }
}

/// Golden fixtures whose beat tempo steps with the time signature over a
/// constant bar (300 -> 150 -> 200 BPM in beats). The density and map gates
/// have no truth for them, and read those real steps as false changes; the
/// signatures gate judges them. Added with the proven-bar golden fixtures,
/// they made both gates fail until this list existed.
const SIGNATURE_FIXTURES: [&str; 1] = ["signature-changes"];

/// Density cases rendered outside the 24-case corpus.
const DENSITY_EXTRAS: [&str; 3] = ["halftime-175-87.5", "halftime-150-75", "doubletime-110-220"];
/// Real density changes the density gate is documented to find (4/4).
const DENSITY_TRUTH_CASES: usize = 4;

/// The command that renders a bench fixture (bench/audio/ is not committed).
fn render_hint(name: &str) -> &'static str {
    if name.starts_with("ramp-") {
        "render it with `python proto/elastic.py`"
    } else if DENSITY_EXTRAS.contains(&name) {
        "render it with `python bench/gates.py coverage`"
    } else if name.starts_with('_') {
        "render it with `python bench/benchmark.py`"
    } else {
        "render it with `python bench/golden.py dump`"
    }
}

/// Resampling speed, which no other mode sees: every fixture is already
/// 44.1 kHz, so the resampler never runs in them. Six minutes of a
/// three-tone signal at each common source rate, converted to 44.1 kHz.
fn resample_mode() -> Result<()> {
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
fn structure_mode(root: &Path, name: &str) -> Result<()> {
    let audio = root.join("bench/audio").join(format!("{name}.wav"));
    if !audio.is_file() {
        bail!("{name} is missing -- {}", render_hint(name));
    }
    let started = std::time::Instant::now();
    let (y, sr) = overtone_audio::load(&audio).map_err(|e| anyhow::anyhow!("{e}"))?;
    let decode_s = started.elapsed().as_secs_f64();
    let started = std::time::Instant::now();
    let structure = overtone_dsp::structure::analyze(&y, sr);
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

fn density_mode(root: &Path, only: &[String]) -> Result<()> {
    let mut names = all_cases(root)?;
    // Required, not optional: skipped when absent, they let the gate pass
    // with nothing measured (bench/audio/ is not committed).
    for extra in DENSITY_EXTRAS {
        if !names.contains(&extra.to_string()) {
            names.push(extra.to_string());
        }
    }
    names.sort();
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
        if SIGNATURE_FIXTURES.contains(&name.as_str()) {
            println!("{name:<20}  (signature steps: judged by `gates.py signatures`)");
            continue;
        }
        let audio = root.join("bench/audio").join(format!("{name}.wav"));
        if !audio.is_file() {
            println!("{name:<20}  MISSING — {}", render_hint(name));
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

/// Genuine tempo ramps: (start BPM, end BPM, duration s, hard gate). v3
/// falls back to the tracker here (an 8-section staircase on the first one).
/// The extreme ramp is reported, not gated: the prototype misses its own
/// median bound there too (1.387 > 1.0) — it needs the §B.1 spline, and the
/// honest gate says so instead of pretending.
fn elastic_ramps() -> Vec<(&'static str, f64, f64, f64, bool)> {
    vec![
        ("ramp-120-160", 120.0, 160.0, 60.0, true),
        ("ramp-180-140", 180.0, 140.0, 60.0, true),
        ("ramp-90-200", 90.0, 200.0, 75.0, false),
    ]
}

/// Cases whose tempo genuinely moves, so the elastic model is allowed to
/// bend there. Everywhere else drift over 1 % is inventing curvature.
fn elastic_may_bend(name: &str) -> bool {
    matches!(name, "secs-4" | "tiny-change")
}

/// Step-tempo fixtures. The degree digit there is cliff dynamics (a 15 %
/// gain rule the reference itself sits ~3 % from), so what is gated is the
/// property both implementations share: the elastic residual stays two
/// orders of magnitude above the piecewise one, and the selector keeps v3.
fn elastic_is_steps(name: &str) -> bool {
    matches!(
        name,
        "change-128-142" | "secs-2" | "secs-3" | "three-sections"
    ) || SIGNATURE_FIXTURES.contains(&name)
}

fn elastic_mode(root: &Path, only: &[String]) -> Result<()> {
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
            println!("{name:<16}  MISSING — {}", render_hint(name));
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
                let ok = if elastic_is_steps(&name) {
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

/// Truth changes where the *atom* jumps by a non-octave ratio. Exact
/// halvings/doublings keep the old period alive as a harmonic, so the ridge
/// rightly stays put there — that is the density detector's case (it finds
/// doubletime at 27.0 s; the ridge managed 30.8). Ramps are checked by
/// endpoint ratio; tiny-change and the secs-3/4 wobbles sit below the
/// 0.08-octave ridge resolution by design.
fn map_truth_changes(name: &str) -> Vec<f64> {
    match name {
        "change-128-142" | "secs-2" => vec![30.0],
        _ => Vec::new(),
    }
}

fn map_mode(root: &Path, only: &[String]) -> Result<()> {
    use overtone_tempo::map;
    let mut names = all_cases(root)?;
    for extra in DENSITY_EXTRAS
        .iter()
        .chain(["ramp-120-160", "ramp-180-140", "ramp-90-200"].iter())
    {
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
        if SIGNATURE_FIXTURES.contains(&name.as_str()) {
            println!("{name:<20}  (signature steps: judged by `gates.py signatures`)");
            continue;
        }
        let audio = root.join("bench/audio").join(format!("{name}.wav"));
        if !audio.is_file() {
            println!("{name:<20}  MISSING — {}", render_hint(name));
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

/// Inputs with no answer. Nothing here may hang, crash, or bluff: no
/// sections, no red lines, and a diagnostic that names the refusal.
/// Mirrors `benchmark.py`'s degenerate section, which caught v3's legacy
/// tracker answering 127.68 BPM to white noise.
fn nogrid_mode(root: &Path) -> Result<()> {
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
            println!("{name:<10}  MISSING — {}", render_hint(name));
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

/// BPM at the first and last fitted beat index.
fn degree_span(
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

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("golden");
    let root = repo_root()?;
    if mode == "density" {
        let only: Vec<String> = args
            .iter()
            .skip_while(|a| *a != "--only")
            .skip(1)
            .cloned()
            .collect();
        return density_mode(&root, &only);
    }
    if mode == "elastic" {
        let only: Vec<String> = args
            .iter()
            .skip_while(|a| *a != "--only")
            .skip(1)
            .cloned()
            .collect();
        return elastic_mode(&root, &only);
    }
    if mode == "map" {
        let only: Vec<String> = args
            .iter()
            .skip_while(|a| *a != "--only")
            .skip(1)
            .cloned()
            .collect();
        return map_mode(&root, &only);
    }
    if mode == "nogrid" {
        return nogrid_mode(&root);
    }
    if mode == "resample" {
        return resample_mode();
    }
    if mode == "structure" {
        let name = args.get(1).context("usage: structure <case>")?;
        return structure_mode(&root, name);
    }
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
        println!(
            "anchor {lo:.6}..{hi:.6}  span {span:.6}  attacks in window {}",
            wt.len()
        );
        let got = overtone_tempo::coherence::candidates(&wt, &ww, 10);
        println!(
            "{:<4} {:>14} {:>14} {:>10}   {:>14} {:>14}",
            "#", "v3 period", "rust period", "d period", "v3 phase", "rust phase"
        );
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
                want.map(|c| format!("{:.9}", c.period_s))
                    .unwrap_or_else(|| "-".into()),
                mine.map(|c| format!("{:.9}", c.period))
                    .unwrap_or_else(|| "-".into()),
                dp,
                want.map(|c| format!("{:.7}", c.phase_s))
                    .unwrap_or_else(|| "-".into()),
                mine.map(|c| format!("{:.7}", c.phase))
                    .unwrap_or_else(|| "-".into()),
            );
        }
        return Ok(());
    }
    if mode != "golden" {
        bail!(
            "usage: overtone-bench (golden | density | elastic | map) [--only CASE...] \r
             | nogrid | resample | structure <case> | candidates <case>"
        );
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
    println!(
        "Tolerance: attacks within {:.3} ms.\n",
        ATTACK_TOL_S * 1000.0
    );
    println!(
        "{:<18} {:>8} {:>8} {:>10} {:>3} {:>10} {:>7} {:>8}  verdict",
        "case", "attacks", "matched", "worst", "in", "seed dP", "octave", "analyse"
    );
    println!("{}", "-".repeat(92));

    let mut failures = 0usize;
    let mut total_decode = 0.0f64;
    let mut total_attacks = 0.0f64;
    let mut total_tempo = 0.0f64;
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
                    if report.env_sum_err > ENV_SUM_TOL {
                        why.push(format!("envelope sum {:.4} off", report.env_sum_err));
                    }
                    if report.worst_weight_err > WEIGHT_TOL {
                        why.push(format!("a weight {:.2e} off", report.worst_weight_err));
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
                    if report.global_bpm_err > 1e-3 {
                        why.push(format!("global bpm {:.4} off", report.global_bpm_err));
                    }
                    if report.matched != report.expected {
                        why.push(format!(
                            "{} unmatched",
                            report.expected.saturating_sub(report.matched)
                        ));
                    }
                    format!(
                        "DIFF: {} (worst at {:.3}s)",
                        why.join(", "),
                        report.worst_at
                    )
                };
                total_decode += report.decode_s;
                total_attacks += report.attacks_s;
                total_tempo += report.tempo_s;
                println!(
                    "{:<18} {:>8} {:>8} {:>8.4}ms {:>3} {:>10.2e} {:>7} {:>7.3}s  {verdict}",
                    report.case,
                    report.expected,
                    report.matched,
                    report.worst_ms,
                    if report.seed_in_candidates { "y" } else { "N" },
                    report.seed_period_err,
                    format!("{}/{}", report.octave_found, report.octave_expected),
                    report.attacks_s + report.tempo_s,
                );
            }
            Err(e) => {
                failures += 1;
                println!("{name:<18}  ERROR: {e:#}");
            }
        }
    }

    println!();
    // All three, because Python's figure times the whole analyze_audio call:
    // attack detection alone once stood in for "the corpus analyses in 2.5 s".
    println!(
        "decode {total_decode:.2}s + attacks {total_attacks:.2}s + tempo {total_tempo:.2}s \
         = {:.2}s, the whole pipeline",
        total_decode + total_attacks + total_tempo
    );
    if failures == 0 {
        println!(
            "{}/{} cases match the v3 engine attack for attack.",
            names.len(),
            names.len()
        );
        Ok(())
    } else {
        println!("{failures}/{} cases diverge.", names.len());
        bail!("golden-vector check failed");
    }
}
