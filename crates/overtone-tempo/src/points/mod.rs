//! Timing points from fitted sections: meter, confidence, red lines.
//!
//! v3 names kept in doc comments: `_section_confidence`, `section_measures`,
//! `detect_bar`, `meter_segments`, `_settle_meter_boundary`,
//! `points_from_meter`, `_points_from_sections`, `snap_timing_points`,
//! `osu_timing_text`. The v3.2/v3.3 additions (per-section meter, measure-grid
//! points) are part of this port, not optional extras: the golden vectors pin
//! `meter`, and `result.points` is compared stage by stage.
//!
//! The physical model for the meter path is Tempora's: measures per second is
//! the quantity, BPM its presentation through the signature
//! (`MpsToBpm(mps) = mps * 60 * beats_per_bar`).

/// Beats a bar may hold. Not every integer: 11 beats to a bar is not a time
/// signature, it is a fit artefact — v3 `BAR_MULTIPLES`.
pub const BAR_MULTIPLES: [usize; 9] = [2, 3, 4, 5, 6, 7, 8, 9, 12];
/// Beats-per-bar a *region* may be written in — v3 `BEATS_PER_BAR`.
pub const BEATS_PER_BAR: [usize; 6] = [2, 3, 4, 6, 8, 12];
/// A bar is only claimed when its downbeat stands out by this much.
pub const BAR_CONTRAST: f64 = 1.20;
/// A meter region must hold at least this many bars to be worth a red line.
pub const MIN_METER_BARS: usize = 4;
/// Rounds of boundary-search / refit alternation (matches sections).
pub const SETTLE_ROUNDS: usize = 2;

mod bars;
mod lines;
mod meter;
mod pipeline;
#[cfg(test)]
mod tests;

pub use bars::*;
pub use lines::*;
pub use meter::*;
pub use pipeline::*;
