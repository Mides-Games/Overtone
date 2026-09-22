# Overtone

Local desktop app that extracts BPMs and offsets from audio with sub-millisecond accuracy,
built for creating osu! red timing points. Everything runs offline — no uploads, no
accounts.

![stack](https://img.shields.io/badge/python-3.10%2B-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![accuracy](https://img.shields.io/badge/median%20error-0.0000%20BPM%20%C2%B7%200.16%20ms-6ee7b7)

```
median BPM error      0.0000 BPM      ← reproduced 2026-09-21, see Benchmarks
median offset error   0.16 ms
sections within 0.05 BPM and 5 ms     24 / 24
```

---

## Status

| | |
|---|---|
| **Shipping now** | **v3.0** — Python, Tk GUI + CLI. Accurate, tested, documented. This is what the code in this repository does today |
| **Designed, not yet built** | **v4** — a full rewrite in Rust with a modern desktop UI, a hitsound analyzer, map validation and batch processing. The complete design is in [`docs/`](docs/) |
| **Rust code in this repo** | None yet. Phase 0 of the [roadmap](docs/07-roadmap.md) is the toolchain and the accuracy gates |

Nothing in this README claims a number that has not been measured. v4's targets are marked
as targets, and the benchmark tables say which engine and which date produced them.

---

## What v3 does

v2 read tempo from the **gaps between detected beats**. Differencing amplifies the few
milliseconds of jitter every onset detector carries, so its BPM wandered by ~0.2 and its
offsets sat about 8 ms late.

v3 never differences anything. It fits an explicit model

```
t(k) = offset + k · beat_length          (k = integer beat index)
```

to the detected attack times by iteratively re-weighted least squares. Hundreds of inlier
attacks average the jitter down by √N — that is what turns "±0.2 BPM" into "±0.001 BPM".

| | v2 | v3 |
|---|---|---|
| median BPM error | 0.1965 BPM | **0.0000 BPM** |
| median offset error | 8.37 ms | **0.16 ms** |
| sections within 0.05 BPM **and** 5 ms | 0 / 24 | **24 / 24** |
| time for a 60 s track | ~5 s | **~0.7 s** |

Both columns come from the same harness, and the v2 engine is still in the box:

```bash
python bench/benchmark.py                    # v3, the right-hand column
python bench/benchmark.py --engine legacy    # v2, the left-hand column
```

The full engineering log, including the approaches that were tried and dropped, is in
[timeline.md](timeline.md).

---

## Install & run

```bash
python -m pip install -r requirements.lock   # exact versions behind the numbers below
python timing_analyzer.py
```

WAV/FLAC/OGG open directly via SoundFile. For MP3/M4A/AAC install FFmpeg and put it on
`PATH`. *(v4 removes this requirement — Symphonia decodes all of them in-process.)*

CLI analysis:

```bash
python timing_analyzer.py "song.wav" --stats --csv timing.csv --click click.wav
```

| Flag | Effect |
|---|---|
| `--delta 1.5` | minimum BPM gap before a new red line is added |
| `--persistence 12` | beats a new tempo must hold. Raise to 20+ for constant-tempo songs |
| `--min-confidence 75` | filters shaky sections |
| `--subdivision 2` | multiplies the detected beat rate; `0.5` halves it. Exact, not a re-guess |
| `--engine auto\|precision\|legacy` | `auto` fits the grid and falls back only when nothing fits; `precision` refuses to fall back |
| `--decimal-offsets 3` | sub-millisecond offsets (lazer accepts them; **stable does not**) |
| `--click click.wav` | metronome aligned to the red lines — **listen to it against the song** |
| `--stats` | global BPM, stability, meter, engine used, grid residual |
| `--osz out.osz` | writes a **complete beatmap archive** — the audio plus an `.osu` carrying this timing. Times a song from nothing, rather than injecting into a map that already exists. `--artist` / `--title` / `--creator` set the metadata |
| `--inject map.osu` | writes red lines straight into an existing beatmap (`--no-backup` skips the `.bak`) |
| `--no-refine` | skips sample-resolution attack re-timing (diagnostic aid) |

GUI presets: **⚡ Variable** = 1.5 / 12 / 75 (default — songs that change often),
**🛡 Steady** = 2.0 / 20 / 85 (constant-tempo songs).

---

## How the v3 engine works

1. **Load** mono 44.1 kHz with peak normalization. Files longer than an hour are refused
   from the header rather than decoded.
2. **Attacks** are peak-picked from a 2.9 ms onset envelope with parabolic sub-frame
   interpolation, then **re-timed on the raw waveform at sample resolution**: a
   spectral-flux peak lags the physical attack by roughly one analysis window, and an
   offset 8 ms late is audible in the editor. Measured: attacks land 0.15 ms from truth.
3. **Atomic pulse.** A weighted circular-coherence sweep, `R(f) = |Σ w·e^{2πi f t}| / Σ w`,
   scores every plausible pulse rate in one O(N) pass each. Candidates are ranked by
   *share* × *coverage* — how much attack energy a grid explains, times how many of its own
   slots are filled. A grid twice too slow fails the first, twice too fast fails the
   second; only the true atom scores on both.
4. **Lock.** Expanding-window least squares walks that grid over the whole track in
   doubling spans, so a 1 % seed error is absorbed without ever slipping a beat index. A
   robust re-centering pass snaps the phase onto the *densest* residual cluster rather
   than its mean, so swung off-beats and ghost notes cannot drag the offset (they used to
   cost 17 ms on a shuffle track).
5. **Octave.** Attacks are grouped by index modulo *m*; if *m* atoms really make a beat,
   one class holds the kicks and another the filler, so the accent depth is large. That
   plus tempogram hints decides how many atoms make a beat, and which one is the downbeat.
   Evidence — never blind multiplication.
6. **Sections** grow forward while attacks keep landing on the grid, and stop where they
   stop. Each new region **re-seeds its own coherence scan**, because a period carried
   across a 128 → 142 BPM change assigns wrong beat indices on the far side. Boundaries
   then settle on the beat where the two grids **cross** — a sharp minimum, where a
   residual cost is flat. Finally every section is refitted on its own attacks alone.
7. **Fallback.** If no grid fits at all — rubato, free time, no percussion — the v2 hybrid
   tracker runs instead, and the analysis says so (`engine: legacy` in `--stats`).

Extras: **global BPM** (duration-weighted across sections), **stability**, **meter**
(evidence-gated), and the **grid residual** in ms, which is the honest measure of how well
the song fits a fixed grid at all.

The full specification, precise enough to port from, is in
[`docs/05-dsp-pipeline.md`](docs/05-dsp-pipeline.md).

---

## The octave is still a judgement call

BPM and offset are essentially exact. What no detector can settle for you is which multiple
of the pulse *you* call the beat: a 92 BPM song with eighth-note hats is also a valid
184 BPM map, and 225 BPM streams read as 112.5 to any tempo estimator with a perceptual
prior.

- `Prefer map BPM (120–300)` is **on** by default and breaks that tie towards the range
  osu! is mapped in. Turn it off (`--no-map-preference`) for the musically-halved reading.
- If you disagree, hit **×2** or **÷2**. With a v3 analysis that is instant *and exact* —
  the fitted grids are read at a different beat rate, nothing is re-detected.
- The click track is the arbiter. A correct map clicks *with* the song.

---

## v3 app features

- Stat cards: global BPM, sections (+ meter), beats, stability.
- Results table (`# / offset / BPM / beat length / confidence`); click a row to highlight
  its section on the trace.
- **Edit timing points**: Apply, Add, Delete (§1 protected), nudge ±1/±5 ms, per-section
  **2× § / ÷2 §**. Hand-added points carry 100 % confidence.
- **Inject .osu…**: red lines written straight into `[TimingPoints]` — greens and
  everything else preserved byte-for-byte, CRLF-safe. The write is **atomic** (temp file +
  rename), a `.bak` is made, and an **existing `.bak` is never overwritten**. Legacy v3/v4
  maps whose timing lines have only two fields are recognised correctly.
- **Per-section pulse hints** for sections reading below 120 BPM with strong off-beat
  support.
- Tempo-trace canvas: onset bed + local-tempo curve (from short least-squares fits, not
  beat deltas) + section shading + red-line markers.
- **Export CSV**, **Copy .osu**, **Click track…**, **Details…**, **Tap tempo**.
- Background-thread analysis (UI never freezes); prefs persisted atomically and ignored
  entirely if corrupt.
- Shortcuts: `Ctrl+O` open, `Ctrl+C` copy points, `F5` analyze.

---

## v4 — the rewrite

Designed in full before any code. Each document stands alone.

| Document | Contents |
|---|---|
| [01 · Audit](docs/01-audit-v3.md) | What v3 does well and must keep; 11 findings with severities; the reproduced baseline |
| [02 · Stack evaluation](docs/02-stack-evaluation.md) | Five stacks compared on 14 weighted criteria; the decision and its costs |
| [03 · Architecture](docs/03-architecture.md) | 12-crate workspace, dependency rules, threading, the UI boundary |
| [04 · UI / UX](docs/04-ui-ux.md) | Design tokens, screens, the timeline, transport, shortcuts |
| [05 · DSP pipeline](docs/05-dsp-pipeline.md) | The exact porting contract, then eight gated improvements |
| [06 · Hitsound engine](docs/06-hitsound-engine.md) | Features → instruments → context → decision → explanation → export |
| [07 · Roadmap](docs/07-roadmap.md) | Phases 0–9 with difficulty, impact, dependencies, and what was rejected |
| [08 · Machine learning](docs/08-machine-learning.md) | Where ML earns its place, and the conditions for shipping a model |
| [09 · Naming](docs/09-naming.md) | The app outgrew "Overtone"; shortlist and recommendation |

### Stack

**Rust workspace of UI-free engine crates + Tauri v2 shell.** The short version of the
reasoning:

- **Symphonia** decodes MP3/AAC/ALAC/FLAC/Vorbis/WAV/MP4 in-process, which **deletes the
  FFmpeg requirement** — the single largest install-time friction in v3.
- **rustfft / realfft / rayon** cover the DSP with no GPL dependency and no P/Invoke.
- A **webview shell** is the only candidate that makes a DAW-grade interactive timeline
  affordable per hour of work spent.
- **No engine crate may depend on the UI**, so the CLI, the benchmark and the GUI link the
  same code — and if Tauri proves wrong, only the shell is replaced.

GPU is used for **rendering**, where it is justified, and **not** for analysis: a
6-minute track is ~124k frames of 1024-point real FFT, which is well under a second on
CPU with rayon. Adding compute shaders would buy a fraction of a negligible cost and add
driver variance.

### New in v4: Hitsound Analyzer

Load an audio file and an `.osu` difficulty; get hitsounds derived from what the music
actually does. Not a lookup table — per-attack spectral and temporal features feed 13
instrument templates, which combine with metrical role and map context in a **Viterbi pass
over the object sequence**, so the result is consistent rather than per-object noise.

Every decision explains itself:

```
Object #1842        slider head · §2 · bar 47 beat 2 · 1/1

  Decision      DRUM-HITCLAP                                        91%
  Alternative   NORMAL-HITCLAP                                       6%

  Audio evidence
    + transient strength           0.83   strong        +1.00
    + mid-band ratio               0.41   snare-like    +0.90
    + percussive ratio             0.78   percussive    +1.00
    − sub-band ratio               0.06   not a kick    −0.05
  Musical role
    + beat 2 of 4                         backbeat      +0.85
  Sequence
    + bar 46 beat 2 took drum-hitclap     phrase bond   +0.62
```

Design: [`docs/06-hitsound-engine.md`](docs/06-hitsound-engine.md).

### v4 targets

Targets, not measurements. They will be replaced with benchmark output as phases land.

| | v3 measured | v4 target |
|---|---|---|
| median BPM / offset error | 0.0000 BPM / 0.16 ms | **no worse** (hard gate) |
| 6-minute track | 5.0 s | < 0.5 s |
| 24-track corpus | 21.6 s | < 3 s |
| exact 2× tempo change | 1 of 2 sections found | 2 of 2 |
| tempo ramp | 8-section staircase | one elastic-grid section |
| MP3/M4A/AAC | needs FFmpeg | in-process |

---

## Benchmarks

```bash
python bench/benchmark.py            # full corpus
python bench/benchmark.py --list     # the 24 case names
python bench/benchmark.py --only edm-174
python bench/benchmark.py --regen    # re-render the audio
```

The harness renders its own audio into `bench/audio/` (git-ignored, ~250 MB) and reuses it.
24 synthesized tracks with exact ground truth — odd tempos including 222.222 and 128.37,
added noise, ±8 ms performance jitter, swing and shuffle, drops, sparse breakdown bars,
a 6-minute track, and 2–4 tempo changes per song — checking **every** section, plus four
degenerate inputs that must degrade honestly rather than invent an answer. Exit code is
non-zero if any section misses tolerance. It scores **precision**, not the octave, and the
module docstring explains why that distinction is deliberate.

**Last reproduced 2026-09-21** on Windows 11, Python 3.14.4, numpy 2.5.3, scipy 1.18.1,
librosa 1.0.0: `24/24 · median 0.0000 BPM · 0.16 ms · 21.6 s total`. Worst single case is
`shuffle-96` at 2.26 ms of offset error, which is the swing limitation below, working as
documented.

The benchmark is **entirely synthetic**. That is what makes sub-millisecond ground truth
possible, and synthesized drums are cleaner than recorded ones, so the numbers should be
read as an upper bound rather than a promise about real masters.

---

## Testing

```bash
python -m unittest test_timing_analyzer -v      # 56 tests
python bench/gates.py bpm-snapshot              # the octave, pinned per fixture
python bench/gates.py coverage                  # density changes inside a section
python bench/golden.py check                    # per-stage vectors, 24/24
```

Covering: least-squares grid fitting (including a regression test for the coherence phase
sign, which once put the seed grid in anti-phase), sample-resolution attack re-timing,
robust phase re-centering against ghost notes, boundary placement at the grid crossing,
exact and reversible octave forcing, two-section detection to 0.02 BPM and 4 ms, the legacy
engine and its fallback, `.osu` injection (CRLF-safe, idempotent, legacy two-field lines,
backup preservation), whole-millisecond offset export, corrupt-config tolerance, and the
v2 segmentation helpers that remain in the fallback path.

Three gates were added for things the accuracy benchmark structurally cannot see:

- **`bench/gates.py bpm-snapshot`** pins the **absolute** reported BPM per fixture. The
  benchmark normalizes octaves, so a change to the octave decision could halve every
  track while all 24 rows stayed green. The snapshot catches it and labels it
  (`global BPM 112.5 -> 225.0  <-- OCTAVE FLIP`).
- **`bench/gates.py coverage`** measures the density signal behind audit finding F-11 on
  three purpose-built half/double-time fixtures, kept out of the 24-case corpus so the
  published numbers stay comparable.
- **`bench/golden.py`** dumps and checks **per-stage** vectors — attacks, seed grid,
  octave, atom sections, beat sections, meter, points — 362 KB committed across the 24
  fixtures. This is the harness the Rust engine will be pointed at: a port can reach the
  right BPM through a wrong envelope and a compensating peak-picker, and only a
  stage-by-stage diff catches that.

Still open: no `.osu` **parser** tests, no property-based tests, no performance gate, no
fuzzing of the beatmap reader. See [`docs/01-audit-v3.md`](docs/01-audit-v3.md) §4.

---

## Compatibility

Understood correctly today: osu!stable timing points, inherited vs uninherited
discrimination (including legacy two-field red lines, where a negative beat length
overrides a contradictory flag), CRLF and BOM preservation, whole-millisecond offsets,
meter written from the detection.

Coming in v4: hitobject flags, sliders and per-node sample sets, slider velocity, custom
sample sets, sample indices and volumes, and reasonable osu!lazer support (decimal
offsets, newer `.osu` versions).

---

## Honest limits

- **Rubato / accelerating tempo**: no fixed grid exists. v3 detects this and falls back to
  the tracker, which emits a staircase of sections — measured at 8 sections on a
  120 → 160 BPM ramp. Expect to fix these by hand. v4's elastic grid targets exactly this.
- **Non-percussive music** (pads, legato strings, solo voice): there are no attacks to fit.
  `--engine precision` refuses the file rather than inventing an answer.
- **White noise currently returns a BPM** through the legacy tracker (`127.68` on the
  degenerate fixture). It should refuse; v4 adds a no-grid verdict.
- **A time-signature change that alters the bar's length is not detected.**
  A song whose bar stays the same length while the subdivision moves — 6/4 to
  3/4 to 4/4 over a constant 1.2 s measure — is handled exactly, and each red
  line carries its own meter. The opposite shape, where the beat stays and the
  bar changes length, still comes out as one section.
- **An exact 2× tempo change is reported as one section.** 87.5 is half of 175, so both
  halves share the same atomic grid and there is no change to find at that level — what
  changed is the octave, and v3 decides the octave globally. See audit finding **F-11**;
  v4 decides it per section.
- **Half-time *feel* sections** (same grid, half the energy): the BPM correctly stays put —
  map the feel, not a new red line.
- **Swing and shuffle**: BPM and offset come out exact, but the off-beats do not sit on a
  subdivision of the grid, so the reported grid residual is large. That number is telling
  you the truth about the music.
- **Offsets export as whole milliseconds** — that is what the `.osu` format specifies.
  The fit is sub-millisecond; rounding costs at most 0.5 ms.
- **The click track accents every 4 beats even on a 3/4 track** (audit finding **F-03**,
  fix pending a test).
- **Always verify the first beat and every transition in the osu! editor.**

---

## Development

```
timing_analyzer.py        v3 engine + Tk GUI + CLI
test_timing_analyzer.py   55 unit tests
bench/benchmark.py        synthetic accuracy harness
docs/                     v4 design documents
timeline.md               engineering log — one entry per release, with what was rejected
CLAUDE.md / AGENTS.md     contributor and agent conventions
```

Conventions that matter: no performance or accuracy claim without a measurement in the same
commit; `timeline.md` gets an entry per release including `Rejected / tried and dropped`;
`.osu` writes stay atomic and backed up; the project stays offline. No GitHub Actions —
every gate is a local one-liner. Full list in [CLAUDE.md](CLAUDE.md).

---

## Resumen en español

La interfaz usa inglés por defecto; elige **Español** en el desplegable. v3 sustituye la
lectura de BPM «por diferencias entre beats» por un **ajuste de rejilla por mínimos
cuadrados**: el BPM y el offset salen exactos (error mediano 0,0000 BPM y 0,16 ms,
reproducido el 21-09-2026) y además es unas 7 veces más rápido. Lo que sigue siendo
criterio humano es la **octava** (92 vs 184, 112,5 vs 225): usa **×2 / ÷2**, que es
instantáneo y exacto.

Flujo recomendado: analiza → revisa la curva → ajusta a mano → exporta el click track →
escúchalo contra la canción → **Inject .osu…** → verifica en el editor de osu!.

**v4** es una reescritura completa en Rust con interfaz moderna, analizador de hitsounds,
validación de mapas y procesado por lotes. El diseño completo está en [`docs/`](docs/); la
regla que lo gobierna es que la precisión de v3 es el mínimo, no el objetivo.

---

## License

MIT — do what you want, credit appreciated.
