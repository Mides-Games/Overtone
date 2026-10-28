/**
 * Versions of a timing (W12.21): the requests, and the difference between two
 * versions, red line by red line. A version is a reading (an analysis of the
 * same audio by the same owner) with an adjustment applied, the engine's own
 * reading being the one with none. Nothing here estimates anything: it lines
 * up what two versions say and shows how far apart they are.
 */
import { api } from './api.js'
import { adjustLines } from './timing.js'

export const NO_ADJUSTMENT = Object.freeze({ factor: 1, nudgeMs: 0 })

export const fetchVersions = (id) => api(`/analyses/${id}/versions`)
export const saveVersion = (id, { factor, nudgeMs, label = null }) =>
  api(`/analyses/${id}/versions`, { method: 'POST', json: { factor, nudgeMs, ...(label ? { label } : {}) } })
export const deleteVersion = (id, versionId) => api(`/analyses/${id}/versions/${versionId}`, { method: 'DELETE' })

export const isAdjusted = (adjustment) => Boolean(adjustment) && (adjustment.factor !== 1 || adjustment.nudgeMs !== 0)

/** The red lines of a version: its reading's result with its adjustment applied. */
export const versionLines = (result, adjustment = NO_ADJUSTMENT) => adjustLines(result, adjustment)

/**
 * The two versions' red lines paired: each pair is the closest two lines
 * within half a beat of each other (the longer of their two beats), taken
 * closest first, so one line is never paired twice. Returns one row per pair
 * or unpaired line, by time:
 * `{ a, b, timeMs, dTimeMs, bpmA, bpmB, dBpm, meterA, meterB }`, `a`/`b`
 * being indexes into each list or null where a version has no line there,
 * and the differences `b - a` (null when a side is missing).
 */
export function diffLines(linesA, linesB) {
  const candidates = []
  linesA.forEach((la, i) => {
    linesB.forEach((lb, j) => {
      const gap = Math.abs(lb.timeMs - la.timeMs)
      if (gap <= Math.max(la.beatMs, lb.beatMs) / 2) candidates.push({ i, j, gap })
    })
  })
  candidates.sort((x, y) => x.gap - y.gap || x.i - y.i || x.j - y.j)
  const usedA = new Set()
  const usedB = new Set()
  const rows = []
  for (const { i, j } of candidates) {
    if (usedA.has(i) || usedB.has(j)) continue
    usedA.add(i)
    usedB.add(j)
    rows.push(row(linesA[i], linesB[j], i, j))
  }
  linesA.forEach((la, i) => usedA.has(i) || rows.push(row(la, null, i, null)))
  linesB.forEach((lb, j) => usedB.has(j) || rows.push(row(null, lb, null, j)))
  return rows.sort((x, y) => x.timeMs - y.timeMs || (x.a ?? Infinity) - (y.a ?? Infinity))
}

function row(la, lb, a, b) {
  return {
    a,
    b,
    timeMs: (la ?? lb).timeMs,
    dTimeMs: la && lb ? lb.timeMs - la.timeMs : null,
    bpmA: la?.bpm ?? null,
    bpmB: lb?.bpm ?? null,
    dBpm: la && lb ? lb.bpm - la.bpm : null,
    meterA: la?.meter ?? null,
    meterB: lb?.meter ?? null,
  }
}

/** What a list of diff rows comes to: the largest moves and how many lines only one side has. */
export function diffSummary(rows) {
  let maxTimeMs = 0
  let maxBpm = 0
  let onlyA = 0
  let onlyB = 0
  let meters = 0
  for (const r of rows) {
    if (r.a === null) onlyB++
    else if (r.b === null) onlyA++
    else {
      maxTimeMs = Math.max(maxTimeMs, Math.abs(r.dTimeMs))
      maxBpm = Math.max(maxBpm, Math.abs(r.dBpm))
      if (r.meterA !== r.meterB) meters++
    }
  }
  return { maxTimeMs, maxBpm, onlyA, onlyB, meters, same: !onlyA && !onlyB && !meters && maxTimeMs < 0.5 && maxBpm < 0.0005 }
}

/** A short name for an adjustment: "x2 -4 ms", "/2", "+12 ms"; '' for none. */
export function adjustmentLabel({ factor, nudgeMs }) {
  const parts = []
  if (factor === 2) parts.push('×2')
  if (factor === 0.5) parts.push('÷2')
  if (nudgeMs) parts.push(`${nudgeMs > 0 ? '+' : '−'}${Math.abs(nudgeMs)} ms`)
  return parts.join(' ')
}
