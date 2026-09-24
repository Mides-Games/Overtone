# DSP pipeline

Two halves, and the order matters:

- **Part A — the porting contract.** Reproduce v3 bit-for-bit-close. No improvements, no
  cleverness. The gate is the golden-vector diff plus 24/24 on the corpus.
- **Part B — improvements.** Each one behind a flag, each one measured against the same
  corpus, each one landing only if it wins.

Doing B before A is how a 0.16 ms tool quietly becomes an 8 ms tool. The audit's F-07 and
F-11 exist precisely because parts of v3 are unguarded, so B also means *adding the
missing gates first*.

---

# Part A — the porting contract

## A.1 Load

```
decode (Symphonia)  →  downmix mono f32  →  resample 44 100 Hz (rubato/soxr HQ)
                    →  peak-normalise to 0.99
```

Preserved from v3: header-first duration check before decoding (a mistyped path to a
3-hour file must cost nothing), NaN/Inf scrubbing, minimum 2 s, `MAX_AUDIO_SECONDS` = 3600.

Changed: **no FFmpeg**. Symphonia decodes MP3/AAC/ALAC/FLAC/Vorbis/WAV/MP4 in-process.
The resample is skipped when the source is already 44 100 Hz, as v3 does.

## A.2 Onset envelope — exact specification

v3 calls:

```python
librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop,
                             aggregate=np.median, fmax=11025, n_mels=128)
```

Everything else is a librosa default, and the defaults are load-bearing. Extracted from
the installed source (librosa 1.0.0, `onset.py::onset_strength_multi`,
`core/spectrum.py::power_to_db`, `filters.py::mel`) rather than from memory:

| Parameter | Value | Where from |
|---|---|---|
| `n_fft` | **2048** | `onset_strength_multi` default |
| `hop_length` | 128 (`FIT_HOP`) | passed by v3 |
| window | Hann, length 2048 | `melspectrogram` default |
| `center` | `True` | `melspectrogram` + `onset_strength_multi` |
| `pad_mode` | `"constant"` | `melspectrogram` default |
| `power` | 2.0 | `melspectrogram` default |
| `n_mels` / `fmin` / `fmax` | 128 / 0 / 11025 | v3 passes n_mels and fmax |
| mel scale | **Slaney** (`htk=False`) | `filters.mel` default |
| mel filter norm | **`"slaney"`** (area) | `filters.mel` default |
| `power_to_db` | `ref=1.0`, `amin=1e-10`, `top_db=80.0` | `power_to_db` defaults |
| `lag` | 1 | default |
| `max_size` | 1 ⇒ `ref = S` | default |
| `detrend` | `False` | default |
| aggregate | `np.median` over the 128 mel bands | v3 passes it |

Algorithm, in order:

```
1.  S    = |melspectrogram(y, n_fft=2048, hop, hann, center, power=2)|      [128 × T]
2.  S_db = power_to_db(S, ref=1.0, amin=1e-10, top_db=80)
3.  D    = S_db[:, 1:] - S_db[:, :-1]                    (lag = 1, ref = S_db)
4.  D    = max(0, D)
5.  env  = median(D, axis=mel)                                              [T-1]
6.  env  = pad_front(env, lag + n_fft // (2 * hop) = 1 + 8 = 9 zeros)
7.  env  = env[:T]                                       (center ⇒ truncate)
8.  env  = env / percentile(env, 99.5)                   ← v3's own step
9.  env  = clip(env, 0, 1.5)
```

Three traps for the port, all of which will show up as a golden-vector mismatch:

- **Step 6's pad width depends on `n_fft` and `hop`.** `1 + 2048 // (2·128) = 9`. Get it
  wrong and every attack is off by a constant 9 frames × 2.9 ms = **26 ms**, which the
  sample-resolution re-timing in A.4 would partially mask — the worst kind of bug.
