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

struct Report {
    case: String,
    decode_s: f64,
    analyse_s: f64,
    candidates: usize,
    seed_in_candidates: bool,
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
}

impl Report {
    fn ok(&self) -> bool {
        self.found == self.expected
            && self.matched == self.expected
            && self.worst_ms <= ATTACK_TOL_S * 1000.0
            && self.env_frames_found == self.env_frames_expected
            && self.seed_in_candidates
            && self.weight_correlation > 0.999
            && self.seed_period_err <= PERIOD_TOL_S
            && self.seed_phase_ms <= ATTACK_TOL_S * 1000.0
    }
}

fn repo_root() -> PathBuf {
    // The binary lives in target/<profile>/, so the repo is two levels up from
    // the manifest dir at build time. Using CARGO_MANIFEST_DIR keeps this
    // working regardless of the working directory the user runs from.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crate lives at <root>/crates/<name>")
        .to_path_buf()
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

    Ok(Report {
        case: golden.case,
        decode_s,
        analyse_s,
        candidates: got_candidates.len(),
        seed_in_candidates,
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
    let root = repo_root();
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
        "{:<18} {:>8} {:>8} {:>10} {:>5} {:>3} {:>10} {:>8}  verdict",
        "case", "attacks", "matched", "worst", "cands", "in", "seed dP", "analyse"
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
                    if report.seed_period_err > PERIOD_TOL_S {
                        why.push(format!("seed period {:.2e}s off", report.seed_period_err));
                    }
                    if report.seed_phase_ms > ATTACK_TOL_S * 1000.0 {
                        why.push(format!("seed phase {:.4}ms off", report.seed_phase_ms));
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
                    "{:<18} {:>8} {:>8} {:>8.4}ms {:>5} {:>3} {:>10.2e} {:>7.3}s  {verdict}",
                    report.case,
                    report.expected,
                    report.matched,
                    report.worst_ms,
                    report.candidates,
                    if report.seed_in_candidates { "y" } else { "N" },
                    report.seed_period_err,
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
