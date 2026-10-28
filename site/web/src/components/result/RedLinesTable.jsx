import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { toggleSelection } from '../../lib/osu-copy.js'
import { formatBpm, formatClock, formatMs } from '../../lib/timing.js'
import Icon from '../ui/Icon.jsx'
import Term from '../Term.jsx'

export const LEVELS = {
  high: { tone: 'var(--accent)', key: 'strip.high' },
  medium: { tone: 'var(--tempo)', key: 'strip.medium' },
  check: { tone: 'var(--amber)', key: 'strip.check' },
}

/**
 * The table's id. It is the tempo map's text alternative (W10.2): the map's
 * canvas names it in aria-describedby, so a screen reader that meets the
 * picture is pointed at the same red lines as rows. One result per page.
 */
export const RED_LINES_TABLE_ID = 'red-lines-table'

const ms1 = (value) => (value === null || value === undefined ? '–' : value.toFixed(1))

/**
 * The red lines, one row each, in step with the map: hovering or selecting a
 * row lights its line there and the other way round. Drift is the attacks'
 * distance from the line's grid (median, 90th percentile, and which way they
 * lean); confidence is the engine's own, not a measured accuracy.
 */
export default function RedLinesTable({ lines, sections, drift, selected, hovered, onSelect, onHover, canPlay, onPlayFrom, onLoop, copyRows = null }) {
  const { t } = useTranslation()
  const rows = useRef([])
  const box = useRef(null)
  // W12.24: rows ticked for copying, apart from the map's selection; Shift-click ticks a stretch.
  const [ticked, setTicked] = useState(() => new Set())
  const anchor = useRef(null)
  const [copied, setCopied] = useState(null) // null | 'all' | 'one:<i>' | 'failed'
  useEffect(() => setTicked(new Set()), [lines.length])

  async function copy(positions, what) {
    try {
      await navigator.clipboard.writeText(copyRows(positions))
      setCopied(what)
    } catch {
      setCopied('failed')
    }
    setTimeout(() => setCopied((c) => (c === what || c === 'failed' ? null : c)), 2000)
  }

  // A line picked on the map scrolls into the table's own box, never the page.
  useEffect(() => {
    const row = rows.current[selected ?? -1]
    const scroller = box.current
    if (!row || !scroller) return
    const head = scroller.querySelector('thead')?.offsetHeight ?? 0
    const top = row.offsetTop - head
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = row.offsetTop + row.offsetHeight - scroller.clientHeight
    }
  }, [selected])

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${RED_LINES_TABLE_ID}-title`} className="heading-title">
          <Term id="redLine">{t('result.redLines')}</Term>
          <span className="readout ml-2 text-label font-normal text-dim">{lines.length}</span>
        </h3>
        {copyRows && (
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <span className="text-dim" role="status">
              {copied === 'failed'
                ? t('platform.copy.failed')
                : copied === 'all'
                  ? t('platform.copy.copied')
                  : ticked.size
                    ? t('platform.copy.ticked', { count: ticked.size })
                    : t('platform.copy.hint')}
            </span>
            <button type="button" className="tool-btn px-2.5" disabled={!ticked.size} onClick={() => copy([...ticked], 'all')}>
              {t('platform.copy.copyTicked')}
            </button>
            <button type="button" className="tool-btn px-2.5" disabled={!ticked.size} onClick={() => setTicked(new Set())}>
              {t('platform.copy.clear')}
            </button>
          </div>
        )}
      </div>
      <div ref={box} className="panel relative max-h-[28rem] overflow-auto">
        <table id={RED_LINES_TABLE_ID} aria-labelledby={`${RED_LINES_TABLE_ID}-title`} className="w-full min-w-[46rem] text-left text-label">
          <thead className="sticky top-0 z-[1] border-b border-line bg-surface-2">
            <tr className="label">
              {copyRows && (
                <th className="w-8 px-2 py-2 font-semibold">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    aria-label={t('platform.copy.all')}
                    checked={lines.length > 0 && ticked.size === lines.length}
                    onChange={(e) => setTicked(e.target.checked ? new Set(lines.map((_, i) => i)) : new Set())}
                  />
                </th>
              )}
              <th className="px-3 py-2 font-semibold">#</th>
              <th className="px-3 py-2 font-semibold">{t('result.time')}</th>
              <th className="px-3 py-2 font-semibold">
                <Term id="bpm">{t('strip.bpm')}</Term>
              </th>
              <th className="px-3 py-2 font-semibold">
                <Term id="meter">{t('strip.meter')}</Term>
              </th>
              <th className="px-3 py-2 font-semibold">
                <Term id="confidence">{t('strip.confidence')}</Term>
              </th>
              <th className="px-3 py-2 font-semibold">
                <Term id="drift">
                  {t('tempo.drift')}
                </Term>
              </th>
              <th className="px-3 py-2 font-semibold">
                <Term id="fit">
                  {t('tempo.residual')}
                </Term>
              </th>
              <th className="px-3 py-2 font-semibold">
                <span className="sr-only">{t('tempo.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((line, i) => {
              const section = sections[line.index] ?? {}
              const level = LEVELS[section.level]
              const d = drift[i] ?? {}
              const lit = i === selected ? 'bg-accent/10' : i === hovered ? 'bg-surface-2' : ''
              return (
                <tr
                  // An edited timing (W7) may add lines (index -1) and reorder them: the position is the key then.
                  key={line.edited === undefined ? line.index : `e${i}`}
                  ref={(el) => {
                    rows.current[i] = el
                  }}
                  className={`readout cursor-pointer ${lit}`}
                  aria-selected={i === selected}
                  onMouseEnter={() => onHover(i)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => onSelect(i === selected ? null : i)}
                >
                  {copyRows && (
                    <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        aria-label={t('platform.copy.tick', { n: i + 1 })}
                        checked={ticked.has(i)}
                        onChange={() => {}}
                        onClick={(e) => {
                          setTicked((s) => toggleSelection(s, i, { shift: e.shiftKey, anchor: anchor.current }))
                          anchor.current = i
                        }}
                      />
                    </td>
                  )}
                  <td className="whitespace-nowrap px-3 py-2 text-dim">
                    <span className="inline-block h-3 w-0.5 bg-red align-middle" aria-hidden="true" /> {i + 1}
                    {line.edited && (
                      <span className="ml-1.5 inline-flex rounded-sm bg-amber/15 p-0.5 align-middle text-amber" title={t(line.added ? 'editor.addedLine' : 'editor.editedLine')}>
                        <Icon name="edit" size={12} />
                        <span className="sr-only"> {t(line.added ? 'editor.addedLine' : 'editor.editedLine')}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {formatClock(line.timeMs)}
                    <span className="ml-2 text-caption text-dim">
                      {formatMs(line.timeMs)}
                      <span className="unit">ms</span>
                    </span>
                  </td>
                  <td className="px-3 py-2">{formatBpm(line.bpm)}</td>
                  <td className="px-3 py-2">
                    {line.meter}/4
                    {!line.meterKnown && (
                      <span className="ml-1 text-caption text-dim" title={t('result.meterGuess')}>
                        ?
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ background: level?.tone }} />
                      {level ? t(level.key) : '–'}
                      <span className="text-caption text-dim">{Math.round((section.confidence ?? 0) * 100)}%</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {d.drift_ms === null || d.drift_ms === undefined ? (
                      <span className="text-dim">–</span>
                    ) : (
                      <>
                        <span className={driftTone(d.drift_ms)}>{ms1(d.drift_ms)}</span>
                        <span className="ml-1.5 text-caption text-dim" title={t('tempo.driftDetail')}>
                          p90 {ms1(d.drift_p90_ms)} · {d.drift_bias_ms > 0 ? '+' : ''}
                          {ms1(d.drift_bias_ms)}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2">{section.residual_ms === null || section.residual_ms === undefined ? '–' : ms1(section.residual_ms)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <button
                      type="button"
                      className="tool-btn"
                      disabled={!canPlay}
                      onClick={(e) => {
                        e.stopPropagation()
                        onPlayFrom(i)
                      }}
                      title={t('tempo.playFrom')}
                      aria-label={t('tempo.playFrom')}
                    >
                      <Icon name="play" size={14} />
                    </button>
                    <button
                      type="button"
                      className="tool-btn ml-1"
                      disabled={!canPlay}
                      onClick={(e) => {
                        e.stopPropagation()
                        onLoop(i)
                      }}
                      title={t('tempo.loopLine')}
                      aria-label={t('tempo.loopLine')}
                    >
                      <Icon name="loop" size={14} />
                    </button>
                    {copyRows && (
                      <button
                        type="button"
                        className="tool-btn ml-1"
                        onClick={(e) => {
                          e.stopPropagation()
                          copy([i], `one:${i}`)
                        }}
                        title={t('platform.copy.one')}
                      >
                        <Icon name={copied === `one:${i}` ? 'check' : 'copy'} size={14} />
                        <span className="sr-only">{copied === `one:${i}` ? t('platform.copy.copied') : t('platform.copy.one')}</span>
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-dim">{t('tempo.tableNote')}</p>
    </section>
  )
}

const driftTone = (ms) => (ms <= 5 ? 'text-accent' : ms <= 15 ? 'text-amber' : 'text-red')
