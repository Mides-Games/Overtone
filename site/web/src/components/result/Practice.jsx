import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DEFAULT_REPS, PRACTICE_FROM, PRACTICE_REPS, PRACTICE_TO } from '../../lib/practice.js'
import { formatClock } from '../../lib/timing.js'

/**
 * Practice mode (W13.8), under the transport: the loop the reader drew, or
 * the red line's section under the playhead, played a few times from half
 * speed to full after a bar counted in. The player does the scheduling
 * (lib/player.js `practise`); this is its switch and its readout.
 */
export default function Practice({ player, snapshot }) {
  const { t } = useTranslation()
  const [reps, setReps] = useState(DEFAULT_REPS)
  const [withCount, setWithCount] = useState(true)
  const [refused, setRefused] = useState(false)
  const practice = snapshot.practice

  async function start() {
    const ok = await player.practise({ reps, withCount })
    setRefused(!ok)
  }

  return (
    <div className="space-y-2 border-t border-line px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="label">{t('practice.title')}</span>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('practice.reps')}>
          <span className="text-caption text-dim">{t('practice.reps')}</span>
          {PRACTICE_REPS.map((n) => (
            <button key={n} type="button" className="tool-btn px-2" aria-pressed={reps === n} disabled={Boolean(practice)} onClick={() => setReps(n)}>
              {n}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-label">
          <input type="checkbox" checked={withCount} disabled={Boolean(practice)} onChange={(e) => setWithCount(e.target.checked)} className="accent-[var(--accent)]" />
          <span>{t('practice.countIn')}</span>
        </label>
        {practice ? (
          <button type="button" className="btn-ghost btn-sm" onClick={() => player.stop()}>
            {t('practice.stop')}
          </button>
        ) : (
          <button type="button" className="btn-ghost btn-sm" disabled={!snapshot.ready} onClick={start}>
            {t('practice.start')}
          </button>
        )}
      </div>
      <p className="text-caption text-dim" aria-live="polite">
        {practice ? (
          <span className="readout text-text">
            {practice.rep < 0
              ? t('practice.counting')
              : t('practice.status', { rep: practice.rep + 1, reps: practice.reps, rate: practice.rate.toFixed(2) })}
            <span className="text-dim"> · {formatClock(practice.a * 1000)} – {formatClock(practice.b * 1000)}</span>
          </span>
        ) : refused ? (
          <span className="text-amber">{t('practice.noStretch')}</span>
        ) : (
          t('practice.hint', { from: PRACTICE_FROM, to: PRACTICE_TO, reps })
        )}
      </p>
    </div>
  )
}
