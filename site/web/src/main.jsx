import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'

import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { SettingsProvider } from './context/SettingsContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { ready } from './i18n.js'
import { registerServiceWorker } from './lib/pwa.js'

// W12.23: the installable app's worker (public/sw.js), in a production build only.
registerServiceWorker()

const root = createRoot(document.getElementById('root'))

// W12.16: until the starting language's strings are in (a language other
// than EN/ES is fetched first), BrandLoader's beats without its words: there
// are none to show yet, and English would be the wrong ones.
const BEATS = ['var(--red)', 'var(--accent)', 'var(--accent)', 'var(--accent)']
root.render(
  <div className="flex min-h-dvh items-center justify-center" role="status" aria-busy="true">
    <span className="flex h-7 items-end gap-1.5" aria-hidden="true">
      {BEATS.map((color, i) => (
        <span key={i} className="beat-bar h-full" style={{ background: color, animationDelay: `${i * 0.3}s` }} />
      ))}
    </span>
  </div>,
)

ready.then(() =>
  root.render(
    <StrictMode>
      {/* The last net, for an error in the frame itself; pages have their own (Layout). */}
      <ErrorBoundary>
        <BrowserRouter>
          <ThemeProvider>
            <SettingsProvider>
              <AuthProvider>
                <App />
              </AuthProvider>
            </SettingsProvider>
          </ThemeProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  ),
)
