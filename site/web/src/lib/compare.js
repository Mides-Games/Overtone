/**
 * Two timings of the same song side by side (W12.10, W12.11): the result
 * against a map someone already timed, or one analysis against another (or
 * against its own adjusted version). Pure functions, no React, so the tests
 * reach every number the page shows.
 *
 * Two timings are compared as **grids**, not as lists of first beats. A red
 * line one beat (or four bars) away from the other's, at the same tempo, is
 * the same grid: osu! would play the same clicks. So:
 *
 * - **Per pair of red lines** (matched by time), the offset difference is the
 *   phase of one grid against the other where both lines are in force: the
 *   sparser grid's first beat there, and the nearest beat of the other grid
 *   to it. The same at the end of the pair's overlap shows a drift.
 * - **Overall**, every beat of the sparser grid from the later first line to
 *   the end of the song is looked up in the other grid. "Same grid within X
 *   ms" means every one of them was within the accuracy gates' tolerances
 *   (CLAUDE.md: 0.05 BPM and 5 ms) and X is the worst.
 *
 * Signs read "B minus A": a positive offset means B's beat comes later. A is
 * the result (or the left analysis), B the map (or the right one).
 */
import { parsePoint } from './osu-patch.js'
import { clickGrid, lowerBound } from './timing.js'

/** The accuracy baseline's tolerances (CLAUDE.md, "within 0.05 BPM and 5 ms"). */
export const BPM_TOLERANCE = 0.05
export const OFFSET_TOLERANCE_MS = 5

/** Two lines pair up when they are at most this many beats (of the slower one) apart, or this many ms. */
export const MATCH_WINDOW_BEATS = 4
export const MIN_MATCH_WINDOW_MS = 1000

/** A tempo ratio within 2 % of 1, 2 or 1/2 is that relation (its accuracy is then the BPM tolerance's to judge). */
const RATIO_SLACK = 0.02

/** The reader's .osu: the same cap as the patch (W3.20); and no more red lines than the alignment can hold. */
export const MAX_OSU_BYTES = 16 * 1024 * 1024
export const MAX_LINES = 2000

// ── Reading a map ───────────────────────────────────────────────────────────

/** Control and bidi characters out of text the page will show (as utils/upload.js `cleanTag` does on the API). */
const clean = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 200) || null

/**
 * A map's timing, read from its `.osu` text: `{ lines, audioFilename, title,
 * artist, version }` with the red lines in `adjustLines`' shape, or `{ error }`
 * ('notOsu', 'noTimingPoints', 'noRedLines', 'tooManyLines'). Green lines are
 * left out: they change neither the grid nor the bar. Two red lines at the
 * same ms: the later in the file wins, as in osu!.
 */
export function readOsu(text) {
  const body = String(text ?? '').replace(/^﻿/, '')
  if (!/^\s*osu file format v\d+/.test(body)) return { error: 'notOsu' }
  const meta = {}
  const points = []
  let section = null
  let sawTiming = false
  for (const raw of body.split(/\r\n|\n|\r/)) {
    const row = raw.trim()
    const header = /^\[([A-Za-z]+)\]$/.exec(row)
    if (header) {
      section = header[1]
      if (section === 'TimingPoints') sawTiming = true
      continue
    }
    if (section === 'General' || section === 'Metadata') {
      const pair = /^([A-Za-z]+)\s*:\s?(.*)$/.exec(row)
      if (pair) meta[pair[1]] = pair[2]
    } else if (section === 'TimingPoints') {
      const point = parsePoint(raw)
      if (point?.red && point.beatLength > 0 && Number.isFinite(point.time)) points.push(point)
    }
  }
  if (!sawTiming) return { error: 'noTimingPoints' }
  if (!points.length) return { error: 'noRedLines' }
  if (points.length > MAX_LINES) return { error: 'tooManyLines' }

  // By time, stably; at one time the last in the file.
  const sorted = points.map((p, order) => ({ p, order })).sort((x, y) => x.p.time - y.p.time || x.order - y.order)
  const kept = sorted.filter((x, i) => i + 1 === sorted.length || sorted[i + 1].p.time !== x.p.time).map((x) => x.p)
  const lines = kept.map((p, index) => ({
    index,
    timeMs: p.time,
    beatMs: p.beatLength,
    bpm: 60000 / p.beatLength,
    meter: Math.max(1, Math.min(16, Math.round(Number(p.meter)) || 4)),
    meterKnown: true,
  }))
  return {
    lines,
    audioFilename: clean(meta.AudioFilename),
    title: clean(meta.TitleUnicode || meta.Title),
    artist: clean(meta.ArtistUnicode || meta.Artist),
    version: clean(meta.Version),
  }
}

