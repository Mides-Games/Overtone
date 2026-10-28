import { createContext, useContext, useEffect, useState } from 'react'

import { THEME_KEY, isDark, readTheme } from '../lib/settings.js'

/**
 * Light and dark, class-based, stored as `mides.theme` like midesprojects.com.
 * Dark is the default there and here. index.html applies the stored choice
 * before the first frame; this keeps it in sync afterwards.
 *
 * The settings page (W12.15) adds a third choice, `system`, which follows the
 * operating system's light or dark and changes with it. The navigation bar's
 * toggle still flips between the two explicit ones.
 */
const ThemeContext = createContext(null)

const systemLight = () => {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

const storedTheme = () => {
  try {
    return readTheme(localStorage.getItem(THEME_KEY))
  } catch {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  }
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(storedTheme)
  const [light, setLight] = useState(systemLight)
  const dark = isDark(theme, light)

  // The system's own switch, which only matters while the choice is `system`.
  useEffect(() => {
    let query
    try {
      query = window.matchMedia('(prefers-color-scheme: light)')
    } catch {
      return undefined
    }
    const follow = (event) => setLight(event.matches)
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [])

  // Another tab's choice, so two open pages never disagree.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === THEME_KEY) setTheme(readTheme(event.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, [theme])

  const value = {
    dark,
    theme,
    setTheme: (next) => setTheme(readTheme(next)),
    toggle: () => setTheme(dark ? 'light' : 'dark'),
  }
  return <ThemeContext value={value}>{children}</ThemeContext>
}

export const useTheme = () => useContext(ThemeContext)
