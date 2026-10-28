import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'
import { NUDGE_STEP_MS, clampNudge, overlayParams, overlaySearch, overlayState, pulseLevel } from '../lib/overlay.js'
import { adjustLines, formatBpm } from '../lib/timing.js'
import { publicTiming, songLine } from '../lib/timings.js'

/**
 * `/overlay/<id>` (W13.23): a published timing as a stream overlay, for OBS's
 * browser source. A transparent page with no chrome (index.html marks the
 * path before the first frame, index.css clears the background): the BPM in
 * force, which red line of how many, the beats of the bar, and a pulse on
 * every beat.
 *
 * It cannot hear the stream, and says so until it is started: it counts from
 * a start time, given by a key (Space or S, through OBS's "Interact") as the
 * song starts, or by `?t0=<epoch ms>` in the URL. Starting writes `t0` into
 * the address, so OBS refreshing the source keeps the sync; ← and → nudge it
 * by 10 ms, Esc stops. deploy/web/serve.mjs lets this path, like /embed, be
 * framed by any site; there is nothing on it to click.
 *
 * The pulse is drawn by a frame loop writing two style properties on one
 * element, not by re-rendering React sixty times a second: React only
 * re-renders when the beat, the line or the phase changes.
 */
export default function Overlay() {
  const { t } = useTranslation()
  const { id } = useParams()
  const [timing, setTiming] = useState(null)
  const [error, setError] = useState(null)
  const [sync, setSync] = useState(() => overlayParams(window.location.search))
  const [view, setView] = useState({ phase: 'waiting', line: 0, barBeat: null, key: null, secondsToGo: null })
  const pulseRef = useRef(null)
  usePageMeta(timing ? `${songLine(timing) ?? t('timings.untitled')} · ${t('platform.overlay.title')}` : t('platform.overlay.title'))

  // index.html sets it on a direct load; this covers arriving from inside the app, and leaving.
  useEffect(() => {
    const root = document.documentElement.classList
    const had = root.contains('overlay')
    root.add('overlay')
    return () => {
      if (!had) root.remove('overlay')
    }
  }, [])

  useEffect(() => {
    let alive = true
    publicTiming(id)
      .then((data) => alive && setTiming(data))
      .catch((failure) => alive && setError(failure.status === 404 ? 'notFound' : 'network'))
    return () => {
      alive = false
    }
  }, [id])

  const lines = useMemo(() => (timing ? adjustLines(timing.result) : []), [timing])
  const durationMs = (timing?.result?.duration_s ?? 0) * 1000 || Infinity

  // The keys. In OBS they arrive through the source's "Interact" window.
  useEffect(() => {
    const onKey = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key
      let next = null
      if (key === ' ' || key === 's' || key === 'S') next = { ...sync, t0: Date.now() }
      else if (key === 'Escape') next = { t0: null, nudgeMs: 0 }
      else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        next = { ...sync, nudgeMs: clampNudge(sync.nudgeMs + (key === 'ArrowRight' ? NUDGE_STEP_MS : -NUDGE_STEP_MS)) }
      }
      if (!next) return
      event.preventDefault()
      setSync(next)
      window.history.replaceState(null, '', `${window.location.pathname}${overlaySearch(window.location.search, next)}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sync])

  // The frame loop: the clock, the pulse, and a re-render only on a change.
  useEffect(() => {
    if (!lines.length) return undefined
    let frame = 0
    let last = ''
    // The settings page's choice first (W12.15), else the system's.
    const root = document.documentElement.classList
    const reduced = root.contains('motion-reduce') || (!root.contains('motion-allow') && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches))
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const started = sync.t0 !== null
      const songMs = started ? Date.now() - sync.t0 + sync.nudgeMs : -1
      const state = started ? overlayState(lines, songMs, durationMs) : { phase: 'idle', line: 0, barBeat: null, key: null, sinceBeatMs: null }
      const secondsToGo = state.phase === 'waiting' && started ? Math.ceil(-songMs / 1000) : null
      const signature = `${state.phase}|${state.line}|${state.key}|${secondsToGo}`
      if (signature !== last) {
        last = signature
        setView({ phase: state.phase, line: state.line, barBeat: state.barBeat, key: state.key, secondsToGo })
      }
      const level = pulseLevel(state.sinceBeatMs, lines[state.line]?.beatMs)
      const pulse = pulseRef.current
      if (pulse) {
        // Reduced motion: the flash without the swell.
        pulse.style.opacity = String(0.25 + 0.75 * level)
        pulse.style.transform = reduced ? 'none' : `scale(${1 + 0.35 * level})`
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [lines, durationMs, sync])

  if (error) {
    return <p className="overlay-text p-4 text-label">{error === 'notFound' ? t('platform.embed.notFound') : t('platform.embed.failed')}</p>
  }
  if (!timing) return <p className="overlay-text p-4 text-label">{t('platform.embed.loading')}</p>

  const line = lines[view.line] ?? lines[0]
  const meter = line?.meter ?? 4
  const idle = view.phase === 'idle'

  return (
    <div className="overlay-text flex min-h-screen flex-col items-start gap-3 p-4">
      <div className="flex items-center gap-4">
        <span ref={pulseRef} className={`overlay-pulse ${view.barBeat === 0 ? 'overlay-pulse-bar' : ''}`} aria-hidden="true" />
        <div>
          <p className="readout text-[clamp(2rem,1.4rem+3vw,3.5rem)] font-bold leading-none">
            {formatBpm(line?.bpm)}
            <span className="ml-2 text-title font-semibold">BPM</span>
          </p>
          <p className="readout mt-1 text-label">
            {t('platform.overlay.line', { index: view.line + 1, total: lines.length })}
            {meter !== 4 ? ` · ${meter}/4` : ''}
          </p>
        </div>
      </div>
      <ol className="flex gap-1.5" aria-label={t('platform.overlay.bar')}>
        {Array.from({ length: Math.min(meter, 16) }, (_, i) => (
          <li key={i} className={`overlay-dot ${view.barBeat === i ? 'overlay-dot-on' : ''} ${i === 0 ? 'overlay-dot-first' : ''}`} />
        ))}
      </ol>
      {view.phase === 'waiting' && view.secondsToGo !== null && (
        <p className="readout text-label">{t('platform.overlay.countIn', { count: view.secondsToGo })}</p>
      )}
      {view.phase === 'ended' && <p className="text-label">{t('platform.overlay.ended')}</p>}
      {idle && (
        <div className="max-w-[46ch] space-y-1.5 rounded-panel bg-black/70 p-3 text-caption leading-relaxed text-white">
          <p className="font-semibold">{songLine(timing) ?? t('timings.untitled')}</p>
          <p>{t('platform.overlay.cannotHear')}</p>
          <p>{t('platform.overlay.howToStart')}</p>
          <p className="readout">{t('platform.overlay.keys')}</p>
        </div>
      )}
      {!idle && sync.nudgeMs !== 0 && <p className="readout text-caption">{t('platform.overlay.nudged', { ms: sync.nudgeMs > 0 ? `+${sync.nudgeMs}` : sync.nudgeMs })}</p>}
    </div>
  )
}
