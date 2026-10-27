import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { SITE_TITLE, applyPageMeta, pageTitle } from '../src/lib/meta.js'

/** Just enough of a document: a title and the meta tags by selector. */
const fakeDocument = (selectors) => {
  const tags = new Map(selectors.map((s) => [s, { content: 'before', setAttribute(name, value) { this[name] = value } }]))
  return { title: 'before', querySelector: (s) => tags.get(s) ?? null, tags }
}

test('a page title names the page and the site; the home page names the site and Mides', () => {
  assert.equal(pageTitle('Privacy'), 'Privacy · Overtone')
  assert.equal(pageTitle('  Status '), 'Status · Overtone')
  assert.equal(pageTitle(''), SITE_TITLE)
  assert.equal(pageTitle(undefined), SITE_TITLE)
})

test('the meta tags index.html carries follow the page, and a missing one is not invented', () => {
  const doc = fakeDocument(['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]'])
  assert.equal(applyPageMeta(doc, { title: 'Terms', description: 'The terms.' }), 'Terms · Overtone')
  assert.equal(doc.title, 'Terms · Overtone')
  assert.equal(doc.tags.get('meta[property="og:title"]').content, 'Terms · Overtone')
  assert.equal(doc.tags.get('meta[name="description"]').content, 'The terms.')
  assert.equal(doc.tags.get('meta[property="og:description"]').content, 'The terms.')
  assert.equal(doc.querySelector('meta[name="twitter:description"]'), null)

  // No description: the last one stays rather than an empty tag.
  applyPageMeta(doc, { title: 'Status' })
  assert.equal(doc.tags.get('meta[name="description"]').content, 'The terms.')
})

test('index.html carries every tag the hook sets, and the link preview', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  for (const tag of ['name="description"', 'property="og:title"', 'property="og:description"', 'name="twitter:title"', 'name="twitter:description"']) {
    assert.ok(html.includes(tag), tag)
  }
  assert.match(html, /property="og:image" content="https:\/\/[^"]+\/og-image\.png"/)
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)
})
