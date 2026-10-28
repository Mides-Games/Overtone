import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { ratingLabel } from '../lib/social.js'
import { bpmLabel, timingPath } from '../lib/timings.js'
import Avatar from './Avatar.jsx'

/**
 * Published timings as a list (W5.1): the song, who timed it and when, its
 * main BPM and how many red lines. Each row opens the timing's own page.
 * Everything here is what the API's public list gives: no file name, no hash.
 */
export default function TimingList({ timings }) {
  return (
    <ul className="divide-y divide-line rounded-panel border border-line">
      {timings.map((timing) => (
        <li key={timing.id}>
          <TimingRow timing={timing} />
        </li>
      ))}
    </ul>
  )
}

function TimingRow({ timing }) {
  const { t, i18n } = useTranslation()
  return (
    <Link to={timingPath(timing.id)} className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2">
      <UploaderMark uploader={timing.uploader} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-label font-semibold text-text">{timing.title ?? t('timings.untitled')}</p>
        <p className="truncate text-caption text-muted">{timing.artist ?? t('timings.unknownArtist')}</p>
        <p className="truncate text-caption text-dim">
          {uploaderName(t, timing)} · <time dateTime={timing.publishedAt}>{shortDate(timing.publishedAt, i18n.language)}</time>
        </p>
      </div>
      <div className="shrink-0 space-y-1 text-right">
        <p className="readout text-label text-text">
          {bpmLabel(timing.bpm)} <span className="text-caption text-dim">BPM</span>
        </p>
        <p className="text-caption text-dim">
          {timing.variable && <span className="chip-amber mr-1.5 px-1.5 py-0 align-middle">{t('timings.variable')}</span>}
          {t('timings.redLines', { count: timing.redLines })}
        </p>
        {/* W6: stars and uses, when the list carries them and there is something to say. */}
        {(timing.rating?.count > 0 || timing.uses > 0) && (
          <p className="readout text-caption text-dim">
            {timing.rating?.count > 0 && (
              <span title={t('social.stars.count', { count: timing.rating.count })}>
                <span className="text-amber">★</span> {ratingLabel(timing.rating.average)} ({timing.rating.count})
              </span>
            )}
            {timing.rating?.count > 0 && timing.uses > 0 && ' · '}
            {timing.uses > 0 && t('social.uses.short', { count: timing.uses })}
          </p>
        )}
      </div>
    </Link>
  )
}

/** The uploader's avatar, or a plain figure for an anonymous upload. */
export function UploaderMark({ uploader, size = 32 }) {
  if (uploader) return <Avatar account={uploader} size={size} />
  return (
    <div
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-3 text-dim"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
    </div>
  )
}

export const uploaderName = (t, timing) => (timing.uploader ? `@${timing.uploader.username}` : t('timings.anonymous'))

export const shortDate = (iso, language) =>
  iso ? new Date(iso).toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
