# Hitsound engine

The goal is not "assign a sample to each object". It is: **decide what the music is doing
at each hitobject, and choose the hitsound that represents it — then be able to defend the
choice.**

Three properties are non-negotiable, and they shape everything below:

1. **Explainable.** Every decision itemises its evidence and its alternatives. A mapper who
   disagrees must be able to see *why* before overriding.
2. **Consistent.** Hitsounding is a sequence, not a set of independent choices. Two objects
   in the same rhythmic role should sound the same. This is why the decision layer is a
   dynamic program over the object sequence rather than a per-object classifier.
3. **Non-destructive.** Only the hitsound fields of hitobject lines change. Everything else
   in the `.osu` comes out byte-identical.

---

## 1. Pipeline

```
audio ──► [ shared with the tempo engine ]
          attacks · beat grid · sections · onset envelope
                    │
                    ▼
          HPSS  →  harmonic / percussive / residual
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
  per-attack features    structure analysis
  (spectral, temporal)   (phrases, downbeats, energy map)
          │                    │
          ▼                    │
  instrument likelihoods       │
  kick·snare·clap·hat·         │
  cymbal·ride·tom·bass·        │
  guitar·keys·vocal            │
          │                    │
.osu ─────┼────────────────────┤
          ▼                    ▼
       object context (type, pattern, spacing, combo, existing hitsounds)
                    │
                    ▼
        ┌───────────────────────────┐
        │  Decision engine          │
        │  emission = evidence      │
        │  transition = consistency │
        │  Viterbi over objects     │
        └───────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   explanations           hitsound assignment
   (evidence, alts)       (bank, additions, index, volume)
                                │
                                ▼
                    span-preserving .osu export
```

Everything above the `.osu` line is audio analysis and is **cached per audio file**, so
hitsounding a second difficulty of the same song costs only the object-context and
decision stages — milliseconds.

---

## 2. Per-attack features

Extracted in a window around each attack: `[−10 ms, +120 ms]`, with a `[−60 ms, −10 ms]`
pre-window for masking context.

### Spectral
Seven log band energies, always used as **ratios**, never absolutes, so the engine is
loudness-invariant:

| Band | Hz | Reads |
|---|---|---|
| sub | 20–60 | kick fundamental, 808 |
| low | 60–120 | kick body, bass |
| low-mid | 120–400 | tom, snare body, bass harmonics |
| mid | 400–2 k | snare crack, vocal fundamentals, guitar body |
| high-mid | 2 k–6 k | snare snap, vocal formants, pick attack |
| high | 6 k–11 k | hat, cymbal |
| air | 11 k+ | cymbal shimmer, crash |

Plus: centroid, rolloff (85 % and 95 %), bandwidth, flatness, crest factor, spectral flux
magnitude at the attack, and the change in **chroma** across the attack (a chord change
has high chroma distance; a drum hit has near-zero).

### Temporal
Rise time (10 → 90 %), decay time constant τ from a log-linear fit over 20–200 ms,
sustain length, zero-crossing rate, and **sub-attack count** in the first 30 ms — the
feature that separates a clap (flam of 2–4 micro-transients) from a snare (one).

### Source
- **Percussive ratio** from HPSS: percussive energy / total in the window.
- **Harmonicity**: peak normalised autocorrelation of the harmonic component. Separates
  pitched (vocal, guitar, bass, tom) from unpitched (snare, hat, cymbal).
- **Pitch** + inharmonicity when harmonicity is high enough to mean anything.
- **Formant-likeness**: energy concentration near ~500 / 1500 / 2500 Hz relative to a
  smooth spectral envelope — the strongest cheap cue for voice.
- **Residual ratio**: energy in the third HPSS component, where breathy vocals and noise
  transients land.

All features are computed once per attack, in parallel across attacks. Cost is dominated
by the HPSS median filtering, which is a one-off per file.

---

## 3. Instrument likelihoods

Each class is a **scored template**: a weighted sum of monotone piecewise-linear responses
over named features, normalised across classes by softmax.

