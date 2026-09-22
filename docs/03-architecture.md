# Architecture

Target of the design: replace one 3258-line module with boundaries that are enforced by
the build, not by convention. The test is mechanical — **if the accuracy benchmark can
link the engine without pulling in a UI, filesystem layout or config crate, the boundary
is real.**

---

## 1. Workspace layout

```
osu-timing-analyzer/
├─ Cargo.toml                    # workspace root
├─ Cargo.lock                    # committed
├─ crates/
│  ├─ ota-core/                  # shared types. no deps beyond serde/thiserror
│  ├─ ota-audio/                 # decode · resample · peak pyramid · mmap
│  ├─ ota-dsp/                   # STFT · ODFs · spectral features · HPSS · filters
│  ├─ ota-tempo/                 # THE v3 MATH. coherence · IRLS · octave. zero I/O
│  ├─ ota-grid/                  # sections · boundaries · confidence · timing points
│  ├─ ota-osu/                   # .osu read/write · hitobjects · atomic write · backup
│  ├─ ota-hitsound/              # features → instruments → decision engine → export
│  ├─ ota-analysis/              # orchestration: job graph · progress · cancellation
│  ├─ ota-project/               # project format · analysis cache · settings
│  ├─ ota-playback/              # cpal output · click synth · transport
│  ├─ ota-cli/                   # bin: ota
│  └─ ota-bench/                 # criterion benches + accuracy harness + golden diff
├─ app/                          # Tauri v2 shell
│  ├─ src-tauri/                 # commands · binary channels · event bus
│  └─ src/                       # TypeScript frontend
├─ reference/
│  └─ python-v3/                 # the v3 implementation, kept runnable
└─ docs/
```

### Dependency rules, enforced

```
ota-core   ← everything (leaf; no reverse deps)

ota-audio  → ota-core
ota-dsp    → ota-core
ota-tempo  → ota-core, ota-dsp                     ← NO I/O, NO audio decode
ota-grid   → ota-core, ota-tempo
ota-osu    → ota-core                              ← NO dsp, NO audio
ota-hitsound → ota-core, ota-dsp, ota-grid, ota-osu
ota-playback → ota-core, ota-audio
ota-analysis → ota-audio, ota-dsp, ota-tempo, ota-grid, ota-osu, ota-hitsound
ota-project  → ota-core, ota-analysis
ota-cli      → ota-analysis, ota-project, ota-osu, ota-playback
ota-bench    → ota-analysis                        ← links the SHIPPED engine

app/src-tauri → ota-analysis, ota-project, ota-playback, ota-osu
```

Three rules, each with a reason:

1. **`ota-tempo` has no I/O and no audio decoding.** It takes `&[f64]` attack times and
   `&[f32]` weights and returns fitted grids. This is the code that produces 0.16 ms
   offsets; it must be fuzzable, property-testable and benchmarkable in isolation, and it
   must be impossible for a file-handling change to affect it.
2. **`ota-osu` knows nothing about audio.** Beatmap parsing is a text/format problem. It
   gets its own fuzz target and round-trip property tests.
3. **`ota-bench` depends on `ota-analysis`, not on private internals.** A benchmark that
   reaches into internals stops measuring the shipped path. This is how v3's benchmark is
   written and it is right.

CI-less enforcement (no GitHub Actions in this project): a `cargo xtask check-deps`
task parses the workspace metadata and fails on a forbidden edge, run from the same
`just`/`cargo xtask` entry point as the tests.

---

## 2. Engine module responsibilities

### `ota-core`
`TimingPoint`, `GridSection`, `Attack`, `Section`, `Analysis`, `Confidence`,
`AnalysisDiagnostic`, `Progress`, error types. Serde derives. Newtypes for units —
`Seconds(f64)`, `Millis(f64)`, `Bpm(f64)`, `BeatIndex(i64)` — because the v3 code mixes
seconds and milliseconds across function boundaries and the compiler can carry that for us.

### `ota-audio`
- Decode via **Symphonia** (MP3/AAC/ALAC/FLAC/Vorbis/WAV/MP4) with a `symphonia-play`-style
  format probe; no FFmpeg, no external process.
