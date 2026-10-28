import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { divisorHistogram, suggestBreaks, suggestDivisor } from '../../lib/mapping.js'
import { energyFrames, kiaiRows, kiaiSections, leadIn, previewTime } from '../../lib/osz-suggest.js'
import { readCover } from '../../lib/tags.js'
import { formatClock } from '../../lib/timing.js'
import MapSet from './MapSet.jsx'

/**
 * What the .osz carries besides the audio and the red lines (W12.9), each one
 * a checkbox. The defaults:
 *
 * - the cover, on: it is the reader's own picture from their own file, it
 *   changes nothing in the timing, and a map without a background is the
 *   first thing a mapper fixes by hand;
 * - the preview, on: it only decides where song select starts playing, and
 *   any bar of the loud part beats osu!'s -1;
 * - the lead-in, off: it changes when the game starts the song, and a map
 *   whose first note is late enough needs none; ticked only when the reader
 *   agrees the song starts too soon;
 * - kiai, off: where kiai goes is a mapping decision, and loudness per bar is
 *   a crude stand-in for "the chorus", so it is never written unasked.
 *
 * - the beat divisor (W13.3), on: it only sets the editor's snapping, and the
 *   attacks' own divisor beats osu!'s blind 1/4;
 * - breaks (W13.4), off: a break is a mapping decision too, and silence in
 *   the onset envelope is only a guess at one.
 *
 * Below them, the set itself (W13.1, W13.5, MapSet.jsx): the mode, the empty
 * difficulties and the test map, all off until asked for, so the .osz stays
 * the one Timing difficulty it always was.
 *
 * Everything is worked out here, from the reader's file, the song the page
 * already decoded for the waveform and the attacks the engine sent: nothing
 * is sent.
 */
export const DEFAULT_OPTIONS = {
  cover: true,
  preview: true,
  leadIn: false,
  kiai: false,
  divisor: true,
  breaks: false,
  mode: 0,
  keys: 4,
  difficulties: [],
  testSub: 0,
}

