import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSettings } from '../context/SettingsContext.jsx'
import { motionReduced } from '../lib/settings.js'
import { activeIndex, buildLines, gridOf, loopTime, osuRow, readoutsOf, spanOf, steppedIndex } from '../lib/strip.js'

/**
 * An example of what an analysis gives back, drawn the way the app draws it:
 * the onset envelope, the beat grid with stronger bar lines, a red line where
 * each timing point goes, and a playhead that plays the example in real time,
 * the readouts following the red line it is in. Four red lines: 174, 186, a
 * bar change to 3/4 and a slower outro at 160 (lib/strip.js). The numbers are
 * an example and the panel says so; nothing here comes from a real song.
 *
 * Everything is placed on one time scale, so a red line sits exactly on its
 * downbeat. The playhead moves by a transform on one SVG element, and React
 * renders again only when the red line under it changes. It stops when the
 * strip is off-screen or the tab hidden; with reduced motion (the system's or
 * the site setting) it does not sweep and steps from line to line instead.
 */
const W = 640
const H = 168
const X0 = 20
const X1 = 620
const TOP = 26
const BASE = 150
const SLOTS = 4

const LINES = buildLines()
const SPAN = spanOf(LINES)
const GRID = gridOf(LINES)
const xOf = (time) => X0 + ((time - SPAN.start) / (SPAN.end - SPAN.start)) * (X1 - X0)

const LEVEL_TONE = { high: 'var(--accent)', medium: 'var(--tempo)', check: 'var(--amber)' }

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

// Attacks on the grid's 1/4 ticks: strongest on the downbeat, then the beat,
// the half and the quarters, some of which are left out.
const ONSETS = (() => {
  const random = mulberry32(174)
  const out = []
  for (const beat of GRID) {
    const length = LINES[beat.line].beatLength
    for (let slot = 0; slot < SLOTS; slot++) {
      const strength = slot === 0 ? (beat.bar ? 0.95 : 0.7) : slot === 2 ? 0.45 : 0.24
      if (slot % 2 === 1 && random() < 0.4) continue
      const height = (BASE - TOP) * strength * (0.62 + 0.38 * random())
      out.push({ x: xOf(beat.time + (slot / SLOTS) * length), height })
    }
  }
  return out
})()

/** Whether motion is cut: the site setting, else the system's preference, followed live. */
function useReducedMotion() {
  const setting = useSettings()?.settings?.reducedMotion ?? 'system'
  const [system, setSystem] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setSystem(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return motionReduced(setting, system)
}

/** Whether `ref`'s element is on screen and the tab visible: the strip runs only then. */
function useRunning(ref) {
  const [onScreen, setOnScreen] = useState(true)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return onScreen && visible
}

export default function TimingStrip() {
  const { t } = useTranslation()
  const figure = useRef(null)
  const playhead = useRef(null)
  const reduced = useReducedMotion()
  const running = useRunning(figure)
  const [active, setActive] = useState(0)
  // Where the example had got to when it last stopped, so it resumes there.
  const elapsed = useRef(0)

  useEffect(() => {
    if (!running) return undefined
    const place = (time) => playhead.current?.setAttribute('transform', `translate(${xOf(time).toFixed(2)} 0)`)

    if (reduced) {
      const show = () => {
        const index = steppedIndex(LINES, elapsed.current)
        setActive(index)
        place(LINES[index].offset)
      }
      show()
      const timer = setInterval(() => {
        elapsed.current += 4000
        show()
      }, 4000)
      return () => clearInterval(timer)
    }

    let frame = 0
    let last = null
    const tick = (now) => {
      if (last !== null) elapsed.current += Math.min(now - last, 100)
      last = now
      const time = loopTime(LINES, elapsed.current)
      place(time)
      const index = activeIndex(LINES, time)
      setActive((current) => (current === index ? current : index))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [running, reduced])

  const line = LINES[active]
  const values = readoutsOf(line)
  const readouts = [
    { label: t('strip.bpm'), value: values.bpm },
    { label: t('strip.offset'), value: values.offset, unit: 'ms' },
    { label: t('strip.meter'), value: values.meter },
    { label: t('strip.confidence'), value: values.confidence, tone: LEVEL_TONE[line.level] },
  ]

  return (
    <figure ref={figure} className="panel overflow-hidden" aria-label={t('strip.caption')}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="label truncate">
          {t('strip.title')} · <span className="readout">{t('strip.line', { n: active + 1, count: LINES.length })}</span>
        </span>
        <span className="chip-accent shrink-0">{t('strip.example')}</span>
      </div>

      <div className="bg-surface-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={t('strip.caption')}>
          {GRID.map((beat, i) => {
            const x = xOf(beat.time)
            return <line key={i} x1={x} x2={x} y1={TOP} y2={BASE} stroke={beat.bar ? 'var(--line-strong)' : 'var(--grid)'} strokeWidth={beat.bar ? 1.2 : 1} />
          })}

          {ONSETS.map((o, i) => (
            <rect key={i} x={o.x - 1.25} y={BASE - o.height} width="2.5" height={o.height} rx="1" fill="var(--onset)" />
          ))}

          <line x1={X0} x2={X1} y1={BASE} y2={BASE} stroke="var(--line-strong)" strokeWidth="1" />

          {LINES.map((l, i) => {
            const x = xOf(l.offset)
            const meterChange = i > 0 && l.meter !== LINES[i - 1].meter
            const label = `${Math.round(l.bpm)}${meterChange ? ` ${l.meter}/4` : ''}`
            const on = i === active
            return (
              <g key={i} opacity={on ? 1 : 0.55}>
                <rect x={x - 1} y={TOP - 4} width="2" height={BASE - TOP + 4} fill="var(--red)" />
                <rect x={x + 1} y={TOP - 4} width={meterChange ? 54 : 30} height="17" rx="2" fill="var(--red)" className="max-sm:hidden" />
                <text x={x + 5} y={TOP + 9} fill="var(--bg)" fontSize="12" fontWeight="700" className="font-mono max-sm:hidden">
                  {label}
                </text>
              </g>
            )
          })}

          <line ref={playhead} x1="0" x2="0" y1={TOP - 6} y2={BASE + 6} stroke="var(--accent)" strokeWidth="1.5" transform={`translate(${xOf(line.offset)} 0)`} />

          {/* Each line's section along the foot, in its confidence level's colour. */}
          {LINES.map((l, i) => (
            <rect key={i} x={xOf(l.offset) + 1} y={BASE + 8} width={Math.max(0, xOf(l.end) - xOf(l.offset) - 2)} height="5" rx="2" fill={LEVEL_TONE[l.level]} opacity={i === active ? 1 : 0.45} />
          ))}
        </svg>
      </div>

      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4" aria-live="off">
        {readouts.map((r) => (
          <div key={r.label} className="min-w-0 space-y-1 bg-surface px-4 py-3">
            <dt className="label">{r.label}</dt>
            <dd className="readout text-title text-text" style={r.tone ? { color: r.tone } : undefined}>
              {r.value}
              {r.unit && <span className="ml-1 text-label text-dim">{r.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2 border-t border-line px-4 py-3">
        <p className="truncate font-mono text-caption text-muted" title={t('strip.osuRow')}>
          <span className="text-dim">[TimingPoints] </span>
          {osuRow(line)}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-dim">
          {['high', 'medium', 'check'].map((key) => (
            <li key={key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: LEVEL_TONE[key] }} />
              {t(`strip.${key}`)}
            </li>
          ))}
        </ul>
      </div>
    </figure>
  )
}
