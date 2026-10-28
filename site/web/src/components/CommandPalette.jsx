import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { useAuth } from '../context/AuthContext.jsx'
import { useSettings } from '../context/SettingsContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import { fold, globalShortcut, rankCommands } from '../lib/commands.js'
import { BUNDLED, LANGS } from '../lib/languages.js'
import { recentAnalyses } from '../lib/recent.js'
import { IN_FLIGHT } from '../lib/tracker.js'
import { useTracker } from '../lib/tracking.js'

/**
 * The command palette and the shortcut help (W12.14). Ctrl+K (⌘K on a Mac)
 * or the bar's search button opens the palette from any page: a page, one of
 * this browser's analyses (the tray's in-flight ones first, then the recent
 * list), or an action (language, theme, contrast, settings, sign in or out,
 * the shortcuts). `?` opens the list of every shortcut, the result page's too.
 *
 * Both are native modal <dialog>s: the page behind is inert, Tab stays inside,
 * Escape closes, and the focus goes back to where it was. The palette follows
 * the ARIA combobox pattern: the field owns a listbox, arrows move the active
 * option (aria-activedescendant, so the focus never leaves the field), Enter
 * runs it. The ranking is lib/commands.js, tested on its own.
 */
const PaletteContext = createContext(null)

export const usePalette = () => useContext(PaletteContext)

const isMac = () => {
  try {
    return /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform ?? '')
  } catch {
    return false
  }
}

/** A modal dialog that opens with `open`, closes on Escape or a click on its backdrop, and gives the focus back. */
function Modal({ open, onClose, className = '', children, ...rest }) {
  const ref = useRef(null)
  const returnTo = useRef(null)
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      returnTo.current = document.activeElement
      dialog.showModal()
      dialog.querySelector('[data-autofocus]')?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      // Escape: closed through the state, at once, so a Ctrl+K pressed right after opens rather than toggles.
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={() => {
        // The close event comes a task later: if the state closed it, another dialog may be opening by now.
        if (openRef.current) onClose()
        // The browser restores the focus too, but not every one yet, and not to an element it replaced.
        const back = returnTo.current
        returnTo.current = null
        if (!document.querySelector('dialog[open]') && back?.isConnected && typeof back.focus === 'function') back.focus()
      }}
      // A click on the backdrop lands on the dialog itself, never on its content.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className={`rise m-0 mx-auto mt-[10vh] max-h-[80vh] w-[min(36rem,calc(100%-2rem))] overflow-hidden rounded-panel border border-line-strong bg-surface p-0 text-text shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop:bg-[var(--scrim)] backdrop:backdrop-blur-sm ${className}`}
      {...rest}
    >
      {open && children}
    </dialog>
  )
}

function Highlight({ text, positions }) {
  // Positions index the folded label; a label whose folding changed its length is shown plain.
  if (!positions.length || fold(text).length !== text.length) return text
  const marked = new Set(positions)
  return [...text].map((ch, i) =>
    marked.has(i) ? (
      <mark key={i} className="bg-transparent font-semibold text-accent">
        {ch}
      </mark>
    ) : (
      ch
    ),
  )
}

