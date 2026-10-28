import { useTranslation } from 'react-i18next'

import { repoFile } from '../../lib/repo.js'

/**
 * Where a step is written (W12.12): each `{ label, path }` as a link to the
 * file in the repository, so a reader can check the page against the source.
 */
export default function Sources({ items }) {
  const { t } = useTranslation()
  if (!Array.isArray(items) || !items.length) return null
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-caption text-dim">
      <span className="label">{t('learn.source')}</span>
      {items.map((item) => {
        const href = repoFile(item.path)
        return href ? (
          <a key={item.label} href={href} target="_blank" rel="noreferrer noopener" className="readout hover:text-text hover:underline">
            {item.label} <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <span key={item.label} className="readout">
            {item.label}
          </span>
        )
      })}
    </p>
  )
}
