import { createContext, useContext, useEffect, useState } from 'react'

import { DEFAULTS, SETTINGS_KEY, applySettings, readSettings, serializeSettings } from '../lib/settings.js'

/**
 * The display settings (W12.15) as React state: read from
 * `overtone.settings`, applied to <html> on every change and written back.
 * index.html has already applied the stored ones before the first frame, so
 * the first application here changes nothing on screen. The theme and the
 * language keep their own providers and keys (ThemeContext, i18n.js).
 */
const SettingsContext = createContext(null)

const stored = () => {
  try {
    return readSettings(localStorage.getItem(SETTINGS_KEY))
  } catch {
    return { ...DEFAULTS }
  }
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(stored)

  useEffect(() => {
    applySettings(document.documentElement, settings)
    try {
      localStorage.setItem(SETTINGS_KEY, serializeSettings(settings))
    } catch {
      // Storage blocked: the settings last for this page only.
    }
  }, [settings])

  // Another tab's change, so two open pages never disagree.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === SETTINGS_KEY) setSettings(readSettings(event.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const value = {
    settings,
    update: (patch) => setSettings((current) => readSettings(JSON.stringify({ ...current, ...patch }))),
    reset: () => setSettings({ ...DEFAULTS }),
  }
  return <SettingsContext value={value}>{children}</SettingsContext>
}

export const useSettings = () => useContext(SettingsContext)
