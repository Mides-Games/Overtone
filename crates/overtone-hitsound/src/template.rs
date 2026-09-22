//! Instrument templates: scored, explainable, calibrated (docs §3).
//!
//! Each class is a weighted sum of monotone responses over named features,
//! normalised across classes by softmax. Templates, not a classifier:
//! every term's contribution is a number, so explanations are generated
//! from the computation; profiles reweight terms as data; a missing
//! feature drops its term instead of producing a confidently wrong answer.
//!
//! Responses have fixed knots (shapes, not parameters); the *weights* are
//! fitted by multinomial logistic regression on the synthetic corpus, with
//! a per-class bias so `other` — the class for attacks nothing describes —
//! learns its base rate instead of being forced into a drum.

use crate::corpus::HitClass;
use crate::source;
use crate::spectral::Spectral;
use crate::temporal::Temporal;

/// Named features templates can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Feature {
    SubRatio,
    LowRatio,
    LowMidRatio,
    MidRatio,
    HighMidRatio,
    HighRatio,
    AirRatio,
    CentroidHz,
    Rolloff85Hz,
    BandwidthHz,
    Flatness,
    Crest,
    Flux,
    RiseS,
    DecayTauS,
    SustainS,
    Zcr,
    SubAttacks,
    ChromaChange,
    F0Hz,
    Harmonicity,
    Formant,
    PercussiveRatio,
}

/// All evidence for one attack, assembled by [`extract`].
#[derive(Debug, Clone)]
pub struct Features {
    pub spectral: Spectral,
    pub temporal: Temporal,
    pub f0_hz: f64,
    pub harmonicity: f64,
    pub formant: f64,
    pub percussive_ratio: f64,
}

impl Features {
    pub fn value(&self, feature: Feature) -> f64 {
        match feature {
            Feature::SubRatio => self.spectral.band_ratios[0],
            Feature::LowRatio => self.spectral.band_ratios[1],
            Feature::LowMidRatio => self.spectral.band_ratios[2],
            Feature::MidRatio => self.spectral.band_ratios[3],
            Feature::HighMidRatio => self.spectral.band_ratios[4],
            Feature::HighRatio => self.spectral.band_ratios[5],
            Feature::AirRatio => self.spectral.band_ratios[6],
            Feature::CentroidHz => self.spectral.centroid,
            Feature::Rolloff85Hz => self.spectral.rolloff85,
            Feature::BandwidthHz => self.spectral.bandwidth,
            Feature::Flatness => self.spectral.flatness,
            Feature::Crest => self.spectral.crest,
            Feature::Flux => self.spectral.flux,
            Feature::RiseS => self.temporal.rise_s,
            // Infinity means "never decayed": beyond every band's reach.
            Feature::DecayTauS => {
                if self.temporal.decay_tau_s.is_finite() {
                    self.temporal.decay_tau_s
                } else {
                    2.0
                }
            }
            Feature::SustainS => self.temporal.sustain_s,
            Feature::Zcr => self.temporal.zcr,
            Feature::SubAttacks => self.temporal.sub_attacks as f64,
            Feature::ChromaChange => self.temporal.chroma_change,
            Feature::F0Hz => self.f0_hz,
            Feature::Harmonicity => self.harmonicity,
            Feature::Formant => self.formant,
            Feature::PercussiveRatio => self.percussive_ratio,
        }
    }
}

/// Assemble every feature for the attack at `attack_s`. `harmonic` and
/// `percussive` come from one full-track HPSS; `frame_of` maps seconds to
/// spectrogram frames (hop 128).
pub fn extract(
    y: &[f32],
    sr: u32,
    attack_s: f64,
    harmonic: &[Vec<f64>],
    percussive: &[Vec<f64>],
) -> Features {
    let spectral = crate::spectral::analyze(y, sr, attack_s);
    let temporal = crate::temporal::analyze(y, sr, attack_s);
    let n_fft = 4096;
    let mags = attack_spectrum(y, sr, attack_s, n_fft);
    let pitch = source::pitch(&mags, sr, n_fft);
    let formant = source::formant_likeness(&mags, sr, n_fft);
    // Same hop the detector and the HPSS spectrogram run on: frame indices
    // must address the same grid, or the ratio reads the wrong moment.
    let hop = overtone_core::FIT_HOP;
    let frame = (attack_s * sr as f64 / hop as f64).round() as usize;
    let lo = frame.saturating_sub(4);
    let hi = frame + 4;
    let percussive_ratio = source::percussive_ratio(harmonic, percussive, lo, hi);
    Features {
        spectral,
        temporal,
        f0_hz: pitch.f0_hz,
        harmonicity: pitch.harmonicity,
        formant,
        percussive_ratio,
    }
}

