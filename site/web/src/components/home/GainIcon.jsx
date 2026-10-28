/**
 * The front page's small line drawings, one per benefit: 24 px, the text
 * colour's stroke, decorative (the heading beside each says it). Red and
 * amber keep the site's meanings: a red line is a timing point, amber is
 * something to check by ear.
 */
const PATHS = {
  // A clock whose hand has jumped forward: time given back.
  time: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
      <path d="M3.5 4.5 6 7" />
    </>
  ),
  // Two red lines over a tempo plot that steps up.
  variable: (
    <>
      <path d="M3 17h6v-5h6V8h6" stroke="var(--tempo)" />
      <path d="M9 4v16M15 4v16" stroke="var(--red)" />
    </>
  ),
  // A package with a downbeat mark: the .osz.
  osz: (
    <>
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" />
      <path d="M4 8.5 12 13l8-4.5M12 13v7" />
    </>
  ),
  // Headphones, with the check-by-ear amber on one cup.
  check: (
    <>
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" stroke="var(--amber)" />
    </>
  ),
  // An open padlock: no account, nothing kept.
  free: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </>
  ),
  // Upload, analyse, check: the three steps.
  upload: <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />,
  analyse: <path d="M3 12h2l2-5 3 10 3-8 2 5 2-2h4" />,
  listen: (
    <>
      <path d="M12 4v16M19 4v16" opacity="0.35" />
      <path d="M5 4v16" stroke="var(--red)" />
      <path d="m9 9 6 3-6 3z" />
    </>
  ),
}

export default function GainIcon({ name, size = 24, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  )
}