/** The reader's `File`, read in this browser and never kept: `readOsu`'s answer, or `{ error: 'tooBig' }`. */
export async function readOsuFile(file) {
  if (!file) return { error: 'notOsu' }
  if (file.size > MAX_OSU_BYTES) return { error: 'tooBig' }
  return readOsu(await file.text())
}

// ── Grids ───────────────────────────────────────────────────────────────────

/** The index of the line in force at `ms`: the last at or before it, else the first. */
function governIndex(lines, ms) {
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].timeMs <= ms + 1e-6) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}

const nearestOnLine = (line, ms) => line.timeMs + Math.round((ms - line.timeMs) / line.beatMs) * line.beatMs

/**
 * How B's tempo stands to A's: 'same', 'double' (B twice as fast), 'half',
 * or 'other'; and whether it is within the BPM tolerance, judged on the
 * slower of the two scales (so 240.04 against 120 is a double within 0.02).
 */
export function relation(bpmA, bpmB) {
  const ratio = bpmB / bpmA
  if (!(ratio > 0) || !Number.isFinite(ratio)) return { kind: 'other', bpmOk: false }
  if (Math.abs(ratio - 1) <= RATIO_SLACK) return { kind: 'same', bpmOk: Math.abs(bpmB - bpmA) <= BPM_TOLERANCE + 1e-9 }
  if (Math.abs(ratio - 2) <= 2 * RATIO_SLACK) return { kind: 'double', bpmOk: Math.abs(bpmB / 2 - bpmA) <= BPM_TOLERANCE + 1e-9 }
  if (Math.abs(ratio - 0.5) <= RATIO_SLACK / 2) return { kind: 'half', bpmOk: Math.abs(bpmB - bpmA / 2) <= BPM_TOLERANCE + 1e-9 }
  return { kind: 'other', bpmOk: false }
}

/**
 * The phase of line b's grid against line a's near `ms`, in ms (B minus A):
 * the sparser grid's beat at or after `ms` (`from: 'after'`) or at or before
 * it (`'before'`), and the other grid's nearest beat to it. A whole number of
 * beats apart reads 0: it is the same grid.
 */
export function phaseMs(a, b, ms, from = 'after') {
  const sparse = a.beatMs >= b.beatMs ? a : b
  const dense = sparse === a ? b : a
  const k = (ms - sparse.timeMs) / sparse.beatMs
  const s = sparse.timeMs + (from === 'after' ? Math.ceil(k - 1e-9) : Math.floor(k + 1e-9)) * sparse.beatMs
  const d = nearestOnLine(dense, s)
  return sparse === a ? d - s : s - d
}

// ── Matching red lines ──────────────────────────────────────────────────────

const windowMs = (a, b) => Math.max(MIN_MATCH_WINDOW_MS, MATCH_WINDOW_BEATS * Math.max(a.beatMs, b.beatMs))

/**
 * Pairs A's red lines with B's by time, in order (neither list is reordered):
 * the alignment that pairs the most lines, nearest first. Two lines pair only
 * when they are within `MATCH_WINDOW_BEATS` beats (or `MIN_MATCH_WINDOW_MS`).
 * Returns `{ pairs: [[i, j]], onlyA: [i], onlyB: [j] }`.
 */
