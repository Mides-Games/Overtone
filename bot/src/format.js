/**
 * Embeds, as the plain objects Discord's API takes (discord.js passes them
 * through), so the tests read them without a client. Everything shown comes
 * from the API's summary (site/api bot.routes.js `summary`): no hash, no
 * file name of a private upload, no Discord id of anyone but the caller.
 *
 * No image of the tempo chart: rendering the site's chart server side means a
 * headless browser or a canvas library for one picture, too heavy for this
 * bot. The embed links the page, which draws it (docs/bot.md).
 */

// The site's palette (site/web src/index.css): accent, and the confidence levels.
export const COLORS = { accent: 0x0a84ff, high: 0x30d158, medium: 0xffd60a, check: 0xff9f0a, failed: 0xff453a };

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Markdown in a song's name would change how the embed reads: shown as text. */
const plain = (text) =>
  String(text ?? '')
    .replace(/([\\*_`~|[\]()<>])/g, '\\$1')
    .replace(/^([#-])/, '\\$1')
    .replace(/@/g, '@​');

export const bpmText = (bpm) => (typeof bpm === 'number' ? String(Math.round(bpm * 100) / 100) : '–');
export const msText = (ms) => (typeof ms === 'number' ? `${Math.round(ms * 10) / 10} ms` : '–');
export const percent = (value) => (typeof value === 'number' ? `${Math.round(value * 100)} %` : '–');

export const songTitle = (s, t) => {
  const name = [s.artist, s.title].filter(Boolean).join(' - ');
  return clip(plain(name || t.unnamed), 240);
};

/** The finished (or refused, or failed) analysis. */
export const analysisEmbed = (s, t) => {
  if (s.status === 'failed') {
    return { color: COLORS.failed, title: t.failed, description: clip(`${songTitle(s, t)}\n${s.error ?? ''}`, 1000) };
  }
  if (s.status === 'refused') {
    return { color: COLORS.check, title: t.refused, description: clip(`${songTitle(s, t)}\n${s.refusal ?? ''}`, 1000), ...(s.url ? { url: s.url } : {}) };
  }
  const level = s.level ? `${t.level[s.level] ?? s.level} (${percent(s.confidence)})` : percent(s.confidence);
  const fields = [
    { name: t.bpm, value: `${bpmText(s.bpm)}${s.variable ? ` · ${t.variable}` : ''}`, inline: true },
    { name: t.offset, value: msText(s.offsetMs), inline: true },
    { name: t.redLines, value: String(s.redLines ?? 0), inline: true },
    { name: t.confidence, value: level, inline: true },
  ];
  if (s.meter) fields.push({ name: t.meter, value: clip(s.meter, 16), inline: true });
  const notes = [
    s.uploader ? t.by(plain(s.uploader.displayName || s.uploader.username)) : s.anonymous ? t.by(t.anonymous) : null,
    s.cached ? t.cachedNote : null,
    s.url ? `[${t.open}](${s.url})` : t.noPage,
  ].filter(Boolean);
  return {
    color: COLORS[s.level] ?? COLORS.accent,
    title: `${t.done}: ${songTitle(s, t)}`.slice(0, 256),
    ...(s.url ? { url: s.url } : {}),
    description: notes.join('\n'),
    fields,
  };
};

/** The reply while it waits: a line, edited as the place and the progress move. */
export const progressText = (s, t) => {
  if (s.status === 'queued') return s.position ? t.queued(s.position) : t.queuedSoon;
  if (s.status === 'running') return t.running(Math.round((s.progress ?? 0) * 100), s.stage);
  return t.analysing;
};

export const queueEmbed = (q, t) => ({
  color: COLORS.accent,
  title: t.queue,
  fields: [
    { name: t.waiting, value: String(q.waiting), inline: true },
    { name: t.runningNow, value: String(q.running), inline: true },
    { name: t.lastHour, value: String(q.finishedLastHour), inline: true },
    ...(q.mine?.length
      ? [{
          name: t.yours,
          value: clip(
            q.mine.slice(0, 10).map((m) => `${m.position ? t.position(m.position) : t.runningNow} · ${songTitle(m, t)}`).join('\n'),
            1000,
          ),
        }]
      : []),
  ],
});

/** Two timings side by side, and how far apart they are. */
export const compareEmbed = (a, b, t) => {
  const row = (s) => `${bpmText(s.bpm)} BPM · ${msText(s.offsetMs)} · ${s.redLines} ${t.redLines.toLowerCase()}`;
  const same = a.bpm === b.bpm && a.offsetMs === b.offsetMs && a.redLines === b.redLines;
  const delta = [
    typeof a.bpm === 'number' && typeof b.bpm === 'number' ? `${bpmText(b.bpm - a.bpm)} BPM` : null,
    typeof a.offsetMs === 'number' && typeof b.offsetMs === 'number' ? msText(b.offsetMs - a.offsetMs) : null,
  ].filter(Boolean).join(' · ');
  return {
    color: COLORS.accent,
    title: t.compare,
    fields: [
      { name: `A: ${songTitle(a, t)}`.slice(0, 256), value: row(a) },
      { name: `B: ${songTitle(b, t)}`.slice(0, 256), value: row(b) },
      { name: t.delta, value: same ? t.same : delta || '–' },
    ],
  };
};

export const recentEmbed = (name, timings, t) => ({
  color: COLORS.accent,
  title: t.recent(plain(name)).slice(0, 256),
  description: clip(
    timings.map((s) => `[${songTitle(s, t)}](${s.url}) · ${bpmText(s.bpm)} BPM`).join('\n'),
    4000,
  ),
});
