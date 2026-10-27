# Contributing to Overtone

Thanks for helping. Overtone's whole value is that its numbers are true, so the
rules below are mostly about measurement: a change that cannot show it keeps the
accuracy baseline does not land, however good the reasoning sounds.

The full rules are in [`CLAUDE.md`](CLAUDE.md) (identical to `AGENTS.md`, which
AI agents read); the per-task routine is in [`docs/workflow.md`](docs/workflow.md).
This page is the short version.

## Branches

| Branch | Role |
|---|---|
| `master` | production: what releases are built from; always green |
| `experimental` | staging: features land here first and are tried together |
| `feat/<topic>`, `fix/<topic>`, … | one piece of work, branched from `experimental` (or `master` for a hotfix) |

Never commit work in progress on `master` or `experimental`; branch first. A
branch is named like its commits' subject without the description:
`feat/click-gain`, `fix/octave-hint`, `chore/repo-layout`.

## Commits

```
type(scope/task): short imperative description
```

- English, lowercase, imperative, one line, no trailing period:
  `fix(engine/octave): prefer the mapped pulse on ties`.
- Types: `feature`/`feat` (new capability), `fix`, `refactor` (same behaviour),
  `perf` (faster, with numbers), `bench` (benchmark, gates, golden vectors),
  `test`, `docs`, `chore` (layout, dependencies, tooling).
- Scope is the area (`engine`, `site`, `app`, `bench`, `rust`, `docs`, `repo`) plus the
  task after a slash.
- The body says **why**; the diff already says what. A `perf` or accuracy claim
  names its measurement; a gate change names the gates run and their result.
- One logical change per commit: a DSP change and a UI change are two commits.
- No AI attribution trailers or generated-by footers.

## Gates

There is no CI on purpose: every check is a local one-liner, and a check nobody
can run locally does not exist. Before any commit that touches the engine, run
the Python suite and the gates listed in `CLAUDE.md` under **Verification**; the
core of it:

```bash
.venv/Scripts/python.exe -m unittest discover -s tests   # all pass
.venv/Scripts/python.exe bench/benchmark.py              # must be 24/24
.venv/Scripts/python.exe bench/gates.py bpm-snapshot     # 24/24 readings unchanged
.venv/Scripts/python.exe bench/golden.py check           # 27/27 stage for stage
.venv/Scripts/python.exe bench/facts.py                  # stated counts match the source
cargo test --workspace                                   # all pass
cargo run --release -q -p overtone-bench -- golden       # 27/27 attack for attack
```

**The accuracy baseline is not negotiable:** 24/24 synthetic sections within
0.05 BPM and 5 ms, median 0.0000 BPM and 0.16 ms. When a reading changes on
purpose, say why in `docs/timeline.md` and re-baseline with `--update`; never
re-baseline to turn a red gate green.

Some measurements read a private osu! library (Corpus B, the genre corpus, the
real-audio gate). Their data lives in gitignored `bench/*.local.json` files and
`bench/*.example.json` shows each shape; without them those scripts say what is
missing and skip. See [`bench/local_data.py`](bench/local_data.py).

## Engineering rules, in brief

- No performance or accuracy claim without a measurement in the same commit.
- Do not invent precision: report confidence, refuse rather than guess (white
  noise must not return a BPM).
- `.osu` writes are atomic and backed up, and never overwrite an existing
  `.bak`; any field the user did not ask to change comes out byte-identical.
- Offline only: no network calls, telemetry, update checks or external APIs.
- No `unsafe` Rust without a benchmark in the same commit showing it was needed.
- Keep `docs/timeline.md` current, including what was tried and dropped.
- No GitHub Actions workflows, bots or automated release pipelines.

## Pull requests

Open them with `gh` against `experimental` (or `master` for a hotfix). The
template asks three things: what changed, why, and which gates were run with
what result. Paste the gate output; numbers, not impressions.

## Reporting bugs

Use the issue templates: a bug report wants the engine (Python v3 or Rust v4),
the version or commit and the audio's length and format; a timing-accuracy
report wants the map you compared against. Security problems go through
[`SECURITY.md`](SECURITY.md), never a public issue.
