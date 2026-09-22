# Timeline

Engineering log for Overtone: what changed, **why**, and what it measurably did.

Newest first. One entry per release. Each entry keeps the same four sections so a
future reader can skim for the one they need:

- **Changed** — what the release does differently.
- **Fixed** — bugs, with the root cause, not just the symptom.
- **Hardening** — robustness and security work.
- **Measured** — numbers, or "not measured" if there aren't any.

A `Rejected / tried and dropped` section is worth adding whenever an approach was
attempted and abandoned — the reasoning is the expensive part, and re-deriving it
later costs more than writing it down now.

---

## v3.4 — 2026-09-22 · A written plan for human-level timing accuracy

Not a code release; a plan release. A user asked what it would take to time a
song as accurately as a mapper who has already done it by hand, using only free
software and offline models, without any budget on how long analysis is allowed
to take.

The answer, worked out in [`docs/10-precision-plan.md`](docs/10-precision-plan.md),
is that **90–95 % of a ranked map's timing points within 5 ms** is a real,
reachable target with the current state of open-source tooling. It takes about
4–6 weeks and twelve sub-phases, and every one of them is measurable.

### Changed

- **`docs/10-precision-plan.md`** — 12 sub-phases with dependencies, licences,
  expected accuracy gains, and a cumulative projection from today's 4.7 %
  within 5 ms on the Vampires reference track to ~95 %. Includes an honest
  audit of what stays outside even this plan.
- **Roadmap gets Phase 10** — a summary that points into the precision plan.

### Measured

Baseline on the reference track (My Chemical Romance – Vampires Will Never Hurt
You, 236 hand-placed red lines):

```
today             median offset error 60.0 ms   within 5 ms   4.7 %
after Phase 10    projected           ~1 ms                  ~95 %
```