export function matchLines(A, B) {
  const n = A.length
  const m = B.length
  // cost[i][j]: the best alignment of A[i..] with B[j..]; a skipped line costs 1, a pair its distance over the window (< 1).
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)) // 1 pair, 2 skip A, 3 skip B
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) continue
      let best = Infinity
      let how = 0
      if (i < n && j < m) {
        const d = Math.abs(A[i].timeMs - B[j].timeMs)
        const w = windowMs(A[i], B[j])
        if (d <= w) {
          best = d / w + cost[i + 1][j + 1]
          how = 1
        }
      }
      if (i < n && 1 + cost[i + 1][j] < best) {
        best = 1 + cost[i + 1][j]
        how = 2
      }
      if (j < m && 1 + cost[i][j + 1] < best) {
        best = 1 + cost[i][j + 1]
        how = 3
      }
      cost[i][j] = best
      move[i][j] = how
    }
  }
  const pairs = []
  const onlyA = []
  const onlyB = []
  for (let i = 0, j = 0; i < n || j < m; ) {
    const how = move[i][j]
    if (how === 1) pairs.push([i++, j++])
    else if (how === 2) onlyA.push(i++)
    else onlyB.push(j++)
  }
  return { pairs, onlyA, onlyB }
}

// ── The comparison ──────────────────────────────────────────────────────────

/** One matched pair: tempo, the phase at the start and the end of their overlap, the meter and the bar. */
function comparePair(A, B, i, j, endMs) {
  const a = A[i]
  const b = B[j]
  const { kind, bpmOk } = relation(a.bpm, b.bpm)
  const start = Math.max(a.timeMs, b.timeMs)
  const end = Math.min(A[i + 1]?.timeMs ?? Infinity, B[j + 1]?.timeMs ?? Infinity, endMs)
  const known = kind !== 'other'
  const offsetMs = known ? phaseMs(a, b, start, 'after') : null
  // The last beat before the overlap ends; none when the two lines' spans barely touch.
  const endOffsetMs = known && end - start > Math.max(a.beatMs, b.beatMs) ? phaseMs(a, b, end - 1e-6, 'before') : null
  let barShiftBeats = null
  if (kind === 'same' && a.meter === b.meter) {
    const n = Math.round((b.timeMs - a.timeMs) / a.beatMs)
    barShiftBeats = ((n % a.meter) + a.meter) % a.meter
  }
  const within = (ms) => ms === null || Math.abs(ms) <= OFFSET_TOLERANCE_MS + 1e-9
  return {
    a: i,
    b: j,
    timeA: a.timeMs,
    timeB: b.timeMs,
    bpmA: a.bpm,
    bpmB: b.bpm,
    bpmDiff: b.bpm - a.bpm,
    kind,
    bpmOk,
    offsetMs,
    endOffsetMs,
    meterA: a.meter,
    meterB: b.meter,
    barShiftBeats,
    // On the same beats within the tolerances: `agree` at the same tempo, `aligned` at the same, half or double.
    aligned: known && bpmOk && within(offsetMs) && within(endOffsetMs),
    agree: kind === 'same' && bpmOk && within(offsetMs) && within(endOffsetMs),
  }
}

/** A red line the other timing has no partner for, and whether the other's grid already agrees where it stands. */
function lonely(own, other, k, side) {
  const line = own[k]
  const there = other[governIndex(other, line.timeMs)]
  const { kind, bpmOk } = side === 'A' ? relation(line.bpm, there.bpm) : relation(there.bpm, line.bpm)
  const phase = kind === 'same' ? (side === 'A' ? phaseMs(line, there, line.timeMs) : phaseMs(there, line, line.timeMs)) : null
  return { side, index: k, timeMs: line.timeMs, bpm: line.bpm, meter: line.meter, sameGrid: kind === 'same' && bpmOk && Math.abs(phase) <= OFFSET_TOLERANCE_MS + 1e-9 }
}

