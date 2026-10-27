# Overtone

**Timing and audio-analysis engine for osu! mapping, and the Mides Projects website
built on it.** Give it a song and Overtone proposes its BPM, offset, bar lines and tempo
changes, checks an existing map against the audio, and writes the timing into your
`.osu` without touching anything else. Open source under the [MIT licence](LICENSE).

Overtone is **web-only** since 2026-10-26: the website (`site/`) is its interface. The
desktop app (the web window, the classic Tk window and its MSI) was parked that day,
whole, on the `parked/desktop-app` branch and the `v3-desktop-app` tag; its editing
tools come back on the website in phase W7 ([web platform](docs/16-web-platform.md)).
The engine runs on its own from the command line.

![python](https://img.shields.io/badge/python-3.14-blue)
![rust](https://img.shields.io/badge/rust-stable-orange)
![licence](https://img.shields.io/badge/licence-MIT-blue)
![accuracy](https://img.shields.io/badge/median%20error-0.0000%20BPM%20%C2%B7%200.16%20ms-6ee7b7)
![tests](https://img.shields.io/badge/tests-491%20Python%20%C2%B7%20231%20Rust-6ee7b7)

## Accuracy, honestly

```
synthetic benchmark (24 tracks, exact ground truth)   24 / 24 sections within 0.05 BPM and 5 ms
                                                      median 0.0000 BPM, 0.16 ms  (2026-09-23)
real ranked maps (Corpus B, 20 hand-timed maps)       ~17 % of red lines within 5 ms
                                                      (Python engine, default export, 2026-10-24)
```

The synthetic number is an upper bound: clean drums with exact answers, where Overtone
is exact. **On real records it is still research.** Against 1,152 red lines that
mappers placed by hand on 20 ranked or loved maps, the default export lands within
5 ms of 16.8 % of them and within 50 ms of 55.7 %; octave choices, drift and live
playing are where it misses. Treat its output as a strong first draft and always check
the first beat and every transition in the osu! editor. The details, and what is being
done about it, are under [Benchmarks and gates](#benchmarks-and-gates) and in the
[precision plan](docs/10-precision-plan.md).

## Quick start

**The website.** Node 22+ and pnpm (`corepack enable`), from the repository root:

```bash
pnpm install && pnpm dev
```

The API starts on http://localhost:3001 and the web on http://localhost:5173 (open
that one). Development needs no secret and no database; configuration, sign-in and
deployment are in [docs/site.md](docs/site.md) and [docs/deploy.md](docs/deploy.md).

**The engine, from the command line.** Python 3.14:

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r python/requirements.lock
.venv/Scripts/python.exe python/overtone.py song.ogg --stats
```

Prints the red lines in osu!'s `[TimingPoints]` format; more under
[Command line](#command-line).

---

## Where it stands — 2026-10-26

| Area | State |
|---|---|
| **Timing engine** (Python) | ✅ Works. Exact on the synthetic corpus; refuses audio with no pulse |
| **Timing engine** (Rust v4) | ✅ At parity with Python, attack for attack and red line for red line; about 4× faster end to end on the corpus. `overtone-cli analyze` runs it; Python takes over, and says so, where Rust has no answer |
| **Website** (`site/`) | 🟡 Phase W3: it runs, signs people in with a Mides account and shows its pages; analysis on the site is the next phase ([docs/site.md](docs/site.md)) |
| **osu! files** | ✅ Full reader; writer keeps every byte you did not ask to change |
| **Measurement server** | ✅ `python/overtone_server.py`: a Songs folder's index and BPM cache, and the bench's measurement runs, over HTTP behind a token ([docs/server.md](docs/server.md)) |
| **Parked** | The desktop app, its Tk window and its installer (2026-10-26: `parked/desktop-app`, tag `v3-desktop-app`); before that, hitsounds, Compile, Train and the Songs browser (W1: `parked/desktop-extras`, tag `v3-desktop-full`) |
| **Accuracy on real, live-played songs** | 📋 Research underway — current default osu! export lands within 5 ms on 16.8 % of Python and 5.2 % of Rust Corpus B red lines; raw engine scores are 2.0 % and 1.1 % (`bench/corpus_b.py`, 2026-10-24) |

Nothing here claims a number that was not measured. Targets are marked as targets.

### Status legend

| | Meaning |
|---|---|
| ✅ | Implemented and covered by a test or gate |
| 🟡 | Partly implemented |
| 🦀 | Built and tested in the Rust engine, not reachable from an interface yet |
| 📋 | Planned — the roadmap phase is given (`P4` = [Phase 4](docs/07-roadmap.md)) |
| ✖ | Deliberately not built — see [Rejected ideas](docs/07-roadmap.md#rejected-ideas) |

---

## Features

Every row below is the engine (`python/overtone.py`, `crates/`), tested on its own.
The views that showed them were the desktop app's; on the website they return phase by
phase ([docs/16-web-platform.md](docs/16-web-platform.md)).

### Timing detection

| Feature | Status | Notes |
|---|:--:|---|
| Least-squares beat grid `t(k) = offset + k·beat` | ✅ | Hundreds of attacks average the jitter away — no beat-to-beat differencing |
| Sample-resolution attack re-timing | ✅ | Attacks land ~0.15 ms from truth |
| Coherence sweep for the atomic pulse | ✅ | Ranked by share × coverage, so ×2 and ÷2 grids both lose |
| Octave decision (which pulse is "the beat") | ✅ | Accent depth + tempogram hints; prefers the 120–300 BPM mapping range by default |
| Tempo sections and change points | ✅ | Each region re-seeds its own grid; boundaries on the beat where the grids cross |
| Downbeat anchoring | ✅ | Red lines sit on the "1" of the bar when the accents prove where it is |
| Time signatures per red line | ✅ | 6/4 → 3/4 → 4/4 over a constant bar, each line with its own meter |
| Exact ×2 / ÷2 | ✅ | `--subdivision`; re-reads the fitted grid, nothing is re-detected |
| Per-section pulse hints | ✅ | Flags half-time-looking sections |
| Refuses audio with no pulse | ✅ | White, pink and brown noise, pads, silence and scattered clicks get no grid |
| Fallback beat tracker for rubato / free time | ✅ | Says so in the result |
| Per-section octave (exact 2× changes) | 🦀 | In Rust; the Python engine decides the octave globally |
| Elastic grid for tempo ramps | 🦀 | 0.16 BPM on realistic ramps, in Rust (`overtone-cli ramps`); the analysis itself still gives a staircase in Python |
| 2-D coherence map | 🦀 | Better seeds and a confidence map |
| Bar-length change (4/4 → 3/4 keeping the beat) | 📋 | P5 |
| Fallback beats on their attacks | ✅ | The tracker's lag behind the attacks, read on each song's waveform, is taken off every beat and red line: 7-9 ms on clean drums, 12-17 ms on real songs |
| Real-audio offset bias measured and corrected | 📋 | P22 — explained, not corrected: ranked maps put their lines a median 21 ms before the sound starts (100 held-out maps, every decoder), and Overtone's grids sit a few ms after it |
| Human-level accuracy on real songs | 📋 | P10 — fingerprint reuse, percussive stem, neural beats, rippling tempo, ensemble |

### osu! files

| Feature | Status | Notes |
|---|:--:|---|
| Full `.osu` reader (all sections, objects, sliders, SV, samples) | ✅ | Unknown keys kept; 3000 mutated files a run (`bench/fuzz_reader.py`) |
| Byte-identical writer | ✅ | BOM, line endings and a missing final newline survive |
| Atomic writes with a `.bak` that is never overwritten | ✅ | |
| Timing injection that keeps what the map plays | ✅ | Measured on a ranked map: 0 of 1341 objects change sound or scroll |
| `.osz` from a song: audio + a minimal `.osu` | ✅ | `--osz` |
| Decimal offsets for lazer | ✅ | `--decimal-offsets`: 0-6 decimals; lazer (v128) maps read, write back byte for byte and inject like stable's |
| Inject into every difficulty, with a diff; kiai, breaks, bookmarks, section volumes and the preview point from the song's structure; SV normaliser; re-snap; audio swap; write history and restore | ✅ | Engine functions, each tested; their views were the desktop app's and come back in W7 |
| Export to Quaver and StepMania | ✅ | Red lines only |

### Map checking

| Feature | Status | Notes |
|---|:--:|---|
| Timing validation: duplicates, short sections, impossible changes, suspicious offsets, octave | ✅ | Reported, never auto-fixed |
| Alignment, density, snap audit, suggestions | ✅ | |
| Mapset check: red lines, audio settings and metadata across difficulties | ✅ | Read only |
| Reference timing: grade any map's red lines against the attacks | ✅ | Offset, drift and fitted BPM per line, each with its standard error |
| Assisted timing: two marked downbeats fit the grid | ✅ | |
| Mod report: every finding as an osu! editor timestamp | ✅ | `--check map.osu` |
| Library health check across a Songs folder | 🟡 | `overtone_library.py`, run by the measurement server |

### Audio analysis

| Feature | Status | Notes |
|---|:--:|---|
| 7-band onset functions, HPSS, chroma and MFCC | 🦀 | |
| Song structure and section labels (intro / verse / chorus) | ✅ | Rust engine (`overtone-cli structure`); labels are heuristics and say which rule decided them |
| Snap-divisor map | ✅ | One line per section |

### Command line

| Feature | Status | Notes |
|---|:--:|---|
| Analyse, stats, CSV, click track, `.osz`, inject | ✅ | |
| `--json` machine-readable output | ✅ | |
| Whole folders | ✅ | |
| A map checked, `--check map.osu` | ✅ | One line per finding; exit 3 on findings, 0 clean |
| Rust engine as a JSON sidecar (`overtone-cli analyze --json` / `--full`) | ✅ | Exit codes: 0 grid, 3 refused, 1 unreadable, 2 usage |
| The sidecar's other commands: `structure`, `ramps` | ✅ | |
| Unified command set (`analyze · timing · validate …`) | 📋 | P8 |

### Deliberately not built

| Idea | Status | Why |
|---|:--:|---|
| Difficulty / strain graphs | ✖ | osu!'s own star rating does it better |
| Timing or hitsounding with no review | ✖ | Suggestions with confidence, yes; "trust me", no |
| Telemetry, update checks, third-party APIs | ✖ | The engine runs offline; the site talks only to its own API |
| SuperFlux onset function, tempogram from the coherence map | ✖ | Measured and lost |

---

## Command line

```bash
.venv/Scripts/python.exe python/overtone.py song.wav --stats   # red lines plus a summary
.venv/Scripts/python.exe python/overtone.py Songs/123 --json    # every audio file in a folder
.venv/Scripts/python.exe python/overtone.py song.ogg --check map.osu
```

WAV, FLAC, OGG and most MP3s open directly (libsndfile 1.2); the odd MP3 it cannot read
(one of the songs tested) and M4A / AAC need FFmpeg on `PATH` for the Python engine. The
Rust engine decodes all of them in-process, AIFF too; Opus it refuses by name, by
decision: its decoder would be a C build.

| Flag | Effect |
|---|---|
| `--delta 1.5` | minimum BPM gap before a new red line |
| `--persistence 12` | beats a new tempo must hold (20+ for constant-tempo songs) |
| `--min-confidence 75` | filters shaky sections |
| `--subdivision 2` | multiplies the detected beat rate; `0.5` halves it — exact |
| `--engine auto\|precision\|legacy` | `precision` refuses to fall back to the tracker |
| `--decimal-offsets 3` | sub-millisecond offsets (lazer accepts them, stable does not) |
| `--click click.wav` | metronome on the red lines |
| `--stats` / `--json` | summary, or everything as JSON |
| `--osz out.osz` | a complete beatmap archive; `--artist` / `--title` / `--creator` |
| `--inject map.osu` | red lines into an existing map (`--no-backup` skips the `.bak`) |
| `--no-refine` | skip sample-resolution re-timing (diagnostic) |
| `--watch` | analyse again, with the same options, each time the audio file is saved; Ctrl+C stops |
| `--check map.osu` | the modder's report for that map instead of the red lines; exits 3 when it finds something, 0 when clean |

Presets: **Variable** 1.5 / 12 / 75 (the defaults), **Steady** 2.0 / 20 / 85.

---

## How the engine works

1. **Load** mono, normalised; files longer than an hour are refused from the header.
2. **Attacks** are peak-picked from a 2.9 ms onset envelope and **re-timed on the raw
   waveform at sample resolution** — a spectral-flux peak lags the real attack by about
   one window.
3. **Atomic pulse.** A weighted circular-coherence sweep `R(f) = |Σ w·e^{2πift}| / Σ w`
   ranks every plausible rate by share × coverage.
4. **Lock.** Expanding-window least squares walks that grid over the whole track; a
   robust re-centring snaps the phase to the densest residual cluster, so swing and ghost
   notes cannot drag the offset.
5. **Octave.** Attacks grouped by index modulo *m*: if *m* atoms make a beat, one class
   holds the kicks. Accent depth plus tempogram hints decide *m* and the downbeat — and
   that class is re-expressed in each section's own index frame.
6. **Sections** grow while attacks keep landing on the grid; each new region re-seeds its
   own scan; boundaries settle where the two grids cross; each section is refitted alone.
7. **Measures.** Where the accents prove a bar, red lines sit on downbeats and a signature
   change over one constant bar gets its own red line and meter — but only when every
   section divides that bar, so a real tempo change is never swallowed.
8. **Fallback.** No grid fits (rubato, free time): the v2 tracker runs, after checking the
   onset envelope is more periodic than itself shuffled — noise is refused, not timed. Its
   beats sit on the envelope's peaks, after the attacks; the lag, read on the waveform for
   each song, is taken off every beat and red line.

Full specification: [`docs/05-dsp-pipeline.md`](docs/05-dsp-pipeline.md).

### The octave is a judgement call

BPM and offset are essentially exact. Which multiple of the pulse *you* call the beat is
not: a 92 BPM song with eighth-note hats is also a valid 184 BPM map. Preferring the
120–300 BPM mapping range breaks the tie towards the range osu! is mapped in;
`--subdivision 2` / `0.5` fix it exactly; the click track is the arbiter.

---

## Benchmarks and gates

```bash
.venv/Scripts/python.exe -m unittest discover -s tests   # 491 tests
.venv/Scripts/python.exe bench/benchmark.py            # 24/24, median 0.0000 BPM / 0.16 ms
.venv/Scripts/python.exe bench/gates.py bpm-snapshot   # the octave, pinned per fixture
.venv/Scripts/python.exe bench/golden.py check         # 27/27 stage by stage
.venv/Scripts/python.exe bench/gates.py coverage       # density changes inside a section
.venv/Scripts/python.exe bench/gates.py measures       # bars read and anchored
.venv/Scripts/python.exe bench/gates.py signatures     # signature regions over one bar
.venv/Scripts/python.exe bench/gates.py robustness     # the audit's edge-case probes
.venv/Scripts/python.exe bench/gates.py reference      # hand-timed maps graded by the attacks
.venv/Scripts/python.exe bench/gates.py assisted       # two marked downbeats seed the grid
.venv/Scripts/python.exe bench/gates.py real-audio     # six local songs keep analysing as pinned
.venv/Scripts/python.exe bench/gates.py perf           # no stage got slower than its baseline
.venv/Scripts/python.exe bench/fixtures.py             # Python and Rust read one fixture list
.venv/Scripts/python.exe bench/facts.py                # the numbers these docs state
.venv/Scripts/python.exe bench/corpus_b.py             # 20 ranked maps' red lines (needs a local library)
cargo test --workspace                                 # 231 tests
cargo run --release -q -p overtone-bench -- golden     # Rust vs Python, attack for attack
```

The full list, with every gate's one line, is in [CLAUDE.md](CLAUDE.md#verification--run-these-before-any-commit-that-touches-the-engine).

The corpus is **24 synthesized tracks** with exact ground truth: odd tempos (222.22,
128.37), noise, ±8 ms jitter, swing and shuffle, drops, sparse bars, a 6-minute track and
2–4 tempo changes per song, plus degenerate inputs that must be refused. The benchmark
scores precision, not the octave — that is what `bpm-snapshot` is for — and it scores
offsets modulo one beat, which is why an off-beat red line could hide in it until the
2026-09-23 audit round found one.

**Synthetic drums are cleaner than records.** Read Corpus A as an upper bound. On the 20
hand-timed ranked maps in local Corpus B (`bench/corpus_b.py`), the raw engine grid lands
within 5 ms of 2.0 % of Python's and 1.1 % of Rust's 1,152 red lines. The default
28 ms osu! export lead raises those measured shares to 16.8 % and 5.2 % respectively
(2026-10-24); it does not fix tempo/octave errors or drift. The Python export lands within
50 ms of 55.7 % of the lines. Ranked maps put their lines a median 21 ms before the sound
starts (`bench/corpus_b.py --onsets`). Improving the grid itself remains [Phase 10](docs/10-precision-plan.md).

Corpus B and the `real-audio` gate read songs from an osu! Songs folder, which is never
committed: the list of maps lives in a gitignored `bench/corpus_b.local.json` (the shape is
in `bench/corpus_b.example.json`, and [`bench/local_data.py`](bench/local_data.py) explains
the rest). Without it those two say so and check nothing; every other gate runs anywhere.

Rust speed, like for like: the whole pipeline over the corpus (decode, attacks, tempo)
takes ~4.2 s against ~18.5 s for Python's `analyze_audio` — about 4×. An earlier "2.5 s"
timed decoding and attack detection only.

---

## Honest limits

- **Real recordings are much harder than the corpus** — see above.
- **Rubato and accelerating tempo** fall back to the tracker, which emits a staircase of
  red lines in Python (8 on a 120 → 160 ramp). The Rust elastic grid handles ramps; the
  analysis itself does not use it yet.
- **An exact 2× tempo change** is one section in Python — the octave is decided globally.
  Rust decides it per section.
- **A signature change that keeps the beat and changes the bar's length** is not detected.
- **Swing and shuffle**: BPM and offset are exact, but the grid residual is large — that
  number is telling the truth about the music.
- **Offsets export as whole milliseconds** by default, what osu!stable reads;
  `--decimal-offsets` keeps decimals for lazer. The fit is sub-millisecond.
- **Every audit finding is closed** — fixed, found already fixed, or decided (Opus stays
  refused) — [`docs/13-audit-backlog.md`](docs/13-audit-backlog.md).
- **Always check the first beat and every transition in the osu! editor.**

---

## Documentation

| Document | Contents |
|---|---|
| [01 · Audit of v3](docs/01-audit-v3.md) | What v3 does well; the original findings |
| [02 · Stack evaluation](docs/02-stack-evaluation.md) | Stacks compared; why Rust + a web front end |
| [03 · Architecture](docs/03-architecture.md) | Crates, dependency rules, threading |
| [04 · UI / UX](docs/04-ui-ux.md) | The parked desktop app's design tokens, screens and timeline |
| [05 · DSP pipeline](docs/05-dsp-pipeline.md) | The porting contract and the gated improvements |
| [07 · Roadmap](docs/07-roadmap.md) | Every phase, with status, priority and dependencies |
| [08 · Machine learning](docs/08-machine-learning.md) | Where ML earns its place |
| [09 · Naming](docs/09-naming.md) | Why "Overtone" |
| [10 · Precision plan](docs/10-precision-plan.md) | Human-level accuracy on real songs, with a verified licence audit |
| [11 · MSI distribution](docs/11-msi-distribution.md) | The installer, as it was before it was parked |
| [12 · Comfort features](docs/12-comfort-features.md) | Playback, projects, osu! integration, i18n, plugins |
| [13 · Audit backlog](docs/13-audit-backlog.md) | The audit's findings, every one closed |
| [14 · Other languages](docs/14-other-languages.md) | Which features another language serves better, and how they stay in step |
| [16 · Web platform](docs/16-web-platform.md) | The site: architecture decisions and the phases from W1 on |
| [site](docs/site.md) | Running, configuring and checking the website |
| [server](docs/server.md) | The measurement server: library API and measurement runs |
| [Project map](docs/project-map.md) | Architecture, source facts, and links to the code and task/status graphs |
| [timeline](docs/timeline.md) | Engineering log, with what was tried and dropped |
| [workflow](docs/workflow.md) | The per-task routine: program, test, measure, commit, audit |

---

## Development

```
site/                     the website: site/api (Express + PostgreSQL), site/web (React)
python/                   Python v3 engine + CLI + library index + measurement server
tests/                    engine, I/O, command-line and server tests (+ fixtures)
bench/                    benchmark, gates, golden vectors
crates/                   Rust workspace: core, audio, dsp, tempo, bench, cli
proto/                    prototypes measured before any port
assets/                   generated logo, icon and the Beat This! model
deploy/                   the server's updater and the site's hosting
docs/                     design documents, plans, workflow routine, timeline
```

Conventions: one logical change per commit, commits and branches in English
as `type(scope/task): short imperative description` (see `AGENTS.md`); each
fix with a test that fails on the old code; no accuracy or speed claim
without a measurement in the same commit; `.osu` writes atomic and backed
up; no checks in GitHub Actions — every gate is a local one-liner.
Start with [CONTRIBUTING.md](CONTRIBUTING.md); the routine is in
[docs/workflow.md](docs/workflow.md), the full rules in [CLAUDE.md](CLAUDE.md).
Security problems: [SECURITY.md](SECURITY.md) (privately, never a public issue).

---

## Resumen en español

**Overtone** es un motor de timing de código abierto (MIT) para osu! y la web de Mides
Projects construida sobre él: propone BPM, offsets, compases y cambios de tempo, compara
un mapa con el audio y escribe el timing en tu `.osu` sin tocar nada más.

- **Solo web desde el 2026-10-26:** la interfaz es el sitio (`site/`; `pnpm install &&
  pnpm dev`, ver `docs/site.md`). La app de escritorio, la ventana Tk y el instalador
  quedaron estacionados enteros en la rama `parked/desktop-app` y el tag
  `v3-desktop-app`; las herramientas de edición vuelven en la web en la fase W7.
- **Precisión, sin adornos:** exacto en el benchmark sintético (24/24 secciones dentro de
  0,05 BPM y 5 ms); en mapas rankeados reales todavía es investigación: cerca del 17 % de
  las red lines puestas a mano quedan dentro de 5 ms. Revisá siempre el primer beat y cada
  transición en el editor de osu!.
- **El motor por línea de comandos:** `python python/overtone.py cancion.ogg --stats`
  (análisis, CSV, pista de clic, `.osz`, inyección en un `.osu`, `--check` de un mapa).
- **Motor en Rust (🦀):** da los mismos resultados que Python y es unas 4 veces más rápido
  de punta a punta (`overtone-cli analyze`).

---

## License

MIT, in [`LICENSE`](LICENSE) and declared in `Cargo.toml`. Contributions are accepted
under the same licence.
