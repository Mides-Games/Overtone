import { useTranslation } from 'react-i18next'
import { Outlet } from 'react-router'

import { gutter } from '../lib/gutter.js'
import Footer from './Footer.jsx'
import Navbar from './Navbar.jsx'
import TickerBar from './TickerBar.jsx'

/**
 * The page frame: the signal strip and the instrument bar stay together at the
 * top, then the page in one column, then the footer.
 */
export default function Layout() {
  const { t } = useTranslation()

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
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
