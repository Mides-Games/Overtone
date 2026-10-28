import { useTranslation } from 'react-i18next'

import { BPM_TOLERANCE, OFFSET_TOLERANCE_MS } from '../../lib/compare.js'
import { formatBpm, formatClock } from '../../lib/timing.js'
import Icon from '../ui/Icon.jsx'

/** Signed differences, rounded first so a hair's breadth reads 0, never "+0.0" or "-0.0". */
const ms1 = (value) => {
  if (value === null || value === undefined) return '–'
  const r = Number(value.toFixed(1)) || 0
  return `${r > 0 ? '+' : ''}${r.toFixed(1)}`
}
const bpmDiff = (value) => {
  const r = Number(value.toFixed(3)) || 0
  return `${r > 0 ? '+' : ''}${r}`
}

/** The verdict's tone: agreeing is the accent, half/double and a plain offset amber, different red. */
const TONE = {
  same: 'border-accent/40 bg-accent/10',
  double: 'border-amber/40 bg-amber/10',
  half: 'border-amber/40 bg-amber/10',
  offset: 'border-amber/40 bg-amber/10',
  different: 'border-red/40 bg-red/10',
  noOverlap: 'border-line bg-surface-2',
}

/**
 * A comparison (lib/compare.js) in words and a table: the verdict, what it was
 * judged with, then each matched pair of red lines and each line only one side
 * has. `labelA` and `labelB` name the two timings ("Result", "Map", or two
 * songs). Signs read B minus A, and the page says so.
 */
export default function CompareReport({ comparison, labelA, labelB, onPlayAt = null }) {
  const { t } = useTranslation()
  if (!comparison) return null
  const c = comparison
  const names = { a: labelA, b: labelB }
  const verdict = {
    same: t('compare.verdict.same', { ms: c.withinMs?.toFixed(1) }),
    offset: t(c.offsetMs > 0 ? 'compare.verdict.later' : 'compare.verdict.earlier', { ...names, ms: Math.abs(c.offsetMs ?? 0).toFixed(1) }),
    double: t('compare.verdict.double', { ...names, ms: c.withinMs?.toFixed(1) }),
    half: t('compare.verdict.half', { ...names, ms: c.withinMs?.toFixed(1) }),
    different: t('compare.verdict.different', { share: Math.round((c.agreeShare ?? 0) * 100), at: c.firstApartMs === null ? '–' : formatClock(c.firstApartMs) }),
    noOverlap: t('compare.verdict.noOverlap'),
  }[c.verdict]
  const rows = [
    ...c.pairs.map((p) => ({ kind: 'pair', at: Math.min(p.timeA, p.timeB), p })),
    ...c.unmatched.map((u) => ({ kind: 'only', at: u.timeMs, u })),
  ].sort((x, y) => x.at - y.at)

  return (
    <div className="space-y-4">
      <div className={`space-y-1.5 rounded-panel border p-4 ${TONE[c.verdict] ?? ''}`} role="status">
        <p className="heading-title">{verdict}</p>
        {c.verdict !== 'noOverlap' && (
          <p className="text-caption text-muted">
            {t('compare.tolerance', { ms: OFFSET_TOLERANCE_MS, bpm: BPM_TOLERANCE, from: formatClock(c.startMs) })}
          </p>
        )}
        {c.verdict === 'different' && c.relatedShare > 0.005 && (
          <p className="text-caption text-muted">{t('compare.related', { share: Math.round(c.relatedShare * 100) })}</p>
        )}
        {c.meterDiffers > 0 && <p className="text-caption text-muted">{t('compare.meterDiffers', { count: c.meterDiffers })}</p>}
        {c.barsShifted > 0 && <p className="text-caption text-muted">{t('compare.barsShifted', { count: c.barsShifted })}</p>}
        {c.unmatched.length > 0 && <p className="text-caption text-muted">{t('compare.unmatchedCount', { count: c.unmatched.length })}</p>}
      </div>

      <div className="panel max-h-[28rem] overflow-auto">
        <table className="w-full min-w-[44rem] text-left text-label">
          <caption className="sr-only">{t('compare.tableCaption', names)}</caption>
          <thead className="sticky top-0 z-[1] border-b border-line bg-surface-2">
            <tr className="label">
              <th className="px-3 py-2 font-semibold">{t('compare.col.time', { name: labelA })}</th>
              <th className="px-3 py-2 font-semibold">{t('compare.col.time', { name: labelB })}</th>
              <th className="px-3 py-2 font-semibold">{t('strip.bpm')}</th>
              <th className="px-3 py-2 font-semibold" title={t('compare.col.offsetHint')}>
                {t('compare.col.offset')}
              </th>
              <th className="px-3 py-2 font-semibold" title={t('compare.col.endHint')}>
                {t('compare.col.end')}
              </th>
              <th className="px-3 py-2 font-semibold">{t('strip.meter')}</th>
              <th className="px-3 py-2 font-semibold">
                <span className="sr-only">{t('compare.col.status')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) =>
              row.kind === 'pair' ? (
                <PairRow key={`p${row.p.a}-${row.p.b}`} p={row.p} onPlayAt={onPlayAt} />
              ) : (
                <OnlyRow key={`o${row.u.side}${row.u.index}`} u={row.u} names={names} onPlayAt={onPlayAt} />
              ),
            )}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-dim">{t('compare.signNote', names)}</p>
    </div>
  )
}

