import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { attacksOf, bpmOf, deleteLine, addLine, mergeSections, METERS, nudgeLine, rescaleSection, setMeter, splitSection, updateLine } from '../../lib/editor.js'
import { pageKeyIgnored } from '../../lib/keys.js'
import { formatBpm, formatClock, governing } from '../../lib/timing.js'
import { stepText } from '../../hooks/useTimingEdits.js'
import Icon from '../ui/Icon.jsx'
import OffsetLab from './OffsetLab.jsx'

/**
 * The timing editor (W7, W12.17) under the tempo map: the selected red line's
 * time, BPM and bar, the section tools, undo and redo with the history in
 * view, and the offset lab. On the map itself (TempoMap.jsx) a line drags,
 * snapped to the attacks or the beats (Alt: free), and a double-click adds
 * one. Keys while editing: ← → move the selected line 1 ms (Shift: 10 ms),
 * N adds a line at the playhead, Delete removes the selected one; Ctrl+Z and
 * Ctrl+Shift+Z undo and redo anywhere on the page.
 *
 * Every edit is the reader's: the engine's reading stays as it came, and the
 * edited lines feed the clicks, the copy, the .osz and the exports as the ×2
 * and the nudge do, marked as edited there. Out of edit mode, a line says the
 * edits are in force and how to undo them.
 */
