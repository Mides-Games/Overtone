//! Source features: what physical process made the sound (docs §2).
//!
//! Percussive ratio from HPSS, pitch and harmonicity from a harmonic
//! product spectrum, formant-likeness from band bumps. Two deliberate
//! deferrals, both recorded: inharmonicity needs partial tracking past a
//! peak picker, and the residual ratio needs the margin-designed 3-way
//! HPSS — neither is a 10-line helper, and neither blocks templates.

/// Percussive energy share over a frame range of a separated spectrogram:
/// mean of P/(H+P). The separation (and its kernels) belongs to the
/// caller — usually one full-track HPSS whose windows are read here.
pub fn percussive_ratio(
    harmonic: &[Vec<f64>],
    percussive: &[Vec<f64>],
    frame_lo: usize,
    frame_hi: usize,
) -> f64 {
    let frames = harmonic.len().min(percussive.len());
    if frames == 0 {
        return 0.0;
    }
    let (lo, hi) = (frame_lo.min(frames), frame_hi.min(frames).max(frame_lo.min(frames)));
    if hi <= lo {
        return 0.0;
    }
    let (mut num, mut den) = (0.0, 0.0);
    for f in lo..hi {
        let n = harmonic[f].len().min(percussive[f].len());
        for b in 0..n {
            let (h, p) = (harmonic[f][b], percussive[f][b]);
            num += p;
            den += h + p;
        }
    }
    if den <= 0.0 {
        0.0
    } else {
        (num / den).clamp(0.0, 1.0)
    }
}

/// Pitch estimate from a harmonic product spectrum: `HPS[i] = Π mags[d·i]`
/// over three harmonics. A periodic spectrum multiplies up; noise
/// multiplies down to nothing.
///
/// Three, not four: the fundamental needs every multiplied partial present,
/// and kicks and basses routinely run out by the fourth. A pure sine still
/// fits every subharmonic divisor equally — no peak picker can know it is
/// not a 55 Hz fundamental with missing partials — so harmonic content
/// (which bass, guitar, voice and toms all carry) remains required.
pub struct Pitch {
    /// Fundamental in Hz, when `harmonicity` means anything.
    pub f0_hz: f64,
    /// 0 (noise) to ~1 (pure periodic). Relative peak height of the HPS.
    pub harmonicity: f64,
}

pub fn pitch(mags: &[f64], sr: u32, n_fft: usize) -> Pitch {
    const HARMONICS: usize = 3;
    const FMIN: f64 = 50.0;
    const FMAX: f64 = 2000.0;
    let bin_hz = sr as f64 / n_fft as f64;
    let lo = ((FMIN / bin_hz).floor() as usize).max(1);
    let hi = ((FMAX / bin_hz).ceil() as usize).min(mags.len() / HARMONICS);
    if hi <= lo || mags.is_empty() {
        return Pitch { f0_hz: 0.0, harmonicity: 0.0 };
    }
    let total: f64 = mags.iter().sum();
    let (mut best_i, mut best_v) = (lo, 0.0);
    for i in lo..hi {
        let mut hps = mags[i].max(0.0);
        for d in 2..=HARMONICS {
            hps *= mags[i * d].max(0.0);
            if hps <= 0.0 {
                break;
            }
        }
        // Normalise by the local level so one loud partial does not read
        // as harmonicity by itself: divide by the mean magnitude around
        // the fundamental bin.
        let neighbourhood: f64 = mags[lo..hi.min(mags.len())]
            .iter()
            .sum::<f64>()
            / hi.max(lo + 1).saturating_sub(lo).max(1) as f64;
        let score = hps / neighbourhood.max(1e-12).powi(HARMONICS as i32 - 1);
        if score > best_v {
            best_v = score;
            best_i = i;
        }
    }
    // Scale-free: a periodic spectrum multiplies up to dominate its own
    // total, noise multiplies down to nothing. Clamped, no constants.
    Pitch {
        f0_hz: best_i as f64 * bin_hz,
        harmonicity: (best_v / total.max(1e-12)).clamp(0.0, 1.0),
    }
}

