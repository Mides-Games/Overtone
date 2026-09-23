# Roadmap

Ten phases, plus the precision plan (Phase 10) and the comfort phases (12–18). Each
feature carries: **Diff** (difficulty) · **Imp** (impact) · **Deps** · **ML** · **GPU** ·
**Pri** (priority: P0 blocking, P1 core, P2 valuable, P3 optional) · **Status**.
Anything not worth building is in [Rejected ideas](#rejected-ideas), with the reason.

Phases are ordered by dependency, not by appetite. The only hard rule: **the Rust engine
must match the measured v3 baseline** — 24/24 within 0.05 BPM and 5 ms, median
0.0000 BPM / 0.16 ms. Everything else is negotiable; that is not.

---

## Where we are — 2026-09-23 (night)

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

Tests: **232** Python (163 engine + 69 web shell) · **193** Rust.

### What is pending, in order

1. **Audit backlog, medium findings** ([`13-audit-backlog.md`](13-audit-backlog.md)) — the six
   high ones are fixed, and so are eight medium ones (#36–#38, #40–#43): backups, the
   Rust decoder, memory, the weak downbeat, long mixes, the fallback's pulse factor and
   scattered clicks. **Next**, in this order, each re-probed before its fix (some may be
   fixed already — the ×2 / ÷2 edit guard landed in #20):
   1. The GUI and I/O findings: a wrongly typed `~/.overtone.json` crashes the classic
      window at launch; Ctrl+C anywhere overwrites the clipboard; CSV export fails
      silently on a locked file; `.osz` audio entries lose their extension.
   2. Two found on 2026-09-23: x2 on the fallback tracker with nothing between its
      beats reads an unrelated BPM; with no bar claimed, the first red line follows noise
      before the music.
   3. The rest of the medium findings, then the 40 low.
2. **Playback in the app** (Phase 4) — hear the song with the click, scrub, loop.
3. **Plug the Rust engine into the app** (Phase 22) — the ~9x speed-up reaches the user.
4. **Timeline** (Phase 3) — waveform, zoom, drag red lines.
5. **App sections and settings** (Phases 19–20) — one home per job, every option in one place.
6. **Map tools** (Phase 21) — kiai, preview point, SV normaliser, inject into every difficulty.
7. **Hitsounds** (Phase 6) — decision, editor, export; then its own section.
8. **Real-audio accuracy** (Phase 10) — build Corpus B first, then one sub-phase at a time.
9. **Installer** (Phase 10.13) — MSI + portable ZIP.

### Bugs fixed on 2026-09-23

All four were reproduced with a probe before the fix and have a test that fails on the old code.

| Bug | Fix | Measured |
|---|---|---|
| Inject reset sampleset, volume and kiai and wrote the section out of order | new red lines carry the state they land in; greens added where SV/sounds would change; sorted section; BOM and line endings kept | ranked map, 1341 objects: **229 → 0** changed what they play |
| Python engine returned a BPM for white noise (127.68) and pads (60.09) | the fallback first checks the onset envelope is more periodic than itself shuffled | noise ≤ +0.022, 27 real songs ≥ +0.090, threshold 0.05; results on real songs unchanged |
| Classic window: CSV clipped to 21 px at the default size | ghost buttons size to their labels; minimum width 1070 | nothing clipped in English or Spanish |
| Classic window: ×2 / ÷2 and Analyze silently dropped hand edits | they ask first while edits are unexported | 3 tests on the real window |

### Audit leads verified on 2026-09-23

The five leads the audit's verifiers did not finish. Each was re-probed; all five were real.

| Lead | Result | Measured | PR |
|---|---|---|---|
| First red line half a beat late | **real, critical** — section 0 applied a beat class counted in another seed's frame | plain renders on the off-beat: 5/8 → 0/8; `fast-300` was on the snare, now on the kick | #22 |
| Meter path hides a tempo change | **real, high** — one bar applied to the whole track | 128 → 150 and 120 → 160 keep both red lines; `signatures` 6/6 | #23 |
| Rust chroma wrong below ~362 Hz | **real** — bins wider than a semitone | bass notes on the wrong class: 24/36 → 0/36; hitsound F1 0.910 unchanged | #24 |
| Licence claims in the plans | **real** — six rows wrong | checked against each project's licence file; Demucs weights are research-only | #25 |
| Stale counts in CLAUDE.md | **real** | 76/75 → 209/181, layout complete | #26 |

### High audit findings fixed on 2026-09-23

All six from the backlog. Each was reproduced with a probe first and has a test that
fails on the old code; Python and Rust were fixed together where both apply.

| Finding | Measured | PR |
|---|---|---|
| ÷2 / ÷4 deleted real tempo changes | tiny-change 1/2 → 2/2, secs-4 2/4 → 4/4 red lines kept at ÷4 | #29 |
| Export snapping moved hand-placed red lines up to a quarter beat | snaps only ≤ 1 ms of rounding; hand-placed lines never move; ranked real map within 10 ms 8.1 % → 14.4 % | #30 |
| A change's red line one beat late (boundary beat µs before the start) | fixed at the function level; did not reproduce end to end (0/177 probes) | #31 |
| A stray click before the music threw the grid away | fallback 295.3 BPM → precision 150.000, red line within 0.1 ms | #32 |
| Sparse random attacks got a grid | random attack times 18–22/40 → 0/40; random-click files 63/240 → 12/240 answered, none by the precision engine | #33 |
| Rust hitsound flux compared spectra of different sizes | steady tone 0.9996 → ~0; 450 test hits 35 → 29 wrong, macro F1 0.913 → 0.931 | #34 |

Since then: `.bak` atomicity (#36), dropped packets in the Rust decoder (#37), the
engine's memory — one 5-minute song peaked at 3.7 GB, 0.55 GB now (#38) — the weak
downbeat (#40), long mixes (#41), the fallback's pulse factor (#42) and scattered clicks
in the fallback (#43).

Still open — 78 findings nobody has re-probed yet (none high, 38 medium, 40 low) — in
[`13-audit-backlog.md`](13-audit-backlog.md).

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
| No-grid verdict | refuse honestly instead of a white-noise BPM | low | med | elastic | no | no | P1 | **done** — Rust, and Python's fallback since 2026-09-23 |
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
| Zoom and pan | wheel zoom anchored at the cursor, drag to pan; beat grid and attack ticks when zoomed in | med | **high** | timeline | no | no | **P1** | todo |
| Drag red lines | click to select, drag to move (snapped to attacks), double-click to add | med | **high** | zoom | no | no | **P1** | todo |
| Drift lane | how far each attack sits from the grid osu! will play | med | high | timeline | no | no | P1 | todo |
| Map red lines as ghosts | the loaded .osu's red lines drawn beside the detected ones | low | high | compare | no | no | P1 | todo |
| Verdict strip | which engine answered, its residual, and whether to trust it, in one line | low | high | shell | no | no | P1 | partial — banners + engine pill |
| Snap indicator | say when export snapping moved an offset, so a ±1 ms nudge is not silently undone | low | med | editor | no | no | P2 | todo |
| Uncovered-intro shading | hatch the audio before the first red line | low | med | timeline | no | no | P2 | partial — banner only |
| Density ribbon | half- and double-time inside one reported section | med | med | P2 density | no | no | P2 | todo |
| Measures on the map | bar ticks and signature regions | low | med | timeline | no | no | P2 | partial — meter column |
| Keyboard map | every action reachable from the keyboard; `?` shows the sheet | low | med | shell | no | no | P2 | partial |
| Cancellable analysis | stop button, stage names and timings | low | med | progress | no | no | P2 | todo |
| Command palette | Ctrl+K search over every action | low | low | shell | no | no | P3 | todo |

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
| In-app preview | play song + click from the selected red line (WebAudio in the shell) | med | **high** | transport | no | no | **P1** | todo |
| Slow section loop | 4-bar loop of song + click at 100 / 75 / 50 %, pitch kept | med | high | transport | no | no | P1 | todo |
| Tap-along check | tap along inside the app; show how far each tap lands from the grid | low | med | transport | no | no | P2 | todo |
| Percussion-only audition | hear just the percussive part (HPSS) to judge timing | med | med | P2 HPSS | no | no | P2 | todo |
| Latency calibration | measure output latency once so the click lines up with the audio | low | med | transport | no | no | P2 | todo |

---

## Phase 5 — osu! integration

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Full `.osu` reader | all sections, hitobjects, sliders, SV, samples; unknown keys kept | **high** | **high** | — | no | no | **P1** | **done** (Python) |
| Span-preserving writer | untouched fields come out byte-identical | high | **high** | reader | no | no | **P1** | **done** (Python) |
| Atomic write + backup | temp+rename, `.bak` never overwritten | low | **high** | writer | no | no | **P1** | **done** |
| Timing injection | red-line replacement, greens preserved, what plays unchanged | med | **high** | writer | no | no | **P1** | **done** — keeps sampleset/volume/kiai/SV since 2026-09-23 |
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
| 10.2 | Source separation | percussive stem first — HPSS (built, no weights); Demucs weights are research-only | +8 pts | partial (HPSS in Rust) |
| 10.3 | Neural beat tracking | Beat This! (MIT code and weights) as one more voter | +17 pts | todo |
| 10.4 | Multi-signal evidence | multi-band onsets, HPSS, chroma novelty (partly built in Phase 2) | +5 pts | partial (Rust pieces exist) |
| 10.4a | Downbeat from the low band | read the 1 from kick and bass onsets, not the broadband envelope: on 88 ranked maps its accents put a claimed bar on the map's 1 only 5 times in 21, mostly one beat early on the snare (9/21 after #40's half-bar rule) | not estimated | todo |
| 10.5 | Rippling model | tempo from neighbouring downbeats, lineup fix on export — our own implementation of the idea | +12 pts | todo |
| 10.6 | Bayesian ensemble | combine every voter with mapper priors | +5 pts | todo |
| 10.7 | Rubato modelling | smooth tempo curve (elastic grid is the start) | +2 pts | partial (elastic grid) |
| 10.8 | Alignment feedback | virtual metronome vs attacks, micro-adjust | +2 pts | todo |
| 10.9 | Fine-tune on ranked maps | domain-specific model | +2 pts | todo |
| 10.10 | Chord & cadence anchors | cadences as downbeat voters | +1 pt | todo |
| 10.11 | Instrument specialists | trained kick/snare/hat detectors | +1 pt | todo |
| 10.12 | UX for slow but precise | stage progress, cancel, cached intermediates | usability | partial (cache) |
| 10.13 | **MSI distribution** | one self-contained installer + portable ZIP — [`11-msi-distribution.md`](11-msi-distribution.md) | packaging | todo |

**Licences, checked at the source on 2026-09-23** (full table in `10-precision-plan.md`):
Beat This! is MIT down to its weights; BeatNet is CC-BY-4.0; madmom's models are
non-commercial (CC BY-NC-SA); Demucs's weights are "only for scientific purposes", so
they do not ship; WiX is MS-RL with a maintenance-fee EULA; Tempora is CC BY-NC-ND, so its
code is never copied — only its ideas are reimplemented.

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

## Phase 19 — App sections

One sidebar entry per job, each shippable on its own, all sharing the one
loaded song. Today everything lives in the Timing view.

| Section | What it holds | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Session model | one loaded song shared by every section through events | med | **high** | shell | no | no | **P1** | todo |
| Library | home: open audio or a beatmap folder, recents, osu! Songs browser with search | med | **high** | P5 reader | no | no | **P1** | partial — recents, folder import |
| Timing | tempo map, points, editor, verdict | — | — | — | no | no | **P1** | **done** |
| Map check | compare, alignment, validation, density and suggestions for the loaded difficulty | med | **high** | P5, P7 | no | no | **P1** | partial — cards live in Timing |
| Hitsounds | instrument lanes, per-object sound, exported hitsound difficulty | high | **high** | P6 | no | no | P1 | todo |
| Audio | spectrogram, 7-band onset lanes, percussive/harmonic balance, energy with sections, tempo heatmap | med | med | P2 via bridge | no | opt | P2 | todo |
| Export | every output in one place: `.osu` text, CSV, click, `.osz`, lazer decimals, other games | low | high | P5 | no | no | P1 | partial — buttons in Timing |
| Settings | every option in Phase 20 | low | high | shell | no | no | P1 | partial — language, detection drawer |

---

## Phase 20 — Options and settings

| Option | What it controls | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Output folder | where exports go; `Documents\Overtone\<Artist - Title>\` by default | low | high | 14.4b | no | no | P1 | todo |
| Offset precision | whole ms (stable) or decimals (lazer) on every export | low | med | writer | no | no | P1 | partial — CLI flag only |
| Octave preference | prefer 120–300 BPM, or a custom range | low | med | engine | no | no | P2 | partial — on/off toggle |
| Live confidence threshold | a slider that shows which candidate points would appear | low | med | engine | no | no | P2 | todo |
| Analysis mode | fast (Rust) or precise (every Phase 10 voter) | low | med | P10, P22 | no | no | P2 | todo |
| Backup policy | one pristine `.bak` (today) or timestamped backups | low | med | writer | no | no | P2 | todo |
| Cache | size limit, location, clear button | low | low | cache | no | no | P2 | todo |
| Click track | sound, accent on downbeats, level, subdivision clicks | low | med | click | no | no | P2 | todo |
| Theme and scale | light theme, UI scale 90–150 %, reduced motion | low | med | tokens | no | no | P2 | todo |
| Shortcuts | rebind any action | low | low | keyboard map | no | no | P3 | todo |
| Per-song presets | remember detection settings per song | low | med | project format | no | no | P2 | todo |
| Language | English and Spanish; more through translation files | low | med | i18n | no | no | P2 | partial |
| Settings file | export/import settings to another PC | low | low | settings | no | no | P3 | todo |

---

## Phase 21 — Map tools

Everything here writes to a `.osu` only as a proposal with a preview and a
consent step, through the same backup-and-keep-what-plays writer as inject.

| Tool | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Inject diff | each old red line beside its new value, and the drift it causes | low | **high** | inject | no | no | **P1** | todo |
| Inject into every difficulty | one confirmation for the whole mapset | low | **high** | inject | no | no | **P1** | todo |
| Kiai from structure | kiai on chorus sections, written as greens | med | high | P2 structure, writer | no | no | P1 | todo |
| Preview point | suggest `PreviewTime` at the chorus | low | med | structure | no | no | P2 | todo |
| Bookmarks | section starts as editor bookmarks | low | med | structure | no | no | P2 | todo |
| Breaks | quiet spans long enough for a break | low | med | energy | no | no | P2 | todo |
| Volume by section | hitsound volume from section energy, as greens | low | med | energy, writer | no | no | P2 | todo |
| SV normaliser | greens that cancel BPM changes so scroll and slider speed stay constant | med | **high** | writer | no | no | P1 | todo |
| Re-snap objects | move hit objects onto the new grid after a timing change | high | **high** | writer, P5 | no | no | P1 | todo |
| Snap-divisor map | where the song needs 1/3, 1/4 or 1/6, per section | med | high | attacks | no | no | P1 | todo |
| Swing lane | where the music swings or sits off the grid | med | med | attacks | no | no | P2 | todo |
| New mapset from audio | encode MP3/OGG at a target bitrate, trim lead silence and re-offset | med | high | `.osz` | no | no | P2 | partial — `.osz` without encoding |
| Metadata from tags | artist/title/source from the audio's tags, romanised and Unicode kept apart | low | med | `.osz` | no | no | P2 | todo |
| Audio file check | bitrate, sample rate, length, clipping and lead-in against ranking rules | low | med | decode | no | no | P2 | todo |
| Video offset | match the video's own audio track to the song | med | low | decode | no | no | P3 | todo |
| Other games | export timing to Quaver (`.qua`) and StepMania (`.sm`/`.ssc`) | low | med | writer | no | no | P2 | todo |
| Import other formats | read Quaver / StepMania timing to compare against | low | low | reader | no | no | P3 | todo |
| Library health check | scan a Songs folder and list maps whose timing disagrees with their audio | med | med | batch, compare | no | no | P2 | todo |
| Sample kit analysis | classify a skin's samples and suggest a mapping | med | low | P6 | no | no | P3 | todo |

---

## Phase 22 — Engine robustness and speed

| Item | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Rust engine in the app | `overtone-cli analyze --json` sidecar, opt-in, v3 as fallback | med | **high** | P1 | no | no | **P1** | todo |
| Fallback re-timing | re-time the fallback tracker's beats at sample resolution (they land 5–35 ms late) | med | **high** | — | no | no | P1 | todo |
| Real-MP3 offset bias | measure the ~20–26 ms attack-vs-map bias on real MP3s before trusting absolute offsets | med | **high** | Corpus B | no | no | P1 | todo |
| Envelope memory bound | mel in chunks: ~2.65 → ~0.74 GB peak on long tracks; no silent MemoryError fallback | med | high | — | no | no | P1 | todo |
| Pre-warm the engine | load librosa and numba in the background at startup (~2.3 s off the first analysis) | low | med | shell | no | no | P2 | todo |
| Linear section growth | refine the growth grid on a trailing window | med | med | — | no | no | P2 | todo |
| Faster phase re-centring | a recurrence instead of one `exp` per shift | low | low | — | no | no | P3 | todo |
| Specific load errors | missing, empty and junk files each get their own message | low | med | decode | no | no | P2 | todo |
| Config type checks | a wrong-typed or BOM config never crashes or silently resets | low | med | config | no | no | P2 | partial — web shell only |
| CLI Unicode output | no crash on Japanese names when output is redirected | low | med | CLI | no | no | P2 | todo |
| CSV save errors | a locked CSV (open in Excel) shows an error | low | low | GUI | no | no | P3 | todo |
| Injection backups | back up the current state on every injection, and report it truthfully | low | med | writer | no | no | P2 | todo |

---

## Phase 23 — Quality gates

| Gate | What it catches | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Golden fails on a missing stage | a skipped stage counts as a failure, not a pass | low | high | golden | no | no | P1 | todo |
| Real-audio smoke set | a handful of local songs that must keep analysing, never refused | low | **high** | — | no | no | P1 | todo |
| Robustness gate | the audit's probes (short audio, odd rates, junk `.osu`, read-only files) as one command | low | high | — | no | no | P1 | todo |
| One fixture manifest | Python and Rust read the same list; no Rust gate passes on missing audio | med | med | bench | no | no | P2 | todo |
| Facts check | documented test counts and crate lists checked against the repo | low | med | — | no | no | P2 | todo |
| Bench times the tempo stage | the Rust-vs-Python speed claim compares like with like | low | low | bench | no | no | P3 | todo |
| `.gitattributes` | `.osu` fixtures keep their CRLF | trivial | low | — | no | no | P3 | todo |
| Layout-fit check | no control clipped at the minimum window size | low | med | GUI | no | no | P2 | **done** — classic toolbar |

Sources: the 2026-09-22 review passes (128 proposals, each checked against the
code by a skeptical judge; the ones already built or only relevant to the old
Tk layout are left out) plus the map tools, options and exports above.

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

Next: audit backlog (medium) ─► playback ─► Rust engine in the app ─► timeline ─► sections + settings
      ─► map tools ─► hitsounds ─► Phase 10 ─► installer
```

P3, P4 and P5 are independent of each other. P6 is the largest body of work and waits on
playback and the timeline, because a hitsound editor you cannot hear is not usable.