function PlayAt({ ms, onPlayAt }) {
  const { t } = useTranslation()
  if (!onPlayAt) return null
  return (
    <button type="button" className="tool-btn ml-2 h-6 min-w-6 px-1" onClick={() => onPlayAt(ms)} title={t('compare.playHere')} aria-label={t('compare.playHere')}>
      <Icon name="play" size={12} />
    </button>
  )
}

function PairRow({ p, onPlayAt }) {
  const { t } = useTranslation()
  const kind = p.kind === 'same' ? null : t(`compare.kind.${p.kind}`)
  return (
    <tr className="readout">
      <td className="px-3 py-2 text-text">{formatClock(p.timeA)}</td>
      <td className="px-3 py-2 text-text">{formatClock(p.timeB)}</td>
      <td className="px-3 py-2">
        <span className="text-text">
          {formatBpm(p.bpmA)} → {formatBpm(p.bpmB)}
        </span>{' '}
        <span className={p.bpmOk ? 'text-dim' : 'text-amber'}>({kind ?? bpmDiff(p.bpmDiff)})</span>
      </td>
      <td className={`px-3 py-2 ${p.offsetMs !== null && Math.abs(p.offsetMs) > OFFSET_TOLERANCE_MS ? 'text-amber' : 'text-text'}`}>{ms1(p.offsetMs)}</td>
      <td className={`px-3 py-2 ${p.endOffsetMs !== null && Math.abs(p.endOffsetMs) > OFFSET_TOLERANCE_MS ? 'text-amber' : 'text-text'}`}>{ms1(p.endOffsetMs)}</td>
      <td className={`px-3 py-2 ${p.meterA !== p.meterB ? 'text-amber' : 'text-text'}`}>
        {p.meterA === p.meterB ? `${p.meterA}/4` : `${p.meterA}/4 → ${p.meterB}/4`}
        {p.barShiftBeats ? <span className="ml-1 text-caption text-amber">{t('compare.barShift', { count: p.barShiftBeats })}</span> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className={p.agree ? 'chip-accent' : 'chip-amber'}>{p.agree ? t('compare.agree') : p.aligned ? t(`compare.kind.${p.kind}`) : t('compare.apart')}</span>
        <PlayAt ms={Math.max(p.timeA, p.timeB)} onPlayAt={onPlayAt} />
      </td>
    </tr>
  )
}

function OnlyRow({ u, names, onPlayAt }) {
  const { t } = useTranslation()
  const own = u.side === 'A' ? names.a : names.b
  const other = u.side === 'A' ? names.b : names.a
  return (
    <tr className="readout bg-surface-2/60">
      <td className="px-3 py-2 text-text">{u.side === 'A' ? formatClock(u.timeMs) : '—'}</td>
      <td className="px-3 py-2 text-text">{u.side === 'B' ? formatClock(u.timeMs) : '—'}</td>
      <td className="px-3 py-2 text-text">{formatBpm(u.bpm)}</td>
      <td className="px-3 py-2 font-sans text-caption text-muted" colSpan={2}>
        {u.sameGrid ? t('compare.onlyAgrees', { own, other }) : t('compare.onlyMissing', { own, other })}
      </td>
      <td className="px-3 py-2 text-text">{u.meter}/4</td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className={u.sameGrid ? 'chip-accent' : 'chip-amber'}>{t('compare.only', { name: own })}</span>
        <PlayAt ms={u.timeMs} onPlayAt={onPlayAt} />
      </td>
    </tr>
  )
}
