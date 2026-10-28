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

/**
 * The two numbers the front page shows, from `GET /api/v1/stats` (W12.13,
 * site/api/src/utils/stats.js `shapeStats`): analyses done (`totals.done`)
 * and the songs in the queue now, waiting or running (`queue.queued` +
 * `queue.running`). Anything that is not a whole non-negative number is left
 * out. Null when neither number is there: the block is then not drawn, rather
 * than drawn with dashes.
 */
export function readStats(data) {
  if (!data || typeof data !== 'object') return null
  const analyses = count(data.totals?.done)
  const queued = count(data.queue?.queued)
  const running = count(data.queue?.running)
  const queue = queued === null && running === null ? null : (queued ?? 0) + (running ?? 0)
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