/** The file's cover, read once per file, with an object URL for its thumbnail. */
export function useCover(file) {
  const [cover, setCover] = useState(null) // null, 'reading' or { ext, mime, bytes, url }
  useEffect(() => {
    if (!file) return setCover(null)
    let live = true
    let url = null
    setCover('reading')
    readCover(file).then((found) => {
      if (!live) return
      if (!found) return setCover(null)
      url = URL.createObjectURL(new Blob([found.bytes], { type: found.mime }))
      setCover({ ...found, url })
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [file])
  return cover
}

/** The suggestions for these lines and this decoded song (null until it is decoded). */
export function useSuggestions({ result, lines, songBuffer }) {
  const frames = useMemo(() => {
    if (!songBuffer) return null
    const channels = []
    for (let c = 0; c < Math.min(songBuffer.numberOfChannels, 2); c++) channels.push(songBuffer.getChannelData(c))
    return energyFrames(channels, songBuffer.sampleRate)
  }, [songBuffer])
  const durationMs = (result.duration_s ?? songBuffer?.duration ?? 0) * 1000
  // W13.3 and W13.4 need only the engine's attacks and envelope, not the decoded song.
  const mapping = useMemo(() => {
    const histogram = divisorHistogram(result.onsets, lines)
    return { histogram, divisor: suggestDivisor(histogram.all), breaks: suggestBreaks({ envelope: result.onset_envelope, onsets: result.onsets }) }
  }, [result, lines])
  return useMemo(() => {
    const kiai = frames ? kiaiSections({ frames, lines, durationMs }) : []
    return {
      previewMs: frames ? previewTime({ frames, lines, durationMs }) : null,
      lead: leadIn({ lines, firstAttackMs: result.onsets?.t_ms?.[0] ?? null }),
      kiai,
      greens: kiaiRows(kiai, lines, durationMs),
      ...mapping,
    }
  }, [frames, lines, durationMs, result, mapping])
}

/** The `extras` buildOsz takes, from what is ticked and what was found. */
export function oszExtras(options, cover, suggestions) {
  return {
    cover: options.cover && cover && typeof cover === 'object' ? cover : null,
    previewMs: options.preview ? suggestions.previewMs : null,
    leadInMs: options.leadIn ? (suggestions.lead?.leadInMs ?? 0) : 0,
    greens: options.kiai ? suggestions.greens : [],
    beatDivisor: options.divisor && suggestions.divisor ? suggestions.divisor : 4,
    breaks: options.breaks ? suggestions.breaks : [],
    mode: options.mode,
    keys: options.keys,
    difficulties: options.difficulties,
    testSub: options.testSub || null,
  }
}

export default function OszOptions({ options, onChange, cover, suggestions, decoded }) {
  const { t } = useTranslation()
  const { previewMs, lead, kiai, divisor, breaks } = suggestions
  const seconds = (ms) => (ms / 1000).toFixed(1)
  const set = (key) => (e) => onChange((o) => ({ ...o, [key]: e.target.checked }))

  const rows = [
    {
      key: 'cover',
      title: t('oszPlus.cover'),
      usable: Boolean(cover && typeof cover === 'object'),
      detail: cover === 'reading' ? t('oszPlus.coverReading') : cover ? t('oszPlus.coverFound', { name: `bg.${cover.ext}` }) : t('oszPlus.coverNone'),
      suggestion: false,
    },
    {
      key: 'preview',
      title: t('oszPlus.preview'),
      usable: previewMs !== null,
      detail: !decoded ? t('oszPlus.needsSong') : previewMs !== null ? t('oszPlus.previewAt', { time: formatClock(previewMs) }) : t('oszPlus.previewNone'),
      suggestion: true,
    },
    {
      key: 'leadIn',
      title: t('oszPlus.leadIn'),
      usable: Boolean(lead?.leadInMs),
      detail: !lead
        ? t('oszPlus.leadInUnknown')
        : lead.leadInMs
          ? t('oszPlus.leadInAt', { ms: lead.leadInMs, first: seconds(lead.firstMs) })
          : t('oszPlus.leadInNone', { first: seconds(lead.firstMs) }),
      suggestion: true,
    },
    {
      key: 'kiai',
      title: t('oszPlus.kiai'),
      usable: kiai.length > 0,
      detail: !decoded
        ? t('oszPlus.needsSong')
        : kiai.length
          ? t('oszPlus.kiaiAt', { spans: kiai.map((s) => `${formatClock(s.startMs)}–${formatClock(s.endMs)}`).join(', ') })
          : t('oszPlus.kiaiNone'),
      suggestion: true,
    },
    {
      key: 'divisor',
      title: t('oszPlus.divisor'),
      usable: divisor !== null,
      detail: divisor ? t('oszPlus.divisorAt', { divisor: `1/${divisor}` }) : t('oszPlus.divisorNone'),
      suggestion: true,
    },
    {
      key: 'breaks',
      title: t('oszPlus.breaks'),
      usable: breaks.length > 0,
      detail: breaks.length
        ? t('oszPlus.breaksAt', { spans: breaks.map((b) => `${formatClock(b.startMs)}–${formatClock(b.endMs)}`).join(', ') })
        : t('oszPlus.breaksNone'),
      suggestion: true,
    },
  ]

  return (
    <fieldset className="space-y-2 border-t border-line px-4 py-3">
      <legend className="sr-only">{t('oszPlus.title')}</legend>
      <h3 className="label" aria-hidden="true">
        {t('oszPlus.title')}
      </h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <li key={row.key}>
            <label className={`flex items-start gap-2 ${row.usable ? 'cursor-pointer' : 'opacity-60'}`}>
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--accent)]"
                checked={row.usable && options[row.key]}
                disabled={!row.usable}
                onChange={set(row.key)}
              />
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-1.5 text-label text-text">
                  {row.title}
                  {row.suggestion && row.usable && <span className="chip-amber px-1.5 py-0 text-caption">{t('oszPlus.suggestion')}</span>}
                </span>
                <span className="block text-caption text-dim">{row.detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-caption text-dim">{t('oszPlus.note')}</p>
      <MapSet options={options} onChange={onChange} breaks={options.breaks ? breaks.length : 0} />
    </fieldset>
  )
}
