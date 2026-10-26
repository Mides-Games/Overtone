# Audit — Overtone v3.0 (Python)

Read of the shipped code at commit `146d299`, before any rewrite work. The point of
this document is to establish (a) what the baseline actually is, so "equal or better"
becomes a testable claim, and (b) which of the rewrite's goals are motivated by real
defects rather than by a wish to use a different language.

Everything here was read from source. Where a claim could not be executed on this
machine it says so.

---

## 1. Inventory

| File | Lines | Role |
|---|---:|---|
| `timing_analyzer.py` | 3258 | **Everything**: DSP, tempo engine, `.osu` I/O, config, CLI, Tk GUI |
| `test_timing_analyzer.py` | 711 | 55 unit tests across 10 classes |
| `bench/benchmark.py` | ~430 | Synthetic accuracy harness, 24 cases + 4 degenerate |
| `README.md` | 129 | User + algorithm documentation |
| `timeline.md` | 250 | Engineering log, incl. rejected approaches |
| `requirements.txt` | 5 | numpy, scipy, librosa, soundfile, soxr |
| `STK_timing_points.osu.txt` | 7 | One sample fixture |

**6 commits.** MIT licensed.

### What the single module contains

```
 lines    1– 112   header docstring, imports, constants, TimingPoint/Analysis
 lines  113– 145   onset envelope (librosa first, STFT flux fallback)
 lines  146– 605   v2 legacy engine: hybrid beat tracking, segmentation, subdivision,
                   meter guess, stability  (≈460 lines, kept as fallback)
 lines  606–1527   v3 precision engine: attacks, coherence, IRLS, octave, sections
                   (≈920 lines — the valuable part of the project)
 lines 1528–1799   audio loading, analysis assembly, public `analyze_audio`
 lines 1800–1939   exports: CSV, click track, snapping, .osu text, summary
 lines 1940–2057   manual timing-point editing primitives
 lines 2058–2192   .osu injection (atomic, backup-preserving, CRLF-safe)
 lines 2193–2224   config load/save
 lines 2225–3197   Tk GUI  (≈970 lines, one class, bilingual string table)
 lines 3198–3258   CLI entry point
```

---

## 2. What is genuinely good and must survive the rewrite

These are not "nice to have". They are the reasons the tool is accurate, and several
of them are non-obvious enough that re-deriving them would cost more than porting them.

1. **The model itself.** `t(k) = offset + k·period`, fitted by iteratively re-weighted
   least squares over hundreds of attacks. The √N averaging of onset jitter is where
   all of the accuracy comes from. Nothing about this is language-dependent — which is
   precisely why the rewrite must port the *math*, not re-invent it.

2. **Sample-resolution attack re-timing** (`_retime_onsets`, l.693). A spectral-flux
   peak lags the physical attack by ~one analysis window. v2 shipped that ~8 ms bias.
   The fix — walk the local 1.5 ms RMS energy back to its 20 % rise point on the raw
   waveform — is the difference between 8.37 ms and 0.16 ms of median offset error.
   Subtle detail worth preserving: it *keeps the envelope time* when the rise is not
   at least 1.6× the local floor, rather than snapping to noise.

3. **The coherence phase sign.** `z = Σ w·e^{2πi f t}` ⇒ `φ = arg(z)/(2πf)`, not
   `−arg(z)`. The timeline records this as the single largest error source in the first
   working engine: every seed grid started half a beat off, and IRLS cannot recover a
   slipped beat index. There is a regression test for it. **Port the test first.**

4. **`share × coverage` candidate ranking** (`_seed_grid`, l.1078). A grid twice too
   slow explains half the attack energy; a grid twice too fast fills half its own slots.
   Only the true atomic pulse scores on both. The timeline documents that the obvious
   alternatives — "slowest strong coherence peak", and a fixed `share ≥ 0.72` gate —
   were tried and fail on uniform click tracks and on ornamented music respectively.

5. **Mode-seeking phase re-centring** (`_recentre_phase`, l.867). Least squares balances
   everything inside its tolerance window, so swung off-beats and ghost notes drag the
   offset toward them (17 ms measured on the shuffle fixture). Scoring candidate shifts
   with a narrow Gaussian and taking the **mode** rather than the mean fixed it to
   0.09 ms. This is the kind of thing a rewrite silently loses.