/**
 * Every beat of the sparser grid (A's where they are as dense) from
 * `startMs` to `endMs`, looked up in the other grid: `{ t, kind, bpmOk, delta,
 * weight }` per beat, delta B minus A in ms, weight the beat's length (so a
 * share of beats is a share of time).
 */
function sampleBeats(A, B, startMs, endMs) {
  const seconds = endMs / 1000
  const gridA = clickGrid(A, seconds).t
  const gridB = clickGrid(B, seconds).t
  const samples = []
  const visit = (own, grid, other, otherGrid, ownIsA) => {
    for (let k = lowerBound(grid, startMs / 1000 - 1e-9); k < grid.length; k++) {
      const t = grid[k] * 1000
      if (t > endMs + 1e-6) break
      const x = own[governIndex(own, t)]
      // The other grid's nearest beat, and the line it belongs to: a few ms either side of two red lines
      // that change tempo at nearly the same time, the beat that meets this one is already (or still) the
      // other line's, and its tempo is the one to judge.
      const at = lowerBound(otherGrid, grid[k])
      let q = -1
      for (const c of [at - 1, at]) if (c >= 0 && c < otherGrid.length && (q < 0 || Math.abs(otherGrid[c] - grid[k]) < Math.abs(otherGrid[q] - grid[k]))) q = c
      if (q < 0) continue
      const near = otherGrid[q] * 1000 - t
      const y = other[governIndex(other, otherGrid[q] * 1000)]
      // Only the sparser grid's beats (A's where they are as dense): a denser grid's in-between beats have nothing to meet.
      if (ownIsA ? x.beatMs < y.beatMs - 1e-9 : x.beatMs <= y.beatMs + 1e-9) continue
      const r = ownIsA ? relation(x.bpm, y.bpm) : relation(y.bpm, x.bpm)
      samples.push({ t, kind: r.kind, bpmOk: r.bpmOk, delta: ownIsA ? near : -near, weight: x.beatMs })
    }
  }
  visit(A, gridA, B, gridB, true)
  visit(B, gridB, A, gridA, false)
  return samples.sort((x, y) => x.t - y.t)
}

const median = (values) => {
  const v = [...values].sort((x, y) => x - y)
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null
}

/**
 * A against B over a song `durationMs` long. Lines are `adjustLines`' shape
 * (`timeMs`, `beatMs`, `bpm`, `meter`), each list sorted by time.
 *
 * `verdict` is one of:
 * - 'same': every beat within 5 ms and every tempo within 0.05 BPM; `withinMs` the worst beat;
 * - 'offset': the same tempo throughout, B shifted by `offsetMs` (the median) for every beat;
 * - 'double' / 'half': B at twice / half A's tempo, otherwise the same grid within `withinMs`;
 * - 'different': anything else; `agreeShare` of the song (in time) is the same grid and `relatedShare`
 *   the same pulse at half or double, the first beat that is not the same grid at `firstApartMs`;
 * - 'noOverlap': the later first line is past the end of the song.
 * `null` when either side has no red line.
 */
