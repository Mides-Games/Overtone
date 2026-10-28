import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { ratingLabel } from '../lib/social.js'
import { bpmLabel, timingPath } from '../lib/timings.js'
import Avatar from './Avatar.jsx'
import Icon from './ui/Icon.jsx'

/**
 * Published timings as a list (W5.1): the song, who timed it and when, its
 * main BPM and how many red lines. Each row opens the timing's own page.
 * Everything here is what the API's public list gives: no file name, no hash.
 *
 * Rows on the page's ground, a hairline apart (docs/design.md, section 11):
 * the list is read, not operated, so it is not a panel. The BPM is the row's
 * readout, on the right where the eye runs down a column of them.
 */
export default function TimingList({ timings, className = '' }) {
  return (
    <ul className={`divide-y divide-line border-y border-line ${className}`}>
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
    <Link
      to={timingPath(timing.id)}
      className="group -mx-3 flex items-center gap-4 rounded-control px-3 py-3.5 transition-colors duration-150 ease-out hover:bg-surface-2"
    >
      <UploaderMark uploader={timing.uploader} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex items-center gap-2 text-body font-semibold text-text group-hover:text-accent">
          <span className="truncate">{timing.title ?? t('timings.untitled')}</span>
          {/* W13.16: a mapper with ranked maps said it is on time. */}
          {timing.verified && (
            <span className="chip-accent shrink-0" title={t('votes.verifiedHint')}>
              <Icon name="check" size={12} strokeWidth={2} />
              {t('votes.verified')}
            </span>
          )}
        </p>
        <p className="truncate text-label text-muted">{timing.artist ?? t('timings.unknownArtist')}</p>
        <p className="truncate text-caption text-dim">
          {uploaderName(t, timing)} · <time dateTime={timing.publishedAt}>{shortDate(timing.publishedAt, i18n.language)}</time>
        </p>
      </div>
      <div className="shrink-0 space-y-1 text-right">
        <p className="readout text-title font-semibold text-text">
          {bpmLabel(timing.bpm)}
          <span className="unit">BPM</span>
        </p>
        <p className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-caption text-dim">
          {timing.variable && <span className="chip-tempo">{t('timings.variable')}</span>}
          <span className="readout">{t('timings.redLines', { count: timing.redLines })}</span>
        </p>
        {/* W6: stars and uses, when the list carries them and there is something to say. */}
        {(timing.rating?.count > 0 || timing.uses > 0) && (
          <p className="readout flex items-center justify-end gap-1 text-caption text-dim">
            {timing.rating?.count > 0 && (
              <span className="inline-flex items-center gap-1" title={t('social.stars.count', { count: timing.rating.count })}>
                <Icon name="star-filled" size={12} strokeWidth={1} className="text-amber" />
                {ratingLabel(timing.rating.average)} ({timing.rating.count})
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
export function UploaderMark({ uploader, size = 36 }) {
  if (uploader) return <Avatar account={uploader} size={size} decorative />
  return (
    <div
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-3 text-dim"
    >
      <Icon name="user" size={Math.round(size * 0.45)} />
    </div>
  )
}

export const uploaderName = (t, timing) => (timing.uploader ? `@${timing.uploader.username}` : t('timings.anonymous'))

export const shortDate = (iso, language) =>
  iso ? new Date(iso).toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
