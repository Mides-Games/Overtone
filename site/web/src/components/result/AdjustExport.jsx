import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../../context/AuthContext.jsx'
import { buildOsz } from '../../lib/osz.js'
import { downloadName, saveText, timingCsv, timingText } from '../../lib/timing.js'

const FACTORS = [
  { value: 0.5, label: '÷2' },
  { value: 1, label: '×1' },
  { value: 2, label: '×2' },
]
const NUDGE_LIMIT = 500

/**
 * The reader's own adjustments, display and export only: half or double every
 * BPM, and move every line by the same few milliseconds. Both are offered to
 * be checked by ear against the clicks; neither is a measurement, and the
 * engine's reading stays what it was. Then the exports, which follow them:
 * the .osz to open in osu!, built here from `audioFile` (the reader's own
 * file, null until they pick it), the [TimingPoints] block and the CSV.
 */
export default function AdjustExport({ id, analysis, lines, adjustment, onAdjust, audioFile, csvHref = null }) {
  const { t } = useTranslation()
  const { account } = useAuth() ?? {}
  const [copied, setCopied] = useState(null)
  const [osz, setOsz] = useState(null) // null, 'busy' or 'failed'
  const result = analysis.result
  const adjusted = adjustment.factor !== 1 || adjustment.nudgeMs !== 0
  const text = () => timingText(result, lines, adjustment)

  // Functional updates: two presses before a render must both count.
  const setNudge = (value) =>
    onAdjust((a) => {
      const n = Math.round(Number(typeof value === 'function' ? value(a.nudgeMs) : value))
      return { ...a, nudgeMs: Number.isFinite(n) ? Math.max(-NUDGE_LIMIT, Math.min(NUDGE_LIMIT, n)) : 0 }
    })

  async function copy() {
    try {
      await navigator.clipboard.writeText(text())
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
    setTimeout(() => setCopied(null), 2500)
  }

  async function downloadOsz() {
    if (!audioFile || osz === 'busy') return
    setOsz('busy')
    try {
      const { name, bytes } = await buildOsz({ file: audioFile, analysis, lines, adjustment, creator: account?.username })
      saveText(bytes, name, 'application/x-osu-beatmap-archive')
      setOsz(null)
    } catch {
      setOsz('failed')
    }
  }

  return (
    <section className="panel overflow-hidden">
      <div className="grid gap-px bg-line md:grid-cols-2">
        <div className="space-y-2 bg-surface px-4 py-3">
          <h3 className="label">{t('tempo.factorTitle')}</h3>
          <div className="flex items-center gap-1.5" role="group" aria-label={t('tempo.factorTitle')}>
            {FACTORS.map((f) => (
              <button
                key={f.value}
                type="button"
                className="tool-btn min-w-11"
                aria-pressed={adjustment.factor === f.value}
                onClick={() => onAdjust((a) => ({ ...a, factor: f.value }))}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-caption text-dim">{t('tempo.factorNote')}</p>
        </div>

        <div className="space-y-2 bg-surface px-4 py-3">
          <h3 className="label">{t('tempo.nudgeTitle')}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {[-5, -1].map((step) => (
              <button key={step} type="button" className="tool-btn px-2" onClick={() => setNudge((n) => n + step)}>
                {step}
              </button>
            ))}
            <label className="flex items-center gap-1">
              <span className="sr-only">{t('tempo.nudgeTitle')}</span>
              <NudgeInput value={adjustment.nudgeMs} onCommit={setNudge} />
              <span className="text-caption text-dim">ms</span>
            </label>
            {[1, 5].map((step) => (
              <button key={step} type="button" className="tool-btn px-2" onClick={() => setNudge((n) => n + step)}>
                +{step}
              </button>
            ))}
            <button type="button" className="tool-btn px-2.5" disabled={!adjustment.nudgeMs} onClick={() => setNudge(0)}>
              {t('tempo.reset')}
            </button>
          </div>
          <p className="text-caption text-dim">{t('tempo.nudgeNote')}</p>
        </div>
      </div>

      {adjusted && (
        <p role="status" className="border-t border-amber/40 bg-amber/10 px-4 py-2 text-caption text-text">
          {t('tempo.adjusted')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button type="button" className="btn-primary" disabled={!audioFile || osz === 'busy'} onClick={downloadOsz}>
          {osz === 'busy' ? t('result.oszBusy') : t('result.downloadOsz')}
        </button>
        <button type="button" className="btn-ghost" onClick={copy}>
          {copied === 'ok' ? t('result.copied') : copied === 'failed' ? t('result.copyFailed') : t('result.copy')}
        </button>
        {adjusted ? (
          <button type="button" className="btn-ghost" onClick={() => saveText(timingCsv(result, lines), downloadName(analysis.filename, 'timing.csv'), 'text/csv;charset=utf-8')}>
            {t('result.downloadCsv')}
          </button>
        ) : (
          <a className="btn-ghost" href={csvHref ?? `/api/v1/analyses/${id}/timing.csv`} download>
            {t('result.downloadCsv')}
          </a>
        )}
        <p className="w-full text-caption text-dim" role={osz === 'failed' ? 'alert' : undefined}>
          {osz === 'failed' ? t('result.oszFailed') : audioFile ? t('result.oszNote') : t('result.oszNeedsAudio')}
        </p>
      </div>
    </section>
  )
}

/** A whole number of ms, typed freely ("-", "") and taken once it reads as one. */
function NudgeInput({ value, onCommit }) {
  const [draft, setDraft] = useState(null)
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? String(value)}
      onChange={(e) => {
        const text = e.target.value.replace(/[^\d-]/g, '').slice(0, 5)
        setDraft(text)
        if (/^-?\d+$/.test(text)) onCommit(text)
      }}
      onBlur={() => setDraft(null)}
      className="readout h-8 w-16 rounded-control border border-line-strong bg-surface-2 px-2 text-right text-label text-text outline-none focus:border-accent"
    />
  )
}
