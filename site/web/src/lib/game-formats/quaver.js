/** Quaver (.qua): YAML timing points, each starting its own grid. */
import { roundHalfEven } from '../timing.js'
import { COMMENT, field, fixed, gameLines, trimmed } from './common.js'

// ---------------------------------------------------------------------------
// Quaver
// ---------------------------------------------------------------------------

/**
 * The `TimingPoints:` block, v3's `quaver_timing_text` with a meter: whole ms
 * at 0 decimals (half to even), else that many; the BPM to 6 decimals, trailing
 * zeros dropped; `Signature: Triple` on a 3/4 line.
 */
export function quaverTimingText(lines, { offsetDecimals = 0 } = {}) {
  const points = gameLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const rows = [`# ${COMMENT}`, 'TimingPoints:']
  for (const p of points) {
    rows.push(`- StartTime: ${offsetDecimals > 0 ? fixed(p.timeMs, offsetDecimals) : String(roundHalfEven(p.timeMs) + 0)}`)
    rows.push(`  Bpm: ${trimmed(p.bpm, 6)}`)
    if (p.meter === 3) rows.push('  Signature: Triple')
  }
  return `${rows.join('\n')}\n`
}

const yamlString = (text) => `'${field(text).replace(/'/g, "''")}'`

/** A whole .qua: a 4K map's metadata, the timing points, no notes. `{ text, report }`. */
export function quaFile({ title, artist, creator, audioName, lines, offsetDecimals }) {
  const timing = quaverTimingText(lines, { offsetDecimals }).split('\n').slice(1).join('\n')
  const points = gameLines(lines)
  const text = [
    `# ${COMMENT}`,
    `AudioFile: ${yamlString(audioName)}`,
    'SongPreviewTime: 0',
    "BackgroundFile: ''",
    'MapId: -1',
    'MapSetId: -1',
    'Mode: Keys4',
    `Title: ${yamlString(title)}`,
    `Artist: ${yamlString(artist)}`,
    "Source: ''",
    "Tags: 'overtone'",
    `Creator: ${yamlString(creator)}`,
    "DifficultyName: 'Timing'",
    "Description: 'Timing from Overtone: red lines only, no notes. Check it by ear.'",
    'BPMDoesNotAffectScrollVelocity: true',
    'InitialScrollVelocity: 1',
    'EditorLayers: []',
    'CustomAudioSamples: []',
    'SoundEffects: []',
    timing.trimEnd(),
    'SliderVelocities: []',
    'HitObjects: []',
    '',
  ].join('\n')
  return { text, report: { meterLost: points.filter((p) => p.meter !== 3 && p.meter !== 4).length } }
}