- **`top_db = 80` clips relative to the global maximum of the dB spectrogram.** The
  envelope is therefore *not* a purely local function of the audio: one loud transient
  raises the floor everywhere. Chunked or streaming STFT must compute the global max
  before the clip, or results differ from v3. This is also why incremental analysis
  (`overtone-project`) treats the envelope as a whole-file artefact.
- **Slaney-normalised mel filters**, not HTK, not unit-norm. A different mel basis changes
  the median across bands and therefore every peak height.

The fallback path (`_fast_onset_envelope`, a plain STFT flux with `nperseg=1024`) ports as
`OnsetFn::Flux1024`; it exists so a mel-filter bug cannot take the whole tool down.

## A.3 Peak picking

`scipy.signal.find_peaks(env, distance, prominence=0.05, height=floor)` with
`distance = round(0.025·sr/hop)` (= round(8.61) = 9 frames ⇒ 26.1 ms minimum spacing at
44.1 kHz / hop 128) and
`floor = max(0.04, percentile(env, 55))`; if nothing is found, retry with `distance` only.
Then parabolic sub-frame interpolation with the shift clamped to ±0.5 frames.

`scipy`'s `prominence` is a specific algorithm (bases found by walking outward to the
nearest higher peak). The port must implement *that*, not a naive neighbourhood test.
It is the second most likely source of divergence after the mel basis.

## A.4 Sample-resolution attack re-timing

The step that turns 8.37 ms into 0.16 ms. Per attack, on the **raw waveform**:

```
window  = round(0.0015·sr)  = 66 samples (1.5 ms)
search  = [t − 30 ms, t + 12 ms]
energy(i) = sqrt(cumsum(y²)[i+window] − cumsum(y²)[i])
top  = argmax(energy)                  ; base = min(energy[0..top])
if energy[top] <= base·1.6 or <= 1e-7 : keep the envelope time   ← do not snap to noise
level = base + 0.20·(energy[top] − base)
j     = last index ≤ top with energy ≤ level
t'    = (lo + j + frac + window) / sr           (linear interp for frac)
accept t' only if |t' − t| ≤ 30 ms
```

Then re-sort, and drop any attack within 4 ms (inclusive) of its sorted predecessor,
keeping the earlier one whatever the weights (re-timing can collide two peaks; v3 and the
port both do exactly this). The `1.6×` guard and the `+ window` term are both easy to lose and
both matter.

## A.5 Circular coherence

```
R(f) = |Σ w·e^{2πi f t}| / Σ w
f ∈ [1/1.35, 1/0.055] Hz,  step = 0.2 / span
```

Peaks with `distance=2`, keep those ≥ 0.55 × best, slowest first, at most `keep = 10`.
Phase from **`φ = arg(z)/(2πf)`** — *not* `−arg(z)`. This sign is the single largest error
source in v3's history and it gets the first ported test.

Candidates are then widened to multiples ×1..×4 of each peak (dedup at 4 ms), because the
slower reading still contains every attack and keeps swung music fittable.

Port note: this is the one kernel where the Rust version should differ in *shape* — v3
blocks 512 frequencies at a time through a dense `outer` product. Rust does the same
arithmetic with an explicitly SIMD-friendly loop over `(t, w)` pairs, accumulating
`cos`/`sin` per frequency. Same result to float tolerance, ~20× faster, and it is what
makes the Part B full-track sweep affordable.

## A.6 IRLS grid fit

```
for tol_ratio in (0.30, 0.18, 0.10, 0.06, 0.04):
    if this is the 3rd pass (index 2):  phase = recentre_phase(...)
    k       = round((t − phase) / period)
    inlier  = |t − (phase + k·period)| ≤ max(tol_ratio·period, 0.006)
    require ≥ 4 inliers and peak-to-peak of k ≥ 2
    weighted least squares of t ≈ phase + k·period over inliers
    reject the pass if new_period ∉ [0.5·period, 2·period]
```

