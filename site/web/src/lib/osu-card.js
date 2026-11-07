/**
 * The osu! card's arithmetic (2026-11-07), apart from its drawing so the
 * tests can hold it: the rank line, the months, the grades and the maps.
 * Everything here reads the card the API sends (`osu.details`,
 * site/api services/osu.service.js `cleanDetails`); nothing asks osu!.
 */

/** osu!'s own names for its rulesets: names, not words, so they are not translated. */
export const MODE_NAMES = { osu: 'osu!', taiko: 'osu!taiko', fruits: 'osu!catch', mania: 'osu!mania' }

/** osu!'s order, best first; `silver` is the hidden or flashlight version of the grade. */
export const GRADES = [
  { key: 'ssh', letter: 'SS', silver: true },
  { key: 'ss', letter: 'SS', silver: false },
  { key: 'sh', letter: 'S', silver: true },
  { key: 's', letter: 'S', silver: false },
  { key: 'a', letter: 'A', silver: false },
]

/**
 * The beatmap set states the card draws, in osu!'s order, each with its
 * colour token. Favourites and nominations are counted beside them: they are
 * other people's maps, not a share of the mapper's own.
 */
export const MAP_STATES = [
  { key: 'ranked', tone: 'accent' },
  { key: 'loved', tone: 'red' },
  { key: 'guest', tone: 'compare' },
  { key: 'pending', tone: 'amber' },
  { key: 'graveyard', tone: 'onset' },
]

/** Whole hours of play, rounded down: osu! shows days and hours, a card needs one number. */
export const playHours = (seconds) => (Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds / 3600) : null)

/** The first and last known rank of the history, and how many places it moved (positive: up the ladder). */
export function rankSpan(history) {
  const known = (history ?? []).filter((r) => Number.isFinite(r))
  if (!known.length) return null
  const from = known[0]
  const to = known.at(-1)
  return { from, to, best: Math.min(...known), worst: Math.max(...known), change: from - to }
}

/**
 * The rank line in a `width` x `height` box, inset by `pad`: day 0 at the
 * left, today at the right, a better (smaller) rank higher. A day osu! had no
 * rank for breaks the line instead of being drawn as a drop. A flat history
 * sits in the middle.
 */
export function rankLine(history, width, height, pad = 4) {
  const days = history?.length ?? 0
  const span = rankSpan(history)
  if (!span || width <= 2 * pad || height <= 2 * pad) return null
  const x = (i) => (days === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (days - 1))
  const range = span.worst - span.best
  const y = (rank) => (range === 0 ? height / 2 : pad + ((rank - span.best) * (height - 2 * pad)) / range)
  const points = []
  const runs = []
  let d = ''
  let open = false
  history.forEach((rank, i) => {
    if (!Number.isFinite(rank)) {
      open = false
      return
    }
    const p = { i, rank, x: round(x(i)), y: round(y(rank)) }
    points.push(p)
    if (open) runs.at(-1).push(p)
    else runs.push([p])
    d += `${open ? 'L' : 'M'}${p.x} ${p.y}`
    open = true
  })
  // The shade under each unbroken run, down to the box's floor; a lone day has none.
  const area = runs
    .filter((run) => run.length > 1)
    .map((run) => `M${run[0].x} ${height}${run.map((p) => `L${p.x} ${p.y}`).join('')}L${run.at(-1).x} ${height}Z`)
    .join('')
  return { d, area, points, ...span }
}

const round = (n) => Math.round(n * 10) / 10

/** The point nearest to `px` along the line, for the pointer's readout. */
export function nearestPoint(points, px) {
  let best = null
  for (const p of points ?? []) if (!best || Math.abs(p.x - px) < Math.abs(best.x - px)) best = p
  return best
}

/** The date of day `i` of a `days`-long history read on `asOf` (its last day). */
export function historyDate(asOf, days, i) {
  const end = new Date(asOf ?? Date.now())
  if (Number.isNaN(end.getTime())) return null
  return new Date(end.getTime() - (days - 1 - i) * 86_400_000)
}

/**
 * Every month from the first listed to the last, a month osu! left out (no
 * plays) as 0: osu! lists only the months something was played, and a chart
 * of them would close the gaps.
 */
export function fillMonths(months) {
  const listed = (months ?? []).filter((m) => /^\d{4}-\d{2}$/.test(m?.month) && Number.isFinite(m.count))
  if (!listed.length) return []
  const counts = new Map(listed.map((m) => [m.month, m.count]))
  const keys = [...counts.keys()].sort()
  const [y0, m0] = keys[0].split('-').map(Number)
  const [y1, m1] = keys.at(-1).split('-').map(Number)
  const out = []
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push({ month: key, count: counts.get(key) ?? 0 })
    if (out.length > 600) break
  }
  return out
}

/** The month with the most plays (the latest of a tie), or `null` with none. */
export const busiestMonth = (months) =>
  (months ?? []).reduce((best, m) => (m.count > 0 && (!best || m.count >= best.count) ? m : best), null)

/** The beatmap set states that have any, with their share of the bar in percent (one decimal). */
export function mapShares(maps) {
  const parts = MAP_STATES.map((s) => ({ ...s, count: Number.isFinite(maps?.[s.key]) ? maps[s.key] : 0 })).filter((s) => s.count > 0)
  const total = parts.reduce((sum, s) => sum + s.count, 0)
  return { total, parts: parts.map((s) => ({ ...s, share: Math.round((1000 * s.count) / total) / 10 })) }
}

/** A month key as the reader's language writes it ("Jun 2024", "jun 2024"). */
export function monthName(key, language, style = 'short') {
  const [y, m] = String(key).split('-').map(Number)
  if (!y || !m) return String(key)
  try {
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(language, { month: style, year: 'numeric', timeZone: 'UTC' })
  } catch {
    return String(key)
  }
}
