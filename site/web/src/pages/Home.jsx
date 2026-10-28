import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import Logo from '../components/Logo.jsx'
import Mark from '../components/Mark.jsx'
import TimingStrip from '../components/TimingStrip.jsx'
import GainIcon from '../components/home/GainIcon.jsx'
import LiveNumbers from '../components/home/LiveNumbers.jsx'
import RecentTimings from '../components/home/RecentTimings.jsx'
import SectionHead from '../components/home/SectionHead.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { FAQ, GAINS, STEPS } from '../lib/home.js'

const REPO_URL = 'https://github.com/Mides-Projects/Overtone'
const STEP_ICON = { upload: 'upload', analyse: 'analyse', check: 'listen' }

/**
 * The front page: what Overtone gives a mapper, how, who makes it, and the
 * way in. Everything above the recent list is static strings and inline SVG,
 * so it paints with the bundle; the two requests (recent timings, live
 * numbers) start after that and hide their sections when they have nothing.
 *
 * Every claim here is one the site keeps today (docs/site.md, "The front
 * page"): change the strings when the site changes, not the other way round.
 */
export default function Home() {
  const { t } = useTranslation()
  usePageMeta('', t('home.subtitle'))

  return (
    <div className="space-y-20 sm:space-y-28">
      <Hero />
      <Gains />
      <Steps />
      <RecentTimings />
      <About />
      <FaqTeaser />
      <FinalCta />
    </div>
  )
}

function Hero() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-title" className="space-y-10">
      <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.15fr]">
        <div className="rise min-w-0 space-y-6">
          <p className="label text-accent">{t('home.eyebrow')}</p>
          <h1 id="home-title" className="font-display text-display font-bold uppercase tracking-[-0.01em]">
            {t('home.title')}
          </h1>
          <p className="max-w-[56ch] text-body text-muted">{t('home.subtitle')}</p>
          <div className="flex flex-wrap gap-3">
            <Link to="/analyze" className="btn-primary px-5">
              {t('home.cta')}
            </Link>
            <Link to="/how-it-works" className="btn-ghost">
              {t('home.howCta')}
            </Link>
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-label text-muted">
            {['free', 'noAccount', 'deleted'].map((key) => (
              <li key={key} className="flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
                {t(`home.facts.${key}`)}
              </li>
            ))}
          </ul>
        </div>
        <div className="rise min-w-0 space-y-3" style={{ animationDelay: '80ms' }}>
          <TimingStrip />
          <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-label text-muted">
            <span className="chip-amber">{t('home.checkByEar')}</span>
            <span>
              {t('home.draft')}{' '}
              <Link to="/disclaimer" className="text-accent hover:underline">
                {t('home.draftLink')}
              </Link>
            </span>
          </p>
        </div>
      </div>
      <LiveNumbers />
    </section>
  )
}

function Gains() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-gain" className="space-y-6">
      <SectionHead id="home-gain" eyebrow={t('home.gain.eyebrow')} title={t('home.gain.title')} />
      <div className="grid gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {GAINS.map((key) => (
          <article key={key} className="space-y-3 bg-surface p-6">
            <GainIcon name={key} className="text-accent" />
            <h3 className="font-display text-[17px] font-semibold">{t(`home.gain.${key}.title`)}</h3>
            <p className="text-label leading-relaxed text-muted">{t(`home.gain.${key}.body`)}</p>
          </article>
        ))}
        <Link to="/analyze" className="group flex flex-col justify-between gap-4 bg-surface-2 p-6 transition hover:bg-surface-3">
          <span className="space-y-2">
            <span className="block font-display text-[17px] font-semibold text-accent">{t('home.gain.try.title')}</span>
            <span className="block text-label leading-relaxed text-muted">{t('home.gain.try.body')}</span>
          </span>
          <span className="font-display text-label font-semibold uppercase text-accent">
            {t('home.cta')} <span className="inline-block transition group-hover:translate-x-1">→</span>
          </span>
        </Link>
      </div>
    </section>
  )
}