`recentre_phase` **at pass index 2 exactly** — after the period is trustworthy, before the
tolerance narrows enough to lock a biased phase in. Moving it changes shuffle results by
milliseconds.

`recentre_phase` itself: residuals wrapped to ±½ period, scored against 401 candidate
shifts with a Gaussian of width `min(0.012, 0.06·period)`, take the **argmax** (mode), not
the mean.

`expand_fit`: doubling windows from ±12 s around the centre until the span is covered,
refitting at each size, so a 1 % seed error is absorbed without slipping a beat index.

`quality` → `(share, coverage, rms_ms)` at `tol_ratio = 0.12`:
`share` = inlier weight fraction, `coverage` = unique occupied k / spanned slots.

## A.7 Seed selection

Windows `(30, 16, 9)` s — `(12, 7, 4.5)` during section growth — shrinking until a grid
locks. Reject candidates with `rms > 0.09·period·1000` ms. Rank by
**`share × (0.25 + 0.75·coverage)`**; stop early at ≥ 0.45. Near-ties (≥ 0.92 × best) go
to the slowest grid, or with a prior, to whichever keeps the same octave.

The timeline records that "slowest strong coherence peak" and a fixed `share ≥ 0.72` gate
were both tried and both fail (uniform click tracks halve; ornamented music is rejected at
share 0.53). **Do not re-litigate this during the port.**

## A.8 Octave

`atoms_per_beat ∈ (1,2,3,4,5,6,7,8,9,10,12,16)`, scored per candidate `m`:

```
score(m) = 0.95·hint_score(bpm)
         + 0.85·min(depth / 0.35, 1)
         + 0.70·coverage
         + 0.40  if prefer_map_bpm and 120 ≤ bpm ≤ 300
         − 0.45·max(0, log2(90 / bpm))
         − 0.45·max(0, log2(bpm / 340))
```

`depth = (max(class means) − min(class means)) / max(class means)` over attack classes
`k mod m`. `hint_score` is a Gaussian in log2-tempo space (σ = 0.35) against tempogram
hints read under librosa's log-normal prior centred on 120 BPM.

**This path has no test in v3 (audit F-07).** The ported implementation gets an
octave-agreement test against v3's output on all 24 fixtures before anything here is
touched.

## A.9 Sections

Grow forward while a fresh chunk keeps fitting (`share ≥ 0.55` and
`rms ≤ 0.09·period·1000`); each new region **re-seeds its own coherence scan**; merge
neighbours within `min_delta` or shorter than `persistence·period`; fold a too-short tail
backwards; settle boundaries for 2 rounds at the **grid crossing** (not at a residual
minimum — it is flat there); refit every section on its own attacks with tight ±0.15
period margins.

Thresholds scale by `m` when applied at the atom level (v3 fixed a bug where `min_delta`
was divided instead of multiplied — keep the multiplication).

## A.10 Points, meter, confidence, export

- First red line anchored to a **downbeat only when accents prove the bar** (`meter_beats`
  is 1 otherwise); subsequent lines to the first beat at/after the section start.
- `confidence = 0.55·tightness + 0.30·min(1, coverage·1.15) + 0.15·length_bonus`.
- `snap_timing_points`: nudge a change onto the previous grid **only** when it is within
  0.25 beat; a larger "correction" would invent an error.
- `.osu` offsets as **whole milliseconds** by default; `--decimal-offsets` for lazer.
- Global BPM = duration-weighted **median** across sections.

## A.11 Fallback

v3 falls back to the v2 hybrid tracker (librosa DP + PLP + peak picking). Porting that
means porting librosa's beat tracker, which is a large amount of work to reproduce an
engine whose measured output on the degenerate corpus is a staircase of 8 sections on a
tempo ramp and `127.68 BPM` on white noise.

Decision: **do not port v2.** Instead:

1. `reference/python-v3` stays runnable and remains the way `--engine legacy` numbers are
   produced for the benchmark table. Nothing is lost that can be measured.
