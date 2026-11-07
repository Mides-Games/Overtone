import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  busiestMonth,
  fillMonths,
  GRADES,
  historyDate,
  MAP_STATES,
  mapShares,
  MODE_NAMES,
  monthName,
  nearestPoint,
  playHours,
  rankLine,
  rankSpan,
} from '../../lib/osu-card.js'
import { useWidth } from '../StatsCharts.jsx'
import Icon from '../ui/Icon.jsx'

/**
 * The linked osu! account (W9.2; the wider card of 2026-11-07) as osu! said
 * at link time or at the owner's last "Refresh": never fetched on a page
 * view. No avatar or cover: the page loads no image from osu!'s host
 * (deploy/web/serve.mjs, img-src), so the level ring stands where a picture
 * would. Every chart is drawn here from the card's numbers, in the theme's
 * tokens and the profile's accent, each with its summary in words for a
 * screen reader. A link made before the wider card has only the six numbers
 * until its next Refresh, and the owner is told so.
 *
 * `framed`: a panel of its own on /u/<name>; inside the linked-accounts
 * panel on /profile it is drawn bare.
 */

/** The fill of each beatmap set state (lib/osu-card.js MAP_STATES), spelled out for Tailwind. */
const STATE_FILL = { accent: 'bg-accent', red: 'bg-red', compare: 'bg-compare', amber: 'bg-amber', onset: 'bg-onset' }

const useNumbers = () => {
  const { i18n } = useTranslation()
  const lang = i18n.language
  const number = (n, digits = 0) =>
    n === null || n === undefined || !Number.isFinite(Number(n)) ? '–' : Number(n).toLocaleString(lang, { maximumFractionDigits: digits })
  return { lang, number, rank: (n) => (n === null || n === undefined ? '–' : `#${number(n)}`) }
}

