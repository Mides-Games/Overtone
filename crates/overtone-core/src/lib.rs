//! Shared types for Overtone. No I/O, no DSP, no UI — this crate is a leaf so
//! that everything above it can depend on it without depending on each other.
//!
//! The unit newtypes exist because the v3 Python mixes seconds and milliseconds
//! across function boundaries, and that is the sort of thing a compiler can
//! carry for us. `Seconds` is what the engine computes in; `Millis` is what the
//! `.osu` format and the UI speak.

use serde::{Deserialize, Serialize};

/// Sample rate every stage of the engine works at.
pub const TARGET_SR: u32 = 44_100;
/// Hop for the fitting envelope: 2.9 ms at 44.1 kHz. `FIT_HOP` in v3.
pub const FIT_HOP: usize = 128;
/// Window for the mel spectrogram the onset envelope is built from. This is a
/// librosa default that v3 relies on without stating; see docs/05-dsp-pipeline.
pub const N_FFT: usize = 2048;
/// Refuse absurd input instead of thrashing memory.
pub const MAX_AUDIO_SECONDS: f64 = 3600.0;

macro_rules! unit {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub f64);

        impl $name {
            #[inline]
            pub fn get(self) -> f64 {
                self.0
            }
        }

        impl From<f64> for $name {
            #[inline]
            fn from(value: f64) -> Self {
                Self(value)
            }
        }
    };
}

unit!(Seconds, "A time, in seconds from the start of the audio.");
unit!(
    Millis,
    "A time or duration in milliseconds — what `.osu` speaks."
);
unit!(Bpm, "Beats per minute.");

impl Seconds {
    #[inline]
    pub fn to_millis(self) -> Millis {
        Millis(self.0 * 1000.0)
    }
}

impl Millis {
    #[inline]
    pub fn to_seconds(self) -> Seconds {
        Seconds(self.0 / 1000.0)
    }
}

impl Bpm {
    /// Beat length. Zero BPM has no period; callers must check.
    #[inline]
    pub fn period(self) -> Option<Seconds> {
        (self.0 > 0.0).then(|| Seconds(60.0 / self.0))
    }
}

/// One detected attack: a physical note onset, re-timed to sample resolution.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Attack {
    pub time: Seconds,
    /// Envelope height at the peak. Used as the least-squares weight, so a
    /// ghost note pulls the grid less than a kick does.
    pub weight: f32,
}

/// One constant-tempo region, fitted as `t(k) = phase + k * period`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GridSection {
    pub start: Seconds,
    pub end: Seconds,
    /// Seconds per beat.
    pub period: f64,
    /// Time of beat index 0. May sit before `start`.
    pub phase: f64,
    pub inliers: usize,
    /// RMS distance from inlier attacks to the grid, in milliseconds.
    pub residual_ms: f64,
    /// Fraction of grid slots that carry an attack.
    pub coverage: f64,
}

impl GridSection {
    pub fn bpm(&self) -> Bpm {
        Bpm(if self.period > 0.0 {
            60.0 / self.period
        } else {
            0.0
        })
    }
}

/// An uninherited ("red") osu! timing point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimingPoint {
    pub offset: Millis,
    pub bpm: Bpm,
    /// 0..=1.
    pub confidence: f64,
    pub section: usize,
    /// Beats per bar written into the `.osu` meter field. Defaults to 4 so
    /// every hand-made point keeps working unchanged.
    pub meter: u32,
    /// True when the accents actually proved where the bar starts. When they
    /// did not, the offset is anchored to a beat rather than a downbeat.
    pub meter_known: bool,
}

impl TimingPoint {
    pub fn new(offset_ms: f64, bpm: f64, confidence: f64, section: usize) -> Self {
        Self {
            offset: Millis(offset_ms),
            bpm: Bpm(bpm),
            confidence,
            section,
            meter: 4,
            meter_known: false,
        }
    }
}

/// Which engine produced a result. Carried on the analysis so a consumer never
/// has to guess, and so a silent downgrade is impossible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    /// The least-squares grid fitter.
    Precision,
    /// A continuously varying tempo model.
    Elastic,
    /// No grid could be fitted and none was invented.
    NoGrid,
}

/// Something worth telling the user that is not a failure. v3 reported these by
/// appending to a progress string, which meant a library consumer could not
/// tell "this audio has no grid" from "the engine panicked" (audit F-08).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Diagnostic {
    /// Fewer attacks than the engine needs to fit anything.
    TooFewAttacks { found: usize, needed: usize },
    /// No pulse rate explained enough of the attack energy.
    NoCoherentPulse { best_share: f64 },
    /// The fit succeeded but the music does not sit on a fixed grid.
    LargeGridResidual { residual_ms: f64 },
    /// A stage failed unexpectedly. This is a bug, not a property of the audio.
    StageFailed { stage: String, detail: String },
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("audio is shorter than two seconds")]
    TooShort,
    #[error("audio is longer than {} minutes; trim it first", MAX_AUDIO_SECONDS / 60.0)]
    TooLong,
    #[error("could not decode audio: {0}")]
    Decode(String),
    #[error("not enough attacks detected: found {found}, need {needed}")]
    NotEnoughAttacks { found: usize, needed: usize },
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Weighted median. v3 uses this for the global BPM so a long section counts
/// for more than a short one.
pub fn weighted_median(values: &[f64], weights: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut order: Vec<usize> = (0..values.len()).collect();
    order.sort_by(|&a, &b| values[a].total_cmp(&values[b]));
    let total: f64 = order.iter().map(|&i| weights[i].max(0.0)).sum();
    if total <= 0.0 {
        let mid = order.len() / 2;
        return if order.len() % 2 == 0 {
            0.5 * (values[order[mid - 1]] + values[order[mid]])
        } else {
            values[order[mid]]
        };
    }
    let mut running = 0.0;
    for &i in &order {
        running += weights[i].max(0.0) / total;
        if running >= 0.5 {
            return values[i];
        }
    }
    values[*order.last().unwrap()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_round_trip() {
        let s = Seconds(1.234_567);
        assert!((s.to_millis().to_seconds().get() - s.get()).abs() < 1e-12);
    }

    #[test]
    fn bpm_period_rejects_zero() {
        assert!(Bpm(0.0).period().is_none());
        assert!((Bpm(120.0).period().unwrap().get() - 0.5).abs() < 1e-12);
    }

    #[test]
    fn weighted_median_follows_the_weight() {
        // Two sections: 10 s at 128 BPM, 1 s at 200 BPM. The long one wins.
        assert_eq!(weighted_median(&[128.0, 200.0], &[10.0, 1.0]), 128.0);
        assert_eq!(weighted_median(&[128.0, 200.0], &[1.0, 10.0]), 200.0);
    }
}
