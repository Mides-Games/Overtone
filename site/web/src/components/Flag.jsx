/**
 * The languages' flags (W12.16), drawn inline: emoji flags do not render on
 * Windows, and image files would be ten more requests. Each is simplified to
 * read at 16-20 px wide, on one 3:2 box so a column of them lines up, with
 * the flag's own colours. Decorative: the language's name always sits beside
 * it, so the flag is hidden from screen readers.
 *
 * Spanish is Spain's flag (the owner's choice, 2026-10-28); English is the
 * United Kingdom's; Portuguese is Brazil's.
 */

const stripes = (colors, vertical = false) =>
  colors.map((fill, i) =>
    vertical ? (
      <rect key={i} x={(30 / colors.length) * i} width={30 / colors.length + 0.05} height="20" fill={fill} />
    ) : (
      <rect key={i} y={(20 / colors.length) * i} width="30" height={20 / colors.length + 0.05} fill={fill} />
    ),
  )

/** A trigram of the South Korean flag: three bars, `true` solid, `false` broken. */
function Trigram({ x, y, angle, bars }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${angle})`}>
      {bars.map((solid, i) =>
        solid ? (
          <rect key={i} x={-1.25 + i * 0.95} y="-1.75" width="0.6" height="3.5" />
        ) : (
          <g key={i}>
            <rect x={-1.25 + i * 0.95} y="-1.75" width="0.6" height="1.5" />
            <rect x={-1.25 + i * 0.95} y="0.25" width="0.6" height="1.5" />
          </g>
        ),
      )}
    </g>
  )
}

const FLAGS = {
  // United Kingdom: the Union Jack, its counterchanged saltire simplified to a centred one.
  gb: (
    <>
      <rect width="30" height="20" fill="#012169" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#fff" strokeWidth="4" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#C8102E" strokeWidth="1.4" />
      <path d="M15 0V20M0 10H30" stroke="#fff" strokeWidth="6" />
      <path d="M15 0V20M0 10H30" stroke="#C8102E" strokeWidth="3.4" />
    </>
  ),
  // Spain: red, yellow twice as tall, red; the coat of arms as a small
  // red-and-gold shield toward the hoist, which is what reads at 16 px.
  es: (
    <>
      <rect width="30" height="20" fill="#AA151B" />
      <rect y="5" width="30" height="10" fill="#F1BF00" />
      <rect x="7" y="7.2" width="3.6" height="5" rx="0.6" fill="#AD1519" />
      <rect x="7.6" y="7.8" width="2.4" height="2.2" fill="#F1BF00" opacity="0.85" />
    </>
  ),
  fr: stripes(['#0055A4', '#fff', '#EF4135'], true),
  de: stripes(['#000', '#DD0000', '#FFCE00']),
  it: stripes(['#009246', '#fff', '#CE2B37'], true),
  pl: stripes(['#fff', '#DC143C']),
  // Brazil: the yellow rhombus and the blue globe with its white band; the stars are too small to keep.
  br: (
    <>
      <rect width="30" height="20" fill="#009C3B" />
      <path d="M15 2.2L27.4 10L15 17.8L2.6 10Z" fill="#FFDF00" />
      <circle cx="15" cy="10" r="5" fill="#002776" />
      <path d="M10.2 8.9Q15 7.6 19.9 11" stroke="#fff" strokeWidth="0.9" fill="none" />
    </>
  ),
  jp: (
    <>
      <rect width="30" height="20" fill="#fff" />
      <circle cx="15" cy="10" r="6" fill="#BC002D" />
    </>
  ),
  // South Korea: the taegeuk, red over blue on the flag's diagonal, and the four trigrams.
  kr: (
    <>
      <rect width="30" height="20" fill="#fff" />
      <g transform="rotate(33.69 15 10)">
        <circle cx="15" cy="10" r="5" fill="#0047A0" />
        <path d="M10 10A5 5 0 0 1 20 10A2.5 2.5 0 0 0 15 10A2.5 2.5 0 0 1 10 10Z" fill="#CD2E3A" />
      </g>
      <g fill="#000">
        <Trigram x={7.7} y={5.1} angle={33.69} bars={[true, true, true]} />
        <Trigram x={22.3} y={14.9} angle={33.69} bars={[false, false, false]} />
        <Trigram x={22.3} y={5.1} angle={-33.69} bars={[false, true, false]} />
        <Trigram x={7.7} y={14.9} angle={-33.69} bars={[true, false, true]} />
      </g>
    </>
  ),
  ru: stripes(['#fff', '#0039A6', '#D52B1E']),
}

/** `code` is a flag id from lib/languages.js (`gb`, `ar`, ...); `size` the width in px. */
export default function Flag({ code, size = 18, className = '' }) {
  const flag = FLAGS[code]
  if (!flag) return null
  return (
    <svg
      viewBox="0 0 30 20"
      width={size}
      height={(size * 2) / 3}
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 rounded-[2px] ${className}`}
    >
      {flag}
      {/* A hairline edge, so the white of Japan, Poland or Russia does not melt into a light page. */}
      <rect x="0.25" y="0.25" width="29.5" height="19.5" fill="none" stroke="#000" strokeOpacity="0.18" strokeWidth="0.5" />
    </svg>
  )
}

export const FLAG_IDS = Object.keys(FLAGS)
