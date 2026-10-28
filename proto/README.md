# Prototypes

Two algorithms from the v4 roadmap, built in Python against the existing corpus **before**
committing to them in Rust. Both are Phase 2 items rated difficulty *high* / impact *high*
in [`../docs/07-roadmap.md`](../docs/07-roadmap.md), and both would be expensive to
discover wrong after a port.

Neither touches `overtone.py`. They read a finished analysis and use the engine's
own private helpers, so the five gates stay green while these are iterated on.

```bash
python proto/density.py          # F-11: half/double-time inside one section
python proto/elastic.py          # rubato: a tempo curve instead of a staircase
```

---

## 1. Density detector — `density.py`

**Verdict: works. Build it.**

`_grow_sections` extends a section while `share` holds up, and `share` cannot move across
an exact 2× change because the grid is continuous — every attack of the slow half still
lands on the fast half's grid. Coverage does move, and the growth loop computes it and
throws it away.

But coverage alone is not enough, and that is the interesting part: a drop, a breakdown and
a sparse bar all lower coverage too, and none of them is a pulse change. The discriminator
is **parity** — in a half-time region the occupied grid indices all share one residue
mod 2; in a sparse or dropped region they are scattered.

```
coverage ~0.5   "half the slots are empty"
parity   ~1.0   "and it is every other one, not a random half"
```

Measured over 26 fixtures:

| | result |
|---|---|
| real density changes detected | **4 / 4** |
| false positives | **0 / 23** |
| worst localisation error | **1.37 s** (one 8-beat window) |

```
case                     truth    thin        at    cov in/out   parity in/out
halftime-175-87.5         0.5x   tail     33.5s     0.62/0.98       0.94/0.69   +1.37s
halftime-150-75           0.5x   tail     29.3s     0.53/0.98       1.00/0.64   +1.20s
doubletime-110-220          2x   head     27.0s     0.54/1.00       0.99/0.70   +0.55s
with-drop-180                -     no         -             -               -
sparse-160                   -     no         -             -               -
breakdown-175                -     no         -             -               -
shuffle-96                   -     no         -             -               -
```

Zero false positives on the three fixtures designed to look like this (a 6 s drop, a 10 s
sparse region, and a track with both) is the result that matters. Parity is what buys it.

**Lessons for the port**

- The signal lives on the **subdivided** grid, not the beat grid. At beat level coverage is
  1.000 across the whole track, because the slow half's attacks land on every beat. The
  first version of this measurement looked at beat level, found nothing, and would have
  concluded the signal did not exist.
- The boundary is whichever edge of the thinned run is *not* a section edge: a half-time
  drop thins the tail, a double-time chorus thins the head. Reporting the run's start
  unconditionally put the double-time case 25.6 s off.

**What it should become:** a bidirectional pulse hint with confidence, surfaced in the UI
with one-click apply — not a silent split. Whether a half-time region wants its own red
line is a judgement call of the same kind as the global octave, and the repository
currently contradicts itself about it (the README says keep the BPM, the benchmark's ground
truth asserts two sections). Also fixes the one-directional
`suggest_section_pulse` gap, which can only ever propose ×2.

---

## 2. Elastic grid — `elastic.py`

**Verdict: works for realistic ramps, with two limits worth knowing. Build it as a
*selector*, not a replacement.**

v3's model is `t(k) = offset + k·period`, exact for constant tempo and silent otherwise: on
a 120 → 160 BPM ramp the precision engine finds no fittable grid, falls back to the v2
tracker and emits an eight-section staircase. The generalisation is one idea — keep least
squares, raise the degree:

```
t(k) = c0 + c1·k + c2·k² + c3·k³
```

Degree 1 *is* v3. Degree 2 is a tempo linear in beat index, which is exactly a ramp. It
stays linear in the coefficients, so the IRLS machinery carries over unchanged.

### Ramps

| case | deg | rms | fitted BPM span | BPM err med/max | v3 |
|---|---:|---:|---|---|---|
| ramp-120-160 | 3 | 4.06 ms | 120.65 → 159.04 | **0.163** / 0.748 | legacy, 8 sections |
| ramp-180-140 | 3 | 2.70 ms | 179.32 → 140.44 | **0.144** / 0.536 | legacy, 13 sections |
| ramp-90-200 | 3 | 23.79 ms | 98.92 → 189.51 | 1.387 / 10.739 | legacy, 1 section |

