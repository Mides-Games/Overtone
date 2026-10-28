import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useLocation, useNavigate } from 'react-router'

import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import useSignInState from '../hooks/useSignInState.js'
import { gutter } from '../lib/gutter.js'
import Avatar from './Avatar.jsx'
import Bell from './Bell.jsx'
import { usePalette } from './CommandPalette.jsx'
import LanguageSelect from './LanguageSelect.jsx'
import Mark from './Mark.jsx'
import { TrayButton } from './Tray.jsx'
import Icon from './ui/Icon.jsx'

/**
 * The bar (docs/design.md, section 4): one slim row, 56 px, that stays at the
 * top. The mark and name on the left, the places on the site, and on the
 * right the palette, language, theme and the account.
 *
 * Below 1024 px the places, the palette and the sign-in move into a sheet
 * that opens under the bar from the menu button; language and theme stay in
 * the row, as do the analysis tray's button (components/Tray.jsx) and, signed
 * in, the account. The sheet closes on Escape (focus back to its button), on
 * a click outside it, and when a link in it is followed. 1024, not the
 * direction's 768: the seven places need 380-560 px in the ten languages
 * (Russian the widest), which the bar has from 1024 px and not below; under
 * it they would scroll inside the bar with nothing to say so.
 */
const LINKS = [
  { to: '/', key: 'nav.home', end: true },
  { to: '/analyze', key: 'nav.analyze' },
  { to: '/queue', key: 'nav.queue' },
  { to: '/community', key: 'community.nav' },
  { to: '/recent', key: 'timings.nav.recent' },
  { to: '/timers', key: 'social.nav.timers' },
  { to: '/profile', key: 'nav.profile' },
]

const SHEET_ID = 'site-menu'

function ThemeToggle() {
  const { dark, toggle } = useTheme()
  const { t } = useTranslation()
  return (
    <button type="button" onClick={toggle} aria-label={t('nav.changeTheme')} aria-pressed={dark} className="icon-btn">
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  )
}

