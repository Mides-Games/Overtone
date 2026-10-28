/**
 * The signature drawing (docs/design.md, section 1): a waveform cut by red
 * lines, the thing an analysis gives back. The hero shows the real one
 * (components/TimingStrip.jsx); this is its quiet form, for section dividers
 * and empty states. Seeded, so it is the same on every load, and decorative:
 * hidden from screen readers, with nothing in it a reader needs.
 *
 * - `bars`: how many attacks across the width.
 * - `lines`: where the red lines fall, as fractions of the width.
 * - `seed`: a different song.
 * The drawing stretches to its box; its height is the box's.
 */
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The bars' heights, 0-1: strong every fourth, a slow swell across the width. */
export function waveBars(count, seed = 7) {
  const random = mulberry32(seed)
  return Array.from({ length: count }, (_, i) => {
    const swell = 0.55 + 0.45 * Math.sin((i / count) * Math.PI)
    const accent = i % 4 === 0 ? 1 : i % 2 === 0 ? 0.62 : 0.4
    return Math.max(0.08, Math.min(1, accent * swell * (0.6 + 0.4 * random())))
  })
}

export default function Waveform({ bars = 96, lines = [0.25, 0.75], seed = 7, className = '', mirrored = true }) {
  const heights = waveBars(bars, seed)
  const W = bars * 4
  const H = 40
  const mid = mirrored ? H / 2 : H
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" className={`block ${className}`}>
      {heights.map((h, i) => {
        const size = (mirrored ? H / 2 : H) * h
        return <rect key={i} x={i * 4 + 1} y={mirrored ? mid - size : H - size} width="2" height={mirrored ? size * 2 : size} rx="1" fill="var(--onset)" />
      })}
      {lines.map((at) => (
        <line key={at} x1={at * W} x2={at * W} y1="0" y2={H} stroke="var(--red)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  )
}

/** A section divider: one hairline with a short stretch of waveform and a red line on it. */
export function WaveRule({ className = '', seed = 11 }) {
  return (
    <div aria-hidden="true" className={`flex items-center gap-4 ${className}`}>
      <span className="h-px flex-1 bg-line" />
      <Waveform bars={40} lines={[0.5]} seed={seed} className="h-6 w-40 shrink-0 opacity-80" />
      <span className="h-px w-10 bg-line" />
    </div>
  )
}
