import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  EditError,
  editLines,
  engineEditLines,
  jump,
  normaliseEdits,
  present,
  readDraft,
  redo,
  toBase,
  undo,
  writeDraft,
} from '../lib/editor.js'
import { adjustLines, formatBpm, formatClock } from '../lib/timing.js'

/** One step of the history in words: `editor.steps.<key>`, with its values. */
export const stepText = (t, label) => t(`editor.steps.${label.key}`, { ...label.values, defaultValue: label.key })

/** A refitted section in words: the BPM its attacks keep and their share on the grid, or why the BPM stayed. */
export const refitText = (t, row) =>
  t(row.kept ? `editor.refit.${row.kept}` : 'editor.refit.fit', {
    bpm: formatBpm(row.bpm),
    share: row.share === null ? '' : Math.round(row.share * 100),
  })

/**
 * The reader's edits of one analysis's red lines (W7): their history with
 * undo and redo, kept in this browser per analysis so a reload does not lose
 * them, and spoken to a screen reader as they happen.
 *
 * `frame` is the page's ×2 / ÷2 and nudge: the editor works on the lines as
 * the reader sees them, and the edits are kept before that frame
 * (lib/editor.js `toBase`), so either can still change afterwards.
 *
 * Ctrl+Z undoes and Ctrl+Shift+Z (or Ctrl+Y) redoes anywhere on the page but
 * in a field, where the browser's own undo wins.
 */
export function useTimingEdits(id, result, frame) {
  const { t } = useTranslation()
  const engine = useMemo(() => engineEditLines(result), [result])
  // The history with the analysis it belongs to: another analysis on the same
  // page (a link between versions) starts its own, before anything is kept.
  const [held, setHeld] = useState(() => ({ id, history: start(id, engine) }))
  if (held.id !== id) setHeld({ id, history: start(id, engine) })
  const history = held.id === id ? held.history : start(id, engine)
  const setHistory = useCallback((next) => setHeld((h) => ({ ...h, history: typeof next === 'function' ? next(h.history) : next })), [])
  const [notice, setNotice] = useState(null) // { text, n }: n changes so the same words are spoken twice

  const edits = present(history)
  useEffect(() => {
    if (held.id === id) writeDraft(id, present(held.history))
  }, [id, held])

  const say = useCallback((text) => setNotice((old) => ({ text, n: (old?.n ?? 0) + 1 })), [])

  /**
   * Runs one editor function (lib/editor.js) on the lines as shown and keeps
   * what it returns as a step. `label` is the step's `{ key, values }`, or a
   * function of the editor's output for a step that names where a line went.
   * Returns the output, or `{ error }` with the editor's refusal code.
   */
  const act = useCallback(
    (fn, label) => {
      const shown = editLines(adjustLines(result, { ...frame, edits }))
      let out
      try {
        out = fn(shown)
      } catch (error) {
        if (!(error instanceof EditError)) throw error
        say(t(`editor.errors.${error.code}`, { defaultValue: error.message }))
        return { error: error.code }
      }
      const step = typeof label === 'function' ? label(out) : label
      setHistory((h) => commit(h, normaliseEdits(toBase(out.lines, frame), engine), step))
      say(stepText(t, step) + (out.report ? `. ${reportText(t, out.report)}` : ''))
      return out
    },
    [result, frame, edits, engine, say, t],
  )

  /** Puts a whole set of edits in force as one step: a saved version applied, or the engine's reading again (null). */
  const replace = useCallback(
    (next, label) => {
      setHistory((h) => commit(h, next ? normaliseEdits(next, engine) : null, label))
      say(stepText(t, label))
    },
    [engine, say, t],
  )

  const back = useCallback(() => {
    if (!canUndo(history)) return say(t('editor.nothingToUndo'))
    say(t('editor.undone', { step: stepText(t, history.steps[history.at].label) }))
    setHistory(undo)
  }, [history, say, t])

  const forward = useCallback(() => {
    if (!canRedo(history)) return say(t('editor.nothingToRedo'))
    say(t('editor.redone', { step: stepText(t, history.steps[history.at + 1].label) }))
    setHistory(redo)
  }, [history, say, t])

  const goTo = useCallback(
    (at) => {
      setHistory((h) => jump(h, at))
      if (history.steps[at]) say(t('editor.wentTo', { step: stepText(t, history.steps[at].label) }))
    },
    [history, say, t],
  )

  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (document.querySelector('dialog[open]')) return
      // Only once there is a history: a page without edits leaves the keys alone.
      if (history.steps.length < 2) return
      event.preventDefault()
      if (key === 'y' || event.shiftKey) forward()
      else back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [history.steps.length, back, forward])

  return { edits, history, notice, say, act, replace, undo: back, redo: forward, jump: goTo, canUndo: canUndo(history), canRedo: canRedo(history) }
}

function start(id, engine) {
  const draft = readDraft(id)
  const edits = draft ? normaliseEdits(draft, engine) : null
  // Undo goes back past what this browser kept, to the engine's reading.
  return edits ? commit(createHistory(), edits, { key: 'restored' }) : createHistory()
}

function reportText(t, report) {
  if (report.splitMs !== undefined) {
    return t('editor.report.split', { time: formatClock(report.splitMs), first: refitText(t, report.sections[0]), second: refitText(t, report.sections[1]) })
  }
  return t('editor.report.merge', { first: refitText(t, report.sections[0]) })
}