The projection is not a promise. Each cell of the projection column is anchored
to published benchmarks for that specific technique (madmom's F-measure gain on
GTZAN, Demucs' SDR on MUSDB, etc), so it can be checked against reality one PR
at a time.

### What was rejected

- **Anything paid.** Spotify's Audio Analysis API is more accurate than an
  open pipeline for the tracks it has, but was rejected outright: the project's
  offline-first policy holds, and Spotify's terms restrict what can be built
  on their data.
- **Anything not free-licence.** RWC Popular Music dataset is skipped
  (commercial licence), even though it would help. Essentia is kept optional
  (AGPL) rather than statically linked.
- **Copying ranked map timings without matching them first** — Phase 10.1
  fingerprints before copying, so the user is not silently given someone
  else's timing for a different song.

---

## v3.3 — 2026-09-22 · Time signatures over a constant bar

A user compared Overtone against a beatmap they had timed by hand in Tempora
and reported a large difference. Reading their timing points made the cause
obvious, and it was not what either of us expected:

```
168    6 x 200 ms    bar 1200 ms         168 -   168 =      0 =  0 x 1200
20568  3 x 400 ms    bar 1200 ms       20568 -   168 =  20400 = 17 x 1200
39768  6 x 200 ms    bar 1200 ms       39768 -   168 =  39600 = 33 x 1200
58968  3 x 400 ms    bar 1200 ms       58968 -   168 =  58800 = 49 x 1200
68568  6 x 200 ms    bar 1200 ms       68568 -   168 =  68400 = 57 x 1200
100968 4 x 300 ms    bar 1200 ms      100968 -   168 = 100800 = 84 x 1200
```

**Every red line sits an exact multiple of 1200 ms from the first, and every
bar is 1200 ms.** The song has no tempo change anywhere. 300, 150 and 200 BPM
are three ways of writing the same measure with 6, 3 and 4 beats — which is
exactly Tempora's model, read from its source:

```csharp
MpsToBpm(mps) => mps * 60 * (TimeSignature[0] * 4f / TimeSignature[1])
measurePosition = (time - point.Offset) * point.MeasuresPerSecond + point.MeasurePosition
```

Measures per second is the physical quantity; BPM is a presentation of it
through the signature. v3 grows sections on measures per second, so a song that
changes only its signature was structurally invisible to it — it reported one
tempo for the whole track.

### Changed

- **`detect_bar`** — how many of a grid's beats make one measure, from accent
  contrast, refusing when the accents prove nothing.
- **`meter_segments`** — splits a track by *how the bar is subdivided*, scoring
  each window against every plausible beats-per-bar with the same
  `share x coverage` ranking the seeder uses. A grid too fine fills half its
  own slots; one too coarse leaves attacks off it; only the written
  subdivision scores on both.
- **`points_from_meter`** — one red line per signature region, on a bar line,
  with BPM derived as Tempora derives it. Declines and leaves the ordinary
  per-section placement alone when there is no provable bar, only one
  signature, or the user forced a pulse octave.
- New gate, `bench/gates.py signatures`, built from the reference track's shape.

### Measured

On a faithful reproduction of that song, against the hand-timed truth:

```
  #        offset        truth      error  beats truth        bpm
  1         168.1        168.0      +0.1ms      6     6    300.000
  2       20568.1      20568.0      +0.1ms      3     3    150.000
  3       39768.1      39768.0      +0.1ms      6     6    300.000
  4       58968.1      58968.0      +0.1ms      3     3    150.000
  5       68568.1      68568.0      +0.1ms      6     6    300.000
  6      100968.1     100968.0      +0.1ms      4     4    200.000
```

Six of six regions, every offset within 0.1 ms of the bar line a human placed
by hand, every signature right. Before this the same audio produced **two**
sections and a single subdivision for all of it.

Accuracy untouched, which the guard is there to ensure: **24/24 within 0.05 BPM
and 5 ms, median 0.0000 BPM / 0.16 ms**, `bpm-snapshot` and the golden vectors
both unchanged. On the 24-case corpus `detect_bar` returns "no bar" on every
fixture — those tracks put a hat on every beat and vary the kick only between
1.0 and 0.8 — so the new path never fires there. 76 unit tests, up from 69.

### Rejected / tried and dropped

- **Preferring the longest bar with usable accent contrast.** A four-bar
  hypermeasure still scores 1.24 on the reference track, beating the true
  three-beat bar at 1.22 under a "longest wins" rule and giving a 4800 ms
  measure where the truth is 1200. Strongest contrast wins instead, with
  near-ties going to the shorter reading — the one a mapper writes.
- **Labelling a region from the window that reads it.** A window wide enough
  to identify a signature is too wide to locate its change: one straddling the
  switch is labelled by whichever side fills more of it, which put every
  boundary exactly one bar early. Boundaries are now settled bar by bar, and
  a single ambiguous bar does not move the line.

### Open items

- **A signature change that keeps the beat and changes the bar's length**
  (4/4 → 3/4 at the same BPM) is a different shape and is not detected. The
  `measures` gate's `downbeat-4-then-3` case records it.
- The reference track is real audio; the reproduction is synthetic. On the real
  recording the offset came out about 20 ms late with 52 % confidence — the
  engine knew it was struggling. Synthetic fixtures remain an upper bound, as
  v3.0 already says of the corpus.

---

## v3.2 — 2026-09-22 · The measure grid, and timing a song from nothing

Tempora (`teamkongehund/Tempora`) times a song by associating points of time in
the music to a timeline of **measures and measure divisions**, by hand. Overtone
already automates the hard half of that — the pairing of audio time to beat
index is exactly `t(k) = offset + k·period`, solved over hundreds of attacks
instead of two hand-placed anchors. What it did not do was measures.

### Changed

- **Per-section time signature.** `section_measures` runs the meter detector on
  each section's own attacks. v3 read the meter once, from the first section,
  and wrote that number into every red line, so a song that moves to 3/4 for a
  bridge came out wrong everywhere after the change.
- **Red lines anchor to downbeats.** v3 anchored only the *first* line to a
  downbeat; every later section took the next plain beat, so osu!'s bar lines
  drifted out of step with the music after the first tempo change. Each section
  now anchors to its own downbeat — but only when its accents prove one.
- `TimingPoint` carries `meter` and `meter_known`. The second field matters:
  a point that does not know its bar falls back to the analysis meter rather
  than to a hard-coded 4, so writing 4 over a detected 3/4 cannot happen.
- New gate, `bench/gates.py measures`.

### Fixed

- **The click track accented every fourth beat regardless of meter** (audit
  **F-03**). A waltz clicked in 4 against the music, and the click track is
  what the README calls the arbiter — a mapper checking a 3/4 song by ear could
  have concluded the timing was wrong when it was not. Now accents on the
  point's own bar.
- **`snap_timing_points` dropped the bar.** It rebuilds each point, and the new
  fields were not carried, so every section silently reset to "unknown" before
  export and the per-section meter never reached the `.osu` or the click track.
  Caught by a test, not by inspection. The same omission was fixed in
  `update_timing_point`, `nudge_timing_point` and `rescale_section`.

### Hardening

- The "no evidence, no bar" rule is preserved exactly: a section whose accents
  do not prove a time signature reports `1` and keeps v3's beat anchoring.
  Guessing a bar without evidence pushes a red line up to three beats past
  where the music changed, which is worse than not knowing.

### Measured

Accuracy unchanged, which is the point: **24/24 within 0.05 BPM and 5 ms,
median 0.0000 BPM and 0.16 ms**, `bpm-snapshot` 24/24 unchanged, golden vectors
24/24 unchanged. 62 unit tests, up from 56.

The new gate needed its own fixtures, and the reason is worth recording. On the
24-case corpus the detector reports "no bar" on **every section**, and it is
right to: `build_track` puts a hat on every beat and varies the kick only
between 1.0 and 0.8, so downbeat contrast lands near 1.05 against a 1.20
threshold. The feature was therefore a no-op on the whole corpus — implemented
but unproven. Rather than lower a threshold with no ground truth to justify it,
three fixtures with an audible downbeat were added:

```
case                        truth     detected   anchored
downbeat-4-4                  [4]          [4]        yes
downbeat-3-4                  [3]          [3]        yes
downbeat-4-then-3          [4, 3]          [4]        yes
```

Anchoring is exact: the emitted offset sits a whole number of bars from its
section's downbeat, to within 2 % of a bar.

### Also changed — `.osz` export

The remaining piece of Tempora's workflow. v3 could only **inject** red lines
into a beatmap that already existed; `export_osz` writes the beatmap: a zip
holding the audio and a complete, openable `.osu` carrying this timing and
nothing else — no hit objects, no background, default difficulty. The point is
a file a mapper opens in the editor with the timing already correct.

`--osz out.osz`, with `--artist` / `--title` / `--creator` for the metadata.

Hardening, because an archive is a filename problem as much as a format one:

- the zip is built in a `.part` file and renamed into place, so an interrupted
  export cannot leave a half-written `.osz` that osu! refuses and the user does
  not think to delete;
- metadata is sanitised into the filename — path separators and the characters
  Windows refuses become `_`, and a run of dots collapses. `../../evil` cannot
  reach outside the archive, and a single dot survives because "Mr. Blue" is a
  legitimate artist;
- the audio is size-capped before anything is written;
- an analysis with no usable points is refused rather than producing a beatmap
  with an empty `[TimingPoints]`.

Seven tests, including that a failed export leaves neither the archive nor the
temporary file behind.

### Open items

- **A time-signature change at constant tempo is not detected.** Sections split
  on tempo, so 4/4 → 3/4 at the same BPM stays one section and only the first
  bar is reported (`downbeat-4-then-3` above). Tempora lets a user set the
  signature per audio block regardless of tempo; matching that needs a
  meter-change detector alongside the tempo one.

---

## v3.1 — 2026-09-22 · Audit, and the v4 design

No engine behaviour changed. This entry exists because the next release is a rewrite, and
a rewrite with no written baseline is how a 0.16 ms tool becomes an 8 ms tool without
anyone noticing.

### Changed

- **`docs/` — nine design documents** covering the audit of v3, a five-way stack
  evaluation, the v4 architecture, the UI/UX language, the DSP porting contract, the
  hitsound engine, the roadmap (phases 0–9), an ML assessment, and naming.
- **README rewritten** around what is measured versus what is designed. Every number now
  carries the date and the environment that produced it.
- **`CLAUDE.md` / `AGENTS.md`**: contributor and agent conventions. No `Co-Authored-By`
  trailers, no GitHub Actions — every gate is a local one-liner.
- `.gitignore` scoped so `.osu` and `.csv` **fixtures can be committed**; the repo-wide
  ignore is why the one sample lives as `STK_timing_points.osu.txt`.
- **`bench/gates.py`** — two gates for things the accuracy benchmark structurally cannot
  see. `bpm-snapshot` pins the **absolute** reported BPM per fixture (`bench/bpm_snapshot.json`,
  24 cases): the benchmark normalizes octaves, so a change to the octave decision could
  halve every track and all 24 rows would stay green. Verified by tampering with the
  baseline — it reports `global BPM 112.5 -> 225.0  <-- OCTAVE FLIP`. `coverage` measures
  the density signal behind F-11 on three half/double-time fixtures, deliberately kept out
  of `benchmark.CASES` so the published 24/24 stays comparable.
- **`bench/golden.py`** — per-stage golden vectors: attacks, coherence candidates, seed
  grids, octave, atom sections, beat sections, meter and points, 362 KB committed across
  the 24 fixtures, with a `check` mode that diffs stage by stage within documented
  tolerances (attacks 0.05 ms, period 1e-6 s, offsets 0.05 ms). This is the harness the
  Rust engine gets pointed at in Phase 1: a port can reach the right BPM through a wrong
  envelope and a compensating peak-picker, and only a stage-by-stage diff catches that.
  It captures by wrapping the private stage functions with recording proxies, so it
  duplicates no pipeline logic — what is recorded is what the shipped path computed.
- **`requirements.lock`** — the exact versions behind the measured baseline.
- One test added (56 total): `test_pulse_hints_only_ever_suggest_doubling`, which
  documents that `suggest_section_pulse` has no downward direction.
- **`proto/` — the two highest-risk roadmap algorithms, prototyped in Python** against the
  existing corpus before committing to them in Rust. Both are Phase 2 items rated
  difficulty *high* / impact *high*, and both would have been expensive to discover wrong
  after a port. Results in [`proto/README.md`](proto/README.md); summary under Measured.
- **Renamed to Overtone.** The repository was `githaltwastaken/Timing-Analyzer`; an
  overtone is a frequency above the fundamental, which is what the coherence sweep spends
  its time separating — `R(f)` peaks at the true pulse and at every multiple of it.
  Renamed: README, all docs, `CLAUDE.md` / `AGENTS.md`, this file, the GUI title and about
  box, the CLI description, and the `.osu` comment. Settings moved to `~/.overtone.json`
  with `~/.timing_analyzer.json` read as a fallback, so an existing install keeps its
  preferences instead of silently losing them. `timing_analyzer.py` keeps its filename on
  purpose — it is the v3 reference implementation and the roadmap already moves it to
  `reference/python-v3/` in the same commit that creates `crates/`; renaming it now would
  touch every import in the suite, the benchmark and all three gates for no gain.

### Fixed

- **`_atomic_grid_candidates` rebound its own `keep` parameter** with a 5000-element index
  array in the dense-audio guard, so `strong[:keep]` would raise `TypeError` and drop the
  whole analysis to the v2 tracker. Currently unreachable — every call site goes through
  `_seed_grid`, whose windows are at most 30 s, and the 25 ms minimum peak spacing caps
  that at ~1200 attacks — but the v4 design widens exactly those windows, and the code's
  own comment at `MAX_SCAN_FREQS` predicts it. Renamed the local to `dense`.
- **`window_of` was defined twice, identically, in `_tune_boundary`.** Copy-paste residue;
  Python binds the second, so behaviour was never affected. Deleted the first.

### Hardening

- Not applicable; no new I/O or parsing paths.

### Measured

The v3 baseline was **reproduced on this machine**, which matters more than quoting it:

| | published | reproduced 2026-09-21 |
|---|---|---|
| median BPM error | 0.0000 BPM | **0.0000 BPM** |
| median offset error | 0.16 ms | **0.16 ms** |
| sections within 0.05 BPM and 5 ms | 24/24 | **24/24** |
| unit tests | 55 | **55/55 pass** (56/56 after this release's addition) |

Environment: Windows 11 26200, Python 3.14.4, numpy 2.5.3, scipy 1.18.1, librosa 1.0.0,
numba 0.67.0. Worth recording because `requirements.txt` has lower bounds only, and the
resolve pulled librosa **1.0.0** — a major version past what v3 was developed against.
Everything passes on it; nothing in the repo would have told us either way.

Corpus wall time: **21.6 s for 24 tracks** single-threaded, worst case 5.0 s on the
6-minute fixture. Cheap enough that the full accuracy gate can run on every commit, which
removes the last excuse for an unmeasured change.

Two results the README did not previously state:

- `change-175-87.5` reports **1 of 2 sections**, and the cause is not what it looked
  like. My first diagnosis blamed the global octave decision; instrumenting the engine
  showed otherwise:

  ```
  ATOMIC grid on 175 region  : share=1.000 coverage=1.000 rms=1.27 ms
  ATOMIC grid on 87.5 region : share=1.000 coverage=0.633 rms=2.18 ms
  growth gate: break when share < 0.55 or rms > 15.43 ms
  ```

  The grid is continuous across the change, so every attack in the slow half still lands
  on the fast half's grid and `share` never moves. What halves is **coverage** — and
  `_grow_sections` computes it and throws it away (`share, _cov, rms = _grid_quality(...)`).
  The statistic `_seed_grid` ranks candidates by is discarded by the loop that decides
  whether a section continues. The signal is strong (drop 0.36–0.46 across three fixtures)
  and localises the change to within one 8-beat window, but it lives on the **subdivided**
  grid: at beat level coverage is 1.000 for the whole track, and the first version of the
  gate measured beat level, found nothing, and would have "proved" the signal absent.

  Whether it *should* split is a separate and genuinely open question — the README's
  policy is to keep the BPM through a half-time section, while the benchmark's ground
  truth asserts two sections. The repository contradicts itself and nothing resolves it.
  Third part of the gap: `suggest_section_pulse` returns early for any point at or above
  120 BPM, so it can only ever propose `×2` and offers nothing here.
- The octave choices are visible for the first time now that they are pinned:
  `slow-92` is reported as **184.000** and `fast-300` as **150.000**. Both were previously
  hidden behind the benchmark's `x2` / `x0.5` notes.
- White noise returns `127.68 BPM` through the legacy tracker. It should refuse.

**Prototype results** (`proto/`, full detail in `proto/README.md`):

*Density detector* — **4/4** real half/double-time changes found, **0 false positives out
of 23**, worst localisation error 1.37 s (one 8-beat window). Zero false positives on the
three fixtures built to look like this — a 6 s drop, a 10 s sparse region, and a track with
both — is the result that matters, and **parity** is what buys it: coverage says "half the
slots are empty", parity says "and it is every other one, not a random half". Verdict:
build it.

*Elastic grid* — a polynomial in `k` (degree 1 *is* v3, degree 2 is a ramp), so IRLS
carries over unchanged.

| case | deg | rms | fitted BPM | BPM err med/max | v3 |
|---|---:|---:|---|---|---|
| ramp-120-160 | 3 | 4.06 ms | 120.65 -> 159.04 | **0.163** / 0.748 | legacy, 8 sections |
| ramp-180-140 | 3 | 2.70 ms | 179.32 -> 140.44 | **0.144** / 0.536 | legacy, 13 sections |
| ramp-90-200 | 3 | 23.79 ms | 98.92 -> 189.51 | 1.387 / 10.739 | legacy, 1 section |

And the test that mattered more — it does **not** invent curvature: **22 of 24** constant
fixtures chose degree 1 with **0.00 % drift**. The two that bent, `secs-4` and
`tiny-change`, both have genuine tempo changes, so the model was noticing real changes and
smoothing them rather than hallucinating. That makes residual a clean **selector**: where
v3's piecewise fit applies it wins by two orders of magnitude (0.15 ms vs 8-15 ms); where
it falls back, elastic wins. The two models are complementary, not competing, and v4
should fit both and report which one answered.

### Rejected / tried and dropped

- **Porting the v2 hybrid tracker to Rust as the v4 fallback.** It means reimplementing
  librosa's DP beat tracker and PLP to reproduce an engine whose measured output on the
  degenerate corpus is an 8-section staircase on a tempo ramp and a confident BPM for
  white noise. Instead: keep the Python v3 runnable as the reference that produces
  `--engine legacy` numbers, ship an elastic (spline) tempo model for genuinely varying
  tempo, and refuse honestly when neither fits.
- **GPU compute for the analysis pipeline.** A 6-minute track is ~124k frames of
  1024-point real FFT; on CPU with rayon that is well under a second against the 5.0 s
  measured in Python. Transfer overhead, driver variance and a second numeric path to
  validate, for a fraction of an already-negligible cost. GPU is used for *rendering*,
  where the timeline genuinely needs it.
- **Extending the elastic tempo curve past its samples with the edge slope.** A ramp
  genuinely keeps ramping, and measurement showed the entire max error on every ramp
  fixture is edge behaviour rather than curve shape, so this looked like the obvious fix.
  It made the extreme fixture *worse* — median 0.63 -> 5.65 BPM, because a steep edge slope
  fed the polynomial-in-k stage badly enough to flip its degree choice — and changed
  nothing on the other two. Clamping at the sample edges is kept.
- **Seeding the elastic fit with a constant period.** Assigning beat indices with one
  period across a 60 s ramp slips indices, and least squares cannot recover a slipped
  index — the same failure mode this file records for the coherence phase sign. It
  returned degree 1 at 30 ms rms and a tempo 17 BPM from truth. The pipeline has to be
  curve-first: sample locally, normalise octaves, fit `period(t)`, integrate to a grid,
  *then* assign indices.
- **Fixing the click track's hardcoded 4-beat accent** (finding F-03, audible on 3/4
  tracks). It is a behaviour change to an audio export with no test covering the accent
  pattern, and the rule is that precision-adjacent code does not change without a test in
  the same commit. Patch is written down in the audit; it lands with its test.

### Open items

Unchanged from v3.0, plus: `_grow_sections` should consult coverage (F-11), and
`suggest_section_pulse` needs a downward direction so a half-time region can be surfaced
the way the global octave already is. Both now have gates that measure the signal; neither
has a fix.

Phase 0's remaining work is blocked on the Rust toolchain (MSVC Build Tools, then rustup
with the `x86_64-pc-windows-msvc` target), which is not installed. Everything in Phase 0
that does not need it is done.

