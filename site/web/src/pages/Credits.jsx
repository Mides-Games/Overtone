import { useTranslation } from 'react-i18next'

import { Contents, DocHeader, DocLayout } from '../components/ui/Doc.jsx'
import Icon from '../components/ui/Icon.jsx'
import credits from '../data/credits.json'
import usePageMeta from '../hooks/usePageMeta.js'

const REPO_URL = 'https://github.com/Mides-Projects/Overtone'

/**
 * Credits and licences (W4.8). Everything below the team comes from
 * src/data/credits.json, which scripts/credits.mjs writes from the
 * installed packages' own metadata: re-run it after a dependency changes
 * (test/credits.test.js fails until then).
 *
 * The faces the site sets its text in come from @fontsource-variable
 * packages (docs/design.md, section 3), so they are npm packages in that
 * file, not hand-written @font-face rules in `fonts`: the Fonts section lists
 * those packages, and says "none" only when there are neither.
 */
const FONT_PACKAGE = /^@fontsource(-variable)?\//

function External({ href, children }) {
  const { t } = useTranslation()
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1">
      {children}
      <Icon name="external" size={13} />
      <span className="sr-only">{t('common.newTab')}</span>
    </a>
  )
}

/** A list of packages: a panel you open, with a table that scrolls sideways inside it on a phone. */
function Packages({ title, list }) {
  const { t } = useTranslation()
  if (!list.length) return null
  return (
    <details className="panel group">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-panel px-4 py-3 transition-colors duration-150 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <span className="text-body font-semibold text-text">{title}</span>
        <span className="flex items-center gap-3">
          <span className="readout text-caption text-dim">{t('credits.count', { count: list.length })}</span>
          <Icon name="chevron-down" size={16} className="text-muted transition-transform duration-200 ease-out group-open:rotate-180" />
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full border-collapse text-left text-label">
          <thead>
            <tr>
              <th scope="col" className="label border-b border-line px-4 py-2.5 font-medium">
                {t('credits.package')}
              </th>
              <th scope="col" className="label border-b border-line px-4 py-2.5 text-right font-medium">
                {t('credits.version')}
              </th>
              <th scope="col" className="label border-b border-line px-4 py-2.5 font-medium">
                {t('credits.licence')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((p) => (
              <tr key={`${p.name}@${p.version}`} className="hover:bg-surface-2">
                <th scope="row" className="px-4 py-2 font-normal break-all text-text">
                  <span className="readout">{p.name}</span>
                  {p.direct && <span className="chip-neutral ml-2 align-middle">{t('credits.direct')}</span>}
                </th>
                <td className="readout px-4 py-2 text-right whitespace-nowrap text-muted">{p.version}</td>
                <td className="readout px-4 py-2 whitespace-nowrap text-muted">{p.licence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function Section({ id, title, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="space-y-4">
      <h2 id={`${id}-h`} className="doc-heading">
        {title}
      </h2>
      {children}
    </section>
  )
}

export default function Credits() {
  const { t } = useTranslation()
  usePageMeta(t('credits.title'), t('credits.description'))
  const npm = (part, role) => credits.npm.filter((p) => p.part === part && p.role === role)
  const fonts = credits.fonts.length ? credits.fonts : credits.npm.filter((p) => FONT_PACKAGE.test(p.name))

  const sections = [
    { id: 'team', label: t('credits.team') },
    { id: 'overtone', label: t('credits.overtone') },
    { id: 'model', label: t('credits.model') },
    { id: 'engine', label: t('credits.engine') },
    { id: 'site', label: t('credits.site') },
    { id: 'fonts', label: t('credits.fonts') },
  ]

  return (
    <article className="rise">
      <DocHeader eyebrow={t('legal.footer.title')} title={t('credits.title')} lede={t('credits.intro')} />

      <DocLayout contents={<Contents label={t('legal.contents')} items={sections} />}>
        <div className="max-w-[52rem] space-y-14">
          <Section id="team" title={t('credits.team')}>
            <dl className="grid border-t border-line sm:grid-cols-2">
              <div className="space-y-1 border-b border-line py-4 sm:pr-6">
                <dt className="label">{t('credits.founder')}</dt>
                <dd className="text-lead font-semibold text-text">githalt</dd>
                <dd className="text-label text-muted">{t('credits.projectOf')}</dd>
              </div>
              <div className="space-y-1 border-b border-line py-4 sm:border-l sm:pl-6">
                <dt className="label">{t('credits.contributors')}</dt>
                <dd className="text-label text-muted">
                  {t('credits.contributorsBody')} <External href={`${REPO_URL}/graphs/contributors`}>GitHub</External>
                </dd>
              </div>
            </dl>
          </Section>

          <Section id="overtone" title={t('credits.overtone')}>
            <p className="prose">
              {t('credits.overtoneBody', credits.overtone)} <External href={credits.overtone.url}>Mides-Projects/Overtone</External>
            </p>
          </Section>

          <Section id="model" title={t('credits.model')}>
            <p className="prose">
              {t('credits.modelBody', credits.model)} <External href={credits.model.url}>CPJKU/beat_this</External>
            </p>
          </Section>

          <Section id="engine" title={t('credits.engine')}>
            <p className="prose">{t('credits.engineBody')}</p>
            <Packages title="Python" list={credits.python} />
          </Section>

          <Section id="site" title={t('credits.site')}>
            <p className="prose">{t('credits.siteBody')}</p>
            <div className="space-y-2">
              <Packages title={t('credits.web')} list={npm('web', 'runtime')} />
              <Packages title={t('credits.api')} list={npm('api', 'runtime')} />
              <Packages title={t('credits.webBuild')} list={npm('web', 'build')} />
            </div>
          </Section>

          <Section id="fonts" title={t('credits.fonts')}>
            {fonts.length ? (
              <ul className="border-t border-line text-label">
                {fonts.map((font) => (
                  <li key={font.name} className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-line py-2.5">
                    <span className="readout text-text">{font.name}</span>
                    <span className="readout text-muted">{font.licence}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="prose">{t('credits.noFonts')}</p>
            )}
          </Section>
        </div>
      </DocLayout>
    </article>
  )
}
