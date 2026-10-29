import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { builtWith, keptDate, useKept } from '../components/KeptOsz.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { downloadKept, formatSize, keptLibrary } from '../lib/kept-osz.js'
import { saveText } from '../lib/timing.js'

const SMALL = 'btn-ghost btn-sm'

/**
 * Every .osz this browser kept (lib/kept-osz.js), for anyone, account or not:
 * the files live on this device, so the page needs no sign-in and the server
 * knows nothing of it. Each one downloads again without the song, or goes;
 * the total, what the browser grants the site and the library's cap are said
 * under the list.
 */
export default function Downloads() {
  const { t, i18n } = useTranslation()
  usePageMeta(t('kept.page.title'), t('kept.page.description'))
  const library = useKept((lib) => lib.list(), [])
  const room = useKept(async (lib) => ({ estimate: await lib.estimate(), cap: await lib.cap() }), [library?.total])
  const [missing, setMissing] = useState(null)

  const clearAll = async () => {
    if (window.confirm(t('kept.page.confirmAll'))) await keptLibrary().clear()
  }

  return (
    <div className="space-y-10">
      <PageHeader
        title={t('kept.page.title')}
        lede={t('kept.page.subtitle')}
        action={
          library?.items.length ? (
            <button type="button" className="btn-ghost" onClick={clearAll}>
              <Icon name="trash" size={16} />
              {t('kept.page.deleteAll')}
            </button>
          ) : null
        }
      >
        <p className="text-caption text-dim">{t('kept.deviceOnly')}</p>
      </PageHeader>

      {library === undefined ? (
        <SkeletonRows rows={3} label={t('common.loading')} className="border-y border-line" />
      ) : !library?.available ? (
        <p className="callout">{t('kept.page.unavailable')}</p>
      ) : library.items.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState
            title={t('kept.page.empty')}
            action={
              <Link to="/analyze" className="btn-ghost">
                {t('nav.analyze')}
                <Icon name="arrow-right" size={16} />
              </Link>
            }
          />
        </div>
      ) : (
        <section className="space-y-4" aria-label={t('kept.page.title')}>
          <ul className="divide-y divide-line border-y border-line">
            {library.items.map((item) => {
              const adjusted = builtWith(item)
              const page = item.source === 'timing' ? `/t/${item.id}` : `/analyze/${item.id}`
              return (
                <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                  <div className="min-w-0 flex-1 basis-56 space-y-0.5">
                    <Link to={page} className="block truncate text-body font-medium text-text hover:text-accent">
                      {item.title || item.name}
                    </Link>
                    <p className="readout break-words text-caption text-dim">
                      {[
                        item.artist,
                        t(item.source === 'timing' ? 'kept.page.fromTiming' : 'kept.page.fromAnalysis'),
                        keptDate(item, i18n.language),
                        formatSize(item.size, i18n.language),
                        adjusted,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {missing === item.key && <p className="text-caption text-red">{t('kept.gone')}</p>}
                  </div>
                  <span className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      className={SMALL}
                      onClick={async () => setMissing((await downloadKept(item.key, saveText)) ? null : item.key)}
                    >
                      <Icon name="download" size={14} />
                      {t('kept.page.download')}
                    </button>
                    <button type="button" className={SMALL} onClick={() => keptLibrary().remove(item.key)} aria-label={`${t('kept.delete')}: ${item.title || item.name}`}>
                      <Icon name="trash" size={14} />
                      {t('kept.delete')}
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="readout text-caption text-dim">
            {t('kept.page.total', { count: library.items.length, size: formatSize(library.total, i18n.language) })}
          </p>
          {room && (
            <p className="max-w-[72ch] text-caption text-dim">
              {room.estimate
                ? t('kept.page.room', { used: formatSize(room.estimate.usage, i18n.language), quota: formatSize(room.estimate.quota, i18n.language), cap: formatSize(room.cap, i18n.language) })
                : t('kept.page.roomUnknown', { cap: formatSize(room.cap, i18n.language) })}
            </p>
          )}
        </section>
      )}
    </div>
  )
}