---

## v3.0 — 2026-09-04 · Least-squares grid engine

The headline change: **BPM is no longer derived from the gaps between beats.**

### Why the old approach capped out

v2 computed tempo as `60 / (t[k+1] - t[k])`, smoothed. Every detected beat carries
a few milliseconds of onset-detector jitter, and differencing two jittery numbers
*amplifies* that noise instead of averaging it away. No amount of median filtering
downstream can recover information the differencing threw out. That is why v2 sat
at ~0.2 BPM of wobble and ~8 ms of offset error no matter how the filters were tuned.

v3 fits an explicit model to the attack times instead:

```
t(k) = offset + k · beat_length        (k = integer beat index)
```

by iteratively re-weighted least squares. With N inlier attacks the fitted period
averages the jitter down by √N. That single change is where essentially all of the
accuracy gain comes from; everything else in this entry exists to make sure the fit
is seeded correctly and applied to the right span of audio.

### Changed

- **Attack detection at sample resolution.** Peaks come off a 2.9 ms onset envelope
  (hop 128, was 256) with parabolic sub-frame interpolation, then each one is
  **re-timed on the raw waveform**: a local energy window walked back to its 20 %
  rise. A spectral-flux peak lags the physical attack by roughly one analysis
  window, which is exactly the ~8 ms bias v2 shipped with. Measured after the fix:
  attacks land 0.15 ms from truth with 0.15 ms spread.
