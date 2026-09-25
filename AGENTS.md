# Project instructions

Repository conventions for any AI agent or contributor working here.
`AGENTS.md` is a symlink-equivalent of this file — keep the two identical.

## Commits and pull requests

- **Do not add `Co-Authored-By` trailers.** No AI attribution lines, no
  `Generated with …` footers, no tool signatures in commit messages or PR descriptions.
  Commits are authored by the repository owner.
- Commit messages: a short imperative subject, then a body explaining **why**, not what.
  The diff already says what. Match the existing style — see
  `v3.0: least-squares grid engine — exact BPM and offsets`.
- One logical change per commit. A DSP change and a UI change are two commits.
- Never commit on the default branch when the change is in progress; branch first.

## CI

- **Do not create GitHub Actions workflows.** No `.github/workflows/`, no CI YAML, no
  bots, no automated release pipelines. Checks run locally.
- The gates that would otherwise live in CI are run with local commands, and every one of
  them must be runnable in a single line (see **Verification** below). If a check cannot be
  run locally by a person, it does not exist.

## Verification — run these before any commit that touches the engine

```bash
.venv/Scripts/python.exe -m unittest test_overtone test_overtone_web   # all pass (354 on 2026-09-24)
.venv/Scripts/python.exe bench/benchmark.py                    # must be 24/24
.venv/Scripts/python.exe bench/gates.py bpm-snapshot           # 24/24 readings unchanged
.venv/Scripts/python.exe bench/golden.py check                 # 27/27 stage for stage
.venv/Scripts/python.exe bench/gates.py coverage               # density signal present
.venv/Scripts/python.exe bench/gates.py measures               # bars read and anchored
.venv/Scripts/python.exe bench/gates.py signatures             # signature regions, one bar
.venv/Scripts/python.exe bench/gates.py robustness             # edge cases end cleanly
.venv/Scripts/python.exe bench/gates.py reference              # maps graded as timed
.venv/Scripts/python.exe bench/gates.py assisted               # marked downbeats fit
.venv/Scripts/python.exe bench/facts.py                        # stated counts and schema match the source
```

Every gate after the benchmark checks something the benchmark cannot see. `bpm-snapshot` pins the
**octave** — the benchmark normalizes it away, so a change there could halve every BPM
and all 24 rows would stay green. `golden.py check` compares **stage by stage**, so a
divergence names its own stage instead of surfacing as a mystery at the output. When a
reading changes on purpose, say why in `timeline.md` and re-run with `--update` / `dump`;
never re-baseline to make a red gate green.

And the Rust side:

```bash
cargo test --workspace                                 # all pass (233 on 2026-09-24)
cargo run --release -q -p overtone-bench -- golden     # 27/27 attack for attack
cargo run --release -q -p overtone-bench -- nogrid     # noise, pads, silence refused
cargo run --release -q -p overtone-bench -- density    # 4/4 changes, 0 false positives
cargo run --release -q -p overtone-bench -- elastic    # no invented curvature
cargo run --release -q -p overtone-bench -- map        # no false changes
```

