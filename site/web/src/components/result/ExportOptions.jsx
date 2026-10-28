import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { bpmRoundingDrift, changesLines, exportOptionsStore, GLOBAL_OFFSET_LIMIT } from '../../lib/export-options.js'

/** The page's export options (W12.8), shared by every export control and remembered in this browser. */
export function useExportOptions() {
  return useSyncExternalStore(exportOptionsStore.subscribe, exportOptionsStore.get, exportOptionsStore.get)
}

const DECIMALS = [0, 1, 2, 3]

/**
 * The options panel, inside "More downloads": how the red lines are written
 * out, never how they are heard. `lines` are the page's (adjusted) lines, for
 * the drift a rounded BPM would cause by the song's end.
 */
export default function ExportOptions({ lines, durationS }) {
  const { t } = useTranslation()
  const options = useExportOptions()
  const set = exportOptionsStore.set
  const drift = bpmRoundingDrift(lines, options, (durationS || 0) * 1000)
  const lastLine = options.firstLineOnly || drift.line + 1 >= lines.length

  return (
    <div className="space-y-3 border-b border-line px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="label">{t('exportOptions.title')}</h3>
        {changesLines(options) && (
          <button
            type="button"
            className="tool-btn px-2.5"
            onClick={() => set({ bpmDecimals: null, firstLineOnly: false, globalOffsetMs: 0 })}
          >
            {t('exportOptions.reset')}
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="space-y-1.5">
          <legend className="text-caption text-text">{t('exportOptions.offsetDecimals')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {DECIMALS.map((d) => (
              <button key={d} type="button" className="tool-btn min-w-9" aria-pressed={options.offsetDecimals === d} onClick={() => set({ offsetDecimals: d })}>
                {d}
              </button>
            ))}
          </div>
          <p className="text-caption text-dim">{t('exportOptions.offsetDecimalsNote')}</p>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-caption text-text">{t('exportOptions.bpmDecimals')}</legend>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="tool-btn px-2.5" aria-pressed={options.bpmDecimals === null} onClick={() => set({ bpmDecimals: null })}>
              {t('exportOptions.bpmFull')}
            </button>
            {DECIMALS.map((d) => (
              <button key={d} type="button" className="tool-btn min-w-9" aria-pressed={options.bpmDecimals === d} onClick={() => set({ bpmDecimals: d })}>
                {d}
              </button>
            ))}
          </div>
          {options.bpmDecimals === null ? (
            <p className="text-caption text-dim">{t('exportOptions.bpmNote')}</p>
          ) : (
            <p role="status" className={`text-caption ${drift.worstMs >= 1 ? 'text-amber' : 'text-dim'}`}>
              {lastLine
                ? t('exportOptions.driftEnd', { ms: drift.worstMs.toFixed(drift.worstMs < 10 ? 2 : 0) })
                : t('exportOptions.driftLine', { ms: drift.worstMs.toFixed(drift.worstMs < 10 ? 2 : 0), line: drift.line + 1 })}
            </p>
          )}
        </fieldset>

        <div className="space-y-1.5">
          <label className="flex items-start gap-2 text-caption text-text">
            <input
              type="checkbox"
              checked={options.firstLineOnly}
              onChange={(e) => set({ firstLineOnly: e.target.checked })}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>{t('exportOptions.firstOnly')}</span>
          </label>
          <p className="text-caption text-dim">
            {options.firstLineOnly && lines.length > 1 ? t('exportOptions.firstOnlyOn', { count: lines.length - 1 }) : t('exportOptions.firstOnlyNote')}
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="flex flex-wrap items-center gap-2 text-caption text-text">
            <span>{t('exportOptions.globalOffset')}</span>
            <OffsetInput value={options.globalOffsetMs} onCommit={(n) => set({ globalOffsetMs: n })} />
            <span className="text-dim">ms</span>
          </label>
          <p className="text-caption text-dim">{t('exportOptions.globalOffsetNote')}</p>
        </div>
      </div>
    </div>
  )
}

/** Whole ms, typed freely ("-", "") and taken once it reads as one, clamped by the store. */
function OffsetInput({ value, onCommit }) {
  const [draft, setDraft] = useState(null)
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? String(value)}
      onChange={(e) => {
        const text = e.target.value.replace(/[^\d-]/g, '').slice(0, String(-GLOBAL_OFFSET_LIMIT).length)
        setDraft(text)
        if (/^-?\d+$/.test(text)) onCommit(Number(text))
      }}
      onBlur={() => setDraft(null)}
      className="field readout h-8 min-h-8 w-16 px-2 py-0 text-right text-label"
    />
  )
}
