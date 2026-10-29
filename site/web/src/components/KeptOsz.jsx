import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { downloadKept, formatSize, KEPT_EVENT, keptLibrary } from '../lib/kept-osz.js'
import { saveText } from '../lib/timing.js'
import { adjustmentLabel } from '../lib/versions.js'
import { shortDate } from './TimingList.jsx'
import Icon from './ui/Icon.jsx'

/**
 * The .osz files this browser kept (lib/kept-osz.js), on the pages that build
 * them: a page's own kept copy, downloaded again without the song, and the
 * line said after a download about whether a copy was kept.
 */

/** Re-reads whenever the library changes, in this tab. `read` is the library call. */
export function useKept(read, deps) {
  const [value, setValue] = useState(undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => read(keptLibrary()).then(setValue, () => setValue(null)), deps)
  useEffect(() => {
    load()
    const on = () => load()
    window.addEventListener(KEPT_EVENT, on)
    return () => window.removeEventListener(KEPT_EVENT, on)
  }, [load])
  return value
}

/** What built an entry, short: the ×2 / nudge / edits it was written with, else nothing. */
export function builtWith(meta) {
  const o = meta?.options
  if (!o) return ''
  return adjustmentLabel({ factor: o.factor, nudgeMs: o.nudgeMs, edits: o.edited ? { length: o.edited } : null })
}

export const keptDate = (meta, language) => shortDate(new Date(meta.createdAt).toISOString(), language)

/** "Download the .osz again" for one page's id, with its date and size, and delete. Nothing when none is kept. */
export function KeptAgain({ source, id }) {
  const { t, i18n } = useTranslation()
  const meta = useKept((lib) => lib.find(source, id), [source, id])
  const [gone, setGone] = useState(false)
  if (!meta) return null
  const adjusted = builtWith(meta)
  return (
    <div className="w-full space-y-1.5 rounded-control border border-line bg-surface-2/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={async () => setGone(!(await downloadKept(meta.key, saveText)))}
        >
          <Icon name="download" size={16} />
          {t('kept.again')}
        </button>
        <span className="readout text-caption text-dim">
          {t('kept.when', { date: keptDate(meta, i18n.language), size: formatSize(meta.size, i18n.language) })}
          {adjusted ? ` · ${adjusted}` : ''}
        </span>
        <button type="button" className="btn-quiet btn-sm ml-auto" onClick={() => keptLibrary().remove(meta.key)}>
          <Icon name="trash" size={14} />
          {t('kept.delete')}
        </button>
      </div>
      <p className="text-caption text-dim">
        {gone ? <span className="text-red">{t('kept.gone')}</span> : t('kept.deviceOnly')}{' '}
        <Link to="/downloads" className="link whitespace-nowrap">
          {t('kept.allLink')}
        </Link>
      </p>
    </div>
  )
}

/**
 * The line after a download: why no copy was kept, quietly, or what was
 * dropped to make room. A plain "kept" says nothing where the page shows the
 * copy itself (`quiet`): KeptAgain is the news.
 */
export function KeptNote({ outcome, quiet = false }) {
  const { t } = useTranslation()
  if (!outcome || (quiet && outcome.kept && !outcome.evicted?.length)) return null
  if (!outcome.kept) {
    return <p className="w-full text-caption text-dim">{outcome.reason === 'too-large' ? t('kept.tooLarge') : t('kept.notKept')}</p>
  }
  return (
    <p role="status" className="w-full text-caption text-dim">
      {t('kept.keptNote')}
      {outcome.evicted?.length > 0 && <> {t('kept.evicted', { names: outcome.evicted.map((e) => e.title || e.name).join(', ') })}</>}{' '}
      <Link to="/downloads" className="link whitespace-nowrap">
        {t('kept.allLink')}
      </Link>
    </p>
  )
}