```rust
Template {
    name: "snare",
    terms: &[
        Term { feature: MidRatio,        response: rising(0.15, 0.45), weight: 1.0 },
        Term { feature: HighMidRatio,    response: rising(0.10, 0.35), weight: 0.9 },
        Term { feature: SubRatio,        response: falling(0.05, 0.20), weight: 0.8 },
        Term { feature: Flatness,        response: rising(0.25, 0.55), weight: 0.7 },
        Term { feature: PercussiveRatio, response: rising(0.45, 0.75), weight: 1.0 },
        Term { feature: Harmonicity,     response: falling(0.25, 0.55), weight: 0.6 },
        Term { feature: DecayTau,        response: band(0.04, 0.10, 0.25), weight: 0.5 },
        Term { feature: SubAttacks,      response: at_most(1.5),         weight: 0.4 },
    ],
}
```

Why templates and not a classifier, given that a small CNN would score better on raw
accuracy (see [`08-machine-learning.md`](08-machine-learning.md))?

- Every term's contribution is a number, so the explanation in §7 is **generated from the
  computation**, not written alongside it and hoped to match.
- A profile can reweight terms — that is literally what a hitsounding profile is.
- It degrades gracefully: a missing or unreliable feature drops its term instead of
  producing a confidently wrong answer.
- It is the correct baseline to *measure* ML against. Shipping ML first means never
  knowing whether it earned its place.

Classes: `kick · snare · clap · hat_closed · hat_open · cymbal · ride · tom · bass ·
guitar · keys · vocal · other`. `other` is a real class and it fires often — an attack the
engine cannot characterise must not be forced into a drum.

The template weights are **calibrated, not guessed**: fitted by logistic regression on
labelled onsets generated by the synthetic renderer (§9), which is the same trick the
tempo benchmark already uses to get exact ground truth for free.

---

## 4. Musical role

Independent of instrument, and it carries as much weight in the decision.

| Signal | Derivation |
|---|---|
| Grid position | subdivision of the beat: 1/1, 1/2, 1/3, 1/4, 1/6, 1/8 — from the fitted grid, exactly |
| Metrical weight | downbeat > beat 3 > beats 2 and 4 > off-beats > 16ths |
| Phrase position | bar 1 of 4/8/16 (phrase start) and last bar (phrase end), from a self-similarity novelty curve over chroma + windowed energy. MFCC is built but not in it: a change of instrumentation alone, same chords at the same level, is not a signal it reads |
| Section boundary | distance to the nearest tempo-section or structural boundary |
| Local energy | RMS percentile in a 2 s window — accents are relative, not absolute |
| Accent | attack weight relative to the local distribution |
| Density | attacks/s locally, which distinguishes a fill from a groove |

Metrical weight is the single most useful non-audio signal: a snare-like attack on beat 2
or 4 is almost certainly the backbeat; the same spectral profile on a 16th is a ghost note
and should be quieter or unsounded.

---

## 5. Object context from the `.osu`

| Signal | Use |
|---|---|
| Object type | circle · slider head/tick/repeat/tail · spinner · hold |
| New combo, combo index | combo starts often want emphasis |
| Δt and Δpx to prev/next | spacing, implied velocity |
| Angle | flow; distinguishes a jump from a stack |
| Pattern class | stream (≥ 4 at ≤ 1/4) · burst (2–3) · jump · stack · triangle · alternating |
| Local density | objects/s |
| Slider velocity | from inherited timing points × base SV |
| **Existing hitsounds** | the mapper's intent — a strong prior, never silently discarded |

Slider handling is where most tools go wrong and where the brief is explicit:

- **Head** gets the full decision.
- **Ticks** are evaluated but strongly biased to `none` or a soft addition; a tick on an
  audible attack may take one, a tick on silence takes nothing.
- **Repeats** are decided like heads, with a consistency bond to the head.
- **Tails** follow the object that lands under them, if any; otherwise nothing.
- Per-node sample sets are written where the format allows them.

---

## 6. Decision engine

### Candidate space

```
bank      ∈ { Normal, Soft, Drum }          (sample set)
additions ∈ P{ whistle, finish, clap }      (the bitfield; normal is the absence of additions)
index     ∈ { 0 (default), 1..N }           (custom sample index, from the sample bank)
volume    ∈ 5..100                          (quantised to 5 %)
```

Pruned per object to a handful of plausible candidates before scoring.

### Emission score

```
E(object, candidate) = Σ_c  L(c) · affinity(c, candidate)        instrument evidence
                     + w_role   · role_fit(role, candidate)      metrical appropriateness
                     + w_energy · energy_fit(local_energy, volume)
                     + w_ctx    · context_fit(object_context, candidate)
                     + w_prior  · agreement_with_existing(candidate)
```

