# Project instructions

Repository conventions for any AI agent or contributor working here.
`AGENTS.md` is a symlink-equivalent of this file — keep the two identical.

## Commits, branches and pull requests

Commits, branch names and PR titles are in **English**. Code, comments and
commit messages are English; only the app's own UI strings stay bilingual
(EN/ES).

- **Do not add `Co-Authored-By` trailers.** No AI attribution lines, no
  `Generated with …` footers, no tool signatures in commit messages or PR descriptions.
  Commits are authored by the repository owner.
- Commit subject: `type(scope/task): short imperative description`, e.g.
  `fix(engine/octave): prefer the mapped pulse on ties`,
  `feature(app/export): add gain option to the click track`.
  Types: `feature` (new capability), `fix` (bug fix), `refactor` (same
  behaviour, clearer structure), `perf` (faster — with numbers), `bench`
  (benchmark, gates or golden vectors), `test` (tests only), `docs`
  (documentation only), `chore` (layout, dependencies, tooling).
  Scope is the area (`engine`, `app`, `bench`, `rust`, `hitsound`, `docs`,
  `repo`) plus the task after a slash. Description in lowercase, imperative,
  no trailing period, one line.
- Body explains **why**, not what. The diff already says what. A `perf` or
  accuracy claim names its measurement; a gate change names the gates run
  and their result.
- One logical change per commit. A DSP change and a UI change are two commits.
- Never commit on the default branch when the change is in progress; branch first.
  Branch names share the subject's shape without the description:
  `type/short-topic`, e.g. `chore/repo-layout`, `fix/octave-hint`.
- PRs go through `gh`. The description answers three things: what changed,
  why, and which gates were run with what result. The checklist and the
  definition of done live in `docs/workflow.md`.

## CI

- **Do not create GitHub Actions workflows.** No `.github/workflows/`, no CI YAML, no
  bots, no automated release pipelines. Checks run locally.
- The gates that would otherwise live in CI are run with local commands, and every one of
  them must be runnable in a single line (see **Verification** below). If a check cannot be
  run locally by a person, it does not exist.

## Verification — run these before any commit that touches the engine

```bash
.venv/Scripts/python.exe -m unittest discover -s tests   # test_overtone_web # all pass (803 on 2026-09-30)
.venv/Scripts/python.exe bench/benchmark.py                    # must be 24/24
.venv/Scripts/python.exe bench/gates.py bpm-snapshot           # 24/24 readings unchanged
.venv/Scripts/python.exe bench/golden.py check                 # 27/27 stage for stage
.venv/Scripts/python.exe bench/gates.py coverage               # density signal present
.venv/Scripts/python.exe bench/gates.py measures               # bars read and anchored
.venv/Scripts/python.exe bench/gates.py signatures             # signature regions, one bar
.venv/Scripts/python.exe bench/gates.py robustness             # edge cases end cleanly
.venv/Scripts/python.exe bench/gates.py reference              # maps graded as timed
.venv/Scripts/python.exe bench/gates.py assisted               # marked downbeats fit
.venv/Scripts/python.exe bench/gates.py real-audio             # 6 local songs analyse as pinned
.venv/Scripts/python.exe bench/gates.py perf                   # every stage inside its time budget
.venv/Scripts/python.exe bench/fixtures.py                     # the fixture manifest matches the code
.venv/Scripts/python.exe bench/parity.py                       # 384 of 535 v3 engine tests held in Rust
.venv/Scripts/python.exe bench/fit_kits.py --verify             # every genre kit renders what it says
.venv/Scripts/python.exe bench/facts.py                        # stated counts and schema match the source
.venv/Scripts/python.exe bench/fuzz_reader.py                  # 3000 mutant .osu files read, written back, consumed
```

Every gate after the benchmark checks something the benchmark cannot see. `bpm-snapshot` pins the
**octave** — the benchmark normalizes it away, so a change there could halve every BPM
and all 24 rows would stay green. `golden.py check` compares **stage by stage**, so a
divergence names its own stage instead of surfacing as a mystery at the output. When a
reading changes on purpose, say why in `docs/timeline.md` and re-run with `--update` / `dump`;
never re-baseline to make a red gate green.

Phase 10 work is also measured on **Corpus B**: 20 hand-timed ranked maps from the local
osu! Songs folder, named by folder, file and SHA-1 in `bench/corpus_b.json` and never
committed. It is a measurement, not a gate: a track whose files changed is skipped and
named, and the analyses are cached per audio and engine hash, so a re-score takes a second.

```bash
.venv/Scripts/python.exe bench/corpus_b.py                     # ranked red lines within 5 ms
.venv/Scripts/python.exe bench/corpus_b.py --engine rust       # the same through overtone-cli
.venv/Scripts/python.exe bench/corpus_b.py --onsets            # and where each track's sound starts
```

And the Rust side:

