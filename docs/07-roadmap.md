# Roadmap

Ten phases, plus the precision plan (Phase 10) and the comfort phases (12–18). Each
feature carries: **Diff** (difficulty) · **Imp** (impact) · **Deps** · **ML** · **GPU** ·
**Pri** (priority: P0 blocking, P1 core, P2 valuable, P3 optional) · **Status**.
Anything not worth building is in [Rejected ideas](#rejected-ideas), with the reason.

Phases are ordered by dependency, not by appetite. The only hard rule: **the Rust engine
must match the measured v3 baseline** — 24/24 within 0.05 BPM and 5 ms, median
0.0000 BPM / 0.16 ms. Everything else is negotiable; that is not.

---

## Where we are — 2026-09-26

**Stage: the app is usable end to end in ten sections, hitsounds included, and can analyse
with the Rust engine (opt-in; v3 stays the default and the fallback).**

| Area | State |
|---|---|
| Timing engine (Python v3) | **works** — 24/24 corpus, median 0.0000 BPM / 0.16 ms, all gates green (every Python and Rust gate re-run 2026-09-26) |
| Timing engine (Rust v4) | **at parity, in the app** — matches v3 attack for attack and red line for red line on 27/27, ~4x faster end to end (on Corpus B's real songs it writes v3's red lines on 13 of the 15 that v3 fits a grid to); Settings → Rust engine runs it through `overtone-cli`, and v3 takes over (with a note) where it has no answer. The same sidecar runs Structure (`structure`), Ramps (`ramps`) and the hitsound proposals (`hitsound`); `hitsound-evidence` prints each attack's classes and role from the command line |
| App (web shell) | **usable** — twelve sidebar sections: Library, Timing, Structure, Hitsounds, Map check, Mapset, Audio, Compile, Report, Export, History, Settings. Analyse, edit, undo/redo, lock, export (.osu / CSV / click / .osz), inject (one map or the whole mapset, with the diff), compare with a map, alignment, density, snap audit, re-snap, suggestions (each addable on its own), mapset check, reference timing, assisted timing, evidence, ramps, offset lab, constant scroll, snap divisors, kiai / breaks / bookmarks / preview point / section volumes from the structure, audio swap, audio file check, **compile several maps and their songs into one map**, write history with restore, mod report, folder import, recents, osu! Songs browser, EN/ES, dark and light |
| osu! files | **works** — full reader, byte-identical writer, atomic write + backup, every write logged and restorable; hitsound fields edited in place, nothing else moves (P-2) |
| Validation | **first rules live** — duplicates, short sections, impossible changes, suspicious offsets, octave checks; in the mod report, claps that break the map's own pattern and finishes or claps over silence (H3) |
| Hitsound engine | **in the app** — the copier (H1), the Hitsounds section (H2), the consistency check (H3), and the decision engine in Rust (H4) behind the Propose card: tick by row or by bars, swap a proposal for one of its alternatives, set volume and sample index by hand, hear it all over the song as the write would make it, preview, write the file or a copy, undo (H5); a row's inspector says why each sound was proposed; the profile is chosen on the Propose card (Balanced, or Drum-focused, measured on its own style's maps). The Samples card shows a skin's or a beatmap folder's samples as playback reads them, plays each alone or over the song in place of a selected sound, and chooses the skin playback asks; instrument lanes are still to build |
| Playback | **in the app** — play/pause/seek, live click from the current red lines (one clock with the song: attacks and clicks within 0.25 ms, measured), playhead, section loop, 100/75/50 % (pitch drops, attacks stay in place), taps with a remembered latency, the percussive part alone, and a difficulty's hitsounds with its own samples, as written or as they would be written, slider slides looped head to tail, and a chosen skin's samples where the map has none |
| UI verification | **done** 2026-09-26 — the 19 surfaces of 2026-09-25/26 exercised in the browser pane on two real mapsets, both themes and languages; it found app.js not loading and fifteen bugs in writes, counts and messages, all fixed; the two tools that needed a decision were decided the same day (timeline) |
| Precision plan (Phase 10) | **measured, nothing shipped** — Corpus B built (10.0): v3 puts 1.7 % of 1,152 ranked red lines within 5 ms (1.6 % before the fallback tracker's beats moved onto their attacks), the Rust engine 1.4 %; the +24 ms late reading explained (10.0a), mostly ranked maps' own lines sitting 21 ms before the sound |
| Installer (MSI) | **first build, not published** — `installer\build.py` makes a per-user MSI (WiX 5.0.2, no administrator, Start menu shortcut) and a portable ZIP from one PyInstaller tree, in one line, and smoke-tests both unpacked with the window's `--self-check`; unsigned, no licence notices, no file associations yet ([`11`](11-msi-distribution.md)) |

Tests: **905** Python (631 engine + 274 web shell) · **291** Rust.

### What is pending, in order

The audit backlog is closed: every finding fixed, recorded as already fixed, or decided
([`13-audit-backlog.md`](13-audit-backlog.md)). Landed since 2026-09-24: the hitsound plan's
P-1 to P-7 and H1 to H4, with H5's engine half and first surface; the sidebar modes
Evidence, Write history, Audio swap, Offset lab and Ramps; the percussion-only audition;
and the Phase 21 map tools (inject everywhere with a diff, kiai, breaks, bookmarks, preview
point, section volumes, SV normaliser, re-snap, snap divisors, audio file check).

1. **Hitsounds, the rest** (Phase 6, [`15-hitsound-plan.md`](15-hitsound-plan.md)) — H6
   (sample recommendation; the bank is in) and H7 (a proposal from the audio alone). Profiles are
   in the app: Drum-focused beat Balanced on its own style's maps and is chosen beside
   Propose; Minimal did not on bare claps and does not ship (timeline, 2026-09-26). The
   role term reads the map's red lines instead of the audio's bar since 2026-09-30
   (`06` §11; bare clap 0.331 → 0.429, finish 0.093 → 0.403); the whistle hand rule
   does not follow it there (measured both ways, both lose). Three things wait until the instrument templates hold on real audio: the
   clap-mismatch rule, instrument lanes on the timeline, and sample→role recommendation
   (the extractor runs on samples since 2026-10-03 via `hitsound-classify`, but a textbook
   kick reads snare — timeline). At the mappers' claps of 11
   real songs the templates read snare or clap at a median 0.138 (timeline, H3 audio
   half), so lanes drawn from them would show a precision they do not have.
2. **Library focus** (Phase 19) — scan, rescan and search measured and fixed on
   2026-09-26; the page's states wait for the browser harness. The library health
   check's page is in since 2026-09-30 (counts, a resumable run, flags with evidence
   marked actionable or weak); a hand-checked precision sample is still open.
3. **The Audio section** (Phase 19), and section labels from repetition.
4. **Other languages** (Phase 24) — TypeScript (needs Node.js) and a C# lazer gate (needs
   the .NET SDK). Node is not installed; ask before installing it. The .NET SDK is, per
   user, since 2026-09-26 (10.0.401, for the MSI build).
5. **Real-audio accuracy** (Phase 10) — Corpus B is built and measured (10.0); one
   sub-phase at a time from here, each measured on it.
6. **Installer, the rest** (Phase 10.13) — licence notices and an SBOM before anything is
   published, code signing, the portable `data\` folder, file associations, and one real
   install and uninstall. Built so far: the one-line build, the per-user MSI and the ZIP
   ([`11`](11-msi-distribution.md)).
7. **Compilation builder** (Phase 25, asked 2026-10-03) — several maps and their songs into
   one map and one audio file, each object keeping the beat it had. Step 1 of its build
   order is in (2026-10-03): the document, the segment reader with its repairs, the shift
   over every field, and the `combine` gate that measures all three. So is step 2's audio —
   the cut and join (25.4) and the decoder delay (25.5), measured to 0.0 ms through both
   formats it writes — and all of step 3: the hitsound remap (25.8), the slider velocity
   (25.9), the difficulty reconciliation (25.10) and the junctions (25.11), with metadata
   and credits (25.13), the output folder (25.16) and three quarters of the build report
   (25.15). Since the **Compile section** (25.14) landed the same day, a compilation can be
   built from the app: pick the maps, order them, press Build. What is left: the loudness
   match (25.6) and the crossfades (25.7); per-segment backgrounds (25.12); the compilation
   drawn on a timeline; picking a segment from the structure view (25.18); the order
   suggestion (25.19); and the reference grade that would close 25.15.

Two proposals wait on a decision, not on work: the Rhythm guide (`04-ui-ux.md` §9 still rules
out inventing objects from the audio, after the 2026-10-03 carve-out that lets a compilation
copy whole maps), song import from a streaming link
(blocked by the offline rule, see Phase 19), and whether exported red lines follow ranked
maps' convention, a median 21 ms before the sound, or the sound itself (10.0a).

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
| Workspace skeleton | crates + dependency rules | low | high | toolchain | no | no | **P0** | **done** — 7 crates; `check-deps` rule not automated |
| `python/` (v3 home) | v3 engine + GUI + bridge in their own folder, still runnable | low | high | — | no | no | **P0** | **done** — a copy in `reference/` stays deferred (2026-09-24): it would keep changing while v3 is the app's default engine and its only `.osu` reader/writer |
| `requirements.lock` | exact versions behind the measured baseline — **F-05** | trivial | med | — | no | no | **P0** | **done** |
| Golden-vector dump | per-stage attacks, seeds, octave, sections, points | med | **high** | — | no | no | **P0** | **done** |
| Golden-vector check | stage-by-stage diff, so a divergence names its stage | med | **high** | dump | no | no | **P0** | **done** |
| Corpus port | the 24 fixtures run through the Rust engine | med | **high** | skeleton | no | no | **P0** | **done** — `overtone-bench golden` |
| **Octave-agreement gate** | pins absolute BPM per fixture — closes **F-07** | low | **high** | — | no | no | **P0** | **done** |
| **Density-change gate** | measures the coverage signal — closes **F-11** | low | high | — | no | no | **P0** | **done** |
| Pulse-hint regression test | documents the one-directional hint gap | trivial | low | — | no | no | P1 | **done** |
| Perf gate | per-stage budget vs measured baseline | low | med | corpus | no | no | P1 | **done** (2026-09-27) — `bench/gates.py perf`: each announced stage held to the CPU and wall seconds pinned in `bench/perf_snapshot.json`, on three cases covering the grid engine, the long track and the fallback. Single-threaded in a child process (free pools swung the same stage 1.72-3.11 CPU s); fails past 2x and +0.3 s of CPU or 3x and +1 s of wall, so an unchanged stage's 1.11x passes while an injected 1.5 s wait and 2 s of arithmetic were both caught by name |
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
| Unit tests ported | the v3 tests by name | med | **high** | all | no | no | **P0** | **done** (2026-09-27) — measured instead of guessed: `bench/parity.json` places all 155 engine stages the v3 tests touch, and `bench/parity.py` derives from it that **381 of 524** v3 engine tests touch a stage Rust holds, naming the `#[test]` functions that hold each one and failing when a rename leaves the claim behind. The other 143 are outside the Rust engine's surface and say so: 61 shell, 31 python-only, 29 bench, 16 the v2 fallback tracker Rust never grew. It measures the surface, not one Rust test per Python test |
| Property tests | ×2/÷2 identity, exact-grid recovery, monotone boundaries | low | high | all | no | no | P1 | **done** (2026-09-27) — `crates/overtone-tempo/tests/properties.rs`: the three claims over generated tracks (240 cases each, 60 where growth runs), plus snapping idempotent and bounded and whole-ms output in order. A seeded SplitMix64 generator rather than a property crate, since the build is offline and a printed seed is what a failure actually needs. Three of six failed first: two were the half-a-slot arithmetic a seed error obeys (over the track, and over the 8 s seed window), the third is the row below |
| ×2/÷2 offset slack | the displayed factor must not tip which bar the first line lands on | low | med | points | no | no | P2 | todo — measured 2026-09-27: the slack in `_points_from_sections` is a quarter of the *displayed* beat, so ×2 moves the first red line 0.455 s on very-noisy-132 (1 of 76 line-and-factor pairs over the 27 golden vectors; the other 6 are ÷2 landing on a beat it declares, which is correct). Reading the slack from the section's own grid leaves factor 1 bit-identical on all 27 and removes it — both engines, so it wants the gate run |
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
| Parallel + cache | rayon stages, content-keyed cache | med | **high** | P1 | no | no | **P1** | **done** (2026-09-28) — the result cache in the shell (re-analysis 2.04 s → 0.02 s), and the stages: the STFT, HPSS, the structure matrix and the coherence sweep were already parallel, and the onset envelope's decibel and flux passes now are too (0.254 → 0.069 s and 0.185 → 0.031 s on a six-minute track, bit for bit the same envelope). The larger win was not threads: growth was refitting a whole section on every step, and a 128-beat trailing window takes that stage from 1.001 to 0.121 s. The analysis of a six-minute track runs 1.98 → 0.69 s, the 27-case corpus 7.96 → 5.61 s, and 27/27 still match v3 stage for stage |
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

