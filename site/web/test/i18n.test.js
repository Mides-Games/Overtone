import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { BUNDLED, CODES, LANGS, matchLanguage, pickLanguage } from '../src/lib/languages.js'

/**
 * Ten languages, one site (W3.7, W12.16). `en.json` is the source of truth;
 * every other file holds a subset of its keys with the same placeholders and
 * the plural forms its language needs, and no empty string. A key a file
 * lacks reads in English (fallbackLng), so coverage is reported rather than
 * failed, except where it is required: 100 % for Spanish, French and German,
 * and for any file that is not empty. The six languages whose translations
 * land on their own branches start as `{}`.
 */
const src = fileURLToPath(new URL('../src/', import.meta.url))
const load = (lang) => JSON.parse(readFileSync(join(src, 'locales', `${lang}.json`), 'utf8'))
const REQUIRED = ['es', 'fr', 'de']

/** `{ 'a.b': 'text', ... }` for every string leaf; arrays by index. */
const flatten = (tree, prefix = '') =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  )
const flatEn = new Map(flatten(load('en')))
const locales = Object.fromEntries(CODES.filter((code) => code !== 'en').map((code) => [code, new Map(flatten(load(code)))]))

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort()

const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/
/** The bases English pluralizes: `analyze.atOnce` for `analyze.atOnce_one` and `_other`. */
const pluralBases = new Set([...flatEn.keys()].map((key) => key.match(PLURAL)?.[1]).filter(Boolean))

/** The forms a language must give every plural (the shared brief), and those it may. */
const FORMS = {
  ru: ['one', 'few', 'many', 'other'],
  pl: ['one', 'few', 'many', 'other'],
  ja: ['other'],
  ko: ['other'],
  fr: ['one', 'many', 'other'],
}
const required = (code) => FORMS[code] ?? ['one', 'other']
const allowed = (code) => new Set([...required(code), ...new Intl.PluralRules(code).resolvedOptions().pluralCategories])

/** The English string a key answers to: itself, or its base's `_other` for a plural form English lacks. */
const english = (key) => {
  if (flatEn.has(key)) return flatEn.get(key)
  const plural = key.match(PLURAL)
  return plural && pluralBases.has(plural[1]) ? flatEn.get(`${plural[1]}_other`) : undefined
}

/** How much of en.json a file covers: a plural counts once all its required forms are there. */
function coverage(code) {
  const flat = locales[code]
  let total = 0
  let have = 0
  const missing = []
  for (const key of flatEn.keys()) {
    const plural = key.match(PLURAL)
    if (plural && pluralBases.has(plural[1])) {
      if (plural[2] !== 'other') continue
      total += 1
      const lacking = required(code).filter((form) => !flat.has(`${plural[1]}_${form}`))
      if (lacking.length) missing.push(...lacking.map((form) => `${plural[1]}_${form}`))
      else have += 1
    } else {
      total += 1
      if (flat.has(key)) have += 1
      else missing.push(key)
    }
  }
  return { percent: (100 * have) / total, missing }
}

test('the list names ten languages, each with its locale file, a flag and a direction', () => {
  assert.equal(LANGS.length, 10)
  assert.deepEqual(
    readdirSync(join(src, 'locales')).map((f) => f.replace(/\.json$/, '')).sort(),
    [...CODES].sort(),
  )
  const flags = readFileSync(join(src, 'components', 'Flag.jsx'), 'utf8')
  for (const lang of LANGS) {
    assert.ok(lang.name.trim(), lang.code)
    assert.ok(new RegExp(`^  ${lang.flag}: `, 'm').test(flags), `Flag.jsx draws ${lang.flag}`)
    assert.ok(['ltr', 'rtl'].includes(lang.dir), lang.code)
  }
  assert.deepEqual(BUNDLED, ['en', 'es'])
})