Two of three recover the curve to about a sixth of a BPM against a staircase of 8 and 13
sections. The third — a 2.2× accelerando over 75 s — does not, and the reason is specific:
**the entire max error on every ramp is edge behaviour, not curve shape.** Measured
directly, the curve itself is 0.09–0.61 BPM median across all three; the error is
concentrated in the first and last few seconds, where no window can be fitted and the
curve has to be held constant.

### Constant tempo — the test that mattered more

The worry with any model that can bend is that it will bend to fit noise. It does not:

```
22 of 24 fixtures chose degree 1, with 0.00% invented drift
median invented drift 0.000%    worst 4.865%
```

The two that bent are `secs-4` (170→174→180→174) and `tiny-change` (200→203.5) — **both
have genuine tempo changes**. So the elastic model was not inventing curvature; it was
noticing real changes and representing them as a smooth curve instead of steps. That is an
architectural finding, not a bug:

| case | elastic rms | v3 rms | winner |
|---|---:|---:|---|
| edm-174 | 1.12 ms | 1.11 ms | v3 |
| shuffle-96 | 3.03 ms | 3.12 ms | elastic |
| change-128-142 | 15.41 ms | 0.16 ms | **v3** |
| secs-3 | 13.31 ms | 0.15 ms | **v3** |
| secs-4 | 9.90 ms | 0.15 ms | **v3** |
| tiny-change | 8.05 ms | 0.15 ms | **v3** |
| ramp-120-160 | 4.06 ms | (falls back) | **elastic** |

**Residual is a clean selector.** Where v3's piecewise fit applies it wins by two orders of
magnitude; where it has to fall back, the elastic fit wins. So v4 should fit both and let
the residual decide, then say which model produced the answer — the same way `engine:
precision | legacy` is reported today. The two models are complementary.

### Lessons for the port

1. **You cannot seed a curved model with a constant period.** Assigning beat indices with
   one period over a 60 s ramp slips indices, and least squares cannot recover a slipped
   index — the same failure mode the timeline records for the coherence phase sign. Seeded
   that way the fit returned degree 1 at 30 ms rms and a tempo 17 BPM from truth. The
   pipeline has to be curve-first: sample the tempo locally, normalise octaves, fit
   `period(t)`, **integrate to a grid**, and only then assign indices and do the global fit.
2. **The octave reference must be local.** A global reference assumes the whole track sits
   inside about half an octave; the 90 → 200 ramp spans 1.15, and a global reference
   "corrected" real tempo differences as octave errors, landing 20 BPM out at both ends.
   Walking forward against a running reference only assumes *adjacent* overlapping windows
   are within half an octave, which they always are.
3. **Judge a window's residual after octave normalisation, not before.** The slow head of
   the 90 → 200 ramp locks the 4× atom (the fixture has attacks a quarter-beat apart
   there), so a 5 ms residual was being compared against 5 % of a 166 ms atom instead of
   5 % of a 667 ms beat. The whole head was discarded and the curve extrapolated 17 s.
4. **Never evaluate the curve outside its samples.** A degree-2 polynomial run backwards
   from its first sample reported 109 BPM where truth was 90.
5. The prototype reports the **atomic** pulse, not the beat — it skips the octave stage
   deliberately, which is why most rows read 2× v3's BPM (348 vs 174). Not a discrepancy.

### Rejected here

- **Extending the curve past its samples with the edge slope.** A ramp genuinely keeps
  ramping, and since all the max error is at the edges this looked like the obvious fix.
  Measured, it made the extreme fixture *worse* — median 0.63 → 5.65 BPM, because a steep
  edge slope fed the polynomial-in-k stage badly enough to flip its degree choice — and
  changed nothing on the other two. Clamping is kept.
- **Piecewise-linear interpolation of the local samples** instead of a fitted polynomial.
  Barely different (median 0.09 vs 0.09, 0.19 vs 0.19, 0.61 vs 0.93), because the error is
  at the edges either way. Not worth the extra machinery at this degree; a proper spline
  with knots is still the right answer for the extreme case, and that is what
  [`../docs/05-dsp-pipeline.md`](../docs/05-dsp-pipeline.md) §B.1 specifies.

### Remaining limit, stated plainly

A 2.2× accelerando over 75 s exceeds a global cubic in `k`. Realistic rubato and
accelerandi — up to roughly ±0.4 octave, which covers both the 120→160 and 180→140
fixtures — are handled well. Anything wider needs the spline, and needs edge windows that
can actually be fitted. Neither is a reason to delay: the selector means such a track gets
v3's honest fallback, exactly as today, instead of a wrong curve.
