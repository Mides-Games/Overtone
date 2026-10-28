import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fold } from '../lib/commands.js'
import { findLanguage, LANGS } from '../lib/languages.js'
import Flag from './Flag.jsx'

/**
 * The navbar's language selector (W12.16), the WAI-ARIA listbox pattern: a
 * button with the current flag and code opens a list of the ten languages,
 * each by its own name. Arrows, Home and End move; Enter or Space picks;
 * typing a name's first letters jumps to it; Escape or Tab closes, and focus
 * goes back to the button.
 */
const short = (code) => code.split('-')[0].toUpperCase()

export default function LanguageSelect({ className = '' }) {
  const { t, i18n } = useTranslation()
  const current = findLanguage(i18n.resolvedLanguage ?? i18n.language)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const id = useId()
  const wrap = useRef(null)
  const button = useRef(null)
  const list = useRef(null)
  const typed = useRef({ text: '', at: 0 })

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const choose = (code) => {
    close()
    if (code !== current.code) i18n.changeLanguage(code)
  }
  const show = (index) => {
    setActive(index)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return undefined
    list.current?.focus()
    const outside = (event) => {
      if (!wrap.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, id])

  const here = LANGS.findIndex((lang) => lang.code === current.code)

  const onButtonKey = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      show(here)
    }
  }

  const onListKey = (event) => {
    const last = LANGS.length - 1
    const move = { ArrowDown: Math.min(active + 1, last), ArrowUp: Math.max(active - 1, 0), Home: 0, End: last }
    if (event.key in move) {
      event.preventDefault()
      setActive(move[event.key])
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(LANGS[active].code)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Tab') {
      close(false)
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typeahead: letters typed within half a second build one prefix.
      const now = Date.now()
      const text = (now - typed.current.at > 500 ? '' : typed.current.text) + fold(event.key)
      typed.current = { text, at: now }
      const starts = (lang) => fold(lang.name).startsWith(text) || fold(lang.code).startsWith(text)
      // A repeated single letter cycles through the names it starts.
      const from = text.length === 1 ? active + 1 : active
      const order = [...LANGS.slice(from), ...LANGS.slice(0, from)]
      const match = order.find(starts)
      if (match) setActive(LANGS.indexOf(match))
    }
  }

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <button
        ref={button}
        type="button"
        onClick={() => (open ? close() : show(here))}
        onKeyDown={onButtonKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={t('nav.language', { name: current.name })}
        title={t('nav.changeLanguage')}
        className="flex h-8 items-center gap-1.5 rounded-control px-1.5 font-display text-caption font-semibold tracking-wider text-muted transition hover:bg-surface-3 hover:text-text"
      >
        <Flag code={current.flag} size={18} />
        <span>{short(current.code)}</span>
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={t('nav.changeLanguage')}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onListKey}
          className="rise fixed right-4 top-14 z-50 sm:absolute sm:right-0 sm:top-full sm:mt-2 max-h-[min(26rem,calc(100dvh-5rem))] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-panel border border-line-strong bg-surface p-1.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.6)] outline-none"
        >
          {LANGS.map((lang, i) => {
            const selected = lang.code === current.code
            return (
              <li
                key={lang.code}
                id={`${id}-${i}`}
                role="option"
                lang={lang.code}
                aria-selected={selected}
                onClick={() => choose(lang.code)}
                onMouseMove={() => active !== i && setActive(i)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-control px-3 py-2 text-label transition ${i === active ? 'bg-surface-3' : ''} ${selected ? 'font-semibold text-accent' : i === active ? 'text-text' : 'text-muted'}`}
              >
                <Flag code={lang.flag} size={20} />
                <span className="min-w-0 flex-1 truncate">{lang.name}</span>
                <span className="readout text-caption text-dim">{lang.code.toUpperCase()}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className={selected ? '' : 'invisible'}>
                  <path d="M5 12l5 5L20 7" />
                </svg>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
