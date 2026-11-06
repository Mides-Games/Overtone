//! The golden vectors' JSON, as `python bench/golden.py dump` writes it, and the
//! tolerances each stage is held to.

use serde::Deserialize;

/// 0.05 ms. Tight enough that a different computation fails, loose enough to
/// survive float-order differences between a NumPy expression and a loop.
pub(crate) const ATTACK_TOL_S: f64 = 5e-5;
/// 1e-6 s of period at 340 ms per beat is about 0.0002 BPM. This is the
/// tolerance for a *fitted* grid, which is a real invariant.
pub(crate) const PERIOD_TOL_S: f64 = 1e-6;
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
pub(crate) const CANDIDATE_REL_TOL: f64 = 5e-3;

#[derive(Deserialize)]
pub(crate) struct Golden {
    pub(crate) case: String,
    pub(crate) attacks: GoldenAttacks,
    #[serde(default)]
    pub(crate) candidates: Vec<GoldenGrid>,
    #[serde(default)]
    pub(crate) seeds: Vec<Option<GoldenGrid>>,
    #[serde(default)]
    pub(crate) octave: Option<GoldenOctave>,
    #[serde(default)]
    pub(crate) atom_sections: Vec<GoldenSection>,
    #[serde(default)]
    pub(crate) beat_sections: Vec<GoldenSection>,
    #[serde(default)]
    pub(crate) settled_sections: Vec<GoldenSection>,
    #[serde(default)]
    pub(crate) meter: Option<GoldenMeter>,
    #[serde(default)]
    pub(crate) result: GoldenResult,
}

impl Golden {
    /// Stages this vector does not carry. Every stage parses with a default,
    /// so a dump that skipped one read as an empty stage, and an empty stage
    /// compares equal to a Rust stage that is also empty: a skipped stage
    /// passed. Every golden fixture has a grid (the refusals live in
    /// `nogrid`), so each stage must be there.
    pub(crate) fn missing_stages(&self) -> Vec<&'static str> {
        [
            ("candidates", self.candidates.is_empty()),
            ("seeds", self.seeds.is_empty()),
            ("octave", self.octave.is_none()),
            ("atom_sections", self.atom_sections.is_empty()),
            ("beat_sections", self.beat_sections.is_empty()),
            ("settled_sections", self.settled_sections.is_empty()),
            ("meter", self.meter.is_none()),
            ("result.points", self.result.points.is_empty()),
        ]
        .into_iter()
        .filter_map(|(stage, absent)| absent.then_some(stage))
        .collect()
    }
}

/// v3's global meter reading on the first settled section.
#[derive(Deserialize, Default)]
pub(crate) struct GoldenMeter {
    #[serde(default)]
    pub(crate) meter: String,
    #[serde(default)]
    pub(crate) downbeat_class: usize,
    #[serde(default)]
    pub(crate) bar_beats: usize,
}

#[derive(Deserialize, Default)]
pub(crate) struct GoldenResult {
    #[serde(default)]
    pub(crate) points: Vec<GoldenPoint>,
    #[serde(default)]
    pub(crate) fit_residual_ms: f64,
    #[serde(default)]
    pub(crate) global_bpm: f64,
}

/// One snapped red line as the Python dump writes it.
#[derive(Deserialize, Default)]
pub(crate) struct GoldenPoint {
    #[serde(default)]
    pub(crate) offset_ms: f64,
    #[serde(default)]
    pub(crate) bpm: f64,
    #[serde(default)]
    pub(crate) confidence: f64,
    #[serde(default)]
    pub(crate) meter: usize,
    #[serde(default)]
    pub(crate) meter_known: bool,
}

/// One constant-tempo region as the Python dump writes it.
#[derive(Deserialize)]
pub(crate) struct GoldenSection {
    #[serde(default)]
    pub(crate) start_s: f64,
    #[serde(default)]
    pub(crate) end_s: f64,
    #[serde(default)]
    pub(crate) period_s: f64,
    #[serde(default)]
    pub(crate) phase_s: f64,
    #[serde(default)]
    pub(crate) bpm: f64,
    #[serde(default)]
    pub(crate) inliers: usize,
    #[serde(default)]
    pub(crate) residual_ms: f64,
}

/// v3's octave decision. The accuracy benchmark normalises octaves away, so
/// this is the only thing that can catch a change to it — audit finding F-07.
#[derive(Deserialize)]
pub(crate) struct GoldenOctave {
    pub(crate) atoms_per_beat: usize,
    pub(crate) first_class: usize,
}

/// A period/phase pair as the Python dump writes it.
#[derive(Deserialize)]
pub(crate) struct GoldenGrid {
    pub(crate) period_s: f64,
    pub(crate) phase_s: f64,
}

#[derive(Deserialize)]
pub(crate) struct GoldenAttacks {
    pub(crate) count: usize,
    pub(crate) times_s: Vec<f64>,
    pub(crate) weights: Vec<f64>,
    pub(crate) envelope_frames: usize,
    /// Sum of v3's onset envelope, to 4 decimals.
    pub(crate) envelope_sum: f64,
}
