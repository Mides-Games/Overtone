import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { latencyEstimate, offsetsToGrid } from '../../lib/listening.js'
import { audioContext, heardContextTime, scheduleClick } from '../../lib/player.js'

/** The test's clicks: 100 BPM, a pace most hands keep easily, and enough of them for a dozen counted taps. */
const BEAT_S = 0.6
const CLICKS = 24
/** The first clicks are for finding the beat; taps on them are not counted. */
const WARMUP = 4

/**
 * The latency test (W12.2), as osu!'s offset wizard: a steady click, nothing
 * to look at on purpose (a flash would be tapped to instead of the sound), and
 * the reader taps along with a key or the pad. Each tap is placed against the
 * click it answered, the browser's own reported latency already taken out
 * (`heardContextTime`), so what is left is what it did not report plus the
 * reader's own timing: the median of that, the stray taps dropped. Nothing is
 * kept until the reader saves it.
 */
export default function LatencyCalibration({ player, onClose }) {
  const { t } = useTranslation()
  const dialog = useRef(null)
  const test = useRef(null) // { bus, clicks, taps, timer }
  const [state, setState] = useState({ phase: 'ready' }) // ready | running | done
  const [count, setCount] = useState(0)

  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => {
      stopTest()
      if (node?.open) node.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function stopTest() {
    const now = test.current
    if (!now) return
    clearTimeout(now.timer)
    now.bus.disconnect()
    test.current = null
  }

  async function start() {
    stopTest()
    player.stop()
    const ctx = audioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    const bus = ctx.createGain()
    // At the reader's click volume, but never so quiet the test cannot be heard.
    bus.gain.value = Math.max(0.2, player.getSnapshot().clickVolume)
    bus.connect(ctx.destination)
    const first = ctx.currentTime + 0.8
    const clicks = Array.from({ length: CLICKS }, (_, i) => first + i * BEAT_S)
    clicks.forEach((when, i) => scheduleClick(ctx, bus, when, i % 4 === 0 ? 2 : 1))
    const timer = setTimeout(finish, (first - ctx.currentTime + CLICKS * BEAT_S + 0.4) * 1000)
    test.current = { bus, clicks, taps: [], timer }
    setCount(0)
    setState({ phase: 'running' })
  }

  function finish() {
    const now = test.current
    if (!now) return
    const counted = now.clicks.slice(WARMUP)
    // A tap is counted against the clicks after the warm-up, and only within half a beat of one.
    const offsets = offsetsToGrid(
      now.taps.filter((s) => s >= counted[0] - BEAT_S / 2),
      Float64Array.from(counted),
    )
    stopTest()
    setState({ phase: 'done', reading: latencyEstimate(offsets) })
  }

  function tap(perfMs) {
    const now = test.current
    if (!now) return
    now.taps.push(heardContextTime(audioContext(), perfMs))
    setCount(now.taps.length)
  }

  function onKeyDown(event) {
    if (state.phase !== 'running') return
    if (event.key === ' ' || event.key === 'Enter' || event.key.toLowerCase() === 't') {
      event.preventDefault()
      if (!event.repeat) tap(event.timeStamp)
    }
  }

  const reading = state.reading
  // Unmounting closes the dialog; the 'close' event is not waited for (a hidden page may hold it back).
  const close = () => onClose()

  return (
    <dialog
      ref={dialog}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-panel border border-line-strong bg-surface p-0 text-text shadow-2xl backdrop:bg-[var(--scrim)]"
      aria-labelledby="latency-title"
      onKeyDown={onKeyDown}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="space-y-4 px-5 py-4">
        <h2 id="latency-title" className="text-title font-semibold">
          {t('listening.calTitle')}
        </h2>
        <p className="text-label leading-relaxed text-muted">{t('listening.calIntro', { count: CLICKS })}</p>

        {state.phase === 'running' ? (
          <button
            type="button"
            className="flex h-32 w-full items-center justify-center rounded-panel border border-line-strong bg-surface-2 text-body text-text"
            style={{ touchAction: 'manipulation' }}
            onPointerDown={(e) => tap(e.timeStamp)}
            // Keys are read on the dialog; the pad's own click would count Space twice.
            onClick={(e) => e.preventDefault()}
            autoFocus
          >
            {t('listening.calPad', { count })}
          </button>
        ) : (
          <div role="status" className="space-y-2">
            {state.phase === 'done' && !reading && <p className="text-label text-amber">{t('listening.calTooFew')}</p>}
            {reading?.unsteady && <p className="text-label text-amber">{t('listening.calUnsteady', { spread: reading.spread.toFixed(0) })}</p>}
            {reading && !reading.unsteady && (
              <p className="text-label">
                <span className="readout text-title text-text">{reading.latencyMs} ms</span>
                <span className="readout text-dim"> ±{reading.spreadMs.toFixed(1)}</span>
                <span className="text-dim"> · {t('listening.calKept', { kept: reading.kept, dropped: reading.dropped })}</span>
              </p>
            )}
          </div>
        )}

        <p className="text-caption text-dim">{t('listening.calNote')}</p>

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => close()}>
            {t('listening.calClose')}
          </button>
          {state.phase !== 'running' && (
            <button type="button" className={reading && !reading.unsteady ? 'btn-ghost' : 'btn-primary'} onClick={start} autoFocus>
              {state.phase === 'done' ? t('listening.calAgain') : t('listening.calStart')}
            </button>
          )}
          {reading && !reading.unsteady && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                player.setLatency(reading.latencyMs)
                close()
              }}
            >
              {t('listening.calSave', { ms: reading.latencyMs })}
            </button>
          )}
        </div>
      </div>
    </dialog>
  )
}
