import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigationType } from 'react-router'

import { gutter } from '../lib/gutter.js'
import { PaletteProvider } from './CommandPalette.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import Footer from './Footer.jsx'
import Navbar from './Navbar.jsx'
import TickerBar from './TickerBar.jsx'
import Tray from './Tray.jsx'

/**
 * The page frame: the status line, the bar (which stays at the top), then the
 * page in one 76rem column, then the footer, and the analysis tray over all
 * of it, so a song being analysed is followed on every page.
 *
 * The page sits in an error boundary keyed by its path (W10.4): a page that
 * throws shows the error page inside the frame, and going anywhere else from
 * the navigation bar starts clean.
 *
 * The page area is at least a screen tall (W10.1), so the footer starts below
 * the fold. Pages fill in after a request (a lazy chunk, a list, a result),
 * and a footer in view was pushed down each time: layout shifts of 0.19-1.0
 * on a phone (site/e2e/vitals.mjs), against the 0.1 budget.
 */
/**
 * A followed link opens its page at the top, as a page load would; the
 * browser keeps the scroll of the page before, since the frame stays. Only on
 * a new page or a link to the page already open (the bar's "Analyze" from
 * halfway down /analyze): a list that changes its ?sort= keeps its place, Back
 * and Forward keep the browser's, and a #section link scrolls to that section.
 */
function useScrollToTop() {
  const { pathname, search, hash, key } = useLocation()
  const type = useNavigationType()
  const before = useRef({ pathname, search, key })

  useEffect(() => {
    const was = before.current
    before.current = { pathname, search, key }
    if (key === was.key || type === 'POP' || hash) return
    if (pathname !== was.pathname || search === was.search) window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [pathname, search, hash, key, type])
}

export default function Layout() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  useScrollToTop()

  return (
    // The palette's provider holds the global keys (Ctrl+K, ?) and both dialogs, on every page.
    <PaletteProvider>
      <div className="flex min-h-screen flex-col">
        <a href="#main-content" className="skip-link">
          {t('common.skipToContent')}
        </a>
        {/* The status line scrolls away; the bar stays (it is sticky itself). */}
        <TickerBar />
        <Navbar />
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[76rem] min-h-[100svh] flex-1 py-10 outline-none sm:py-14" style={gutter}>
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
        <Footer />
        <Tray />
      </div>
    </PaletteProvider>
  )
}