fn attack_spectrum(y: &[f32], sr: u32, attack_s: f64, n_fft: usize) -> Vec<f64> {
    use realfft::RealFftPlanner;
    let seg = crate::window_samples(y, sr, attack_s, crate::WIN_START_S, crate::WIN_END_S);
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut input = fft.make_input_vec();
    for (slot, &v) in input.iter_mut().zip(seg.iter()) {
        *slot = v;
    }
    let mut output = fft.make_output_vec();
    fft.process(&mut input, &mut output)
        .expect("fft sizes are fixed");
    output.iter().map(|c| c.norm()).collect()
}

/// Monotone response shapes. Knots are fixed and must ascend (a debug
/// assert enforces it); weights are learned.
#[derive(Debug, Clone, Copy)]
pub enum Response {
    /// 0 at or below `a`, 1 at or above `b`.
    Rising(f64, f64),
    /// 1 at or below `a`, 0 at or above `b`.
    Falling(f64, f64),
    /// Triangular peak of 1 at `mid`, 0 outside `[lo, hi]`.
    Band(f64, f64, f64),
    /// 1 at or below `t`, 0 at or above `2t`.
    AtMost(f64),
    /// 0 at or below `t - 0.5`, 1 at or above `t + 0.5`.
    AtLeast(f64),
}

impl Response {
    pub fn apply(&self, x: f64) -> f64 {
        match *self {
            // Knots must ascend; an inverted pair silently reads backwards,
            // which calibration then fits around — the audit caught five.
            Response::Rising(a, b) => {
                debug_assert!(a <= b);
                ((x - a) / (b - a).max(1e-12)).clamp(0.0, 1.0)
            }
            Response::Falling(a, b) => {
                debug_assert!(a <= b);
                1.0 - ((x - a) / (b - a).max(1e-12)).clamp(0.0, 1.0)
            }
            Response::Band(lo, mid, hi) => {
                debug_assert!(lo <= mid && mid <= hi);
                Response::Rising(lo, mid).apply(x).min(Response::Falling(mid, hi).apply(x))
            }
            Response::AtMost(t) => ((2.0 * t - x) / t.max(1e-12)).clamp(0.0, 1.0),
            Response::AtLeast(t) => ((x - (t - 0.5)) / 1.0).clamp(0.0, 1.0),
        }
    }
}

/// One scored term: a feature read through a response, times a weight.
#[derive(Debug, Clone, Copy)]
pub struct Term {
    pub feature: Feature,
    pub response: Response,
    pub weight: f64,
}

/// A scored instrument class.
#[derive(Debug, Clone)]
pub struct Template {
    pub class: HitClass,
    pub bias: f64,
    pub terms: Vec<Term>,
}

impl Template {
    pub fn score(&self, features: &Features) -> f64 {
        self.bias
            + self
                .terms
                .iter()
                .map(|t| t.weight * t.response.apply(features.value(t.feature)))
                .sum::<f64>()
    }
}

