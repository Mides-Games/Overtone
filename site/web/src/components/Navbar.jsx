import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useNavigate } from 'react-router'

import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import { gutter } from '../lib/gutter.js'
import Avatar from './Avatar.jsx'
import { SearchIcon, usePalette } from './CommandPalette.jsx'
import Mark from './Mark.jsx'
import { TrayButton } from './Tray.jsx'

/**
 * The instrument bar: mark and name on the left, the three places on the
 * site, and on the right language, theme and the account. One slim row on a
 * wide screen; on a phone the places drop to a second row that scrolls, and
 * the analysis tray's button joins the right side (components/Tray.jsx).
 */
const LINKS = [
  { to: '/', key: 'nav.home', end: true },
  { to: '/analyze', key: 'nav.analyze' },
  { to: '/queue', key: 'nav.queue' },
  { to: '/community', key: 'community.nav' },
  { to: '/recent', key: 'timings.nav.recent' },
  { to: '/profile', key: 'nav.profile' },
]

const iconButton =
  'flex h-8 min-w-8 items-center justify-center rounded-control px-1.5 text-muted transition hover:bg-surface-3 hover:text-text'

function ThemeToggle() {
  const { dark, toggle } = useTheme()
  const { t } = useTranslation()
  return (
    <button type="button" onClick={toggle} aria-label={t('nav.changeTheme')} aria-pressed={dark} className={iconButton}>
      {dark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  )
}

/** Opens the command palette (W12.14): the keyboard's Ctrl+K, for a pointer or a phone. */
function PaletteButton({ className = '' }) {
  const { t } = useTranslation()
  const { openPalette, shortcut } = usePalette()
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label={t('palette.open', { shortcut })}
      title={t('palette.open', { shortcut })}
      aria-keyshortcuts="Control+K Meta+K"
      aria-haspopup="dialog"
      className={`${iconButton} ${className}`}
    >
      <SearchIcon />
    </button>
  )
}

function LanguageToggle() {
  const { t, i18n } = useTranslation()
  return (
    <button
      type="button"
      onClick={() => i18n.changeLanguage(i18n.language === 'es' ? 'en' : 'es')}
      aria-label={t('nav.changeLanguage')}
      title={t('nav.changeLanguage')}
      className={`${iconButton} font-display text-caption font-semibold tracking-wider`}
    >
      {t('nav.otherLanguage')}
    </button>
  )
}

function UserMenu({ account }) {
  const { t } = useTranslation()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !ref.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const item = 'flex w-full items-center rounded-control px-3 py-2 text-left text-label text-muted transition hover:bg-surface-3 hover:text-text'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('nav.account')}
        aria-expanded={open}
        aria-haspopup="menu"
        className="ml-1 flex items-center rounded-full transition hover:opacity-80"
      >
        <Avatar account={account} size={30} />
      </button>
      {open && (
        <div
          role="menu"
          className="rise absolute right-0 mt-2 w-56 rounded-panel border border-line-strong bg-surface p-1.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.6)]"
        >
          <div className="border-b border-line px-3 pb-2.5 pt-1.5">
            <p className="truncate text-label font-semibold text-text">{account.displayName || account.username}</p>
            <p className="readout truncate text-caption text-dim">@{account.username}</p>
          </div>
          <div className="pt-1.5">
            <Link role="menuitem" to="/profile" className={item} onClick={() => setOpen(false)}>
              {t('nav.profile')}
            </Link>
            <Link role="menuitem" to="/history" className={item} onClick={() => setOpen(false)}>
              {t('timings.nav.history')}
            </Link>
            <Link role="menuitem" to="/settings" className={item} onClick={() => setOpen(false)}>
              {t('settings.title')}
            </Link>
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={async () => {
                setOpen(false)
                await signOut()
                navigate('/', { replace: true })
              }}
            >
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Places({ className = '' }) {
  const { t } = useTranslation()
  const tab = ({ isActive }) =>
    `relative flex h-full shrink-0 items-center px-3 font-display text-label font-semibold uppercase tracking-[0.08em] transition ${
      isActive
        ? 'text-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
        : 'text-dim hover:text-text'
    }`
  return (
    <nav aria-label="Overtone" className={className}>
      {LINKS.map((link) => (
        <NavLink key={link.to} to={link.to} end={link.end} className={tab}>
          {t(link.key)}
        </NavLink>
      ))}
    </nav>
  )
}

export default function Navbar() {
  const { t } = useTranslation()
  const { account } = useAuth()

  return (
    <header id="site-navbar" className="border-b border-line bg-[var(--scrim)] backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6" style={gutter}>
        <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label="Overtone">
          <Mark size={22} />
          <span className="font-display text-[15px] font-bold uppercase tracking-[0.16em] text-text">Overtone</span>
        </Link>

        {/* min-w-0 and its own scroll: at a large font size (W12.15) the places scroll rather than push the account off the bar. */}
        <Places className="hidden h-full min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] md:flex" />

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <TrayButton />
          <div className="hidden md:block">
            <PaletteButton />
          </div>
          <LanguageToggle />
          <ThemeToggle />
          {account ? (
            <UserMenu account={account} />
          ) : (
            <Link to="/login" className="btn-ghost ml-1 h-8 whitespace-nowrap px-3">
              {t('nav.signIn')}
            </Link>
          )}
        </div>
      </div>
      {/* On a phone the palette's button leads the places' row: the top row has no room left at a large font size. */}
      <div className="flex h-10 items-stretch border-t border-line md:hidden">
        <PaletteButton className="ml-2 self-center" />
        <Places className="flex min-w-0 flex-1 items-stretch overflow-x-auto px-1 [scrollbar-width:none]" />
      </div>
    </header>
  )
}
