import { useTranslation } from 'react-i18next'

import credits from '../data/credits.json'
import usePageMeta from '../hooks/usePageMeta.js'

const REPO_URL = 'https://github.com/Mides-Projects/Overtone'

/**
 * Credits and licences (W4.8). Everything below the team comes from
 * src/data/credits.json, which scripts/credits.mjs writes from the
 * installed packages' own metadata: re-run it after a dependency changes
 * (test/credits.test.js fails until then).
 */
function Packages({ title, list }) {
  const { t } = useTranslation()
  if (!list.length) return null
  return (
    <details className="panel group">
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-4 py-3">
        <span className="font-display text-label font-semibold uppercase">{title}</span>
        <span className="readout text-caption text-dim">
          {t('credits.count', { count: list.length })} <span className="inline-block transition group-open:rotate-90">›</span>
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full text-left text-label">
          <thead>
            <tr className="label">
              <th className="px-4 py-2 font-semibold">{t('credits.package')}</th>
              <th className="px-4 py-2 font-semibold">{t('credits.version')}</th>
              <th className="px-4 py-2 font-semibold">{t('credits.licence')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((p) => (
              <tr key={`${p.name}@${p.version}`}>
                <td className="px-4 py-1.5 break-all">
                  {p.name}
                  {p.direct && <span className="ml-2 text-caption text-dim">{t('credits.direct')}</span>}
                </td>
                <td className="readout px-4 py-1.5 text-muted">{p.version}</td>
                <td className="px-4 py-1.5 text-muted">{p.licence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

export default function Credits() {
  const { t } = useTranslation()
  usePageMeta(t('credits.title'), t('credits.description'))
  const npm = (part, role) => credits.npm.filter((p) => p.part === part && p.role === role)

  return (
    <div className="rise space-y-10">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('credits.title')}</h1>
        <p className="leading-relaxed text-muted">{t('credits.intro')}</p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-title font-bold">{t('credits.team')}</h2>
        <dl className="grid gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-2">
          <div className="space-y-1 bg-surface px-4 py-3">
            <dt className="label">{t('credits.founder')}</dt>
            <dd className="font-semibold">githalt</dd>
            <dd className="text-label text-muted">{t('credits.projectOf')}</dd>
          </div>
          <div className="space-y-1 bg-surface px-4 py-3">
            <dt className="label">{t('credits.contributors')}</dt>
            <dd className="text-label text-muted">
              {t('credits.contributorsBody')}{' '}
              <a href={`${REPO_URL}/graphs/contributors`} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                GitHub ↗
              </a>
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-title font-bold">{t('credits.overtone')}</h2>
        <p className="leading-relaxed text-muted">
          {t('credits.overtoneBody', credits.overtone)}{' '}
          <a href={credits.overtone.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            Mides-Projects/Overtone ↗
          </a>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-title font-bold">{t('credits.model')}</h2>
        <p className="leading-relaxed text-muted">
          {t('credits.modelBody', credits.model)}{' '}
          <a href={credits.model.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            CPJKU/beat_this ↗
          </a>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-title font-bold">{t('credits.engine')}</h2>
        <p className="text-label leading-relaxed text-muted">{t('credits.engineBody')}</p>
        <Packages title="Python" list={credits.python} />
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-title font-bold">{t('credits.site')}</h2>
        <p className="text-label leading-relaxed text-muted">{t('credits.siteBody')}</p>
        <div className="space-y-2">
          <Packages title={t('credits.web')} list={npm('web', 'runtime')} />
          <Packages title={t('credits.api')} list={npm('api', 'runtime')} />
          <Packages title={t('credits.webBuild')} list={npm('web', 'build')} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-title font-bold">{t('credits.fonts')}</h2>
        {credits.fonts.length ? (
          <ul className="list-disc pl-5 text-muted">
            {credits.fonts.map((font) => (
              <li key={font.name}>
                {font.name} · {font.licence}
              </li>
            ))}
          </ul>
        ) : (
          <p className="leading-relaxed text-muted">{t('credits.noFonts')}</p>
        )}
      </section>
    </div>
  )
}
