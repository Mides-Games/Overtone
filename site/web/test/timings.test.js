import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bpmLabel, listQuery, NO_FILTERS, songLine, timingPath } from '../src/lib/timings.js'

test('a list query sends only the filters that are set and read as the API reads them', () => {
  assert.equal(listQuery(NO_FILTERS), '')
  assert.equal(listQuery({ ...NO_FILTERS, q: '  daft punk ', tempo: 'variable' }), '?q=daft+punk&tempo=variable')
  assert.equal(listQuery({ bpmMin: '120', bpmMax: '180.5' }), '?bpmMin=120&bpmMax=180.5')
  // Half-typed or impossible numbers stay home rather than earning a 400.
  assert.equal(listQuery({ bpmMin: '1.', bpmMax: '-5' }), '')
  assert.equal(listQuery({ tempo: 'fast' }), '')
  assert.equal(listQuery({}, { cursor: '123-abc', limit: 5 }), '?limit=5&cursor=123-abc')
  assert.equal(listQuery({ q: 'x'.repeat(300) }).length, '?q='.length + 100)
})

test('status and dates are history filters only', () => {
  const filters = { status: 'done', from: '2026-10-01', to: '2026-10-27' }
  assert.equal(listQuery(filters), '')
  assert.equal(listQuery(filters, { kind: 'history' }), '?status=done&from=2026-10-01&to=2026-10-27')
  assert.equal(listQuery({ status: 'gone', from: '27/10/2026' }, { kind: 'history' }), '')
})

test('names, BPMs and links read as the lists show them', () => {
  assert.equal(songLine({ title: 'Song', artist: 'Band' }), 'Band - Song')
  assert.equal(songLine({ title: 'Song', artist: null }), 'Song')
  assert.equal(songLine({ title: null, artist: null }), null)
  assert.equal(bpmLabel(128), '128')
  assert.equal(bpmLabel(174.5), '174.5')
  assert.equal(bpmLabel(174.004), '174')
  assert.equal(bpmLabel(91.25), '91.25')
  assert.equal(bpmLabel(null), '–')
  assert.equal(timingPath('a'.repeat(32)), `/t/${'a'.repeat(32)}`)
})
