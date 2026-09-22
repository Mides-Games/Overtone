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
.venv/Scripts/python.exe -m unittest test_timing_analyzer      # must be 56/56
.venv/Scripts/python.exe bench/benchmark.py                    # must be 24/24
.venv/Scripts/python.exe bench/gates.py bpm-snapshot           # 24/24 readings unchanged
.venv/Scripts/python.exe bench/golden.py check                 # 24/24 stage for stage
.venv/Scripts/python.exe bench/gates.py coverage               # density signal present
```

The last three exist because the benchmark cannot see them. `bpm-snapshot` pins the
**octave** — the benchmark normalizes it away, so a change there could halve every BPM
and all 24 rows would stay green. `golden.py check` compares **stage by stage**, so a
divergence names its own stage instead of surfacing as a mystery at the output. When a
reading changes on purpose, say why in `timeline.md` and re-run with `--update` / `dump`;
never re-baseline to make a red gate green.

Once the Rust workspace exists, add:

```bash
cargo test --workspace
cargo run -p ota-bench --release -- --accuracy    # must match the v3 baseline
cargo run -p ota-bench --release -- --golden      # per-stage diff vs v3
```

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
4. **The v3 Python engine stays runnable** in `reference/python-v3` for as long as the
   comparison is meaningful. It is the only way "equal or better" can be audited.
5. **`.osu` writes are atomic, backed up, and never overwrite an existing `.bak`.**
   A field the user did not ask to change comes out byte-identical, CRLF included.
6. Offline only. No network calls, no telemetry, no update checks, no external APIs.
7. No `unsafe` in Rust without a benchmark in the same commit showing it was necessary.
8. Precision-critical code is not edited without running the suite. If the suite cannot be
   run, the change does not land.

## Layout

```
timing_analyzer.py        v3 engine + Tk GUI + CLI  (to move to reference/python-v3)
test_timing_analyzer.py   56 unit tests
bench/benchmark.py        synthetic accuracy harness, exact ground truth
bench/gates.py            octave snapshot + density-change gates (benchmark blind spots)
bench/golden.py           per-stage golden vectors; the harness Rust gets pointed at
bench/golden/             24 committed vector files, 362 KB
bench/bpm_snapshot.json   pinned absolute BPM per fixture
requirements.lock         exact versions behind the measured baseline
docs/                     audit, stack evaluation, architecture, UI, DSP, hitsounds,
                          roadmap, ML evaluation, naming
timeline.md               engineering log
```

## Environment notes

- Python reference runs in `.venv` (Python 3.14; numpy 2.5.3, scipy 1.18.1, librosa 1.0.0,
  numba 0.67.0). `requirements.txt` has lower bounds only — pin a `requirements.lock`
  before trusting a benchmark comparison across machines.
- The Rust toolchain is **not yet installed**; Phase 0 of the roadmap covers it
  (MSVC Build Tools, then rustup with the `x86_64-pc-windows-msvc` target).
