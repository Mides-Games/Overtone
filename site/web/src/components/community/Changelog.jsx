import { useTranslation } from 'react-i18next'
import entries from 'virtual:changelog'

import EmptyState from '../ui/EmptyState.jsx'
import Icon from '../ui/Icon.jsx'

/**
 * The changelog (W5.5): the latest entries of docs/timeline.md, read at build
 * time (scripts/changelog.mjs). The timeline is written in English and so is
 * this; the page says so. Each bullet arrives as tokens, rendered here as
 * React elements, so no text from the file is ever HTML.
 *
 * A log, so it reads like one: the date and version in a narrow column on the
 * left, the entry beside it, a hairline between entries, no boxes.
 */
export default function Changelog() {
  const { t, i18n } = useTranslation()
  return (
    <div className="space-y-6">
      <p className="max-w-[72ch] text-label text-muted">{t('community.changelog.source')}</p>
      {!entries.length ? (
        <EmptyState title={t('community.changelog.empty')} className="border-y border-line" />
      ) : (
        <ol className="divide-y divide-line border-y border-line">
          {entries.map((entry, i) => (
            <li key={`${entry.date}-${i}`} className="grid gap-x-8 gap-y-3 py-6 md:grid-cols-[11rem_1fr]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:flex-col md:items-start">
                <time dateTime={entry.date} className="readout text-label text-text">
                  {new Date(`${entry.date}T00:00:00Z`).toLocaleDateString(i18n.language, { dateStyle: 'medium', timeZone: 'UTC' })}
                </time>
                <span className={entry.version === 'Unreleased' ? 'chip-neutral' : 'chip-accent'}>
                  {entry.version === 'Unreleased' ? t('community.changelog.unreleased') : entry.version}
                </span>
              </div>
              <div className="min-w-0 space-y-3">
                <h3 lang="en" className="heading-title break-words">
                  {entry.title}
                </h3>
                {entry.changed.length > 0 && (
                  <ul lang="en" className="max-w-[80ch] space-y-2 text-label text-muted">
                    {entry.changed.map((bullet, j) => (
                      <li key={j} className="relative break-words pl-4 before:absolute before:left-0 before:top-[0.6em] before:h-px before:w-2 before:bg-line-strong">
                        <Tokens tokens={bullet} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Tokens({ tokens }) {
  const { t } = useTranslation()
  return tokens.map((tok, i) => {
    if (tok.t === 'code') return <code key={i} className="readout rounded bg-surface-3 px-1 text-[0.92em] text-text">{tok.v}</code>
    if (tok.t === 'strong') return <strong key={i} className="font-semibold text-text">{tok.v}</strong>
    if (tok.t === 'link' && /^https?:\/\//i.test(tok.href)) {
      return (
        <a key={i} href={tok.href} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-0.5">
          {tok.v}
          <Icon name="external" size={13} />
          <span className="sr-only">{t('common.newTab')}</span>
        </a>
      )
    }
    return <span key={i}>{tok.v}</span>
  })
}
