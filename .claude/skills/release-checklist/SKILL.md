---
name: release-checklist
description: The checks to run and what a pull request must say before Overtone work is merged, and before a release is tagged on master. Use when finishing a branch, opening a PR with gh, preparing a release, or when asked which gates apply to a change. Covers where the engine's gates run, the commit and PR rules, and the docs a change must update.
---

# Release checklist

The rules live in `CLAUDE.md` (identical to `AGENTS.md`) and `docs/workflow.md`; this is
them in the order you use them. When they disagree with this file, they win: fix this file.

## Branches

- Work on a branch named `type/short-topic` (`feature/`, `fix/`, `perf/`, `test/`,
  `docs/`, `chore/`, `refactor/`, `bench/`), cut from `origin/master`, the only
  long-lived branch (owner's decision, 2026-10-27). Never commit in-progress work on
  `master`.
- Features reach `master` through a PR. A release is a version tag on `master`
  (`docs/release.md`).
- Merge `origin/master` into your branch before you finish, and run the checks again
  after the merge.

## Checks

**Site and bot**: they are their own repositories since 2026-11-07
(Mides-Games/overtone-site, Mides-Games/overtone-bot), each with its checks in its
CLAUDE.md. A change here that the site reads (the worker's result format,
`docs/timeline.md`, `assets/logo-web.svg`, a file "how it works" cites) runs the
site's `pnpm --dir site/web test` with this checkout beside it.

**Engine** (`python/`, `crates/`, `worker/`, `bench/`): the owner's rule is that the
Python suite, the benchmark and the gates are not run on this machine. They run on the
owner's server:

```
python bench/remote.py suite --wait     # the Python suite
python bench/remote.py gates --wait     # every Python gate
```

Rust's `cargo test` and the `overtone-bench` modes are listed in CLAUDE.md. The accuracy
baseline (24/24 within 0.05 BPM and 5 ms) does not move without a reason written in
`docs/timeline.md`; a gate is never re-baselined to turn it green.

**Docs counts:** `bench/facts.py` holds the test counts stated in CLAUDE.md to the source.
Update the counts in CLAUDE.md and AGENTS.md together (they must stay byte-identical).

**Security:** a change to the worker or the deploy gets a security review on its diff,
following Mides-Games/overtone-site's `.claude/skills/security-review` skill and its
`docs/security-review.md`: their worker/ and deploy/ parts apply to this repository. A
release gets it on the whole diff since the last release tag.

## Commits

- English, `type(scope/task): lowercase imperative description`, one line, no period,
  e.g. `fix(engine/octave): prefer the mapped pulse on ties`.
- One logical change per commit: a DSP change and a UI change are two commits.
- The body says **why**, not what. A `perf` or accuracy claim names its measurement; a
  gate change names the gates run and their result.
- No `Co-Authored-By`, no AI attribution, no tool signature. The repository owner is the
  author.

## Docs a change updates

- `docs/timeline.md`: one entry at the top, `## Unreleased — <date> · <title>`, with
  Changed / Fixed / Hardening / Measured as they apply, and `Rejected / tried and
  dropped` when an approach was abandoned. "Not measured" is a valid line.
- `docs/07-roadmap.md`: the engine's roadmap rows the change finishes or advances.

## The pull request

Opened with `gh pr create`. `.github/pull_request_template.md` has the shape; the
description answers three things:

1. **What changed** and **why**, in one or two sentences each (the diff says how).
2. **Checks run**, each command with its numbers pasted (`109/109`, `72 passed`,
   `initial 148.8 kB`), never "all green". Say which checks did not apply and why
   (engine untouched: no gates), and what was not verified (a real phone, Safari, a real
   PostgreSQL, a real Mides sign-in).
3. **The checklist**, ticked: one logical change per commit; checks green with numbers;
   `bench/facts.py` clean; timeline entry; roadmap updated.

Do not merge your own feature PR unless the owner said so; a release names the
security review it had.