- Header-first duration check before decoding (v3's `sf.info` guard — keep it).
- Downmix to mono f32, resample to 44 100 Hz via **rubato**, peak-normalise to 0.99.
- **Peak pyramid**: min/max pairs at LODs 256/1024/4096/16384 samples, computed once,
  cached. This is what the timeline renders; the raw samples are never sent to the UI.
- `memmap2` for large files; streaming decode for the progress bar.

### `ota-dsp`
Pure functions over slices. No state, no globals.
- STFT (realfft), windowed, configurable hop; `rayon` over frames.
- Onset detection functions: **v3-compatible mel flux** (the porting contract in
  [`05-dsp-pipeline.md`](05-dsp-pipeline.md)), plus SuperFlux and complex-domain ODF
  behind the same trait.
- Multi-band flux (7 bands) — needed by the hitsound engine, useful for attack weights.
- Spectral features: centroid, rolloff, bandwidth, flatness, crest, flux, skew.
- HPSS (median-filter, Fitzgerald) with a 3-way harmonic/percussive/residual variant.
- Chroma, for chord-change detection.
- Peak picking with parabolic interpolation (v3-compatible `find_peaks` semantics).

### `ota-tempo` — the precious one
A direct, line-traceable port of v3's math. Each function keeps its v3 name in a doc
comment so the two can be diffed by a human:

| Rust | v3 |
|---|---|
| `coherence::sweep` | `_coherence_curve` |
| `coherence::candidates` | `_atomic_grid_candidates` |
| `fit::irls_pass` | `_ls_fit` |
| `fit::recentre_phase` | `_recentre_phase` |
| `fit::refine` | `_refine_grid` |
| `fit::expand` | `_expand_fit` |
| `fit::quality` | `_grid_quality` |
| `octave::beat_from_atoms` | `_beat_from_atoms` |
| `octave::tempo_hints` | `_tempo_hints` |
| `meter::from_grid` | `_meter_from_grid` |

Plus the v4 additions (elastic grid, per-section octave, 2-D coherence map), each behind
a feature flag until it beats the baseline on the corpus.

### `ota-grid`
Section growth, merging, boundary settling at the grid crossing, per-section refit,
confidence, and the conversion to osu! red lines including the downbeat/meter anchoring
rules. Separated from `ota-tempo` because this layer is *policy* (what counts as a
section) over *math* (how a grid is fitted), and policy is what users tune.

### `ota-osu`
- Full reader: `[General]`, `[Metadata]`, `[Difficulty]`, `[Events]`, `[TimingPoints]`,
  `[Colours]`, `[HitObjects]`, with unknown keys and sections **preserved verbatim**.
- Hitobjects: circles, sliders (all curve types, repeats, per-node sample sets), spinners,
  holds; hitsound bitfield; sample set / addition set / custom index / volume / filename.
- Uninherited vs inherited discrimination using v3's rule: **negative beat length always
  means inherited, overriding a contradictory flag**, and two-field legacy lines are red.
- Writer designed around one invariant: **a field the user did not ask to change comes
  out byte-identical**, including CRLF style and a UTF-8 BOM if present. Implemented as
  span-preserving edits over the original bytes, not as re-serialisation of a parsed model.
  This is stricter than v3 (which only preserved the lines it did not touch) and it is
  what makes hitsound injection safe.
- Atomic write + `.bak` that is never overwritten. Ported verbatim in behaviour.

### `ota-hitsound`
See [`06-hitsound-engine.md`](06-hitsound-engine.md). Structurally:
`features` → `instruments` → `context` → `decide` (DP) → `explain` → `export`.

### `ota-analysis`
The orchestrator, and the only crate that knows the *order* of things.

```rust
pub struct Job { stages: Vec<Stage>, cancel: CancellationToken }

pub enum Stage {
    Decode, Peaks, Onsets, Attacks, Coherence,
    Octave, Sections, Boundaries, Meter, Spectral, Structure,
}
```
- Every stage reports `Progress { stage: Stage, done: u32, total: u32 }` — **structured,
  not a localised string** (audit F-10).
- Every stage is cancellable at a coarse checkpoint.
- Failures are carried, not swallowed: the result holds
  `Vec<AnalysisDiagnostic>` so a consumer can tell "this audio has no grid" from "the
  precision engine panicked" (audit F-08). The CLI prints them; the UI shows a badge.
- Results are immutable `Arc<Analysis>` snapshots so the UI keeps rendering the old one
  while a new analysis runs.

### `ota-project`
Project file = a directory with a `project.toml` plus a binary `cache/` of derived data
(peak pyramid, onset envelope, attack list, spectral features) keyed by
`blake3(audio bytes) + engine_version + params_hash`. Reopening a project recomputes
nothing; changing a parameter recomputes only the stages downstream of it, which is what
"incremental analysis" means concretely:

```
params.onset_*   changed → Onsets, Attacks, Coherence, Octave, Sections, …
params.min_delta changed → Sections onwards only    (attacks are untouched)
params.octave    changed → nothing recomputed; grids are re-read at a new beat rate
```

That last line is v3's exact `rebuild_with_subdivision` insight, promoted to a general rule.

### `ota-playback`
`cpal` output stream; lock-free ring buffer fed by a decode/mix thread; the audio callback
allocates nothing and locks nothing. Mixes the source with a synthesised click aligned to
the current timing points. Publishes `Playhead { position: Seconds, at: Instant }`; the UI
extrapolates between updates rather than receiving a message per frame.

---

## 3. Threading model

```
┌────────────────────────────────────────────────────────────────┐
│ WebView UI thread            never blocks, never computes      │
└───────────┬──────────────────────────────▲─────────────────────┘
            │ commands (typed, small)      │ events (progress, playhead)
            │ binary reads (ota:// URIs)   │
┌───────────▼──────────────────────────────┴─────────────────────┐
│ Tauri main / command handlers            dispatch only         │
└───────────┬────────────────────────────────────────────────────┘
            │ submit(Job)
┌───────────▼────────────────────────────────────────────────────┐
│ Analysis executor  (1 worker per job, bounded queue)           │
│    └── rayon pool for data-parallel stages                     │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ Audio thread (cpal callback)   real-time, no alloc, no locks   │
└────────────────────────────────────────────────────────────────┘
```

Rules:
- The rayon pool is sized `cores - 1` so a batch run cannot starve the audio thread.
- One analysis job at a time per project; submitting again cancels the in-flight job
  (the user changed a parameter — the old answer is worthless).
- Batch mode parallelises **across files**, one file per rayon task, each using a small
  inner pool. This is where the cores actually pay off.

---

## 4. The UI boundary

Two channels, chosen by payload size. This is the main thing to get right in a Tauri app.

**Typed commands** — request/response, JSON, kilobytes at most:
`open_audio`, `analyze`, `cancel`, `get_analysis_summary`, `edit_timing_point`,
`split_section`, `merge_sections`, `load_osu`, `analyze_hitsounds`,
`explain_object`, `export_osu`, `validate_map`, `save_project`.

**Binary reads** — a custom URI scheme, zero-copy into a `TypedArray`:

```
ota://peaks/{analysis_id}/{lod}/{from_sample}-{to_sample}     → i8/i16 min-max pairs
ota://envelope/{analysis_id}/{from_frame}-{to_frame}          → f32
ota://spectrogram/{analysis_id}/{tile_x}/{tile_y}             → u8 tile
ota://attacks/{analysis_id}                                   → f64 times + f32 weights
```

A waveform is never JSON. The frontend asks for the LOD that matches its current zoom and
viewport width, so the bytes transferred are proportional to *pixels on screen*, not to
track length — a 6-minute track and a 60-second track cost the same to display.

**Events** — `analysis://progress`, `analysis://done`, `transport://playhead`,
`project://dirty`. Coalesced: progress at ≤ 20 Hz, playhead at ≤ 30 Hz with local
extrapolation.

---

## 5. Where v3's behaviour is pinned

The architecture is worthless if the port silently changes an answer. Three mechanisms,
all gating:

1. **Golden vectors.** `reference/python-v3` gains a `--dump-json` flag emitting attacks,
   coherence peaks, per-stage fitted grids, sections and final points for every benchmark
   fixture. `ota-bench` asserts the Rust engine matches within documented tolerances
   (attacks ≤ 0.05 ms, period ≤ 1e-6 s, offsets ≤ 0.05 ms). A stage-by-stage diff means a
   divergence is localised instead of appearing as a mystery at the output.
2. **The v3 test suite, ported.** All 55, keeping their names, so a reader can map them.
   The coherence-phase-sign test ports first — it guards the single largest error source
   in v3's history.
3. **The accuracy corpus, ported**, plus the gaps the audit identified: octave agreement
   (F-07), a genuine two-section 2× fixture (F-11), `.osu` parser round-trips, and a
   performance gate. Total v3 corpus runtime is 21.6 s, so this runs on every commit.

**No DSP improvement lands before all three are green on the unimproved port.** That is
the difference between a rewrite and a regression.
