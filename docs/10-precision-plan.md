# Phase 10 — Human-level timing accuracy

The rest of the roadmap gets Overtone to a **good** automatic timing tool. This
document is about making it a **great** one — as close to the accuracy of a
mapper who has already timed the song by hand as an offline, licence-free
system can be.

Everything here uses free software and open datasets. No paid APIs, no
proprietary models, no manual clicks required at runtime. It is allowed to
take longer per analysis: a five-minute song may take a couple of minutes to
process rather than three seconds. Precision is the only goal; time is not
budgeted.

The baseline this phase is measured against is the ranked map
`2437969 My Chemical Romance - Vampires Will Never Hurt You` — 236 hand-placed
red lines over 5 minutes 12 seconds of live-band audio. Today Overtone reaches
**4.7 % of those points within 5 ms**. The ceiling this plan targets is
**90–95 %** with a **1–2 ms median error**.

---

## The measurement discipline before anything else

Nothing on this phase ships without a measurable improvement on both corpora.

### The reference set

- **Corpus A** — the 24 synthetic fixtures. This is the accuracy baseline
  (0.16 ms median). Cannot regress.
- **Corpus B — real ranked maps.** Twenty tracks scraped from osu!'s ranked
  section, spanning every category the plan needs to handle:

  | Category | Tracks | Property |
  |---|---|---|
  | Constant-tempo EDM | 4 | v3 already exact |
  | Constant-tempo rock/pop | 4 | v3 usually exact, sometimes octave wrong |
  | Live-band with drift | 4 | Vampires-style, 200+ manual points |
  | Verse/chorus octave swap | 3 | Sunday Cruise class |
  | Rubato intro then steady | 3 | v3 falls back |
  | Signature changes | 2 | 6/4 → 3/4, etc |

  Each carries its ranked `.osu` as ground truth.

### The metric

Not "did we find the right number of points". The correct question is:
**for each ranked red line, does an Overtone red line fall within 5 ms of it?**
Reported as:

- % of ranked points within 5 ms · within 10 ms · within 50 ms
- median and worst offset error
- median and worst BPM error (octave-normalised)

Corpus A stays the same. Corpus B is the new bar.

---

## Phase 10.1 — Fingerprint & reuse against the user's own `osu!/Songs`

