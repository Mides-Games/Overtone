# Overtone

**Offline timing and audio-analysis workbench for osu! mapping.** Open a song and
Overtone finds every BPM, offset, bar line and tempo change with sub-millisecond accuracy,
checks an existing map against the audio, and writes the timing into your `.osu` without
touching anything else. No uploads, no accounts, no network calls.

![python](https://img.shields.io/badge/python-3.14-blue)
![rust](https://img.shields.io/badge/rust-stable-orange)
![accuracy](https://img.shields.io/badge/median%20error-0.0000%20BPM%20%C2%B7%200.16%20ms-6ee7b7)
![tests](https://img.shields.io/badge/tests-468%20Python%20%C2%B7%20263%20Rust-6ee7b7)

```
median BPM error      0.0000 BPM      measured 2026-09-23 on the 24-track corpus
median offset error   0.16 ms
sections within 0.05 BPM and 5 ms     24 / 24
```

---

## Where it stands — 2026-09-24

| Area | State |
|---|---|
| **Timing engine** (Python) | ✅ Works. Exact on the synthetic corpus; refuses audio with no pulse |
| **Timing engine** (Rust v4) | ✅ At parity with Python, attack for attack and red line for red line; about 4× faster end to end on the corpus. In the app as an opt-in (Settings → Rust engine); Python takes over, and says so, where Rust has no answer |
| **App** (web window) | ✅ Sections for Library, Timing, Structure, Hitsounds, Map check, Mapset, Report and Export; analyse, edit, undo, lock, export, inject, compare with a map, alignment, density, snap audit, suggestions, mapset check, reference timing, assisted timing, mod report, osu! Songs browser — in English and Spanish |
| **osu! files** | ✅ Full reader; writer keeps every byte you did not ask to change |
| **Hitsounds** | 🦀 Half built in Rust (features, 13 instrument classes, musical role); no decision or editor yet |
| **Playback inside the app** | ✅ Song with a live click from the current red lines, playhead, section loop at 100/75/50 %, taps |
| **Accuracy on real, live-played songs** | 📋 Planned — today ~5 % of a ranked map's red lines land within 5 ms |
| **Installer** (MSI) | 📋 Planned |

Nothing here claims a number that was not measured. Targets are marked as targets.

### Status legend

| | Meaning |
|---|---|
| ✅ | Implemented and covered by a test or gate |
| 🟡 | Partly implemented |
| 🦀 | Built and tested in the Rust engine, not reachable from the app yet |
| 📋 | Planned — the roadmap phase is given (`P4` = [Phase 4](docs/07-roadmap.md)) |
| ✖ | Deliberately not built — see [Rejected ideas](docs/07-roadmap.md#rejected-ideas) |

---

## Features

### Timing detection

| Feature | Status | Notes |
|---|:--:|---|
| Least-squares beat grid `t(k) = offset + k·beat` | ✅ | Hundreds of attacks average the jitter away — no beat-to-beat differencing |
| Sample-resolution attack re-timing | ✅ | Attacks land ~0.15 ms from truth |
| Coherence sweep for the atomic pulse | ✅ | Ranked by share × coverage, so ×2 and ÷2 grids both lose |
| Octave decision (which pulse is "the beat") | ✅ | Accent depth + tempogram hints; *Prefer map BPM (120–300)* by default |
| Tempo sections and change points | ✅ | Each region re-seeds its own grid; boundaries on the beat where the grids cross |
| Downbeat anchoring | ✅ | Red lines sit on the "1" of the bar when the accents prove where it is |
| Time signatures per red line | ✅ | 6/4 → 3/4 → 4/4 over a constant bar, each line with its own meter |
| Instant, exact ×2 / ÷2 | ✅ | Re-reads the fitted grid; nothing is re-detected |
| Per-section pulse hints | ✅ | Flags half-time-looking sections |
| Refuses audio with no pulse | ✅ | White, pink and brown noise, pads, silence and scattered clicks get no grid |
| Fallback beat tracker for rubato / free time | ✅ | Says so in the result and the app |
| Result cache by audio content | ✅ | Re-analysing a song takes ~0.02 s |
| Per-section octave (exact 2× changes) | 🦀 | In Rust; the Python engine decides the octave globally |
| Elastic grid for tempo ramps | 🦀 | 0.16 BPM on realistic ramps in Rust; Python emits a staircase |
| 2-D coherence map | 🦀 | Better seeds and a confidence map |
| Bar-length change (4/4 → 3/4 keeping the beat) | 📋 | P5 |
| Fallback beats re-timed at sample resolution | 📋 | P22 — they land 5–35 ms late today |
| Real-audio offset bias measured and corrected | 📋 | P22 — measured, not explained: 30 ranked maps read the attacks +26 ms after their lines (median), OGG as much as MP3 |
| Human-level accuracy on real songs | 📋 | P10 — fingerprint reuse, percussive stem, neural beats, rippling tempo, ensemble |
| Analysis mode fast / precise | 📋 | P20 |

### The app (web window)

| Feature | Status | Notes |
|---|:--:|---|
| Open audio, drag and drop, beatmap folder import, recent files | ✅ | A file dropped on `Overtone.bat` opens straight into analysis |
| Analysis on a background thread with stage messages | ✅ | |
| Stats strip: global BPM, points, beats, stability, engine, residual | ✅ | |
| Timeline: local BPM, waveform, drift lane, sections, red lines, hover readout | ✅ | Wheel zooms at the cursor, drag pans; click selects the governing red line |
| Timing-point list with a detail panel | ✅ | ↑ / ↓ to move; the panel explains the selected point |
| Honesty banners | ✅ | Fallback engine, a first red line long after the music starts, loose grids, validation findings |
| Point editor: apply, add, delete, ±1 ms nudge, per-section ×2 / ÷2 | ✅ | |
| Undo / redo | ✅ | |
| Lock verified points | ✅ | Locked points survive re-analysis |
| Exports: copy `.osu` timing, CSV, click track, `.osz` | ✅ | |
| Inject into a `.osu` with a preview | ✅ | Keeps sample set, volume, kiai and slider velocity |
| Map vs detected comparison | ✅ | |
| Object alignment: do the map's notes land on real attacks? | ✅ | |
| Object density over time | ✅ | |
| Suggestions: red lines the map is missing | ✅ | Shown on the tempo map; applying one is P9 |
| Reference timing: grade any map's red lines against the attacks | ✅ | Offset, drift and fitted BPM per line, each with its standard error; load a map as the working timing; find every map of the same audio in a Songs folder |
| Structure: the song's sections, each label with the evidence behind it | ✅ | Rust engine; edges snap to proven bar lines, a section opens in Timing. Labels are heuristics and say which rule decided them |
| Hitsounds section: where each addition falls in the bar, every sound heard one by one | ✅ | Read only; against the map's own red lines, in sixteenths. The object lane shows them on the timeline |
| Hear a difficulty's hitsounds with the song | ✅ | The transport's "Hitsounds from"; the map's own samples, else Overtone's (osu!'s defaults are not ours to ship). Slider bodies not yet |
| Hitsound copier: one difficulty's hitsounds onto the others | ✅ | Mapset view; by time within 5 ms, a preview first, only hitsound fields change, backups kept |
| osu! Songs browser: your whole Songs folder, searched as you type | ✅ | A SQLite index: a rescan reads only what changed, and maps of the same audio come back in milliseconds |
| Mod report: every finding as osu! editor timestamps | ✅ | Red lines to check, missing red lines, unsnapped objects, objects away from the music; copy all, or open the editor at a timestamp |
| Assisted timing: two marked downbeats fit the grid | ✅ | Where detection fails: marks snap to attacks, the grid grows across breakdowns but not tempo changes, refusals say why. Marks are typed in ms, or tapped from a downbeat |
| Detection settings drawer, presets | ✅ | Shared with the classic window |
| English / Spanish | ✅ | |
| Dark window caption, generated app icon | ✅ | |
| Verdict strip | 🟡 | Engine pill and banners; one-line verdict is P3 |
| Progress panel | 🟡 | Stage names; timings and cancel are P3 |
| Drag red lines on the timeline | ✅ | Snaps to the nearest attack (Alt: free); one undo |
| Map red lines drawn as ghosts on the timeline | ✅ | From the reference or compare card |
| Command palette, full keyboard map | 📋 | P3 |
| Settings section: output folder, offset precision, click, interface size, cache | ✅ | Detection stays in its drawer |
| Sections: Audio | 📋 | P19 — Library, Timing, Structure, Hitsounds, Map check, Mapset, Report, Export and Settings exist |
| Light and dark themes, or the system's | ✅ | Settings → Theme; UI scale and reduced motion too |

### Playback

| Feature | Status | Notes |
|---|:--:|---|
| Click track export (accent on the detected meter) | ✅ | Listen to it against the song — the final arbiter |
| Tap tempo | ✅ | In the app (T) and the classic window |
| Play song + click inside the app | ✅ | One clock for both: attacks and clicks within 0.25 ms, measured; the click follows edits while playing |
| Section loop at 75 / 50 % | ✅ | Resampled, so the pitch drops and every attack stays exactly in place; a pitch-kept stretch moved attacks ~24 ms |
| Seek, section loop, playhead, play from a red line | ✅ | Space plays and pauses; double-click the tempo map to play from there |
| Tap-along check, tap latency calibration | ✅ | How far your taps land from the click; calibrate once, remembered |
| Metronome options | ✅ | 1-4 clicks per beat, bar accent; one sound |

### osu! files

| Feature | Status | Notes |
|---|:--:|---|
| Full `.osu` reader (all sections, objects, sliders, SV, samples) | ✅ | Unknown keys kept |
| Byte-identical writer | ✅ | BOM, line endings and a missing final newline survive |
| Atomic writes with a `.bak` that is never overwritten | ✅ | |
| Timing injection that keeps what the map plays | ✅ | Measured on a ranked map: 0 of 1341 objects change sound or scroll |
| Legacy two-field timing lines | ✅ | |
| `.osz` from a song: audio + a minimal `.osu` | ✅ | |
| Decimal offsets for lazer | 🟡 | CLI flag; in the app is P20 |
| lazer format specifics | 📋 | P5 |
| Inject into every difficulty at once, with a diff | 📋 | P21 |
| Kiai, preview point, bookmarks and breaks from song structure | 📋 | P21 |
| SV normaliser across BPM changes | 📋 | P21 |
| Re-snap objects after a timing change | 📋 | P21 |
| Export to Quaver and StepMania | 📋 | P21 |
| Audio file check against ranking rules | 📋 | P21 |
| Reader fuzzing | 📋 | P5 |

### Map checking

| Feature | Status | Notes |
|---|:--:|---|
| Timing validation: duplicates, short sections, impossible changes, suspicious offsets, octave | ✅ | Shown as banners, never auto-fixed |
| Alignment report | ✅ | |
| Density analysis | ✅ | |
| Snap audit: objects off the map's own grid, and what an inject would unsnap | ✅ | Object starts |
| Mapset check: red lines, audio settings and metadata across difficulties | ✅ | Read only, never fixes |
| Timing suggestions | ✅ | |
| Apply a suggestion to the `.osu` | 📋 | P9 |
| Hitsound validation | 📋 | P7 |
| Library health check across a Songs folder | 📋 | P21 |

### Audio analysis

| Feature | Status | Notes |
|---|:--:|---|
| 7-band onset functions | 🦀 | |
| Harmonic / percussive separation (HPSS) | 🦀 | Also the planned percussive stem for P10 |
| Chroma and MFCC | 🦀 | Bass notes on their true pitch class since 2026-09-23 |
| Song structure and section labels (intro / verse / chorus) | 🦀 | |
| Audio section: spectrogram, band lanes, energy with sections | 📋 | P19 |
| Snap-divisor map and swing lane | 📋 | P21 |

### Hitsounds

| Feature | Status | Notes |
|---|:--:|---|
| Per-attack spectral, temporal and source features | 🦀 | |
| 13 instrument templates, calibrated | 🦀 | Macro F1 0.72 on synthetic arrangements it never saw — not a real-song number (an earlier "0.91" judged a re-draw of its training track) |
| Musical role: grid position, metrical weight, phrase, accent | 🦀 | |
| Map context per attack | 🟡 | Python |
| Sequence decision (Viterbi) with explanations | 📋 | P6 |
| Profiles, hitsound editor, sample bank, hitsound export | 📋 | P6 |

### Command line

| Feature | Status | Notes |
|---|:--:|---|
| Analyse, stats, CSV, click track, `.osz`, inject | ✅ | |
| `--json` machine-readable output | ✅ | |
| Whole folders | ✅ | |
| Unified command set (`analyze · timing · hitsound · validate …`) | 📋 | P8 |
| Rust engine as a JSON sidecar (`overtone-cli analyze --json` / `--full`) | ✅ | Exit codes: 0 grid, 3 refused, 1 unreadable, 2 usage |

### Distribution

| Feature | Status | Notes |
|---|:--:|---|
| Double-click launcher | ✅ | `Overtone.bat` |
| Self-contained MSI + portable ZIP | 📋 | P10.13 — [plan](docs/11-msi-distribution.md) |

### Deliberately not built

| Idea | Status | Why |
|---|:--:|---|
| Difficulty / strain graphs | ✖ | osu!'s own star rating does it better |
| Timing or hitsounding with no review | ✖ | Suggestions with confidence, yes; "trust me", no |
| Anything in the cloud, telemetry, update checks | ✖ | Offline is a product property |
| PySide6 desktop UI | ✖ | Superseded by the web window, which moves to Tauri unchanged |
| SuperFlux onset function, tempogram from the coherence map | ✖ | Measured and lost |

---

## Install & run

Windows, Python 3.14:

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.lock
```

Then double-click **`Overtone.bat`**, or from a terminal:

```bash
.venv/Scripts/python.exe overtone_web.py [audio-file]   # the app (Edge WebView2 window)
.venv/Scripts/python.exe overtone.py                    # the classic Tk window
.venv/Scripts/python.exe overtone.py song.wav --stats   # command line
```

WAV, FLAC, OGG and most MP3s open directly (libsndfile 1.2); the odd MP3 it cannot read
(one of the songs tested) and M4A / AAC need FFmpeg on `PATH` for the Python engine. The
Rust engine decodes all of them in-process, AIFF too; Opus it refuses by name, by
decision: its decoder would be a C build.

Command-line flags:

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

A folder instead of a file analyses every audio file in it. Presets: **Variable**
1.5 / 12 / 75 (default), **Steady** 2.0 / 20 / 85.

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
   onset envelope is more periodic than itself shuffled — noise is refused, not timed.

Full specification: [`docs/05-dsp-pipeline.md`](docs/05-dsp-pipeline.md).

### The octave is a judgement call

BPM and offset are essentially exact. Which multiple of the pulse *you* call the beat is
not: a 92 BPM song with eighth-note hats is also a valid 184 BPM map. *Prefer map BPM
(120–300)* breaks the tie towards the range osu! is mapped in; **×2 / ÷2** fix it
instantly and exactly; the click track is the arbiter.

---

## Benchmarks and gates

```bash
.venv/Scripts/python.exe -m unittest test_overtone test_overtone_web   # 468 tests
.venv/Scripts/python.exe bench/benchmark.py            # 24/24, median 0.0000 BPM / 0.16 ms
.venv/Scripts/python.exe bench/gates.py bpm-snapshot   # the octave, pinned per fixture
.venv/Scripts/python.exe bench/golden.py check         # 27/27 stage by stage
.venv/Scripts/python.exe bench/gates.py coverage       # density changes inside a section
.venv/Scripts/python.exe bench/gates.py measures       # bars read and anchored
.venv/Scripts/python.exe bench/gates.py signatures     # signature regions over one bar
.venv/Scripts/python.exe bench/gates.py robustness     # the audit's edge-case probes
.venv/Scripts/python.exe bench/gates.py reference      # hand-timed maps graded by the attacks
.venv/Scripts/python.exe bench/gates.py assisted       # two marked downbeats seed the grid
.venv/Scripts/python.exe bench/facts.py                # the numbers these docs state
cargo test --workspace                                 # 263 tests
cargo run --release -q -p overtone-bench -- golden     # Rust vs Python, attack for attack
```

The corpus is **24 synthesized tracks** with exact ground truth: odd tempos (222.22,
128.37), noise, ±8 ms jitter, swing and shuffle, drops, sparse bars, a 6-minute track and
2–4 tempo changes per song, plus degenerate inputs that must be refused. The benchmark
scores precision, not the octave — that is what `bpm-snapshot` is for — and it scores
offsets modulo one beat, which is why an off-beat red line could hide in it until the
2026-09-23 audit round found one.

**Synthetic drums are cleaner than records.** Read the corpus numbers as an upper bound.
On a real live-band ranked map (*Vampires Will Never Hurt You*, 236 hand-placed red lines)
about 5 % of the red lines land within 5 ms today; closing that gap is
[Phase 10](docs/10-precision-plan.md).

Rust speed, like for like: the whole pipeline over the corpus (decode, attacks, tempo)
takes ~4.2 s against ~18.5 s for Python's `analyze_audio` — about 4×. An earlier "2.5 s"
timed decoding and attack detection only.

---

## Honest limits

- **Real recordings are much harder than the corpus** — see above.
- **Rubato and accelerating tempo** fall back to the tracker, which emits a staircase of
  red lines in Python (8 on a 120 → 160 ramp). The Rust elastic grid handles ramps; the app
  does not use it yet.
- **An exact 2× tempo change** is one section in Python — the octave is decided globally.
  Rust decides it per section.
- **A signature change that keeps the beat and changes the bar's length** is not detected.
- **Swing and shuffle**: BPM and offset are exact, but the grid residual is large — that
  number is telling the truth about the music.
- **Offsets export as whole milliseconds** (the `.osu` format); the fit is sub-millisecond.
- **Every audit finding is closed** — fixed, found already fixed, or decided (Opus stays
  refused) — [`docs/13-audit-backlog.md`](docs/13-audit-backlog.md).
- **Always check the first beat and every transition in the osu! editor.**

---

## Documentation

| Document | Contents |
|---|---|
| [01 · Audit of v3](docs/01-audit-v3.md) | What v3 does well; the original findings |
| [02 · Stack evaluation](docs/02-stack-evaluation.md) | Stacks compared; why Rust + a web shell |
| [03 · Architecture](docs/03-architecture.md) | Crates, dependency rules, threading |
| [04 · UI / UX](docs/04-ui-ux.md) | Design tokens, screens, timeline |
| [05 · DSP pipeline](docs/05-dsp-pipeline.md) | The porting contract and the gated improvements |
| [06 · Hitsound engine](docs/06-hitsound-engine.md) | Features → instruments → context → decision → export |
| [07 · Roadmap](docs/07-roadmap.md) | Every phase, with status, priority and dependencies |
| [08 · Machine learning](docs/08-machine-learning.md) | Where ML earns its place |
| [09 · Naming](docs/09-naming.md) | Why "Overtone" |
| [10 · Precision plan](docs/10-precision-plan.md) | Human-level accuracy on real songs, with a verified licence audit |
| [11 · MSI distribution](docs/11-msi-distribution.md) | One self-contained installer |
| [12 · Comfort features](docs/12-comfort-features.md) | Playback, projects, osu! integration, i18n, plugins |
| [13 · Audit backlog](docs/13-audit-backlog.md) | Confirmed findings still open |
| [14 · Other languages](docs/14-other-languages.md) | Which features another language serves better, and how they stay in step |
| [15 · Hitsound plan](docs/15-hitsound-plan.md) | What hitsounds need first, and what ships in which order |
| [timeline.md](timeline.md) | Engineering log, with what was tried and dropped |

---

## Development

```
overtone.py               Python engine + classic Tk window + CLI
overtone_web.py           the app: pywebview window + JSON bridge to the engine
overtone_library.py       the library index: your Songs folder in SQLite
library.sql               the index's schema
app/                      the app's frontend (HTML/CSS/JS, nothing from the network)
Overtone.bat              double-click launcher
test_overtone.py          engine, I/O and classic-window tests
test_overtone_web.py      bridge tests (never touch your real config)
bench/                    benchmark, gates, golden vectors
crates/                   Rust workspace: core, audio, dsp, tempo, hitsound, bench
proto/                    prototypes measured before any port
assets/                   generated logo and icon
docs/                     design documents and plans
```

Conventions: one logical change per commit, each fix with a test that fails on the old
code; no accuracy or speed claim without a measurement in the same commit; `.osu` writes
atomic and backed up; offline only; no GitHub Actions — every gate is a local one-liner.
The routine is in [WORKFLOW.md](WORKFLOW.md), the rules in [CLAUDE.md](CLAUDE.md).

---

## Resumen en español

**Overtone** es una herramienta offline para timear canciones de osu!: encuentra BPM,
offsets, compases y cambios de tempo con precisión sub-milisegundo, compara un mapa con el
audio y escribe el timing en tu `.osu` sin tocar nada más (hitsounds, kiai y velocidad de
sliders quedan igual).

- **Qué funciona hoy (✅):** análisis, editor con deshacer, bloqueo de puntos, exportación
  (`.osu`, CSV, pista de clic, `.osz`), inyección con vista previa, comparación con un mapa,
  alineación, densidad y sugerencias, en inglés y español.
- **Motor en Rust (🦀):** da los mismos resultados que Python y es unas 4 veces más rápido de punta a punta; todavía no lo usa la app.
- **Próximo (📋):** los hallazgos medios de la auditoría (los 6 altos ya están
  arreglados), escuchar la canción con el clic dentro de la app, conectar el motor
  Rust, línea de tiempo con zoom, secciones (Biblioteca, Hitsounds, Audio…), herramientas
  de mapa, precisión en canciones reales e instalador `.msi`.

Uso: doble clic en `Overtone.bat`, abrí un audio, **Analizar**, revisá el mapa de tempo,
escuchá la pista de clic y usá **Inyectar .osu…**. La octava (92 vs 184) sigue siendo
criterio tuyo: **×2 / ÷2** la corrige al instante.

---

## License

MIT, as declared in `Cargo.toml`. A `LICENSE` file has not been added to the repository
yet.
