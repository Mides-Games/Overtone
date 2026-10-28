import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { BpmRange, MoreButton, SearchField } from '../components/ListControls.jsx'
import { shortDate } from '../components/TimingList.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { comparePath } from '../lib/compare.js'
import { usePagedList } from '../hooks/usePagedList.js'
import { forgetAnalysis, recentAnalyses } from '../lib/recent.js'
import { bpmLabel, deleteAnalysis, myAnalyses, NO_FILTERS, publishAnalysis, songLine, timingPath, unpublishAnalysis } from '../lib/timings.js'

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

  if (account === undefined) return <SkeletonRows rows={5} label={t('common.loading')} className="border-y border-line" />
  return (
    <div className="space-y-10">
      <PageHeader title={t('timings.history.title')} lede={account ? t('timings.history.subtitle') : t('timings.history.anonymousSubtitle')} />
      <div className="space-y-6">{account ? <AccountHistory /> : <BrowserHistory />}</div>
    </div>
  )
}

/** A small action in a row: the same size everywhere on the page. */
const SMALL = 'btn-ghost btn-sm'

function BrowserHistory() {
  const { t, i18n } = useTranslation()
  const [items, setItems] = useState(() => recentAnalyses())
  return (
    <>
      <section className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-[60ch] text-body text-muted">{t('timings.history.signInPrompt')}</p>
        <Link to="/login" state={{ from: '/history' }} className="btn-primary shrink-0 self-start sm:self-auto">
          <Icon name="user" size={16} />
          {t('nav.signIn')}
        </Link>
      </section>
      {items.length ? (
        <ul className="divide-y divide-line border-y border-line">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <Link to={`/analyze/${item.id}`} className="min-w-0 flex-1 basis-48 truncate text-body font-medium text-text hover:text-accent">
                {item.filename}
              </Link>
              <time dateTime={new Date(item.at).toISOString()} className="readout shrink-0 text-caption text-dim">
                {shortDate(new Date(item.at).toISOString(), i18n.language)}
              </time>
              <span className="flex shrink-0 gap-2">
                <Link to={comparePath({ id: item.id })} className={SMALL}>
                  {t('compare.action')}
                </Link>
                <button
                  type="button"
                  className={SMALL}
                  onClick={() => {
                    forgetAnalysis(item.id)
                    setItems(recentAnalyses())
                  }}
                >
                  <Icon name="close" size={14} />
                  {t('timings.history.forget')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title={t('timings.history.browserEmpty')}
          className="border-y border-line"
          action={
            <Link to="/analyze" className="btn-ghost">
              {t('timings.recent.analyze')}
              <Icon name="arrow-right" size={16} />
            </Link>
          }
        />
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
      <form
        className="panel grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-[1fr_auto_auto_auto_auto] [&>*]:min-w-0"
        role="search"
        onSubmit={(e) => e.preventDefault()}
      >
        <SearchField value={filters.q} onChange={set('q')} />
        <label className="space-y-1.5">
          <span className="label block">{t('timings.filters.status')}</span>
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
        <fieldset className="space-y-1.5">
          <legend className="label mb-1.5">{t('timings.filters.dates')}</legend>
          <div className="flex items-center gap-2">
            <input type="date" className="field readout min-w-0 flex-1" value={filters.from} onChange={set('from')} aria-label={t('timings.filters.fromDate')} />
            <span aria-hidden="true" className="text-dim">
              –
            </span>
            <input type="date" className="field readout min-w-0 flex-1" value={filters.to} onChange={set('to')} aria-label={t('timings.filters.toDate')} />
          </div>
        </fieldset>
        {narrowed && (
          <button type="button" className="btn-ghost self-end" onClick={() => setFilters(NO_FILTERS)}>
            <Icon name="close" size={16} />
            {t('timings.filters.clear')}
          </button>
        )}
      </form>

      {list.items === null ? (
        list.error ? (
          <p role="status" className="text-label text-dim">
            {t('result.reconnecting')}
          </p>
        ) : (
          <SkeletonRows rows={5} label={t('common.loading')} className="border-y border-line" />
        )
      ) : (
        <section className="space-y-6" aria-label={t('timings.history.title')} aria-busy={list.loading}>
          {list.items.length ? (
            <ul className="divide-y divide-line border-y border-line">
              {list.items.map((item) => (
                <HistoryRow key={item.id} item={item} onChange={(change) => list.update(item.id, change)} />
              ))}
            </ul>
          ) : (
            <EmptyState
              title={narrowed ? t('timings.history.noMatch') : t('timings.history.empty')}
              className="border-y border-line"
              action={
                !narrowed && (
                  <Link to="/analyze" className="btn-ghost">
                    {t('timings.recent.analyze')}
                    <Icon name="arrow-right" size={16} />
                  </Link>
                )
              }
            />
          )}
          {list.error && (
            <p role="alert" className="text-caption text-red">
              {t('timings.loadFailed')}
            </p>
          )}
          <MoreButton list={list} />
        </section>
      )}
      <p className="max-w-[72ch] text-caption text-dim">{t('timings.history.deleteNote')}</p>
    </>
  )
}

/** A status as a chip: done is the signal, a refusal is the one to read; the rest are neutral. */
const TONE = { queued: 'chip-neutral', running: 'chip-accent', done: 'chip-accent', refused: 'chip-neutral', failed: 'chip-neutral' }

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

  return (
    <li className="space-y-3 py-4">
      <div className="flex items-start gap-4">
        <Link to={`/analyze/${item.id}`} className="group min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-body font-semibold text-text group-hover:text-accent">{songLine(item) ?? item.filename ?? t('timings.untitled')}</p>
          <p className="truncate text-caption text-dim">
            {item.filename} · <time dateTime={item.createdAt}>{shortDate(item.createdAt, i18n.language)}</time>
          </p>
        </Link>
        <div className="shrink-0 space-y-1.5 text-right">
          <p className="readout text-title font-semibold text-text">
            {bpmLabel(item.bpm)}
            <span className="unit">BPM</span>
          </p>
          <p className="flex flex-wrap justify-end gap-1.5">
            <span className={TONE[item.status] ?? 'chip-neutral'}>{t(`queue.status.${item.status}`)}</span>
            {item.published && (
              <span className="chip-accent">
                <Icon name="globe" size={12} />
                {t('timings.history.public')}
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {item.status === 'done' &&
          (item.published ? (
            <>
              <Link to={timingPath(item.id)} className={SMALL}>
                {t('timings.history.openPublic')}
                <Icon name="arrow-right" size={14} />
              </Link>
              <button type="button" className={SMALL} disabled={busy} onClick={unpublish}>
                {t('timings.publish.unpublish')}
              </button>
            </>
          ) : state.kind === 'confirmPrivate' ? (
            <>
              <span className="text-caption text-amber">{t('timings.publish.privateWarning')}</span>
              <button type="button" className={SMALL} onClick={() => publish(true)}>
                {t('timings.publish.makePublic')}
              </button>
              <button type="button" className={SMALL} onClick={() => setState({ kind: 'idle' })}>
                {t('timings.publish.keepPrivate')}
              </button>
            </>
          ) : (
            <button type="button" className={SMALL} disabled={busy} onClick={() => (item.private ? setState({ kind: 'confirmPrivate' }) : publish(false))}>
              <Icon name="upload" size={14} />
              {t('timings.publish.publish')}
            </button>
          ))}
        {item.status === 'done' && (
          <Link to={comparePath({ id: item.id })} className={SMALL}>
            {t('compare.action')}
          </Link>
        )}
        {finished &&
          (state.kind === 'confirmDelete' ? (
            <>
              <span className="text-caption text-red">{t('timings.history.deleteConfirm')}</span>
              <button type="button" className={`${SMALL} border-red/50 text-red`} onClick={remove}>
                <Icon name="trash" size={14} />
                {t('timings.history.deleteYes')}
              </button>
              <button type="button" className={SMALL} onClick={() => setState({ kind: 'idle' })}>
                {t('timings.history.deleteNo')}
              </button>
            </>
          ) : (
            <button type="button" className={`${SMALL} sm:ml-auto`} disabled={busy} onClick={() => setState({ kind: 'confirmDelete' })}>
              <Icon name="trash" size={14} />
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
