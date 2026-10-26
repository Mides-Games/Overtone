import { useTranslation } from 'react-i18next'

/**
 * An example of what an analysis gives back, drawn the way the app draws it:
 * the onset envelope, the beat grid with stronger bar lines, red lines where
 * timing points go, and a playhead. Four bars of 4/4 at 174 BPM. The numbers
 * are an example and the panel says so; nothing here comes from a real song.
 *
 * Everything is placed on one scale: 16 beats across the plot, 4 onset slots
 * per beat, so a red line sits exactly on its downbeat.
 */
const W = 640
const H = 168
const X0 = 20
const X1 = 620
const TOP = 26
const BASE = 150
const BEATS = 16
const SLOTS = 4
const BEAT_W = (X1 - X0) / BEATS
const RED_LINE_BARS = [0, 2]

// A seeded generator, so the drawing is the same on every load and in tests.
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ONSETS = (() => {
  const random = mulberry32(174)
  const out = []
  for (let beat = 0; beat < BEATS; beat++) {
    for (let slot = 0; slot < SLOTS; slot++) {
      const strength = slot === 0 ? (beat % 4 === 0 ? 0.95 : 0.72) : slot === 2 ? 0.46 : 0.26
      if (slot % 2 === 1 && random() < 0.35) continue
      const height = (BASE - TOP) * strength * (0.62 + 0.38 * random())
      out.push({ x: X0 + (beat + slot / SLOTS) * BEAT_W, height })
    }
  }
  return out
})()

const SECTIONS = [
  { share: 50, tone: 'var(--accent)', key: 'high' },
  { share: 32, tone: 'var(--lavender)', key: 'medium' },
  { share: 18, tone: 'var(--amber)', key: 'check' },
]

export default function TimingStrip() {
  const { t } = useTranslation()

  const readouts = [
    { label: t('strip.bpm'), value: '174.00' },
    { label: t('strip.offset'), value: '1 284', unit: 'ms' },
    { label: t('strip.meter'), value: '4/4' },
    { label: t('strip.confidence'), value: '0.93' },
  ]

  return (
    <figure className="panel overflow-hidden" aria-label={t('strip.caption')}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="label">{t('strip.title')}</span>
        <span className="chip-accent">{t('strip.example')}</span>
      </div>

      <div className="relative bg-surface-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={t('strip.caption')}>
          {Array.from({ length: BEATS + 1 }, (_, beat) => {
            const x = X0 + beat * BEAT_W
            const bar = beat % 4 === 0
            return (
              <g key={beat}>
                <line x1={x} x2={x} y1={TOP} y2={BASE} stroke={bar ? 'var(--line-strong)' : 'var(--grid)'} strokeWidth={bar ? 1.2 : 1} />
                {bar && beat < BEATS && (
                  <text x={x + 4} y={TOP - 8} fill="var(--dim)" fontSize="10" className="font-mono">
                    {beat / 4 + 1}
                  </text>
                )}
              </g>
            )
          })}

          {ONSETS.map((o, i) => (
            <rect key={i} x={o.x - 1.5} y={BASE - o.height} width="3" height={o.height} rx="1" fill="var(--onset)" />
          ))}

          <line x1={X0} x2={X1} y1={BASE} y2={BASE} stroke="var(--line-strong)" strokeWidth="1" />

          {RED_LINE_BARS.map((bar) => {
            const x = X0 + bar * 4 * BEAT_W
            return (
              <g key={bar}>
                <rect x={x - 1} y={TOP - 4} width="2" height={BASE - TOP + 4} fill="var(--red)" />
                <rect x={x + 1} y={TOP + 2} width="44" height="15" rx="2" fill="var(--red)" />
                <text x={x + 5} y={TOP + 13} fill="var(--bg)" fontSize="10" fontWeight="600" className="font-mono">
                  174.00
                </text>
              </g>
            )
          })}
        </svg>

        <div className="pointer-events-none absolute inset-y-[15%] left-[3.125%] right-[3.125%]" aria-hidden="true">
          <div className="playhead h-full w-full border-l border-accent" />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
        {readouts.map((r) => (
          <div key={r.label} className="space-y-1 bg-surface px-4 py-3">
            <dt className="label">{r.label}</dt>
            <dd className="readout text-title text-text">
              {r.value}
              {r.unit && <span className="ml-1 text-label text-dim">{r.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2 border-t border-line px-4 py-3">
        <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
          {SECTIONS.map((s) => (
            <span key={s.key} style={{ width: `${s.share}%`, background: s.tone }} />
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-dim">
          {SECTIONS.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.tone }} />
              {t(`strip.${s.key}`)}
            </li>
          ))}
        </ul>
      </div>
    </figure>
  )
}