export default function OsuCard({ osu, action = null, framed = true }) {
  const { t } = useTranslation()
  const { lang, number, rank } = useNumbers()
  if (!osu) return null
  const d = osu.details ?? null
  const mode = d?.mode ? MODE_NAMES[d.mode] : null
  let country = osu.country
  try {
    if (osu.country) country = new Intl.DisplayNames([lang], { type: 'region' }).of(osu.country) ?? osu.country
  } catch {
    // An old browser without DisplayNames: the two letters.
  }
  const joined = d?.joinedAt ? new Date(d.joinedAt).toLocaleDateString(lang, { month: 'long', year: 'numeric' }) : null
  const asOf = osu.refreshedAt ? new Date(osu.refreshedAt).toLocaleDateString(lang, { dateStyle: 'medium' }) : null
  const main = [
    { key: 'globalRank', value: rank(osu.globalRank) },
    { key: 'countryRank', value: rank(osu.countryRank) },
    { key: 'pp', value: number(osu.pp), unit: osu.pp === null ? null : 'pp' },
    { key: 'accuracy', value: number(osu.accuracy, 2), unit: osu.accuracy === null ? null : '%' },
  ]

  return (
    <section aria-labelledby="profile-osu" className={framed ? 'panel overflow-hidden' : undefined}>
      {framed && <div aria-hidden="true" className="h-1 bg-accent" />}
      <div className={`space-y-7 ${framed ? 'p-5 sm:p-6' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <LevelRing level={d?.level ?? null} initial={osu.username?.[0] ?? '?'} />
            <div className="min-w-0 space-y-1.5">
              <h2 id="profile-osu" className="label">
                {t('social.profile.osu.title')}
              </h2>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <a
                  href={osu.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link inline-flex min-w-0 items-center gap-1.5 break-all text-title font-bold"
                >
                  {osu.username}
                  <Icon name="external" size={15} />
                  <span className="sr-only">{t('common.newTab')}</span>
                </a>
                {d?.supporter && (
                  <span className="chip-red">
                    <Icon name="heart" size={12} strokeWidth={2} />
                    {t('social.profile.osu.supporter')}
                  </span>
                )}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-muted">
                {mode && <span className="chip-neutral normal-case">{mode}</span>}
                {[country, joined && t('social.profile.osu.joined', { date: joined })].filter(Boolean).join(' · ')}
              </p>
              {d?.groups?.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label={t('social.profile.osu.groups')}>
                  {d.groups.map((g) => (
                    <li key={g.short}>
                      <span className="chip-neutral" title={g.name}>
                        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.colour ?? 'var(--line-strong)' }} />
                        <span aria-hidden="true">{g.short}</span>
                        <span className="sr-only">{g.name}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {action}
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-control)] border border-line bg-line sm:grid-cols-4">
          {main.map((cell) => (
            <div key={cell.key} className="min-w-0 space-y-1 bg-surface px-4 py-3">
              <dt className="label">{t(`social.profile.osu.${cell.key}`)}</dt>
              <dd className="readout truncate text-heading font-semibold text-text">
                {cell.value}
                {cell.unit && <span className="unit">{cell.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>

        {d ? (
          <>
            <RankHistory history={d.rankHistory} peak={d.peakRank} asOf={osu.refreshedAt} />
            <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
              <Playing osu={osu} details={d} />
              <Mapping osu={osu} details={d} />
            </div>
            <MonthlyPlays months={d.monthlyPlays} />
          </>
        ) : (
          <>
            <dl className="flex flex-wrap gap-x-10 gap-y-3">
              {[
                ['playCount', number(osu.playCount)],
                ['ranked', number(osu.rankedCount)],
              ].map(([key, value]) => (
                <div key={key} className="space-y-1">
                  <dt className="label">{t(`social.profile.osu.${key}`)}</dt>
                  <dd className="readout text-lead font-semibold text-text">{value}</dd>
                </div>
              ))}
            </dl>
            {action && <p className="text-caption text-muted">{t('social.profile.osu.refreshForMore')}</p>}
          </>
        )}

        {asOf && <p className="readout text-caption text-dim">{t('social.profile.osu.asOf', { date: asOf })}</p>}
      </div>
    </section>
  )
}

/** The level as a ring filling towards the next one; the name's first letter when osu! sent no level. */
function LevelRing({ level, initial }) {
  const { t } = useTranslation()
  const size = 64
  const stroke = 5
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const filled = level ? (circumference * level.progress) / 100 : 0
  return (
    <div
      className="relative grid h-16 w-16 shrink-0 place-items-center"
      role={level ? 'img' : undefined}
      aria-label={level ? t('social.profile.osu.levelValue', { level: level.current, progress: level.progress }) : undefined}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="stroke-line-strong" strokeWidth={stroke} />
        {filled > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            className="stroke-accent"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
          />
        )}
      </svg>
      {level ? (
        <span aria-hidden="true" className="relative text-center leading-none">
          <span className="label block text-[10px]">{t('social.profile.osu.levelShort')}</span>
          <span className="readout block text-title font-semibold text-text">{level.current}</span>
        </span>
      ) : (
        <span aria-hidden="true" className="heading-title relative text-heading text-accent">
          {initial.toUpperCase()}
        </span>
      )}
    </div>
  )
}

const RANK_H = 120
const RANK_GUTTER = 72

/** The global rank over the last 90 days: a better rank is higher, a day without one breaks the line. */
function RankHistory({ history, peak, asOf }) {
  const { t } = useTranslation()
  const { lang, number, rank } = useNumbers()
  const [box, width] = useWidth()
  const [hover, setHover] = useState(null)
  const span = rankSpan(history)
  const days = history?.length ?? 0
  const line = span ? rankLine(history, Math.max(0, width - RANK_GUTTER), RANK_H, 8) : null
  const dateOf = (i) => historyDate(asOf, days, i)?.toLocaleDateString(lang, { day: 'numeric', month: 'short' }) ?? ''
  const shown = hover ?? line?.points.at(-1) ?? null
  const peakDate = peak?.at ? new Date(peak.at).toLocaleDateString(lang, { month: 'short', year: 'numeric' }) : null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="heading-title">{t('social.profile.osu.rankHistory', { days })}</h3>
        <p className="readout flex flex-wrap items-baseline gap-x-3 text-label">
          {span &&
            (span.change > 0 ? (
              <span className="text-tempo">▲ {t('social.profile.osu.rankUp', { value: number(span.change) })}</span>
            ) : span.change < 0 ? (
              <span className="text-red">▼ {t('social.profile.osu.rankDown', { value: number(-span.change) })}</span>
            ) : (
              <span className="text-dim">{t('social.profile.osu.rankSame')}</span>
            ))}
          {peak && (
            <span className="text-muted">
              {peakDate
                ? t('social.profile.osu.peakOn', { rank: number(peak.rank), date: peakDate })
                : t('social.profile.osu.peak', { rank: number(peak.rank) })}
            </span>
          )}
        </p>
      </div>
      <div ref={box}>
        {!span ? (
          <p className="text-label text-dim">{t('social.profile.osu.noRankHistory')}</p>
        ) : (
          width > 0 &&
          line && (
            <svg
              width={width}
              height={RANK_H}
              role="img"
              aria-label={t('social.profile.osu.rankLabel', { days, from: number(span.from), to: number(span.to) })}
              className="block touch-pan-y"
              onPointerMove={(e) => setHover(nearestPoint(line.points, e.clientX - e.currentTarget.getBoundingClientRect().left - RANK_GUTTER))}
              onPointerLeave={() => setHover(null)}
            >
              <text x={RANK_GUTTER - 12} y="8" dy="0.35em" textAnchor="end" className="readout fill-muted text-[12px]">
                {rank(span.best)}
              </text>
              <text x={RANK_GUTTER - 12} y={RANK_H - 8} dy="0.35em" textAnchor="end" className="readout fill-dim text-[12px]">
                {rank(span.worst)}
              </text>
              <g transform={`translate(${RANK_GUTTER} 0)`}>
                {[8, RANK_H / 2, RANK_H - 8].map((y) => (
                  <line key={y} x1="0" x2={width - RANK_GUTTER} y1={y} y2={y} className="stroke-line" strokeWidth="1" strokeDasharray="2 4" />
                ))}
                {line.area && <path d={line.area} className="fill-accent" fillOpacity="0.1" />}
                <path d={line.d} fill="none" className="stroke-accent" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {shown && (
                  <>
                    {hover && <line x1={shown.x} x2={shown.x} y1="0" y2={RANK_H} className="stroke-line-strong" strokeWidth="1" />}
                    <circle cx={shown.x} cy={shown.y} r="4" className="fill-accent stroke-surface" strokeWidth="2" />
                  </>
                )}
              </g>
            </svg>
          )
        )}
      </div>
      {shown && (
        <p className="readout text-caption text-muted" aria-hidden="true">
          {t('social.profile.osu.rankOn', { date: dateOf(shown.i), rank: number(shown.rank) })}
        </p>
      )}
    </div>
  )
}

/** Grades and the play numbers that are not on the top row. */
function Playing({ osu, details }) {
  const { t } = useTranslation()
  const { number } = useNumbers()
  const hours = playHours(details.playTime)
  const stats = [
    ['playCount', osu.playCount === null ? null : number(osu.playCount)],
    ['playTime', hours === null ? null : t('social.profile.osu.hours', { value: number(hours) })],
    ['maxCombo', details.maxCombo === null ? null : `${number(details.maxCombo)}×`],
    ['rankedScore', details.rankedScore === null ? null : number(details.rankedScore)],
    ['totalHits', details.totalHits === null ? null : number(details.totalHits)],
    ['replays', details.replaysWatched === null ? null : number(details.replaysWatched)],
    ['firstPlaces', details.firstPlaces === null ? null : number(details.firstPlaces)],
    ['medals', details.medals === null ? null : number(details.medals)],
    ['followers', details.followers === null ? null : number(details.followers)],
  ].filter(([, value]) => value !== null)
  return (
    <div className="min-w-0 space-y-5">
      <h3 className="heading-title">{t('social.profile.osu.playing')}</h3>
      {details.grades && (
        <dl className="grid grid-cols-5 gap-2" aria-label={t('social.profile.osu.grades')}>
          {GRADES.map((g) => (
            <div key={g.key} className="min-w-0 space-y-1.5 rounded-[var(--radius-control)] bg-surface-2 px-1 py-2.5 text-center">
              <dt className="leading-none">
                <span
                  aria-hidden="true"
                  className={`heading-title text-title ${g.silver ? 'text-muted' : g.key === 'a' ? 'text-tempo' : 'text-amber'}`}
                >
                  {g.letter}
                </span>
                <span aria-hidden="true" className="label mt-1 block min-h-[1.4em] text-[10px]">
                  {g.silver ? t('social.profile.osu.silver') : ''}
                </span>
                <span className="sr-only">{g.silver ? `${g.letter} (${t('social.profile.osu.silver')})` : g.letter}</span>
              </dt>
              <dd className="readout truncate text-label font-semibold text-text">{number(details.grades[g.key])}</dd>
            </div>
          ))}
        </dl>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {stats.map(([key, value]) => (
          // A ranked score runs to 14 characters: on a phone it takes the row rather than being cut.
          <div key={key} className={`min-w-0 space-y-1 border-t border-line pt-2.5 ${key === 'rankedScore' ? 'col-span-2 sm:col-span-1' : ''}`}>
            <dt className="label">{t(`social.profile.osu.${key}`)}</dt>
            <dd className="readout truncate text-lead font-semibold text-text" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** The mapper's side: beatmap sets by state as one bar, then what the mapping community gave back. */
function Mapping({ osu, details }) {
  const { t } = useTranslation()
  const { number } = useNumbers()
  const maps = { ranked: osu.rankedCount, ...(details.maps ?? {}) }
  const { total, parts } = mapShares(maps)
  const listText = parts.map((p) => `${t(`social.profile.osu.maps.${p.key}`)} ${number(p.count)}`).join(', ')
  const extra = [
    ['mappingFollowers', details.mappingFollowers],
    ['kudosu', details.kudosu],
    ['favourite', details.maps?.favourite ?? null],
    ['nominated', details.maps?.nominated ? details.maps.nominated : null],
  ].filter(([, value]) => value !== null && value !== undefined)
  return (
    <div className="min-w-0 space-y-5">
      <h3 className="heading-title">{t('social.profile.osu.mapping')}</h3>
      {total > 0 ? (
        <div className="space-y-4">
          <div role="img" aria-label={t('social.profile.osu.mapsLabel', { list: listText })} className="flex h-3 gap-[2px] overflow-hidden rounded-[2px]">
            {parts.map((p) => (
              <span key={p.key} className={`h-full ${STATE_FILL[p.tone]}`} style={{ width: `${p.share}%` }} />
            ))}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
            {MAP_STATES.map((s) => (
              <div key={s.key} className="flex min-w-0 items-baseline justify-between gap-2 border-b border-line py-2">
                <dt className="flex min-w-0 items-center gap-2 text-label text-muted">
                  <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ${STATE_FILL[s.tone]}`} />
                  <span className="truncate">{t(`social.profile.osu.maps.${s.key}`)}</span>
                </dt>
                <dd className="readout text-label font-semibold text-text">{number(maps[s.key] ?? 0)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <p className="text-label text-dim">{t('social.profile.osu.noMaps')}</p>
      )}
      {extra.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          {extra.map(([key, value]) => (
            <div key={key} className="min-w-0 space-y-1 border-t border-line pt-2.5">
              <dt className="label">{t(key === 'favourite' || key === 'nominated' ? `social.profile.osu.maps.${key}` : `social.profile.osu.${key}`)}</dt>
              <dd className="readout truncate text-lead font-semibold text-text">{number(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

const MONTH_H = 88

/** Plays per month over the last two years, a month without plays drawn as a floor mark. */
function MonthlyPlays({ months }) {
  const { t } = useTranslation()
  const { lang, number } = useNumbers()
  const [box, width] = useWidth()
  const filled = fillMonths(months).slice(-24)
  const peak = busiestMonth(filled)
  if (filled.length < 2 || !peak) return null
  const gap = filled.length > 18 ? 3 : 4
  const bar = Math.max(1, (width - gap * (filled.length - 1)) / filled.length)
  return (
    <div className="space-y-3">
      <h3 className="heading-title">{t('social.profile.osu.monthly')}</h3>
      <div ref={box}>
        {width > 0 && (
          <svg
            width={width}
            height={MONTH_H}
            role="img"
            aria-label={t('social.profile.osu.monthlyLabel', { months: filled.length, month: monthName(peak.month, lang, 'long'), plays: number(peak.count) })}
            className="block"
          >
            <line x1="0" x2={width} y1={MONTH_H - 0.5} y2={MONTH_H - 0.5} className="stroke-line-strong" strokeWidth="1" />
            {filled.map((m, i) => {
              const h = m.count ? Math.max(3, ((MONTH_H - 4) * m.count) / peak.count) : 1
              // The busiest month and the latest stand out; the rest recede.
              const strong = m.month === peak.month || i === filled.length - 1
              return (
                <rect
                  key={m.month}
                  x={i * (bar + gap)}
                  y={MONTH_H - h}
                  width={bar}
                  height={h}
                  rx="1.5"
                  className={m.count ? 'fill-accent' : 'fill-line-strong'}
                  fillOpacity={m.count && !strong ? 0.45 : 1}
                >
                  <title>{`${monthName(m.month, lang)}: ${number(m.count)}`}</title>
                </rect>
              )
            })}
          </svg>
        )}
      </div>
      <div className="readout space-y-1.5 text-caption" aria-hidden="true">
        <p className="flex justify-between gap-4 whitespace-nowrap text-dim">
          <span>{monthName(filled[0].month, lang)}</span>
          <span>{monthName(filled.at(-1).month, lang)}</span>
        </p>
        <p className="text-muted">{t('social.profile.osu.monthlyPeak', { month: monthName(peak.month, lang), plays: number(peak.count) })}</p>
      </div>
    </div>
  )
}
