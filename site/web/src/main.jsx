import './index.css'
import './i18n.js'

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