/// Initial templates: shapes from acoustics, weights at 1-ish starting
/// points. Calibration moves the weights; it never invents a term.
pub fn initial_templates() -> Vec<Template> {
    use Feature::*;
    vec![
        Template {
            class: HitClass::Kick,
            bias: 0.0,
            terms: vec![
                Term { feature: SubRatio, response: Response::Rising(0.25, 0.55), weight: 1.0 },
                Term { feature: CentroidHz, response: Response::Falling(250.0, 600.0), weight: 0.8 },
                Term { feature: DecayTauS, response: Response::Band(0.005, 0.02, 0.06), weight: 0.7 },
                Term { feature: Harmonicity, response: Response::Rising(0.4, 0.7), weight: 0.8 },
                Term { feature: F0Hz, response: Response::Band(40.0, 60.0, 100.0), weight: 0.7 },
            ],
        },
        Template {
            class: HitClass::Snare,
            bias: 0.0,
            terms: vec![
                Term { feature: MidRatio, response: Response::Rising(0.15, 0.45), weight: 1.0 },
                Term { feature: HighMidRatio, response: Response::Rising(0.10, 0.35), weight: 0.9 },
                Term { feature: SubRatio, response: Response::Falling(0.05, 0.20), weight: 0.8 },
                Term { feature: Flatness, response: Response::Rising(0.25, 0.55), weight: 0.7 },
                Term { feature: PercussiveRatio, response: Response::Rising(0.45, 0.75), weight: 1.0 },
                Term { feature: Harmonicity, response: Response::Falling(0.25, 0.55), weight: 0.6 },
                Term { feature: DecayTauS, response: Response::Band(0.04, 0.10, 0.25), weight: 0.5 },
                Term { feature: SubAttacks, response: Response::AtMost(1.5), weight: 0.4 },
            ],
        },
        Template {
            class: HitClass::Clap,
            bias: 0.0,
            terms: vec![
                Term { feature: MidRatio, response: Response::Rising(0.15, 0.40), weight: 0.9 },
                Term { feature: HighMidRatio, response: Response::Rising(0.10, 0.30), weight: 0.8 },
                Term { feature: PercussiveRatio, response: Response::Rising(0.40, 0.70), weight: 0.9 },
                Term { feature: SubAttacks, response: Response::AtLeast(1.5), weight: 1.0 },
                Term { feature: SustainS, response: Response::Rising(0.02, 0.06), weight: 0.4 },
            ],
        },
        Template {
            class: HitClass::HatClosed,
            bias: 0.0,
            terms: vec![
                Term { feature: HighRatio, response: Response::Rising(0.35, 0.65), weight: 1.0 },
                Term { feature: CentroidHz, response: Response::Rising(3500.0, 6500.0), weight: 0.8 },
                Term { feature: DecayTauS, response: Response::Falling(0.015, 0.05), weight: 0.7 },
                Term { feature: SustainS, response: Response::Falling(0.03, 0.08), weight: 0.6 },
                Term { feature: Zcr, response: Response::Rising(0.10, 0.25), weight: 0.5 },
            ],
        },
        Template {
            class: HitClass::HatOpen,
            bias: 0.0,
            terms: vec![
                Term { feature: HighRatio, response: Response::Rising(0.30, 0.60), weight: 1.0 },
                Term { feature: DecayTauS, response: Response::Band(0.02, 0.08, 0.25), weight: 0.9 },
                Term { feature: SustainS, response: Response::Rising(0.05, 0.12), weight: 0.7 },
                Term { feature: CentroidHz, response: Response::Rising(3000.0, 6000.0), weight: 0.6 },
            ],
        },
        Template {
            class: HitClass::Tom,
            bias: 0.0,
            terms: vec![
                Term { feature: LowMidRatio, response: Response::Rising(0.20, 0.45), weight: 1.0 },
                Term { feature: Harmonicity, response: Response::Rising(0.35, 0.65), weight: 0.8 },
                Term { feature: F0Hz, response: Response::Band(70.0, 110.0, 180.0), weight: 0.7 },
                Term { feature: DecayTauS, response: Response::Band(0.06, 0.12, 0.30), weight: 0.6 },
            ],
        },
        Template {
            class: HitClass::Cymbal,
            bias: 0.0,
            terms: vec![
                Term { feature: HighRatio, response: Response::Rising(0.25, 0.50), weight: 0.9 },
                Term { feature: AirRatio, response: Response::Rising(0.10, 0.30), weight: 0.9 },
                Term { feature: DecayTauS, response: Response::Rising(0.25, 0.60), weight: 0.8 },
                Term { feature: SustainS, response: Response::Rising(0.20, 0.50), weight: 0.7 },
                Term { feature: Flatness, response: Response::Rising(0.30, 0.60), weight: 0.6 },
            ],
        },
        Template {
            class: HitClass::Other,
            bias: 0.0,
            terms: vec![
                Term { feature: Harmonicity, response: Response::Rising(0.40, 0.70), weight: 0.8 },
                Term { feature: SustainS, response: Response::Rising(0.10, 0.30), weight: 0.7 },
                Term { feature: Flux, response: Response::Falling(0.20, 0.50), weight: 0.6 },
                Term { feature: PercussiveRatio, response: Response::Falling(0.20, 0.50), weight: 0.7 },
            ],
        },
    ]
}

