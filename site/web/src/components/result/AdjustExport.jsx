import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../../context/AuthContext.jsx'
import { changesLines, exportLines } from '../../lib/export-options.js'
import { buildOsz } from '../../lib/osz.js'
import { saveText, timingText } from '../../lib/timing.js'
import { useExportOptions } from './ExportOptions.jsx'

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
 * file, null until they pick it), and the [TimingPoints] block; `children`
 * (the "More downloads" group) below them.
 */
export default function AdjustExport({ analysis, lines, adjustment, onAdjust, audioFile, children }) {
  const { t } = useTranslation()
  const { account } = useAuth() ?? {}
  const [copied, setCopied] = useState(null)
  const [osz, setOsz] = useState(null) // null, 'busy' or 'failed'
  const result = analysis.result
  const adjusted = adjustment.factor !== 1 || adjustment.nudgeMs !== 0
  // The export options (W12.8) shape what is written, never what is heard.
  const options = useExportOptions()
  const written = useMemo(() => exportLines(lines, options), [lines, options])
  const text = () => timingText(result, written, adjustment, options)

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
      const { name, bytes } = await buildOsz({ file: audioFile, analysis, lines: written, adjustment, options, creator: account?.username })
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
        <p className="w-full text-caption text-dim" role={osz === 'failed' ? 'alert' : undefined}>
          {osz === 'failed' ? t('result.oszFailed') : audioFile ? t('result.oszNote') : t('result.oszNeedsAudio')}
        </p>
        {changesLines(options) && <OptionsInForce options={options} />}
      </div>
      {children}
    </section>
  )
}

/**
 * The export options that change what is written, said beside the .osz: they
 * are remembered across songs, so one set weeks ago must never go unnoticed.
 */
function OptionsInForce({ options }) {
  const { t } = useTranslation()
  const parts = []
  if (options.bpmDecimals !== null) parts.push(t('exportOptions.inForce.bpm', { count: options.bpmDecimals }))
  if (options.firstLineOnly) parts.push(t('exportOptions.inForce.first'))
  if (options.globalOffsetMs) parts.push(t('exportOptions.inForce.offset', { ms: `${options.globalOffsetMs > 0 ? '+' : ''}${options.globalOffsetMs}` }))
  return (
    <p role="status" className="w-full rounded-control border border-amber/40 bg-amber/10 px-3 py-1.5 text-caption text-text">
      {t('exportOptions.inForce.label', { list: parts.join(' · ') })}
    </p>
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