function Steps() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-steps" className="space-y-6">
      <SectionHead id="home-steps" eyebrow={t('home.steps.eyebrow')} title={t('home.steps.title')}>
        <Link to="/how-it-works" className="text-label text-accent hover:underline">
          {t('home.steps.more')} →
        </Link>
      </SectionHead>
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map((key, i) => (
          <li key={key} className="panel relative space-y-3 p-6">
            <div className="flex items-center justify-between gap-3">
              <span className="readout text-title text-dim" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <GainIcon name={STEP_ICON[key]} className="text-muted" />
            </div>
            <h3 className="font-display text-[17px] font-semibold">{t(`home.steps.${key}.title`)}</h3>
            <p className="text-label leading-relaxed text-muted">{t(`home.steps.${key}.body`)}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

function About() {
  const { t } = useTranslation()
  const points = [
    { key: 'open', icon: <path d="m8 7-5 5 5 5M16 7l5 5-5 5" /> },
    { key: 'desktop', icon: <path d="M3 5h18v11H3zM8 20h8M12 16v4" /> },
    { key: 'independent', icon: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8" /> },
  ]
  return (
    <section aria-labelledby="home-about" className="grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-center">
      <div className="min-w-0 space-y-5">
        <SectionHead id="home-about" eyebrow={t('home.about.eyebrow')} title={t('home.about.title')} />
        <p className="max-w-[60ch] text-body text-muted">{t('home.about.body')}</p>
        <div className="flex flex-wrap gap-3">
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="btn-ghost">
            {t('home.about.source')} <span className="text-dim">↗</span>
          </a>
          <a href="https://midesprojects.com" target="_blank" rel="noreferrer noopener" className="btn-ghost">
            {t('home.about.mides')} <span className="text-dim">↗</span>
          </a>
        </div>
      </div>
      <div className="panel min-w-0 overflow-hidden">
        <div className="flex items-center gap-4 border-b border-line bg-surface-2 px-6 py-5">
          <Logo size={36} className="shrink-0 text-text" />
          <span className="h-8 w-px bg-line-strong" aria-hidden="true" />
          <Mark size={32} />
          <div className="min-w-0">
            <p className="font-display text-[15px] font-bold uppercase tracking-[0.12em]">Overtone</p>
            <p className="text-caption text-dim">{t('common.byMides')}</p>
          </div>
        </div>
        <ul className="divide-y divide-line">
          {points.map((point) => (
            <li key={point.key} className="flex items-start gap-3 px-6 py-4 text-label leading-relaxed text-muted">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0 text-accent">
                {point.icon}
              </svg>
              {t(`home.about.${point.key}`)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function FaqTeaser() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-faq" className="space-y-6">
      <SectionHead id="home-faq" eyebrow={t('home.faq.eyebrow')} title={t('home.faq.title')}>
        <Link to="/faq" className="text-label text-accent hover:underline">
          {t('home.faq.more')} →
        </Link>
      </SectionHead>
      <div className="divide-y divide-line rounded-panel border border-line bg-surface">
        {FAQ.map((key) => (
          <details key={key} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-display text-[16px] font-semibold transition hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              <h3>{t(`home.faq.${key}.q`)}</h3>
              <span className="shrink-0 text-dim transition group-open:rotate-45" aria-hidden="true">
                +
              </span>
            </summary>
            <p className="max-w-[72ch] px-5 pb-5 text-label leading-relaxed text-muted">{t(`home.faq.${key}.a`)}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

function FinalCta() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-final" className="panel relative overflow-hidden px-6 py-10 sm:px-10 sm:py-12">
      {/* Bar lines and one red line behind the text: the page ends on the grid it began with. */}
      <svg className="pointer-events-none absolute inset-0 hidden h-full w-full md:block" preserveAspectRatio="none" viewBox="0 0 100 10" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <line key={i} x1={62 + i * 5} x2={62 + i * 5} y1="0" y2="10" stroke={i % 4 === 0 ? 'var(--line-strong)' : 'var(--grid)'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1="82" x2="82" y1="0" y2="10" stroke="var(--red)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="relative max-w-xl space-y-4">
        <h2 id="home-final" className="font-display text-[clamp(1.5rem,1.1rem+1.6vw,2.3rem)] font-bold uppercase leading-tight">
          {t('home.final.title')}
        </h2>
        <p className="text-body text-muted">{t('home.final.body')}</p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-2">
          <Link to="/analyze" className="btn-primary px-5">
            {t('home.cta')}
          </Link>
          <Link to="/community" className="text-label text-accent hover:underline">
            {t('home.final.community')}
          </Link>
          <Link to="/recent" className="text-label text-accent hover:underline">
            {t('home.final.recent')}
          </Link>
        </div>
      </div>
    </section>
  )
}
