import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { BUNDLED, CODES, DEFAULT, findLanguage, pickLanguage } from './lib/languages.js'
import en from './locales/en.json'

/**
 * Ten languages (W12.16; EN/ES since W3.7). The choice is stored as
 * `mides.lang`, the same key as midesprojects.com, so a visitor's language
 * follows them across the ecosystem on the same browser. Without a stored
 * choice the browser's languages decide, and English when none matches.
 *
 * English ships in the main bundle, as the default and every key's fallback.
 * The others, Spanish included (W10.1: 29 kB gzip an English visitor never
 * needs), are found by convention, `src/locales/<code>.json`, and Vite splits
 * each into its own chunk, fetched the first time the language is chosen; the
 * first frame waits for the starting one. A key a file lacks reads in English.
 */
export { LANGS } from './lib/languages.js'
const KEY = 'mides.lang'

const bundled = { en }
const lazy = import.meta.glob(['./locales/*.json', '!./locales/en.json'])

/** An i18next backend that hands over the bundled files and imports the rest. */
const localeFiles = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    if (BUNDLED.includes(language)) return callback(null, bundled[language])
    const load = lazy[`./locales/${language}.json`]
    if (!load) return callback(null, {})
    load().then(
      (module) => callback(null, module.default ?? module),
      (error) => callback(error, null),
    )
  },
}

const stored = () => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

const browser = () => (typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language])

const applyToDocument = (lng) => {
  const lang = findLanguage(lng)
  document.documentElement.lang = lang.code
  document.documentElement.dir = lang.dir
}

let starting = true
i18n.on('languageChanged', (lng) => {
  applyToDocument(lng)
  // A detected language is not stored: only a visitor's own choice is, so a
  // browser set to another language later is still followed.
  if (starting) return
  try {
    localStorage.setItem(KEY, lng)
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
})

/** Resolves once the starting language's strings are in, so the first frame is never English by mistake. */
export const ready = i18n
  .use(localeFiles)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    lng: pickLanguage(stored(), browser()),
    supportedLngs: CODES,
    load: 'currentOnly',
    fallbackLng: DEFAULT,
    // React already escapes what it renders.
    interpolation: { escapeValue: false },
    returnObjects: true,
  })
  .catch(() => i18n.changeLanguage(DEFAULT))
  .finally(() => {
    starting = false
  })

export default i18n
