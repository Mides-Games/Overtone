import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pageKeyIgnored } from '../../lib/keys.js'
import { addTap, compareTempo, MIN_OFFSET_TAPS, MIN_TEMPO_TAPS, offsetProposal, tapTempo } from '../../lib/listening.js'
import { formatBpm, governing, SUBDIVISIONS } from '../../lib/timing.js'
import LatencyCalibration from './LatencyCalibration.jsx'

const NUDGE_LIMIT = 500

/**
 * The tools for checking a timing by ear (W12.2-W12.6), under the transport:
 * clicks between the beats, the A/B between the engine's lines and the
 * reader's, a tap pad that reads a tempo and, while the song plays, how far
 * the taps sit from the grid, and the device's latency. Every reading is the
 * reader's hand: it is shown with its spread and applied only on a press.
 */
export default function Listening({ player, snapshot, lines, grid, adjusted, nudgeMs, onAdjust }) {
  const { t } = useTranslation()
  // One run of taps: when each came (performance ms) and, while playing, where it fell in the song.
  const [run, setRun] = useState({ at: [], song: [] })
  const [calibrating, setCalibrating] = useState(false)
  const lastTap = useRef(0)
  const calibrateButton = useRef(null)

  const tap = useCallback(
    (perfMs) => {
      lastTap.current = perfMs
      // The taps follow the reader's latency: each is placed where the song was that long before.
      const song = player.heardPositionAt(perfMs, snapshot.latencyMs)
      setRun((now) => {
        const at = addTap(now.at, perfMs)
        if (at === now.at) return now
        const songs = at.length === 1 ? [song] : [...now.song, song].slice(-at.length)
        return { at, song: songs }
      })
    },
    [player, snapshot.latencyMs],
  )
  const clear = () => setRun({ at: [], song: [] })

  const cycleSubdivision = useCallback(() => {
    const i = SUBDIVISIONS.indexOf(snapshot.subdivision)
    player.setSubdivision(SUBDIVISIONS[(i + 1) % SUBDIVISIONS.length])
  }, [player, snapshot.subdivision])

  // T taps, A swaps the clicks between the engine's lines and yours, S steps the subdivision.
  useEffect(() => {
    const onKey = (event) => {
      if (pageKeyIgnored(event)) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      if (key === 't') {
        event.preventDefault()
        if (!event.repeat) tap(event.timeStamp)
      } else if (key === 'a') {
        event.preventDefault()
        player.setAbEngine(!snapshot.abEngine)
      } else if (key === 's') {
        event.preventDefault()
        cycleSubdivision()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tap, player, snapshot.abEngine, cycleSubdivision])

  const tempo = useMemo(() => tapTempo(run.at), [run.at])
  // The song's own tempo at a slower or faster rate: what was tapped, divided by the rate.
  const tappedBpm = tempo ? tempo.bpm / snapshot.rate : null
  const here = lines[governing(lines, player.position())]
  const comparison = tappedBpm && here ? compareTempo(tappedBpm, here.bpm) : null
  const songTaps = run.song.filter((s) => s !== null && Number.isFinite(s))
  // Kept after the song stops, so the reader can still apply it.
  const proposal = songTaps.length ? offsetProposal(songTaps, grid.t) : null
  const proposed = proposal ? Math.max(-NUDGE_LIMIT, Math.min(NUDGE_LIMIT, nudgeMs + proposal.nudgeMs)) : null

  return (
    <div className="space-y-3 border-t border-line px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('listening.subdivision')}>
          <span className="label mr-1">{t('listening.subdivision')}</span>
          {SUBDIVISIONS.map((n) => (
            <button
              key={n}
              type="button"
              className="tool-btn px-2"
              aria-pressed={snapshot.subdivision === n}
              onClick={() => player.setSubdivision(n)}
              aria-keyshortcuts="S"
            >
              {n === 1 ? t('listening.subOff') : `1/${n}`}
            </button>
          ))}
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(snapshot.subVolume * 100)}
            onChange={(e) => player.setSubVolume(Number(e.target.value) / 100)}
            disabled={snapshot.subdivision === 1}
            className="ml-1 w-24 accent-[var(--accent)]"
            aria-label={t('listening.subVolume')}
            title={t('listening.subVolume')}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('listening.abLabel')}>
          <span className="label mr-1">{t('listening.ab')}</span>
          <button
            type="button"
            className="tool-btn px-2.5"
            aria-pressed={!snapshot.abEngine}
            disabled={!snapshot.hasEngineGrid}
            onClick={() => player.setAbEngine(false)}
            aria-keyshortcuts="A"
          >
            {t('listening.abYours')}
          </button>
          <button
            type="button"
            className="tool-btn px-2.5"
            aria-pressed={snapshot.abEngine}
            disabled={!snapshot.hasEngineGrid}
            onClick={() => player.setAbEngine(true)}
            aria-keyshortcuts="A"
          >
            {t('listening.abEngine')}
          </button>
          {!adjusted && <span className="text-caption text-dim">{t('listening.abSame')}</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost min-w-20"
            aria-keyshortcuts="T"
            aria-describedby="tap-reading"
            onPointerDown={(e) => {
              if (e.pointerType !== 'mouse' || e.button === 0) tap(e.timeStamp)
            }}
            onKeyDown={(e) => {
              if (e.key !== ' ' && e.key !== 'Enter') return
              e.preventDefault()
              if (!e.repeat) tap(e.timeStamp)
            }}
            onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
            onClick={(e) => {
              // An activation with no pointer or key before it (a screen reader's): a tap now.
              if (e.detail === 0 && performance.now() - lastTap.current > 120) tap(performance.now())
            }}
          >
            {t('listening.tap')}
          </button>
          <button type="button" className="tool-btn px-2" onClick={clear} disabled={!run.at.length}>
            {t('listening.clear')}
          </button>
        </div>

        <div id="tap-reading" className="min-w-0 flex-1 space-y-1 text-label" aria-live="polite">
          {!tempo ? (
            <p className="text-caption text-dim">
              {run.at.length ? t('listening.tapMore', { count: MIN_TEMPO_TAPS - run.at.length }) : t('listening.tapHint')}
            </p>
          ) : (
            <p>
              <span className="readout text-text">{formatBpm(Number(tappedBpm.toFixed(1)))}<span className="unit">BPM</span></span>
              <span className="readout text-dim"> ±{(tempo.spreadBpm / snapshot.rate).toFixed(1)}</span>
              <span className="text-dim"> · {t('listening.taps', { count: tempo.taps })}</span>
              {comparison && (
                <span className={comparison.kind === 'match' ? 'text-accent' : 'text-amber'}>
                  {' · '}
                  {t(`listening.compare.${comparison.kind}`, { bpm: formatBpm(here.bpm), ratio: comparison.ratio.toFixed(2) })}
                </span>
              )}
            </p>
          )}
          {snapshot.playing && !proposal && (
            <p className="text-caption text-dim">{t('listening.offsetHint', { count: MIN_OFFSET_TAPS })}</p>
          )}
          {proposal && (
            <div className="flex flex-wrap items-center gap-2">
              <p>
                {t('listening.offsetReading', {
                  ms: `${proposal.nudgeMs > 0 ? '+' : ''}${proposal.nudgeMs}`,
                  spread: proposal.spreadMs.toFixed(1),
                  count: proposal.kept,
                })}
              </p>
              <button
                type="button"
                className="tool-btn px-2.5"
                disabled={!proposal.nudgeMs || proposed === nudgeMs}
                onClick={() => {
                  onAdjust((a) => ({ ...a, nudgeMs: proposed }))
                  clear()
                }}
              >
                {t('listening.offsetApply', { ms: `${proposed > 0 ? '+' : ''}${proposed}` })}
              </button>
            </div>
          )}
          {proposal && snapshot.latencyMs === 0 && <p className="text-caption text-amber">{t('listening.offsetNoLatency')}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="label">{t('listening.latency')}</span>
        <span className="readout text-label text-text">{snapshot.latencyMs ? <>{snapshot.latencyMs}<span className="unit">ms</span></> : t('listening.latencyNone')}</span>
        <button ref={calibrateButton} type="button" className="tool-btn px-2.5" onClick={() => setCalibrating(true)} aria-haspopup="dialog">
          {t('listening.calibrate')}
        </button>
        <button type="button" className="tool-btn px-2.5" disabled={!snapshot.latencyMs} onClick={() => player.setLatency(0)}>
          {t('tempo.reset')}
        </button>
        <label className="flex items-center gap-2 text-label">
          <input
            type="checkbox"
            checked={snapshot.shiftClicks}
            disabled={!snapshot.latencyMs}
            onChange={(e) => player.setShiftClicks(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <span>{t('listening.shiftClicks')}</span>
        </label>
      </div>
      <p className="text-caption text-dim">{t('listening.note')}</p>
      {calibrating && <LatencyCalibration
          player={player}
          onClose={() => {
            setCalibrating(false)
            // The dialog is gone before it could hand the focus back: the button that opened it takes it.
            setTimeout(() => calibrateButton.current?.focus(), 0)
          }}
        />}
    </div>
  )
}
