/**
 * The site's one icon set (docs/design.md, section 6): line icons on a 24 px
 * grid, a 1.5 px stroke in the text's colour, drawn inline so nothing is
 * fetched. No emoji, ever. Decorative by default (`aria-hidden`): the button
 * or link around an icon carries the name. Pass `label` only for an icon that
 * stands alone and means something, and it becomes an image with that name.
 *
 * The reserved colours keep their meanings inside icons too: a red stroke is
 * a red line, amber is "check by ear", tempo is the tempo curve.
 */
const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 2.75v2M12 19.25v2M4.75 12h-2M21.25 12h-2M6.87 6.87 5.46 5.46M18.54 18.54l-1.41-1.41M6.87 17.13l-1.41 1.41M18.54 5.46l-1.41 1.41" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  external: <path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />,
  list: <path d="M4 6h16M4 12h10M4 18h7" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5s1.1-6.2 3.5-8.5Z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.75 20a7.25 7.25 0 0 1 14.5 0" />
    </>
  ),
  // The product's own marks.
  upload: <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />,
  wave: <path d="M3 12h2l2-5 3 10 3-8 2 5 2-2h4" />,
  listen: (
    <>
      <path d="M12 4v16M19 4v16" opacity="0.35" />
      <path d="M5 4v16" stroke="var(--red)" />
      <path d="m9 9 6 3-6 3z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  'red-lines': (
    <>
      <path d="M3 17h6v-5h6V8h6" stroke="var(--tempo)" />
      <path d="M9 4v16M15 4v16" stroke="var(--red)" />
    </>
  ),
  package: (
    <>
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" />
      <path d="M4 8.5 12 13l8-4.5M12 13v7" />
    </>
  ),
  headphones: (
    <>
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" stroke="var(--amber)" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />,
  desktop: <path d="M3 5h18v11H3zM8 20h8M12 16v4" />,
  'not-affiliated': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.75" y="6" width="18.5" height="12" rx="2" />
      <path d="M6.5 9.5h1M10 9.5h1M13.5 9.5h1M17 9.5h.5M6.5 12h1M10 12h1M13.5 12h1M17 12h.5M8 15h8" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
}

export const ICONS = Object.keys(PATHS)

export default function Icon({ name, size = 18, label, className = '', strokeWidth = 1.5 }) {
  const named = Boolean(label)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={named ? undefined : 'true'}
      role={named ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  )
}
