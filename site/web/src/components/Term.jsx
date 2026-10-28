import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { GLOSSARY } from '../lib/glossary.js'

const WIDTH = 288 // 18rem
const MARGIN = 8

/**
 * A glossary word in place (W12.12): a dotted underline that opens the term's
 * short definition and a link to the glossary. `id` is one of
 * lib/glossary.js GLOSSARY.
 *
 * A button, so the keyboard reaches it: Enter or Space opens it and moves the
 * focus into it, Tab walks its link and its Close, and Tab past either end,
 * Escape or Close shuts it and gives the focus back to the word. A click
 * outside shuts it too. It is a non-modal disclosure, not a tooltip, because
 * it holds a link.
 *
 * The popover is portalled to <body> and placed `fixed` from the word's box:
 * the words sit inside scrolling boxes (the red lines table), a sticky header
 * and animated panels, any of which would clip or displace it in place. A
 * scroll or a resize closes it rather than leave it floating off its word.
 */
export default function Term({ id, children }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState(null)
  const button = useRef(null)
  const panel = useRef(null)
  const panelId = useId()

  const close = useCallback((refocus) => {
    setOpen(false)
    setPlace(null)
    if (refocus) button.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!open || !button.current || !panel.current) return
    const box = button.current.getBoundingClientRect()
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN)
    const left = Math.max(MARGIN, Math.min(box.left, window.innerWidth - width - MARGIN))
    const height = panel.current.offsetHeight
    // Below the word, or above it when there is no room underneath.
    const below = box.bottom + 6
    const above = box.top - 6 - height
    const top = below + height > window.innerHeight - MARGIN && above > MARGIN ? above : below
    setPlace({ top, left, width })
  }, [open])

  // Once placed: a hidden element cannot take the focus.
  useEffect(() => {
    if (open && place) panel.current?.focus({ preventScroll: true })
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(true)
      }
    }
    const onPointer = (e) => {
      if (!panel.current?.contains(e.target) && !button.current?.contains(e.target)) close(false)
    }
    const onMove = (e) => {
      if (e.type === 'scroll' && panel.current?.contains(e.target)) return
      close(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, close])

  // An unknown id is a typo in the code: show the words, not a broken popover.
  if (!GLOSSARY.includes(id)) return children

  const name = t(`learn.glossary.terms.${id}.term`)

  // Tab past the last control, or Shift-Tab past the first, leaves the popover for its word.
  const onPanelKey = (e) => {
    if (e.key !== 'Tab') return
    const stops = [...panel.current.querySelectorAll('a, button')]
    const first = e.target === panel.current || e.target === stops[0]
    if ((e.shiftKey && first) || (!e.shiftKey && e.target === stops.at(-1))) {
      e.preventDefault()
      close(true)
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="term cursor-help"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={t('learn.term.open', { term: name })}
        onClick={(e) => {
          // Inside a clickable row (the table), opening a term is not picking the row.
          e.stopPropagation()
          if (open) close(false)
          else setOpen(true)
        }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            role="region"
            aria-label={name}
            tabIndex={-1}
            className="fixed z-50 space-y-2 rounded-panel border border-line-strong bg-surface p-3 text-left text-label leading-relaxed text-muted shadow-lg outline-none"
            style={place ? { top: place.top, left: place.left, width: place.width } : { visibility: 'hidden', top: 0, left: 0, width: WIDTH }}
            onKeyDown={onPanelKey}
          >
            <p className="font-display font-semibold text-text">{name}</p>
            <p>{t(`learn.glossary.terms.${id}.short`)}</p>
            <div className="flex items-center justify-between gap-3 pt-1">
              <Link to={`/glossary#${id}`} className="text-accent hover:underline" onClick={() => close(false)}>
                {t('learn.term.more')} →
              </Link>
              <button type="button" className="tool-btn px-2" onClick={() => close(true)}>
                {t('learn.term.close')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