/// Softmax classification: class probabilities in template order.
pub fn classify(templates: &[Template], features: &Features) -> Vec<(HitClass, f64)> {
    let scores: Vec<f64> = templates.iter().map(|t| t.score(features)).collect();
    let peak = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let exps: Vec<f64> = scores.iter().map(|&s| (s - peak).exp()).collect();
    let total: f64 = exps.iter().sum();
    templates
        .iter()
        .zip(exps.iter())
        .map(|(t, &e)| (t.class, e / total.max(1e-12)))
        .collect()
}

/// Multinomial logistic regression on labelled feature rows: full-batch
/// gradient descent, fixed iteration budget, L2 on the weights (biases
/// unregularised). Deterministic: zero init is not needed since templates
/// arrive warm, and every operation is closed-form arithmetic.
pub fn calibrate(
    templates: &mut [Template],
    rows: &[(HitClass, Features)],
    iterations: usize,
    learning_rate: f64,
    l2: f64,
) -> f64 {
    let mut loss = f64::INFINITY;
    for _ in 0..iterations {
        let (mut grad_bias, mut grad_w): (Vec<f64>, Vec<Vec<f64>>) = (
            vec![0.0; templates.len()],
            templates.iter().map(|t| vec![0.0; t.terms.len()]).collect(),
        );
        loss = 0.0;
        for (truth, features) in rows {
            let probs = classify(templates, features);
            for (c, template) in templates.iter().enumerate() {
                let target = if template.class == *truth { 1.0 } else { 0.0 };
                let error = probs[c].1 - target;
                loss -= target * probs[c].1.max(1e-12).ln();
                grad_bias[c] += error;
                for (t, term) in template.terms.iter().enumerate() {
                    grad_w[c][t] += error * term.response.apply(features.value(term.feature));
                }
            }
        }
        let n = rows.len().max(1) as f64;
        for (c, template) in templates.iter_mut().enumerate() {
            template.bias -= learning_rate * grad_bias[c] / n;
            for (t, term) in template.terms.iter_mut().enumerate() {
                let reg = l2 * term.weight;
                term.weight -= learning_rate * (grad_w[c][t] / n + reg);
            }
        }
    }
    loss
}

