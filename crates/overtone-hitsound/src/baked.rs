//! Calibrated template weights, baked in as constants (P-4).
//!
//! [`calibrated_templates`](crate::template::calibrated_templates) renders
//! the corpus and fits it on every call — about 3.5 s in a release build —
//! so the CLI and H4 read the fit from here instead, in under a millisecond.
//! The shapes (which feature, which response) still come from
//! [`initial_templates`](crate::template::initial_templates); only the bias
//! and the term weights are baked.
//!
//! Generated, do not edit by hand: the temporary `dump_baked_tables` test
//! prints these rows from a fresh fit. `baked_matches_fresh_fit` fails when
//! they drift (a corpus, shape or fitter change), and then this file is
//! regenerated and the reason recorded — never re-baselined to make a red
//! gate green.

use crate::corpus::HitClass;
use crate::template::{initial_templates, Template};

/// One class's fitted numbers: bias, then one weight per term, in the
/// template's own term order.
struct BakedClass {
    class: HitClass,
    bias: f64,
    weights: &'static [f64],
}

const BAKED: [BakedClass; 13] = [
    BakedClass { class: HitClass::Kick, bias: 2.05483219799845696e0, weights: &[
        2.43733915076414043e0, 2.59794182144591135e0, -9.37563244472584101e-1,
        3.20096999467112675e-1, -8.25692679634981941e-1, 5.69860712671407299e0,
    ] },
    BakedClass { class: HitClass::Snare, bias: -5.00875520019608667e-1, weights: &[
        -2.91421656124996575e0, -9.91766701736231382e-1, 7.99268323037609751e-1,
        5.46407384549118080e-1, -3.41200936131682386e0, -2.48717771714800862e-1,
        5.78378095874725329e0, 2.62798072055703313e0, 2.45642349412581185e0,
    ] },
    BakedClass { class: HitClass::Clap, bias: 1.70187853990422622e0, weights: &[
        1.63974387050535769e-1, -2.85210955222033657e0, 2.76536174918450728e0,
        1.64705153414915384e0, 2.00557234787306049e0,
    ] },
    BakedClass { class: HitClass::HatClosed, bias: 3.47376803569998716e0, weights: &[
        9.04835155869835095e-1, 2.87926226586266765e0, -1.69305104961790298e0,
        -7.06942409144527273e-2, -1.50042742332881285e0, 1.73798074251311019e0,
    ] },
    BakedClass { class: HitClass::HatOpen, bias: -4.91662511410022707e-1, weights: &[
        9.04835155869835095e-1, 2.31151031343384750e0, 1.15179492275765361e0,
        4.41199038531500864e0, 9.22702285998575622e-1,
    ] },
    BakedClass { class: HitClass::Tom, bias: 5.46457714729887800e-1, weights: &[
        -2.47906786924896494e0, 3.04402819645924394e0, 5.05398745252208847e0,
        3.53137731092084506e0, -2.22625132991483232e0,
    ] },
    BakedClass { class: HitClass::Cymbal, bias: -2.07015955630477899e0, weights: &[
        8.14351640282849010e-1, 5.49633439793055256e0, 6.88866309393028481e-2,
        2.85168609442661314e0, 3.25958781138863340e-1, -1.06735094414858489e0,
        1.44547452692247447e0, 2.20079932137194678e0,
    ] },
    BakedClass { class: HitClass::Ride, bias: -9.76328833725482959e-1, weights: &[
        5.60265806477624917e0, 7.23665548136621650e-1, 4.97387341855683385e0,
        3.31125718789683499e-1, -2.97930945573307460e0,
    ] },
    BakedClass { class: HitClass::Bass, bias: -6.37570008414250627e-2, weights: &[
        5.23261370502090806e0, 9.36827113499433595e-1, 3.84979644579032465e0,
        1.62475215221316804e0, 2.17427102746319323e-1, -6.08181751568768281e0,
    ] },
    BakedClass { class: HitClass::Guitar, bias: -9.32079081353115013e-1, weights: &[
        4.40795649556797997e0, 7.70981372338473525e-1, -1.60241229269850449e0,
        4.88105084037694947e0, -1.35740512447440809e0,
    ] },
    BakedClass { class: HitClass::Keys, bias: 3.13461267818900824e-1, weights: &[
        2.07957296307245354e0, 3.16907365583159684e-1, -7.77164727217214135e-2,
        3.69687210901443475e0, 1.86326399283801430e-2, 1.60088627007813322e0,
    ] },
    BakedClass { class: HitClass::Vocal, bias: -2.17691069149629834e0, weights: &[
        5.77875779240263654e0, 7.84604617078154765e-1, 1.35176900523550247e0,
        4.23887715724965286e0, 1.54247216718113411e0, 2.36063576145783882e0,
    ] },
    BakedClass { class: HitClass::Other, bias: -8.78624561000723170e-1, weights: &[
        2.59118685748161814e0, 3.28401586951506674e-1, 7.53827956750057560e0,
        2.72893783682058233e0,
    ] },
];

/// The templates to classify with: the hand-designed shapes with the fitted
/// numbers above. What [`calibrated_templates`](crate::template::calibrated_templates)
/// returns, without the 3.5 s fit.
pub fn templates() -> Vec<Template> {
    let mut out = initial_templates();
    for template in out.iter_mut() {
        let baked = BAKED
            .iter()
            .find(|b| b.class == template.class)
            .expect("one baked row per template class");
        assert_eq!(
            baked.weights.len(),
            template.terms.len(),
            "{:?}: baked weights out of step with the shapes",
            template.class,
        );
        template.bias = baked.bias;
        for (term, &weight) in template.terms.iter_mut().zip(baked.weights.iter()) {
            term.weight = weight;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template::calibrated_templates;

    /// The baked numbers are the fresh fit, exactly: same corpus, same
    /// fitter, same order of operations, so bit-for-bit. When a corpus,
    /// shape or fitter change moves the fit, this names it and `baked.rs`
    /// is regenerated with the reason recorded.
    #[test]
    fn baked_matches_fresh_fit() {
        let fresh = calibrated_templates();
        let baked = templates();
        assert_eq!(fresh.len(), baked.len());
        for template in &fresh {
            let same = baked
                .iter()
                .find(|b| b.class == template.class)
                .expect("one baked row per template class");
            assert_eq!(template.bias, same.bias, "{:?} bias", template.class);
            assert_eq!(template.terms.len(), same.terms.len());
            for (a, b) in template.terms.iter().zip(same.terms.iter()) {
                assert_eq!(a.feature, b.feature);
                assert_eq!(a.weight, b.weight, "{:?} weight", template.class);
            }
        }
    }
}
