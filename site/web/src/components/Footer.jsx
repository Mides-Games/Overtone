import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { gutter } from '../lib/gutter.js'
import { REPO_URL } from '../lib/repo.js'
import Logo from './Logo.jsx'
import Mark from './Mark.jsx'

const link = 'text-label text-muted transition hover:text-text'

function Column({ title, links }) {
  return (
    <div className="space-y-3">
      <h3 className="label">{title}</h3>
      <ul className="space-y-2">
        {links.map((item) => (
          <li key={item.label}>
            {item.href ? (
              <a href={item.href} target="_blank" rel="noreferrer noopener" className={link}>
                {item.label} <span className="text-dim">↗</span>
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
    <footer id="site-footer" className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr]" style={gutter}>
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <Mark size={20} />
            <span className="font-display text-[14px] font-bold uppercase tracking-[0.16em]">Overtone</span>
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
            { label: t('calculator.title'), to: '/tools/calculator' },
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
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 py-4 text-caption text-dim" style={gutter}>
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
