import { Component } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Catches a page that throws while it renders (W10.4) and shows a plain page
 * with a reload button instead of a blank screen. The error goes to the
 * console for whoever is debugging; the visitor never sees a stack trace or
 * the error's own message, which can name code paths.
 *
 * Layout puts one around the routes, keyed by the path, so moving to another
 * page clears it and the navigation bar keeps working. main.jsx puts one
 * around everything, for an error in the frame itself.
 */
export function ErrorPage() {
  const { t } = useTranslation()
  return (
    <div role="alert" className="mx-auto max-w-[60ch] space-y-5 px-4 py-16 text-center">
      <p className="readout text-[56px] font-semibold leading-none text-red" aria-hidden="true">
        !
      </p>
      <h1 className="font-display text-title font-bold uppercase">{t('errorPage.title')}</h1>
      <p className="leading-relaxed text-muted">{t('errorPage.body')}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
          {t('errorPage.reload')}
        </button>
        {/* A plain link, not the router's: the router may be what broke. */}
        <a href="/" className="btn-ghost">
          {t('errorPage.home')}
        </a>
      </div>
    </div>
  )
}

export default class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('[overtone] a page failed to render:', error, info?.componentStack)
  }

  render() {
    return this.state.failed ? <ErrorPage /> : this.props.children
  }
}