- **Circular-coherence pulse sweep.** `R(f) = |Σ w·e^{2πi f t}| / Σ w` scores a
  candidate pulse rate in one O(N) pass, so the whole plausible range is swept
  rather than trusting one tracker's guess. Candidates are ranked by
  *share* × *coverage* (see Rejected, below).
- **Expanding-window least squares.** The fit grows over the track in doubling
  spans, so a 1 % seed error is absorbed without ever slipping a beat index.
- **Octave from accent depth.** Attacks are grouped by index modulo *m*; if *m*
  atoms really make a beat, one class holds the kicks and another the filler, so
  the spread between strongest and weakest class is large. That plus tempogram
  hints read through librosa's log-normal prior picks the beat — and the downbeat.
- **Sections grow and re-seed.** A region extends forward while attacks keep
  landing on its grid; the next region runs **its own** coherence scan instead of
  inheriting a period that just failed. Boundaries then settle on the beat where
  the two grids cross, and every section is refitted on its own attacks alone.
- **Legacy engine kept as a fallback**, not deleted. Rubato, free time and
  non-percussive audio have no grid to fit; those fall through to the v2 hybrid
  tracker and the analysis says so (`engine: legacy` in `--stats`).
- API: `analyze_audio(..., engine="auto"|"precision"|"legacy")`;
  `force_subdivision` is now a float (`0.25 … 4`, so ÷2 finally exists in the GUI
  and CLI); `osu_timing_text(analysis, decimals=0)`; new `GridSection` dataclass and
  `Analysis.sections / attack_times / attack_weights / engine / fit_residual_ms`.
