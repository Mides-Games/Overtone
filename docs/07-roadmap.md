# Roadmap

Ten phases, plus the precision plan (Phase 10) and the comfort phases (12–18). Each
feature carries: **Diff** (difficulty) · **Imp** (impact) · **Deps** · **ML** · **GPU** ·
**Pri** (priority: P0 blocking, P1 core, P2 valuable, P3 optional) · **Status**.
Anything not worth building is in [Rejected ideas](#rejected-ideas), with the reason.

Phases are ordered by dependency, not by appetite. The only hard rule: **the Rust engine
must match the measured v3 baseline** — 24/24 within 0.05 BPM and 5 ms, median
0.0000 BPM / 0.16 ms. Everything else is negotiable; that is not.

---

## Where we are — 2026-09-23

**Stage: the app is usable end to end in Python; the Rust engine is at parity but not yet
plugged into the app.**

| Area | State |
|---|---|
| Timing engine (Python v3) | **works** — 24/24 corpus, median 0.0000 BPM / 0.16 ms, all gates green |
| Timing engine (Rust v4) | **at parity** — matches v3 attack for attack and red line for red line on 24/24, ~9x faster; **not used by the app yet** |
| App (web shell) | **usable** — analyse, edit, undo/redo, lock, export (.osu / CSV / click / .osz), inject, compare with a map, alignment, density, suggestions, folder import, recents, EN/ES |
| osu! files | **works** — full reader, byte-identical writer, atomic write + backup |
| Validation | **first rules live** — duplicates, short sections, impossible changes, suspicious offsets, octave checks |
| Hitsound engine | **half built, Rust only** — features, 13 instrument classes, musical role; no decision, editor or export; not in the app |
| Playback | **missing** — no audio or live click inside the app |
| Precision plan (Phase 10) | **not started** — plan only |
| Installer (MSI) | **not started** — plan only |

Tests: **191** Python (122 engine + 69 web shell) · **177** Rust.

### What is pending, in order

1. **Fix the known bugs** (next section) — they break promises the tool makes.
2. **Playback in the app** (Phase 4) — hear the song with the click, scrub, loop.
3. **Plug the Rust engine into the app** — the ~9x speed-up reaches the user.
4. **Timeline** (Phase 3) — waveform, zoom, drag red lines.
5. **Hitsounds** (Phase 6) — decision, editor, export; then show them in the app.
6. **Real-audio accuracy** (Phase 10) — build Corpus B first, then one sub-phase at a time.
7. **Installer** (Phase 10.13) — MSI + portable ZIP.

### Known bugs to fix

Each was reproduced with a probe, not just read in the code.

| Bug | Why it matters |
|---|---|
| **Inject resets sampleset, volume and kiai** on every new red line (hard-coded `…,1,0,100,1,0`) and writes the timing section out of time order | breaks rule 5: fields the user did not ask to change must come out unchanged |
| **Python engine returns a BPM for white noise** (127.68 in the benchmark's degenerate inputs) | breaks rule 2; the Rust engine already refuses |
| Classic Tk window: toolbar buttons are clipped at the default size (every ghost button has an 11-character minimum) | CSV / Copy .osu hard to reach in the classic window |
| Classic Tk window: ×2 / ÷2 silently throws away manual edits | lost work; the web shell has undo, the classic window does not |

### To verify (reported by the audit, not yet confirmed)

The 2026-09-22 audit ran out of budget before its verifiers finished, so these stay
unconfirmed until a probe reproduces them:

- the first red line can land **half a beat late** on a constant-tempo track whose first
  beat sits on the atom grid (Python and Rust);
- the meter path can **hide a real tempo change** (128 → 150) when the song has a clear
  downbeat;
- Rust chroma gives the **wrong pitch class below ~360 Hz** (bass notes);
- licence claims in `10-precision-plan.md` / `11-msi-distribution.md` (WiX is not MIT;
  madmom model files and Demucs weights have their own terms) — check before any is bundled;
- `CLAUDE.md` still says 76 / 75 tests and lists 5 crates.

---

## Phase 0 — Architecture and gates

Nothing here produces a feature. It produces the ability to know whether later phases
broke something, which is why it is first.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Toolchain | MSVC Build Tools + rustup MSVC target | — | — | — | no | no | **P0** | **done** |
| Workspace skeleton | crates + dependency rules | low | high | toolchain | no | no | **P0** | **done** — 6 crates; `check-deps` rule not automated |
| `reference/python-v3` | move v3 in, keep it runnable | low | high | — | no | no | **P0** | todo — still `overtone.py` at the root |
| `requirements.lock` | exact versions behind the measured baseline — **F-05** | trivial | med | — | no | no | **P0** | **done** |
| Golden-vector dump | per-stage attacks, seeds, octave, sections, points | med | **high** | — | no | no | **P0** | **done** |
| Golden-vector check | stage-by-stage diff, so a divergence names its stage | med | **high** | dump | no | no | **P0** | **done** |
| Corpus port | the 24 fixtures run through the Rust engine | med | **high** | skeleton | no | no | **P0** | **done** — `overtone-bench golden` |
| **Octave-agreement gate** | pins absolute BPM per fixture — closes **F-07** | low | **high** | — | no | no | **P0** | **done** |
| **Density-change gate** | measures the coverage signal — closes **F-11** | low | high | — | no | no | **P0** | **done** |
| Pulse-hint regression test | documents the one-directional hint gap | trivial | low | — | no | no | P1 | **done** |
| Perf gate | per-stage budget vs measured baseline | low | med | corpus | no | no | P1 | todo |
| `.gitignore` scoping | stop ignoring `*.osu` repo-wide — **F-09** | trivial | low | — | no | no | P1 | **done** |

**What the gates cover:**

```bash
python bench/gates.py bpm-snapshot     # 24/24 readings unchanged
python bench/gates.py coverage         # signal present in 3/3 density fixtures
python bench/golden.py check           # 24/24 cases match stage for stage
```

The first pins the octave, which the accuracy benchmark normalizes away. The second
measures the coverage drop that `_grow_sections` discards. The third is the harness the
Rust engine is pointed at: 362 KB of committed per-stage vectors across the 24 fixtures.

**Exit: met.** The harness runs, produces v3's numbers from v3, and fails when the Rust
engine disagrees.

---

## Phase 1 — Core engine port

The whole of [`05-dsp-pipeline.md`](05-dsp-pipeline.md) Part A, and nothing from Part B.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| `overtone-core` types | unit newtypes, serde, errors, diagnostics | low | med | P0 | no | no | **P0** | **done** |
| Symphonia decode | MP3/AAC/ALAC/FLAC/Vorbis/WAV/MP4 — **removes FFmpeg** (F-06) | med | **high** | — | no | no | **P0** | **done** |
| Mel-flux envelope | the exact librosa contract (DSP §A.2) | **high** | **high** | decode | no | no | **P0** | **done** |
| Peak picking | scipy `find_peaks` prominence semantics + parabolic interp | med | high | envelope | no | no | **P0** | **done** |
| Attack re-timing | sample-resolution 20 % rise walk (DSP §A.4) | med | **high** | decode | no | no | **P0** | **done** |
| Coherence sweep | `R(f)`, correct phase sign, ×1–4 widening | med | **high** | attacks | no | no | **P0** | **done** |
| IRLS fit | tolerance ladder, mode re-centring at pass 2, expanding windows | med | **high** | coherence | no | no | **P0** | **done** |
| Octave decision | accent depth + tempogram hints | high | high | fit | no | no | **P0** | **done** |
| Sections | grow · re-seed · merge · crossing boundaries · refit | high | **high** | fit | no | no | **P0** | **done** |
| Meter, confidence, points | downbeat anchoring, snapping, whole-ms export | med | high | sections | no | no | **P0** | **done** |
| Analysis assembly | beats, local curve, global BPM, stability, residual | med | high | points | no | no | **P0** | **done** |
| Unit tests ported | the v3 tests by name | med | **high** | all | no | no | **P0** | partial — 177 Rust tests; not every v3 name |
| Property tests | ×2/÷2 identity, exact-grid recovery, monotone boundaries | low | high | all | no | no | P1 | partial |
| Structured diagnostics | carried on the result, not in a progress string — closes **F-08** | low | med | all | no | no | P1 | **done** (Rust) |
| **App uses the Rust engine** | Python binding (PyO3) or JSON subprocess, so the shell gets the speed-up | med | **high** | all | no | no | **P1** | todo |

Agreement with v3 on all 24 fixtures:

| stage | agreement with v3 |
|---|---|
| attacks | exact — worst 0.0001 ms against a 0.05 ms tolerance |
| coherence candidates | the list contains the grid v3 seeded, every fixture |
| anchor seed | period within 1e-11 to 2.6e-7 s |
| octave | **exact on all 24** |
| sections, meter, red lines, global BPM | all 34 red lines match |

Speed, measured:

| | Python v3 | Rust | |
|---|---|---|---|
| 24-track corpus | 21.6 s | **2.53 s** | 8.5x |
| 6-minute fixture | 5.0 s | **0.51 s** | 9.8x |

Two things got there and neither was the language: a **sparse** mel filterbank and an STFT
**fused** into the mel projection, so the linear spectrogram is never materialised.

**Exit: met for the engine** (golden 24/24 attack for attack and red line for red line).
Still open: the rest of the v3 unit tests by name, and wiring the engine into the app.

---

## Phase 2 — Audio analysis beyond parity

Part B of the DSP doc, in the order its gates can be met.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Parallel + cache | rayon stages, content-keyed cache | med | **high** | P1 | no | no | **P1** | partial — result cache in the shell (re-analysis 2.04 s → 0.02 s); no rayon stages |
| **Per-section octave** | half/double-time regions get their own beat rate — **F-11** | med | **high** | P1, fixture | no | no | **P1** | **ported** — matches the prototype 4/4, 0 FP |
| 2-D coherence map | `R(t,f)` full-track: better seeds + confidence map | med | high | P1 | no | no | P1 | **ported** |
| **Elastic grid** | tempo model for ramps; a **selector** beside the piecewise fit | **high** | **high** | IRLS | no | no | **P1** | **ported** as polynomial-in-k — 0.16 BPM on realistic ramps; extreme ramp needs the spline |
| No-grid verdict | refuse honestly instead of a white-noise BPM | low | med | elastic | no | no | P1 | **done in Rust** — Python still answers (see known bugs) |
| SuperFlux ODF | vibrato-suppressed flux | low | med | envelope | no | no | P2 | **rejected** — measured: no win on pads |
| Drop librosa tempogram | octave hint from the coherence map | med | med | 2-D map | no | no | P2 | **rejected** — measured: 5 octave flips |
| Multi-band flux | 7-band onset functions; also feeds hitsounds | low | med | STFT | no | no | **P1** | **done** |
| HPSS | harmonic/percussive separation | med | high | STFT | no | no | **P1** | **done** 2-way; residual open |
| Band-limited re-timing | re-time each attack in its own band | med | low-med | multi-band | no | no | P3 | partial — measured no general win; wiring deferred |
| Structure analysis | novelty curve → phrases, energy map | med | high | chroma/MFCC | no | no | **P1** | **done** |
| Section classification | intro/verse/chorus/bridge labels | med | med | structure | opt | no | P2 | **done** |

The two starred items were prototyped and measured in [`../proto/`](../proto/) before any
Rust was written: density detection **4/4 found, 0 false positives out of 23**; elastic
grid **0.144–0.163 BPM** on realistic ramps. Details in [`../proto/README.md`](../proto/README.md).

None of Phase 2 reaches the app yet: it lives in the Rust crates.

---

## Phase 3 — Modern UI

**Decision (2026-09-22):** the UI is a **web shell** — HTML/CSS in a native WebView2 window
(`app/` + `overtone_web.py`, pywebview). It gives real rounded corners, shadows and a
canvas timeline today on the Python engine, and the same frontend moves to Tauri when the
Rust engine replaces the backend. The Tk window stays as the classic fallback.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Shell + tokens | window, theme, typography, bridge | med | **high** | P1 | no | no | **P1** | **done** — pywebview now, Tauri later |
| Binary transport | fast channel for peaks/envelope/attacks | med | **high** | shell | no | no | **P1** | todo — JSON bridge today |
| Peak pyramid | LOD min/max waveform, computed once, cached | low | **high** | audio | no | no | **P1** | todo |
| **Timeline** | waveform · onsets · grid · attacks · sections · red lines | **high** | **high** | transport | no | opt | **P1** | partial — canvas tempo map with onsets, sections and red lines; no waveform |
| Zoom / scroll / select | cursor-anchored zoom, range selection, keyboard nav | med | **high** | timeline | no | no | **P1** | partial — click and ↑/↓ select; no zoom |
| Tempo curve layer | local BPM over time | med | high | timeline | no | no | **P1** | **done** |
| Hover readout | time, tempo, governing red line | low | high | timeline | no | no | **P1** | **done** |
| Stat cards | BPM, points, beats, stability, engine, residual | low | med | shell | no | no | P1 | **done** |
| Progress panel | per-stage ticks and timings, cancellable | low | med | shell | no | no | P1 | partial — stage messages; no timings, no cancel |
| Dashboard | drop target, recents, folder entry points | low | med | shell | no | no | P1 | **done** |
| Honesty banners | fallback engine, late first line, validation findings | low | **high** | shell | no | no | P1 | **done** |
| Confidence ribbon | per-section confidence under the ruler | low | med | timeline | no | no | P2 | todo — per-point bars in the list only |
| Spectrogram layer | optional spectral energy | med | low-med | STFT | no | yes | P3 | todo |
| Light theme | full token counterpart | low | low | tokens | no | no | P3 | todo |

---

## Phase 4 — Playback and timing editor

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Transport | play/pause/seek inside the app | med | **high** | audio | no | no | **P1** | todo |
| Live click track | click synthesised against the *current* timing points | med | **high** | transport | no | no | **P1** | todo — click exported as a WAV only |
| Playhead sync | position on the timeline at 60 Hz | low | high | transport | no | no | **P1** | todo |
| Scrub + loop | scrubbing, loop selection, loop section | med | high | transport | no | no | P1 | todo |
| Play from beat / point | click a beat or red line to play from it | low | med | transport | no | no | P2 | todo |
| Grid editor | edit offset/BPM, ±1 ms nudge, ×2/÷2 | med | **high** | P1 | no | no | **P1** | **done** (web shell) |
| Add / delete / split / merge | with recalculation | med | high | editor | no | no | **P1** | partial — add and delete; no split/merge |
| **Lock timing point** | protect a verified point from re-analysis | low | high | editor | no | no | P1 | **done** |
| Undo/redo | one stack per song | med | high | editor | no | no | P1 | **done** (web shell) |
| Click-accent meter fix | accent on the detected meter — closes audit **F-03** | trivial | low | click | no | no | P1 | **done** |

---

## Phase 5 — osu! integration

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Full `.osu` reader | all sections, hitobjects, sliders, SV, samples; unknown keys kept | **high** | **high** | — | no | no | **P1** | **done** (Python) |
| Span-preserving writer | untouched fields come out byte-identical | high | **high** | reader | no | no | **P1** | **done** (Python) |
| Atomic write + backup | temp+rename, `.bak` never overwritten | low | **high** | writer | no | no | **P1** | **done** |
| Timing injection | red-line replacement, greens preserved | med | **high** | writer | no | no | **P1** | **done, with a bug** — resets sampleset/volume/kiai (see known bugs) |
| Parser fuzzing | fuzz the reader | low | high | reader | no | no | P1 | todo |
| Beatmap folder import | audio + all difficulties from one folder | low | med | reader | no | no | P1 | **done** |
| **Map vs detected compare** | per-section BPM/offset diff table | med | **high** | reader, P1 | no | no | **P1** | **done** |
| Audio/object alignment | do the map's objects land on real attacks? | med | **high** | reader, attacks | no | no | **P1** | **done** |
| lazer compatibility | decimal offsets, `.osu` v14+ specifics | low | med | writer | no | no | P2 | todo |
| **Per-section meter** | each red line carries the bar its own section proved | med | high | meter | no | no | **P1** | **done** |
| **Downbeat anchoring** | every red line lands on a downbeat | med | high | meter | no | no | **P1** | **done** |
| Meter-change detection | split on time signature, not only on tempo | high | med | sections | no | no | P2 | **done** for a constant bar |
| Bar-length change | 4/4 → 3/4 keeping the *beat* | high | med | meter | no | no | P2 | todo |
| `.osz` export | audio + a minimal `.osu` in a zip | med | high | writer | no | no | P2 | **done** |

The measure-based rows come from comparing against [Tempora](https://github.com/teamkongehund/Tempora),
which times a song by pairing audio points to a timeline of measures. Overtone automates
the pairing (`t(k) = offset + k·period`, fitted over hundreds of attacks); the measures
were what was missing.

---

## Phase 6 — Hitsound engine

All of [`06-hitsound-engine.md`](06-hitsound-engine.md). **Rust only; nothing of it is in
the app yet.**

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Per-attack features | 7 bands, centroid/rolloff/flatness/crest, rise/decay | med | **high** | P2 HPSS | no | no | **P1** | **done** |
| Harmonicity + pitch | HPS pitch, formants | med | high | features | no | no | **P1** | **done** — inharmonicity deferred |
| Instrument templates | 13 scored classes, explainable | high | **high** | features | no | no | **P1** | **done** — F1 0.91 dense; vocal weak |
| Synthetic label corpus | renderer emits audio + per-hit labels | med | **high** | bench | no | no | **P1** | **done** |
| Template calibration | logistic fit of term weights | med | high | corpus | **light** | no | P1 | **done** — macro F1 0.85 |
| Musical role | grid position, metrical weight, phrase, accent, density | med | **high** | P2 structure | no | no | **P1** | **done** (audio side) |
| Object context | type, pattern, spacing, combo, existing hitsounds | med | **high** | P5 reader | no | no | **P1** | partial — map context attached to each attack (Python) |
| **Viterbi decision** | sequence labelling with consistency costs | high | **high** | all above | no | no | **P1** | todo |
| Explanations | itemised terms + alternatives | med | **high** | decision | no | no | **P1** | todo |
| Profiles | built-in + custom, as data | low | high | decision | no | no | **P1** | todo |
| Hitsound timeline | instrument lanes over object lanes | med | **high** | P3 timeline | no | no | **P1** | todo |
| Hitsound editor | change/remove/volume/sample | med | **high** | decision | no | no | **P1** | todo |
| Sample bank | import skin/folder, audition samples | med | high | P4 playback | no | no | P1 | todo |
| Sample recommendation | map samples to roles by their spectrum | med | med | bank | no | no | P2 | todo |
| Hitsound export | only hitsound fields change | med | **high** | P5 writer | no | no | **P1** | todo |
| Consistency check | flag objects whose sound disagrees with their role | low | high | decision | no | no | P2 | todo |

The F1 numbers are measured on the synthetic corpus the templates were calibrated on; they
say the classes separate, not how they do on real songs.

---

## Phase 7 — Validation and mapping analysis

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Validation rules | duplicates, very short sections, impossible changes, suspicious offsets, octave mistakes | med | **high** | P5 | no | no | **P1** | **done** — shown as banners |
| Hitsound validation | missing samples, silent assignments, inconsistent patterns | med | high | P6 | no | no | P1 | todo |
| Alignment report | objects not on attacks; attacks with no object | med | high | P5 | no | no | P1 | **done** |
| Never auto-fix | every finding is a proposal with a consent step | low | **high** | rules | no | no | **P1** | **done** |
| Density analysis | objects/s over time | low | med | P5 | no | no | P2 | **done** |
| Rhythm pattern recognition | recurring rhythmic figures | high | med | P2, P5 | opt | no | P3 | todo |

---

## Phase 8 — Automation

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| CLI rewrite | `analyze · timing · hitsound · validate · inject · export · bench` | med | **high** | P1, P5 | no | no | **P1** | partial — Python CLI covers analyse, CSV, click, .osz, inject, folders |
| Machine-readable output | `--json` | low | high | CLI | no | no | P1 | **done** for analyse |
| Batch folder analysis | every audio file in a folder | low | high | CLI | no | no | P1 | **done** |
| Batch hitsounding | many difficulties, one analysis reused | low | high | P6 | no | no | P1 | todo |
| Project format | reopen a song with its edits without recomputing | med | high | P2 cache | no | no | P1 | todo — only the result cache exists |
| Watch mode | re-analyse on file change | low | low | CLI | no | no | P3 | todo |

---

## Phase 9 — Experimental

Nothing here is promised. Each item is a hypothesis with a way to test it.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Drum classifier (CNN) | small mel-patch model vs calibrated templates | high | med-high | P6 corpus | **yes** | opt | P2 | todo |
| Vocal onset model | the weakest classifier; the best ML candidate | high | med | P6 | **yes** | opt | P2 | todo |
| Learned structure | section labels from a small embedding | high | low-med | P2 | **yes** | opt | P3 | todo |
| Full drum transcription | complete kit transcription | high | med | classifier | yes | opt | P3 | todo |
| Timing suggestions | list red lines a map is missing | med | med | P7 | no | no | P2 | **done** — shown in the compare card |
| Apply a suggestion | write one suggested red line into the `.osu`, with backup and consent | med | med | suggestions, writer | no | no | P2 | todo |
| Waveform annotation | user notes pinned to timeline positions | low | low | P3 | no | no | P3 | todo |
| Plugin API | third-party analysis stages | high | low | P0 rules | no | no | P3 | todo |
| WASM engine | the core in a browser | med | low | P1 | no | no | P3 | todo |

---

## Phase 10 — Human-level timing accuracy

Documented in full in [`10-precision-plan.md`](10-precision-plan.md). **Not started.** The
goal: push accuracy on real songs from today's ~5 % of a ranked map's red lines within
5 ms (measured on one track, *Vampires Will Never Hurt You*) towards 90 %+, offline.

**Measurement first.** Nothing ships without a measured gain on Corpus B — 20 hand-timed
ranked tracks across every category — while Corpus A (the 24 synthetic fixtures) stays
green.

The gain column below is an **estimate, not a measurement**; each sub-phase replaces its
estimate with a number or is dropped.

| # | Sub-phase | What it adds | Estimated gain | Status |
|---|---|---|---:|:--:|
| 10.0 | Corpus B | 20 ranked tracks + the scoring script | — | todo |
| 10.1 | Fingerprint & reuse | match the audio against the user's own `osu!/Songs`; exact when the song is already mapped | large when matched | todo |
| 10.2 | Source separation | drum stem first | +8 pts | todo |
| 10.3 | Neural beat tracking | a downbeat model as one more voter | +17 pts | todo |
| 10.4 | Multi-signal evidence | multi-band onsets, HPSS, chroma novelty (partly built in Phase 2) | +5 pts | partial (Rust pieces exist) |
| 10.5 | Rippling model | tempo from neighbouring downbeats, lineup fix on export — our own implementation of the idea | +12 pts | todo |
| 10.6 | Bayesian ensemble | combine every voter with mapper priors | +5 pts | todo |
| 10.7 | Rubato modelling | smooth tempo curve (elastic grid is the start) | +2 pts | partial (elastic grid) |
| 10.8 | Alignment feedback | virtual metronome vs attacks, micro-adjust | +2 pts | todo |
| 10.9 | Fine-tune on ranked maps | domain-specific model | +2 pts | todo |
| 10.10 | Chord & cadence anchors | cadences as downbeat voters | +1 pt | todo |
| 10.11 | Instrument specialists | trained kick/snare/hat detectors | +1 pt | todo |
| 10.12 | UX for slow but precise | stage progress, cancel, cached intermediates | usability | partial (cache) |
| 10.13 | **MSI distribution** | one self-contained installer + portable ZIP — [`11-msi-distribution.md`](11-msi-distribution.md) | packaging | todo |

**Before bundling anything:** check each licence at the source. WiX, the madmom model files,
the Demucs weights and every dataset have terms of their own, and Tempora's code is not to
be copied — only its ideas reimplemented.

**Escape valve.** Some tracks will stay unresolvable (real rubato, aesthetic timing
choices). For those, an assisted mode — the user taps two downbeats — rebuilds the rest.

---

## Phases 12–18 — Comfort features

Documented in [`12-comfort-features.md`](12-comfort-features.md). They touch the
presentation and I/O layers, not the engine, so they run in parallel with the rest.

| Phase | Adds | Status |
|---:|---|---|
| 12 | Modern UI | **superseded** — the web shell (Phase 3) replaced the PySide6 plan |
| 13 | Audio playback — transport, live click, scrubbing, MIDI tap | todo (same as Phase 4 transport) |
| 14 | Project system — project file, auto-save, undo, **organised output folders**, batch | partial — undo/redo and result cache; no project file, no output folders |
| 15 | Deep osu! integration — Songs browser, lazer, editor round-trip, sample library | partial — folder import; no Songs browser, no lazer |
| 16 | Localization + accessibility | partial — English/Spanish; no screen-reader work |
| 17 | Plugins + reports | todo |
| 18 | Advanced input — multi-monitor, loopback capture, video preview, MIDI | todo |

**Output-file policy** (14.4b, not built yet): every artefact Overtone produces will live
under `%USERPROFILE%\Documents\Overtone\`, never next to the installed app.

---

## Rejected ideas

| Idea | Verdict |
|---|---|
| **Difficulty / strain graphs** | **Drop.** osu!'s own star rating already does it with the official algorithm. Object density — which feeds hitsound decisions — is kept |
| **"Suspicious map detection"** | **Reframe, don't build.** The useful part is the concrete validation rules in Phase 7 |
| **Project sharing** | **Drop for now.** Exporting a `.osu` and a CSV covers real needs |
| **Automatic BPM detection** as a separate feature | **Already the product** |
| **Automatic timing** with no review | **Won't build.** Suggestions with confidence, yes; "trust me", no |
| **Full automatic hitsounding with no review** | **Same.** The editor and the explanations are the feature |
| **Chorus / verse detection** as a headline | **Keep, demote.** Useful for per-section hitsound profiles, not its own phase |
| **PySide6 desktop UI** (old Phase 12 plan) | **Superseded** by the web shell, which survives the move to Tauri |
| **SuperFlux**, **tempogram from the coherence map** | **Rejected on measurement** (Phase 2) |
| **Cloud anything** | **Never.** Offline is a product property |

---

## Sequencing

```
P0 gates ✓ ─► P1 parity ✓ ─┬─► P2 analysis ✓(Rust) ─┬─► P6 hitsounds (half) ─► P7 validation (half)
                           ├─► P3 UI (web shell ✓, timeline half)
                           ├─► P4 playback ✗ / editor ✓
                           └─► P5 osu! ✓ ─────────────► P8 automation (half) ─► P9 (suggestions ✓)

Next: fix known bugs ─► playback ─► Rust engine in the app ─► timeline ─► hitsounds ─► Phase 10
```

P3, P4 and P5 are independent of each other. P6 is the largest body of work and waits on
playback and the timeline, because a hitsound editor you cannot hear is not usable.