export default function TimingEditor({ editor, editing, onEditing, lines, selected, onSelect, player, snapshot, result, durationS, owner, nudgeMs, onAdjust, audioFile = null }) {
  const { t } = useTranslation()
  const attacks = useMemo(() => attacksOf(result.onsets), [result.onsets])
  const endMs = durationS * 1000
  const line = selected !== null && selected !== undefined ? lines[selected] ?? null : null
  const edited = Boolean(editor.edits)

  const run = (fn, label) => {
    const out = editor.act(fn, label)
    if (out && !out.error && out.selected !== null && out.selected !== undefined) onSelect(out.selected)
    return out
  }
  const n = (i) => i + 1
  const playhead = () => player.position() * 1000

  const nudge = (delta) =>
    line && run((l) => nudgeLine(l, selected, delta), (out) => ({ key: 'nudge', values: { n: n(out.selected), ms: `${delta > 0 ? '+' : '−'}${Math.abs(delta)}` } }))
  const remove = () => line && run((l) => deleteLine(l, selected), { key: 'delete', values: { n: n(selected) } })
  const addAtPlayhead = () => {
    const at = playhead()
    const here = lines[governing(lines, at / 1000)]
    if (!here) return
    run((l) => addLine(l, Math.round(at * 1000) / 1000, here.bpm, { meter: here.meter }), (out) => ({ key: 'add', values: { n: n(out.selected), time: formatClock(at) } }))
  }
  const split = () => {
    if (!line) return
    run((l) => splitSection(l, selected, playhead(), attacks, endMs), (out) => ({ key: 'split', values: { n: n(selected), time: formatClock(out.report.splitMs) } }))
  }
  const merge = () => line && run((l) => mergeSections(l, selected, attacks, endMs), { key: 'merge', values: { n: n(selected), next: n(selected + 1) } })
  const rescale = (factor) =>
    line && run((l) => rescaleSection(l, selected, factor), (out) => ({ key: factor === 2 ? 'double' : 'half', values: { n: n(selected), bpm: formatBpm(bpmOf(out.lines[selected])) } }))
  const meter = (m) => line && run((l) => setMeter(l, selected, m), { key: 'meter', values: { n: n(selected), meter: m } })

  // The keys that edit, while editing; the map's own keys (TempoMap.jsx) leave ← → to the selected line then.
  useEffect(() => {
    if (!editing) return undefined
    const onKey = (event) => {
      if (pageKeyIgnored(event)) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      const handled = {
        ArrowLeft: line ? () => nudge(event.shiftKey ? -10 : -1) : null,
        ArrowRight: line ? () => nudge(event.shiftKey ? 10 : 1) : null,
        Delete: line ? remove : null,
        Backspace: line ? remove : null,
        n: addAtPlayhead,
        Insert: addAtPlayhead,
      }[key]
      if (!handled) return
      if (event.target instanceof HTMLButtonElement && (key === 'Enter' || key === ' ')) return
      event.preventDefault()
      handled()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const live = (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {editor.notice ? <span key={editor.notice.n}>{editor.notice.text}</span> : null}
    </p>
  )

  if (!editing) {
    return (
      <div className="border-t border-line px-3 py-2">
        {live}
        {edited ? (
          <div role="status" className="flex flex-wrap items-center gap-2 text-caption text-text">
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-amber/15 px-1.5 py-0.5 text-amber">
              <Icon name="edit" size={13} />
              {t('editor.inForce', { count: lines.length })}
            </span>
            <button type="button" className="tool-btn h-7 px-2" onClick={() => onEditing(true)} aria-keyshortcuts="E">
              {t('editor.open')}
            </button>
            <button type="button" className="tool-btn h-7 px-2" onClick={editor.undo} disabled={!editor.canUndo} aria-keyshortcuts="Control+Z">
              {t('editor.undo')}
            </button>
            <button type="button" className="tool-btn h-7 px-2" onClick={() => editor.replace(null, { key: 'reset' })}>
              {t('editor.reset')}
            </button>
          </div>
        ) : (
          <p className="text-caption text-dim">{t('editor.closedHint')}</p>
        )}
      </div>
    )
  }

  return (
    <section className="space-y-3 border-t border-accent/40 bg-accent/5 px-3 py-3" aria-labelledby="editor-title">
      {live}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 id="editor-title" className="label flex items-center gap-1.5 text-accent">
            <Icon name="edit" size={14} />
            {t('editor.title')}
          </h3>
          <p className="text-caption text-dim">{t('editor.note')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className="tool-btn px-2.5" onClick={editor.undo} disabled={!editor.canUndo} aria-keyshortcuts="Control+Z">
            ↶ {t('editor.undo')}
          </button>
          <button type="button" className="tool-btn px-2.5" onClick={editor.redo} disabled={!editor.canRedo} aria-keyshortcuts="Control+Shift+Z">
            ↷ {t('editor.redo')}
          </button>
          <button type="button" className="tool-btn px-2.5" onClick={() => editor.replace(null, { key: 'reset' })} disabled={!edited}>
            {t('editor.reset')}
          </button>
          <button type="button" className="tool-btn px-2.5" aria-pressed="true" onClick={() => onEditing(false)} aria-keyshortcuts="E">
            {t('editor.done')}
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="space-y-3">
          <LineFields
            key={line ? `${selected}:${line.timeMs}:${line.beatMs}` : 'none'}
            line={line}
            index={selected}
            count={lines.length}
            onTime={(ms) => run((l) => updateLine(l, selected, ms), (out) => ({ key: 'offset', values: { n: n(out.selected), ms: ms.toFixed(1) } }))}
            onBpm={(bpm) => run((l) => updateLine(l, selected, l[selected].timeMs, bpm), { key: 'bpm', values: { n: n(selected), bpm: formatBpm(bpm) } })}
            onMeter={meter}
          />

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('editor.moveGroup')}>
            <span className="label mr-1">{t('editor.move')}</span>
            {[-10, -1, 1, 10].map((step) => (
              <button key={step} type="button" className="tool-btn px-2" disabled={!line} onClick={() => nudge(step)} aria-label={t('editor.nudgeBy', { ms: `${step > 0 ? '+' : '−'}${Math.abs(step)}` })}>
                {step > 0 ? `+${step}` : `−${-step}`}
              </button>
            ))}
            <span className="text-caption text-dim">ms</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('editor.linesGroup')}>
            <button type="button" className="tool-btn px-2.5" onClick={addAtPlayhead} disabled={!lines.length} aria-keyshortcuts="N">
              + {t('editor.addAtPlayhead')}
            </button>
            <button type="button" className="tool-btn px-2.5" onClick={remove} disabled={!line || selected === 0} aria-keyshortcuts="Delete">
              {t('editor.delete')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('editor.sectionGroup')}>
            <span className="label mr-1">{t('editor.section')}</span>
            <button type="button" className="tool-btn px-2.5" onClick={split} disabled={!line} title={t('editor.splitHint')}>
              {t('editor.split')}
            </button>
            <button type="button" className="tool-btn px-2.5" onClick={merge} disabled={!line || selected >= lines.length - 1} title={t('editor.mergeHint')}>
              {t('editor.merge')}
            </button>
            <button type="button" className="tool-btn px-2" onClick={() => rescale(0.5)} disabled={!line} aria-label={t('editor.halfSection')}>
              ÷2
            </button>
            <button type="button" className="tool-btn px-2" onClick={() => rescale(2)} disabled={!line} aria-label={t('editor.doubleSection')}>
              ×2
            </button>
          </div>

          <p className="text-caption text-dim" aria-hidden={editor.notice ? undefined : 'true'}>
            {editor.notice?.text ?? (line ? t('editor.keysHint') : t('editor.selectHint'))}
          </p>
          <p className="text-caption text-dim">{owner ? t('editor.keptOwner') : t('editor.keptHere')}</p>
        </div>

        <History editor={editor} />
      </div>

      <OffsetLab player={player} snapshot={snapshot} lines={lines} nudgeMs={nudgeMs} onAdjust={onAdjust} audioFile={audioFile} />
    </section>
  )
}

/** The selected line's time, BPM and bar, typed and taken on Enter or Apply. */
function LineFields({ line, index, count, onTime, onBpm, onMeter }) {
  const { t } = useTranslation()
  const [time, setTime] = useState(line ? String(Number(line.timeMs.toFixed(3))) : '')
  const [bpm, setBpm] = useState(line ? String(Number(line.bpm.toFixed(3))) : '')
  if (!line) return <p className="text-label text-muted">{t('editor.selectHint')}</p>
  const timeValue = Number(time.replace(',', '.'))
  const bpmValue = Number(bpm.replace(',', '.'))
  const timeChanged = time.trim() !== '' && Number.isFinite(timeValue) && Math.abs(timeValue - line.timeMs) > 1e-6
  const bpmChanged = bpm.trim() !== '' && Number.isFinite(bpmValue) && bpmValue > 0 && Math.abs(bpmValue - line.bpm) > 1e-9
  const apply = () => {
    if (timeChanged) onTime(timeValue)
    else if (bpmChanged) onBpm(bpmValue)
  }
  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      apply()
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-label text-text">
        <span className="readout">{t('editor.lineOf', { n: index + 1, total: count })}</span>
        <span className="readout ml-2 text-dim">{formatClock(line.timeMs)}</span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="label block">{t('editor.time')}</span>
          <input type="text" inputMode="decimal" className="field readout h-8 w-28 py-1 text-label" value={time} onChange={(e) => setTime(e.target.value)} onKeyDown={onKeyDown} />
        </label>
        <label className="space-y-1">
          <span className="label block">BPM</span>
          <input type="text" inputMode="decimal" className="field readout h-8 w-24 py-1 text-label" value={bpm} onChange={(e) => setBpm(e.target.value)} onKeyDown={onKeyDown} />
        </label>
        <button type="button" className="tool-btn h-8 px-2.5" disabled={!timeChanged && !bpmChanged} onClick={apply}>
          {t('editor.apply')}
        </button>
        <label className="space-y-1">
          <span className="label block">{t('editor.meter')}</span>
          <select className="field h-8 w-auto py-0 text-label" value={line.meter} onChange={(e) => onMeter(Number(e.target.value))} title={t('editor.meterHint')}>
            {METERS.map((m) => (
              <option key={m} value={m}>
                {m}/4
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

/** The steps so far, newest last; the one in force is marked, and any can be gone back to. */
function History({ editor }) {
  const { t } = useTranslation()
  const { steps, at } = editor.history
  return (
    <div className="min-w-0 space-y-1.5">
      <h4 className="label">{t('editor.history')}</h4>
      <ol className="max-h-48 space-y-0.5 overflow-y-auto rounded-control border border-line bg-surface p-1 text-caption" aria-label={t('editor.history')}>
        {steps.map((step, i) => (
          <li key={i}>
            <button
              type="button"
              className={`w-full truncate rounded px-2 py-1 text-left ${i === at ? 'bg-accent/15 text-text' : i > at ? 'text-dim line-through' : 'text-muted hover:bg-surface-2'}`}
              aria-current={i === at ? 'step' : undefined}
              onClick={() => editor.jump(i)}
              title={stepText(t, step.label)}
            >
              <span className="readout mr-1.5 text-dim">{i}</span>
              {stepText(t, step.label)}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
