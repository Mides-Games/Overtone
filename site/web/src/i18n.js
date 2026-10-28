import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'

/**
 * Spanish is its own chunk (W10.1): 29 kB gzip that an English visitor never
 * needs. English stays bundled, as the default and every key's fallback.
 * i18next asks this backend for any language it lacks, and changeLanguage
 * waits for it, so a switch to Spanish never shows a half-translated page;
 * main.jsx waits for the first language before it renders.
 */
const lazyLocales = {
  type: 'backend',
  init() {},
  read(language, _namespace, callback) {
    if (language !== 'es') return callback(null, {})
    import('./locales/es.json').then(
      (module) => callback(null, module.default),
      (error) => callback(error, false),
    )
  },
}

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

/** Resolves once the stored language is loaded (at once for English). */
export const i18nReady = i18n.use(lazyLocales).use(initReactI18next).init({
  resources: { en: { translation: en } },
  partialBundledLanguages: true,
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