/** Opens the command palette (W12.14): the keyboard's Ctrl+K, for a pointer or a phone. */
function PaletteButton({ wide = false }) {
  const { t } = useTranslation()
  const { openPalette, shortcut } = usePalette()
  const label = t('palette.open', { shortcut })
  if (wide) {
    return (
      <button type="button" onClick={openPalette} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" className="btn-ghost w-full justify-start gap-3">
        <Icon name="search" className="text-dim" />
        <span className="min-w-0 flex-1 truncate text-left font-normal text-muted">{label}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label={label}
      title={label}
      aria-keyshortcuts="Control+K Meta+K"
      aria-haspopup="dialog"
      className="icon-btn gap-2 xl:w-auto xl:px-2.5"
    >
      <Icon name="search" />
      <kbd aria-hidden="true" className="hidden rounded-[4px] border border-line-strong px-1.5 font-mono text-[11px] leading-5 text-dim xl:inline">
        {shortcut}
      </kbd>
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

  const item = 'menu-item'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('nav.account')}
        aria-expanded={open}
        aria-haspopup="menu"
        className="icon-btn rounded-full"
      >
        <Avatar account={account} size={28} />
      </button>
      {open && (
        <div role="menu" className="menu pop-in absolute right-0 mt-2 w-56">
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
            <Link role="menuitem" to="/notifications" className={item} onClick={() => setOpen(false)}>
              {t('notifications.title')}
            </Link>
            <Link role="menuitem" to="/settings" className={item} onClick={() => setOpen(false)}>
              {t('settings.title')}
            </Link>
            {/* W13.19: Mides moderators only; the page is a 404 for anyone else. */}
            {account.role === 'moderator' && (
              <Link role="menuitem" to="/staff" className={item} onClick={() => setOpen(false)}>
                {t('staff.nav')}
              </Link>
            )}
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

/** The places in the bar: quiet text, the current one lit with an accent rule on the bar's edge. */
function Places() {
  const { t } = useTranslation()
  const tab = ({ isActive }) =>
    `relative flex h-full shrink-0 items-center px-2.5 text-[13.5px] font-medium transition-colors duration-150 xl:px-3 ${
      isActive
        ? 'text-text after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:bg-accent xl:after:inset-x-3'
        : 'text-muted hover:text-text'
    }`
  return (
    // min-w-0 and its own scroll: at a large font size (W12.15) the places scroll rather than push the account off the bar.
    <nav aria-label="Overtone" className="hidden h-full min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] lg:flex">
      {LINKS.map((link) => (
        <NavLink key={link.to} to={link.to} end={link.end} className={tab}>
          {t(link.key)}
        </NavLink>
      ))}
    </nav>
  )
}

/** The phone's menu: the places as large rows, the palette, and the way to sign in. */
function Sheet({ account, onClose, firstRef }) {
  const { t } = useTranslation()
  const signInState = useSignInState()
  const row = ({ isActive }) =>
    `flex min-h-12 items-center justify-between rounded-control px-3 text-[17px] font-medium transition-colors ${
      isActive ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
    }`
  return (
    <>
      <div aria-hidden="true" className="fade-in fixed inset-x-0 bottom-0 top-[var(--bar-height)] z-30 bg-[var(--scrim)] lg:hidden" onClick={onClose} />
      <div id={SHEET_ID} className="sheet-in absolute inset-x-0 top-full z-40 max-h-[calc(100dvh-var(--bar-height))] overflow-y-auto border-b border-line bg-bg lg:hidden">
        <div className="space-y-4 py-4" style={gutter}>
          <nav aria-label="Overtone">
            <ul className="space-y-0.5">
              {LINKS.map((link, i) => (
                <li key={link.to}>
                  <NavLink ref={i === 0 ? firstRef : undefined} to={link.to} end={link.end} className={row} onClick={onClose}>
                    {({ isActive }) => (
                      <>
                        {t(link.key)}
                        {isActive && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="space-y-2 border-t border-line pt-4">
            <PaletteButton wide />
            {!account && (
              <Link to="/login" state={signInState} className="btn-primary w-full" onClick={onClose}>
                {t('nav.signIn')}
              </Link>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export default function Navbar() {
  const { t } = useTranslation()
  const { account } = useAuth()
  const { pathname } = useLocation()
  const signInState = useSignInState()
  const [open, setOpen] = useState(false)
  const menuButton = useRef(null)
  const firstLink = useRef(null)

  // A followed link, or the window growing past 1024 px, closes the sheet.
  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    if (!open) return undefined
    firstLink.current?.focus()
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      menuButton.current?.focus()
    }
    let wide
    try {
      wide = window.matchMedia('(min-width: 1024px)')
    } catch {
      wide = null
    }
    const onWide = (event) => event.matches && setOpen(false)
    document.addEventListener('keydown', onKey)
    wide?.addEventListener('change', onWide)
    return () => {
      document.removeEventListener('keydown', onKey)
      wide?.removeEventListener('change', onWide)
    }
  }, [open])

  return (
    <header id="site-navbar" className="sticky top-[env(safe-area-inset-top,0px)] z-40 border-b border-line bg-bg">
      <div className="mx-auto flex h-[var(--bar-height)] max-w-[76rem] items-center gap-5 xl:gap-8" style={gutter}>
        <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-control" aria-label="Overtone">
          <Mark size={22} />
          {/* Signed in, the bell and the account join the row: under 420 px on a touch screen
              (44 px targets) the name would push the menu button off the bar, so the mark stands alone. */}
          <span className={`wordmark ${account ? 'max-[419px]:hidden' : ''}`}>Overtone</span>
        </Link>

        <Places />

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <TrayButton />
          <div className="hidden lg:block">
            <PaletteButton />
          </div>
          <LanguageSelect />
          <ThemeToggle />
          {/* W13.17: the bell, for an account only, beside the account at every width; it polls once a minute while the tab is seen. */}
          {account && <Bell />}
          {account ? (
            <UserMenu account={account} />
          ) : (
            <Link to="/login" state={signInState} className="btn-ghost btn-sm ml-1.5 hidden lg:inline-flex">
              {t('nav.signIn')}
            </Link>
          )}
          <button
            ref={menuButton}
            type="button"
            className="icon-btn lg:hidden"
            aria-expanded={open}
            aria-controls={open ? SHEET_ID : undefined}
            aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? 'close' : 'menu'} />
          </button>
        </div>
      </div>
      {open && <Sheet account={account} onClose={() => setOpen(false)} firstRef={firstLink} />}
    </header>
  )
}
