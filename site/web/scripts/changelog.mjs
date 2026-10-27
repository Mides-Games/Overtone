import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The site's changelog (W5.5), read from `docs/timeline.md` at build time.
 *
 * The timeline is the engineering log, one entry per release:
 *
 *   ## <version> — <date> · <title>
 *   ### Changed
 *   - a bullet, wrapped
 *     over lines
 *
 * This keeps the latest LIMIT entries' version, date, title and "Changed"
 * bullets, and nothing else: Fixed, Hardening and Measured are for the people
 * who build the site, and the full log is one click away in the repository.
 *
 * Inline markdown becomes tokens, never HTML: text, `code`, **strong**, and
 * links. Only an absolute http(s) link stays a link; a relative one (the
 * timeline's links point at other docs, relative to wherever it is read) is
 * kept as its text. The page renders tokens as React elements, so nothing in
 * the timeline can become markup on the site.
 *
 * `vite.config.js` serves the result as the `virtual:changelog` module, so
 * every build and every dev server reads the timeline as it is then. Run this
 * file directly to print the JSON.
 */

export const LIMIT = 30

export const timelinePath = fileURLToPath(new URL('../../../docs/timeline.md', import.meta.url))

const HEADING = /^## (.+?) — (\d{4}-\d{2}-\d{2}) · (.+)$/
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

/** Inline markdown as `[{ t: 'text' | 'code' | 'strong' | 'link', v, href? }]`. */
export const inline = (source) => {
  const tokens = []
  const push = (t, v, href) => {
    if (!v) return
    const last = tokens[tokens.length - 1]
    // Neighbouring text merges, so a dropped link reads as one run of words.
    if (t === 'text' && last?.t === 'text') last.v += v
    else tokens.push(href ? { t, v, href } : { t, v })
  }
  let at = 0
  for (const match of source.matchAll(INLINE)) {
    push('text', source.slice(at, match.index))
    const [, code, strong, label, href] = match
    if (code !== undefined) push('code', code)
    else if (strong !== undefined) push('strong', strong)
    else if (/^https?:\/\//i.test(href)) push('link', label.replace(/`/g, ''), href)
    else push('text', label.replace(/`/g, ''))
    at = match.index + match[0].length
  }
  push('text', source.slice(at))
  return tokens
}

/** The latest `limit` entries of a timeline, newest first, as it is written. */
export const parseTimeline = (markdown, { limit = LIMIT } = {}) => {
  const entries = []
  let entry = null
  let section = null
  let bullet = null

  const flush = () => {
    if (bullet !== null && entry) entry.changed.push(inline(bullet.replace(/\s+/g, ' ').trim()))
    bullet = null
  }

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      if (entries.length >= limit) break
      entry = { version: heading[1].trim(), date: heading[2], title: heading[3].trim(), changed: [] }
      entries.push(entry)
      section = null
      continue
    }
    if (line.startsWith('## ') || line === '---') {
      // A heading of another shape, or the rule between entries: neither
      // belongs to the entry before it.
      flush()
      if (line.startsWith('## ')) entry = null
      section = null
      continue
    }
    if (line.startsWith('### ')) {
      flush()
      section = line.slice(4).trim()
      continue
    }
    if (!entry || section !== 'Changed') continue

    const item = /^\s*[-*] (.*)$/.exec(line)
    if (item) {
      flush()
      bullet = item[1]
    } else if (!line.trim()) {
      flush()
    } else if (bullet !== null) {
      bullet += ` ${line.trim()}`
    } else {
      // A paragraph under "Changed" with no bullet: it reads as one.
      bullet = line.trim()
    }
  }
  flush()
  return entries
}

export const readChangelog = (path = timelinePath, options) => parseTimeline(readFileSync(path, 'utf8'), options)

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(readChangelog(), null, 2)}\n`)
}