2. v4 ships an **elastic grid** (Part B.1) as the non-constant-tempo path, which is what
   the v3 timeline's own Open Items propose.
3. When neither a constant grid nor an elastic one fits, v4 **refuses with a diagnostic**
   rather than returning a tracker's guess. White noise returning a BPM is not a feature.

This satisfies "do not remove v3's engine without an equal or better replacement" on the
only terms that can be checked: the ramp and pad fixtures must come out better than a
staircase, and the no-answer fixtures must say no.

---

# Part B — improvements, each gated

Ordered by expected value. Every one lands only with a measured win on the ported corpus,
and every one is reversible by a flag.

## B.1 Elastic grid for rubato and drifting tempo

**Problem.** The measured baseline on `tempo ramp 120→160` is `engine=legacy,
sections=8`, i.e. a staircase approximating a smooth accelerando. Unusable output.

**Design.** Generalise the model from constant period to a slowly-varying one:

```
t(k) = φ + Σ_{j<k} p(j)          with  p(j) a monotone cubic spline in k,
                                 few knots (1 per ~16 beats), λ‖p″‖² regularised
```

Fitted with the same IRLS machinery — the design matrix changes, the robustness story does
not. Reduces to the constant grid when the spline is flat, so it is a strict
generalisation, and the tempo-curve visualisation becomes the model output rather than a
post-hoc estimate from short local fits.

**Gate:** ≤ 1 section and a monotone BPM curve within 1 BPM of truth on a new ramp fixture
with ground truth; zero change on all 24 constant fixtures.
Difficulty **high** · impact **high** · no ML · no GPU.

## B.2 Per-section octave decision

**Problem.** Audit **F-11**: `change-175-87.5` reports `1/2` sections. An exact halving is
not a tempo change at the atom level, so section growth correctly never splits — but the
octave is decided **once, globally**, on the anchor window, so the half-time region is
reported at the wrong beat rate. Half-time drops and double-time choruses are everywhere
in osu!'s music.

**The signal is measured and strong.** `bench/gates.py coverage` reports, on three
purpose-built fixtures:

```
halftime-175-87.5   coverage 0.625..1.000  drop 0.359  at 30.8s   truth 32.17s
halftime-150-75     coverage 0.533..1.000  drop 0.447  at 29.3s   truth 28.10s
doubletime-110-220  coverage 0.529..1.000  drop 0.456  at 26.98s  truth 26.44s
```

Coverage on a **subdivided** grid halves; `share` does not move (it stays at 1.000 against
a 0.55 break) so the one statistic `_grow_sections` consults cannot fire. The change
localises to within one 8-beat window. Note the subdivision: at beat level coverage is
1.000 across the whole track, because the slow half's attacks land on every beat.

**Design.** Add coverage to the growth gate — the statistic `_seed_grid` already ranks
candidates by and `_grow_sections` currently discards. Then decide `m` **per region** by
running the accent-depth scorer on that region's own attacks, and split where consecutive
regions disagree on `m` — a split on the shared atomic grid, so both sides stay exact and
the boundary is exact by construction. Hysteresis on `m` so a 2-bar fill cannot flip it.

**And surface it rather than deciding it.** Whether a half-time region wants its own red
line is a judgement call of the same kind as the global octave: mapping the whole track at
175 is defensible, and v3's README says to do exactly that. So the deliverable is a
**bidirectional** pulse hint with confidence — `suggest_section_pulse` can currently only
propose `×2` (audit **F-11**) — plus one-click apply, not a silent split.

**Gate:** a new fixture with a genuine 175 → 87.5 change must report `2/2` scored
**without** the octave allowance, and no currently-green fixture may change its BPM.
Difficulty **medium** · impact **high** · no ML · no GPU.

## B.3 Full-track 2-D coherence map

**Enabled by the language, not by cleverness.** v3 anchors the octave/seed scan on one
densest 90 s window because the sweep is expensive in NumPy. In Rust the same sweep is
microseconds, so compute `R(t, f)` over the whole track on a sliding window.