`affinity` is the profile's mapping from instrument to hitsound — this is where the
"kick → `drum-hitnormal`" style table lives, as **data**, not code:

```toml
# profiles/balanced.toml
[affinity]
kick       = [{ bank = "drum", additions = [],          w = 1.00 }]
snare      = [{ bank = "drum", additions = ["clap"],    w = 1.00 },
              { bank = "normal", additions = ["clap"],  w = 0.60 }]
hat_closed = [{ bank = "soft", additions = [],          w = 0.90 }]
hat_open   = [{ bank = "soft", additions = ["whistle"], w = 0.55 }]
cymbal     = [{ bank = "soft", additions = ["finish"],  w = 1.00 }]
ride       = [{ bank = "soft", additions = ["whistle"], w = 0.70 }]
vocal      = [{ bank = "soft", additions = ["whistle"], w = 0.85 }]
guitar     = [{ bank = "normal", additions = ["finish"],w = 0.70 }]
other      = [{ bank = "inherit", additions = [],       w = 0.30 }]

[weights]
role = 1.0   energy = 0.6   context = 0.8   prior = 1.2
[transition]
stream_consistency = 1.4  phrase_symmetry = 0.9  finish_spacing = 1.1  switch_cost = 0.5
```

### Transition score — the part that makes it sound intentional

A per-object argmax produces noise: three claps, a whistle, two claps, a finish, because
the audio wobbled. Real hitsounding is periodic and structural. So the assignment is a
**sequence labelling problem**, solved exactly by Viterbi over the object list:

```
best = argmax_S  Σ_i E(o_i, s_i) + Σ_i T(s_{i-1}, s_i, o_{i-1}, o_i)
```

with `T` combining:

- **switch cost** — changing bank or additions between adjacent objects costs, unless a
  boundary justifies it (new combo, section, phrase edge).
- **stream consistency** — inside a stream, deviation from the stream's modal hitsound is
  heavily penalised; a stream that alternates randomly is always wrong.
- **phrase symmetry** — objects at the same metrical position in consecutive bars are
  bonded: if bar 1 beat 2 took a clap, bar 2 beat 2 wants one. This is what makes output
  sound like a person did it.
- **finish spacing** — `finish` gets a refractory penalty; cymbal crashes are sparse, and
  finish spam is the most common failure of automatic hitsounding.
- **mapper-intent bond** — where the mapper already placed hitsounds, deviating costs
  `w_prior`. With `--respect-existing` the bond becomes a hard constraint.

Cost is `O(n · |states|²)` with a pruned state set — trivial for tens of thousands of
objects, and it is the kind of thing that is free in Rust and would have been painful in
Python. The DP also gives **per-object marginals**, which is where §7's alternatives and
confidences come from, correctly normalised rather than invented.

---

## 7. Explainability

The inspector reads the computation, not a narrative:

```
Object #1842        slider head · §2 · bar 47 beat 2 · 1/1

  Decision      DRUM-HITCLAP                                        91%
  Alternative   NORMAL-HITCLAP                                       6%
                SOFT-HITNORMAL                                       2%
                (none)                                               1%

  Audio evidence
    + transient strength           0.83   strong        +1.00
    + mid-band ratio               0.41   snare-like    +0.90
    + high-mid ratio               0.33   snare-like    +0.81
    + percussive ratio             0.78   percussive    +1.00
    − sub-band ratio               0.06   not a kick    −0.05
    + sub-attacks                  1      single hit    +0.40
    ⇒ snare 0.74 · clap 0.11 · tom 0.06 · other 0.09

  Musical role
    + beat 2 of 4                         backbeat      +0.85
    + on the 1/1 grid, residual 0.4 ms    exact         +0.20

  Map context
    + slider head, new combo                            +0.30
    + previous object took drum-hitclap   consistency   +0.55

  Sequence
    + bar 46 beat 2 took drum-hitclap     phrase bond   +0.62
```

Every line is a term that was actually evaluated, with its feature value, its
interpretation and its signed contribution. If the sum does not equal the decision, that
is a bug and it is visible.

`overtone-cli explain map.osu --object 1842` prints the same block, which makes disagreements
reportable as text.