function useCommands({ openHelp }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { account, signOut } = useAuth()
  const { theme, setTheme } = useTheme()
  const { settings, update } = useSettings()
  const tray = useTracker()

  return useMemo(() => {
    // A thing's name in the two bundled languages besides the current one, so
    // "inicio" finds Home on the English site and "home" on any other.
    const also = (key) => BUNDLED.filter((lng) => lng !== i18n.language).map((lng) => i18n.t(key, { lng }))
    const go = (to) => () => navigate(to)

    const analyses = []
    const seen = new Set()
    for (const entry of tray?.entries ?? []) {
      if (!(entry.status === null || IN_FLIGHT.includes(entry.status))) continue
      seen.add(entry.id)
      analyses.push({
        id: `analysis:${entry.id}`,
        label: entry.name || entry.id,
        hint: entry.status === 'running' ? t('palette.inProgress') : t('palette.waiting'),
        keywords: [entry.id],
        run: go(`/analyze/${entry.id}`),
      })
    }
    for (const item of recentAnalyses()) {
      if (seen.has(item.id)) continue
      analyses.push({
        id: `analysis:${item.id}`,
        label: item.filename || item.id,
        hint: t('palette.groups.analysis'),
        keywords: [item.id],
        run: go(`/analyze/${item.id}`),
      })
    }

    const page = (to, key) => ({ id: `page:${to}`, label: t(key), hint: t('palette.groups.page'), keywords: [to.slice(1), ...also(key)], run: go(to) })
    const pages = [
      page('/', 'nav.home'),
      page('/analyze', 'nav.analyze'),
      page('/queue', 'nav.queue'),
      page('/community', 'community.nav'),
      page('/recent', 'timings.nav.recent'),
      page('/history', 'timings.nav.history'),
      page('/profile', 'nav.profile'),
      page('/settings', 'settings.title'),
      page('/status', 'legal.footer.status'),
      page('/terms', 'legal.footer.terms'),
      page('/privacy', 'legal.footer.privacy'),
      page('/disclaimer', 'legal.footer.disclaimer'),
      page('/credits', 'legal.footer.credits'),
    ]

    const action = (id, key, run, extra = {}) => ({ id: `action:${id}`, label: t(key), hint: t('palette.groups.action'), keywords: also(key), run, ...extra })
    const themeAction = (value) =>
      action(`theme-${value}`, `palette.actions.theme.${value}`, () => setTheme(value), theme === value ? { hint: t('palette.current') } : {})
    const actions = [
      themeAction('dark'),
      themeAction('light'),
      themeAction('system'),
      action('contrast', settings.contrast === 'more' ? 'palette.actions.contrastOff' : 'palette.actions.contrastOn', () =>
        update({ contrast: settings.contrast === 'more' ? 'normal' : 'more' }),
      ),
      action('settings', 'palette.actions.settings', go('/settings')),
      action('shortcuts', 'palette.actions.shortcuts', openHelp, { keywords: ['?', ...also('palette.actions.shortcuts')] }),
      account
        ? action('sign-out', 'nav.signOut', async () => {
            await signOut()
            navigate('/', { replace: true })
          })
        : action('sign-in', 'nav.signIn', go('/login')),
    ]
    // One action per language (W12.16), after the others so ten do not crowd
    // the empty list; each also answers to its name in English and in the
    // site's language ("german", "alemán") and to its code.
    const named = (lng, code) => {
      try {
        return new Intl.DisplayNames([lng], { type: 'language' }).of(code)
      } catch {
        return code
      }
    }
    for (const lang of LANGS) {
      actions.push({
        id: `action:language-${lang.code}`,
        label: t('palette.actions.language', { name: lang.name }),
        hint: lang.code === i18n.language ? t('palette.current') : t('palette.groups.action'),
        keywords: [lang.code, named('en', lang.code), named(i18n.language, lang.code), t('nav.changeLanguage'), ...also('nav.changeLanguage')],
        run: () => i18n.changeLanguage(lang.code),
      })
    }
    return [...analyses, ...pages, ...actions]
  }, [t, i18n, navigate, account, signOut, theme, setTheme, settings.contrast, update, tray, openHelp])
}