Gives three things for one cost:
- better section seeds (the map *shows* where the pulse changes, before any growth loop);
- the **timing confidence map** the brief asks for, as a first-class visualisation;
- a tempogram replacement (B.4).

**Prerequisite:** A.5's Rust kernel, and the audit's warning that widening seed windows is
what would have triggered F-01 — fixed in this audit.
Difficulty **medium** · impact **medium-high** · no ML · GPU **no** (it is already trivial on CPU).

## B.4 Drop librosa's tempogram for the octave hint

Once B.3 exists, `hint_score` can read the coherence map under the same log-normal prior,
removing the last librosa-shaped dependency in the accuracy path *and* the 4× max-pooling
hack v3 needed to make the tempogram affordable.

**Hard gate:** this changes the octave decision, which the corpus does not check
(F-07). It cannot land before the octave-agreement test exists, and it must match v3's
`atoms_per_beat` on all 24 fixtures or the disagreement must be shown to be an
improvement, per fixture, by listening.
Difficulty **medium** · impact **medium** (removes a dependency, not an error) · no ML · no GPU.

**Measured, and rejected as specified.** Reading the map surface (per-column
normalised mean R under the same log-normal prior) ranks the *atom* first:
R is ~1.0 at the pulse and ~0.18 at the beat on accented tracks, and no
honest prior closes a 5× gap — the prior would have to want the answer
before seeing the evidence. Ported and gated, it flips 5 of 24 octave
decisions (change-128-142, decimal-128.37, secs-2, secs-3, three-sections,
all m=2 → m=1). The tempogram's autocorrelation of the envelope measures
genuinely different information (energy self-similarity, beat-first: best
hint 172.27 on the 174 fixture) and the ported Rust version costs **8 ms**
a track, 49 ms on the 6-minute fixture — v3's "ten seconds" was NumPy loop
overhead the port already killed, and realfft stays in the workspace for
the STFT regardless. So both stated motivations are gone and the change is
all risk. If hints are ever re-sourced, the candidate is autocorrelating an
envelope *rebuilt from the attacks* (same information, no mel contract) —
as a Python prototype with the 24/24 octave gate, not as a port.

## B.5 SuperFlux onset function

Vibrato-suppressed spectral flux (Böck & Widmer): a maximum filter across frequency before
differencing, which stops vibrato and legato pitch movement from producing false onsets.
Cheap, well-established, and aimed exactly at the material where v3 currently falls back.

Offered as an alternative `OnsetFn`, selected automatically when the mel-flux envelope has
low peak contrast (the signature of non-percussive audio).
**Gate:** no change on the 24 percussive fixtures; measurable improvement on new
pad/strings/vocal fixtures. Difficulty **low** · impact **medium** · no ML · no GPU.

**Measured, and rejected as specified.** A max-filtered (±1 mel band) median
flux was built and scored against mel-flux with identical peak picking:

- dense triads with ±7 % vibrato: SuperFlux F=0.222 vs mel F=0.276 — the
  max-filter masks new partials landing near decaying old ones (masking
  also arrives as latency: matched peaks land up to 150 ms late);
- real pads (`_ambient.wav`): identical picks, 17 vs 17 — no recall gain
  where it was supposed to help;
- percussive control: identical picks, 346 vs 346;
- solo legato line with wide leaps: SuperFlux F=0.333 vs mel F=0.125 —
  the one place the mechanism works, at poor absolute recall (3/8).

