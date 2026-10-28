import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { energyFrames, kiaiRows, kiaiSections, leadIn, previewTime } from '../../lib/osz-suggest.js'
import { readCover } from '../../lib/tags.js'
import { formatClock } from '../../lib/timing.js'

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
 * Everything is worked out here, from the reader's file and the song the
 * page already decoded for the waveform: nothing is sent.
 */
export const DEFAULT_OPTIONS = { cover: true, preview: true, leadIn: false, kiai: false }

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
  return useMemo(() => {
    const kiai = frames ? kiaiSections({ frames, lines, durationMs }) : []
    return {
      previewMs: frames ? previewTime({ frames, lines, durationMs }) : null,
      lead: leadIn({ lines, firstAttackMs: result.onsets?.t_ms?.[0] ?? null }),
      kiai,
      greens: kiaiRows(kiai, lines, durationMs),
    }
  }, [frames, lines, durationMs, result])
}

/** The `extras` buildOsz takes, from what is ticked and what was found. */
export function oszExtras(options, cover, suggestions) {
  return {
    cover: options.cover && cover && typeof cover === 'object' ? cover : null,
    previewMs: options.preview ? suggestions.previewMs : null,
    leadInMs: options.leadIn ? (suggestions.lead?.leadInMs ?? 0) : 0,
    greens: options.kiai ? suggestions.greens : [],
  }
}

export default function OszOptions({ options, onChange, cover, suggestions, decoded }) {
  const { t } = useTranslation()
  const { previewMs, lead, kiai } = suggestions
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
    </fieldset>
  )
}
