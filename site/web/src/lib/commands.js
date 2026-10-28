/**
 * The command palette's ranking and the global shortcuts' rules (W12.14).
 * Pure, so the tests reach them without a browser; the palette itself is
 * components/CommandPalette.jsx.
 *
 * The ranking is a subsequence match, the way editors' palettes match: every
 * typed character must appear in order, and a match scores higher the more of
 * it falls on word starts and in runs. "rcnt" finds "Recent", "an res" finds
 * "Analysis result". Accents and case are ignored on both sides, so "analisis"
 * finds "Análisis".
 */

/** Lower case, accents off, so "Análisis" and "analisis" compare equal. Keeps the length. */
export const fold = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const SEPARATOR = /[\s\-_./·:()[\]]/

/**
 * How well `query` matches `text`, and where: `{ score, positions }`, or null
 * when some character of the query is missing. Spaces in the query are free
 * (they separate words, they do not have to match). Greedy, but each
 * character prefers a word start over the next plain occurrence, which is
 * what makes initials match ("ar" → "Analysis Result" on its two capitals).
 */
function walk(q, t, preferStarts) {
  const positions = []
  let from = 0
  for (const ch of q) {
    let at = -1
    for (let i = from; i < t.length; i++) {
      if (t[i] !== ch) continue
      if (at < 0) at = i
      if (!preferStarts) break
      // A run beats a later word start: keep the first hit if it continues the previous one.
      if (positions.length && at === positions.at(-1) + 1) break
      if (i === 0 || SEPARATOR.test(t[i - 1])) {
        at = i
        break
      }
    }
    if (at < 0) return null
    positions.push(at)
    from = at + 1
  }
  return positions
}

export function fuzzyMatch(query, text) {
  const q = fold(query).replace(/\s+/g, '')
  if (!q) return { score: 0, positions: [] }
  const t = fold(text)
  // Jumping to a word start can strand a later character ("ab" in "xab a"):
  // then the plain leftmost walk, which finds any subsequence there is.
  // Positions index the folded string, one character per base letter for
  // precomposed accents, which is how the labels here are written.
  const positions = walk(q, t, true) ?? walk(q, t, false)
  if (!positions) return null

  let score = 0
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k]
    score += 1
    if (i === 0) score += 8
    else if (SEPARATOR.test(t[i - 1])) score += 6
    if (k > 0 && i === positions[k - 1] + 1) score += 4
    else if (k > 0) score -= Math.min(3, (i - positions[k - 1] - 1) * 0.5)
  }
  // The whole label typed beats a longer one that happens to start the same.
  if (t === q) score += 20
  else if (t.startsWith(q)) score += 10
  score -= t.length * 0.02
  return { score, positions }
}

/**
 * The commands that match `query`, best first. Each command is
 * `{ id, label, keywords? }`; a keyword match counts a little less than the
 * label's own, so "theme" finds both "Dark theme" and "Settings" but lists the
 * theme first. Ties keep the order the commands came in, which is the
 * palette's order for an empty query: recent analyses, pages, then actions.
 * Each result carries the label's matched `positions`, for highlighting.
 */
export function rankCommands(query, commands, { limit = 50 } = {}) {
  const typed = fold(query).trim()
  if (!typed) return commands.slice(0, limit).map((command) => ({ command, positions: [] }))
  const ranked = []
  commands.forEach((command, order) => {
    const own = fuzzyMatch(typed, command.label)
    let best = own ? { score: own.score, positions: own.positions } : null
    for (const keyword of command.keywords ?? []) {
      const hit = fuzzyMatch(typed, keyword)
      if (hit && (!best || hit.score - 2 > best.score)) best = { score: hit.score - 2, positions: [] }
    }
    if (best) ranked.push({ command, order, ...best })
  })
  ranked.sort((a, b) => b.score - a.score || a.order - b.order)
  return ranked.slice(0, limit).map(({ command, positions }) => ({ command, positions }))
}

/**
 * Whether a key pressed on `target` is someone typing: a text field, a text
 * area, a select or an editable region. A slider, a checkbox or a button is
 * not typing, so the result page's keys still work after one is clicked.
 * Duck-typed (tagName, type, isContentEditable), so the tests pass plain objects.
 */
const NOT_TEXT = ['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']

export function isTyping(target) {
  if (!target || typeof target !== 'object') return false
  if (target.isContentEditable) return true
  const tag = String(target.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NOT_TEXT.includes(String(target.type ?? 'text').toLowerCase())
  return false
}

/**
 * The global shortcut a keydown asks for: 'palette' (Ctrl+K, or ⌘K on a Mac),
 * 'help' (?), or null. Ctrl+K is a chord, never a character, so it opens the
 * palette from inside a field too, as it does in editors; `?` is a character,
 * so it is someone typing whenever the focus is in a field.
 */
export function globalShortcut(event) {
  if (!event || event.isComposing || event.repeat) return null
  const key = String(event.key ?? '')
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key.toLowerCase() === 'k') return 'palette'
  if (key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target)) return 'help'
  return null
}