**The insight.** The user already has osu! installed. Every map they have
downloaded lives in `C:\osu!\Songs\` with its `.osu` (timing included) and
its audio next to it. That is a local, personal, licenced corpus of timed
tracks, keyed to exactly the music the user listens to and maps.

Fingerprinting an incoming track against this local library gives an exact
answer for every song the user already has a map for — with zero network,
zero external mirror to maintain, and zero terms-of-service to accept.

### Dependencies (all free, offline)

- **Chromaprint** (LGPL-2.1) — audio fingerprint, small C library, ~2 MB
- **pyacoustid** (MIT) — Python bindings for Chromaprint
- Local SQLite index — a few MB per thousand maps

**Deliberately not used:**
- ~~osu! API v2~~ — was the earlier plan; requires network, breaks the
  offline-first policy the user asked for
- ~~Public mirror of ranked maps (50 GB download)~~ — not portable, not
  installable in one step

### Steps

1. **Install Chromaprint** as a bundled DLL in the installer. Nothing to
   configure.
2. **First-run index build.** On first launch, the app scans
   `%USERPROFILE%\AppData\Local\osu!\Songs\`,
   `C:\osu!\Songs\` and any folders the user adds. For each mapset:
   - Compute a Chromaprint fingerprint of the audio (~2 s per track).
   - Parse the `.osu` timing sections.
   - Store `{fingerprint_hash → (path, timing_lines)}` in
     `%LOCALAPPDATA%\Overtone\fingerprints.sqlite`.
   - Cache the fingerprint on the audio file's blake3 hash so re-scans are
     instant.
   - Progress bar during the scan; the app is usable immediately for
     non-cached tracks.
3. **Passive updates.** When the user opens a new track in Overtone, its
   fingerprint is computed and cached anyway. When they add a new map to
   `osu!/Songs`, a background watch (or a manual "Rescan" button) updates
   the index.
4. **Match at analysis time.**
   - Fingerprint the input audio (~2 s).
   - Query the local index; if a match with score > 0.9 is found, use that
     map's `.osu` timing directly. Verify by aligning the first and last
     onset — a fingerprint match plus onset alignment is proof of identity.
5. **Fall through** to Phase 10.2+ when no match exists.

### What this gains and what it does not

Perfect result on any song the user has already downloaded a ranked or loved
map for. That is a large fraction of what mappers actually work on — most
people mapping a song have that map's set in their folder as reference.

Does **nothing** for a song the user has never seen. Phases 10.2 onward
handle those.

### Measurable

On tracks in the mirror: 100 % within 1 ms (it *is* the answer).
On tracks not in the mirror: identical to today. No regression is possible.

### Cost

~500 lines. One-off download of the mirror (hours the first time). Free
forever after.

---

## Phase 10.2 — Source separation (Demucs)

**The insight.** A beat tracker fed vocals plus guitars plus drums is being
asked to find the drums. Isolating them first is trivially better. Vampires
fails partly because the vocals dominate energetically.

### Dependencies

- **Demucs v4 (htdemucs)** — Meta AI, MIT licence, offline. ~500 MB of
  weights, ~10 s per minute of audio on CPU, seconds on GPU.
- **PyTorch** as a runtime dep.

### Steps

1. **Vendor the weights** in a downloadable-once-on-first-use manner. Never
   fetched silently; a UI prompt confirms the download.
2. **Cache the drum stem** per audio file, keyed by blake3 hash. A track is
   never separated twice.
3. **Extend the pipeline**:
   - Run the current envelope on the full mix (kept for onset density).
   - Run *another* envelope on the drum stem.
   - Attack times come from the drum stem; energy weights come from the full
     mix.
4. **Fall through** to Phase 10.3+ working on drum-stem attacks.

### Measurable

Expected gain on Corpus B: +5 % of points within 5 ms; nothing on Corpus A
because the fixtures are already drums-only.

### Cost

~300 lines of pipeline wiring, plus the download UX.

---

## Phase 10.3 — Neural beat & downbeat tracking

**The insight.** The last decade of research produced beat trackers that beat
signal-processing pipelines by 5–10 F-measure points on real music. Their
downbeat outputs align with what a mapper calls a downbeat much more
reliably than accent depth alone.

### Dependencies (in preference order — all free/permissive)

- **BeatThis** (Böck et al. 2024, MIT) — newest, smallest, best measured
  performance on GTZAN and RWC. ~50 MB. First choice.
- **BeatNet** (Heydari et al. 2021, MIT) — TCN, ~40 MB. Fallback.
- **madmom** (MPI-2.0) — RNN+DBN, ~200 MB with all models, robust and older
  but the reference implementation for many benchmarks. Second fallback.
- **Beat Transformer** (Zhao et al. 2022, MIT) — dilated self-attention.
  Highest peak accuracy in papers but heavier.

### Steps

1. **Vendor BeatThis weights** with the app.
2. **Add `overtone-neural` as a Python subprocess boundary**, so PyTorch is
   loaded lazily and doesn't leak into the fast path. First analysis after
   install shows a "loading model" progress state.
3. **Get three signals from BeatThis per track**:
   - beat positions (in seconds, sub-frame),
   - downbeat positions,
   - meter (2/3/4 estimate).
4. **Present them as candidates to the ensemble** (Phase 10.6), not as
   ground truth. The neural model is one voter, not the decider.

### Measurable

Expected gain: +8 % of points within 5 ms on Corpus B. Zero regression on
Corpus A because BeatThis will agree with v3 on synthetic drums to sub-ms.

### Cost

~600 lines. New dependency: PyTorch (large). Justified by the ceiling this
raises.

---

## Phase 10.4 — Multi-band and multi-signal evidence

**The insight.** A mapper does not listen to "onsets". They listen to kick,
snare, hat, hand-clap, vocal onset, chord change — each carrying a different
piece of information about where the "1" is.

### Sub-signals to add

1. **7-band onset envelopes.** STFT split into logarithmic bands:
   sub (20–60), low (60–120), low-mid (120–400), mid (400–2000),
   high-mid (2k–6k), high (6k–11k), air (11k+). One envelope per band.
2. **3-way HPSS.** Fitzgerald extended to harmonic + percussive + residual.
   Beat tracking runs on percussive; chord-change detection runs on harmonic.
3. **Chroma novelty.** Cosine distance between consecutive chroma frames.
   Peaks land on chord changes — which mappers say almost always coincide
   with downbeats.
4. **Constant-Q Transform** in place of STFT for the chroma path. Better
   resolution on low frequencies where the harmonic content lives.
5. **Kick and snare specialists.** Two small models trained on
   drum-transcription datasets — see Phase 10.9.

### Steps

1. Add each sub-signal as a *feature*, computed once per track and cached
   on the analysis object.
2. Expose them to the ensemble (Phase 10.6) so each hypothesis can be
   scored against every piece of evidence.

### Measurable

Expected gain: +2 % on Corpus B by itself; larger when combined with the
ensemble because it feeds richer inputs.

### Cost

~800 lines. Purely additive to the pipeline.

---

## Phase 10.5 — Rippling model (Tempora's own algorithm)

**The insight.** Tempora's core innovation isn't the UI; it's that each timing
point derives its `MeasuresPerSecond` from its neighbours, not from a global
fit. This is what handles drift naturally: the tempo of point *k* is
`(measure[k+1] − measure[k]) / (time[k+1] − time[k])`, computed locally.

### Steps

1. **Re-derive the timing model.** Replace the per-section `period` with
   per-point `mps`. `TimingPoint` gains `measure_position` and
   `measures_per_second`. BPM is derived: `bpm = mps * 60 * beats_per_bar`.
2. **Port `CalculateMPSBasedOnAdjacentPoints` verbatim.** When a candidate
   downbeat is added, its `mps` is set from the neighbour ahead; the
   neighbour behind is updated too. This is a direct port of Tempora's C#.
3. **Port `FixBpmsToEnsureProperLineups`.** When exporting to `.osu` with
   integer millisecond offsets, tiny rounding errors accumulate across long
   sections; Tempora adjusts the BPM *up* slightly on each point so the next
   downbeat still lands on its intended bar line. Overtone must do the same.
4. **Micro-timing propagation.** Once downbeats are placed, walk the track
   and insert a new point wherever the local `mps` differs from the previous
   point's `mps` by more than 0.5 %. That is the numerical criterion behind
   "the mapper felt the tempo drift and added a point".

### Measurable

Expected gain: +15–20 % on Corpus B, huge because it directly attacks the
drift that Vampires exhibits. Zero on Corpus A because synthetic fixtures
have zero drift.

### Cost

~1200 lines, and a compatibility layer with the existing model. This is the
biggest architectural change on the plan.

---

## Phase 10.6 — Multi-hypothesis ensemble

**The insight.** A human considers multiple interpretations before committing.
"Is this 6/4 at 300 or 3/4 at 150?" — they try both and pick the one that
sounds right. The algorithm must generate hypotheses, score them, and pick.

### Voters

For every candidate `(offset, mps, meter)`:

1. **BeatThis alignment** — how close are the model's beats to this hypothesis's beats?
2. **Coherence score** — v3's `share × coverage`, on the drum stem.
3. **Sub-bass hits** — do the sub-bass onsets land on the beats?
4. **Chord-change coincidence** — do the chroma-novelty peaks land on downbeats?
5. **Alignment score** — synthesise a click at this hypothesis and compute
   its correlation with the drum stem's envelope. This is the "does it sound
   right" check.
6. **osu! mapper priors** — calibrated from the ranked corpus:
   - P(BPM = round number) > P(BPM = 148.7)
   - P(BPM in 120–300) > P(BPM outside)
   - P(4/4) > P(3/4) > P(5/4)
   - P(no tempo change) > P(N changes) shrinks with N
7. **Neighbour continuity** — the `mps` of this hypothesis vs the last
   accepted point. Sudden 10 % jumps are penalised unless the audio really
   changed.

### The Bayesian ensemble

```
posterior(H) ∝ prior(H) × ∏ voter_likelihood_i(H)
```

- Priors from the calibrated corpus.
- Voter likelihoods each on their own scale, log-summed.
- Top-K posteriors kept for downstream refinement rather than a single winner.

### Measurable

Expected gain: +5–8 % on Corpus B. Also raises the *confidence* of the final
result, which the UI can display honestly.

### Cost

~600 lines including a coherent representation of hypotheses.

---

## Phase 10.7 — Rubato modelling

**The insight.** Even after everything above, some tracks have genuine tempo
variation across seconds (piano rubato, accelerando fills, deliberate pushes
and pulls). The current elastic-grid prototype handles ramps but not local
variation.

### Model

A **Gaussian process** on the log-tempo curve:

- Prior: mean ≈ current best BPM, kernel = RBF with length scale ~4 s.
- Observations: for each accepted downbeat, `log(60/period_local)` with the
  uncertainty from the ensemble's posterior.
- Posterior: smooth tempo curve with per-time uncertainty.

Where the posterior variance is above threshold, insert extra timing points.
Where it's low, merge points.

### Alternative implementations to also code and compare

- **B-spline tempo curve** with cross-validation to pick knot count.
- **Particle filter** for online tempo estimation with resampling.
- **HSMM (Hidden Semi-Markov Model)** with tempo as a hidden state.

Compare all four on Corpus B; ship whichever wins by median error.

### Measurable

Expected gain: +3–5 % on Corpus B, concentrated on the rubato-intro tracks.

### Cost

~1000 lines. GPy or a hand-written GP; both viable.

---

## Phase 10.8 — Alignment feedback loop

**The insight.** A mapper exports the map, plays it with a click, hears drift,
and adjusts. The algorithm must do the same *virtually*.

### Steps

1. **Synthesise a click at every proposed timing point.** Same wave, same
   accents, same volume as the exported one.
2. **Cross-correlate** the click with the drum stem's onset envelope across
   ±30 ms per point.
3. **Local offset correction.** If a point's cross-correlation peak is at
   +7 ms, move the point +7 ms — but only if the ensemble posterior is
   uncertain there. Confident points are left alone.
4. **Iterate** until no point moves more than 1 ms.

This is a post-processing pass that runs after the ensemble commits.

### Measurable

Expected gain: +2 % on Corpus B, more on pop/rock than on EDM.

### Cost

~400 lines.

---

## Phase 10.9 — Fine-tuning on the osu! corpus

**The insight.** The public ranked-map corpus is a training set of a size and
timing precision no other domain has. A model fine-tuned on it will beat a
general beat tracker at what mappers care about.

### Data pipeline

1. Scrape ~50,000 ranked maps' `.osu` timing sections and their fingerprints.
2. Filter to sets where the ranked timing is under 10 ms uncertainty (measured
   by variance across duplicate maps of the same song).
3. Extract audio from the user's local osu!/Songs (or a rented API for
   research volumes).
4. Build training pairs: (audio_features, timing_points).

### Training

- Fine-tune **BeatThis** on this corpus. Only the last few layers, so training
  fits in an evening on a single consumer GPU.
- Loss: negative log-likelihood of downbeat presence at each time frame, plus
  an auxiliary meter classification.

### Distribution

- The fine-tuned weights ship as an optional download.
- The base model still ships as default so nothing depends on the fine-tune.

### Measurable

Expected gain: +3–5 % on Corpus B (fine-tune specifically to what the
domain calls "correct").

### Cost

~2000 lines and one-time training. Weekly re-training as more maps get ranked.

---

## Phase 10.10 — Chord recognition and cadence anchors

**The insight.** Cadences (V–I, IV–I, ii–V–I) almost always land on downbeats
in Western pop and rock. Detecting cadences and using them as anchors is a
tiny but robust signal.

### Dependencies

- **Chordino** (VAMP plugin, GPL — usable as a subprocess if licence
  compatibility matters) or **madmom chord recognition**.
- **Roman numeral analysis** from detected chords.

### Steps

1. Extract chord progression per bar.
2. Detect cadences by pattern (V–I, IV–I, etc).
3. Anchor downbeats where a cadence resolves.

### Measurable

Expected gain: +1 % on Corpus B (small, but on the pop/rock category it's
larger and where Vampires lives).

### Cost

~500 lines. Optional voter in the ensemble.

---

## Phase 10.11 — Instrument-specific detectors

**The insight.** A trained kick detector is more precise than a generic onset
detector.

### Detectors to build

- **Kick detector.** Sub-bass envelope (20–100 Hz) with transient shape prior.
- **Snare detector.** 200–500 Hz mid-band + noise burst signature.
- **Hi-hat detector.** > 5 kHz with sharp attack.
- **Bass note onsets.** Pitched onsets from CQT.

Trained on the ADTOF dataset (open, 2022) or the Vogl et al. datasets.

### Measurable

Expected gain: +1–2 % on Corpus B, mostly on drum-heavy tracks.

### Cost

~600 lines plus training.

---

## Phase 10.12 — UX for slow but precise

**The insight.** If analysis takes 90 seconds, the UI must communicate that
without making the app feel broken.

### Changes

1. **Multi-stage progress bar.** Per-stage times, current stage highlighted,
   total elapsed and estimated remaining. Nothing spins without a name.
2. **Cancellable at any stage.** Users can bail out of a long run and get
   whatever partial result the finished stages produced.
3. **Cached intermediate results.** Fingerprint, stem, envelope, beat model
   output, ensemble hypotheses — all keyed to blake3(audio bytes). Re-analysing
   the same track uses cache; changing parameters re-runs only downstream
   stages.
4. **Confidence colour on every timing point.** Green if the ensemble
   posterior > 0.9; amber if 0.6–0.9; red if below 0.6. The mapper knows
   exactly where to look first.
5. **Explanation panel.** Selecting a timing point shows *why* it was placed:
   "BeatThis: 96 % · sub-bass kick at −0.4 ms · chord change at +1 ms".
6. **Preview click track without exporting.** Play the audio with the current
   timing points as click, live, in the app. Adjust in place.

### Measurable

No accuracy metric — usability.

### Cost

~1500 lines UI, mostly in the workspace canvas.


---

## Phase 10.13 — MSI distribution (Windows first, self-contained)

**The insight.** The user asked for a single Windows installer that contains
every capability of the app. No runtime downloads, no external services, no
"first-launch setup" that fails offline. Full detail in
[`11-msi-distribution.md`](11-msi-distribution.md); summary here.

### What ships in the installer

Everything Phase 10 needs, bundled: Python 3.14 embedded, PyTorch CPU,
BeatThis weights, Demucs v4 drum-stem weights, madmom fallback models,
Chromaprint DLL, librosa/scipy/numpy, FFmpeg CLI for MP3/M4A fallback,
app icons, licence texts. Full component table in the distribution doc.

**Estimated installer size: 1.15–1.25 GB.** Size-reduction pass (INT8
quantisation, Demucs drums-only, drop madmom as bundled dep) drops that
to ~450 MB — same accuracy, easier to host.

### Toolchain

- **WiX Toolset v5** (MIT) — MSI authoring.
- **PyInstaller** — bundle Python + wheels into a redistributable tree.
- **Azure Trusted Signing** ($10/month) — cheapest path past SmartScreen.

### Windows integration

Start Menu entry, optional desktop shortcut, file associations for
`.mp3` / `.ogg` / `.flac` / `.wav` / `.m4a` / `.osu` / `.osz`, right-click
"Analyze with Overtone", uninstall via Control Panel. All opt-in.

### Portable ZIP variant

Same tree in a ZIP the user unpacks anywhere. No registry, no file
associations, reads settings from a `data\` subfolder. Ships alongside the
MSI for pen drives, sandboxes and locked-down PCs.

### Sub-phase timeline (~12 days on top of Phase 10)

| # | Adds | Days |
|---|---|---:|
| 10.13.1 | PyInstaller wrapper + reproducible wheel set + first unsigned MSI | 2 |
| 10.13.2 | WiX authoring: install flow, custom setup screen, file associations, uninstall | 3 |
| 10.13.3 | Model manifest + integrity checks + SBOM + third-party licence packaging | 1 |
| 10.13.4 | Size reduction: INT8 quantisation, drop madmom, drums-only Demucs | 2 |
| 10.13.5 | Portable ZIP variant | 1 |
| 10.13.6 | Code signing (Azure Trusted Signing) + documented signed release process | 2 |
| 10.13.7 | Build automation script (`build_release.py`) + release checklist | 1 |

### What is deliberately *not* included

- macOS `.pkg` and Linux `.AppImage` — the app runs on those platforms, the
  installers are out of scope.
- Microsoft Store / Winget submission — GitHub Releases is enough.
- Auto-update — Overtone has no network requirements; silent auto-update
  would be a policy change.


---

## Order of implementation

The dependency graph is not strictly linear. This is the order that maximises
early measurable gains and lets each phase build on the previous:

```
   0. Corpus B and measurement harness (must exist before any change)
    │
    ▼
   1. Fingerprint & reuse       — biggest single win, no ML
    │
    ▼
   2. Source separation         — every later phase gains from this
    │
    ▼
   3. Neural beat tracking      — the new baseline
    │
    ▼
   4. Multi-signal evidence  ── │
    │                            ├─ both feed the ensemble
   5. Rippling model         ── │
    │
    ▼
   6. Ensemble                  — puts everything together
    │
    ▼
   7. Rubato modelling          — for the hard cases
    │
    ▼
   8. Alignment feedback        — the polish pass
    │
    ▼
   9. osu! fine-tuning          — the domain-specific edge
    │
    ▼
  10. Chord/cadence + instrument detectors — marginal but real
    │
    ▼
  11. UX for slow but precise   — ships alongside the whole thing
