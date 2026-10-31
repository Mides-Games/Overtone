import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildRequest, compareHref, EMPTY_FORM, formatRange, isDefault, jobCost, parseTime,
} from '../src/lib/analysis-options.js'

/** A stand-in for i18next's t: the key and its values, so the tests read what was asked. */
const t = (key, values = {}) => {
  const words = {
    'modes.estimate.seconds': `${values.count} s`,
    'modes.estimate.minutes': `${values.count} min`,
    'modes.estimate.about': `≈ ${values.value}`,
    'modes.estimate.range': `≈ ${values.low} – ${values.high}`,
    'modes.estimate.atLeast': `at least ${values.value}`,
  }
  return words[key] ?? key
}

test('a form left alone asks for the analysis as it always was', () => {
  const request = buildRequest(EMPTY_FORM)
  assert.deepEqual(request, { mode: 'normal', options: {}, error: null })
  assert.equal(isDefault(request), true)
  assert.equal(isDefault(buildRequest({ ...EMPTY_FORM, mode: 'fast' })), false)
})

test('each hint becomes the field the API takes', () => {
  const request = buildRequest(
    { ...EMPTY_FORM, mode: 'strict', tempo: 'constant', bpmKind: 'about', bpm: '174,5', meter: '3', start: '0:30', end: '1:45' },
    { durationS: 200 },
  )
  assert.equal(request.error, null)
  assert.equal(request.mode, 'strict')
  assert.deepEqual(request.options, { tempo: 'constant', bpm: 174.5, meter: 3, start_s: 30, end_s: 105 })
  const range = buildRequest({ ...EMPTY_FORM, bpmKind: 'range', bpmMin: '90', bpmMax: '180' })
  assert.deepEqual(range.options, { bpm_min: 90, bpm_max: 180 })
  // A kind chosen with nothing typed says nothing.
  assert.deepEqual(buildRequest({ ...EMPTY_FORM, bpmKind: 'about' }).options, {})
})

test('a live band asks the worker to separate the drums', () => {
  assert.deepEqual(buildRequest({ ...EMPTY_FORM, band: true }).options, { band: true })
  assert.deepEqual(buildRequest({ ...EMPTY_FORM, band: false }).options, {})
  assert.equal(isDefault(buildRequest({ ...EMPTY_FORM, band: true })), false)
})

test('a mistake is named before anything is sent', () => {
  const error = (form, context) => buildRequest({ ...EMPTY_FORM, ...form }, context).error
  assert.equal(error({ bpmKind: 'about', bpm: '1000' }), 'bpm')
  assert.equal(error({ bpmKind: 'about', bpm: 'fast' }), 'bpm')
  assert.equal(error({ bpmKind: 'range', bpmMin: '180', bpmMax: '90' }), 'range')
  assert.equal(error({ bpmKind: 'range', bpmMin: '90' }), 'bpm')
  assert.equal(error({ start: '0:30', end: '0:35' }, { durationS: 100 }), 'stretchShort')
  assert.equal(error({ start: '0:30', end: '5:00' }, { durationS: 100 }), 'stretchPast')
  assert.equal(error({ start: 'abc', end: '1:00' }), 'stretch')
  assert.equal(error({ start: '0:30' }), 'stretch') // no end and no known length
  assert.equal(error({ start: '0:30', end: '1:30' }, { allowStretch: false }), 'stretchBatch')
  // A start alone runs to the end of a song whose length is known.
  assert.deepEqual(buildRequest({ ...EMPTY_FORM, start: '30' }, { durationS: 100.4 }).options, { start_s: 30, end_s: 100.4 })
})

test('times are m:ss or seconds', () => {
  assert.equal(parseTime(''), null)
  assert.equal(parseTime('90'), 90)
  assert.equal(parseTime('1:30.5'), 90.5)
  assert.ok(Number.isNaN(parseTime('1:2:3')))
  assert.ok(Number.isNaN(parseTime('-5')))
})

test('an estimate is a rounded range, and "at least" without a ceiling', () => {
  assert.equal(formatRange(t, 7, 41), '≈ 5 s – 40 s')
  assert.equal(formatRange(t, 130, 600), '≈ 2 min – 10 min')
  assert.equal(formatRange(t, 62, 62), '≈ 60 s')
  assert.equal(formatRange(t, 0, 2), '≈ 5 s')
  assert.equal(formatRange(t, 300, null), 'at least 5 min')
})

test('a job costs what the API measured, and nothing without the table or the length', () => {
  const costs = { fast: { fixed: 1.4, perMin: 0.77, highPerMin: 11 }, normal: { fixed: 3, perMin: 5.1, highPerMin: 35 } }
  const cost = jobCost(costs, 'normal', 120)
  assert.equal(cost.low, 3 + 5.1 * 2)
  assert.equal(cost.high, 70)
  assert.equal(jobCost(null, 'normal', 120), null)
  assert.equal(jobCost(costs, 'normal', null), null)
  assert.equal(jobCost(costs, 'strict', 120), null)
})

test('the compare link names both analyses', () => {
  assert.equal(compareHref('a'.repeat(32), 'b'.repeat(32)), `/compare?a=${'a'.repeat(32)}&b=${'b'.repeat(32)}`)
})
