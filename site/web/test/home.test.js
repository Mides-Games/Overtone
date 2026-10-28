import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { ApiError } from '../src/lib/api.js'
import { countLabel, FAQ, GAINS, loadStats, readStats, STEPS } from '../src/lib/home.js'

/**
 * The front page (W12): its sections walk lists of keys whose strings the
 * i18n test cannot see (they are built, not literal), and its live numbers
 * come from a route that may not exist yet. Both are checked here.
 */
const load = (lang) => JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), 'utf8'))

test('every section key has its strings in both languages', () => {
  for (const lang of ['en', 'es']) {
    const home = load(lang).home
    for (const key of GAINS) for (const part of ['title', 'body']) assert.ok(home.gain[key]?.[part], `${lang} home.gain.${key}.${part}`)
    for (const key of STEPS) for (const part of ['title', 'body']) assert.ok(home.steps[key]?.[part], `${lang} home.steps.${key}.${part}`)
    for (const key of FAQ) for (const part of ['q', 'a']) assert.ok(home.faq[key]?.[part], `${lang} home.faq.${key}.${part}`)
  }
})

test('the formats the FAQ names are the ones the API accepts', () => {
  const upload = readFileSync(new URL('../../api/src/utils/upload.js', import.meta.url), 'utf8')
  const accepted = JSON.parse(/AUDIO_EXTENSIONS = (\[[^\]]+\])/.exec(upload)[1].replace(/'/g, '"'))
  for (const lang of ['en', 'es']) {
    const answer = load(lang).home.faq.formats.a.toLowerCase()
    for (const ext of accepted) assert.ok(answer.includes(ext), `${lang} FAQ misses ${ext}`)
  }
})

test('the live numbers read what GET /stats answers, and nothing else', () => {
  assert.deepEqual(readStats({ totals: { done: 1234, refused: 3 }, queue: { queued: 3, running: 1 } }), { analyses: 1234, queue: 4 })
  assert.deepEqual(readStats({ totals: { done: 10 } }), { analyses: 10, queue: null })
  assert.deepEqual(readStats({ totals: { done: 7 }, queue: { queued: 0, running: 0 } }), { analyses: 7, queue: 0 })
  // A total that is not a count is left out, never shown as NaN or a fraction.
  assert.deepEqual(readStats({ totals: { done: -1 }, queue: { queued: 2 } }), { analyses: null, queue: 2 })
  assert.equal(readStats({ totals: { done: '12' }, queue: { queued: 1.5 } }), null)
  assert.equal(readStats({}), null)
  assert.equal(readStats(null), null)
  assert.equal(readStats('nope'), null)
})

test('a stats route that is missing or broken hides the block instead of failing the page', async () => {
  const notFound = async () => {
    throw new ApiError(404, 'NOT_FOUND')
  }
  const offline = async () => {
    throw new ApiError(0, 'NETWORK')
  }
  assert.equal(await loadStats(notFound), null)
  assert.equal(await loadStats(offline), null)
  assert.equal(await loadStats(async () => ({ unrelated: true })), null)
  let asked = null
  const live = async (path) => {
    asked = path
    return { totals: { done: 5 }, queue: { queued: 1, running: 0 } }
  }
  assert.deepEqual(await loadStats(live), { analyses: 5, queue: 1 })
  assert.equal(asked, '/stats')
})

test('counts read in the reader\'s language', () => {
  assert.equal(countLabel(12345, 'en'), '12,345')
  assert.equal(countLabel(12345, 'es'), '12.345')
  assert.equal(countLabel(0, 'es'), '0')
})
