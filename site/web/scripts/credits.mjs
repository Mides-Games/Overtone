#!/usr/bin/env node
/**
 * The credits page's list (W4.8), generated, never typed:
 *
 *   node site/web/scripts/credits.mjs [--venv <path to a virtualenv>]
 *
 * writes site/web/src/data/credits.json, which pages/Credits.jsx imports.
 *
 * What it reads, and nothing else:
 *   - LICENSE at the repository root: Overtone's own licence and holder;
 *   - assets/models/beat_this.json and LICENSE-beat-this.txt: the model;
 *   - python/requirements.lock: every Python package the engine pins, with
 *     the licence from that package's installed metadata (the virtualenv's
 *     *.dist-info/METADATA; `--venv`, or OVERTONE_VENV, or <repo>/.venv);
 *   - site/web and site/api package.json: the direct npm packages, and every
 *     package the runtime ones pull in, walked through node_modules, each
 *     with the licence its own package.json declares;
 *   - site/web/src/index.css: any @font-face written there by hand (there is
 *     none today: the three faces come from @fontsource-variable packages,
 *     which are credited with the other npm packages, licence and all).
 *
 * A licence the metadata does not state comes out as "unknown", never a
 * guess. A missing virtualenv or node_modules stops the script instead of
 * writing a shorter list. The output carries no date, so running it twice
 * on the same install writes the same bytes; test/credits.test.js checks its
 * shape.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(WEB, '..', '..')
export const OUTPUT = join(WEB, 'src', 'data', 'credits.json')

// ── Python ─────────────────────────────────────────────────────────────────

/** `[{ name, version }]` from a pip lock: `name==version` lines, comments skipped. */
export function readLock(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)$/.exec(line)
      if (!m) throw new Error(`credits: "${line}" in requirements.lock is not name==version`)
      return { name: m[1], version: m[2] }
    })
}

/**
 * A package's licence from its METADATA headers: License-Expression (the
 * modern SPDX field), else a one-line License field, else the trove
 * classifiers, else "unknown". A License field that is the whole licence
 * text (scipy's starts "Copyright (c) ...") is not a name and is skipped.
 */
