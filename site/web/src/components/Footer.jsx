import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { gutter } from '../lib/gutter.js'
import { REPO_URL } from '../lib/repo.js'
import Logo from './Logo.jsx'
import Mark from './Mark.jsx'
import Icon from './ui/Icon.jsx'
import { WaveRule } from './ui/Waveform.jsx'

/**
 * The footer: no box, the page's own ground under one hairline with the
 * waveform on it. The name and what it is on the left, then the site's
 * places in five short columns with mono headings. An external link carries
 * an arrow and says, to a screen reader, that it opens a new tab.
 */
const link = 'inline-flex items-center gap-1 py-0.5 text-label text-muted transition-colors duration-150 hover:text-text'

function Column({ title, links }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <h2 className="label">{title}</h2>
      <ul className="space-y-1.5">
        {links.map((item) => (
          <li key={item.label}>
            {item.href ? (
              <a href={item.href} target="_blank" rel="noreferrer noopener" className={link}>
                {item.label}
                <Icon name="external" size={13} className="text-dim" />
                <span className="sr-only">{t('common.newTab')}</span>
              </a>
            ) : (
              <Link to={item.to} className={link}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function Footer() {
  const { t } = useTranslation()

  return (
    <footer id="site-footer" className="mt-8">
      <div className="mx-auto max-w-[76rem]" style={gutter}>
        <WaveRule />
      </div>
      <div className="mx-auto grid max-w-[76rem] gap-x-8 gap-y-10 py-14 sm:grid-cols-2 lg:grid-cols-[1.6fr_repeat(5,1fr)]" style={gutter}>
        <div className="space-y-3 sm:col-span-2 lg:col-span-1">
          <div className="flex items-center gap-2.5">
            <Mark size={22} />
            <span className="wordmark">Overtone</span>
          </div>
          <p className="max-w-xs text-label text-muted">{t('footer.tagline')}</p>
        </div>
        <Column
          title={t('footer.site')}
          links={[
            { label: t('nav.analyze'), to: '/analyze' },
            { label: t('nav.profile'), to: '/profile' },
            { label: t('settings.title'), to: '/settings' },
            { label: t('legal.footer.status'), to: '/status' },
          ]}
        />
        <Column
          title={t('learn.footer.title')}
          links={[
            { label: t('learn.footer.how'), to: '/how-it-works' },
            { label: t('learn.footer.faq'), to: '/faq' },
            { label: t('learn.footer.glossary'), to: '/glossary' },
            { label: t('learn.footer.stats'), to: '/stats' },
          ]}
        />
        <Column
          title={t('footer.ecosystem')}
          links={[
            { label: 'midesprojects.com', href: 'https://midesprojects.com' },
            { label: 'Discord', href: 'https://discord.gg/mides' },
          ]}
        />
        <Column
          title={t('footer.project')}
          links={[
            { label: t('platform.developers.footer'), to: '/developers' },
            { label: t('footer.source'), href: REPO_URL },
            { label: t('footer.docs'), href: `${REPO_URL}/tree/master/docs` },
          ]}
        />
        <Column
          title={t('legal.footer.title')}
          links={[
            { label: t('legal.footer.terms'), to: '/terms' },
            { label: t('legal.footer.privacy'), to: '/privacy' },
            { label: t('legal.footer.disclaimer'), to: '/disclaimer' },
            { label: t('legal.footer.credits'), to: '/credits' },
          ]}
        />
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[76rem] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-5 text-caption text-dim" style={gutter}>
          <span className="readout">{t('footer.rights', { year: new Date().getFullYear() })}</span>
          <span className="flex items-center gap-2">
            <Logo size={16} />
            {t('common.byMides')}
          </span>
        </div>
      </div>
    </footer>
  )
}