/** The palette's inside, mounted afresh each time it opens: an empty field, the first option active. */
function PaletteBody({ onClose, openHelp }) {
  const { t } = useTranslation()
  const commands = useCommands({ openHelp })
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const optionId = (i) => `${listId}-option-${i}`
  const results = useMemo(() => rankCommands(query, commands), [query, commands])
  const listRef = useRef(null)

  // Keep the active option in view as the arrows walk past the edge.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  const run = (result) => {
    if (!result) return
    onClose()
    // After the dialog has closed and handed the focus back, so a command that moves the focus keeps it.
    setTimeout(() => result.command.run(), 0)
  }

  const onKeyDown = (event) => {
    const last = results.length - 1
    const moves = {
      ArrowDown: () => setActive((i) => (i >= last ? 0 : i + 1)),
      ArrowUp: () => setActive((i) => (i <= 0 ? last : i - 1)),
      Home: () => setActive(0),
      End: () => setActive(Math.max(0, last)),
      PageDown: () => setActive((i) => Math.min(last, i + 8)),
      PageUp: () => setActive((i) => Math.max(0, i - 8)),
    }
    // Home and End belong to the text while there is text to move in.
    if ((event.key === 'Home' || event.key === 'End') && query) return
    if (moves[event.key]) {
      event.preventDefault()
      if (results.length) moves[event.key]()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(results[active])
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <SearchIcon className="shrink-0 text-dim" />
        <input
          data-autofocus
          type="text"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          aria-label={t('palette.title')}
          placeholder={t('palette.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className="palette-input h-12 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-dim"
        />
        <kbd className="hidden rounded border border-line-strong px-1.5 font-mono text-caption text-dim sm:inline">Esc</kbd>
      </div>
      <ul ref={listRef} id={listId} role="listbox" aria-label={t('palette.results')} className="max-h-[min(24rem,55vh)] overflow-y-auto p-1.5">
        {results.map((result, i) => (
          <li
            key={result.command.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            // mousedown, not click: the field keeps the focus, as a combobox's should.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(result)}
            className={`flex cursor-pointer items-center justify-between gap-3 rounded-control px-3 py-2 text-label ${
              i === active ? 'bg-surface-3 text-text' : 'text-muted'
            }`}
          >
            <span className="min-w-0 truncate">
              <Highlight text={result.command.label} positions={result.positions} />
            </span>
            <span className="shrink-0 font-display text-caption uppercase text-dim">{result.command.hint}</span>
          </li>
        ))}
      </ul>
      {!results.length && (
        <p className="px-4 pb-4 pt-1 text-label text-dim" role="status">
          {t('palette.empty', { query })}
        </p>
      )}
      <p className="hidden border-t border-line px-4 py-2 text-caption text-dim sm:block">{t('palette.footer')}</p>
    </>
  )
}

function Palette({ open, onClose, openHelp }) {
  const { t } = useTranslation()
  return (
    <Modal open={open} onClose={onClose} aria-label={t('palette.title')}>
      <PaletteBody onClose={onClose} openHelp={openHelp} />
    </Modal>
  )
}

function Keys({ keys }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {keys.map((key, i) => (
        <kbd key={i} className="min-w-6 rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 text-center font-mono text-caption text-text">
          {key}
        </kbd>
      ))}
    </span>
  )
}

/** The result page's keys (components/result/TempoMap.jsx), one row each. */
const RESULT_KEYS = [
  [['Space'], 'play'],
  [['←', '→'], 'beat'],
  [['Shift', '←', '→'], 'bar'],
  [['+', '−'], 'zoom'],
  [['0'], 'fit'],
  [['[', ']'], 'lines'],
  [['L'], 'loop'],
  [['C'], 'clicks'],
  [['F'], 'follow'],
]

function Help({ open, onClose }) {
  const { t } = useTranslation()
  const titleId = useId()
  const mod = isMac() ? '⌘' : 'Ctrl'
  const global = [
    [[mod, 'K'], 'palette'],
    [['?'], 'help'],
    [['Esc'], 'close'],
  ]
  const section = (title, rows, group) => (
    <section className="space-y-2">
      <h3 className="label">{title}</h3>
      <dl className="divide-y divide-line rounded-control border border-line">
        {rows.map(([keys, name]) => (
          <div key={name} className="flex items-center justify-between gap-4 px-3 py-2">
            <dt className="text-label text-muted">{t(`palette.help.${group}.${name}`)}</dt>
            <dd>
              <Keys keys={keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
  return (
    <Modal open={open} onClose={onClose} aria-labelledby={titleId}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 id={titleId} className="font-display text-title font-semibold">
          {t('palette.help.title')}
        </h2>
        <button type="button" data-autofocus onClick={onClose} className="tool-btn" aria-label={t('palette.help.close')}>
          ×
        </button>
      </div>
      <div className="max-h-[65vh] space-y-5 overflow-y-auto p-4">
        {section(t('palette.help.global.title'), global, 'global')}
        {section(t('palette.help.result.title'), RESULT_KEYS, 'result')}
        <p className="text-caption text-dim">{t('palette.help.note')}</p>
      </div>
    </Modal>
  )
}

export function SearchIcon({ className = '' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

/** Holds both dialogs and the global keys; Layout wraps the frame in it so the bar's button can reach it. */
export function PaletteProvider({ children }) {
  const [open, setOpen] = useState(null) // 'palette' | 'help' | null

  useEffect(() => {
    const onKey = (event) => {
      const which = globalShortcut(event)
      if (!which) return
      event.preventDefault()
      // Ctrl+K again closes the palette, as in editors; `?` inside an open dialog is ignored.
      setOpen((current) => (which === 'palette' ? (current === 'palette' ? null : 'palette') : (current ?? 'help')))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo(
    () => ({
      shortcut: `${isMac() ? '⌘' : 'Ctrl+'}K`,
      openPalette: () => setOpen('palette'),
      openHelp: () => setOpen('help'),
    }),
    [],
  )

  return (
    <PaletteContext value={value}>
      {children}
      <Palette open={open === 'palette'} onClose={() => setOpen(null)} openHelp={value.openHelp} />
      <Help open={open === 'help'} onClose={() => setOpen(null)} />
    </PaletteContext>
  )
}
