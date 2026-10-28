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
  minus: <path d="M5 12h14" />,
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
  // The result page's controls (docs/design.md, section 11.7: no ▶, ⟲, ✎ or × characters).
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" />,
  loop: (
    <>
      <path d="M4 11.5V10a3 3 0 0 1 3-3h12" />
      <path d="m16 4 3 3-3 3M20 12.5V14a3 3 0 0 1-3 3H5" />
      <path d="m8 20-3-3 3-3" />
    </>
  ),
  edit: <path d="M4.5 19.5h4l10-10a2.83 2.83 0 0 0-4-4l-10 10zM13.5 7l3.5 3.5" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  download: <path d="M12 4.5v11M7.5 11 12 15.5l4.5-4.5M5 19.5h14" />,
  star: <path d="m12 4 2.45 5 5.55.8-4 3.9.95 5.5L12 16.6l-4.95 2.6L8 13.7 4 9.8l5.55-.8z" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  link: <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />,
  sliders: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" />,
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
  // The community and account pages.
  'chevron-up': <path d="m6 15 6-6 6 6" />,
  // Filled, for a rating's earned stars: the outline (star) is the unearned one.
  'star-filled': <path fill="currentColor" d="m12 4 2.45 5 5.55.8-4 3.9.95 5.5L12 16.6l-4.95 2.6L8 13.7 4 9.8l5.55-.8z" />,
  flag: <path d="M5 21V4.5M5 4.5h11l-2 4 2 4H5" />,
  'eye-off': (
    <>
      <path d="M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4.5 9 6-.25.75-1.2 2.3-2.8 3.7M6.5 7.6C4.6 8.9 3.4 10.8 3 12c.5 1.5 4 6 9 6 1.5 0 2.9-.4 4.1-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  eye: (
    <>
      <path d="M3 12c.5-1.5 4-6 9-6s8.5 4.5 9 6c-.5 1.5-4 6-9 6s-8.5-4.5-9-6Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="3.75" />
      <path d="m10.7 12.3 8.8-8.8M16.5 6.5l2.5 2.5M14 9l2 2" />
    </>
  ),
  trash: <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7M10 11v5M14 11v5" />,
  pencil: <path d="M4.5 19.5l1-4.5L15.8 4.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L9 18.5zM13.5 7l3.5 3.5" />,
  bell: (
    <>
      <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 5.5 2.5 7.5 2.5 7.5H4s2.5-2 2.5-7.5" />
      <path d="M10.3 20a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" />
      <path d="M4 4.5v4h4M12 8v4l2.5 1.5" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4.5h8v5a4 4 0 0 1-8 0zM8 6.5H5a3 3 0 0 0 3 3.5M16 6.5h3a3 3 0 0 1-3 3.5" />
      <path d="M12 13.5V17M8.5 19.5h7" />
    </>
  ),
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
