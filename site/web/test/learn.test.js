import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { GLOSSARY } from '../src/lib/glossary.js'
import { REPO_URL, repoFile } from '../src/lib/repo.js'

/**
 * How it works, the FAQ and the glossary (W12.12). The pages are text in
 * the locale files, so what can go wrong is structural: a term the Term
 * component names but the glossary lacks, a cited file that was moved, a link
 * to a route that does not exist.
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const locales = { en: JSON.parse(read('../src/locales/en.json')), es: JSON.parse(read('../src/locales/es.json')) }
const app = read('../src/App.jsx')
const routes = new Set(['/', ...[...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => `/${m[1]}`)])
const repoRoot = new URL('../../../', import.meta.url)

test('every glossary term has its name, short and long text in both languages, and nothing else is listed', () => {
  for (const [lang, tree] of Object.entries(locales)) {
    const terms = tree.learn.glossary.terms
    assert.deepEqual(Object.keys(terms).sort(), [...GLOSSARY].sort(), lang)
    for (const id of GLOSSARY) for (const field of ['term', 'short', 'long']) assert.ok(terms[id][field]?.trim(), `${lang} ${id}.${field}`)
  }
})

test('the terms the result page underlines are in the glossary', () => {
  const sources = [read('../src/pages/AnalysisResult.jsx'), read('../src/components/result/RedLinesTable.jsx')].join('\n')
  const used = new Set([...sources.matchAll(/<Term id="([^"]+)"/g)].map((m) => m[1]))
  for (const m of sources.matchAll(/term: '([^']+)'/g)) used.add(m[1])
  for (const id of ['drift', 'fit', 'confidence', 'redLine']) assert.ok(used.has(id), `${id} is not underlined`)
  for (const id of used) assert.ok(GLOSSARY.includes(id), `${id} is not a glossary term`)
})

test('how it works: the same steps in both languages, each citing a file that exists in the repository', () => {
  const ids = (lang) => locales[lang].learn.how.steps.map((s) => s.id)
  assert.deepEqual(ids('es'), ids('en'))
  assert.equal(new Set(ids('en')).size, ids('en').length)
  for (const lang of Object.keys(locales)) {
    const how = locales[lang].learn.how
    const cited = [...how.steps.flatMap((s) => s.src), ...how.time.src, ...how.bench.src]
    assert.ok(cited.length >= 8)
    for (const { path } of cited) {
      assert.ok(repoFile(path), `${lang} cites ${path}, not a plain path`)
      assert.ok(existsSync(new URL(path, repoRoot)), `${lang} cites ${path}, which is not in the repository`)
    }
  }
})

test('the FAQ: the same questions in both languages, and every link goes to a route of the site', () => {
  const ids = (lang) => locales[lang].learn.faq.items.map((item) => item.id)
  assert.deepEqual(ids('es'), ids('en'))
  for (const id of ['doubled', 'two-lines', 'offset', 'drift', 'audio', 'limits', 'formats', 'osz', 'accounts', 'privacy']) {
    assert.ok(ids('en').includes(id), id)
  }
  for (const lang of Object.keys(locales)) {
    for (const item of locales[lang].learn.faq.items) {
      for (const link of item.links ?? []) {
        const [path, hash] = link.to.split('#')
        assert.ok(routes.has(path), `${lang} ${item.id} links to ${link.to}`)
        if (path === '/glossary') assert.ok(GLOSSARY.includes(hash), `${link.to} is not a term`)
      }
    }
  }
})

test('repoFile links only plain paths inside the repository', () => {
  assert.equal(repoFile('docs/site.md'), `${REPO_URL}/blob/master/docs/site.md`)
  for (const bad of ['../secret', 'docs/../../x', 'https://example.com/x', '/etc/passwd', 'docs/a b.md', 'javascript:alert(1)', '']) {
    assert.equal(repoFile(bad), null, bad)
  }
})

