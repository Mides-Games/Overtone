import { useTranslation } from 'react-i18next'

import { repoFile } from '../../lib/repo.js'
import Icon from '../ui/Icon.jsx'

/**
 * Where a step is written (W12.12): each `{ label, path }` as a link to the
 * file in the repository, so a reader can check the page against the source.
 * Set as a reference line under the prose: the label, then each file in mono.
 */
export default function Sources({ items }) {
  const { t } = useTranslation()
  if (!Array.isArray(items) || !items.length) return null
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border-t border-line pt-3 text-caption text-dim">
      <span className="label">{t('learn.source')}</span>
      {items.map((item) => {
        const href = repoFile(item.path)
        return href ? (
          <a key={item.label} href={href} target="_blank" rel="noreferrer noopener" className="readout inline-flex items-center gap-1 break-all text-muted underline decoration-line-strong underline-offset-[3px] transition-colors duration-150 hover:text-accent hover:decoration-current">
            {item.label}
            <Icon name="external" size={12} className="shrink-0" />
            <span className="sr-only">{t('common.newTab')}</span>
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