The median (not the paper's sum) was required to keep narrowband flicker
from drowning recall, and linear magnitudes beat dB (the log lift promotes
vibrato residue) — both deviations were measured, neither closed the gap.
Peak contrast as a selector was also miscalibrated: percussive envelopes
are sparse (median ~0), so contrast must read peak height (pads never crest:
p99 0.000 vs ≥0.72), and that routes pads but never the mono lines where
SuperFlux wins. Shipping auto-select would trade a documented loss on the
common case for a win on a slice with no routing signal and no corpus.
Revisit only with a mono/poly selector and a non-percussive corpus — until
then the honest answer on pads stays the no-grid refusal, which is gated.

## B.6 Band-limited attack re-timing

A kick's physical attack in a full-band signal is smeared by the hat on top of it. Re-time
each attack on the band where *its* energy is, using the multi-band flux (which the
hitsound engine needs anyway) to pick the band. Plausibly worth a few tenths of a
millisecond on dense mixes; the measured worst case today is `shuffle-96` at 2.26 ms.
**Gate:** median offset error must not regress on any fixture.
Difficulty **medium** · impact **low-medium** · no ML · no GPU.

**Measured, and rejected as specified.** On a synthetic kick with a hat 3 ms on top
(the `bandpass.rs` test), re-timing on the kick's own narrow band came out **+9 ms
late** — the band's ringing outlasts the smear it removes — and a submix of bands 0-2
**-4.5 ms early** from skirt pre-ring. A gentle lowpass (RBJ, Q = 0.5) does halve the
smear (0.96 ms against 1.86 ms full-band) and is the candidate if this is picked up
again; it is built and tested but not wired into the engine, and nothing has been
measured on the corpus.

## B.7 Parallelism and caching

- STFT frames and the coherence sweep over `rayon`; per-file parallelism for batch.
- Peak pyramid, envelope, attacks and spectral features cached under
  `blake3(audio) + engine_version + params_hash`; parameter changes recompute only
  downstream stages (see [`03-architecture.md`](03-architecture.md) §`overtone-project`).
- Octave changes recompute **nothing** — v3's exact `rebuild_with_subdivision` insight.

**Target, to be measured not assumed:** the 6-minute fixture from 5.0 s (measured, Python,
single-threaded) to under 0.5 s; the full 24-track corpus from 21.6 s to under 3 s.
Difficulty **low-medium** · impact **high** · no ML · no GPU.

## B.8 Explicitly rejected

| Idea | Why not |
|---|---|
| GPU compute for STFT / coherence | ~124k frames of 1024-pt real FFT is well under a second on CPU with rayon. Transfer + launch overhead, driver variance and a second numeric path to validate, for a fraction of a negligible cost |
| ML tempo estimation | The fit is already exact (0.0000 BPM median). A learned estimator would be worse and unexplainable |
| Neural source separation in the tempo path | Latency and model size for no accuracy gain. It has a real role in the *hitsound* engine — see [`08-machine-learning.md`](08-machine-learning.md) |
| Replacing IRLS with RANSAC / L1 | `recentre_phase` already solves the multi-population problem that motivates them, and it was measured (17 ms → 0.09 ms) |
| Higher `FIT_HOP` resolution | Attack times come from the raw waveform at sample resolution; the envelope hop only has to find the peak, and 2.9 ms already does |

---

## Validation plan

| Layer | Content | Gates |
|---|---|---|
| Unit | all 55 v3 tests, names preserved; coherence-sign test first | every commit |
| Property | ×2 then ÷2 is the identity; an exact synthetic grid is recovered to float precision; boundaries are monotone; `.osu` round-trip is byte-identical | every commit |
| Golden vectors | per-stage JSON from `reference/python-v3` on all 24 fixtures: attacks ≤ 0.05 ms, period ≤ 1e-6 s, offsets ≤ 0.05 ms | every commit |
| Accuracy corpus | 24 fixtures + the 4 degenerate + new fixtures for F-07, F-11, rubato, non-percussive | every commit (21.6 s today) |
| Performance | per-stage wall time vs a committed budget | every commit |
| Fuzz | `.osu` reader, config reader, audio header | nightly, locally |
| Real audio | a small set of tracks hand-timed in the osu! editor | manual; the timeline already calls this out as the honest complement to synthetic ground truth |
