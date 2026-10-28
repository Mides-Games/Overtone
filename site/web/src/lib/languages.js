/**
 * The site's languages (W12.16): the one list the selector, the settings
 * page, the command palette and the locale tests read. Pure, so the tests
 * reach it without Vite.
 *
 * `code` is the i18next code and the locale file's name
 * (`src/locales/<code>.json`), `name` the language's own name, `flag` the
 * id of its flag in components/Flag.jsx and `dir` the text direction. The
 * Spanish flag is Spain's (the owner's choice).
 */
export const LANGS = [
  { code: 'en', name: 'English', flag: 'gb', dir: 'ltr' },
  { code: 'es', name: 'Español', flag: 'es', dir: 'ltr' },
  { code: 'fr', name: 'Français', flag: 'fr', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', flag: 'de', dir: 'ltr' },
  { code: 'it', name: 'Italiano', flag: 'it', dir: 'ltr' },
  { code: 'pl', name: 'Polski', flag: 'pl', dir: 'ltr' },
  { code: 'pt-BR', name: 'Português do Brasil', flag: 'br', dir: 'ltr' },
  { code: 'ja', name: '日本語', flag: 'jp', dir: 'ltr' },
  { code: 'ko', name: '한국어', flag: 'kr', dir: 'ltr' },
  { code: 'ru', name: 'Русский', flag: 'ru', dir: 'ltr' },
]

export const CODES = LANGS.map((lang) => lang.code)

/** Bundled with the page; the others are fetched when chosen. */
export const BUNDLED = ['en']

export const DEFAULT = 'en'

export const findLanguage = (code) => LANGS.find((lang) => lang.code === code) ?? LANGS[0]

/**
 * The site's language for a BCP 47 tag, or null: the exact code first
 * ("pt-BR", any case), then the first with the same primary language, so
 * "pt-PT" and "pt" read Brazilian Portuguese and "es-MX" reads Spanish.
 */
export function matchLanguage(tag) {
  if (typeof tag !== 'string' || !tag) return null
  const lower = tag.toLowerCase()
  const exact = LANGS.find((lang) => lang.code.toLowerCase() === lower)
  if (exact) return exact.code
  const primary = lower.split(/[-_]/)[0]
  return LANGS.find((lang) => lang.code.toLowerCase().split('-')[0] === primary)?.code ?? null
}

/**
 * The language to start in: the stored choice when it is one of the ten,
 * otherwise the browser's first preference the site has, otherwise English.
 */
export function pickLanguage(stored, preferred = []) {
  if (CODES.includes(stored)) return stored
  for (const tag of preferred ?? []) {
    const match = matchLanguage(tag)
    if (match) return match
  }
  return DEFAULT
}