export function pythonLicence(metadata) {
  const head = metadata.split(/\r?\n\r?\n/)[0]
  const lines = head.split(/\r?\n/)
  const field = (name) => {
    const at = lines.findIndex((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    if (at < 0) return null
    const continued = lines[at + 1]?.startsWith(' ') || lines[at + 1]?.startsWith('\t')
    return { value: lines[at].slice(name.length + 1).trim(), continued }
  }
  const expression = field('License-Expression')
  if (expression?.value) return expression.value
  const licence = field('License')
  if (licence?.value && !licence.continued && licence.value.length <= 60 && !/copyright|permission|\(c\)/i.test(licence.value)) {
    return licence.value
  }
  const classifiers = lines
    .filter((line) => line.startsWith('Classifier: License ::'))
    .map((line) => line.split('::').at(-1).trim())
  if (classifiers.length) return [...new Set(classifiers)].join(' / ')
  return 'unknown'
}

const normalise = (name) => name.toLowerCase().replace(/[-_.]+/g, '_')

function sitePackages(venv) {
  const windows = join(venv, 'Lib', 'site-packages')
  if (existsSync(windows)) return windows
  const lib = join(venv, 'lib')
  if (existsSync(lib)) {
    for (const entry of readdirSync(lib)) {
      const candidate = join(lib, entry, 'site-packages')
      if (entry.startsWith('python') && existsSync(candidate)) return candidate
    }
  }
  throw new Error(`credits: no site-packages under ${venv}; pass --venv <path> or set OVERTONE_VENV`)
}

function pythonPackages(venv) {
  const site = sitePackages(venv)
  const infos = readdirSync(site).filter((entry) => entry.endsWith('.dist-info'))
  return readLock(readFileSync(join(REPO, 'python', 'requirements.lock'), 'utf8')).map(({ name, version }) => {
    const info = infos.find((entry) => normalise(entry) === normalise(`${name}-${version}.dist-info`))
    if (!info) throw new Error(`credits: ${name}==${version} is pinned but not installed in ${site}`)
    return { name, version, licence: pythonLicence(readFileSync(join(site, info, 'METADATA'), 'utf8')) }
  })
}

// ── npm ────────────────────────────────────────────────────────────────────

/** A package.json's licence: `license`, or the legacy `licenses` list, or "unknown". */
export function npmLicence(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim()
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ') || 'unknown'
  }
  return 'unknown'
}

/** Where `dep` resolves from a package in `dir`, as Node would: up the node_modules chain. */
function resolvePackage(dir, dep) {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', dep, 'package.json')
    if (existsSync(candidate)) return realpathSync(dirname(candidate))
    if (dirname(at) === at) return null
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Every package of one site package (`web` or `api`): its direct
 * dependencies (`runtime`) and devDependencies (`build`), plus everything
 * the runtime ones depend on (`runtime`, `direct: false`). The build tools'
 * own dependencies stay out: none of them ships.
 */
function npmPackages(part) {
  const root = join(REPO, 'site', part)
  const manifest = readJson(join(root, 'package.json'))
  if (!existsSync(join(root, 'node_modules'))) throw new Error(`credits: run pnpm install in site/${part} first`)
  const found = new Map()

  const visit = (dir, name, role, direct) => {
    const at = resolvePackage(dir, name)
    if (!at) {
      if (direct) throw new Error(`credits: ${name} is in site/${part}/package.json but not installed`)
      return // an optional dependency for another platform
    }
    const pkg = readJson(join(at, 'package.json'))
    const key = `${pkg.name}@${pkg.version}`
    if (found.has(key)) return
    found.set(key, { name: pkg.name, version: pkg.version, licence: npmLicence(pkg), role, direct })
    if (role !== 'runtime') return
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(at, dep, role, false)
  }

  for (const name of Object.keys(manifest.dependencies ?? {})) visit(root, name, 'runtime', true)
  for (const name of Object.keys(manifest.devDependencies ?? {})) visit(root, name, 'build', true)
  return [...found.values()]
}

// ── The rest ───────────────────────────────────────────────────────────────

/** The licence's name, and the year and holder of its copyright line, from an MIT-style LICENSE file. */
export function readLicenceFile(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const name = /^(MIT|ISC|BSD|Apache)\b/.exec(lines[0])?.[1] ?? 'unknown'
  const line = lines.find((l) => /^Copyright \(c\)/i.test(l))?.replace(/^Copyright \(c\)\s*/i, '') ?? ''
  const m = /^(\d{4}(?:\s*-\s*\d{4})?)?\s*(.*)$/.exec(line)
  return { licence: name, year: m[1] ?? null, holder: m[2] || null }
}

function model() {
  const dir = join(REPO, 'assets', 'models')
  const card = readJson(join(dir, 'beat_this.json'))
  const file = readLicenceFile(readFileSync(join(dir, 'LICENSE-beat-this.txt'), 'utf8'))
  return {
    name: 'Beat This!',
    // "Beat This! (authors, venue)": the card's sentence up to its first parenthesis' end.
    what: /^[^)]*\)/.exec(card.what)?.[0] ?? 'Beat This!',
    checkpoint: card.checkpoint?.name ?? null,
    licence: /^\S+/.exec(card.licence ?? '')?.[0] ?? file.licence,
    year: file.year,
    holder: file.holder,
    url: card.source,
  }
}

function fonts() {
  const css = readFileSync(join(WEB, 'src', 'index.css'), 'utf8')
  return [...css.matchAll(/@font-face\s*{[^}]*font-family:\s*['"]?([^;'"]+)/g)].map((m) => ({ name: m[1].trim(), licence: 'unknown' }))
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en')

export function collect({ venv }) {
  const npm = [...npmPackages('web').map((p) => ({ ...p, part: 'web' })), ...npmPackages('api').map((p) => ({ ...p, part: 'api' }))]
  return {
    overtone: { ...readLicenceFile(readFileSync(join(REPO, 'LICENSE'), 'utf8')), url: 'https://github.com/Mides-Games/Overtone' },
    model: model(),
    python: pythonPackages(venv).sort(byName),
    npm: npm.sort((a, b) => a.part.localeCompare(b.part) || byName(a, b)),
    fonts: fonts(),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf('--venv')
  const venv = flag > 0 ? process.argv[flag + 1] : process.env.OVERTONE_VENV || join(REPO, '.venv')
  const credits = collect({ venv })
  writeFileSync(OUTPUT, `${JSON.stringify(credits, null, 2)}\n`)
  const unknown = [...credits.python, ...credits.npm].filter((p) => p.licence === 'unknown').map((p) => p.name)
  console.log(
    `credits: ${credits.python.length} Python and ${credits.npm.length} npm packages, ${credits.fonts.length} fonts -> ${OUTPUT}` +
      (unknown.length ? `\ncredits: no licence stated by ${unknown.join(', ')}` : ''),
  )
}