```bash
cargo test --workspace                                 # all pass (290 on 2026-10-03)
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
about 5.6 s (2026-09-28, 27 vectors: 1.25 s decode, 2.65 s attacks, 1.71 s
tempo, down from 7.96 s before that day's growth-window and envelope work)
against about 18.5 s for Python's `analyze_audio` (2026-09-23, 24 vectors, not
re-measured since). This machine's timings vary by up to a third between runs,
so a comparison is only worth making between numbers taken minutes apart on the
same build -- which is how those two Rust figures were taken.

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
   commit.** The repo has a benchmark; use it. `docs/timeline.md` records numbers, including
   "not measured" when that is the truth.
2. **Do not invent precision.** Report confidence, state uncertainty, and refuse rather
   than guess. White noise must not return a BPM.
3. **Keep `docs/timeline.md` current.** One entry per release, with the same sections:
   Changed / Fixed / Hardening / Measured, plus `Rejected / tried and dropped` whenever an
   approach was abandoned — the reasoning is the expensive part.
4. **The v3 Python engine stays runnable** in `python/` for as long as the
   comparison is meaningful. It is the only way "equal or better" can be audited.
   A copy in `reference/python-v3` stays deferred (2026-09-24, see the roadmap's
   Phase 0): it would keep changing while v3 is the app's default engine.
5. **`.osu` writes are atomic, backed up, and never overwrite an existing `.bak`.**
   A field the user did not ask to change comes out byte-identical, CRLF included.
6. Offline only. No network calls, no telemetry, no update checks, no external APIs.
7. No `unsafe` in Rust without a benchmark in the same commit showing it was necessary.
8. Precision-critical code is not edited without running the suite. If the suite cannot be
   run, the change does not land.

## Layout

The root holds almost nothing on purpose: `README.md`, the launcher
(`Overtone.bat`), the workspace (`Cargo.toml`, `Cargo.lock`), the agent
rules (`AGENTS.md`, `CLAUDE.md` — identical) and the Git plumbing
(`.gitignore`, `.gitattributes`). Everything else lives in a folder:

```
python/                   v3 engine, osu! I/O, classic Tk GUI + CLI (the app's default)
  overtone.py               engine, classic window and command line
  overtone_web.py           web shell host: pywebview window + JSON bridge to the engine
  overtone_rust.py          the v4 engine through overtone-cli, as v3's Analysis (opt-in)
  overtone_library.py       the library index: a Songs folder in SQLite, searched (FTS5)
  library.sql               the index's schema, versioned; facts.py checks the version
  requirements.txt          lower bounds; requirements.lock pins the measured baseline
tests/                    Python suite (run from the root with unittest discover)
  test_overtone.py          engine, I/O and classic-window tests
  test_overtone_web.py      web bridge tests (never touch the real config)
  fixtures/                 hand-timed samples the tests read
app/                      web shell frontend (HTML/CSS/JS, no network)
Overtone.bat              double-click launcher
installer/                the MSI and portable ZIP: PyInstaller spec, WiX source, the
                          one-line build (installer/build.py) and its smoke test
profiles/                 hitsound profiles as JSON
assets/                   generated logo (assets/logo.py), window icon and Overtone's own
                          hitsound samples (assets/samples.py)
bench/benchmark.py        synthetic accuracy harness, exact ground truth
bench/gates.py            octave snapshot, density-change and measure gates
                          (the things the accuracy benchmark cannot see)
bench/golden.py           per-stage golden vectors; the harness Rust gets pointed at
bench/fixtures.py         the one list of bench fixtures, derived from the definitions;
bench/fixtures.json       what it writes, and what the Rust bench reads for its cases
bench/parity.py           where each v3 engine guarantee lives: held in Rust,
bench/parity.json         or outside its surface, with the reason and the tests
bench/facts.py            the counts and lists the docs state, checked against the source,
                          and library.sql's schema version against the code's
bench/golden/             27 committed vector files: the 24-case corpus plus the
                          proven-bar and signature fixtures from bench/gates.py
bench/bpm_snapshot.json   pinned absolute BPM per fixture
bench/templates_on_real_audio.py  whether the instrument templates hear real drums,
                          at the places mappers put claps
bench/genre_samples.py    what a genre's hitsounds sound like, from the files its
bench/genre_samples.json  maps ship; bench/fit_kits.py aims the synthesiser at it
assets/kits.json          and writes the settings a genre's kit is rendered from
bench/genre_corpus.py     where each genre puts its hitsounds, measured from the
bench/genre_corpus.json   user's Songs folder; writes profiles/<genre>.json
bench/corpus_b.py         Corpus B: the engine against 20 hand-timed ranked maps (Phase 10)
bench/corpus_b.json       its manifest: Songs folders, files and SHA-1s, never the audio
proto/                    Python prototypes of the riskiest v4 algorithms, and
                          band_lanes.py, which prints the band flux as
                          `overtone-bench bands` does so the two can be diffed,
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
                          other languages, hitsound plan, workflow, timeline
  workflow.md               the per-task routine: program, test, measure, commit, audit
  timeline.md               engineering log
```

## Environment notes

- Python reference runs in `.venv` (Python 3.14; numpy 2.5.3, scipy 1.18.1, librosa 1.0.0,
  numba 0.67.0). `python/requirements.txt` has lower bounds only — pin a `python/requirements.lock`
  before trusting a benchmark comparison across machines. The suite runs from the
  repository root (`python -m unittest discover -s tests`); `bench/` and `tests/`
  put `python/` on `sys.path`, so the engine is imported, never copied.
- Rust: rustup 1.29 / rustc 1.98.1 on `x86_64-pc-windows-msvc`, with Visual Studio
  Build Tools 2022 17.14 supplying the linker. `Cargo.lock` is committed.
- The local folder is `Overtone-master`, matching the `<Name>-master` convention used by
  the other projects here; the GitHub repository is `githaltwastaken/Overtone`. Nothing in
  the build depends on either name — the bench resolves the repository root at runtime by
  walking up for `Cargo.toml` and `bench/golden/`, precisely so a rename cannot break it.
