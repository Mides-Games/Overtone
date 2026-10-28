/**
 * A loading placeholder shaped like what it stands in for (docs/design.md,
 * section 6): no spinner for a wait under 300 ms, and no jump when the content
 * lands. `Skeleton` is one block; size it with classes (`h-3 w-2/5`).
 * `SkeletonRows` is a list of rows the shape of TimingList's.
 *
 * The block is decorative; the container that waits says so to a screen
 * reader (`role="status"` with a label, or `aria-busy` on the region).
 */
export default function Skeleton({ className = '' }) {
  return <span aria-hidden="true" className={`skeleton block ${className}`} />
}

export function SkeletonRows({ rows = 3, label, className = '' }) {
  return (
    <ul className={`divide-y divide-line ${className}`} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 py-3" aria-hidden="true">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <span className="flex-1 space-y-2">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-1/4 opacity-70" />
          </span>
          <Skeleton className="h-3 w-14" />
        </li>
      ))}
    </ul>
  )
}