Every mode reads the golden vectors, so a new golden fixture must pass all five.
`structure <case>` and `resample` are measurements, not gates: whole-track spectral
memory (peak working set, read from outside with the one-liner in the mode's doc) and
resampling speed, which no 44.1 kHz fixture exercises.

The golden check is the gate that matters during the port: it diffs the Rust
engine against v3 **stage by stage** on the committed vectors, so a divergence
names its own stage. Current state: all 27 vectors -- including 8 red lines on a
proven bar and the measure-grid path -- match every attack within 0.0001 ms, every anchor seed within 2.6e-7 s of period, and **every octave
decision exactly** — which is the stage audit finding F-07 says nothing in v3
tests. The whole pipeline over the corpus -- decode, attacks and tempo -- takes
about 4.2 s against about 18.5 s for Python's `analyze_audio` (both measured on
2026-09-23; this machine's timings vary by up to a third between runs).

`cargo run --release -q -p overtone-bench -- candidates <case>` prints the
coherence candidates beside v3's when a seed diverges.

`cargo run --release` may spend a minute compiling the first time after an
edit; that is the build, not the engine. The bench prints its own decode,
attack and tempo timings so the two are never confused.

**The accuracy baseline is not negotiable:** 24/24 sections within 0.05 BPM and 5 ms,
median 0.0000 BPM and 0.16 ms. A change that moves those numbers is a regression until
proven otherwise on the corpus, no matter how good the reasoning sounds.

## Engineering rules

1. **Never claim a performance or accuracy improvement without a measurement in the same
   commit.** The repo has a benchmark; use it. `timeline.md` records numbers, including
   "not measured" when that is the truth.
2. **Do not invent precision.** Report confidence, state uncertainty, and refuse rather
   than guess. White noise must not return a BPM.
3. **Keep `timeline.md` current.** One entry per release, with the same sections:
   Changed / Fixed / Hardening / Measured, plus `Rejected / tried and dropped` whenever an
   approach was abandoned — the reasoning is the expensive part.
4. **The v3 Python engine stays runnable** for as long as the comparison is meaningful. It
   is the only way "equal or better" can be audited. It stays `overtone.py` at the root
   while the app runs on it; it moves to `reference/python-v3` once the Rust engine is the
   default and the osu! I/O is ported (deferred 2026-09-24, see the roadmap's Phase 0).
5. **`.osu` writes are atomic, backed up, and never overwrite an existing `.bak`.**
   A field the user did not ask to change comes out byte-identical, CRLF included.
6. Offline only. No network calls, no telemetry, no update checks, no external APIs.
7. No `unsafe` in Rust without a benchmark in the same commit showing it was necessary.
8. Precision-critical code is not edited without running the suite. If the suite cannot be
   run, the change does not land.

## Layout

```
overtone.py               v3 engine, osu! I/O, classic Tk GUI + CLI (the app's default)
overtone_web.py           web shell host: pywebview window + JSON bridge to the engine
overtone_rust.py          the v4 engine through overtone-cli, as v3's Analysis (opt-in)
overtone_library.py       the library index: a Songs folder in SQLite, searched (FTS5)
library.sql               the index's schema, versioned; facts.py checks the version
app/                      web shell frontend (HTML/CSS/JS, no network)
Overtone.bat              double-click launcher
test_overtone.py          engine, I/O and classic-window tests
test_overtone_web.py      web bridge tests (never touch the real config)
assets/                   generated logo (assets/logo.py) and window icon
fixtures/                 hand-timed samples the tests read
bench/benchmark.py        synthetic accuracy harness, exact ground truth
bench/gates.py            octave snapshot, density-change and measure gates
                          (the things the accuracy benchmark cannot see)
bench/golden.py           per-stage golden vectors; the harness Rust gets pointed at
bench/facts.py            the counts and lists the docs state, checked against the source,
                          and library.sql's schema version against the code's
bench/golden/             27 committed vector files: the 24-case corpus plus the
                          proven-bar and signature fixtures from bench/gates.py
bench/bpm_snapshot.json   pinned absolute BPM per fixture
requirements.lock         exact versions behind the measured baseline
proto/                    Python prototypes of the riskiest v4 algorithms,
                          measured against the corpus before any port
crates/                   the v4 Rust workspace
  overtone-core/            shared types, unit newtypes, diagnostics
  overtone-audio/           Symphonia decode, resample, normalise
  overtone-dsp/             mel, STFT, onset envelope, peak picking, re-timing
  overtone-tempo/           coherence sweep, IRLS grid fit, seeding, octave, sections,
                            points, density, elastic grid, 2-D coherence map
  overtone-hitsound/        per-attack features, instrument templates, musical role
  overtone-bench/           golden-vector diff against the Python engine
  overtone-cli/             `overtone-cli analyze`: the v4 engine as one command
docs/                     audit, stack evaluation, architecture, UI, DSP, hitsounds,
                          roadmap, ML evaluation, naming, precision plan, MSI
                          distribution, comfort features, audit backlog,
                          other languages, hitsound plan
WORKFLOW.md               the per-task routine: program, test, measure, commit, audit
timeline.md               engineering log
```

## Environment notes

- Python reference runs in `.venv` (Python 3.14; numpy 2.5.3, scipy 1.18.1, librosa 1.0.0,
  numba 0.67.0). `requirements.txt` has lower bounds only — pin a `requirements.lock`
  before trusting a benchmark comparison across machines.
- Rust: rustup 1.29 / rustc 1.98.1 on `x86_64-pc-windows-msvc`, with Visual Studio
  Build Tools 2022 17.14 supplying the linker. `Cargo.lock` is committed.
- The local folder is `Overtone-master`, matching the `<Name>-master` convention used by
  the other projects here; the GitHub repository is `githaltwastaken/Overtone`. Nothing in
  the build depends on either name — the bench resolves the repository root at runtime by
  walking up for `Cargo.toml` and `bench/golden/`, precisely so a rename cannot break it.
