import { INVISIBLE } from './upload.js';

/**
 * What a person's own words may become before they are stored (W5.2-W5.4):
 * suggestions, reviews, reports and moderators' reasons. Pure, so the tests
 * reach it without a server.
 *
 * The web renders all of it as text, never as HTML, so `<` and `>` are kept
 * ("<3", "a < b"): stripping them would protect nothing and mangle the words.
 * What goes is what changes how text reads without being seen: control
 * characters (a line break only where `multiline` allows it), the bidi
 * overrides and isolates, zero-width characters and the BOM (the list
 * `cleanTag` uses for the queue). Then the length cap, after cleaning, so
 * invisible padding cannot spend it.
 *
 * Returns `null` when nothing is left.
 */
export const cleanText = (raw, max, { multiline = false } = {}) => {
  if (typeof raw !== 'string') return null;
  let text = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(INVISIBLE, '');
  if (multiline) {
    text = text
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      .split('\n')
      .map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
      .join('\n')
      // At most one empty line in a row: a wall of blank lines is a way to
      // push a list around, not a paragraph break.
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Cut by code points, so a cap never splits a surrogate pair in half.
  const points = [...text];
  if (points.length > max) text = points.slice(0, max).join('').trimEnd();
  return text || null;
};

/** Length in code points, as the caps count it (an emoji is one, not two). */
export const textLength = (text) => [...(text ?? '')].length;