6. **Boundaries at the grid *crossing*, not at a cost minimum** (`_tune_boundary`,
   l.1265). At a real tempo change both grids fit equally well, so a residual cost is
   *flat* there (measured: 0.9 % difference between correct and one-beat-early). What is
   sharp is that the two grids share a beat at the change and diverge linearly away
   from it. Genuinely clever; documented in the timeline as a rejected alternative.

7. **Per-section re-seeding** (`_grow_sections`, l.1131). Each new region runs its own
   coherence scan instead of inheriting a period that just failed. Without this a
   128 → 142 BPM change gets averaged into one wrong section.

8. **Octave from accent depth, not from a multiplier.** Attacks grouped by index mod *m*;
   if *m* atoms really make a beat, one class holds the kicks and another the filler, so
   the spread between strongest and weakest class is large. Plus tempogram hints under a
   log-normal prior. Evidence-based — and the project is honest that the octave remains a
   human call.

9. **Safety engineering around the `.osu` write path.** Atomic temp-file + rename;
   an existing `.bak` is never overwritten; legacy two-field red lines recognised;
   negative beat length overrides a contradictory `uninherited` flag; CRLF preserved by
   writing bytes rather than text. This is better than most beatmap tooling and the
   rewrite must match it line for line.

10. **A benchmark with exact ground truth, scoring every section**, plus four degenerate
    inputs, seeded per track so a subset run reproduces a full one. And the old engine is
    kept runnable so the comparison means something. This is the single most valuable
    asset in the repo for a rewrite: it is the acceptance test.

11. **The timeline's `Rejected / tried and dropped` section.** Four approaches with the
    measurements that killed them. Keep this file and keep the discipline.

---

## 3. Findings

Severity: **S1** breaks or silently degrades results · **S2** real defect, bounded impact ·
**S3** maintainability / correctness hazard · **S4** cosmetic.

### F-01 · S3 (latent S1) · Parameter shadowed by an index array

`_atomic_grid_candidates`, `timing_analyzer.py:779`:

```python
def _atomic_grid_candidates(times, weights, period_range=(0.055, 1.35), keep: int = 10):
    ...
    if times.size > MAX_SCAN_ONSETS:        # 5000
        keep = np.sort(np.argsort(weights)[-MAX_SCAN_ONSETS:])   # ← rebinds `keep`
        times, weights = times[keep], weights[keep]
    ...
    strong = strong[np.argsort(freqs[strong])][:keep]            # ← now a 5000-element array
```

`keep` is the parameter meaning "how many candidates to return". The dense-audio guard
reuses the same name for a 5000-element index array. `ndarray[:ndarray]` calls
`__index__` on the bound, which raises `TypeError: only integer scalar arrays can be
converted to a scalar index`. Inside `analyze_audio` that is caught by the broad
`except Exception` and degrades to the **v2 legacy engine** — i.e. back to ~0.2 BPM /
~8 ms error, with only a message to say so.

**Why it does not fire today.** Every call site reaches this function through
`_seed_grid`, whose windows are at most 30 s wide (`widths=(30.0, 16.0, 9.0)`), and
`_pick_onsets` enforces a 25 ms minimum peak distance — a ceiling of 40 attacks/s, so
≤ 1200 attacks in 30 s. The 5000 threshold is unreachable. The identical guard in
`_recentre_phase:883` *is* reachable (it runs on whole sections) and is correct there
because `keep` is a local.

So: not a live bug, a landmine — and the code's own comment at `MAX_SCAN_FREQS` says
"only reachable if someone widens the seed windows", which is exactly what the v4 design
wants to do (full-track coherence sweep). **Fixed in this audit** by renaming the local.

### F-02 · S3 · `window_of` defined twice, identically

`_tune_boundary`, `timing_analyzer.py:1287–1297`: an eight-line block — comment and
nested `def` — appears twice in a row. The second binding wins, so behaviour is correct
and unchanged; it is copy-paste residue. Harmless, but it is the kind of thing that
makes a reader doubt the rest of the function. **Fixed in this audit.**

### F-03 · S2 · Click track accents every 4 beats regardless of detected meter

`export_click_track`, `timing_analyzer.py:1811`:

```python
place(t, accent=(k % 4 == 0))
```

`_meter_from_grid` can return `3/4`, and `osu_timing_text` *does* write the detected
meter into the `.osu` line. The click track — which the README correctly calls "the
arbiter" for verifying a timing map by ear — ignores it and accents in 4 on a 3/4 track.
A mapper checking a waltz hears the accent walk against the music and may conclude the
timing is wrong when it is not.

Not fixed here: it is a behaviour change to an audio export with no test covering the
accent pattern. Proposed patch, to land with a test:

