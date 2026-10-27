import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * EN and ES are one site in two languages (W3.7): every string in one exists
 * in the other with the same placeholders, and every key the code asks for by
 * name exists. Without this a new string lands in one file only and the other
 * language silently shows English, or the raw key.
 */
const src = fileURLToPath(new URL('../src/', import.meta.url))
const load = (lang) => JSON.parse(readFileSync(join(src, 'locales', `${lang}.json`), 'utf8'))
const en = load('en')
const es = load('es')

/** `{ 'a.b': 'text', ... }` for every string leaf. */
const flatten = (tree, prefix = '') =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  )
const flatEn = new Map(flatten(en))
const flatEs = new Map(flatten(es))

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort()

test('both languages have exactly the same keys', () => {
  assert.deepEqual([...flatEs.keys()].filter((k) => !flatEn.has(k)), [], 'only in es.json')
  assert.deepEqual([...flatEn.keys()].filter((k) => !flatEs.has(k)), [], 'only in en.json')
})

test('a string has the same placeholders in both languages, and none is empty', () => {
  for (const [key, text] of flatEn) {
    assert.ok(String(text).trim(), `en ${key} is empty`)
    assert.ok(String(flatEs.get(key)).trim(), `es ${key} is empty`)
    assert.deepEqual(placeholders(flatEs.get(key)), placeholders(text), key)
  }
})

test('every plural has its one and its other form', () => {
  for (const key of flatEn.keys()) {
    const plural = key.match(/^(.*)_(one|other)$/)
    if (!plural) continue
    for (const form of ['one', 'other']) assert.ok(flatEn.has(`${plural[1]}_${form}`), `${plural[1]}_${form}`)
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