test("index.html's early script knows the same ten codes", () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')
  const list = html.match(/\[('en'[^\]]*)\]\.indexOf\(lang\)/)
  assert.ok(list, 'the list in the early script')
  assert.deepEqual(list[1].split(',').map((s) => s.trim().replace(/'/g, '')), CODES)
})

test('a first visit reads the browser, a stored choice wins, and English is the default', () => {
  assert.equal(pickLanguage(null, ['de-AT', 'en']), 'de')
  assert.equal(pickLanguage(null, ['pt']), 'pt-BR')
  assert.equal(pickLanguage(null, ['pt-PT']), 'pt-BR')
  assert.equal(pickLanguage(null, ['PT-br']), 'pt-BR')
  assert.equal(pickLanguage(null, ['nl-NL', 'fr-CA']), 'fr')
  assert.equal(pickLanguage(null, ['zh-CN']), 'en')
  assert.equal(pickLanguage(null, []), 'en')
  assert.equal(pickLanguage(null, undefined), 'en')
  assert.equal(pickLanguage('ja', ['de']), 'ja')
  assert.equal(pickLanguage('xx', ['ko-KR']), 'ko')
  assert.equal(matchLanguage(''), null)
  assert.equal(matchLanguage('es_AR'), 'es')
})

test('every key of every language exists in English', () => {
  for (const [code, flat] of Object.entries(locales)) {
    const extra = [...flat.keys()].filter((key) => english(key) === undefined)
    assert.deepEqual(extra, [], `only in ${code}.json`)
  }
})

test('a string has the same placeholders as in English, and none is empty', () => {
  for (const [key, text] of flatEn) assert.ok(String(text).trim(), `en ${key} is empty`)
  for (const [code, flat] of Object.entries(locales)) {
    for (const [key, text] of flat) {
      assert.ok(String(text).trim(), `${code} ${key} is empty`)
      const want = placeholders(english(key))
      const got = placeholders(text)
      // A plural form may leave the count out ("one item", "un élément"), never anything else.
      if (PLURAL.test(key) && pluralBases.has(key.match(PLURAL)[1])) {
        assert.deepEqual(got.filter((p) => p !== 'count'), want.filter((p) => p !== 'count'), `${code} ${key}`)
      } else {
        assert.deepEqual(got, want, `${code} ${key}`)
      }
    }
  }
})

test("the `[[...]]` marks of the legal pages survive translation", () => {
  const marks = (text) => (String(text).match(/\[\[/g) ?? []).length
  for (const [code, flat] of Object.entries(locales)) {
    for (const [key, text] of flat) assert.equal(marks(text), marks(english(key)), `${code} ${key}`)
  }
})

test('every plural has the forms its language needs, and only forms it has', () => {
  for (const base of pluralBases) for (const form of ['one', 'other']) assert.ok(flatEn.has(`${base}_${form}`), `en ${base}_${form}`)
  for (const [code, flat] of Object.entries(locales)) {
    const may = allowed(code)
    for (const key of flat.keys()) {
      const plural = key.match(PLURAL)
      if (!plural || !pluralBases.has(plural[1])) continue
      assert.ok(may.has(plural[2]), `${code} ${key}: ${code} has no ${plural[2]} form`)
      for (const form of required(code)) assert.ok(flat.has(`${plural[1]}_${form}`), `${code} ${plural[1]}_${form}`)
    }
  }
})

test('coverage: 100 % for es, fr, de and any language that has begun', (t) => {
  for (const code of Object.keys(locales)) {
    const { percent, missing } = coverage(code)
    t.diagnostic(`${code}: ${percent.toFixed(1)} %`)
    if (REQUIRED.includes(code) || locales[code].size > 0) {
      assert.deepEqual(missing.slice(0, 20), [], `${code}.json lacks ${missing.length} keys`)
    }
  }
})

test('every key the code names exists', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (/\.jsx?$/.test(entry.name)) files.push(join(dir, entry.name))
    }
  }
  walk(src)
  const missing = []
  for (const file of files) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([\w.]+)'/g)) {
      const known = flatEn.has(key) || flatEn.has(`${key}_one`) || [...flatEn.keys()].some((k) => k.startsWith(`${key}.`))
      if (!known) missing.push(`${file.slice(src.length)}: ${key}`)
    }
  }
  assert.deepEqual(missing, [])
})
