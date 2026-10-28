#!/usr/bin/env node
/**
 * The bundle's budgets (W10.1), read from a finished build:
 *
 *   pnpm --dir site/web budget        (vite build, then this script)
 *
 * Initial JS is what every first visit downloads before the page can run:
 * the entry script dist/index.html loads and every chunk it modulepreloads
 * (Vite lists the entry's whole static import graph there). It must stay
 * under 200 kB gzip, the roadmap's number.
 *
 * Every other chunk is loaded on demand (a lazy route, a lazy component).
 * Each has a budget of its own, by the name Vite gives it (the source file's
 * name before the hash), else DEFAULT_CHUNK_KB. A budget is the size it had
 * when it was set plus some room, so a chunk that doubles is named, and one
 * that grows a little is not; raise one only with the reason in the commit.
 *
 * Sizes are gzip level 9 of the bytes on disk, in kB of 1000 bytes, as
 * `vite build` reports them. serve.mjs sends the files as they are; the
 * compression on the wire is the TLS proxy's (Cloudflare's), gzip or brotli,
 * so these are close to what a visitor downloads, not exactly it.
 *
 * Exits 1 on any overrun, or when there is no build to read.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

export const INITIAL_KB = 200
export const DEFAULT_CHUNK_KB = 12
/** Chunks known to be larger than the default, each with why. */
export const CHUNK_KB = {
  // The result page: the tempo map's canvases, the player, the exports
  // (19.5 kB on 2026-10-27; 30.1 kB on 2026-10-28 after the design rework
  // grouped it into listen, check and export zones with folded tools).
  AnalysisResult: 32,
  // The changelog tab carries the timeline's last 30 entries as data
  // (11.7 kB on 2026-10-27), and grows with them.
  Changelog: 16,
  // What the result page and a published timing share: the player, the song
  // in the browser, the .osz (14.0 kB on 2026-10-27).
  useSongAudio: 20,
  // The upload form with the analysis options and the tag reader (13.5 kB
  // on 2026-10-27).
  Analyze: 20,
  // The API reference carries the whole OpenAPI document (17.0 kB on
  // 2026-10-27).
  Developers: 24,
  // Each language's strings, loaded only for its visitors (Spanish was 28 kB
  // on 2026-10-27, before W12; the ten files are ~110-120 kB raw each on
  // 2026-10-28). They grow with every page; the CJK and Cyrillic files
  // compress less. Raised on 2026-10-28 with W13's strings, when Russian
  // reached 50.3 kB and French and Polish 43-44 kB of their 45.
  es: 50,
  fr: 50,
  de: 50,
  it: 50,
  pl: 50,
  'pt-BR': 50,
  ja: 56,
  ko: 56,
  ru: 58,
}

const kb = (bytes) => bytes / 1000
const gzipKb = (file) => kb(gzipSync(readFileSync(file), { level: 9 }).length)

/** `index-12owOo2C.js` -> `index`; `rolldown-runtime-WkwZ5CU-.js` -> `rolldown-runtime`. */
export const chunkName = (file) => file.replace(/\.js$/, '').replace(/-[A-Za-z0-9_-]{8}$/, '')

/** The scripts index.html loads or preloads, as asset paths. */
export const initialScripts = (html) => {
  const found = new Set()
  for (const m of html.matchAll(/<script[^>]*\bsrc="\/(assets\/[^"]+\.js)"/g)) found.add(m[1])
  for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/(assets\/[^"]+\.js)"/g)) found.add(m[1])
  return [...found]
}

function main() {
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('budget: no build in site/web/dist; run `pnpm --dir site/web budget`, which builds first')
    return 1
  }
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const initial = initialScripts(html)
  const problems = []

  let initialKb = 0
  console.log('initial JS (gzip):')
  for (const rel of initial) {
    const size = gzipKb(join(dist, rel))
    initialKb += size
    console.log(`  ${rel.padEnd(44)} ${size.toFixed(2).padStart(7)} kB`)
  }
  console.log(`  ${'total'.padEnd(44)} ${initialKb.toFixed(2).padStart(7)} kB  (budget ${INITIAL_KB} kB)`)
  if (initialKb > INITIAL_KB) problems.push(`initial JS is ${initialKb.toFixed(1)} kB gzip, over ${INITIAL_KB} kB`)

  console.log('on demand (gzip):')
  const lazy = readdirSync(join(dist, 'assets'))
    .filter((f) => f.endsWith('.js') && !initial.includes(`assets/${f}`))
    .sort()
  for (const file of lazy) {
    const name = chunkName(file)
    const budget = CHUNK_KB[name] ?? DEFAULT_CHUNK_KB
    const size = gzipKb(join(dist, 'assets', file))
    const over = size > budget
    console.log(`  ${file.padEnd(44)} ${size.toFixed(2).padStart(7)} kB  (budget ${budget} kB)${over ? '  OVER' : ''}`)
    if (over) problems.push(`${file} is ${size.toFixed(1)} kB gzip, over its ${budget} kB`)
  }

  const css = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.css'))
  for (const file of css) console.log(`css ${file}: ${gzipKb(join(dist, 'assets', file)).toFixed(2)} kB gzip (not budgeted)`)

  if (problems.length) {
    for (const p of problems) console.error(`budget: ${p}`)
    return 1
  }
  console.log('budget: ok')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