- **The benchmark harness is in the repo** (`bench/benchmark.py`): 24 synthesized
  tracks with exact ground truth plus four no-answer inputs, scoring every section
  rather than only the first, seeded per track so a subset run reproduces a full
  one byte-for-byte. `--engine legacy` reproduces the v2 column of the table below
  from the same code, which is the only way the comparison means anything.
- Docs: README rewritten around the measured numbers and an explicit
  "Honest limits" section. Tests 35 → 55.

### Fixed

- **Coherence phase came back negated.** `z = Σ w·e^{2πi f t}` has
  `arg(z) = 2π f φ`, so `φ = arg(z)/(2πf)` — the code used `-arg(z)`. Every seed
  grid started in **anti-phase**, half a beat off, and least squares cannot recover
  from a slipped beat index. This was the single largest source of error in the
  first working version of the engine. Regression test:
  `GridMathTests.test_coherence_phase_has_the_right_sign`.
- **`_refine_beats_to_transients` had a latent `NameError`**: `dtype(...)` where
  `dtype=...` was meant, on the empty-input branch. Present since v2.1.
- **Variable-tempo tracks collapsed into one section.** A global expanding fit ran
  *before* section growth, so on a 128 → 142 BPM track it locked onto 142 and the
  per-section seeds inherited that. Removed; each section now seeds itself.