```python
meter = max(1, min(16, int(str(getattr(analysis, "meter", "4/4")).split("/")[0])))
...
place(t, accent=(k % meter == 0))
```

### F-04 · S3 · One 3258-line module

DSP, the two engines, `.osu` parsing, filesystem writes, config, CLI and a 970-line Tk
GUI share one namespace. Consequences that are already visible:

- `test_timing_analyzer.py` imports the module that owns the GUI. Only the lazy `import
  tkinter` *inside* methods (l.2343, 2449, 2742) keeps the suite headless — an accident
  of style, not a boundary.
- The precision engine cannot be reused, benchmarked or fuzzed without dragging in the
  whole application.
- The GUI reaches directly into engine internals (`_synth_beats`, `analysis.sections`),
  so any engine change is a potential GUI change.

This is the strongest structural argument for the rewrite, independent of language.

### F-05 · S4 · Dependencies are unpinned above, and a major version drifted in

`requirements.txt` specifies only lower bounds (`librosa>=0.10.2`). A fresh install on
this machine resolved to **librosa 1.0.0** — a major version past what the project was
developed and measured against — plus numba 0.67, numpy 2.5.3, scipy 1.18.1.

The good news, and it is worth stating because it was the opposite of what I expected:
**all 55 tests pass and the engine works on that stack** (see [§5](#5-reproduction-status)).
So this is a reproducibility finding, not a breakage: nothing records which dependency
set produced the published benchmark numbers, and a future resolve could change
`librosa.onset.onset_strength` or `librosa.feature.tempogram` behaviour — both of which
feed the accuracy-critical path — without any signal.

Mitigation for as long as the Python reference implementation lives in the repo: commit a
`requirements.lock` with exact versions, and record the resolved versions alongside every
benchmark run. The rewrite removes the issue differently: `Cargo.lock` is checked in by
default and the DSP stops depending on a third-party framework's internal behaviour.

Related but separate: the `librosa → numba → llvmlite → LLVM` chain is the least portable
part of the project and the hardest to turn into a self-contained `.exe`. That is a
packaging argument, unaffected by the above.

### F-06 · S2 · FFmpeg required for MP3/M4A/AAC

The README asks the user to install FFmpeg and put it on `PATH`. For a
"local desktop app, no accounts, no uploads" this is the largest install-time friction
in the product, and it is avoidable — see the stack evaluation.

### F-07 · S3 · The benchmark cannot see an octave regression

`bench/benchmark.py` scores BPM and offset **precision** and deliberately not the octave
(the module docstring explains why: the octave is a judgement call). That is a defensible
choice, but it means the tempogram-hint path — `_tempo_hints` → `_hint_score` →
`_beat_from_atoms` — is covered by **no automated check at all**. A rewrite that replaces
librosa's tempogram, as the v4 DSP design proposes, could halve or double every track's
reported BPM and every number in the benchmark table would stay green.

**Required before any tempogram replacement:** an octave-agreement test that pins
`atoms_per_beat` and the final global BPM per fixture against v3's current output.

### F-08 · S3 · Silent-ish fallback is reported through a progress *string*

`analyze_audio` catches any engine exception and continues with the legacy tracker,
appending `f" ({type(exc).__name__}: {exc})"` to a progress message. v3 was right to stop
making this fully silent — the timeline records that it immediately caught a live
regression. But the failure is not in the returned `Analysis`: a CLI or library consumer
sees only `engine == "legacy"` and cannot distinguish "this audio has no grid" (expected)
from "the precision engine crashed" (a bug). The rewrite should carry a structured
diagnostic on the result.

### F-11 · S2 · A density change inside a section cannot be detected at all

Reproducing the benchmark surfaced one case that is not green and is not in the
README's `Honest limits`:

```
case                 bpm_err offset_ms  sec/exp    time  note
change-175-87.5       0.0016      0.70    1/2       0.8  x2
```

`sec/exp = 1/2`: the fixture changes 175 → 87.5 BPM and **one** section is reported,
at 174.9984 BPM, while every other multi-section fixture finds all of them.

**The mechanism, measured rather than assumed.** My first reading of this blamed the
global octave decision. That is wrong, and the correction matters because it points at a
different fix. Instrumenting the engine on the fixture:

```
ATOMIC grid on 175 region  : share=1.000 coverage=1.000 rms=1.27 ms
ATOMIC grid on 87.5 region : share=1.000 coverage=0.633 rms=2.18 ms

growth gate: break when share < 0.55 or rms > 0.09*atom*1000 = 15.43 ms
```

87.5 is exactly half of 175, so the grid is *continuous*: every attack in the slow half
still lands on the fast half's grid. `share` — the fraction of attack energy the grid
explains — therefore stays at **1.000**, nowhere near the 0.55 break, and the RMS stays at
2.18 ms against a 15.43 ms threshold. So `_grow_sections` extends straight through the
change, correctly by its own rules.

What *does* change is **coverage**, the fraction of grid slots carrying an attack:
1.000 → 0.633. And `_grow_sections` computes it and throws it away:

```python
share, _cov, rms = _grid_quality(times[chunk], weights[chunk],
                                 local_period, local_phase, tol_ratio=0.11)
if share < 0.55 or rms > 0.09 * local_period * 1000.0:
    break
```

The statistic `_seed_grid` uses to *rank* candidates — `share × coverage`, the insight the
timeline is proudest of — is discarded by the loop that decides whether a section
continues. That is the defect: not a wrong answer, a signal computed and dropped.

**Whether it should split is a separate, genuinely open question.** The README's stated
policy is to keep the BPM through a half-time section ("map the feel, not a new red
line"), and mapping this track at 175 throughout is defensible — the 87.5 beats all fall
on 175 beats, so only bar lines and snap semantics differ. But the benchmark's ground
truth asserts two sections. **The repository contradicts itself here and nothing resolves
it.** The accent data shows the pulse genuinely halved, not merely the feel — in the slow
half one accent class is entirely empty (`m=4` class means `[0.803, 0.000, 1.084, 0.239]`,
accent depth 1.000 against 0.803 in the fast half) — so there is bar-level evidence a
detector could use.

**Third part of the gap:** `suggest_section_pulse`, which exists to surface exactly this
kind of octave doubt, is **one-directional**. It returns early for any point at or above
`low_bpm` (120), so it can only ever propose `×2`. A section reported at 175 that is
musically 87.5 gets no hint at all — verified, it returns `[]` on this fixture. Regression
test added: `test_pulse_hints_only_ever_suggest_doubling`.

**Gates built for this** (`bench/gates.py coverage`, three fixtures kept out of
`benchmark.CASES` so the published 24/24 stays comparable):

```
halftime-175-87.5   coverage 0.625..1.000  drop 0.359 (halves)  at 30.8s   truth 32.17s
halftime-150-75     coverage 0.533..1.000  drop 0.447 (halves)  at 29.3s   truth 28.10s
doubletime-110-220  coverage 0.529..1.000  drop 0.456 (doubles) at 26.98s  truth 26.44s
```

The signal is strong and localises the change to within one 8-beat window. Note it lives
on the **subdivided** grid: at beat level, coverage is 1.000 across the whole track,
because the slow half's attacks land on every beat. My first attempt at this gate measured
beat-level coverage, found nothing, and would have "proved" the signal absent.

So v4's job is not to decide this silently either way. It is to **detect it and surface it
with confidence**, the same way the global octave is surfaced — see
[`05-dsp-pipeline.md`](05-dsp-pipeline.md) §B.2.

### F-09 · S4 · `.gitignore` ignores `*.osu` and `*.csv` repo-wide

Which is why the one sample fixture is committed as `STK_timing_points.osu.txt`. Test
fixtures for the `.osu` parser and the hitsound engine will be `.osu` files; the ignore
rule needs to become path-scoped (`/*.osu`, `/exports/`) before that work starts.

### F-10 · S4 · Two i18n mechanisms, neither reusable

A `TEXT` dict on the GUI class plus `_localize_engine_message`, which pattern-matches
English engine strings to translate them. Engine progress messages are English literals
produced deep in the DSP. The rewrite should emit **structured progress events**
(stage id + payload) and localise at the presentation layer.

---

## 4. Test and benchmark assessment

**55 tests is good coverage for a 3.2k-line project**, and the choice of *what* to test is
better than the count suggests: the coherence phase sign, least-squares-beats-differencing
as an explicit comparison, mode-seeking against ghost notes, boundary placement at the
crossing, attack re-timing removing detector latency. Those are tests of the *ideas*, not
of the code shape, which means they survive a rewrite.

Gaps, all of which the rewrite must close:

| Gap | Why it matters |
|---|---|
| No `.osu` **parser** tests (only injection) | v4 must read hitobjects, sliders, SVs, sample sets |
| No octave-agreement test | F-07 |
| No property-based tests | Grid fitting has obvious invariants: forcing ×2 then ÷2 is the identity; a synthetic exact grid must be recovered to float precision; boundaries must be monotone |
| Benchmark is entirely synthetic | The timeline already admits this and calls the fix "expensive, and worth it". Still true |
| No performance regression gate | "~0.7 s for a 60 s track" is in the README with nothing enforcing it |
| No fuzzing of the `.osu` reader | It is about to become a much larger parser |

The synthetic corpus itself is the right design and should be **ported wholesale**: exact
ground truth is what makes sub-millisecond claims checkable at all, and per-track seeding
makes subset runs reproducible.

---

## 5. Reproduction status — the baseline is real

Everything below was executed on this machine, in a fresh venv, as part of this audit.

**Environment:** Windows 11 26200 · Python 3.14.4 · numpy 2.5.3 · scipy 1.18.1 ·
librosa 1.0.0 · numba 0.67.0 · soundfile 0.14.0 · soxr 1.1.0.

| Check | Result |
|---|---|
| Source read in full | ✅ |
| `pip install -r requirements.txt` on Python 3.14 | ✅ resolved and built |
| `python -m unittest test_timing_analyzer` | ✅ **55/55 pass**, 14.2 s cold / 7.5 s warm |
| `python bench/benchmark.py` (24 tracks, audio rendered fresh) | ✅ **24/24 within 0.05 BPM and 5 ms** |

```
within 0.05 BPM and 5 ms: 24/24
median BPM error 0.0000   median offset error 0.16 ms
```

Which **matches the published README table exactly** — `0.0000 BPM` and `0.16 ms`. The v3
numbers are reproducible, and they are now the measured baseline for the rewrite rather
than a quoted claim.

Per-case results worth carrying forward as the acceptance target:

| | value | case |
|---|---|---|
| worst offset error | 2.26 ms | `shuffle-96` — expected; the off-beats genuinely are not on the grid |
| second worst | 0.70 ms | `change-175-87.5` — and see **F-11** |
| worst BPM error | 0.0016 BPM | `change-175-87.5` |
| all other cases | ≤ 0.45 ms | |
| slowest track | 5.0 s | `long-6min` (360 s of audio) |
| total wall time, 24 tracks | ≈ 21.6 s | single-threaded, one track at a time |

Degenerate inputs degrade honestly, as documented:

```
tempo ramp 120->160 : engine=legacy  sections=8   (the staircase the timeline predicts)
pads, no percussion : engine=legacy  global=60.09 sections=1
pure silence        : ValueError: Not enough beats detected.
white noise         : engine=legacy  bpm=127.68
```

Two observations on those. The ramp behaves exactly as the timeline says it will, which is
the honest-but-poor outcome the v4 elastic-grid design targets. White noise returning
`127.68 BPM` through the legacy tracker is the one place the tool *does* invent an answer —
it should refuse, and v4's fallback needs a no-grid verdict rather than a tracker result.

**Consequence for the rewrite:** total wall time of 21.6 s for the whole corpus means the
full accuracy gate can run on every commit. There is no excuse for an unmeasured change.

---

## 6. Fixes applied in this audit

Two, both provably behaviour-preserving without needing to run the suite:

- **F-01** — renamed the shadowing local in `_atomic_grid_candidates` to `dense`, so the
  `keep` parameter keeps its meaning.
- **F-02** — deleted the duplicated `window_of` definition in `_tune_boundary`. Python
  binds the second definition; the two are byte-identical, so removing the first is a
  no-op by language semantics.

**F-03** is left for a test-gated change. Nothing else in the engine was touched: the
precision path is the asset, the test suite cannot currently be executed here, and
editing precision-critical code you cannot test is how a 0.16 ms tool becomes an 8 ms
tool without anyone noticing.

---

## 7. What this audit implies for the rewrite

1. The v3 **algorithms** are the product. The rewrite is about the three things Python
   cannot fix: the 3258-line single namespace, the `librosa → numba` dependency chain,
   and a Tk GUI that cannot become a DAW-grade timeline.
2. Accuracy parity is not a hope, it is a **gate**: port the benchmark and the 55 tests
   *first*, add golden-vector cross-validation against v3's actual outputs, and only then
   allow DSP "improvements" — each one measured against the same corpus.
3. The v3 Python code must stay in the repository as the reference implementation for as
   long as the comparison is meaningful. It is the only way the claim "equal or better"
   can be audited by anyone else.