---

## 8. Sample bank

```
Samples/
├─ Normal/  hitnormal · hitwhistle · hitfinish · hitclap
├─ Soft/    hitnormal · hitwhistle · hitfinish · hitclap
└─ Drum/    hitnormal · hitwhistle · hitfinish · hitclap
   + custom indices:  normal-hitclap2.wav, drum-hitfinish3.ogg, …
```

- Import a skin folder or a beatmap folder; detect which of the 12 base samples and which
  custom indices exist, by filename convention.
- Audition any sample; auditioning it **against the song at the selected object** is the
  feature that matters, and it is cheap once playback exists.
- Analyse the samples themselves with the same feature extractor, then **recommend** a
  mapping: a sample whose spectral profile is kick-like is offered for the kick role. This
  makes profiles portable across sample sets instead of hard-coding "drum-hitnormal".
- Missing samples are reported, not silently assigned: an assignment referencing a sample
  the beatmap folder does not contain is a playable-but-silent hitsound, and that is a
  validation error (see [`07-roadmap.md`](07-roadmap.md), Phase 6).

---

## 9. Ground truth without a licensing problem

The hitsound engine needs labelled onsets to calibrate §3 and to measure anything. Public
drum-transcription datasets are mostly research-only or non-commercial, which makes
shipping weights trained on them a licensing question nobody wants.

The repo already contains the answer: `bench/benchmark.py` **synthesises** its audio with
exact ground truth. Extend that renderer to emit, alongside the audio, the label of every
hit it placed:

```
render(kick @ 0.000, snare @ 0.535, hat @ 0.267, …)  →  audio.wav + labels.json
```

Vary tempo, sample choice, velocity, mix balance, reverb, sidechain, noise, mastering
loudness and overlap density. This yields unlimited perfectly-labelled onsets with no
dataset licence, which is enough to calibrate the templates, measure classification F1,
and — if it ever earns its place — train a small model.

Its limitation is the same one the timeline already states about the tempo benchmark:
synthesised drums are cleaner than recorded ones, so results are an upper bound. The
honest complement is a small hand-labelled set of real tracks, and it should be built.

---

## 10. Export

- Modify **only** the hitsound fields of hitobject lines: the `hitSound` bitfield and the
  `hitSample` group (`normalSet:additionSet:index:volume:filename`).
- Everything else byte-identical: metadata, timing points, positions, curve data, combo
  colours, unknown sections, CRLF style, BOM.
- Implemented as span-preserving edits over the original bytes, not re-serialisation of a
  parsed model. A round-trip with zero decisions applied must produce an identical file,
  and that is a test.
- Atomic write (temp + rename), `.bak` never overwritten — v3's rules, inherited.
- `original.osu` → `original_hitsounded.osu` when writing a copy instead of in place.
- Green (inherited) timing points are **added only if needed** for per-section volume, and
  only with explicit consent.

## 11. Profiles

| Profile | Character |
|---|---|
| Balanced | natural and musical; the default |
| Technical | precise hats and claps, dense subdivision coverage |
| Aggressive | more accents, more finishes on phrase edges |
| Minimal | drums only on strong beats; most objects inherit |
| Drum-focused | kick/snare/hat drive everything; vocals ignored |
| Vocal-focused | vocal onsets take whistles; drums support |
| Rock / Metal | kick, snare, crash and guitar accents; hats de-emphasised |
| Custom | every weight in §6 exposed, saved as TOML |

A profile is data. Adding one is a file, not a code change — which is the test of whether
the decision engine is actually configurable or just parameterised.

---

## 12. Honest limits

Stated here so they end up in the README rather than being discovered by users:

- **Hitsounding is taste.** The engine can find the snare; it cannot know that this mapper
  uses soft-hitclap for backbeats in kiai and drum-hitclap elsewhere. The output is a
  first pass to edit, not a finished hitsound layer.
- **Dense mixes mask instruments.** A kick under a crash is partly guesswork; the
  confidence will say so, and low-confidence objects are exactly what the timeline
  highlights.
- **Electronic music has no drum kit.** A supersaw stab is not a snare. The `other` class
  and low confidence are the correct output, not a forced label.
- **Vocal onset detection is the weakest classifier** in the set, and the honest place
  where ML is worth evaluating.
- **Synthetic calibration is an upper bound**, as above.