- **Section boundaries landed a beat late.** The reach walk that decides where a
  grid stops explaining attacks used a 5 %-of-beat tolerance, loose enough for the
  *old* grid to claim the *new* tempo's first beat. Now driven by each side's own
  fit residual.
- **Swung and ornamented music pulled the offset late.** Least squares balances
  everything inside its tolerance window, so a second population of attacks (swung
  off-beats, ghost notes) dragged the grid halfway toward them — 17 ms on the
  shuffle fixture. `_recentre_phase` scores candidate shifts with a narrow Gaussian
  and snaps to the *mode* rather than the mean. 17 ms → 0.09 ms.
- **`min_delta` was scaled the wrong way** when handed to the atom-level segmenter
  (`/m` instead of `*m`), making the change detector ~m² more sensitive than the
  documented parameter promised.
- `_robust_local_bpms` raised `IndexError` on arrays of 0 or 1 beats.
- The GUI editor located the edited point with `list.index()`, which matches by
  *value* on a frozen dataclass — duplicate points returned the wrong row.

### Hardening

- **`.osu` injection is now atomic** (temp file + rename). Previously a crash or
  power loss between truncate and write destroyed the user's beatmap.
- **An existing `.bak` is never overwritten.** Injecting twice used to back up the
  already-injected file, losing the pristine original for good.
