import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkSpans, DRIFT_P90_MS } from '../src/lib/check-spans.js'

test('nothing to check: an empty list', () => {
  assert.deepEqual(checkSpans({ sections: [{ level: 'high', drift_p90_ms: 2, start_ms: 0, end_ms: 1000 }] }), [])
  assert.deepEqual(checkSpans(null), [])
})

test('check and medium sections, high drift, hints and swing, sorted by time', () => {
  const spans = checkSpans({
    sections: [
      { start_ms: 0, end_ms: 10_000, level: 'high', drift_p90_ms: DRIFT_P90_MS + 1 },
      { start_ms: 10_000, end_ms: 20_000, level: 'high', drift_p90_ms: DRIFT_P90_MS },
      { start_ms: 20_000, end_ms: 30_000, level: 'check', drift_p90_ms: 35 },
      { start_ms: 30_000, end_ms: 40_000, level: 'medium', drift_p90_ms: null },
    ],
    pulse_hints: [{ section: 1, from_ms: 15_000, to_ms: 25_000, boundary_ms: 15_000, factor: 0.5 }],
    swing: { spans: [{ start_ms: 5_000, end_ms: 8_000, feel: 'swing' }] },
  })
  assert.deepEqual(
    spans.map((s) => [s.startMs, s.reasons.join('+')]),
    [
      [0, 'drift'],
      [5_000, 'swing'],
      [15_000, 'hint'],
      [20_000, 'check+drift'],
      [30_000, 'medium'],
    ],
  )
  assert.equal(spans[2].factor, 0.5)
  assert.deepEqual(spans[3].sections, [2, 2])
})

test('neighbouring sections with the same reasons are one span', () => {
  const sections = Array.from({ length: 30 }, (_, i) => ({ start_ms: i * 1000, end_ms: (i + 1) * 1000, level: 'check', drift_p90_ms: i === 7 ? 40 : null }))
  const spans = checkSpans({ sections })
  assert.deepEqual(
    spans.map((s) => [s.startMs, s.endMs, s.reasons.join('+'), s.sections.join('-')]),
    [
      [0, 7000, 'check', '0-6'],
      [7000, 8000, 'check+drift', '7-7'],
      [8000, 30000, 'check', '8-29'],
    ],
  )
})

test('a hint or swing span with no length is left out', () => {
  assert.deepEqual(checkSpans({ pulse_hints: [{ from_ms: 10, to_ms: 10, boundary_ms: 10 }], swing: { spans: [{ start_ms: 5, end_ms: 4 }] } }), [])
})
