/**
 * What the front page needs beyond its strings: the lists its sections walk
 * (each key is a `home.*` string group in both locales, checked by
 * test/home.test.js), and the live numbers read defensively from a route
 * another branch adds (W12.13). Pure where it can be, so the tests reach it
 * without a browser.
 */
import { api } from './api.js'

/** "What you gain": benefits, in the order a mapper weighs them. */
export const GAINS = ['time', 'variable', 'osz', 'check', 'free']

/** "How it works": the three steps an analysis takes. */
export const STEPS = ['upload', 'analyse', 'check']

/** The FAQ teaser's questions; the whole list is /faq. */
export const FAQ = ['free', 'audio', 'accuracy', 'formats', 'account']

/** How many recent timings the front page shows; /recent has the rest. */
export const RECENT_ON_HOME = 5

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/** The first field among `paths` that holds a count, or null. */
const pick = (data, paths) => {
  for (const path of paths) {
    const value = path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), data)
    if (count(value) !== null) return value
  }
  return null
}

/**
 * The two numbers the front page shows, from `GET /api/v1/stats`: analyses
 * done and songs waiting. That route is W12.13's and its shape was not fixed
 * when this was written, so the names it is likely to use are all read, and
 * anything that is not a whole non-negative number is left out. Null when
 * neither number is there: the block is then not drawn, rather than drawn
 * with dashes.
 */
export function readStats(data) {
  if (!data || typeof data !== 'object') return null
  const analyses = pick(data, ['analyses.done', 'analyses.total', 'totals.analyses', 'analysesDone', 'analyses', 'songsTimed', 'timed'])
  const queue = pick(data, ['queue.waiting', 'queue.queued', 'queue.length', 'queueLength', 'queued', 'waiting'])
  if (analyses === null && queue === null) return null
  return { analyses, queue }
}

/**
 * Reads the live numbers, or null on any failure: a 404 (the route not
 * deployed yet), a network error, a body that says nothing. The front page
 * never shows an error for something it only adds as colour.
 */
export async function loadStats(get = api) {
  try {
    return readStats(await get('/stats'))
  } catch {
    return null
  }
}

/** A count as people read it in their language: 12 345 / 12,345 / 12.345. */
export const countLabel = (n, language) => new Intl.NumberFormat(language || undefined).format(n)
