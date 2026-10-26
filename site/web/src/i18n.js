import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import es from './locales/es.json'

/**
 * EN/ES from day one (phase W3.7). The choice is stored as `mides.lang`, the
 * same key as midesprojects.com, so a visitor's language follows them across
 * the ecosystem on the same browser. English is the default, as there.
 */
export const LANGS = ['en', 'es']
const KEY = 'mides.lang'

const stored = () => {
  try {
    const value = localStorage.getItem(KEY)
    return LANGS.includes(value) ? value : 'en'
  } catch {
    return 'en'
  }
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: stored(),
  fallbackLng: 'en',
  // React already escapes what it renders.
  interpolation: { escapeValue: false },
  returnObjects: true,
})

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
  try {
    localStorage.setItem(KEY, lng)
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
})

export default i18n
