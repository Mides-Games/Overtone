import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import { shortDate } from '../components/TimingList.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { usePagedList } from '../hooks/usePagedList.js'
import { forgetAnalysis, recentAnalyses } from '../lib/recent.js'
import { bpmLabel, deleteAnalysis, myAnalyses, NO_FILTERS, publishAnalysis, songLine, timingPath, unpublishAnalysis } from '../lib/timings.js'
import { BpmRange } from './Recent.jsx'

const loadHistory = (filters, options) => myAnalyses(filters, options).then((data) => ({ items: data.analyses, next: data.next }))
const STATUSES = ['done', 'refused', 'failed', 'queued', 'running']

/**
 * Everything the signed-in account analysed (W3.26): searchable, filtered by
 * date, BPM and status, and each one published, unpublished or deleted from
 * here. Without an account the server keeps no list of who uploaded what, so
 * the page shows this browser's own short list and asks to sign in.
 */
export default function History() {
  const { t } = useTranslation()
  usePageMeta(t('timings.history.title'))
  const { account } = useAuth()

  if (account === undefined) return <BrandLoader className="py-16" />
  return (
    <div className="space-y-8">
      <header className="rise space-y-2">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('timings.history.title')}</h1>
        <p className="max-w-[60ch] text-muted">{account ? t('timings.history.subtitle') : t('timings.history.anonymousSubtitle')}</p>
      </header>
      {account ? <AccountHistory /> : <BrowserHistory />}
    </div>
  )
}

