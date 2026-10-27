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
 * The .osu file (format v14): the general and metadata sections a new map
 * gets in the editor, osu!'s default difficulty, the red lines in
 * `[TimingPoints]` and no hit objects. Comment rows are left out: osu! reads
 * the file, a person reads the page. `lines` are the export's (after the
 * export options, `exportLines`) and `options` those options.
 */
export function osuFile({ title, artist, creator, audioName, lines, result, adjustment, options = null }) {
  const rows = timingText(result, lines, adjustment, options)
    .split('\r\n')
    .filter((row) => row && row !== '[TimingPoints]' && !row.startsWith('//'))
  const titleAscii = ascii(title) || 'Untitled'
  const artistAscii = ascii(artist) || 'Unknown'
  return [
    'osu file format v14',
    '',
    '[General]',
    `AudioFilename: ${audioName}`,
    'AudioLeadIn: 0',
    'PreviewTime: -1',
    'Countdown: 0',
    'SampleSet: Soft',
    'StackLeniency: 0.7',
    'Mode: 0',
    'LetterboxInBreaks: 0',
    'WidescreenStoryboard: 1',
    '',
    '[Editor]',
    'DistanceSpacing: 1',
    'BeatDivisor: 4',
    'GridSize: 32',
    'TimelineZoom: 1',
    '',
    '[Metadata]',
    `Title:${titleAscii}`,
    `TitleUnicode:${field(title) || titleAscii}`,
    `Artist:${artistAscii}`,
    `ArtistUnicode:${field(artist) || artistAscii}`,
    `Creator:${field(creator) || 'Overtone'}`,
    'Version:Timing',
    'Source:',
    'Tags:overtone',
    'BeatmapID:0',
    'BeatmapSetID:-1',
    '',
    '[Difficulty]',
    'HPDrainRate:5',
    'CircleSize:4',
    'OverallDifficulty:5',
    'ApproachRate:5',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    '',
    '[Events]',
    '//Background and Video events',
    '//Break Periods',
    '',
    '[TimingPoints]',
    ...rows,
    '',
    '',
    '[HitObjects]',
    '',
  ].join('\r\n')
}

/**
 * The .osz: the audio as `audio.<ext>` and the .osu named as osu! names its
 * own (`Artist - Title (Creator) [Version].osu`). Returns `{ name, bytes }`.
 */
export async function buildOsz({ file, analysis, lines, adjustment, creator, options = null }) {
  const { title, artist } = songNames({ ...analysis, filename: analysis.filename ?? file.name })
  const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(file.name)?.[0] ?? '.mp3').toLowerCase()
  const audioName = `audio${ext}`
  const who = field(creator) || 'Overtone'
  const set = safeName(`${artist} - ${title}`) || 'Overtone'
  const osu = osuFile({ title, artist, creator: who, audioName, lines, result: analysis.result, adjustment, options })
  const bytes = zipStore([
    { name: audioName, data: new Uint8Array(await file.arrayBuffer()) },
    { name: `${safeName(`${artist} - ${title} (${who}) [Timing]`) || 'overtone'}.osu`, text: osu },
  ])
  return { name: `${set}.osz`, bytes }
}
