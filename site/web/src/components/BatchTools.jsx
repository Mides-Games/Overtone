import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useExportOptions } from './result/ExportOptions.jsx'
import { adjustmentLabel } from '../lib/versions.js'
import { BATCH_OSZ_MAX_BYTES, batchOsz, batchTimingFiles, oszPlan } from '../lib/batch-export.js'
import { keptLibrary, keptOptions } from '../lib/kept-osz.js'
import { songNames } from '../lib/osz.js'
import { saveText } from '../lib/timing.js'
import { zipStore } from '../lib/zip.js'
import { KeptNote } from './KeptOsz.jsx'

const FACTORS = [
  { value: 0.5, label: '÷2' },
  { value: 1, label: '×1' },
  { value: 2, label: '×2' },
]
const NUDGE_LIMIT = 500

/** One line for the whole batch: kept if any was, with every entry dropped to make room. */
function mergeOutcomes(outcomes) {
  if (!outcomes.length) return null
  const kept = outcomes.filter((o) => o.kept)
  if (!kept.length) return outcomes[0]
  return { kept: true, evicted: outcomes.flatMap((o) => o.evicted ?? []), reason: null }
}

/**
 * The batch's own tools under its cards (W3.15, W12.22): one adjustment for
 * every song (×2 / ÷2 and a nudge, as the result page has them), the timings
 * in one zip and every song's .osz in one zip, both with that adjustment and
 * the export options (W12.8). The .osz files need the songs this page holds;
 * they are built one at a time (lib/batch-export.js).
 */
export default function BatchTools({ items, creator }) {
  const { t } = useTranslation()
  const options = useExportOptions()
  const [adjustment, setAdjustment] = useState({ factor: 1, nudgeMs: 0 })
  const [osz, setOsz] = useState({ kind: 'idle' }) // idle | busy {done,total} | done {failed} | failed
  const timings = batchTimingFiles(items, adjustment, options)
  const plan = oszPlan(items)
  const adjusted = adjustment.factor !== 1 || adjustment.nudgeMs !== 0
  const nudge = (step) =>
    setAdjustment((a) => ({ ...a, nudgeMs: Math.max(-NUDGE_LIMIT, Math.min(NUDGE_LIMIT, a.nudgeMs + step)) }))

  function downloadTimings() {
    saveText(zipStore(timings), 'overtone-timings.zip', 'application/zip')
  }

  async function downloadOsz() {
    setOsz({ kind: 'busy', done: 0, total: plan.songs.length })
    try {
      const outcomes = []
      const { blob, failed } = await batchOsz(items, {
        adjustment, options, creator, onProgress: (done, total) => setOsz({ kind: 'busy', done, total }),
        // Each song's own .osz is kept in this browser, to download again from its page or /downloads.
        onBuilt: async ({ analysis, name, bytes }) => {
          if (!analysis?.id) return
          const { title, artist } = songNames(analysis)
          outcomes.push(await keptLibrary().keep({
            source: 'analysis', id: analysis.id, title, artist, name, bytes, options: keptOptions({ adjustment, exportOptions: options }),
          }))
        },
      })
      saveText(blob, 'overtone-osz.zip', 'application/zip')
      setOsz({ kind: 'done', failed, kept: mergeOutcomes(outcomes) })
    } catch {
      setOsz({ kind: 'failed' })
    }
  }

  const mb = (bytes) => Math.round(bytes / 1_048_576)
  return (
    <section className="panel-well space-y-3 p-3 sm:p-4" aria-labelledby="batch-tools">
      <h3 id="batch-tools" className="label">
        {t('platform.batch.title')}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('platform.batch.adjust')}>
        {FACTORS.map((f) => (
          <button key={f.value} type="button" className="tool-btn min-w-11" aria-pressed={adjustment.factor === f.value}
            onClick={() => setAdjustment((a) => ({ ...a, factor: f.value }))}>
            {f.label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        {[-5, -1].map((s) => (
          <button key={s} type="button" className="tool-btn px-2" onClick={() => nudge(s)}>
            {s}
          </button>
        ))}
        <span className="readout min-w-14 text-center text-label" aria-live="polite">
          {adjustment.nudgeMs > 0 ? '+' : ''}
          {adjustment.nudgeMs} ms
        </span>
        {[1, 5].map((s) => (
          <button key={s} type="button" className="tool-btn px-2" onClick={() => nudge(s)}>
            +{s}
          </button>
        ))}
        <button type="button" className="tool-btn px-2.5" disabled={!adjusted} onClick={() => setAdjustment({ factor: 1, nudgeMs: 0 })}>
          {t('tempo.reset')}
        </button>
      </div>
      <p className="text-caption text-dim">
        {adjusted ? t('platform.batch.adjusted', { adjustment: adjustmentLabel(adjustment) }) : t('platform.batch.adjustNote')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={downloadTimings} className="btn-ghost w-full" disabled={!timings.length}>
          {t('analyze.batch.download', { count: timings.length })}
        </button>
        <button type="button" onClick={downloadOsz} className="btn-ghost w-full" disabled={!plan.fits || osz.kind === 'busy'}>
          {osz.kind === 'busy'
            ? t('platform.batch.oszBusy', { done: osz.done, total: osz.total })
            : t('platform.batch.osz', { count: plan.songs.length })}
        </button>
      </div>
      <p className="text-caption text-dim" role={osz.kind === 'failed' ? 'alert' : 'status'}>
        {osz.kind === 'failed'
          ? t('platform.batch.oszFailed')
          : osz.kind === 'done' && osz.failed.length
            ? t('platform.batch.oszSome', { names: osz.failed.join(', ') })
            : plan.songs.length && !plan.fits
              ? t('platform.batch.tooLarge', { mb: mb(plan.bytes), max: mb(BATCH_OSZ_MAX_BYTES) })
              : t('platform.batch.oszNote', { max: mb(BATCH_OSZ_MAX_BYTES) })}
      </p>
      {osz.kind === 'done' && <KeptNote outcome={osz.kept} />}
    </section>
  )
}
