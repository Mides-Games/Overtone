import './index.css'
import { i18nReady } from './i18n.js'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'

import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { SettingsProvider } from './context/SettingsContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { registerServiceWorker } from './lib/pwa.js'

// W12.23: the installable app's worker (public/sw.js), in a production build only.
registerServiceWorker()

// A Spanish visitor's strings are a chunk of their own (i18n.js): the first
// frame waits for them rather than flash English. If they fail to load, the
// page renders in English, i18next's fallback.
await i18nReady.catch(() => {})

createRoot(document.getElementById('root')).render(
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
)