- **Legacy `.osu` red lines are recognised.** Format v3/v4 wrote only
  `time,beatLength`; the old 8-field check treated those as green, so a legacy map
  kept its old red lines *and* gained the new ones. A negative beat length now
  always means inherited, overriding a contradictory flag.
- **Offsets export as whole milliseconds.** The `.osu` format specifies integers and
  osu!stable does not accept decimals; v2.2 wrote `.3f`. The fit is sub-millisecond,
  so rounding costs at most 0.5 ms. `--decimal-offsets N` opts back in for lazer.
- **A corrupt config no longer bricks the app.** `load_config` returned whatever
  JSON it found; a list or a scalar crashed startup with `AttributeError`, which the
  user could only fix by deleting `~/.timing_analyzer.json` by hand. Now validated,
  size-capped, and written atomically.
- **Resource limits** against absurd or hostile input: audio duration is checked
  from the file *header* before decoding, plus caps on `.osu` size, config size,
  click-track length, coherence-sweep frequencies, and onsets fed to the O(N×M)
  kernel scans.
- Division-by-zero guards for hand-edited 0 BPM points along every export path;
  a cap on the legacy peak-tracker's gap reconstruction loop.
- **The fallback is no longer silent.** An unexpected exception inside the precision
  engine used to degrade quietly to the legacy tracker, which hides a real bug
  behind merely-worse numbers. It now reports the exception type in the progress
  message — and this immediately caught a live regression during development (a
  cleanup pass deleted two helper functions and every benchmark silently dropped
  back to v2-quality output).
- Audited and clean: no `eval`/`exec`/`pickle`/`subprocess`/`shell=True`, no
  user-controlled format strings, no writes outside the target file's own directory.

### Measured

24-track synthetic benchmark with exact ground truth (odd tempos incl. 222.222 and
128.37, added noise, ±8 ms performance jitter, swing and shuffle, drops, sparse
breakdown bars, a 6-minute track, and 2–4 tempo changes per song), scoring **every**
section rather than only the first:

| | v2 engine | v3 engine |
|---|---|---|
| median BPM error | 0.1965 BPM | **0.0000 BPM** |
| median offset error | 8.37 ms | **0.16 ms** |
| sections within 0.05 BPM **and** 5 ms | 0 / 24 | **24 / 24** |
| wall time, 60 s track | ~5 s | **~0.7 s** |

Both columns come from the same harness, now committed as `bench/benchmark.py`:
`python bench/benchmark.py` and `python bench/benchmark.py --engine legacy`.

The speedup is incidental: the old tempogram ran at hop 128 and cost ~10 s of the
~11 s total. It only ever fed an octave *hint*, which needs no such resolution, so
it now runs on a 4× max-pooled envelope.

Degenerate inputs behave: a 120 → 160 BPM ramp and pad-only audio fall back to the
legacy tracker, pure silence raises a clear `ValueError`, white noise does not hang.

### Rejected / tried and dropped

