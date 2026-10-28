import { useTranslation } from 'react-i18next'

import { formatClock } from '../../lib/timing.js'

export const RATES = [0.5, 0.75, 1, 1.25, 1.5]

/**
 * Play, the clock, the rate, the loop and the two volumes. The clock's text
 * is written by the tempo map's frame loop (`clockRef`), not by React, so a
 * playing song re-renders nothing.
 */
export default function Transport({ player, snapshot, durationS, clockRef }) {
  const { t } = useTranslation()
  const disabled = !snapshot.ready
  const range = snapshot.range

  return (
    <div className="space-y-3 border-t border-line px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="button"
          className="btn-primary h-10 w-24"
          onClick={() => player.toggle()}
          disabled={disabled}
          aria-keyshortcuts="Space"
        >
          {snapshot.playing ? t('tempo.pause') : t('tempo.play')}
        </button>
        <span className="readout text-label">
          <span ref={clockRef}>{formatClock(0)}</span>
          <span className="text-dim"> / {formatClock(durationS * 1000)}</span>
        </span>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('tempo.rate')}>
          <span className="label mr-1">{t('tempo.rate')}</span>
          {RATES.map((rate) => (
            <button
              key={rate}
              type="button"
              className="tool-btn px-2"
              aria-pressed={snapshot.rate === rate}
              disabled={disabled}
              onClick={() => player.setRate(rate)}
            >
              {rate}×
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="tool-btn px-2.5"
            aria-pressed={snapshot.loopOn}
            disabled={disabled}
            onClick={() => player.setLoopOn(!snapshot.loopOn)}
            aria-keyshortcuts="L"
          >
            {t('tempo.loop')}
          </button>
          <span className="readout text-caption text-dim">
            {range ? `${formatClock(range.a * 1000)} – ${formatClock(range.b * 1000)}` : t('tempo.loopSection')}
          </span>
          {range && (
            <button type="button" className="tool-btn px-2" onClick={() => player.setRange(null)} aria-label={t('tempo.loopClear')} title={t('tempo.loopClear')}>
              ×
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-label">
          <span className="label">{t('tempo.song')}</span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(snapshot.songVolume * 100)}
            onChange={(e) => player.setVolumes({ song: Number(e.target.value) / 100 })}
            className="w-28 accent-[var(--accent)]"
            aria-label={t('tempo.songVolume')}
          />
        </label>
        <label className="flex items-center gap-2 text-label">
          <input
            type="checkbox"
            checked={snapshot.clicksOn}
            onChange={(e) => player.setVolumes({ clicksOn: e.target.checked })}
            className="accent-[var(--accent)]"
            aria-keyshortcuts="C"
          />
          <span className="label">{t('tempo.clicks')}</span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(snapshot.clickVolume * 100)}
            onChange={(e) => player.setVolumes({ click: Number(e.target.value) / 100 })}
            className="w-28 accent-[var(--accent)]"
            aria-label={t('tempo.clickVolume')}
          />
        </label>
      </div>
      <p className="hidden text-caption text-dim sm:block">{t('tempo.keys')}</p>
    </div>
  )
}
