# Machine learning — where it earns its place

The brief asks whether ML genuinely improves five specific things. Answering "yes, add a
model" everywhere would be the easy and wrong reply. The useful answer is per-task, with
the condition under which each one ships.

Two constraints frame everything: **the app must work with no internet and no external
API**, and **the hitsound engine's explanations must remain generated from the
computation**, not narrated alongside a black box.

---

## 1. Verdicts

| Task | Do the hand-tuned features plateau? | ML verdict |
|---|---|---|
| Tempo / offset estimation | **No** — the fit is exact (0.0000 BPM median, measured) | **Never.** A learned estimator would be strictly worse and unexplainable |
| Section boundaries (tempo changes) | No — the grid-crossing method is exact by construction | **No.** Nothing to learn |
| Kick / snare / hat classification | **Yes, around 75–85 % F1** is the realistic ceiling for templates on real mixes | **Yes, conditionally** — the clearest win |
| Vocal onset detection | **Yes, and lower** — templates confuse voice with synth leads and guitar | **Yes, conditionally** — the biggest gap |
| Musical section labelling (verse/chorus) | Partly — novelty curves find boundaries; *labels* need semantics | **Optional**, low value |
| Hitsound decision | Not applicable — this is preference, not perception | **No.** Keep the DP; it is what makes output consistent and explainable |

The pattern: ML belongs in **perception** (what instrument is this?), never in
**measurement** (what is the tempo?) and never in **preference** (which sample should this
be?).

---

## 2. Drum classification — the one clear candidate

**Task.** Given an attack and its ~120 ms window, label it
`kick / snare / hat / cymbal / tom / other`, multi-label (a kick and a crash co-occur).

**Why ML helps here.** Drum timbre on a real, mastered, sidechained mix is not separable
by band ratios alone. Compression flattens crest factor; a kick under a crash has its
spectrum dominated by the crash; layered samples blur every template boundary. This is
exactly the regime where a small learned model beats hand-tuned thresholds, and drum
transcription is a long-standing, well-benchmarked task, so the gain is predictable rather
than speculative.

**Model.** A small CNN over a log-mel patch — roughly 80 mel bands × 15 frames centred on
the attack, 3–4 conv layers, ~50–200 k parameters, well under 1 MB in f32 and smaller
quantised. Inference is one tiny forward pass per attack: a few thousand attacks per track
is single-digit milliseconds on CPU.

**Runtime.** `tract` (pure Rust, no C++ toolchain, permissive licence) as first choice;
ONNX Runtime as the fallback if an operator is missing. Both run fully offline. No GPU —
the batch is too small to amortise a transfer.

**How it is integrated — this part matters.** The model does **not** replace the
templates. It produces a second opinion that enters the decision engine as additional
evidence terms:

```
+ model: snare 0.88                            +0.88   (learned)
+ template: snare 0.74                         +0.74   (spectral profile)
```

Both appear in the explanation with their provenance. When they disagree, the explanation
shows the disagreement rather than hiding it, and confidence drops — which is the honest
outcome and also the useful one, because a disagreement is a good signal for "listen to
this one".

**Training data.** The licensing problem is real: the standard drum-transcription datasets
are mostly research-only or non-commercial, and **I have not verified the current licence
of any specific dataset**, so none should be assumed usable. Rather than resolve that, use
what the repo already does for tempo: **synthesise labelled data**
([`06-hitsound-engine.md`](06-hitsound-engine.md) §9). The benchmark renderer already
places kicks, snares and hats at known times; emit those labels, then vary sample choice,
velocity, tempo, mix balance, sidechain, reverb, saturation and mastering loudness to
cover the realistic space. No dataset licence, unlimited quantity, perfect labels.

Its weakness is the same one the timeline already admits about the tempo benchmark:
synthesised drums are cleaner than recorded ones, so held-out synthetic accuracy is an
upper bound. The complement is a few hundred hand-labelled onsets from real tracks —
cheap to produce with the tool's own timeline once it exists, and the only way to measure
the real-world gap.

