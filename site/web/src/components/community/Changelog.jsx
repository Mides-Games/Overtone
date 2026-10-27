import { useTranslation } from 'react-i18next'
import entries from 'virtual:changelog'

/**
 * The changelog (W5.5): the latest entries of docs/timeline.md, read at build
 * time (scripts/changelog.mjs). The timeline is written in English and so is
 * this; the page says so. Each bullet arrives as tokens, rendered here as
 * React elements, so no text from the file is ever HTML.
 */
export default function Changelog() {
  const { t, i18n } = useTranslation()
  return (
    <div className="space-y-6">
      <p className="max-w-[72ch] text-caption leading-relaxed text-dim">{t('community.changelog.source')}</p>
      {!entries.length ? (
        <p className="text-label text-dim">{t('community.changelog.empty')}</p>
      ) : (
        <ol className="space-y-4">
          {entries.map((entry, i) => (
            <li key={`${entry.date}-${i}`} className="panel space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="readout text-caption text-dim">
                  {new Date(`${entry.date}T00:00:00Z`).toLocaleDateString(i18n.language, { dateStyle: 'medium', timeZone: 'UTC' })}
                </span>
                <span className={entry.version === 'Unreleased' ? 'chip border-line-strong text-dim' : 'chip-accent'}>
                  {entry.version === 'Unreleased' ? t('community.changelog.unreleased') : entry.version}
                </span>
              </div>
              <h3 lang="en" className="break-words text-body font-semibold">
                {entry.title}
              </h3>
              {entry.changed.length > 0 && (
                <ul lang="en" className="list-disc space-y-1.5 pl-5 text-label text-muted marker:text-dim">
                  {entry.changed.map((bullet, j) => (
                    <li key={j} className="break-words">
                      <Tokens tokens={bullet} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Tokens({ tokens }) {
  return tokens.map((tok, i) => {
    if (tok.t === 'code') return <code key={i} className="readout rounded bg-surface-3 px-1 text-[0.92em] text-text">{tok.v}</code>
    if (tok.t === 'strong') return <strong key={i} className="font-semibold text-text">{tok.v}</strong>
    if (tok.t === 'link' && /^https?:\/\//i.test(tok.href)) {
      return (
        <a key={i} href={tok.href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
          {tok.v}
        </a>
      )
    }
    return <span key={i}>{tok.v}</span>
  })
}
