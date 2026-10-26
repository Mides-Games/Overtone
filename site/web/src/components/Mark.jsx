/**
 * Overtone's mark: a ring (the O, and a sustained tone) cut by one red line,
 * the timing point the tool exists to place.
 */
export default function Mark({ size = 24, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="8" stroke="var(--accent)" strokeWidth="2.6" />
      <rect x="10.9" y="1.5" width="2.2" height="21" rx="1.1" fill="var(--red)" />
    </svg>
  )
}
