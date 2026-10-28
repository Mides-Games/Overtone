/**
 * What an upload's own words are allowed to become. Pure functions, so the
 * tests reach them without a server.
 */

/** The audio formats the engine decodes (librosa/soundfile, FFmpeg for the compressed ones). */
export const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus'];

const UNSAFE = /[\u0000-\u001f\u007f<>:"|?*\\/]/g;

/**
 * Characters a label must not carry, because they change how the text around
 * them reads without being seen: C1 controls, the bidi marks, embeddings,
 * overrides and isolates (an RLO turns "song‮vaw.exe" into what looks like
 * "songexe.wav" on the public queue), the zero-width characters and the BOM.
 */
export const INVISIBLE = /[\u0080-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * The display name of an upload from its `X-Filename` header (percent-encoded
 * by the web, since a header is Latin-1). Only the last path segment, no
 * control or path characters, at most 200 characters with the extension
 * kept. It is shown back to its uploader and never used as a path.
 * `null` when nothing usable is left.
 */
export const cleanFilename = (raw) => {
  if (typeof raw !== 'string' || !raw) return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded: take it as it came.
  }
  name = name.split(/[\\/]/).pop().replace(UNSAFE, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  if (!name) return null;
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
};

/** The lower-case extension when it is one the engine reads, else `null`. */
export const audioExtension = (name) => {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name ?? '');
  const ext = match?.[1].toLowerCase();
  return ext && AUDIO_EXTENSIONS.includes(ext) ? ext : null;
};

/** A filename for a download, ASCII only: `<song>-timing.txt`. */
export const downloadName = (filename, suffix) => {
  const stem = (filename ?? 'overtone').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._ -]+/g, '').trim().slice(0, 80);
  return `${stem || 'overtone'}-${suffix}`;
};

/**
 * One CSV cell. Numbers go as they are. Text that a spreadsheet would run as a
 * formula (a leading = + - @, or a tab or carriage return before one) gets a
 * leading apostrophe, and anything with a comma, quote or line break is quoted.
 */
export const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let cell = String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
};

/** The red lines as CSV: one row per line, the numbers the result carries. */
export const timingCsv = (result) => {
  const rows = ['time_ms,bpm,beat_length_ms,meter,confidence,level'];
  (result?.red_lines ?? []).forEach((line, i) => {
    const section = result.sections?.[i] ?? {};
    rows.push([line.time_ms, line.bpm, line.beat_length_ms, line.meter, section.confidence, section.level].map(csvCell).join(','));
  });
  return `${rows.join('\r\n')}\r\n`;
};

/** The `[TimingPoints]` block as an .osu file writes it, CRLF included. */
export const timingText = (result) => {
  const lines = String(result?.osu_timing ?? '').split(/\r?\n/).filter(Boolean);
  return `[TimingPoints]\r\n${lines.join('\r\n')}\r\n`;
};

/**
 * A tag the browser read from the audio (`X-Title`, `X-Artist`), cleaned like
 * a file name but keeping slashes, which titles use. `null` when empty.
 */
export const cleanTag = (raw) => {
  if (typeof raw !== 'string' || !raw) return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded: take it as it came.
  }
  value = value.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return value || null;
};

/**
 * What the public queue calls a song: "Artist - Title" from the tags, the
 * title alone, or the file name without its extension and with its
 * underscores and dots as spaces.
 */
export const songLabel = ({ tagArtist, tagTitle, filename }) => {
  if (tagTitle) return tagArtist ? `${tagArtist} - ${tagTitle}` : tagTitle;
  const stem = (filename ?? '').replace(/\.[^.]*$/, '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return stem || null;
};
