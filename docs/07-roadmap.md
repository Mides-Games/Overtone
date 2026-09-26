# Roadmap

Ten phases, plus the precision plan (Phase 10) and the comfort phases (12–18). Each
feature carries: **Diff** (difficulty) · **Imp** (impact) · **Deps** · **ML** · **GPU** ·
**Pri** (priority: P0 blocking, P1 core, P2 valuable, P3 optional) · **Status**.
Anything not worth building is in [Rejected ideas](#rejected-ideas), with the reason.

Phases are ordered by dependency, not by appetite. The only hard rule: **the Rust engine
must match the measured v3 baseline** — 24/24 within 0.05 BPM and 5 ms, median
0.0000 BPM / 0.16 ms. Everything else is negotiable; that is not.

---

## Where we are — 2026-09-24

**Stage: the app is usable end to end, in sections, and can analyse with the Rust engine
(opt-in; v3 stays the default and the fallback).**

| Area | State |
|---|---|
| Timing engine (Python v3) | **works** — 24/24 corpus, median 0.0000 BPM / 0.16 ms, all gates green |
| Timing engine (Rust v4) | **at parity, in the app** — matches v3 attack for attack and red line for red line on 27/27, ~4x faster end to end; Settings → Rust engine runs it through `overtone-cli`, and v3 takes over (with a note) where it has no answer |
| App (web shell) | **usable** — sidebar sections (Library, Timing, Structure, Map check, Mapset, Report, Export, Settings); analyse, edit, undo/redo, lock, export (.osu / CSV / click / .osz), inject, compare with a map, alignment, density, snap audit, suggestions, mapset check, reference timing, assisted timing, mod report, folder import, recents, osu! Songs browser, EN/ES |
| osu! files | **works** — full reader, byte-identical writer, atomic write + backup |
| Validation | **first rules live** — duplicates, short sections, impossible changes, suspicious offsets, octave checks |
| Hitsound engine | **half built, Rust only** — features, 13 instrument classes, musical role; no decision, editor or export; not in the app |
| Playback | **in the app** — play/pause/seek, live click from the current red lines (one clock with the song: attacks and clicks within 0.25 ms, measured), playhead, section loop, 100/75/50 % (pitch drops, attacks stay in place), taps with a remembered latency |
| Precision plan (Phase 10) | **not started** — plan only |
| Installer (MSI) | **not started** — plan only |

Tests: **456** Python (313 engine + 143 web shell) · **263** Rust.

### What is pending, in order

The audit backlog is closed: every finding fixed, recorded as already fixed, or decided
([`13-audit-backlog.md`](13-audit-backlog.md)). The Rust engine is in the app, opt-in.

1. **Hitsounds** (Phase 6) — the most requested feature, first since 2026-09-24. The plan
   is [`15-hitsound-plan.md`](15-hitsound-plan.md): prerequisites P-1 to P-7 (sound events
   from the map, a hitsound field writer, sample playback, evidence through the CLI,
   object-attack matching, a real-map evaluation, an object lane), then H1 the hitsound
   copier, H2 the Hitsounds section, H3 a consistency check, H4 the decision engine, H5 the
   editor and export.
2. **The next sidebar modes** (Phase 19) — Evidence, Write history, Audio swap.
   In since 2026-09-24: Settings (Phase 20: output folder, offset precision, click,
   interface size, cache), the timeline (Phase 3), playback (Phase 4, but for the
   percussion-only audition) and the first six sidebar modes of
   [Phase 19](#phase-19--app-sections).
3. **Other languages** (Phase 24) — SQL is in: the SQLite library index behind the Songs
   browser and same-audio lookup. Next TypeScript (needs Node.js) and a C# lazer gate
   (needs the .NET SDK).
4. **Percussion-only audition** (Phase 4) — hear the percussive part alone.
5. **Map tools** (Phase 21) — kiai, preview point, SV normaliser, inject into every difficulty.
6. **Real-audio accuracy** (Phase 10) — build Corpus B first, then one sub-phase at a time.
7. **Installer** (Phase 10.13) — MSI + portable ZIP.

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
| Rust chroma wrong below ~362 Hz | **real** — bins wider than a semitone | bass notes on the wrong class: 24/36 → 0/36; hitsound F1 0.910 unchanged (the retired in-sample test) | #24 |
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
| Rust hitsound flux compared spectra of different sizes | steady tone 0.9996 → ~0; 450 test hits 35 → 29 wrong, macro F1 0.913 → 0.931 (the retired in-sample test) | #34 |

Since then: `.bak` atomicity (#36), dropped packets in the Rust decoder (#37), the
engine's memory — one 5-minute song peaked at 3.7 GB, 0.55 GB now (#38) — the weak
downbeat (#40), long mixes (#41), the fallback's pulse factor (#42), scattered clicks
in the fallback (#43), the config crash (#45), Ctrl+C in fields (#46), CSV errors (#47),
`.osz` audio names (#48), x2 on the fallback (#50), noise before the first red line (#51),
Rust tie-breaking (#52), the Rust hour cap and load tests (#53), bench honesty (#54), the
DSP contract's stale passages (#55), one-window signature regions (#57), the peak tie
rule (#58), and the golden gate's blind spots — the envelope, every weight, each red
line's bar, and fixtures with a proven bar (#59–#61); the hitsound engine's
evaluation, windows and metrical role (#63–#66); elastic parity with its prototype (#69);
the whole-track spectrograms, the structure windows, the percussive ratio and a chorus on
the verse's chords (#71–#75); the resampler's speed and AIFF (#76, #77).

The forty low findings were closed on 2026-09-24; nothing is open in
[`13-audit-backlog.md`](13-audit-backlog.md).

---

## Phase 0 — Architecture and gates

Nothing here produces a feature. It produces the ability to know whether later phases
broke something, which is why it is first.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Toolchain | MSVC Build Tools + rustup MSVC target | — | — | — | no | no | **P0** | **done** |
| Workspace skeleton | crates + dependency rules | low | high | toolchain | no | no | **P0** | **done** — 6 crates; `check-deps` rule not automated |
| `reference/python-v3` | move v3 in, keep it runnable | low | high | — | no | no | **P0** | **deferred** (2026-09-24) — `overtone.py` is still the app's default engine and its only `.osu` reader/writer, so a copy in `reference/` would keep changing; it moves once the Rust engine is the default and the osu! I/O is ported |
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
python bench/golden.py check           # 27/27 cases match stage for stage
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
| Unit tests ported | the v3 tests by name | med | **high** | all | no | no | **P0** | partial — 231 Rust tests; not every v3 name |
| Property tests | ×2/÷2 identity, exact-grid recovery, monotone boundaries | low | high | all | no | no | P1 | partial |
| Structured diagnostics | carried on the result, not in a progress string — closes **F-08** | low | med | all | no | no | P1 | **done** (Rust) |
| **App uses the Rust engine** | Python binding (PyO3) or JSON subprocess, so the shell gets the speed-up | med | **high** | all | no | no | **P1** | **done** — JSON subprocess (`overtone-cli --full`), opt-in in Settings |

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
| 24-track corpus, whole pipeline | 18.5 s | **4.2 s** (decode 0.45 + attacks 2.26 + tempo 1.49) | ~4.4x |
| 6-minute fixture | 4.6 s | **1.12 s** + decode (attacks + tempo) | ~4x |

Measured on 2026-09-23, like for like. The first version of this table (2.53 s, 8.5x;
0.51 s, 9.8x) timed only decoding and attack detection on the Rust side against Python's
whole `analyze_audio`; the bench now times the tempo pipeline too. The 05-dsp-pipeline
target of "under 3 s" for the corpus is not met.

Two things got there and neither was the language: a **sparse** mel filterbank and an STFT
**fused** into the mel projection, so the linear spectrogram is never materialised.

**Exit: met for the engine** (golden 24/24 attack for attack and red line for red line).
Still open: the rest of the v3 unit tests by name. The engine is in the app, opt-in.

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
| Structure analysis | novelty curve → phrases, energy map | med | high | chroma + energy (MFCC built, unused) | no | no | **P1** | **done** |
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
| Binary transport | fast channel for peaks/envelope/attacks | med | **high** | shell | no | no | **P1** | not needed so far — the song travels once as base64 chunks and the page builds its own peaks; attacks and clicks ride the JSON payload |
| Peak pyramid | LOD min/max waveform, computed once, cached | low | **high** | audio | no | no | **P1** | **done** — min/max per 256 samples, built once from the decoded song in the page |
| **Timeline** | waveform · onsets · grid · attacks · sections · red lines | **high** | **high** | transport | no | opt | **P1** | **done** — tempo curve, waveform lane, drift lane, beat grid when zoomed, sections, red lines, map ghosts |
| Zoom / scroll / select | cursor-anchored zoom, range selection, keyboard nav | med | **high** | timeline | no | no | **P1** | **done** for zoom and select — cursor-anchored wheel zoom, ↑/↓; no range selection yet |
| Tempo curve layer | local BPM over time | med | high | timeline | no | no | **P1** | **done** |
| Hover readout | time, tempo, governing red line | low | high | timeline | no | no | **P1** | **done** |
| Stat cards | BPM, points, beats, stability, engine, residual | low | med | shell | no | no | P1 | **done** |
| Progress panel | per-stage ticks and timings, cancellable | low | med | shell | no | no | P1 | partial — stage messages; no timings, no cancel |
| Dashboard | drop target, recents, folder entry points | low | med | shell | no | no | P1 | **done** |
| Honesty banners | fallback engine, late first line, validation findings | low | **high** | shell | no | no | P1 | **done** |
| Confidence ribbon | per-section confidence under the ruler | low | med | timeline | no | no | P2 | todo — per-point bars in the list only |
| Spectrogram layer | optional spectral energy | med | low-med | STFT | no | yes | P3 | todo |
| Light theme | full token counterpart | low | low | tokens | no | no | P3 | **done** — one light token block, canvas ink included; Settings → Theme (System, Dark, Light) |
| Zoom and pan | wheel zoom anchored at the cursor, drag to pan; beat grid and attack ticks when zoomed in | med | **high** | timeline | no | no | **P1** | **done** — beat grid, bars brighter; attacks show in the drift lane |
| Drag red lines | click to select, drag to move (snapped to attacks), double-click to add | med | **high** | zoom | no | no | **P1** | **done** but adding — snaps within 6 px, Alt frees it, one undo; double-click plays instead, and the editor adds |
| Drift lane | how far each attack sits from the grid osu! will play | med | high | timeline | no | no | P1 | **done** — nearest 1/1-1/4 tick of the governing line, ±30 ms, green ≤5, amber ≤15 |
| Map red lines as ghosts | the loaded .osu's red lines drawn beside the detected ones | low | high | compare | no | no | P1 | **done** — from the reference card, else the compare card |
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
| Transport | play/pause/seek inside the app | med | **high** | audio | no | no | **P1** | **done** — WebAudio, Space to play/pause, position bar |
| Live click track | click synthesised against the *current* timing points | med | **high** | transport | no | no | **P1** | **done** — ``click_schedule``, the WAV export's own; scheduled 150 ms ahead, so an edit is heard on the next beat |
| Playhead sync | position on the timeline at 60 Hz | low | high | transport | no | no | **P1** | **done** — its own layer over the tempo map |
| Scrub + loop | scrubbing, loop selection, loop section | med | high | transport | no | no | P1 | partial — seek bar and loop section (sample-exact, the click folded into it); no drawn selection to loop, no audible scrub |
| Play from beat / point | click a beat or red line to play from it | low | med | transport | no | no | P2 | **done** — from the selected red line, or double-click the map |
| Grid editor | edit offset/BPM, ±1 ms nudge, ×2/÷2 | med | **high** | P1 | no | no | **P1** | **done** (web shell) |
| Add / delete / split / merge | with recalculation | med | high | editor | no | no | **P1** | partial — add and delete; no split/merge |
| **Lock timing point** | protect a verified point from re-analysis | low | high | editor | no | no | P1 | **done** |
| Undo/redo | one stack per song | med | high | editor | no | no | P1 | **done** (web shell) |
| Click-accent meter fix | accent on the detected meter — closes audit **F-03** | trivial | low | click | no | no | P1 | **done** |
| In-app preview | play song + click from the selected red line (WebAudio in the shell) | med | **high** | transport | no | no | **P1** | **done** |
| Slow section loop | 4-bar loop of song + click at 100 / 75 / 50 %, pitch kept | med | high | transport | no | no | P1 | **done**, pitch not kept, by measurement — the section loop at 100/75/50 %, resampled: every attack exactly at t / rate. A pitch-kept stretch (librosa's phase vocoder) put attacks a median 23-24 ms late |
| Tap-along check | tap along inside the app; show how far each tap lands from the grid | low | med | transport | no | no | P2 | **done** — T or the Tap button: taps placed at the sample then sounding (getOutputTimestamp; mapping within -1.1..+0.4 ms, measured), tempo of the run, offset from the click |
| Percussion-only audition | hear just the percussive part (HPSS) to judge timing | med | med | P2 HPSS | no | no | P2 | **done** — transport toggle, librosa stem cached per analysis over the chunk transport |
| Latency calibration | measure output latency once so the click lines up with the audio | low | med | transport | no | no | P2 | not needed for listening — the song and the click share one AudioContext and one clock (measured within 0.25 ms). For tapping: **done** — the person's own latency, measured against the click and remembered |

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
the app yet.** The order of work, and what has to land first, is
[`15-hitsound-plan.md`](15-hitsound-plan.md): the prerequisite rows below (P-1 to P-7), then
the copier, the section, the check, the decision engine, the editor.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| P-1 Sound events from the map | every object as the sounds it makes (edges, body, spinner end), resolved against the timing points | med | **high** | P5 reader | no | no | **P1** | **done** — `sound_events`; 0 errors on 3,000 local maps, slider lengths held (0.04 % overlap, all in gimmick maps) |
| P-2 Hitsound field writer | only `hitSound`/`edgeSounds`/`edgeSets`/`hitSample` change; zero-change write byte-identical | med | **high** | P5 writer | no | no | **P1** | **done** — `set_object_hitsounds`, `write_object_hitsounds`: edits over the file's own text; flip and restore on 2,998 local maps sound identical, only object lines move |
| P-3 Sample playback | samples found as osu! finds them, Overtone's own synthesised defaults, on the playback clock | med | **high** | P4 playback | no | no | **P1** | **done** — `assets/samples.py`, `hitsound_playback`, the transport's "Hitsounds from"; slider bodies not played yet |
| P-4 Evidence through the CLI | class probabilities with terms, and role, per attack; calibrated weights baked in | med | **high** | templates, role | no | no | **P1** | **done** — `overtone-cli hitsound-evidence`: 13 probs + every term's contribution + role per attack, baked fit in 0.036 ms (was 3.5 s a call) |
| P-5 Object-attack matching | each sound event's nearest attack, "no attack" as a state | low | high | P-1 | no | no | **P1** | **done** — `match_sound_events`: binary search, dt and weight inside 50 ms, else unmatched |
| P-6 Real-map evaluation | agreement with mappers' own hitsounds on local maps, against simple baselines | med | **high** | library index, P-1 | no | no | **P1** | **done** — `bench/eval_hitsounds.py`: clap-on-2-and-4 F1 0.59, finish-on-downbeat F1 0.42 (medians, 1,000 local maps); the bars H4 must beat |
| P-7 Object lane | objects and their sounds on the timeline | low | high | P3 timeline, P-1 | no | no | **P1** | **done** — objects and additions in rows, while a difficulty's hitsounds are picked |
| H2 Hitsounds section | one difficulty, read only: where each addition falls in the bar, every sound heard one by one | med | **high** | P-1, P-3, P-7 | no | no | **P1** | **done** — `hitsound_report`; on 800 local maps claps sit on 2 and 4 57 % of the time (median) |
| H1 Hitsound copier | one difficulty's hitsounds onto others, by time, with a preview | low | **high** | P-1, P-2 | no | no | **P1** | **done** — `copy_hitsounds` + Mapset view card; 1,494 copies on 300 local mapsets, 0 errors, 95.3 % of sounds matched (median) |
| Per-attack features | 7 bands, centroid/rolloff/flatness/crest, rise/decay | med | **high** | P2 HPSS | no | no | **P1** | **done** |
| Harmonicity + pitch | HPS pitch, formants | med | high | features | no | no | **P1** | **done** — inharmonicity deferred |
| Instrument templates | 13 scored classes, explainable | high | **high** | features | no | no | **P1** | **done** — held-out F1 0.723 on synthetic arrangements it never saw (the old 0.91 judged a re-draw of its training track); Clap 0.15, closed hats 0.40 weakest |
| Synthetic label corpus | renderer emits audio + per-hit labels | med | **high** | bench | no | no | **P1** | **done** |
| Template calibration | logistic fit of term weights | med | high | corpus | **light** | no | P1 | **done** — held-out macro F1 0.231 hand-set → 0.723 calibrated (fit on seeds 11–14, judged on 21–24); `calibrated_templates()` ships the fit |
| Musical role | grid position, metrical weight, phrase, accent, density | med | **high** | P2 structure | no | no | **P1** | **done** (audio side) |
| Object context | type, pattern, spacing, combo, existing hitsounds | med | **high** | P5 reader | no | no | **P1** | partial — map context attached to each attack (Python) |
| **Viterbi decision** | sequence labelling with consistency costs | high | **high** | all above | no | no | **P1** | **done** — `overtone-cli hitsound`: 19/19 synthetic exact, real clap/finish F1 above the rules on two samples |
| Explanations | itemised terms + alternatives | med | **high** | decision | no | no | **P1** | todo |
| Profiles | built-in + custom, as data | low | high | decision | no | no | **P1** | todo |
| Hitsound timeline | instrument lanes over object lanes | med | **high** | P3 timeline | no | no | **P1** | partial — the object lane (P-7); instrument lanes need P-4 |
| Hitsound editor | change/remove/volume/sample | med | **high** | decision | no | no | **P1** | partial — engine half, bridge propose/preview/apply/one-level-undo, and the Decide card (tick, preview, write, copy, undo) short of a harness pass; volume/sample changes and pre-hearing proposals still to build |
| Sample bank | import skin/folder, audition samples | med | high | P4 playback | no | no | P1 | todo |
| Sample recommendation | map samples to roles by their spectrum | med | med | bank | no | no | P2 | todo |
| Hitsound export | only hitsound fields change | med | **high** | P5 writer | no | no | **P1** | partial — same engine half; the Export-section surface still to build |
| Consistency check | flag objects whose sound disagrees with their role | low | high | decision | no | no | P2 | partial — map half and silence half in the mod report (missing/extra clap; finish/clap with no attack under them); clap-mismatch refused on measurement until the templates prove themselves on real audio |
| Audio-only proposal | hitsounds from the song alone, no map: attacks → classes + role, proposed on the song's own analysis | med | high | H4, P-4 | no | no | P2 | todo — proposed 2026-09-26: H4 needs a difficulty's objects today and refuses without them; the ask is drop an audio file and get a proposal by the song's analysis |

The F1 numbers are measured on synthetic arrangements the fit never saw, from the same
corpus generator; they say the classes separate, not how they do on real songs.

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
choices). For those, an assisted mode — the user marks two downbeats — rebuilds the rest. 2026-09-24 as Assisted timing (Phase 19), with the marks typed in ms until playback them be tapped.

---

## Phases 12–18 — Comfort features

Documented in [`12-comfort-features.md`](12-comfort-features.md). They touch the
presentation and I/O layers, not the engine, so they run in parallel with the rest.

| Phase | Adds | Status |
|---:|---|---|
| 12 | Modern UI | **superseded** — the web shell (Phase 3) replaced the PySide6 plan |
| 13 | Audio playback — transport, live click, scrubbing, MIDI tap | partial — Phase 4 transport, live click and loop; no scrub audio, no MIDI tap |
| 14 | Project system — project file, auto-save, undo, **organised output folders**, batch | partial — undo/redo and result cache; no project file, no output folders |
| 15 | Deep osu! integration — Songs browser, lazer, editor round-trip, sample library | partial — folder import, Songs browser; no lazer |
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
| Session model | one loaded song shared by every section through events | med | **high** | shell | no | no | **P1** | **done** — one song shared by every section |
| Library | home: open audio or a beatmap folder, recents, osu! Songs browser with search | med | **high** | P5 reader | no | no | **P1** | **done** — recents, folder import, Songs browser on a SQLite + FTS5 index (Phase 24): search as you type, rescan reads only what changed |
| Timing | tempo map, points, editor, verdict | — | — | — | no | no | **P1** | **done** |
| Map check | compare, alignment, validation, density and suggestions for the loaded difficulty | med | **high** | P5, P7 | no | no | **P1** | **done** — own section: compare, alignment, density, snap audit, suggestions |
| Hitsounds | instrument lanes, per-object sound, exported hitsound difficulty | high | **high** | P6 | no | no | P1 | todo |
| Audio | spectrogram, 7-band onset lanes, percussive/harmonic balance, energy with sections, tempo heatmap | med | med | P2 via bridge | no | opt | P2 | todo |
| Export | every output in one place: `.osu` text, CSV, click, `.osz`, lazer decimals, other games | low | high | P5 | no | no | P1 | **done** — own section |
| Settings | every option in Phase 20 | low | high | shell | no | no | P1 | **done** — its own section; detection stays in the drawer |


### New sidebar modes — proposed 2026-09-24

The sidebar held one entry, and clicking it did nothing. Each mode below builds on engine
pieces that already exist but that the app cannot reach yet, such as the full beatmap
reader, the folder scan, `_grid_quality`, structure and classify, the elastic grid, band
flux and the instrument templates. None needs the network. Every finding carries its
number and confidence. Every write goes through the atomic writer and keeps a backup.

| Mode | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Mapset check | every difficulty of a folder side by side: red lines, AudioFilename, PreviewTime, lead-in, metadata, kiai spans, density; differences listed, never auto-fixed | low | **high** | P5 reader, folder import | no | no | **P1** | **done** — `mapset_report`, own section |
| Snap audit | objects off the map's own grid (divisor, ms off), objects before the first red line or past the audio, and how many would go unsnapped if the detected timing were injected | low | **high** | P5 reader | no | no | **P1** | **done** — `snap_audit`, a Map check card |
| Reference timing | grade each red line of any `.osu` against the attacks (share, residual, drift at span end), load it as the working timing, find same-audio maps by content hash | med | **high** | P5 reader, attacks | no | no | **P1** | **done** — `grade_reference_timing`, a Map check card; offsets judged against the map's own shift, each error with its standard error; attacks detected when the fallback kept none; `gates.py reference` 24/24 |
| Assisted timing | tap tempo in the app; tap or mark two downbeats and the grid fit starts from there, with residual and share, or refuses. The precision plan's escape valve, which had no row | med | **high** | IRLS fit, P4 transport | no | no | **P1** | **done** without tapping — `assisted_grid`, a Timing card: two downbeats typed in ms, marks snapped to attacks, growth across gaps and not across changes, refusals with the reason; `gates.py assisted` 70/70; on 30 ranked maps median 0.004 BPM off the map. Marks can be tapped: a run of taps from a downbeat fills them |
| Structure view | phrase boundaries snapped to the nearest proven downbeat, labelled with the evidence for each label, over the energy lane; home for the kiai, preview, bookmark and break proposals | med | **high** | P2 structure + classify, P22 | no | no | **P1** | **done** — `overtone-cli structure`, `structure_view`; edges on the nearest proven bar within 1.5 s (on 20 ranked maps' bars, 31 % on a 4-bar line against 25 % by chance: a bar near the change, not the phrase's first) |
| Phrase starts on the phrase's bar | snap to the bar the phrase starts on, not the nearest; measured against ranked maps' kiai starts as truth | med | med | Structure view | no | no | P2 | todo |
| Mod report | every finding as osu! editor timestamps (`mm:ss:mmm (combo) - ...`) with its number and confidence, copyable as text; each opens the local osu! editor | low | high | P7 findings | no | no | P2 | **done** — `mod_report`, the Report section: reference, suggestions, snap audit and alignment in time order, combo numbers, `osu://edit/` links from validated timestamps; 0.31 s per map |
| Write history and restore | a log of every `.osu` write and its backup; see the timing diff against the backup and restore atomically, keeping the current file as a new backup | low | med | writer | no | no | P2 | **done** — JSONL log beside the cache, History section with per-write red diff and confirmed restore |
| Evidence view | the engine's alternatives for the open song: coherence candidates, octave margin, per-section residual and coverage, half-time hints, why the fallback ran; each one click from ×2 / ÷2 | med | med | payload fields or P22 | no | no | P2 | **done** — `analysis_evidence` + Timing card: candidates with coherence, seeded/half/double marks, octave margin, residual/coverage; Use writes the BPM into the governing red line through edit_apply |
| Ramp and live timing | the elastic tempo curve turned into the fewest red lines that keep every attack within a chosen drift (ms) or one line per N bars, with the count-versus-drift trade-off shown | high | high | P22, elastic grid | no | no | P2 | **done** — `overtone-cli ramps` + Timing card: longest grids back to back on strong attacks, tradeoff table, max-lines cap; Use loads hand-placed lines |
| Audio swap | the shift between a mapset's old and new audio from full-waveform correlation (onsets biased sub-frame shifts by a frame in the probe), refused on a tempo mismatch; on consent every time in every difficulty moves, with backup | med | high | writer, attacks | no | no | P2 | **done** — correlation at 11 kHz (±0.005 ms on real music), tempo twins and different cuts refused, Mapset card with preview and confirmed apply |
| Offset lab | MP3 encoder delay read from the file header, the first attack through each decoder side by side, and a blind listening test that reports the preferred click shift with an interval | med | med | both decoders, P4 transport | no | no | P2 | **done** — header numbers, decoder side-by-side, and an 18-trial blind 2AFC with Wilson intervals in Timing |
| Rhythm guide | a separate guide difficulty with circles on strong attacks snapped to the detected grid (per band; optional taiko don/kat hint), ambiguous snaps left out and listed | med | high | attacks, sections, `.osz` writer | no | no | P2 | needs a decision: `04-ui-ux.md` §9 rules out beatmap editing beyond hitsounds and timing |

Target sidebar, grouped by job: **Library** · **Timing** (Evidence and Ramps as tabs) ·
**Structure** · **Map check** (Snap audit and Reference inside) · **Mapset** ·
**Hitsounds** · **Audio** (Offset lab inside) · **Export** · **Report** · **History** ·
**Settings**.

Build order:

1. Mapset check.
2. Snap audit, the safety check before an inject.
3. Reference timing, which makes the app useful on hand-timed live songs, where detection
   is weakest.
4. Assisted timing, so a refusal becomes a guided step instead of a dead end.
5. Mod report.

Structure runs on the Rust engine (in since 2026-09-24); Ramps and Evidence follow it. Audio
swap needs two analyses, which run one after the other: the one-heavy-job-at-a-time
limit applies.

### Song import from a streaming link (proposed 2026-09-25, blocked)

Paste a track link, confirm it is the right song from its metadata, get the audio into
the app, and analyse its timing. Wanted as a Library entry: link → metadata
confirmation → audio file → the existing analysis.

It is recorded here but not built, because as specified it cannot ship under the
repo's own rules and has no lawful audio source:

- **Offline is a product property** (engineering rule 6; "Cloud anything: Never" in
  [Rejected ideas](#rejected-ideas)). Fetching metadata or audio from Spotify is a
  network call with an external API, so this needs the rule lifted first, deliberately,
  not slipped in.
- **Spotify's Web API gives metadata, not audio.** It returns track, artist, album and
  ISRC, never the full track file; full audio lives behind DRM or outside the terms of
  use. There is no "download the audio of this link" endpoint to call.
- It would need an API credential (client id/secret) stored and a consent step for the
  audio's origin, like every other `.osu` write in this roadmap.

What fits the rules today and already covers half the job: drop the audio file (or a
beatmap folder) into Library, and fingerprint reuse (Phase 10.1) answers "is this song
already mapped" from the user's own Songs folder. If the rule ever changes, the shape
above — metadata confirmation before anything downloads — is the starting point.

---

## Phase 20 — Options and settings

| Option | What it controls | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Output folder | where exports go; `Documents\Overtone\<Artist - Title>\` by default | low | high | 14.4b | no | no | P1 | **done** — asked (the dialog opens there) or not (a free name, never over an earlier export) |
| Offset precision | whole ms (stable) or decimals (lazer) on every export | low | med | writer | no | no | P1 | **done** — 0-3 decimals for copy, .osz and inject |
| Octave preference | prefer 120–300 BPM, or a custom range | low | med | engine | no | no | P2 | partial — on/off toggle |
| Live confidence threshold | a slider that shows which candidate points would appear | low | med | engine | no | no | P2 | todo |
| Analysis mode | fast (Rust) or precise (every Phase 10 voter) | low | med | P10, P22 | no | no | P2 | todo |
| Backup policy | one pristine `.bak` (today) or timestamped backups | low | med | writer | no | no | P2 | **not needed** — every state is already kept (`.bak` pristine, then `.bak2`, `.bak3`…); the Settings section says so |
| Cache | size limit, location, clear button | low | low | cache | no | no | P2 | **done** but a settable limit — entries, size, folder, clear |
| Click track | sound, accent on downbeats, level, subdivision clicks | low | med | click | no | no | P2 | **done** — 1-4 clicks per beat, bar accent on/off, levels in the transport; one sound |
| Theme and scale | light theme, UI scale 90–150 %, reduced motion | low | med | tokens | no | no | P2 | **done** — UI scale 80-150 %, reduced motion, light theme |
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
| Kiai from structure | kiai on chorus sections, written as greens | med | high | P2 structure, writer | no | no | P1 | **done** — engine half carries the audible state so sound never changes, second run a no-op; Structure card with preview counts and confirmed write with backup |
| Preview point | suggest `PreviewTime` at the chorus | low | med | structure | no | no | P2 | **done** — loudest chorus start, loudest part without one, in the Structure view with its reason |
| Bookmarks | section starts as editor bookmarks | low | med | structure | no | no | P2 | **done** — merged with the map's own, preview then confirmed write with backup, in the Structure view |
| Breaks | quiet spans long enough for a break | low | med | energy | no | no | P2 | **done** — sections 6 dB under the loudest cut by the map's own sound gaps (5 s or longer), Structure card with span preview and confirmed write with backup |
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
| Library health check | scan a Songs folder and list maps whose timing disagrees with their audio | med | med | batch, compare, library index | no | no | P2 | todo — the index lists the maps |
| Sample kit analysis | classify a skin's samples and suggest a mapping | med | low | P6 | no | no | P3 | todo |

---

## Phase 22 — Engine robustness and speed

| Item | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Rust engine in the app | `overtone-cli analyze --json` sidecar, opt-in, v3 as fallback; `.opus` goes to v3 or is refused (v4 has no decoder, by decision) | med | **high** | P1 | no | no | **P1** | **done** — opt-in; v3 takes over with a note where Rust has no answer |
| Fallback re-timing | re-time the fallback tracker's beats at sample resolution (they land 5–35 ms late) | med | **high** | — | no | no | P1 | todo |
| Real-MP3 offset bias | measure the ~20–26 ms attack-vs-map bias on real MP3s before trusting absolute offsets | med | **high** | Corpus B | no | no | P1 | partial — measured 2026-09-24 by reference timing: 30 random ranked maps all read the attacks after their lines, median +26.2 ms (IQR +23.0..+30.9), OGG (+27.2, n=3) as MP3 (+26.1, n=27), so not the MP3 decoder; not explained or corrected |
| Envelope memory bound | mel in chunks: ~2.65 → ~0.74 GB peak on long tracks; no silent MemoryError fallback | med | high | — | no | no | P1 | todo |
| Pre-warm the engine | load librosa and numba in the background at startup (~2.3 s off the first analysis) | low | med | shell | no | no | P2 | todo |
| Linear section growth | refine the growth grid on a trailing window | med | med | — | no | no | P2 | todo |
| Faster phase re-centring | a recurrence instead of one `exp` per shift | low | low | — | no | no | P3 | todo |
| Specific load errors | missing, empty and junk files each get their own message | low | med | decode | no | no | P2 | **done** — missing, empty and junk files named |
| Config type checks | a wrong-typed or BOM config never crashes or silently resets | low | med | config | no | no | P2 | partial — web shell only |
| CLI Unicode output | no crash on Japanese names when output is redirected | low | med | CLI | no | no | P2 | todo |
| CSV save errors | a locked CSV (open in Excel) shows an error | low | low | GUI | no | no | P3 | todo |
| Injection backups | back up the current state on every injection, and report it truthfully | low | med | writer | no | no | P2 | todo |

---

## Phase 23 — Quality gates

| Gate | What it catches | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Golden fails on a missing stage | a skipped stage counts as a failure, not a pass | low | high | golden | no | no | P1 | **done** |
| Real-audio smoke set | a handful of local songs that must keep analysing, never refused | low | **high** | — | no | no | P1 | todo |
| Robustness gate | the audit's probes (short audio, odd rates, junk `.osu`, read-only files) as one command | low | high | — | no | no | P1 | **done** — `gates.py robustness`; the CLI tests run the same probes on v4 |
| One fixture manifest | Python and Rust read the same list; no Rust gate passes on missing audio | med | med | bench | no | no | P2 | todo |
| Facts check | documented test counts and crate lists checked against the repo | low | med | — | no | no | P2 | **done** — `bench/facts.py` |
| Bench times the tempo stage | the Rust-vs-Python speed claim compares like with like | low | low | bench | no | no | P3 | **done** — #54 |
| `.gitattributes` | `.osu` fixtures keep their CRLF | trivial | low | — | no | no | P3 | **done** |
| Layout-fit check | no control clipped at the minimum window size | low | med | GUI | no | no | P2 | **done** — classic toolbar |
| Reference gate | a hand-timed map graded as timed: the true map clean, a late map one shift, a moved line flagged alone, a BPM 0.1 % off drifting | low | high | reference timing | no | no | P1 | **done** — `gates.py reference` 24/24 |
| Assisted gate | every corpus section marked like a person would, one and four bars apart: the grid within the benchmark's bar, covering the section, stopping where the next grid parts; noise, pads and silence refused | low | high | assisted timing | no | no | P1 | **done** — `gates.py assisted` 70/70 |

Sources: the 2026-09-22 review passes (128 proposals, each checked against the
code by a skeptical judge; the ones already built or only relevant to the old
Tk layout are left out) plus the map tools, options and exports above.

---

## Phase 24 — Other languages

Features better served by another language than Python, Rust or JavaScript, evaluated one
at a time in [`14-other-languages.md`](14-other-languages.md): value, viability on this
project's rules (offline, one-line local gates), and how each stays in step with the rest.

| Language | Feature | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| **SQL** (SQLite + FTS5) | library index of the Songs folder: search, same-audio lookup, library health, ground for fingerprint reuse | low | **high** | Python's `sqlite3` (installed) | no | no | **P1** | **done** — `overtone_library.py` + `library.sql`: search, same-audio in 3-5 ms; library health next |
| **TypeScript** | the web shell type-checked against the bridge (`@ts-check` + JSDoc, `tsc --noEmit`), payload types generated from Python | med | high | Node.js (dev only, not installed) | no | no | P1 | todo — after Node |
| **C#** | osu!lazer compatibility gate: lazer's own `osu.Game` decoder reads every `.osu` Overtone writes | med | high | .NET 8 SDK (dev only, not installed) | no | no | P2 | todo |
| **WGSL** (WebGPU) | spectrogram layer computed on the GPU | med | low-med | WebView2 WebGPU | no | **yes** | P3 | todo |
| **Lua** | user rules for the mod report, sandboxed | med | low-med | `lupa` or `mlua` | no | no | P3 | todo |
| WiX (XML) | the MSI (Phase 10.13) | med | med | WiX toolset | no | no | — | as planned |

Rejected: C++, Go, Java, Kotlin, Cython, Julia, R — the reasons are in the document.

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
| **A pitch-kept slow loop** | **Rejected on measurement** (Phase 4): it exists to judge attacks, and the phase vocoder moved them a median 23-24 ms; the loop is resampled instead, pitch and all |
| **Cloud anything** | **Never.** Offline is a product property |

---

## Sequencing

```
P0 gates ✓ ─► P1 parity ✓ ─┬─► P2 analysis ✓(Rust) ─┬─► P6 hitsounds (half) ─► P7 validation (half)
                           ├─► P3 UI (web shell ✓, timeline half)
                           ├─► P4 playback ✗ / editor ✓
                           └─► P5 osu! ✓ ─────────────► P8 automation (half) ─► P9 (suggestions ✓)

Next: map tools ─► hitsounds ─► Phase 10
      ─► map tools ─► hitsounds ─► Phase 10 ─► installer
```

P3, P4 and P5 are independent of each other. P6 is the largest body of work and waits on
playback and the timeline, because a hitsound editor you cannot hear is not usable.