What reaches the app goes through `overtone-cli`: structure and section labels (the
Structure view), the elastic grid (the Ramps card in Timing) and the band features behind
the hitsound evidence and decision. The per-section octave and the 2-D coherence map are
measured by the bench and not used by the CLI yet. The percussion-only audition uses
librosa's HPSS on the Python side.

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
| Progress panel | per-stage ticks and timings, cancellable | low | med | shell | no | no | P1 | **done** (web shell) — each stage named, the finished ones ticked with their times, a running clock and Stop; the song panel keeps the times |
| Dashboard | drop target, recents, folder entry points | low | med | shell | no | no | P1 | **done** |
| Honesty banners | fallback engine, late first line, validation findings | low | **high** | shell | no | no | P1 | **done** |
| Confidence ribbon | per-section confidence under the ruler | low | med | timeline | no | no | P2 | **done** — a strip along the tempo plot's foot, each section in its list bar's colour (90 % and up, 75 % and up, below), in the legend, and the hover names the line's confidence |
| Spectrogram layer | optional spectral energy | med | low-med | STFT | no | yes | P3 | todo |
| Light theme | full token counterpart | low | low | tokens | no | no | P3 | **done** — one light token block, canvas ink included; Settings → Theme (System, Dark, Light) |
| Zoom and pan | wheel zoom anchored at the cursor, drag to pan; beat grid and attack ticks when zoomed in | med | **high** | timeline | no | no | **P1** | **done** — beat grid, bars brighter; attacks show in the drift lane |
| Drag red lines | click to select, drag to move (snapped to attacks), double-click to add | med | **high** | zoom | no | no | **P1** | **done** but adding — snaps within 6 px, Alt frees it, one undo; double-click plays instead, and the editor adds |
| Drift lane | how far each attack sits from the grid osu! will play | med | high | timeline | no | no | P1 | **done** — nearest 1/1-1/4 tick of the governing line, ±30 ms, green ≤5, amber ≤15 |
| Map red lines as ghosts | the loaded .osu's red lines drawn beside the detected ones | low | high | compare | no | no | P1 | **done** — from the reference card, else the compare card |
| Verdict strip | which engine answered, its residual, and whether to trust it, in one line | low | high | shell | no | no | P1 | **done** (2026-09-28) — one line under the stats: the engine that answered, the fit, the steadiness, the line count, and whether to doubt them. Calibrated on Corpus B: of the 9 readings a mapper would reject, falling back and stability under 0.9 flag 5 between them; the other 4 are octave errors that fit beautifully (residual 11-17 ms, stability 0.90-0.98), and the octave margin does not separate them either, so the quiet state says nothing looks wrong and names the octave as what it cannot check. The loose-fit banner, which fired on all 15 ranked tracks at 5 ms, moves to 30 |
| Snap indicator | say when export snapping moved an offset, so a ±1 ms nudge is not silently undone | low | med | editor | no | no | P2 | **done** without an indicator, by fixing the cause — snapping never moves a hand-placed line, and every edit now starts from the line as it is shown, so a nudge moves the shown and written line by exactly its step |
| Uncovered-intro shading | hatch the audio before the first red line | low | med | timeline | no | no | P2 | **done** — hatched across every lane, and the hover says the first line's grid runs back there; the banner stays for a late first line |
| Density ribbon | half- and double-time inside one reported section | med | med | P2 density | no | no | P2 | **done** (2026-09-27) — `density_hints` in the engine (the prototype moved in, identical to it and to the Rust detector on all 27 fixtures: 4/4 real changes, 0 false positives of 23), a bridge call, and a band on the tempo map with a card saying what to do — ÷2/×2 on that section or a red line there — and the coverage and parity behind it. Corpus B: 5 hints on 19 tracks, none where the map already changes octave because the engine had split those sections itself. Nothing is moved automatically, by decision (DSP §B.2) |
| Measures on the map | bar ticks and signature regions | low | med | timeline | no | no | P2 | **done** — the bar lines stay when the beats are too close to draw (bars 8 px apart or more), and a red line where the bar changes length names the signature on its chip ("150 · 3/4") |
| Keyboard map | every action reachable from the keyboard; `?` shows the sheet | low | med | shell | no | no | P2 | **done** — `?` shows every key; ←/→ seek 1 s (Shift: 10 ms), `[`/`]` the red lines, L loop, C click, 1–9 and 0 the rail, on top of Space, T, ↑/↓, Ctrl+O/Z/Y and Enter/F5; buttons reach by Tab. Not bound: mute, solo click, beat steps |
| Cancellable analysis | stop button, stage names and timings | low | med | progress | no | no | P2 | **done** — the engine is asked at each stage it announces, inside the stages too (next row), and once more before a result replaces the one on screen, which stays |
| Stop inside a stage | a stop that lands in seconds, not when the stage ends: attack detection ran 48 s on an eight-minute track, the fallback's transients 53 s on another (machine busy) | med | med | cancellable analysis | no | no | P2 | **done** — checkpoints in every stage's long loops, asked on the analysing thread only (the STFT, decode and octave tempogram split so each piece is the call it replaces, bit for bit), and the Rust engine's process ended. Pressed 25/50/75 % into each stage of four songs, a stop landed in a median 0.03 s, 0.5 s at most (before: 0.87 s, up to 36 s); no measurable cost on an analysis that is not stopped |
| Command palette | Ctrl+K search over every action | low | low | shell | no | no | P3 | todo |

---

