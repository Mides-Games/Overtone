import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import TimingStrip from '../components/TimingStrip.jsx'
import { useAuth } from '../context/AuthContext.jsx'

const FEATURES = ['upload', 'confidence', 'account']

export default function Home() {
  const { t } = useTranslation()
  const { account } = useAuth()

  return (
    <div className="space-y-16 sm:space-y-20">
      <section className="grid items-center gap-10 lg:grid-cols-[1fr_1.15fr]">
        <div className="rise min-w-0 space-y-6">
          <p className="label text-accent">{t('home.eyebrow')}</p>
          <h1 className="font-display text-display font-bold uppercase tracking-[-0.01em]">{t('home.title')}</h1>
          <p className="max-w-[56ch] text-body text-muted">{t('home.subtitle')}</p>
          <div className="flex flex-wrap gap-3">
            <Link to="/analyze" className="btn-primary px-5">
              {t('home.cta')}
            </Link>
            {account === null && (
              <Link to="/login" className="btn-ghost">
                {t('home.secondary')}
              </Link>
            )}
          </div>
        </div>
        <div className="rise min-w-0" style={{ animationDelay: '80ms' }}>
          <TimingStrip />
        </div>
      </section>

      <section className="grid gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-3">
        {FEATURES.map((key) => (
          <article key={key} className="space-y-2 bg-surface p-6">
            <h2 className="font-display text-[17px] font-semibold">{t(`home.features.${key}.title`)}</h2>
            <p className="text-label leading-relaxed text-muted">{t(`home.features.${key}.body`)}</p>
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
        <span className="chip-amber shrink-0">{t('home.checkByEar')}</span>
        <p className="max-w-[72ch] text-label leading-relaxed text-muted">{t('home.honest')}</p>
      </section>
    </div>
  )
}
