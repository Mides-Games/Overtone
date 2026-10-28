/**
 * The `/developers` page's arrangement of the reduced OpenAPI document
 * (scripts/openapi.mjs): pure, so the tests reach it without a browser.
 */

/** Operations grouped by their path's first segment, in the document's order. */
export function groupOperations(operations) {
  const groups = new Map()
  for (const op of operations) {
    const name = op.path.split('/')[1] || '/'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(op)
  }
  return [...groups].map(([name, list]) => ({ name: `/${name}`, operations: list }))
}

/** A description as paragraphs: blank lines split them, single line breaks are spaces. */
export function prose(text) {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
}