**Ship condition.** The model ships only if, on a **hand-labelled real-audio** set:

1. it beats the calibrated templates by **≥ 8 points of macro F1**, and
2. its false-positive rate on `cymbal` (the class whose errors are most audible as finish
   spam) is no worse, and
3. model + weights stay under 5 MB, and
4. per-track inference stays under 50 ms.

If it clears that, it is worth the dependency. If it clears only condition 1 by a couple of
points, it is not — the templates are explainable, calibratable and have no runtime
dependency, and that is worth several points of F1.

---

## 3. Vocal onset detection — the biggest gap

**Why.** Vocal onsets are the most requested hitsound cue after drums and the hardest to
get from templates: voice, distorted guitar and synth lead all sit in 200 Hz–4 kHz with
harmonic structure and moderate rise times. Formant-likeness helps and is not enough.

**Approach, cheapest first:**

1. **HPSS residual + formant features** (already planned in Phase 6). Measure it. It may
   be adequate for the profile that needs it.
2. **A small CRNN for vocal activity** over time, then intersect activity with detected
   attacks. Vocal activity detection is an easier task than onset detection and a coarse
   time resolution is sufficient, because the attack time itself already comes from the
   sample-resolution re-timer.
3. **Vocal stem separation**, only if 1 and 2 both fail. The quality would be excellent and
   the costs are real: tens to hundreds of MB of weights, seconds of processing, and
   licence terms that must be checked per model — **several well-known separation models
   have non-commercial or research-only weights, and I would not ship any of them without
   reading the current licence**. A ~100 MB download for a hitsound hint is a bad trade
   for a tool whose whole premise is that it is small and local.

**Ship condition:** same shape as §2, plus the model must degrade to "no vocal evidence"
rather than guessing, because a false vocal whistle is more annoying than a missing one.

---

## 4. Calibration — the ML that ships first and is barely ML

Before any neural network: **fit the template weights instead of guessing them.**
Multinomial logistic regression over the same named features, trained on the synthetic
corpus. ~100 parameters, trained in under a second, and it keeps every property that makes
templates worth having — each feature's contribution stays a signed number with a name.

This is Phase 6 work, not Phase 9, and it is likely to recover a good share of the gap to
a CNN. Measuring *that* gap is the honest way to decide whether the CNN is needed at all.

---

## 5. What ML will not be used for

| Not this | Because |
|---|---|
| Tempo or offset regression | The least-squares fit is exact on the corpus. Replacing a measurement with an estimate is a regression, not a feature |
| End-to-end "audio → hitsounded map" | Unexplainable, untunable, unfixable, and trained on a target (other people's hitsounds) that is preference rather than truth |
| The octave decision | It is a judgement call about musical interpretation. A model would encode *someone's* preference and present it as detection. ×2 / ÷2 with evidence shown is the correct design |
| Beat tracking | Same as tempo |
| Anything requiring a network call | Offline is a product property, not a default |
| Generative anything | Out of scope |

---

## 6. If ML is added, these are the rules

1. **Weights are vendored in the repo or downloaded once with an explicit prompt** — never
   fetched silently, never required for the app to start.
2. **The app works fully with every model disabled.** ML is an evidence source, not a
   dependency. A `--no-ml` flag must produce a complete, usable result.
3. **Licences for weights and training data are recorded in `docs/licenses.md`**, per
   model, with the date they were checked.
4. **Every model has a measured baseline it beat**, recorded in the benchmark output. A
   model with no comparison is a liability.
5. **Inference is CPU-only by default.** GPU inference for a few thousand tiny patches is
   slower once transfer is counted, and it would make results hardware-dependent.
6. **Model output enters explanations labelled as learned**, with its confidence, and never
   overrides a high-confidence template agreement silently.
