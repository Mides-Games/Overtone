import { useTranslation } from 'react-i18next'
import { Outlet, useLocation } from 'react-router'

import { gutter } from '../lib/gutter.js'
import ErrorBoundary from './ErrorBoundary.jsx'
import Footer from './Footer.jsx'
import Navbar from './Navbar.jsx'
import TickerBar from './TickerBar.jsx'
import Tray from './Tray.jsx'

/**
 * The page frame: the signal strip and the instrument bar stay together at the
 * top, then the page in one column, then the footer, and the analysis tray
 * over all of it, so a song being analysed is followed on every page.
 *
 * The page sits in an error boundary keyed by its path (W10.4): a page that
 * throws shows the error page inside the frame, and going anywhere else from
 * the navigation bar starts clean.
 */
export default function Layout() {
  const { t } = useTranslation()
  const { pathname } = useLocation()

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main-content" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <div className="sticky top-[env(safe-area-inset-top,0px)] z-40">
        <TickerBar />
        <Navbar />
      </div>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 py-10 outline-none sm:py-14" style={gutter}>
        <ErrorBoundary key={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <Footer />
      <Tray />
    </div>
  )
}