- **"Slowest strong coherence peak" as the atomic grid.** `R(f)` is high at the true
  pulse *and every multiple of it*, so the fundamental is the slowest strong peak —
  in theory. In practice a 12-second uniform click track has near-flat coherence and
  a grid at half density (share 0.5) still qualified, halving the tempo. Replaced by
  ranking on *share* × *coverage*: a grid twice too slow explains only half the
  attack energy, a grid twice too fast fills only half its own slots, and only the
  true atom scores on both. Requiring `share ≥ 0.72` instead was tried first and
  rejected — it rejects legitimately ornamented music (the shuffle fixture sits at
  0.53) while still admitting the half-density case at 0.559.
- **Least-squares residual cost for section boundaries.** It is *flat* at the true
  change, because at a real tempo change both grids pass through the same beat and
  fit equally well on either side of it. Measured cost differed by 0.9 % between the
  correct split and one a beat early — noise. What *is* sharp is that the two grids
  share a beat there and drift apart linearly away from it, so the boundary is now
  placed at that crossing.

### Open items

- **The octave remains a judgement call, and always will be.** A 92 BPM song with
  eighth-note hats is a valid 184 BPM map; 225 BPM streams read as 112.5 to any
  estimator carrying a perceptual prior. `Prefer map BPM (120–300)` breaks the tie
  toward osu!'s range and ×2 / ÷2 is now instant and exact, but no detector settles
  this for you.
- Rubato and non-percussive audio still route to the v2 tracker, which emits a
  staircase of sections. Fitting a slowly-varying tempo curve (rather than piecewise
  constant) would serve those tracks properly.
- Swing and shuffle produce exact BPM and offset but a large grid residual, because
  the off-beats genuinely do not sit on a subdivision. That number is honest, but the
  confidence score currently reads it as instability.
- **The benchmark is entirely synthetic.** That is what makes sub-millisecond ground
  truth possible, but synthesized drums are cleaner than recorded ones and the
  numbers above should be read as an upper bound, not a promise about real masters.
  A small set of real tracks hand-timed in the osu! editor would be the honest
  complement — expensive to build, and worth it.

---

## v2.2 — 2026-09-03 · Editing, injection, hardening

Two commits (`0576894`, `ea5cb6e`).

- **Changed**: manual timing-point editor (add / update / delete / nudge ±1 and
  ±5 ms / per-section ×2 and ÷2); `.osu` injection preserving green lines and CRLF
  style with a `.bak` backup; per-section half-time pulse hints; menu bar i18n.
- **Fixed**: CSV column labels; CLI error paths made to exit cleanly instead of
  raising tracebacks; the GUI worker thread stopped touching Tk variables (it now
  captures parameters before the thread starts).
- **Hardening**: parameter validation before any I/O; validation tests.
- **Measured**: not measured — accuracy work in this release was qualitative.

## v2.1 — 2026-09-03 · Hybrid tracking

Commit `a3bc82e`.

- **Changed**: hybrid beat tracking (librosa DP + PLP + peak-picking fallback, most
  clock-regular candidate wins); sub-frame parabolic transient re-anchoring;
  half/double-time resolved from onset evidence at subdivided grid positions rather
  than blind multiplication; defaults retuned for songs that change tempo often;
  English as the default UI language.
- **Fixed**: half-time locks collapsing a whole map into one "constant" section
  (225 vs 222.2 differ by only ~1.4 BPM once halved, below `min_delta`).
- **Measured**: not measured — no ground-truth harness existed yet, which is
  precisely why the v2 error floor went unnoticed until v3.

## v1 — 2026-09-03 · Initial release

Commit `fae9bf7`. Onset-strength envelope, `librosa.beat.beat_track`, tempo from
smoothed beat intervals, persistence-based segmentation, Tk GUI, CSV and `.osu`
text export.

---

## Resumen en español

Este archivo es el registro de ingeniería del proyecto: qué cambió, **por qué**, y
qué efecto medible tuvo. Entradas de más nueva a más vieja, una por versión, cada
una con las mismas cuatro secciones (Changed / Fixed / Hardening / Measured) más,
cuando aplica, `Rejected` — las ideas que se probaron y se descartaron, porque el
razonamiento es lo caro de reconstruir después.

El cambio central de v3.0: el BPM ya no sale de las diferencias entre beats
consecutivos, sino de un ajuste por mínimos cuadrados sobre los tiempos de ataque.
Error mediano 0,0000 BPM y 0,14 ms frente a 0,18 BPM y 8,2 ms en v2.2, y unas 7
veces más rápido. Lo que sigue sin resolverse — y no lo resuelve ninguna
herramienta — está en `Open items`.