```

Every step has a measurable target on Corpus B. Nothing ships without a
gain. `bpm-snapshot` and Corpus A gates remain green throughout.

## Cumulative accuracy projection on Corpus B

| After phase | % within 5 ms | Median error |
|---|---:|---:|
| today | 4.7 % | 60 ms |
| 10.1 (fingerprint) | ~40 %† | ~20 ms† |
| 10.2 (source sep) | ~48 % | ~15 ms |
| 10.3 (neural) | ~65 % | ~8 ms |
| 10.4 (multi-signal) | ~70 % | ~6 ms |
| 10.5 (rippling) | ~82 % | ~3 ms |
| 10.6 (ensemble) | ~87 % | ~2 ms |
| 10.7 (rubato) | ~89 % | ~1.5 ms |
| 10.8 (feedback) | ~91 % | ~1.3 ms |
| 10.9 (fine-tune) | ~93 % | ~1.1 ms |
| 10.10 (chords) | ~94 % | ~1 ms |
| 10.11 (instruments) | ~95 % | ~1 ms |

† 10.1 is bimodal: 100 % on tracks in the mirror, unchanged on tracks not.
The average depends on the mirror coverage; ~40 % is a rough figure assuming
half the user's tracks are in the ranked corpus.

## What this does not cover

Honesty section: what stays outside even this plan.

- **Genuinely rubato tracks the mapper hand-timed to their own feel.** No
  algorithm recovers a subjective interpretation exactly.
- **Aesthetic timing points** — those that mark section boundaries where the
  audio doesn't clearly change. The mapper places them because the map needs
  a red line there; the algorithm can only propose them from audio.
- **Tempo choices that are matters of taste** — 6/4 vs 3/4 with the same bar
  length, 200 vs 100 BPM notation. The algorithm picks one; the mapper may
  want the other.

For that residual, the escape valve is the assisted mode — the user taps two
downbeats and the algorithm rebuilds from there. It stays available even
after 10.11, and covers the ~5 % nothing else does.

## Free software licence audit

Every dependency named here is either MIT, LGPL, or open dataset:

| Component | Licence | Notes |
|---|---|---|
| Chromaprint | LGPL-2.1 | dynamic link |
| BeatThis | MIT | model weights CC-BY-4.0 |
| BeatNet | MIT | |
| madmom | MPI-2.0 | |
| Beat Transformer | MIT | |
| Demucs v4 | MIT | weights CC-BY-NC — verify commercial use |
| PyTorch | BSD-3 | |
| librosa | ISC | |
| Essentia | AGPL | subprocess boundary to preserve MIT project |
| osu! API | free, no key needed for GET | rate limit |
| Ballroom Dataset | research licence | tempo/meter labels |
| ADTOF | CC-BY-4.0 | drum transcription training |
| RWC | commercial licence — skip | |
| Isophonics Beatles | free for research | |

`Essentia`'s AGPL is the one that needs a careful boundary — anything statically
linked to it inherits AGPL. Kept as an optional subprocess so the core stays
MIT.

## Estimated timeline

Phase 10 total: roughly **4–6 weeks** of focused work. Each sub-phase is a
PR of 2–5 days.

Not urgent; not free either. The value is proportional to how much of
osu!'s mapping community adopts it. If Overtone becomes the tool ranked
mappers actually use, this is the plan that earns that.