export function compareTimings(A, B, { durationMs }) {
  const a = (A ?? []).filter((l) => l.beatMs > 0 && Number.isFinite(l.timeMs))
  const b = (B ?? []).filter((l) => l.beatMs > 0 && Number.isFinite(l.timeMs))
  if (!a.length || !b.length) return null
  const endMs = Math.max(durationMs || 0, a[a.length - 1].timeMs, b[b.length - 1].timeMs, 1000)
  const startMs = Math.max(a[0].timeMs, b[0].timeMs)

  const { pairs: matched, onlyA, onlyB } = matchLines(a, b)
  const pairs = matched.map(([i, j]) => comparePair(a, b, i, j, endMs))
  const unmatched = [...onlyA.map((k) => lonely(a, b, k, 'A')), ...onlyB.map((k) => lonely(b, a, k, 'B'))].sort((x, y) => x.timeMs - y.timeMs)
  const meterDiffers = pairs.filter((p) => p.meterA !== p.meterB).length
  const barsShifted = pairs.filter((p) => p.barShiftBeats).length
  const base = { startMs, endMs, pairs, unmatched, meterDiffers, barsShifted, withinMs: null, offsetMs: null, agreeShare: null, relatedShare: null, firstApartMs: null, samples: 0 }
  if (startMs > endMs) return { ...base, verdict: 'noOverlap' }

  const samples = sampleBeats(a, b, startMs, endMs)
  const worst = samples.reduce((w, s) => Math.max(w, Math.abs(s.delta)), 0)
  const all = (fn) => samples.length > 0 && samples.every(fn)
  const close = (s) => Math.abs(s.delta) <= OFFSET_TOLERANCE_MS + 1e-9
  const out = { ...base, samples: samples.length }
  for (const kind of ['same', 'double', 'half']) {
    if (all((s) => s.kind === kind && s.bpmOk && close(s))) return { ...out, verdict: kind, withinMs: worst, agreeShare: 1 }
  }
  if (all((s) => s.kind === 'same' && s.bpmOk)) {
    const mid = median(samples.map((s) => s.delta))
    if (samples.every((s) => Math.abs(s.delta - mid) <= OFFSET_TOLERANCE_MS + 1e-9)) return { ...out, verdict: 'offset', offsetMs: mid, withinMs: worst, agreeShare: 0 }
  }
  // A beat agrees when the clicks do: the same pulse within 5 ms, whatever the BPM says further on.
  const agrees = (s) => s.kind === 'same' && close(s)
  const apart = samples.find((s) => !agrees(s))
  const total = samples.reduce((sum, s) => sum + s.weight, 0)
  return {
    ...out,
    verdict: 'different',
    withinMs: worst,
    agreeShare: total ? samples.filter(agrees).reduce((sum, s) => sum + s.weight, 0) / total : 0,
    // Where the beats meet at half or double the tempo: not the same clicks, but the same pulse.
    relatedShare: total ? samples.filter((s) => s.kind !== 'same' && s.kind !== 'other' && s.bpmOk && close(s)).reduce((sum, s) => sum + s.weight, 0) / total : 0,
    firstApartMs: apart ? apart.t : null,
  }
}

// ── The /compare page's address ─────────────────────────────────────────────

const ID = /^[0-9a-f]{32}$/
const FACTORS = [0.5, 1, 2]

/**
 * One side of `/compare` from its query: `a` / `b` the analysis id, and
 * optionally `ax` / `bx` (×0.5, ×1 or ×2) and `an` / `bn` (a nudge in ms, at
 * most ±1000), the reader's adjustment. `null` when the id is missing or
 * malformed; a bad adjustment is read as none.
 */
export function readSide(params, key) {
  const id = String(params.get(key) ?? '').toLowerCase()
  if (!ID.test(id)) return null
  const factor = Number(params.get(`${key}x`))
  const nudge = Number(params.get(`${key}n`))
  return {
    id,
    factor: FACTORS.includes(factor) ? factor : 1,
    nudgeMs: Number.isFinite(nudge) && Math.abs(nudge) <= 1000 ? Math.round(nudge * 10) / 10 : 0,
  }
}

/** The `/compare` address for sides `a` and (optionally) `b`, each `{ id, factor?, nudgeMs? }`. */
export function comparePath(a, b = null) {
  const params = new URLSearchParams()
  for (const [key, side] of [['a', a], ['b', b]]) {
    if (!side?.id) continue
    params.set(key, side.id)
    if (side.factor && side.factor !== 1) params.set(`${key}x`, String(side.factor))
    if (side.nudgeMs) params.set(`${key}n`, String(side.nudgeMs))
  }
  const text = params.toString()
  return text ? `/compare?${text}` : '/compare'
}

/** An analysis id out of what a visitor pastes: the id itself, or a `/t/<id>` or `/analyze/<id>` link. */
export function readAnalysisRef(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (ID.test(value)) return value
  const m = /\/(?:t|analyze)\/([0-9a-f]{32})(?:[/?#]|$)/.exec(value)
  return m ? m[1] : null
}