/// Formant-likeness: energy within ±100 Hz of 500/1500/2500 Hz over energy
/// in 200–4000 Hz. Vowel-like spectra concentrate at formants; drums and
/// cymbals spread. The strongest cheap cue for voice, per the design doc.
pub fn formant_likeness(mags: &[f64], sr: u32, n_fft: usize) -> f64 {
    const FORMANTS: [f64; 3] = [500.0, 1500.0, 2500.0];
    const HALF_WIDTH: f64 = 100.0;
    const LO: f64 = 200.0;
    const HI: f64 = 4000.0;
    let bin_hz = sr as f64 / n_fft as f64;
    let mut formant = 0.0;
    let mut broadband = 0.0;
    for (i, &m) in mags.iter().enumerate() {
        let f = i as f64 * bin_hz;
        if f < LO || f > HI {
            continue;
        }
        let e = m * m;
        broadband += e;
        if FORMANTS.iter().any(|&ff| (f - ff).abs() <= HALF_WIDTH) {
            formant += e;
        }
    }
    if broadband <= 0.0 {
        0.0
    } else {
        (formant / broadband).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spectrum_of(y: &[f32], n_fft: usize) -> Vec<f64> {
        use realfft::RealFftPlanner;
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(n_fft);
        let mut input = fft.make_input_vec();
        for (slot, &v) in input.iter_mut().zip(y.iter()) {
            *slot = v as f64;
        }
        let mut output = fft.make_output_vec();
        fft.process(&mut input, &mut output).expect("fft sizes are fixed");
        output.iter().map(|c| c.norm()).collect()
    }

    #[test]
    fn percussive_ratio_separates_burst_from_tone() {
        // Noise burst frames read percussive, sine frames harmonic, through
        // small-kernel HPSS on a two-frame... no: build a tiny spec directly.
        let harmonic = vec![vec![10.0, 10.0], vec![10.0, 10.0]];
        let percussive = vec![vec![0.1, 0.1], vec![0.1, 0.1]];
        assert!(percussive_ratio(&harmonic, &percussive, 0, 2) < 0.05);
        assert!(percussive_ratio(&percussive, &harmonic, 0, 2) > 0.95);
        assert_eq!(percussive_ratio(&[], &[], 0, 0), 0.0);
        assert_eq!(percussive_ratio(&harmonic, &percussive, 5, 9), 0.0);
    }

    #[test]
    fn pitch_reads_a_harmonic_tone_and_dismisses_noise() {
        let sr = 44_100;
        let n_fft = 4096;
        // Harmonic series, as pitched material always carries: the
        // fundamental is then the only bin with four aligned partials.
        let tone_sig: Vec<f32> = (0..n_fft)
            .map(|i| {
                let t = i as f64 / sr as f64;
                (0.5 * (2.0 * std::f64::consts::PI * 220.0 * t).sin()
                    + 0.3 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()
                    + 0.2 * (2.0 * std::f64::consts::PI * 660.0 * t).sin()) as f32
            })
            .collect();
        let mags = spectrum_of(&tone_sig, n_fft);
        let tone = pitch(&mags, sr, n_fft);
        assert!((tone.f0_hz - 220.0).abs() < 220.0 * 0.05, "f0 {}", tone.f0_hz);
        assert!(tone.harmonicity > 0.5, "harmonicity {}", tone.harmonicity);

        let mut rng = 3u64;
        let noise: Vec<f32> = (0..n_fft)
            .map(|_| {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
                (((rng >> 33) as f64 / (1u64 << 31) as f64) - 0.5) as f32
            })
            .collect();
        let nmags = spectrum_of(&noise, n_fft);
        let hiss = pitch(&nmags, sr, n_fft);
        assert!(
            hiss.harmonicity < 0.5 * tone.harmonicity,
            "noise {} vs tone {}",
            hiss.harmonicity,
            tone.harmonicity
        );
    }

    #[test]
    fn formants_flag_vowels_not_drums() {
        let sr = 44_100;
        let n_fft = 4096;
        // Vowel-ish: harmonics with bumps at the formants.
        let mut vowel = vec![0.0f32; n_fft];
        for (i, slot) in vowel.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            let bump = |f: f64, c: f64| (-((f - c) / 220.0).powi(2)).exp();
            let mut s = 0.0;
            for h in 1..=12 {
                let f = 130.0 * h as f64;
                s += (2.0 * std::f64::consts::PI * f * t).sin()
                    * (0.4 * bump(f, 500.0) + 0.4 * bump(f, 1500.0) + 0.4 * bump(f, 2500.0) + 0.05);
            }
            *slot = (s * 0.1) as f32;
        }
        let vform = formant_likeness(&spectrum_of(&vowel, n_fft), sr, n_fft);
        // Kick-ish: 60 Hz plus click, nothing in the formant zone.
        let mut kick = vec![0.0f32; n_fft];
        for (i, slot) in kick.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            *slot = (0.9 * (2.0 * std::f64::consts::PI * 60.0 * t).sin() * (-t / 0.03).exp()
                + 0.3 * (2.0 * std::f64::consts::PI * 4000.0 * t).sin() * (-t / 0.003).exp()) as f32;
        }
        let kform = formant_likeness(&spectrum_of(&kick, n_fft), sr, n_fft);
        eprintln!("vowel {vform:.3} kick {kform:.3}");
        assert!(vform > 2.0 * kform.max(0.05), "vowel {vform:.3} vs kick {kform:.3}");
    }
}
