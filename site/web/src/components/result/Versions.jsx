import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { api } from '../../lib/api.js'
import { formatBpm, formatClock } from '../../lib/timing.js'
import {
  adjustmentKey,
  adjustmentLabel,
  deleteVersion,
  diffLines,
  diffSummary,
  fetchVersions,
  isAdjusted,
  NO_ADJUSTMENT,
  saveVersion,
  versionAdjustment,
  versionLines,
} from '../../lib/versions.js'

const LABEL_MAX = 60

/**
 * Versions of this timing (W12.21), for its owner: the other readings of the
 * same audio (re-analyses), the adjustments saved on any of them, a button
 * that saves the one being tried, and the difference per red line between
 * any two. A saved version is its adjustment only; applying it sets the
 * page's ×2 / ÷2 and nudge, exactly as pressing them would, and an edited
 * timing's lines (W7) as one step of the editor's history.
 */
export default function Versions({ analysis, adjustment, onApply }) {
  const { t, i18n } = useTranslation()
  const id = analysis.id
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(null) // null | 'busy' | 'failed' | 'limit'
  const [results, setResults] = useState({}) // reading id -> result, or 'failed'
  const [pick, setPick] = useState({ a: null, b: null })

  const load = () =>
    fetchVersions(id)
      .then((d) => {
        setData(d)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  useEffect(() => {
    setData(null)
    load()
  }, [id])

  const dated = (iso) => new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
  const readingName = (r) => `${dated(r.createdAt)} · ${String(r.engineHash ?? '').slice(0, 7) || '–'}`

  // Every version two can be compared from: each finished reading as the engine read it, each saved adjustment, and what the page shows now.
  const options = useMemo(() => {
    if (!data) return []
    const done = data.readings.filter((r) => r.status === 'done')
    const byId = new Map(done.map((r) => [r.id, r]))
    const list = done.map((r) => ({
      key: `${r.id}:${adjustmentKey(NO_ADJUSTMENT)}`,
      reading: r.id,
      adjustment: NO_ADJUSTMENT,
      name: `${readingName(r)} · ${t('platform.versions.engine')}${r.current ? ` (${t('platform.versions.thisOne')})` : ''}`,
    }))
    for (const v of data.adjustments) {
      const r = byId.get(v.analysisId)
      if (!r) continue
      const adjustment = versionAdjustment(v)
      list.push({
        key: `${v.analysisId}:${adjustmentKey(adjustment)}`,
        reading: v.analysisId,
        adjustment,
        name: `${readingName(r)} · ${adjustmentLabel(v)}${v.label ? ` · ${v.label}` : ''}`,
      })
    }
    const nowKey = `${id}:${adjustmentKey(adjustment)}`
    if (!list.some((o) => o.key === nowKey)) {
      list.push({ key: nowKey, reading: id, adjustment, name: `${t('platform.versions.now')} · ${adjustmentLabel(adjustment) || t('platform.versions.engine')}` })
    }
    return list
  }, [data, adjustment, id, i18n.language])

  const nowKey = `${id}:${adjustmentKey(adjustment)}`
  const a = options.find((o) => o.key === (pick.a ?? `${id}:${adjustmentKey(NO_ADJUSTMENT)}`)) ?? null
  const b = options.find((o) => o.key === (pick.b ?? nowKey)) ?? null

  // The other readings' results, read once each when a comparison needs them.
  useEffect(() => {
    for (const o of [a, b]) {
      if (!o || o.reading === id || results[o.reading]) continue
      setResults((r) => ({ ...r, [o.reading]: 'loading' }))
      api(`/analyses/${o.reading}`)
        .then((other) => setResults((r) => ({ ...r, [o.reading]: other.result ?? 'failed' })))
        .catch(() => setResults((r) => ({ ...r, [o.reading]: 'failed' })))
    }
  }, [a?.reading, b?.reading])

  const resultOf = (o) => (o.reading === id ? analysis.result : results[o.reading])
  const ready = a && b && typeof resultOf(a) === 'object' && typeof resultOf(b) === 'object'
  const rows = useMemo(
    () => (ready ? diffLines(versionLines(resultOf(a), a.adjustment), versionLines(resultOf(b), b.adjustment)) : null),
    [ready, a?.key, b?.key, results],
  )
  const summary = rows ? diffSummary(rows) : null

  async function save() {
    setSaving('busy')
    try {
      await saveVersion(id, { ...adjustment, label: label.trim() || null })
      setLabel('')
      setSaving(null)
      load()
    } catch (error) {
      setSaving(error.code === 'VERSION_LIMIT' ? 'limit' : 'failed')
    }
  }

  async function forget(v) {
    try {
      await deleteVersion(id, v.id)
    } finally {
      load()
    }
  }

  const adjusted = isAdjusted(adjustment)
  const savedAlready = data?.adjustments.some((v) => v.analysisId === id && adjustmentKey(versionAdjustment(v)) === adjustmentKey(adjustment))

  return (
    <section className="panel overflow-hidden" aria-labelledby="versions-title">
      <div className="space-y-1 border-b border-line px-4 py-3">
        <h2 id="versions-title" className="label">
          {t('platform.versions.title')}
        </h2>
        <p className="text-caption text-dim">{t('platform.versions.note')}</p>
      </div>

      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-center">
        {adjusted && !savedAlready ? (
          <>
            <input
              type="text"
              value={label}
              maxLength={LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('platform.versions.labelPlaceholder')}
              aria-label={t('platform.versions.labelPlaceholder')}
              className="field min-w-0 flex-1"
            />
            <button type="button" className="btn-primary shrink-0" disabled={saving === 'busy'} onClick={save}>
              {t('platform.versions.save', { adjustment: adjustmentLabel(adjustment) })}
            </button>
          </>
        ) : (
          <p className="text-caption text-dim">{adjusted ? t('platform.versions.saved') : t('platform.versions.howToSave')}</p>
        )}
        {(saving === 'failed' || saving === 'limit') && (
          <p role="alert" className="text-caption text-red">
            {saving === 'limit' ? t('platform.versions.limit') : t('platform.versions.saveFailed')}
          </p>
        )}
      </div>

      {failed && (
        <p role="alert" className="px-4 py-3 text-label text-red">
          {t('platform.versions.loadFailed')}
        </p>
      )}

      {data && (
        <ul className="divide-y divide-line">
          {data.readings.map((r) => {
            const saved = data.adjustments.filter((v) => v.analysisId === r.id)
            return (
              <li key={r.id} className="space-y-1.5 px-4 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="readout text-label">
                    {readingName(r)}
                    <span className="ml-2 text-caption text-dim">{t(`queue.status.${r.status}`)}</span>
                  </span>
                  {r.current ? (
                    <span className="chip-accent">{t('platform.versions.thisOne')}</span>
                  ) : (
                    <Link to={`/analyze/${r.id}`} className="text-caption text-accent hover:underline">
                      {t('platform.versions.open')} →
                    </Link>
                  )}
                </div>
                {saved.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {saved.map((v) => (
                      <li key={v.id} className="flex items-center gap-1 rounded-control border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-caption">
                        <span className="readout">{adjustmentLabel(v)}</span>
                        {v.label && <span className="max-w-[16ch] truncate text-dim">{v.label}</span>}
                        {r.current && (
                          <button
                            type="button"
                            className="tool-btn h-6 px-1.5"
                            aria-pressed={adjustmentKey(versionAdjustment(v)) === adjustmentKey(adjustment)}
                            onClick={() => onApply(versionAdjustment(v))}
                          >
                            {t('platform.versions.apply')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="px-1 text-dim hover:text-text"
                          aria-label={t('platform.versions.forget', { name: adjustmentLabel(v) })}
                          onClick={() => forget(v)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {options.length > 1 && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          <h3 className="label">{t('platform.versions.compare')}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {['a', 'b'].map((side) => (
              <label key={side} className="flex min-w-0 items-center gap-2 text-caption">
                <span className="readout w-4 shrink-0 font-bold">{side.toUpperCase()}</span>
                <select
                  className="field min-w-0 flex-1"
                  value={(side === 'a' ? a : b)?.key ?? ''}
                  onChange={(e) => setPick((p) => ({ ...p, [side]: e.target.value }))}
                >
                  {options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {a && b && !ready && (
            <p className="text-caption text-dim">
              {[a, b].some((o) => resultOf(o) === 'failed') ? t('platform.versions.otherFailed') : t('platform.versions.loading')}
            </p>
          )}
          {summary && (
            <p className="text-caption text-text" role="status">
              {summary.same
                ? t('platform.versions.same')
                : t('platform.versions.summary', {
                    ms: summary.maxTimeMs.toFixed(1),
                    bpm: Number(summary.maxBpm.toFixed(3)),
                    onlyA: summary.onlyA,
                    onlyB: summary.onlyB,
                  })}
            </p>
          )}
          {rows && !summary.same && <DiffTable rows={rows} />}
        </div>
      )}
    </section>
  )
}

function DiffTable({ rows }) {
  const { t } = useTranslation()
  const signed = (v, digits) => (v === null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}`)
  return (
    <div className="max-h-72 overflow-auto rounded-control border border-line">
      <table className="w-full min-w-[30rem] text-left text-caption">
        <thead className="sticky top-0 bg-surface-2">
          <tr className="label">
            <th className="px-2 py-1.5 font-semibold">{t('result.time')}</th>
            <th className="px-2 py-1.5 font-semibold">A BPM</th>
            <th className="px-2 py-1.5 font-semibold">B BPM</th>
            <th className="px-2 py-1.5 font-semibold">{t('platform.versions.dTime')}</th>
            <th className="px-2 py-1.5 font-semibold">{t('platform.versions.dBpm')}</th>
          </tr>
        </thead>
        <tbody className="readout divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i} className={r.a === null || r.b === null ? 'text-amber' : ''}>
              <td className="px-2 py-1 whitespace-nowrap">{formatClock(r.timeMs)}</td>
              <td className="px-2 py-1">{r.bpmA === null ? t('platform.versions.none') : formatBpm(r.bpmA)}</td>
              <td className="px-2 py-1">{r.bpmB === null ? t('platform.versions.none') : formatBpm(r.bpmB)}</td>
              <td className="px-2 py-1">{signed(r.dTimeMs, 1)}</td>
              <td className="px-2 py-1">{signed(r.dBpm, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
