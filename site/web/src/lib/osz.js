/**
 * A song's .osz, built in the browser from the reader's own file and the
 * timing as they have it: double-clicked, osu!stable imports it as a new
 * beatmap set with one difficulty that holds the red lines and nothing else,
 * ready for the editor.
 *
 * The audio never goes through the server (ADR-W4): it is the file the
 * reader uploaded or picked again, already checked against the analysis's
 * SHA-1 by the page.
 */
import { breakRows, DEFAULT_DIFFICULTY, DIFFICULTIES, normalKeys, normalMode, redPoints, SNAP_DIVISORS, testObjects, testVersion } from './mapping.js'
import { timingText } from './timing.js'
import { zipStore } from './zip.js'

/** osu! keeps Title and Artist ASCII and the rest in the *Unicode fields. */
const ascii = (text) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** One line of a section: no line breaks, which would start another key. */
const field = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').trim()

/** A name safe on every file system osu! runs on. */
const safeName = (text) =>
  text
    .replace(/[<>:"/\|?*\u0000-\u001f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)

/** Title and artist: the file's tags, else its name read as "Artist - Title", else the name. */
export function songNames({ tagTitle, tagArtist, filename }) {
  const stem = String(filename ?? 'Untitled').replace(/\.[^.]*$/, '').trim() || 'Untitled'
  if (tagTitle) return { title: field(tagTitle), artist: field(tagArtist) || 'Unknown' }
  const split = /^(.+?)\s+-\s+(.+)$/.exec(stem)
  if (split) return { artist: field(split[1]), title: field(split[2]) }
  return { title: field(stem), artist: field(tagArtist) || 'Unknown' }
}

/**
 * The tags every map Overtone builds carries, so a map made with it can be
 * found by them (the owner's rule, 2026-10-27). Always first, never dropped.
 */
export const OVERTONE_TAGS = ['overtone', 'overtone_timings']

/**
 * `[Metadata] Tags`: Overtone's two, then any `extra` (a string or a list)
 * the caller passes, split on spaces as osu! splits them, without repeats or
 * line breaks.
 */
export function mapTags(extra = '') {
  const words = (Array.isArray(extra) ? extra.join(' ') : String(extra ?? ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const seen = new Set()
  return [...OVERTONE_TAGS, ...words].filter((word) => {
    const key = word.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).join(' ')
}

/**
 * Red rows and green `{ timeMs, row }` lines in osu!'s order: by time, a red
 * line before a green one at the same ms (the green one then overrides its
 * effects, as the editor writes them).
 */
export function mergeRows(reds, greens = []) {
  const all = [
    ...reds.map((row, i) => ({ timeMs: Number(row.split(',')[0]), red: 0, i, row })),
    ...greens.map((g, i) => ({ timeMs: g.timeMs, red: 1, i, row: g.row })),
  ]
  return all.sort((a, b) => a.timeMs - b.timeMs || a.red - b.red || a.i - b.i).map((x) => x.row)
}

/**
 * The .osu file (format v14): the general and metadata sections a new map
 * gets in the editor, osu!'s default difficulty, the red lines in
 * `[TimingPoints]` and no hit objects. Comment rows are left out: osu! reads
 * the file, a person reads the page. `lines` are the export's (after the
 * export options, `exportLines`) and `options` those options.
 *
 * The W12.9 extras, each optional: `previewMs` (else -1, osu!'s "none"),
 * `leadInMs`, `background` (the image's name in the .osz, written in
 * `[Events]` as the editor writes it) and `greens`, kiai green lines from
 * lib/osz-suggest.js `kiaiRows`.
 *
 * The W13 ones, each optional and lib/mapping.js's: `mode` (0-3) and, for
 * mania, `keys` written as `CircleSize`; `beatDivisor` (the suggested one,
 * else osu!'s 4); `breaks` in `[Events]`; `version` and `difficulty` (`{ hp,
 * cs, od, ar }`) for a set's other difficulties; `hitObjects`, the test map's
 * rows.
 */
export function osuFile({
  title,
  artist,
  creator,
  audioName,
  lines,
  result,
  adjustment,
  options = null,
  previewMs = null,
  leadInMs = 0,
  background = null,
  greens = [],
  tags = '',
  mode = 0,
  keys = 4,
  beatDivisor = 4,
  breaks = [],
  version = 'Timing',
  difficulty = DEFAULT_DIFFICULTY,
  hitObjects = [],
}) {
  const rows = mergeRows(redRows(result, lines, adjustment, options), greens)
  const m = normalMode(mode)
  const divisor = SNAP_DIVISORS.includes(beatDivisor) ? beatDivisor : 4
  const cs = m === 3 ? normalKeys(keys) : difficulty.cs
  const preview = Number.isFinite(previewMs) && previewMs >= 0 ? Math.round(previewMs) : -1
  const lead = Number.isFinite(leadInMs) && leadInMs > 0 ? Math.round(leadInMs) : 0
  const titleAscii = ascii(title) || 'Untitled'
  const artistAscii = ascii(artist) || 'Unknown'
  return [
    'osu file format v14',
    '',
    '[General]',
    `AudioFilename: ${audioName}`,
    `AudioLeadIn: ${lead}`,
    `PreviewTime: ${preview}`,
    'Countdown: 0',
    'SampleSet: Soft',
    'StackLeniency: 0.7',
    `Mode: ${m}`,
    'LetterboxInBreaks: 0',
    'WidescreenStoryboard: 1',
    '',
    '[Editor]',
    'DistanceSpacing: 1',
    `BeatDivisor: ${divisor}`,
    'GridSize: 32',
    'TimelineZoom: 1',
    '',
    '[Metadata]',
    `Title:${titleAscii}`,
    `TitleUnicode:${field(title) || titleAscii}`,
    `Artist:${artistAscii}`,
    `ArtistUnicode:${field(artist) || artistAscii}`,
    `Creator:${field(creator) || 'Overtone'}`,
    `Version:${field(version) || 'Timing'}`,
    'Source:',
    `Tags:${mapTags(tags)}`,
    'BeatmapID:0',
    'BeatmapSetID:-1',
    '',
    '[Difficulty]',
    `HPDrainRate:${difficulty.hp}`,
    `CircleSize:${cs}`,
    `OverallDifficulty:${difficulty.od}`,
    `ApproachRate:${difficulty.ar}`,
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    '',
    '[Events]',
    '//Background and Video events',
    ...(background ? [`0,0,"${background}",0,0`] : []),
    '//Break Periods',
    ...breakRows(breaks),
    '',
    '[TimingPoints]',
    ...rows,
    '',
    '',
    '[HitObjects]',
    ...hitObjects,
    '',
  ].join('\r\n')
}

/** The export's red lines as `[TimingPoints]` rows, comments left out: osu! reads the file, a person reads the page. */
export function redRows(result, lines, adjustment, options = null) {
  return timingText(result, lines, adjustment, options)
    .split('\r\n')
    .filter((row) => row && row !== '[TimingPoints]' && !row.startsWith('//'))
}

/**
 * The .osz: the audio as `audio.<ext>` and the .osu named as osu! names its
 * own (`Artist - Title (Creator) [Version].osu`). Returns `{ name, bytes }`.
 *
 * `extras` holds what the reader ticked under ".osz options": `cover`
 * (`{ ext, bytes }` from lib/tags.js `readCover`, written as `bg.<ext>`),
 * `previewMs`, `leadInMs` and `greens`; and the W13 ones: `beatDivisor`,
 * `breaks`, `mode` and `keys` (every difficulty's), `difficulties` (names
 * from lib/mapping.js `DIFFICULTIES`, each an empty .osu with the same
 * timing) and `testSub` (1 or 2: a playable test difficulty with a circle on
 * every beat or half beat, W13.1). Left out, the .osz is what it was.
 */
export async function buildOsz({ file, analysis, lines, adjustment, creator, options = null, extras = {} }) {
  const { title, artist } = songNames({ ...analysis, filename: analysis.filename ?? file.name })
  const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(file.name)?.[0] ?? '.mp3').toLowerCase()
  const audioName = `audio${ext}`
  const who = field(creator) || 'Overtone'
  const set = safeName(`${artist} - ${title}`) || 'Overtone'
  const { cover = null, previewMs = null, leadInMs = 0, greens = [], beatDivisor = 4, breaks = [], mode = 0, keys = 4, difficulties = [], testSub = null } = extras
  const background = cover && /^(jpg|png)$/.test(cover.ext) ? `bg.${cover.ext}` : null
  const base = { title, artist, creator: who, audioName, lines, result: analysis.result, adjustment, options, previewMs, leadInMs, background, greens, beatDivisor, breaks, mode, keys }
  // A version's "/" (the test map's "1/2") cannot be in a file name: osu! reads the version from the file, not its name.
  const osuName = (version) => `${safeName(`${artist} - ${title} (${who}) [${version.replace(/\//g, '-')}]`) || 'overtone'}.osu`
  const sets = [{ version: 'Timing' }, ...DIFFICULTIES.filter((d) => difficulties.includes(d.name)).map((d) => ({ version: d.name, difficulty: d }))]
  if (testSub) {
    const durationMs = (analysis.result?.duration_s ?? 0) * 1000
    const points = redPoints(redRows(analysis.result, lines, adjustment, options))
    sets.push({ version: testVersion(testSub), hitObjects: testObjects({ points, durationMs, sub: testSub, mode, keys, breaks }) })
  }
  const bytes = zipStore([
    { name: audioName, data: new Uint8Array(await file.arrayBuffer()) },
    ...sets.map((set) => ({ name: osuName(set.version), text: osuFile({ ...base, ...set }) })),
    ...(background ? [{ name: background, data: cover.bytes }] : []),
  ])
  return { name: `${set}.osz`, bytes }
}
