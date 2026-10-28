/**
 * The glossary's terms (W12.12), in the order the glossary page lists them.
 * Each id is a key of `learn.glossary.terms` in the locale files and the
 * anchor of its entry on /glossary (`/glossary#drift`), so components/Term.jsx
 * and the page cannot disagree. test/learn.test.js checks every id has its
 * three strings in both languages.
 */
export const GLOSSARY = [
  'redLine',
  'greenLine',
  'offset',
  'bpm',
  'meter',
  'kiai',
  'drift',
  'fit',
  'onset',
  'confidence',
  'octave',
  'beatThis',
]

