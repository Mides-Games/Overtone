import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Light and dark, class-based, stored as `mides.theme` like midesprojects.com.
 * Dark is the default there and here. index.html applies the stored choice
 * before the first frame; this keeps it in sync afterwards.
 */
const ThemeContext = createContext(null)
const KEY = 'mides.theme'

export function ThemeProvider({ children }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem(KEY, dark ? 'dark' : 'light')
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, [dark])

  return <ThemeContext value={{ dark, toggle: () => setDark((d) => !d) }}>{children}</ThemeContext>
}

export const useTheme = () => useContext(ThemeContext)