## Phase 4 — Playback and timing editor

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Transport | play/pause/seek inside the app | med | **high** | audio | no | no | **P1** | **done** — WebAudio, Space to play/pause, position bar |
| Live click track | click synthesised against the *current* timing points | med | **high** | transport | no | no | **P1** | **done** — ``click_schedule``, the WAV export's own; scheduled 150 ms ahead, so an edit is heard on the next beat |
| Playhead sync | position on the timeline at 60 Hz | low | high | transport | no | no | **P1** | **done** — its own layer over the tempo map |
| Scrub + loop | scrubbing, loop selection, loop section | med | high | transport | no | no | P1 | **done** — seek bar, loop section (sample-exact, the click folded into it), a loop drawn on the map (Shift-drag, ends on the beats; Alt anywhere), and the scrub heard: stopped, the seek bar, the arrow keys and the red-line jumps play a 120 ms grain where they land (2026-09-26) |
| Play from beat / point | click a beat or red line to play from it | low | med | transport | no | no | P2 | **done** — from the selected red line, or double-click the map |
| Grid editor | edit offset/BPM, ±1 ms nudge, ×2/÷2 | med | **high** | P1 | no | no | **P1** | **done** (web shell) |
| Add / delete / split / merge | with recalculation | med | high | editor | no | no | **P1** | **done** (web shell) — split at the playhead on the section's beat, merge with the next; the sections involved refitted to their attacks, or kept with the reason |
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
| Parser fuzzing | fuzz the reader | low | high | reader | no | no | P1 | **done** — `bench/fuzz_reader.py`: mutant .osu files (lines, fields, bytes, BOMs, stray line breaks) through the reader, the byte-for-byte writer and 13 consumers of a parsed map; it found four bugs, each fixed with a test; 15,000 mutants on five seeds pass |
| Beatmap folder import | audio + all difficulties from one folder | low | med | reader | no | no | P1 | **done** |
| **Map vs detected compare** | per-section BPM/offset diff table | med | **high** | reader, P1 | no | no | **P1** | **done** |
| Audio/object alignment | do the map's objects land on real attacks? | med | **high** | reader, attacks | no | no | **P1** | **done** |
| lazer compatibility | decimal offsets, `.osu` v14+ specifics | low | med | writer | no | no | P2 | **done** — decimal offsets in Settings → Offset precision (0-3); measured on the 270 local v128 maps (osu!lazer's export): all read and written back byte for byte, an inject dry run ok on all; 3 carry decimal timing offsets, none a decimal object time (2026-09-26) |
| **Per-section meter** | each red line carries the bar its own section proved | med | high | meter | no | no | **P1** | **done** |
| **Downbeat anchoring** | every red line lands on a downbeat | med | high | meter | no | no | **P1** | **done** |
| Meter-change detection | split on time signature, not only on tempo | high | med | sections | no | no | P2 | **done** for a constant bar |
| Bar-length change | 4/4 → 3/4 keeping the *beat* | high | med | meter | no | no | P2 | partial — by hand: the point editor's "Beats per bar" sets a red line's bar length (1–16), its BPM and shown offset kept, the meter known from then on; finding a bar-length change at the same BPM by itself stays open (the measures gate's downbeat-4-then-3) |
| `.osz` export | audio + a minimal `.osu` in a zip | med | high | writer | no | no | P2 | **done** |

The measure-based rows come from comparing against [Tempora](https://github.com/teamkongehund/Tempora),
which times a song by pairing audio points to a timeline of measures. Overtone automates
the pairing (`t(k) = offset + k·period`, fitted over hundreds of attacks); the measures
were what was missing.

---

## Phase 6 — Hitsound engine

All of [`06-hitsound-engine.md`](06-hitsound-engine.md). **In the app since 2026-09-24/25:**
the copier, the Hitsounds section, the consistency check in the mod report and the
decision engine's proposals, with detection and decision in Rust behind `overtone-cli`.
The order of work, and what has to land first, is
[`15-hitsound-plan.md`](15-hitsound-plan.md): the prerequisite rows below (P-1 to P-7), then
the copier, the section, the check, the decision engine, the editor.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| P-1 Sound events from the map | every object as the sounds it makes (edges, body, spinner end), resolved against the timing points | med | **high** | P5 reader | no | no | **P1** | **done** — `sound_events`; 0 errors on 3,000 local maps, slider lengths held (0.04 % overlap, all in gimmick maps) |
| P-2 Hitsound field writer | only `hitSound`/`edgeSounds`/`edgeSets`/`hitSample` change; zero-change write byte-identical | med | **high** | P5 writer | no | no | **P1** | **done** — `set_object_hitsounds`, `write_object_hitsounds`: edits over the file's own text; flip and restore on 2,998 local maps sound identical, only object lines move |
| P-3 Sample playback | samples found as osu! finds them, Overtone's own synthesised defaults, on the playback clock | med | **high** | P4 playback | no | no | **P1** | **done** — `assets/samples.py`, `hitsound_playback`, the transport's "Hitsounds from"; slider bodies loop their slide and whistle slide (2026-09-26); the skin, never read before, asked between the map's samples and Overtone's once one is chosen on the Samples card (H6, 2026-09-26) |
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
| Object context | type, pattern, spacing, combo, existing hitsounds | med | **high** | P5 reader | no | no | **P1** | **done** (2026-09-28) — every sound event, not every object start: a slider's head, each repeat and its tail, and a spinner's end, each with the sound that edge itself plays. On five ranked maps that is 1,653 of 6,207 events (27 %) which had no context at all, and 1,179 of those (71 %) were being reported with their head's sound. Type, spacing, pattern, combo and the existing hitsound are all per event; positions stay the owning object's, since a repeat's needs the slider path |
| **Viterbi decision** | sequence labelling with consistency costs | high | **high** | all above | no | no | **P1** | **done** — `overtone-cli hitsound`: 19/19 synthetic exact, real clap/finish F1 above the rules on two samples |
| Explanations | itemised terms + alternatives | med | **high** | decision | no | no | **P1** | **done** — a row's inspector in the Hitsounds section: the proposal and its two runner-ups with their chances, what was heard under it (three likeliest instruments, place in the bar) and every term signed; the features behind each instrument stay in `overtone-cli hitsound-evidence` |
| Profiles | built-in + custom, as data | low | high | decision | no | no | **P1** | partial — Balanced baked in; Drum-focused ships as `profiles/drum_focused.json`; and eight **genre profiles** (metal, metalcore, punk, rock, jrock, pop, funk, electronic) whose metrical criterion is measured from 748 mapsets of the user's library by `bench/genre_corpus.py`, not written by hand: the share of each addition's placements per sixteenth of the bar. Held out on a third of the maps the table never saw, it beats the old rule in 25 of 27 genre-and-addition cells, median +0.29 bits a placement. Jazz lost and ships no table. Minimal measured. The card preselects the profile the map's own tags claim (`hitsound_genre`, the classifier the tables were measured with), marked as a suggestion and never a choice |
| Hitsound timeline | instrument lanes over object lanes | med | **high** | P3 timeline | no | no | **P1** | partial — the object lane (P-7), drawn with each sound's additions. The instrument lanes wait on the classifier, and the number is current: median `P(snare)+P(clap)` 0.168 at mappers' claps over 12 ranked songs. Reading the percussive half instead was tried and measured **worse** (0.138); the 0.458 a probe showed came from its resampling to 22 kHz, not from separating. What the measurement points at is the calibration's domain: the corpus renders claps as band-passed noise and the snare template asks for flatness 0.25 and up, where real claps in a mix measure 0.036 — so that feature scores nothing for practically every real drum (`bench/templates_on_real_audio.py`) |
| Hitsound editor | change/remove/volume/sample | med | **high** | decision | no | no | **P1** | **done** — the Decide card ticks proposals by row or by bars, swaps one for an alternative, sets volume and sample index by hand, and plays it all over the song as the write would make it (equal to the written copy on 799 of 800 local maps, the last refused alike by both), then previews, writes the file or a copy and undoes once |
| Sample bank | import skin/folder, audition samples | med | high | P4 playback | no | no | P1 | **done** — `sample_bank` reads a skin or beatmap folder as playback reads it: the 12 hits and 6 slides per set, custom indices, empty and never-played files, what a missing one falls back to (60 local skins and 200 beatmap folders; a beatmap folder read for the first time in a median 2.0 ms). The Samples card in the Hitsounds section shows the song's folder, the playback skin or any folder, plays each sample alone or over the song in place of the sound selected in the table, and chooses the skin playback asks between the map's samples and Overtone's (a setting) |
| Sample recommendation | map samples to roles by their spectrum | med | med | bank | no | no | P2 | todo |
| Hitsound export | only hitsound fields change | med | **high** | P5 writer | no | no | **P1** | **done** — the Decide card writes the file or a copy; the Export section writes a hitsound difficulty for the whole mapset, which copied back with H1 leaves its source as it was |
| Consistency check | flag objects whose sound disagrees with their role | low | high | decision | no | no | P2 | partial — map half and silence half in the mod report (missing/extra clap; finish/clap with no attack under them); clap-mismatch refused on measurement until the templates prove themselves on real audio |
| Audio-only proposal | hitsounds from the song alone, no map: attacks → classes + role, proposed on the song's own analysis | med | high | H4, P-4 | no | no | P2 | **engine done 2026-10-03** — `hitsound <audio>` decides strong attacks (weight ≥ 0.5, residual ≤ 5 ms) with the same core, no combos/prior/bars, reported `"mode": "audio-only"`; mapper clap F1 0.29 on 6 maps, bare-H4 agreement 0.50 — app surface (Propose without a map, write path) still open |

The F1 numbers are measured on synthetic arrangements the fit never saw, from the same
corpus generator; they say the classes separate, not how they do on real songs.

---

## Phase 7 — Validation and mapping analysis

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Validation rules | duplicates, very short sections, impossible changes, suspicious offsets, octave mistakes | med | **high** | P5 | no | no | **P1** | **done** — shown as banners |
| Hitsound validation | missing samples, silent assignments, inconsistent patterns | med | high | P6 | no | no | P1 | partial — in the mod report since H3: claps that break the map's own pattern, finishes and claps with no attack under them; missing sample files are counted by the playback and, measured, not reported: osu! plays the skin's there, and 78 % of 800 local maps ask for one, mostly an index-1 hitnormal left to the skin on purpose |
| Alignment report | objects not on attacks; attacks with no object | med | high | P5 | no | no | P1 | **done** |
| Never auto-fix | every finding is a proposal with a consent step | low | **high** | rules | no | no | **P1** | **done** |
| Density analysis | objects/s over time | low | med | P5 | no | no | P2 | **done** |
| Rhythm pattern recognition | recurring rhythmic figures | high | med | P2, P5 | opt | no | P3 | todo |

---

## Phase 8 — Automation

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| CLI rewrite | `analyze · timing · hitsound · validate · inject · export · bench` | med | **high** | P1, P5 | no | no | **P1** | partial — Python CLI covers analyse, CSV, click, .osz, inject, folders, and a map checked (`--check`, the mod report, exit 3 on findings); no hitsound or bench commands |
| Machine-readable output | `--json` | low | high | CLI | no | no | P1 | **done** for analyse |
| Batch folder analysis | every audio file in a folder | low | high | CLI | no | no | P1 | **done** |
| Batch hitsounding | many difficulties, one analysis reused | low | high | P6 | no | no | P1 | **done** (2026-09-27) — `overtone-cli hitsound` takes a mapset and reads the audio once, a map it cannot read costing the others nothing; "Every difficulty" in the Hitsounds view runs it and each difficulty then shows its cached proposal when picked. 8 difficulties in 19.1 s against 148.0 s one by one (7.8x), 7 in 40.1 against 296.4 (7.4x), the same sounds map for map; a switch afterwards 0.55-0.75 s |
| Project format | reopen a song with its edits without recomputing | med | high | P2 cache | no | no | P1 | **done** for the timing work — each song's red lines and locks saved after every edit to `<output folder>/Projects/<song> [<sha>].oto` (JSON, atomic), offered back after its analysis, undo returning to the analysis; not kept: the undo history, the view, notes, earlier versions (14.1's full list) |
| Watch mode | re-analyse on file change | low | low | CLI | no | no | P3 | todo |

---

## Phase 9 — Experimental

Nothing here is promised. Each item is a hypothesis with a way to test it.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Drum classifier (CNN) | small mel-patch model vs calibrated templates | high | med-high | P6 corpus | **yes** | opt | P2 | todo, and the case for it is measured. On 7,772 held-out attacks of real songs the shipped classifier ranks a clapped attack above a bare one 52.6 % of the time, where the percussive ratio **alone** reads 0.687 and flux 0.680 — it scores worse than features it already carries, because the response curves were placed on synthetic drums and clip them to zero (the percussive ratio counts from 0.45; real attacks sit at 0.08-0.44). The same features with their curves on real ranges reach **0.743**. So the hand-built features have not plateaued — they were never placed on real audio, and that is cheaper to fix than a model (`bench/templates_on_real_audio.py --fit`). With two labels — claps for snares, finishes for crashes — the engine tells a crash from a snare at **0.491** on real music, a coin toss on the distinction every hitsound proposal rests on, and the same features fitted together with their curves on real ranges reach **0.810** (`--classes`) |
| Vocal onset model | the weakest classifier; the best ML candidate | high | med | P6 | **yes** | opt | P2 | todo |
| Learned structure | section labels from a small embedding | high | low-med | P2 | **yes** | opt | P3 | todo |
| Full drum transcription | complete kit transcription | high | med | classifier | yes | opt | P3 | todo |
| Timing suggestions | list red lines a map is missing | med | med | P7 | no | no | P2 | **done** — shown in the compare card |
| Apply a suggestion | write one suggested red line into the `.osu`, with backup and consent | med | med | suggestions, writer | no | no | P2 | **done** — Add beside each suggestion in Map check: that red line alone, carrying the sounds in force, a green where slider velocity needs one; the confirmation names the objects and slider ends it moves and warns at ×2/×4 the map's tempo; backed up, logged |
| Octave-marked suggestions | mark in the list itself a suggestion at ×2 or ×4 the map's own tempo there, not only in the consent: on Corpus B 5 of 23 were, and they alone moved slider ends past 25 ms | low | med | suggestions | no | no | P2 | **done** — a pill beside the suggestion's BPM (×2, ×4, ÷2, ÷4) with the map's tempo in its tooltip; one rule, the octave finding's band, for the list and the consent. Corpus B: 6 of 23 marked, all 5 slider shifts past 25 ms among them |
| Waveform annotation | user notes pinned to timeline positions | low | low | P3 | no | no | P3 | todo |
| Plugin API | third-party analysis stages | high | low | P0 rules | no | no | P3 | todo |
| WASM engine | the core in a browser | med | low | P1 | no | no | P3 | todo |

---

## Phase 10 — Human-level timing accuracy

Documented in full in [`10-precision-plan.md`](10-precision-plan.md). **Measured, nothing
shipped.** The goal: push accuracy on real songs from today's **1.7 %** of ranked red lines
with an Overtone beat within 5 ms towards 90 %+, offline. That is v3 on Corpus B, 1,152 red
lines of 20 ranked maps, measured 2026-09-26 with `bench/corpus_b.py`; averaged over the
tracks it is 2.6 %, and within 50 ms 47.9 % (1.6 %, 0.9 % and 46.9 % before the fallback
tracker's beats moved onto their attacks, the same day). The "~5 %" quoted here before came from one
track, *Vampires Will Never Hurt You* (4.7 % on 2026-09-22, method not recorded); Corpus B's
scorer reads 5.9 % there. Two things set the gap: the red lines read a median 24-27 ms after
the maps', and one grid, or none, against a band that drifts. The 24 ms are explained (10.0a):
ranked maps put their lines a median 21 ms before the sound starts, and Overtone's grids sit a
few milliseconds after it.

**Measurement first.** Nothing ships without a measured gain on Corpus B — 20 hand-timed
ranked tracks across every category — while Corpus A (the 24 synthetic fixtures) stays
green. The truth has a spread of its own: two ranked maps of the same audio agree on 82 %
of their red lines within 5 ms, and on 74 % where they differ at all (319 pairs, measured
2026-09-26), so 90 % of one mapper's lines asks more than a second mapper gives.

The gain column below is an **estimate, not a measurement**; each sub-phase replaces its
estimate with a number or is dropped.

| # | Sub-phase | What it adds | Estimated gain | Status |
|---|---|---|---:|:--:|
| 10.0 | Corpus B | 20 ranked tracks + the scoring script | — | **done** — `bench/corpus_b.json` + `bench/corpus_b.py`: v3 1.6 % of 1,152 red lines within 5 ms (0.9 % per track, 46.9 % within 50 ms), Rust 1.4 % (5 of 20 refused); signed error a median +24.0 ms per track |
| 10.0a | The late reading | explain the +24 ms Overtone reads after the mappers' lines on every category of Corpus B, steady songs included (so not drift); correct it only once the cause is found and shown, with Corpus A green | diagnostic: a constant subtracted takes v3 from 1.6 % to 14.4 % | **explained, not corrected** (2026-09-26, `corpus_b.py --onsets`) — ranked maps put their lines a median 21.4 ms before the sound's first edge (100 held-out maps, IQR 18.1-23.9, all 100 before it; LAME MP3, other MP3 and OGG alike; the decode is exact), and Overtone's grids sit a median 7.9 ms after it (Corpus B); about half of that is the re-timing following the full band's rise, which can come well after the first edge, and the rest is not traced yet. The convention is not in the audio; re-timing on the first difference moved attacks onto the edge (Corpus A 0.16 → 0.08 ms) but made the tempo worse on 6 of 20 songs (better on 4), so dropped. Next: decide whether the export writes osu!'s convention (about -21 ms, at export, never in the engine); then a phase fitted on edge-timed attacks (estimated -3.5 ms) |
| 10.0b | Human agreement as a mode | the mapper-against-mapper check (82 % of red lines within 5 ms on 319 pairs of ranked maps sharing one audio) as a repeatable bench mode, with a read-only `osu!.db` reader for ranked status; the 90-95 % target restated against it, which is a decision | — | todo (proposed 2026-09-26) |
| 10.0c | Refusals on Corpus B | v3 refuses The Raven (pulse gap 0.024, under the 0.07 floor); Rust refuses 5 of 20 and reads FREEDOM DiVE as one 333.33 BPM line in 12/4 where v3 reads 222.22: each explained, and fixed only where the engine is wrong | — | explained 2026-09-30: the 4 Rust-only refusals are by design (no fallback; v3-precision refuses them too), The Raven is refused by both (genuinely hard), and the FREEDOM DiVE divergence is localized to the points stage (razor-margin best-1 among weak meter segments); an earliest-survivor fix measured net-negative and was reverted |
| 10.1 | Fingerprint & reuse | match the audio against the user's own `osu!/Songs`; exact when the song is already mapped. Scored on Corpus B only with each track's own mapset held out, or it finds its own answer | large when matched | todo |
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
| 10.12 | UX for slow but precise | stage progress, cancel, cached intermediates | usability | partial — result cache, stage progress with timings, a stop that lands inside the running stage; no cached intermediates |
| 10.13 | **MSI distribution** | one self-contained installer + portable ZIP — [`11-msi-distribution.md`](11-msi-distribution.md) | packaging | partial — 10.13.1 and 10.13.5 built, 10.13.2 in part (2026-09-26): `installer\build.py`, a per-user MSI and the ZIP, smoke-tested unpacked; the pinned wheels' licences inventoried in `installer/sbom.json` with a drift gate (2026-09-30; LGPL/MPL flagged, 2 UNKNOWNs, natives still open); no signing or file associations |

**Licences, checked at the source on 2026-09-23** (full table in `10-precision-plan.md`):
Beat This! is MIT down to its weights; BeatNet is CC-BY-4.0; madmom's models are
non-commercial (CC BY-NC-SA); Demucs's weights are "only for scientific purposes", so
they do not ship; WiX is MS-RL with a maintenance-fee EULA; Tempora is CC BY-NC-ND, so its
code is never copied — only its ideas are reimplemented.

**Escape valve.** Some tracks will stay unresolvable (real rubato, aesthetic timing
choices). For those, an assisted mode — the user marks two downbeats — rebuilds the rest. Built on 2026-09-24 as Assisted timing (Phase 19): the marks are typed in ms, or tapped from a downbeat.

---

## Phases 12–18 — Comfort features

Documented in [`12-comfort-features.md`](12-comfort-features.md). They touch the
presentation and I/O layers, not the engine, so they run in parallel with the rest.

| Phase | Adds | Status |
|---:|---|---|
| 12 | Modern UI | **superseded** — the web shell (Phase 3) replaced the PySide6 plan |
| 13 | Audio playback — transport, live click, scrubbing, MIDI tap | partial — Phase 4 transport, live click, loop and scrub heard while stopped; no MIDI tap |
| 14 | Project system — project file, auto-save, undo, **organised output folders**, batch | partial — undo/redo, result cache and the output folder (Phase 20), and a project file per song saved after every edit; no journal, no batch |
| 15 | Deep osu! integration — Songs browser, lazer, editor round-trip, sample library | partial — folder import, Songs browser; no lazer |
| 16 | Localization + accessibility | partial — English/Spanish; no screen-reader work |
| 17 | Plugins + reports | todo |
| 18 | Advanced input — multi-monitor, loopback capture, video preview, MIDI | todo |

**Output-file policy** (14.4b): the app's exports go under
`%USERPROFILE%\Documents\Overtone\` unless told otherwise, never next to the installed app
(Phase 20's output folder).

---

## Phase 19 — App sections

One sidebar entry per job, each shippable on its own, all sharing the one
loaded song. Ten are in (Library, Timing, Structure, Hitsounds, Map check, Mapset,
Report, Export, History, Settings); Audio is the one left.

| Section | What it holds | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Session model | one loaded song shared by every section through events | med | **high** | shell | no | no | **P1** | **done** — one song shared by every section |
| Library | home: open audio or a beatmap folder, recents, osu! Songs browser with search | med | **high** | P5 reader | no | no | **P1** | **done** — recents, folder import, Songs browser on a SQLite + FTS5 index (Phase 24): search as you type, rescan reads only what changed |
| Library focus | leave the Library category working well: scan/rescan with truthful folder progress, search fast on a full Songs folder, clear empty and error states, and the health check (Phase 21) listing maps whose timing disagrees with their audio | med | high | Library, index, compare | no | no | P1 | partial — measured on the local Songs folder (4,802 folders, 25,174 maps) and fixed on 2026-09-26: the first scan (263 s) waits on first opens, now 4 at a time (1,211 fresh maps 29.0 → 7.1 s); progress counts folders in the index from 0, 0.25 s apart at most, and says what it removes; unreadable folders and files keep their rows and are named; a damaged index is rebuilt; one-letter search p50 58 → 15 ms; the page says each state (to see in the browser); the health check has its page since 2026-09-30 (counts by verdict, a resumable run with progress, flags with per-line evidence marked actionable or weak) |
| Timing | tempo map, points, editor, verdict | — | — | — | no | no | **P1** | **done** |
| Map check | compare, alignment, validation, density and suggestions for the loaded difficulty | med | **high** | P5, P7 | no | no | **P1** | **done** — own section: compare, alignment, density, snap audit, suggestions |
| Hitsounds | instrument lanes, per-object sound, exported hitsound difficulty | high | **high** | P6 | no | no | P1 | partial — the section is in: where each addition falls, every sound heard one by one (H2), the Propose card (H5) and the hitsound difficulty in Export; instrument lanes wait until the templates hold on real audio |
| Audio | spectrogram, 7-band onset lanes, percussive/harmonic balance, energy with sections, tempo heatmap | med | med | P2 via bridge | no | opt | P2 | **done** (2026-09-27) — the section holds all five. `band_flux` ports the Rust front end constant for constant (identical frame counts and loudest frames on all 27 fixtures, worst band total 6.07e-06 apart), the bridge max-pools each lane to 1,600 columns scaled by one peak, and the view draws them low band at the foot. The picture is the analysis path's own mel, pooled by maximum so a transient survives a column, sent a byte a cell. The balance runs Fitzgerald's median separation on that same mel grid, its two kernels chosen by what they do to signals whose truth is known (pads 0.011, white noise 0.486, the drum corpus 0.26-0.27). The loudness curve is RMS against the song's own peak with the Structure view's sections behind it, and stands without them where the sidecar is not built. The tempo heatmap is `R(t, f)` over the whole track — a 12 s window every 2 s on a shared frequency grid, ridge tracked with octave continuity — with the reported red lines drawn over it, since coherence peaks at a multiple of the pulse as readily as at the pulse |
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
| Structure view | phrase boundaries snapped to the nearest proven downbeat, labelled with the evidence for each label, over the energy lane; home for the kiai, preview, bookmark and break proposals | med | **high** | P2 structure + classify, P22 | no | no | **P1** | **done** — `overtone-cli structure`, `structure_view`; section edges where the song starts or stops repeating itself (Structure edge recall, below), each on a proven bar within 1.5 s, the nearest or the one either side where the level changes more (Phrase level rule, below) |
| Phrase starts on the phrase's bar | snap to the bar the phrase starts on, not the nearest; measured against ranked maps' kiai starts as truth | med | med | Structure view | no | no | P2 | **done** 2026-09-26 — the Phrase level rule, below (timeline). Where a kiai start has an edge within 2 bars, the nearest bar was the kiai's own 35-46 % of the time (20 % by chance), and the level rule 56 % and 49 % on the two samples it was not chosen on. Most kiai starts had no edge within 2 bars then: Structure edge recall |
| Phrase level rule, confirmed | freeze the rule that just missed (the nearest bar or a neighbour where the level changes most, one bar either side, 0.5 dB) and confirm it on the 673 eligible songs neither sample used; it ships only if it clears +10 points and p < 0.01 there | low | med | Structure view | no | no | P2 | **done** 2026-09-26 — shipped in `structure_view`. On the 673 unused songs, read once: the kiai's own bar 35.5 % -> 48.8 % (+46 fixed, -19 broken, sign test p 0.0011), kiai ends 49.7 -> 51.8 %, clearing the bar set before |
| Structure edge recall | 88 % of ranked kiai starts have no structure edge within 2 bars: find the edges the novelty curve misses (per-song thresholds, repetition in the self-similarity matrix, energy steps), measured against kiai starts on the same samples, with the edges it adds checked for false ones | high | high | Structure view | no | no | P1 | **done** 2026-09-26 — `structure::phrases` for `overtone-cli structure` (timeline): edges where the song starts or stops repeating (structure features); the novelty curve sat no closer to kiai starts than chance, whatever its threshold. On the held-out sample, read once against a bar set before: kiai starts with an edge within 2 bars 11.6 -> 58.0 %, edges near a kiai start or end 14.6 -> 39.8 % (16.5-17.2 % by chance), 6 edges a song against 3. The hitsound engine keeps the novelty edges. The Kiai card lights fewer songs (99 -> 87 of 500): Section labels from repetition |
| Section labels from repetition | a chorus needs two repeated families, and the classifier groups sections by mean chroma, which a full mix makes alike: one family holds every section of the median song. The recurrence matrix behind the edges already says which parts return; label from it, measured on the Kiai card against ranked maps' kiai (chorus time under kiai, songs lit) | med | high | Structure edge recall | no | no | P2 | todo (proposed 2026-09-26) |
| Mod report | every finding as osu! editor timestamps (`mm:ss:mmm (combo) - ...`) with its number and confidence, copyable as text; each opens the local osu! editor | low | high | P7 findings | no | no | P2 | **done** — `mod_report`, the Report section: reference, suggestions, snap audit and alignment in time order, combo numbers, `osu://edit/` links from validated timestamps; 0.31 s per map |
| Write history and restore | a log of every `.osu` write and its backup; see the timing diff against the backup and restore atomically, keeping the current file as a new backup | low | med | writer | no | no | P2 | **done** — JSONL log beside the cache, History section with per-write red diff and confirmed restore |
| Evidence view | the engine's alternatives for the open song: coherence candidates, octave margin, per-section residual and coverage, half-time hints, why the fallback ran; each one click from ×2 / ÷2 | med | med | payload fields or P22 | no | no | P2 | **done** — `analysis_evidence` + Timing card: candidates with coherence, seeded/half/double marks, octave margin, residual/coverage; Use writes the BPM into the governing red line through edit_apply |
| Ramp and live timing | the elastic tempo curve turned into the fewest red lines that keep every attack within a chosen drift (ms) or one line per N bars, with the count-versus-drift trade-off shown | high | high | P22, elastic grid | no | no | P2 | **done** on synthetic ramps — `overtone-cli ramps` + Timing card: longest grids back to back on strong attacks, tradeoff table, max-lines cap; Use loads hand-placed lines, only where the engine recommends ramps. On two real songs it cut the jitter into two-attack grids at the atomic pulse (184 lines, 173-794 BPM on a steady 172), which the selector turned down |
| Audio swap | the shift between a mapset's old and new audio from full-waveform correlation (onsets biased sub-frame shifts by a frame in the probe), refused on a tempo mismatch; on consent every time in every difficulty moves, with backup | med | high | writer, attacks | no | no | P2 | **done** — correlation at 11 kHz (±0.005 ms on real music), tempo twins and different cuts refused, Mapset card with preview and confirmed apply |
| Offset lab | MP3 encoder delay read from the file header, the first attack through each decoder side by side, and a blind listening test that reports the preferred click shift with an interval | med | med | both decoders, P4 transport | no | no | P2 | **done** — header numbers, decoder side-by-side, and an 18-trial blind 2AFC with Wilson intervals in Timing |
| Rhythm guide | a separate guide difficulty with circles on strong attacks snapped to the detected grid (per band; optional taiko don/kat hint), ambiguous snaps left out and listed | med | high | attacks, sections, `.osz` writer | no | no | P2 | needs a decision: `04-ui-ux.md` §9 rules out beatmap editing beyond hitsounds and timing |
| Compile | many maps and their songs into one map and one audio file: ordered segments, every object keeping the beat it had, hitsounds remapped, slider velocity restored per segment, the junctions proven against the source audio afterwards | **high** | high | P5 reader/writer, P6 bank, P4 transport, structure, library | no | no | **P1** | **done** 2026-10-03 — [Phase 25](#phase-25--compilation-builder-marathon-maps) rows 25.1-25.11, 25.13-25.17 |

Target sidebar, grouped by job: **Library** · **Timing** (Evidence and Ramps as tabs) ·
**Structure** · **Map check** (Snap audit and Reference inside) · **Mapset** ·
**Hitsounds** · **Audio** (Offset lab inside) · **Compile** · **Export** · **Report** ·
**History** · **Settings**.

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
| Live confidence threshold | a slider that shows which candidate points would appear | low | med | engine | no | no | P2 | **done** — beside the minimum confidence in the Detection drawer: the grid analysis's sections read again, the lines it would add dashed on the map and the ones it would drop faded; applied as one undoable edit. Corpus B: candidates below 75 % on 13 of 15 grid tracks; Corpus A: none |
| Live threshold on a fallback result | the same trial for the beat tracker's result, read again from its stored beats; a rebuild at its own pulse reproduces it since 2026-09-26 (32 of 32 fallback analyses, 11 did not) | low | low-med | fallback rebuild | no | no | P3 | **done** — the slider reads a fallback result's beats again; 7 of 7 fallback results identical at their own 75 %, and the threshold moves red lines on all 7 |
| Analysis mode | fast (Rust) or precise (every Phase 10 voter) | low | med | P10, P22 | no | no | P2 | todo |
| Backup policy | one pristine `.bak` (today) or timestamped backups | low | med | writer | no | no | P2 | **not needed** — every state is already kept (`.bak` pristine, then `.bak2`, `.bak3`…); the Settings section says so |
| Cache | size limit, location, clear button | low | low | cache | no | no | P2 | **done** but a settable limit — entries, size, folder, clear |
| Click track | sound, accent on downbeats, level, subdivision clicks | low | med | click | no | no | P2 | **done** — 1-4 clicks per beat, bar accent on/off, levels in the transport; one sound |
| Theme and scale | light theme, UI scale 90–150 %, reduced motion | low | med | tokens | no | no | P2 | **done** — UI scale 80-150 %, reduced motion, light theme; since 2026-09-27 the theme also switches from the rail in one press, showing the theme it would move to, with Settings' three-way following it |
| Shortcuts | rebind any action | low | low | keyboard map | no | no | P3 | todo |
| Per-song presets | remember detection settings per song | low | med | project format | no | no | P2 | **done** — the settings a song's last finished analysis ran with (not the engine), kept in the config by the audio's SHA-256 for 200 songs; choosing the song puts them back with a note and the previous ones a click away. Not in the project file: a project exists only after an edit |
| The song's pulse, kept | a ×2 or ÷2 applied after an analysis kept with the song's settings, so analysing it again lands on the octave the mapper chose | low | med | per-song presets | no | no | P2 | **done** — a ×2/÷2 becomes the song's pulse setting, undo and redo move it back, the drawer follows; analysing again reproduces the ×2/÷2 on 16 of 18 (the fallback tracker's 2 wait on its rebuild fix) |
| Language | English and Spanish; more through translation files | low | med | i18n | no | no | P2 | partial |
| Settings file | export/import settings to another PC | low | low | settings | no | no | P3 | todo |

---

## Phase 21 — Map tools

Everything here writes to a `.osu` only as a proposal with a preview and a
consent step, through the same backup-and-keep-what-plays writer as inject.

| Tool | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Inject diff | each old red line beside its new value, and the drift it causes | low | **high** | inject | no | no | **P1** | **done** — `inject_diff` pairs by order with exact end-of-span drift; both inject previews carry it, the single confirm lists changed lines, inject-all rows show worst drift |
| Inject into every difficulty | one confirmation for the whole mapset | low | **high** | inject | no | no | **P1** | **done** — `inject_mapset` runs every .osu through the same inject (one bad map never stops the rest); Export row with per-file preview and one confirmation, each file backed up |
| Kiai from structure | kiai on chorus sections, written as greens | med | high | P2 structure, writer | no | no | P1 | **done** — engine half carries the audible state so sound never changes, second run a no-op; Structure card with preview counts and confirmed write with backup. Since 2026-09-26 every point inside a chorus is lit and touching choruses stay lit (it lit 4 % of the first chorus on a real map before) |
| Preview point | suggest `PreviewTime` at the chorus | low | med | structure | no | no | P2 | **done** — loudest chorus start, loudest part without one, in the Structure view with its reason |
| Bookmarks | section starts as editor bookmarks | low | med | structure | no | no | P2 | **done** — merged with the map's own, preview then confirmed write with backup, in the Structure view |
| Breaks | quiet spans long enough for a break | low | med | energy | no | no | P2 | **done** — sections 6 dB under the loudest cut by the map's own sound gaps (5 s or longer), Structure card with span preview and confirmed write with backup |
| Volume by section | hitsound volume from section energy, as greens | low | med | energy, writer | no | no | P2 | **done** — sections where the map sets its own volumes kept; a section at one volume set all the way through (its start, greens, a green at each red line inside, the next section's own volume given back); the scale from the loudest section's longest-held volume, 5 % floor. On 800 local maps: 20 % of sections set, 77 % left to the mapper, none of those changed |
| SV normaliser | greens that cancel BPM changes so scroll and slider speed stay constant | med | **high** | writer | no | no | P1 | **done** where it cannot move a slider — first red's BPM is the reference; every green under a BPM change scaled by reference over its BPM, a green at each red line, spans already constant kept, a second run refused through History's scroll profile; a map with a slider in a span it would scale refused, by decision (a slider lasts by its SV, and resizing it would change its shape: see Rejected ideas). Of local maps with a BPM change: mania 100 of 117 written, taiko 103 of 132, standard 22 of 249 |
| Re-snap objects | move hit objects onto the new grid after a timing change | high | **high** | writer, P5 | no | no | P1 | **done** — snapped-before stays snapped via the diff's drift, off-grid listed never touched; Map check card with preview, one confirmation and backup |
| Snap-divisor map | where the song needs 1/3, 1/4 or 1/6, per section | med | high | attacks | no | no | P1 | **done** — coarsest grid per attack within 15 ms, verdict by attack weight; read-only Timing card, one line per section |
| Swing lane | where the music swings or sits off the grid | med | med | attacks | no | no | P2 | **done** (2026-09-27) — `swing_lane` reads each 8 beats from their own beat: straight, swing or triplets, with the eighth's place, the pair's ratio and the editor snap. A lane on the tempo map (only while something swings, so a straight song's chart is unchanged) and a Swing card naming each stretch. On 34 local maps at the map's own pulse it agreed with the mapper's own late snapping on 134 of 185 swung windows (72 %), 6 % of straight windows holding late objects; the two synthetic fixtures read their known swing to 0.005 of the beat |
| New mapset from audio | encode MP3/OGG at a target bitrate, trim lead silence and re-offset | med | high | `.osz` | no | no | P2 | partial — `.osz` without encoding |
| Metadata from tags | artist/title/source from the audio's tags, romanised and Unicode kept apart | low | med | `.osz` | no | no | P2 | **done** — a map beside the audio first (its [Metadata] as written), else the tags (Unicode as written, romanised only when ASCII); on 249 local audio files half carry a title tag, and those match the mapper's title 78 of 125 times |
| Audio file check | bitrate, sample rate, length, clipping and lead-in against ranking rules | low | med | decode | no | no | P2 | **done** — header facts plus raw-decode measurements, findings on the tool's own bars (no ranking number encoded, none verifiable offline); Mapset card beside Audio swap |
| Video offset | match the video's own audio track to the song | med | low | decode | no | no | P3 | todo |
| Other games | export timing to Quaver (`.qua`) and StepMania (`.sm`/`.ssc`) | low | med | writer | no | no | P2 | **done** (2026-09-27) — both as text to copy, from Export. `verify_export` reads each back and compares its grid with Overtone's, which is the only check possible offline and is what the page reports; no game has opened one, and nothing claims otherwise. All 33 pinned readings round-trip: worst beat error 0.478 ms for Quaver (its whole-millisecond offsets) and 0.0005 ms for StepMania |
| Import other formats | read Quaver / StepMania timing to compare against | low | low | reader | no | no | P3 | **done** (2026-09-27) — `read_timing_file` reads a `.qua`, `.sm` or `.ssc` into the same shape an `.osu` grades in, so Map check takes one where it took a beatmap and names the game it came from. A real `.qua`'s SliderVelocities are not read as timing and a `.ssc`'s per-chart tags are not read as the song's; a rate that cannot be played is refused for StepMania, whose times accumulate, and skipped for Quaver, whose do not |
| Library health check | scan a Songs folder and list maps whose timing disagrees with their audio | med | med | batch, compare, library index | no | no | P2 | partial — engine half (2026-09-26): every map graded by the reference grading where it plays, kept in the index, resumable, reruns grade only what changed; 5.1 s per audio file with the Rust sidecar, about 7 h for 5,236 local audio files (estimate). Its flags do not yet separate maps that move from steady ones (23 of 60 caught, 26 of 44 steady flagged). Decided 2026-09-30: the page lists flags with evidence, marking solid fits actionable (12 or more attacks, share 0.60 or more) and the rest weak leads -- presentation only, no engine change; 41 flags read 32 actionable and 9 weak on 20 real files. A hand-checked precision sample is still open |
| Sample kit analysis | classify a skin's samples and suggest a mapping | med | low | P6 | no | no | P3 | partial — the measuring half (2026-09-27): `bench/genre_samples.py` reads the sample files the genre corpus mapsets ship and reduces each to decay, attack, centroid, rolloff, noisiness and seven band ratios, and `bench/fit_kits.py` fits Overtone's own synthesiser to those medians, per genre and role, into `assets/kits.json`. Applying a kit to a map — copying it in under a custom index and writing the objects' sample set — is the half still to come |

---

## Phase 22 — Engine robustness and speed

| Item | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Rust engine in the app | `overtone-cli analyze --json` sidecar, opt-in, v3 as fallback; `.opus` goes to v3 or is refused (v4 has no decoder, by decision) | med | **high** | P1 | no | no | **P1** | **done** — opt-in; v3 takes over with a note where Rust has no answer |
| Fallback re-timing | re-time the fallback tracker's beats at sample resolution (they land 5–35 ms late) | med | **high** | — | no | no | P1 | **done** (2026-09-26) — measured first: the tracker's beats sit on the onset envelope's peaks, a median 7.4-8.9 ms after the hits on Corpus A forced (13-17 ms under noise) and 21-24 ms after the sound on the four Corpus B songs that fall back. Each song's lag is read on the waveform (the median of its beats re-timed as the precision engine re-times attacks) and taken off every beat and red line: Corpus A -0.2..+0.2 ms, those four songs 4-10 ms after the sound, as the precision engine's grids; the tempo reading is untouched. Each beat on its own re-timed attack was tried and dropped: it scattered the real songs' beats |
| Real-MP3 offset bias | measure the ~20–26 ms attack-vs-map bias on real MP3s before trusting absolute offsets | med | **high** | Corpus B | no | no | P1 | **explained** (2026-09-26, 10.0a) — measured 2026-09-24 by reference timing: 30 random ranked maps all read the attacks after their lines, median +26.2 ms (IQR +23.0..+30.9), OGG (+27.2, n=3) as MP3 (+26.1, n=27); on Corpus B v3's red lines sit a median +24.0 ms after the maps'. Read from the audio itself, the sound starts a median 21.4 ms after ranked maps' lines (100 held-out maps, every decoder) and 7.9 ms before Overtone's (Corpus B): a convention of the maps plus a few ms of the engine, not the MP3 decoder. Not corrected: the correction waits on a decision (10.0a) |
| Envelope memory bound | mel in chunks: ~2.65 → ~0.74 GB peak on long tracks; no silent MemoryError fallback | med | high | — | no | no | P1 | **done** — spectrogram and tempogram in blocks since audit #38 (3.7 → 0.55 GB peak on a 5-minute song, the same red lines); a failed envelope now reaches the caller instead of being swapped for the flux one (2026-09-26) |
| Pre-warm the engine | load librosa and numba in the background at startup (~2.3 s off the first analysis) | low | med | shell | no | no | P2 | **done** — the window runs both engines once on 20 s of clicks in the background (not when opened with a song to analyse): a first grid analysis 2.65 → 1.09 s, a first fallback one 5.74 → 2.66 s (medians of 3 fresh processes) |
| Linear section growth | refine the growth grid on a trailing window | med | med | — | no | no | P2 | **done** (2026-09-27) — the grid carried through growth is refit on the last 128 beats, not on the whole span, which the final fit does anyway. Every synthetic reading identical (golden 27/27 stage for stage); the sections stage 2.72 s -> 0.19 s on long-6min and **unchanged on real music**, where that stage is seeding and boundary settling. Kept for the quadratic, not for a corpus speed-up. Corpus B: 18 of 19 identical, camisa-negra 3 lines -> 1, losing a section at 4x the map's tempo |
| Faster phase re-centring | a recurrence instead of one `exp` per shift | low | low | — | no | no | P3 | todo |
| Specific load errors | missing, empty and junk files each get their own message | low | med | decode | no | no | P2 | **done** — missing, empty and junk files named |
| Config type checks | a wrong-typed or BOM config never crashes or silently resets | low | med | config | no | no | P2 | partial — web shell only |
| CLI Unicode output | no crash on Japanese names when output is redirected | low | med | CLI | no | no | P2 | **done** — redirected, the CLI writes UTF-8; a console is left as it is |
| CSV save errors | a locked CSV (open in Excel) shows an error | low | low | GUI | no | no | P3 | todo |
| Injection backups | back up the current state on every injection, and report it truthfully | low | med | writer | no | no | P2 | **done** since audit #36 — every write keeps what it replaces (`.bak` first and for good, then `.bak2`, `.bak3`…, never overwritten, skipped only when the newest already holds those bytes) and returns the backup's real path; tested (`test_backup_keeps_the_pristine_original` and the tests after it) |

---

## Phase 23 — Quality gates

| Gate | What it catches | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Golden fails on a missing stage | a skipped stage counts as a failure, not a pass | low | high | golden | no | no | P1 | **done** |
| Real-audio smoke set | a handful of local songs that must keep analysing, never refused | low | **high** | — | no | no | P1 | **done** — `bench/gates.py real-audio`: six Corpus B tracks, one or two per engine path, pinned in `bench/real_audio_snapshot.json`; tracks not held here are skipped and named (2026-09-26) |
| Robustness gate | the audit's probes (short audio, odd rates, junk `.osu`, read-only files) as one command | low | high | — | no | no | P1 | **done** — `gates.py robustness`; the CLI tests run the same probes on v4 |
| One fixture manifest | Python and Rust read the same list; no Rust gate passes on missing audio | med | med | bench | no | no | P2 | **done** (2026-09-27) — `bench/fixtures.json`, derived by `bench/fixtures.py` from the Python definitions and the committed vectors, read by the Rust bench for its cases and its render hints; `facts.py` and a test hold the file to the code. It closed a real gap: the three coverage fixtures had no golden vector, so the Rust gates could not see them and the density gate carried a copy of their names — a fourth reached no gate at all. Missing audio already failed all five Rust gates, checked with an empty bench/audio/ |
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
| **SQL** (SQLite + FTS5) | library index of the Songs folder: search, same-audio lookup, library health, ground for fingerprint reuse | low | **high** | Python's `sqlite3` (installed) | no | no | **P1** | **done** — `overtone_library.py` + `library.sql` (schema 2): search p50 10 ms (one letter 15 ms), same-audio 6-12 ms once hashed, the library health table |
| **TypeScript** | the web shell type-checked against the bridge (`@ts-check` + JSDoc, `tsc --noEmit`), payload types generated from Python | med | high | Node.js (dev only, not installed) | no | no | P1 | todo — after Node |
| **C#** | osu!lazer compatibility gate: lazer's own `osu.Game` decoder reads every `.osu` Overtone writes | med | high | .NET SDK (dev only; 10.0.401 installed per user on 2026-09-26, for the MSI) | no | no | P2 | todo |
| **WGSL** (WebGPU) | spectrogram layer computed on the GPU | med | low-med | WebView2 WebGPU | no | **yes** | P3 | todo |
| **Lua** | user rules for the mod report, sandboxed | med | low-med | `lupa` or `mlua` | no | no | P3 | todo |
| WiX (XML) | the MSI (Phase 10.13) | med | med | WiX toolset | no | no | — | **built** — `installer\Overtone.wxs`, WiX 5.0.2 (MS-RL; 6 and 7 ask for the OSMF EULA, not accepted) |

Rejected: C++, Go, Java, Kotlin, Cython, Julia, R — the reasons are in the document.

---

## Phase 25 — Compilation builder (marathon maps)

One map out of many: pick difficulties from several songs, put them in an order, and get a
single `.osu` and a single audio file in which every borrowed object falls on the same beat
of the same sound it fell on in its own map. Asked for on 2026-10-03, with
[`frankhjwx/osu-map-combiner`](https://github.com/frankhjwx/osu-map-combiner) named as the
reference: one script, FFmpeg required, a config file of about thirteen fields (`osuPath`,
artist and title with their Unicode twins, difficulty name, mapper, AR/CS/OD/HP, `dstPath`,
`generateAudio`). Its source was read on 2026-10-03, not run here. What it leaves out is
most of the specification:

| The reference | What breaks | This phase |
|---|---|---|
| Timing points found with `"Timing" in line` | Matches a path or a comment that happens to contain the word, and misses nothing else because every line in the section is one | The committed reader (`read_osu_beatmap`): every section kept in file order, reds parsed, greens raw, unknown keys surviving a round trip |
| Hardcoded format `v14` | Refuses or mangles v5–v13 and lazer's own files | Every version the reader takes, the version written chosen and reported |
| The sixth field treated as a slider end time | In the format the sixth field is a slider's curve, a spinner's end time and a mania hold's `end:sample`; one rule cannot serve the three | One rule per object kind, and `unparsed` objects carried through untouched with a count |
| Breaks, combo colours, events, editor settings dropped | Hit the compilation as HP drain with no break, a black background and lost bookmarks | Breaks rebuilt at the junctions, bookmarks and preview point merged, backgrounds per segment through an `.osb`, every dropped event counted and named |
| `SliderMultiplier` adjusted only for negative BPM | Every slider of every segment but one scrolls and ticks at the wrong speed | Per-segment velocity compensation on green lines, with a refusal when a slider cannot be represented |
| Filenames encoded GB18030 | Mangles any non-Chinese Unicode title | Unicode metadata kept as it is, filenames made ASCII-safe through the existing `_safe_component` |
| FFmpeg required | A second install, and a network to get it | libsndfile, already pinned: it writes MPEG Layer III and Ogg Vorbis offline (verified 2026-10-03, libsndfile 1.2.2 through soundfile) — the same reason FFmpeg left the engine (**F-06**) |
| Zero crossfade, a blind 5 s cut, 3 s fades | A click at every junction, and a cut that can land inside a hit | Cuts at a sample the builder names, fades and crossfades per junction, and the junction proven against the source audio afterwards |
| No validation | A missing audio file, an empty folder or a broken object ends in a traceback | A repair pass that reports, and a dry run that shows the whole plan before anything is written |

Nothing here is new engine work. The pieces exist: the reader and the byte-identical writer
with its atomic write, backup and write log (Phase 5), the sample bank and sample-index
machinery (Phase 6), `shift_samples`/`audio_shift` for proving a cut landed where it says,
`mp3_gapless_info` for an MP3's own encoder delay, the structure view for picking a chorus,
the library index for finding the maps, snap audit and reference timing for checking the
result, and `export_osz` for the output. The phase is assembly, bookkeeping and refusals.

### The decision this needed

[`04-ui-ux.md`](04-ui-ux.md) §9 ruled out "beatmap *editing* beyond hitsounds and timing".
A compilation copies objects, so the rule had to be settled before the phase could be
written. Decided by the owner on 2026-10-03, and the rule now draws the line where the
reason for it was: **Overtone never draws, moves or reshapes an object on its own.** It may
copy whole maps' objects unchanged and move them in time together with their audio, which
is bookkeeping, not mapping. Inventing objects from the audio stays out, so the Rhythm
guide's decision is untouched.

Credit is part of the feature, not a footnote: every source mapper, difficulty and song is
named in the output — in `Tags`, in a `credits.txt` beside the `.osu`, and in the build
report — and the builder says in the UI that posting someone's map inside a compilation is
the mapper's call, not the tool's.

### The compilation document

The plan is data before it is a file: an ordered list of segments plus the settings that
apply to all of them, saved as JSON beside the cache so a build is reproducible, a long
build can be resumed, and a report can be re-read without the sources.

```
{ "segments": [ { "osu": <path>, "audio": <path>, "range": {...}, "trim": {...},
                  "gain_db": 0.0, "transition": {...}, "repairs": [...] } ],
  "settings": { "audio": {...}, "difficulty": {...}, "hitsounds": {...},
                "events": {...}, "metadata": {...}, "output": {...} },
  "report": { "refusals": [...], "warnings": [...], "measured": {...} } }
```

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| 25.1 Compilation document | the plan as JSON: ordered segments, per-segment settings, global settings, repairs and refusals; reproducible, resumable, diffable | low | **high** | P5 reader | no | no | **P1** | **done** 2026-10-03 — `plan_compilation`: the order given is the order built, each segment placed by a **whole-millisecond** shift with the junction absorbing the remainder, so a source's own snapping is never re-rounded. Refuses two modes, two mania key counts, a segment with no song, the length and object ceilings, and under `strict` any repair at all |
| 25.2 Segment read and repair | each source through `read_osu_beatmap`, then the repair pass below: every fix logged with the line it touched, nothing guessed silently | med | **high** | 25.1 | no | no | **P1** | **done** 2026-10-03 — `read_segment` in `python/overtone_combine.py`: 20 repair codes, each saying whether anything was actually done, and five refusals. A file that will not read comes back refused, not raised, so a plan can show all five songs including the broken one |
| 25.3 Time shift, every field | one rule per timestamp the format has (list below), applied as whole milliseconds so a stable client reads what lazer reads | med | **high** | 25.2 | no | no | **P1** | **done** 2026-10-03 — `combine_beatmap`: object starts, spinner and hold ends, every timing offset, breaks, bookmarks and the preview point, each by its own rule; a slider's curve untouched. Each segment is pinned at its start with the grid and sound its own map had there, the governing red line placed by **whole beats** so the phase is the mapper's (measured: worst 2.84e-04 ms off its own beat, which is the three decimals the file writes). The report's `pending` list names what rows 25.8, 25.9, 25.10 and 25.13 still owe |
| 25.4 Audio cut and join | decode each range, cut at a named sample, join, write one file | med | **high** | 25.1 | no | no | **P1** | **done** 2026-10-03 — `build_audio`: each segment written at `round(at_ms * rate / 1000)` frames, so the audio lands on the same rounding the objects did; a block at a time, so the peak working set is one block and not one compilation. **MP3 by default, and Ogg is not offered**: writing more than about ten seconds of 44.1 kHz stereo Vorbis kills the process in this libsndfile build (exit 127, nothing to catch), and Opus refuses 44.1 kHz. WAV is there for a lossless check. Output rate is the highest any segment brings, stereo if any is stereo, resampled per segment with `resample_poly` |
| 25.5 Decoder-delay accounting | the output encoder's round-trip delay measured rather than assumed, and the sources' own delay with it | med | **high** | 25.4 | no | no | **P1** | **done** 2026-10-03 — measured, and **there is nothing to compensate**: libsndfile 1.2.2 encodes MP3 through LAME 3.100, writes the gapless tag (delay 576, padding 972) and strips it again on read, so a click written at *t* comes back at *t* — 0.0 ms on four probes through a 45 s file, frame count identical, correlation peak 1.000. `verify_audio` keeps it honest per build by correlating each segment against its own song (`shift_samples`), and the gate runs it on every format. What osu!'s own decoder does with the same file is the Offset lab's question, not this row's |
| 25.6 Loudness match | per-segment gain so one song does not arrive twice as loud: integrated loudness per segment, one target, the applied dB shown per segment and capped against clipping with true-peak headroom | med | high | 25.4 | no | no | **P1** | todo |
| 25.7 Junction placement | where one segment ends and the next begins: a gap in milliseconds or in bars of the next map's own grid, the next segment starting on a downbeat, fade in/out lengths, and an optional crossfade — each junction its own settings | med | **high** | 25.4, P5 reds | no | no | **P1** | todo |
| 25.8 Hitsound merge | sample indices remapped so no two segments collide, custom sample files copied and renamed, identical files deduplicated by content hash, per-object `filename` overrides followed, and a segment's bank kept whole: what a segment sounded like is what it sounds like | med | **high** | P6 sample bank | no | no | **P1** | **done** 2026-10-03 — `sample_plan` gives every segment its own indices and `build_samples` copies the files under their new names, never touching a source folder. Index 0 is never remapped (on a point it means the skin's, on an object the point's: instructions, not files) and index 1 is, since the bare `soft-hitclap.wav` is a name two segments can both want. The timing lines, the pinned lines and every object that names an index or a file are rewritten — a slider's sample is its eleventh field, a mania hold's shares the sixth with its end time. A file an object names keeps its name where it can; two with one name and different bytes rename the second, two with the same bytes share one copy (SHA-1). An index whose file is missing stays missing, so osu! falls back to the skin exactly as the source did |
| 25.9 Slider velocity compensation | each segment keeps its own slider velocity under the one `SliderMultiplier` the map can hold, or the build refuses by name | med | **high** | 25.3 | no | no | **P1** | **done** 2026-10-03 — the ratio of a segment's own multiplier to the one written goes into **every** green line it brings and a new one after **every** red line it brings, because a red resets velocity to 1.0 and 1.0 under another multiplier is the wrong speed. A segment needing a velocity outside the 0.1x-10x a green line can carry refuses the build, naming the segment and the multipliers that would hold it. `SliderTickRate` has no such escape — nothing in a green touches it — so a segment whose tick rate differs is reported and ticks at the compilation's rate |
| 25.10 Difficulty reconciliation | AR, OD, HP, CS and stack leniency cannot vary inside one map: pick a segment's values, a hand-set value or the median, and show every segment's deviation from what was picked, in its own units | low | high | 25.1 | no | no | **P1** | **done** 2026-10-03 — `difficulty_plan`: the first segment's (the map the compilation opens with), the median, or a dict of values, any field it leaves out falling back to the first's and then to osu!'s own default. Every deviation is reported per segment in its field's own units, because this is the one promise a compilation cannot keep: AR 9 and AR 7 cannot both be true, and the honest thing is to say which maps are played at numbers their mapper did not choose |
| 25.11 Breaks, kiai, bookmarks, preview | a break written into every junction gap long enough for one, each segment's kiai spans kept, every source bookmark shifted plus one per segment so the result is navigable, and the preview point taken from a chosen segment | low | high | 25.3 | no | no | **P1** | **done** 2026-10-03 — the junction break opens after the previous segment's last **sound** (a spinner is still playing after it starts) and closes before the next one's first object, with 200 ms of air either side; breaks that meet are merged into one, and a break with no object on both sides of it is dropped with a count, since osu! draws a break between objects and not off the end of a map. Kiai travels in the timing lines and in the pinned line, so a range starting mid-kiai plays lit and the span cannot leak into the next song. A bookmark marks where each segment starts. `preview_from` takes ``"first"`` or a segment number; breaks and bookmarks can each be turned off |
| 25.12 Events and backgrounds | one background, or each segment's own through an `.osb` with timed fades; video and storyboard dropped with a count and a reason rather than silently | med | med | 25.3 | no | no | P2 | todo |
| 25.13 Metadata and credits | a title and artist from a template or by hand, Unicode kept, every source mapper and song in `Tags`, a `credits.txt`, and the per-segment credit in the report | low | high | 25.1 | no | no | **P1** | **done** 2026-10-03 — `metadata_plan`: the artist and title the songs agree on, else "Various Artists" and "Compilation (N songs)", with a Unicode twin only while the romanised field is still the songs' own. `Creator` is a **placeholder** the report flags, because osu! wants the uploader's name there and no source mapper made this. Tags carry every mapper and artist as deduplicated tokens, and `credits_text` writes the `credits.txt` that travels with the mapset: every song in playing order with its difficulty, mapper and source file, and the one thing the tool cannot decide — whether those mappers are willing |
| 25.14 The Compile section | its own sidebar section: pick maps, reorder them, a card per segment (source, range, gain, gap, repairs), the dry-run report, then Build with its own progress | high | **high** | 25.1-25.13, P3 shell | no | no | **P1** | **done** 2026-10-03 — the twelfth section, four cards: the songs in playing order (the app's first reorderable list), the joining settings, the names with the live `credits.txt`, and what it would build. Eleven bridge calls, every one of them returning the whole state: a change re-plans in Python, so the list and the numbers under it cannot drift apart. The build runs on **its own lock**, not the analysis's — the two refuse each other, because this machine runs one heavy job at a time — and pushes `onCompileProgress` / `onCompileDone` like the library health check. Checked in the browser harness in both languages: two mapsets added, reordered, a typed range, a wider gap, names by hand, built to MP3 with the three checks passing, no console error, no layout overflow. The timeline of the whole compilation is not drawn (the waveform is the analysed song's) |
| 25.15 Build report and proof | after a build: each junction's audio correlated against its source so the cut is proven, not assumed; snap audit over the result; each segment's red lines graded against the built audio by reference timing; and the whole thing read back through the writer to prove it is byte-stable | med | **high** | 25.4, snap audit, reference timing | no | no | **P1** | **three of four** 2026-10-03 — `verify_build` runs after every build unless turned off: each segment's audio correlated against its own song, the snap audit on the written map, and the text back through the reader and writer. The reference grade is the one left, since it needs attack detection over the built audio — the one heavy job in the phase |
| 25.16 Output | a folder in the Songs directory, an `.osz`, or a dry run that writes nothing; sources opened read-only and never written, even to fix them | low | **high** | `export_osz` | no | no | **P1** | **done** 2026-10-03 — `build_compilation` settles every plan and builds the beatmap text **before** it writes a byte, so a build that cannot be made refuses with nothing on disk; `dry_run` stops there and returns the file list. Then audio, samples, the `.osu` (through the engine's atomic writer and the write history, so History names it), `credits.txt` and the background. Refuses a folder that already holds a beatmap unless told to add to it, and refuses a source's own folder always. `osz=True` zips the folder flat, built in a temp file and renamed into place |
| 25.17 Gates | `bench/gates.py combine`: object times preserved relative to their segment to the millisecond, red-line BPM preserved exactly, sample indices unique and resolvable, audio length the sum of the ranges within tolerance, every junction's first attack where the `.osu` says within a pinned budget, 0 new unsnapped objects, and a byte-stable round trip — plus the malformed corpus through `fuzz_reader.py`'s mutants | med | **high** | 25.15 | no | no | **P1** | **half** 2026-10-03 — the rows that cover 25.1-25.3 are in and green in 2.0 s: three songs compiled (edm-174, odd-222.22 from the middle of its song so its grid must be pinned, secs-4 with four red lines), every object's offset inside its segment unchanged to 0.00e+00 ms, every beat length digit for digit, 0 of 116 objects off the grid or before it, the writer giving the text back, and 60 `fuzz_reader` mutants read or refused with nothing crashing. The audio and hitsound rows wait for 25.4 and 25.8 |
| 25.18 Pick by section | take a segment straight from the structure view: this song's chorus, from phrase edge to phrase edge on a proven downbeat, instead of a hand-typed range | med | high | P2 structure, 25.1 | no | no | P2 | todo |
| 25.19 Order suggestion | an order proposed with its reason: smallest tempo jump at each junction, or energy rising across the set, never applied on its own | med | med | 25.1 | no | no | P2 | todo |
| 25.20 Tempo-matched junction | stretch the tail of one segment into the head of the next so the beat never breaks | high | low | 25.7 | no | no | P3 | **unlikely** — the phase vocoder moved attacks a median 23-24 ms when Phase 4 measured it for the slow loop, which is exactly the error this phase exists to avoid. It ships only if a measurement on the corpus says otherwise |

### Every timestamp the shift has to touch

The list is the specification; missing one is the bug that makes a compilation unplayable
halfway through. Each is shifted by its segment's offset, rounded to whole milliseconds,
and checked afterwards to be in order:

- **Hit objects** — `time` for every kind; a spinner's end time (sixth field); a mania
  hold's end time (`end:sample`, sixth field); nothing inside a slider's curve, which is
  geometry, not time.
- **Timing points** — reds and greens alike, by their offset only; a red's beat length,
  meter, sample set, index, volume and effects are copied untouched.
- **`[Events]`** — break periods (`2,start,end`), background and video start times,
  storyboard command times if a storyboard is kept at all.
- **`[General]`** — `PreviewTime`, and `AudioLeadIn` recomputed for the result rather than
  copied from a segment.
- **`[Editor]`** — `Bookmarks`, every one of them.
- **Not shifted, and worth saying so** — combo colours, which osu! cannot change mid-map;
  `StackLeniency`, AR, OD, HP and CS, which are one value per map (25.10); and the
  `.osb`'s own sprite names.

### When the input is half-wrong

The reason the reference tool breaks is that it assumes the files are right. This is the
repair pass, and every one of these is reported with the segment, the line and what was
done — a build never repairs quietly, and a strict mode refuses instead of repairing:

- A format version the reader takes but the writer must choose for (v5 to lazer's own).
- A BOM, CRLF, LF or mixed line endings; the writer already round-trips all three.
- `AudioFilename` with the wrong case, a wrong extension or a path separator, and the
  audio sitting in the folder under a slightly different name.
- Audio missing, empty, zero-length, a tag-only file, or not audio at all — the loader's
  own messages, per segment, with the rest of the plan still shown.
- Objects before the first timing point, after the audio ends, or out of time order.
- No timing points at all, duplicate reds at one offset, a red with a non-finite or
  negative beat length, greens before the first red.
- Broken or truncated objects, which stay `unparsed` and are carried through or dropped by
  the chosen policy, with a count either way.
- Custom sample files missing, empty, or named outside the `set-hitsoundN` convention;
  per-object `filename` overrides pointing at a file that is not there.
- A `Mode` that differs between segments, and a mania key count that differs — refused,
  not repaired (below).
- Unicode titles, non-Latin filenames, and names too long for the filesystem.
- A segment whose own timing is wrong: the result's reference grade says so per segment,
  so a bad source map is named instead of quietly making the compilation feel off.
- Hit object times with decimals (lazer): kept or rounded by the chosen output version,
  and the rounding reported.

### What it will refuse

A refusal with a reason beats a file that loads and plays wrong:

- Segments in different game modes, or mania segments with different key counts.
- A segment whose audio cannot be decoded, when it is not dropped from the plan.
- A slider whose velocity cannot be represented at the chosen `SliderMultiplier` (25.9),
  naming the sliders and what multiplier would hold them.
- An output longer than a pinned ceiling, or more objects than a pinned ceiling.
- Writing into a folder that already holds a map, unless the user says to add to it.
- Overwriting a source file, ever.

### Build order

1. 25.1, 25.2, 25.3 and the gate rows of 25.17 that cover them: the plan, the read and the
   shift, measured on the committed fixtures, before any audio is touched.
2. 25.4, 25.5 and 25.16 dry run: one audio file out, the cut proven by correlation
   (25.15's junction check) before anything else is built on it.
3. 25.8, 25.9, 25.10, 25.11: the parts that decide whether a segment *plays* like its
   source. Hitsounds first — they are the reference tool's one real trick and the easiest
   to get subtly wrong.
4. 25.13, 25.16 whole output, 25.15 report.
5. 25.14, the section, once the pieces behind it refuse correctly; the browser harness
   over it in both themes and languages, as Phase 19 did.
6. 25.6, 25.7's crossfades, 25.12, then 25.18 and 25.19.

The one-heavy-job-at-a-time rule applies throughout: a five-song compilation is five
decodes, and they run one after the other with the progress panel naming which.

### Open questions

- ~~**The audio format to write.**~~ **Answered 2026-10-03, by measurement.** MP3, through
  libsndfile's LAME: a click written at *t* comes back at *t* (0.0 ms on four probes, frame
  count identical, correlation peak 1.000), and it is what mapsets ship. Ogg Vorbis is out
  for a reason nobody would have guessed: writing more than about ten seconds of 44.1 kHz
  stereo kills the process in this build — exit 127, no exception, nothing written — and
  Opus takes only 8, 12, 16, 24 and 48 kHz. WAV stays available for a lossless check, and
  is what the gate compares sample for sample.
- **Whether a segment may be a map's own section** rather than the whole map, which is
  25.18's premise but also a question about what a compilation is for.
- **Where the compilation document lives** — beside the cache, or in the output folder so
  it travels with the mapset.

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
| **Resizing sliders to hold scroll constant** | **Won't build** (decided 2026-09-26). A slider lasts by the SV it starts under, so constant scroll under one means a new length, and so a new shape on screen: that is the mapper's call, made in the editor. Constant scroll refuses such a map and says how many sliders and where (221 of 249 local standard maps with a BPM change) |
| **A pitch-kept slow loop** | **Rejected on measurement** (Phase 4): it exists to judge attacks, and the phase vocoder moved them a median 23-24 ms; the loop is resampled instead, pitch and all |
| **Cloud anything** | **Never.** Offline is a product property |

---

## Sequencing

```
P0 gates ✓ ─► P1 parity ✓ ─┬─► P2 analysis ✓(Rust) ─┬─► P6 hitsounds (in the app, editor half) ─► P7 validation (half)
                           ├─► P3 UI (web shell ✓, timeline half)
                           ├─► P4 playback ✓ / editor ✓
                           └─► P5 osu! ✓ ─────────────► P8 automation (half) ─► P9 (suggestions ✓)
                                                         P21 map tools (the P1 rows ✓)
                                                         P25 compilation builder (todo)

Next: harness passes ─► hitsounds, the rest ─► Library focus ─► Phase 10 ─► installer
```

P3, P4 and P5 are independent of each other. P6 was the largest body of work and waited on
playback and the timeline, because a hitsound editor you cannot hear is not usable; both
are in, and so is most of P6.
