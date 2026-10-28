/**
 * A page's <title> and description (W10.3). Pure, so the tests reach it
 * without a browser; hooks/usePageMeta.js applies it on every page.
 *
 * The home page is "Overtone · Mides Projects", as index.html says before any
 * script runs; every other page is "<its name> · Overtone".
 */
export const SITE_TITLE = 'Overtone · Mides Projects'

export const pageTitle = (name) => {
  const clean = String(name ?? '').trim()
  return clean ? `${clean} · Overtone` : SITE_TITLE
}

/** The description meta tags a page sets: the plain one, Open Graph's and Twitter's. */
const DESCRIPTIONS = ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']
const TITLES = ['meta[property="og:title"]', 'meta[name="twitter:title"]']

/**
 * Sets `doc`'s title and the description tags index.html carries. A tag the
 * document lacks is left alone, never created: index.html is the one list.
 * An empty description keeps whatever is there. Returns the title it set.
 */
export function applyPageMeta(doc, { title, description } = {}) {
  const full = pageTitle(title)
  doc.title = full
  for (const selector of TITLES) doc.querySelector(selector)?.setAttribute('content', full)
  const text = String(description ?? '').trim()
  if (text) for (const selector of DESCRIPTIONS) doc.querySelector(selector)?.setAttribute('content', text)
  return full
}