/// Macro F1 of calibrated templates on labelled rows.
pub fn macro_f1(templates: &[Template], rows: &[(HitClass, Features)]) -> (f64, Vec<(HitClass, f64)>) {
    use std::collections::HashMap;
    let mut tp: HashMap<HitClass, usize> = HashMap::new();
    let mut fp: HashMap<HitClass, usize> = HashMap::new();
    let mut support: HashMap<HitClass, usize> = HashMap::new();
    for (truth, features) in rows {
        *support.entry(*truth).or_insert(0) += 1;
        let best = classify(templates, features)
            .into_iter()
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(c, _)| c)
            .unwrap();
        if best == *truth {
            *tp.entry(best).or_insert(0) += 1;
        } else {
            *fp.entry(best).or_insert(0) += 1;
        }
    }
    let mut per_class = Vec::new();
    for class in HitClass::ALL {
        let (tp, fp, sup) = (
            tp.get(&class).copied().unwrap_or(0) as f64,
            fp.get(&class).copied().unwrap_or(0) as f64,
            support.get(&class).copied().unwrap_or(0) as f64,
        );
        let precision = if tp + fp > 0.0 { tp / (tp + fp) } else { 0.0 };
        let recall = if sup > 0.0 { tp / sup } else { 0.0 };
        let f1 = if precision + recall > 0.0 {
            2.0 * precision * recall / (precision + recall)
        } else {
            0.0
        };
        per_class.push((class, f1));
    }
    let macro_f1 = per_class.iter().map(|(_, f)| f).sum::<f64>() / per_class.len() as f64;
    (macro_f1, per_class)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_span_zero_to_one() {
        assert_eq!(Response::Rising(0.0, 1.0).apply(-1.0), 0.0);
        assert_eq!(Response::Rising(0.0, 1.0).apply(0.5), 0.5);
        assert_eq!(Response::Rising(0.0, 1.0).apply(2.0), 1.0);
        assert_eq!(Response::Falling(0.0, 1.0).apply(0.25), 0.75);
        assert_eq!(Response::Band(0.0, 0.5, 1.0).apply(0.5), 1.0);
        assert_eq!(Response::Band(0.0, 0.5, 1.0).apply(0.0), 0.0);
        assert_eq!(Response::AtMost(1.5).apply(1.0), 1.0);
        assert_eq!(Response::AtMost(1.5).apply(3.0), 0.0);
        assert_eq!(Response::AtLeast(1.5).apply(1.0), 0.0);
        assert_eq!(Response::AtLeast(1.5).apply(3.0), 1.0);
    }

    fn extract_track(track: &crate::corpus::CorpusTrack) -> Vec<(HitClass, Features)> {
        let spec = overtone_dsp::stft::power_spectrogram(&track.samples, 2048, 128);
        let sep = overtone_dsp::hpss::separate(&spec);
        track
            .hits
            .iter()
            .map(|hit| {
                (
                    hit.class,
                    extract(
                        &track.samples,
                        track.sr,
                        hit.time_s,
                        &sep.harmonic,
                        &sep.percussive,
                    ),
                )
            })
            .collect()
    }

    #[test]
    fn calibration_separates_the_corpus() {
        // Train on one seed, test on another: same recipes, different draws.
        // 16 s tracks keep per-class support at 6-7 hits, so one flip moves
        // macro F1 ~0.02 and the gate bar below has real margin.
        let train = crate::corpus::render(44_100, 16.0, 0.3, &HitClass::ALL, 11);
        let test = crate::corpus::render(44_100, 16.0, 0.3, &HitClass::ALL, 12);
        let train_rows = extract_track(&train);
        let test_rows = extract_track(&test);
        let mut templates = initial_templates();
        let (before, _) = macro_f1(&templates, &test_rows);
        let loss = calibrate(&mut templates, &train_rows, 2000, 0.5, 1e-4);
        let (after, per_class) = macro_f1(&templates, &test_rows);
        eprintln!("F1 {before:.3} -> {after:.3} (loss {loss:.3}): {per_class:.2?}");
        for (truth, features) in &test_rows {
            let best = classify(&templates, features)
                .into_iter()
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(c, _)| c)
                .unwrap();
            if best != *truth {
                eprintln!("  miss {truth:?} -> {best:?}");
            }
        }
        // Bar 0.80 against measured 0.85 on dense overlapping tracks: a
        // single class collapsing to zero costs ~0.06 of macro, so the bar
        // catches it with a two-flip margin elsewhere. The known-hard pair
        // is cymbal/other in dense mixes — docs §12 predicts exactly this,
        // and sequence context (not sharper templates) is the fix.
        assert!(
            after >= 0.80,
            "macro F1 {after:.3} (per class {per_class:.2?})"
        );
        assert!(after >= before, "calibration must not regress {before:.3}");
    }

    #[test]
    fn softmax_probabilities_sum_to_one() {
        let templates = initial_templates();
        let y = vec![0.0f32; 44_100];
        let features = Features {
            spectral: crate::spectral::analyze(&y, 44_100, 0.5),
            temporal: crate::temporal::analyze(&y, 44_100, 0.5),
            f0_hz: 0.0,
            harmonicity: 0.0,
            formant: 0.0,
            percussive_ratio: 0.0,
        };
        let probs = classify(&templates, &features);
        let total: f64 = probs.iter().map(|(_, p)| p).sum();
        assert!((total - 1.0).abs() < 1e-9);
    }
}
