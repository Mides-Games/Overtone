/** The formats the page offers, and one file of any of them. */
import { songNames } from '../osz.js'
import { adofaiFile } from './adofai.js'
import { beatSaberFile } from './beat-saber.js'
import { chartFile } from './clone-hero.js'
import { field } from './common.js'
import { fnfFile } from './fnf.js'
import { quaFile } from './quaver.js'
import { rhythmDoctorFile } from './rhythm-doctor.js'
import { stepmaniaFile } from './stepmania.js'

// ---------------------------------------------------------------------------
// The page's entry point
// ---------------------------------------------------------------------------

/** The formats the page offers, in order. Etterna rides on the .sm. */
export const GAME_FORMATS = [
  { id: 'qua', ext: 'qua', game: 'Quaver' },
  { id: 'sm', ext: 'sm', game: 'StepMania · Etterna' },
  { id: 'ssc', ext: 'ssc', game: 'StepMania 5' },
  { id: 'chart', ext: 'chart', game: 'Clone Hero' },
  { id: 'beatsaber', ext: 'dat', game: 'Beat Saber' },
  { id: 'adofai', ext: 'adofai', game: 'A Dance of Fire and Ice' },
  { id: 'fnf', ext: 'json', game: "Friday Night Funkin'" },
  { id: 'rdlevel', ext: 'rdlevel', game: 'Rhythm Doctor' },
]

/**
 * One game's file for the page: `{ name, text, report }`. `lines` are the
 * export's (after `exportLines`); `analysis` names the song and its audio,
 * `durationS` its length (how many tiles or sections the last line gets).
 */
export function gameFile(kind, { analysis, lines, offsetDecimals = 3, creator, durationS }) {
  const { title, artist } = songNames({ ...analysis, filename: analysis?.filename })
  const audio = String(analysis?.filename ?? 'audio.mp3')
  const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(audio)?.[0] ?? '.mp3').toLowerCase()
  const who = field(creator) || 'Overtone'
  const stem = audio
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .trim()
    .slice(0, 80) || 'overtone'
  const base = { title, artist, creator: who, lines, offsetDecimals, durationS: durationS ?? analysis?.result?.duration_s }
  if (kind === 'qua') return { name: `${stem}.qua`, ...quaFile({ ...base, audioName: audio }) }
  if (kind === 'sm' || kind === 'ssc') return { name: `${stem}.${kind}`, ...stepmaniaFile({ ...base, kind, audioName: audio }) }
  if (kind === 'chart') return { name: 'notes.chart', ...chartFile({ ...base, audioName: `song${ext}` }) }
  // Beat Saber finds a difficulty by the name Info.dat gives it; ExpertStandard.dat is the editors' usual one for Expert.
  if (kind === 'beatsaber') return { name: 'ExpertStandard.dat', ...beatSaberFile(base) }
  if (kind === 'adofai') return { name: `${stem}.adofai`, ...adofaiFile({ ...base, audioName: audio }) }
  // FNF looks a chart up by the song's folder name, lower case with dashes.
  if (kind === 'fnf') return { name: `${stem.toLowerCase().replace(/[\s._-]+/g, '-').replace(/^-+|-+$/g, '') || 'overtone'}.json`, ...fnfFile(base) }
  if (kind === 'rdlevel') return { name: `${stem}.rdlevel`, ...rhythmDoctorFile({ ...base, audioName: audio }) }
  throw new Error(`Unknown format: ${kind}`)
}
