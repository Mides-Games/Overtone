/**
 * The statistics page's arithmetic (W12.13), pure so the tests reach it:
 * how a bucket is named and how the shares are rounded. The numbers come from
 * `GET /api/v1/stats`; nothing here counts anything itself.
 */

/** A bucket's name: `{ key, values }` for i18n, from its open or closed edges. */
export function bucketName({ from, to }) {
  if (from === null || from === undefined) return { key: 'siteStats.bpm.below', values: { to } }
  if (to === null || to === undefined) return { key: 'siteStats.bpm.above', values: { from } }
  return { key: 'siteStats.bpm.range', values: { from, to } }
}

/**
 * Whole-percent shares of `counts` that add up to 100 (largest remainder), or
 * all zeros when there is nothing to share. Rounding each one alone can show
 * 33 + 33 + 33.
 */
export function shares(counts) {
  const total = counts.reduce((sum, n) => sum + n, 0)
  if (!total) return counts.map(() => 0)
  const raw = counts.map((n) => (n * 100) / total)
  const out = raw.map(Math.floor)
  let left = 100 - out.reduce((sum, n) => sum + n, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i] += 1
    left -= 1
  }
  return out
}

/** The bar lengths of a histogram, 0..1 of the longest; all zero when empty. */
export function barScale(counts) {
  const top = Math.max(0, ...counts)
  return counts.map((n) => (top ? n / top : 0))
}
