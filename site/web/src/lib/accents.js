/**
 * A profile's accent (2026-10-28): the palette a person picks their page's
 * colour from. The API keeps only the name (site/api utils/profile.js
 * ACCENTS, the same six); the colours live here, one set per theme, and
 * test/accents.test.js checks every one for WCAG AA (4.5:1) as text on each
 * of its theme's surfaces, and its ink on it as a button's fill. A colour
 * that fails is not shipped, whatever it looks like.
 *
 * Only `--accent`, its hover and its ink change, and only inside the profile
 * (the `.profile-accent` wrapper, index.css): the site around it keeps its
 * teal, and the high-contrast setting keeps its own accent everywhere.
 */
export const ACCENTS = {
  blue: {
    light: { accent: '#1d5fb8', hover: '#174d96', ink: '#ffffff' },
    dark: { accent: '#6cb2ff', hover: '#93c6ff', ink: '#06182c' },
  },
  violet: {
    light: { accent: '#6b3fc0', hover: '#58329f', ink: '#ffffff' },
    dark: { accent: '#b79cff', hover: '#cbb7ff', ink: '#1a0d36' },
  },
  pink: {
    light: { accent: '#b02a6b', hover: '#922158', ink: '#ffffff' },
    dark: { accent: '#ff8cc6', hover: '#ffaed6', ink: '#33091d' },
  },
  orange: {
    light: { accent: '#9a4a00', hover: '#7e3c00', ink: '#ffffff' },
    dark: { accent: '#ffad5c', hover: '#ffc285', ink: '#2e1600' },
  },
  green: {
    light: { accent: '#2f6b1a', hover: '#255515', ink: '#ffffff' },
    dark: { accent: '#8fd16a', hover: '#a8de8a', ink: '#11240a' },
  },
  red: {
    light: { accent: '#ad2834', hover: '#8f202b', ink: '#ffffff' },
    dark: { accent: '#ff7a86', hover: '#ff9ea7', ink: '#2b070b' },
  },
}

export const ACCENT_NAMES = Object.keys(ACCENTS)

/**
 * The wrapper's props for `name`: a class and the six custom properties the
 * class reads per theme. Nothing for the default (or a name this build does
 * not know, from a newer API), so the site's own accent stays.
 */
export function accentProps(name) {
  const set = ACCENTS[name]
  if (!set) return {}
  return {
    className: 'profile-accent',
    style: {
      '--pa-light': set.light.accent,
      '--pa-light-hover': set.light.hover,
      '--pa-light-ink': set.light.ink,
      '--pa-dark': set.dark.accent,
      '--pa-dark-hover': set.dark.hover,
      '--pa-dark-ink': set.dark.ink,
    },
  }
}

/** WCAG 2 relative luminance of `#rrggbb`. */
export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