function BrowserHistory() {
  const { t, i18n } = useTranslation()
  const [items, setItems] = useState(() => recentAnalyses())
  return (
    <>
      <section className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-label text-muted">{t('timings.history.signInPrompt')}</p>
        <Link to="/login" state={{ from: '/history' }} className="btn-primary shrink-0">
          {t('nav.signIn')}
        </Link>
      </section>
      {items.length ? (
        <ul className="divide-y divide-line rounded-panel border border-line">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <Link to={`/analyze/${item.id}`} className="min-w-0 flex-1 truncate text-label text-text hover:text-accent">
                {item.filename}
              </Link>
              <span className="readout shrink-0 text-caption text-dim">{shortDate(new Date(item.at).toISOString(), i18n.language)}</span>
              <button
                type="button"
                className="btn-ghost h-7 shrink-0 px-2.5 text-caption"
                onClick={() => {
                  forgetAnalysis(item.id)
                  setItems(recentAnalyses())
                }}
              >
                {t('timings.history.forget')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">{t('timings.history.browserEmpty')}</p>
      )}
    </>
  )
}

function AccountHistory() {
  const { t } = useTranslation()
  const [filters, setFilters] = useState(NO_FILTERS)
  const list = usePagedList(loadHistory, filters)
  const set = (key) => (event) => setFilters((f) => ({ ...f, [key]: event.target.value }))
  const narrowed = Object.values(filters).some(Boolean)

  return (
    <>
      <form className="panel grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto] [&>*]:min-w-0" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="space-y-1">
          <span className="label">{t('timings.filters.search')}</span>
          <input type="search" className="field" value={filters.q} maxLength={100} onChange={set('q')} placeholder={t('timings.filters.searchPlaceholder')} />
        </label>
        <label className="space-y-1">
          <span className="label">{t('timings.filters.status')}</span>
          <select className="field" value={filters.status} onChange={set('status')}>
            <option value="">{t('timings.filters.any')}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`queue.status.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <BpmRange filters={filters} set={set} />
        <fieldset className="space-y-1">
          <legend className="label">{t('timings.filters.dates')}</legend>
          <div className="flex items-center gap-2">
            <input type="date" className="field min-w-0 flex-1" value={filters.from} onChange={set('from')} aria-label={t('timings.filters.fromDate')} />
            <span className="text-dim">–</span>
            <input type="date" className="field min-w-0 flex-1" value={filters.to} onChange={set('to')} aria-label={t('timings.filters.toDate')} />
          </div>
        </fieldset>
        {narrowed && (
          <button type="button" className="btn-ghost self-end" onClick={() => setFilters(NO_FILTERS)}>
            {t('timings.filters.clear')}
          </button>
        )}
      </form>

      {list.items === null ? (
        list.error ? <p className="text-label text-dim">{t('result.reconnecting')}</p> : <BrandLoader className="py-16" />
      ) : (
        <section className="space-y-4" aria-busy={list.loading}>
          {list.items.length ? (
            <ul className="divide-y divide-line rounded-panel border border-line">
              {list.items.map((item) => (
                <HistoryRow key={item.id} item={item} onChange={(change) => list.update(item.id, change)} />
              ))}
            </ul>
          ) : (
            <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">
              {narrowed ? t('timings.history.noMatch') : t('timings.history.empty')}{' '}
              {!narrowed && (
                <Link to="/analyze" className="text-accent hover:underline">
                  {t('timings.recent.analyze')}
                </Link>
              )}
            </p>
          )}
          {list.error && <p role="alert" className="text-caption text-red">{t('timings.loadFailed')}</p>}
          {list.next && (
            <button type="button" className="btn-ghost w-full" onClick={list.more} disabled={list.loading}>
              {list.loading ? t('common.loading') : t('timings.more')}
            </button>
          )}
        </section>
      )}
      <p className="max-w-[72ch] text-caption leading-relaxed text-dim">{t('timings.history.deleteNote')}</p>
    </>
  )
}

const TONE = { queued: 'text-dim', running: 'text-accent', done: 'text-accent', refused: 'text-amber', failed: 'text-red' }

function HistoryRow({ item, onChange }) {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState({ kind: 'idle' }) // idle | busy | confirmPrivate | confirmDelete | error

  async function run(action) {
    setState({ kind: 'busy' })
    try {
      await action()
      setState({ kind: 'idle' })
    } catch (error) {
      setState({ kind: 'error', code: error.code })
    }
  }

  const publish = (makePublic) =>
    run(async () => {
      const done = await publishAnalysis(item.id, { makePublic })
      onChange({ published: true, publishedAt: done.publishedAt, private: false })
    })
  const unpublish = () =>
    run(async () => {
      await unpublishAnalysis(item.id)
      onChange({ published: false, publishedAt: undefined })
    })
  const remove = () =>
    run(async () => {
      await deleteAnalysis(item.id)
      forgetAnalysis(item.id)
      onChange(null)
    })

  const busy = state.kind === 'busy'
  const finished = item.status === 'done' || item.status === 'refused' || item.status === 'failed'
  const small = 'btn-ghost h-7 px-2.5 text-caption'

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <Link to={`/analyze/${item.id}`} className="min-w-0 flex-1 space-y-0.5 hover:text-accent">
          <p className="truncate text-label font-semibold">{songLine(item) ?? item.filename ?? t('timings.untitled')}</p>
          <p className="truncate text-caption text-dim">
            {item.filename} · <time dateTime={item.createdAt}>{shortDate(item.createdAt, i18n.language)}</time>
          </p>
        </Link>
        <div className="shrink-0 space-y-1 text-right">
          <p className="readout text-label text-text">
            {bpmLabel(item.bpm)} <span className="text-caption text-dim">BPM</span>
          </p>
          <p className={`text-caption font-semibold ${TONE[item.status] ?? ''}`}>
            {t(`queue.status.${item.status}`)}
            {item.published && <span className="chip-accent ml-1.5 px-1.5 py-0 align-middle">{t('timings.history.public')}</span>}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {item.status === 'done' &&
          (item.published ? (
            <>
              <Link to={timingPath(item.id)} className={small}>
                {t('timings.history.openPublic')}
              </Link>
              <button type="button" className={small} disabled={busy} onClick={unpublish}>
                {t('timings.publish.unpublish')}
              </button>
            </>
          ) : state.kind === 'confirmPrivate' ? (
            <>
              <span className="text-caption text-amber">{t('timings.publish.privateWarning')}</span>
              <button type="button" className={small} onClick={() => publish(true)}>
                {t('timings.publish.makePublic')}
              </button>
              <button type="button" className={small} onClick={() => setState({ kind: 'idle' })}>
                {t('timings.publish.keepPrivate')}
              </button>
            </>
          ) : (
            <button type="button" className={small} disabled={busy} onClick={() => (item.private ? setState({ kind: 'confirmPrivate' }) : publish(false))}>
              {t('timings.publish.publish')}
            </button>
          ))}
        {finished &&
          (state.kind === 'confirmDelete' ? (
            <>
              <span className="text-caption text-red">{t('timings.history.deleteConfirm')}</span>
              <button type="button" className={`${small} border-red/50 text-red`} onClick={remove}>
                {t('timings.history.deleteYes')}
              </button>
              <button type="button" className={small} onClick={() => setState({ kind: 'idle' })}>
                {t('timings.history.deleteNo')}
              </button>
            </>
          ) : (
            <button type="button" className={small} disabled={busy} onClick={() => setState({ kind: 'confirmDelete' })}>
              {t('timings.history.delete')}
            </button>
          ))}
        {state.kind === 'error' && (
          <span role="alert" className="text-caption text-red">
            {t('timings.history.failed')}
          </span>
        )}
      </div>
    </li>
  )
}
