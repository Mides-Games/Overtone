import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import Logo from '../components/Logo.jsx'
import Mark from '../components/Mark.jsx'
import TimingStrip from '../components/TimingStrip.jsx'
import GainIcon from '../components/home/GainIcon.jsx'
import LiveNumbers from '../components/home/LiveNumbers.jsx'
import RecentTimings from '../components/home/RecentTimings.jsx'
import SectionHead from '../components/home/SectionHead.jsx'
import Icon from '../components/ui/Icon.jsx'
import Reveal from '../components/ui/Reveal.jsx'
import Waveform, { WaveRule } from '../components/ui/Waveform.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { FAQ, GAINS, STEPS } from '../lib/home.js'
import { REPO_URL } from '../lib/repo.js'

const STEP_ICON = { upload: 'upload', analyse: 'analyse', check: 'listen' }

/**
 * The front page: what Overtone gives a mapper, how, who makes it, and the
 * way in. Everything above the recent list is static strings and inline SVG,
 * so it paints with the bundle; the two requests (recent timings, live
 * numbers) start after that and hide their sections when they have nothing.
 *
 * The layout follows docs/design.md: an asymmetric hero with the live example
 * strip as the product shot, then sections separated by space and one
 * hairline, not boxed. Groups that start below the fold rise in as they come
 * into view (components/ui/Reveal.jsx); nothing waits with reduced motion.
 *
 * Every claim here is one the site keeps today (docs/site.md, "The front
 * page"): change the strings when the site changes, not the other way round.
 */
export default function Home() {
  const { t } = useTranslation()
  usePageMeta('', t('home.subtitle'))

  return (
    <div>
      <Hero />
      <WaveRule className="mt-[calc(var(--space-section)*0.75)]" />
      <Gains />
      <Steps />
      <RecentTimings className={SECTION} />
      <About />
      <FaqTeaser />
      <FinalCta />
    </div>
  )
}

/** A section after the hero: half the section space above and below a hairline. */
const SECTION = 'mt-[calc(var(--space-section)*0.5)] border-t border-line pt-[calc(var(--space-section)*0.5)] first:mt-0'

/** An external link's tail: the arrow, and to a screen reader, that it opens a new tab. */
function External() {
  const { t } = useTranslation()
  return (
    <>
      <Icon name="external" size={15} className="text-dim" />
      <span className="sr-only">{t('common.newTab')}</span>
    </>
  )
}

function Hero() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-title" className="pt-2 sm:pt-6">
      <div className="grid items-center gap-x-10 gap-y-12 lg:grid-cols-12">
        <div className="rise min-w-0 space-y-7 lg:col-span-6 lg:pr-4">
          <p className="eyebrow">{t('home.eyebrow')}</p>
          <h1 id="home-title" className="heading-display hyphens-auto">
            {t('home.title')}
          </h1>
          <p className="lede max-w-[52ch]">{t('home.subtitle')}</p>
          <div className="flex flex-wrap gap-3">
            <Link to="/analyze" className="btn-primary btn-lg">
              {t('home.cta')}
              <Icon name="arrow-right" size={18} />
            </Link>
            <Link to="/how-it-works" className="btn-ghost btn-lg">
              {t('home.howCta')}
            </Link>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-label text-muted">
            {['free', 'noAccount', 'deleted'].map((key) => (
              <li key={key} className="flex items-center gap-2">
                <Icon name="check" size={16} className="text-accent" strokeWidth={2} />
                {t(`home.facts.${key}`)}
              </li>
            ))}
          </ul>
        </div>
        <div className="rise min-w-0 space-y-4 lg:col-span-6" style={{ animationDelay: '60ms' }}>
          <TimingStrip />
          <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-label text-muted">
            <span className="chip-amber">{t('home.checkByEar')}</span>
            <span>
              {t('home.draft')}{' '}
              <Link to="/disclaimer" className="link">
                {t('home.draftLink')}
              </Link>
            </span>
          </p>
        </div>
      </div>
      <div className="mt-14">
        <LiveNumbers />
      </div>
    </section>
  )
}

function Gains() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-gain" className="pt-[calc(var(--space-section)*0.5)]">
      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <SectionHead id="home-gain" eyebrow={t('home.gain.eyebrow')} title={t('home.gain.title')} className="lg:sticky lg:top-[calc(var(--bar-height)+32px)]" />
        </div>
        <Reveal as="ul" className="grid gap-x-10 sm:grid-cols-2 lg:col-span-8">
          {GAINS.map((key, i) => (
            <li key={key} data-reveal style={{ '--i': i }} className="space-y-3 border-t border-line py-7">
              <GainIcon name={key} className="text-accent" />
              <h3 className="heading-title">{t(`home.gain.${key}.title`)}</h3>
              <p className="text-body text-muted">{t(`home.gain.${key}.body`)}</p>
            </li>
          ))}
          <li data-reveal style={{ '--i': GAINS.length }} className="border-t border-line py-7">
            <Link to="/analyze" className="group block space-y-3 rounded-control">
              <span className="heading-title block text-accent">{t('home.gain.try.title')}</span>
              <span className="block text-body text-muted">{t('home.gain.try.body')}</span>
              <span className="inline-flex items-center gap-2 text-label font-semibold text-accent">
                {t('home.cta')}
                <Icon name="arrow-right" size={16} className="transition-transform duration-150 ease-out group-hover:translate-x-1" />
              </span>
            </Link>
          </li>
        </Reveal>
      </div>
    </section>
  )
}

function Steps() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-steps" className={`${SECTION} space-y-10`}>
      <SectionHead id="home-steps" eyebrow={t('home.steps.eyebrow')} title={t('home.steps.title')}>
        <Link to="/how-it-works" className="btn-quiet -mr-2.5">
          {t('home.steps.more')}
          <Icon name="arrow-right" size={16} />
        </Link>
      </SectionHead>
      {/* Three steps along one ruler, each marked where it starts, like red lines on a grid. */}
      <Reveal as="ol" className="grid border-t border-line-strong md:grid-cols-3">
        {STEPS.map((key, i) => (
          <li key={key} data-reveal style={{ '--i': i }} className={`relative space-y-3 pt-8 pb-2 md:pr-8 ${i > 0 ? 'max-md:mt-6 max-md:border-t max-md:border-line md:border-l md:border-line md:pl-8' : ''}`}>
            <span aria-hidden="true" className={`absolute -top-px h-0.5 w-10 bg-accent ${i > 0 ? 'left-0 md:left-8' : 'left-0'}`} />
            <div className="flex items-center justify-between gap-3">
              <span className="readout text-headline font-medium leading-none text-dim" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <GainIcon name={STEP_ICON[key]} className="text-muted" />
            </div>
            <h3 className="heading-title">{t(`home.steps.${key}.title`)}</h3>
            <p className="max-w-[40ch] text-body text-muted">{t(`home.steps.${key}.body`)}</p>
          </li>
        ))}
      </Reveal>
    </section>
  )
}

function About() {
  const { t } = useTranslation()
  const points = [
    { key: 'open', icon: 'code' },
    { key: 'desktop', icon: 'desktop' },
    { key: 'independent', icon: 'not-affiliated' },
  ]
  return (
    <section aria-labelledby="home-about" className={`${SECTION} grid gap-x-10 gap-y-10 lg:grid-cols-12`}>
      <div className="min-w-0 space-y-6 lg:col-span-6">
        <SectionHead id="home-about" eyebrow={t('home.about.eyebrow')} title={t('home.about.title')} />
        <p className="max-w-[60ch] text-body text-muted">{t('home.about.body')}</p>
        <div className="flex flex-wrap gap-3">
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="btn-ghost">
            {t('home.about.source')}
            <External />
          </a>
          <a href="https://midesprojects.com" target="_blank" rel="noreferrer noopener" className="btn-ghost">
            {t('home.about.mides')}
            <External />
          </a>
        </div>
      </div>
      <div className="min-w-0 lg:col-span-5 lg:col-start-8">
        <div className="flex items-center gap-4 pb-6">
          <Logo size={36} className="shrink-0 text-text" />
          <span className="h-8 w-px bg-line-strong" aria-hidden="true" />
          <Mark size={32} />
          <div className="min-w-0">
            <p className="wordmark">Overtone</p>
            <p className="text-caption text-dim">{t('common.byMides')}</p>
          </div>
        </div>
        <Reveal as="ul" className="border-t border-line">
          {points.map((point, i) => (
            <li key={point.key} data-reveal style={{ '--i': i }} className="flex items-start gap-3 border-b border-line py-4 text-body text-muted">
              <Icon name={point.icon} size={20} className="mt-0.5 text-accent" />
              {t(`home.about.${point.key}`)}
            </li>
          ))}
        </Reveal>
      </div>
    </section>
  )
}

function FaqTeaser() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-faq" className={`${SECTION} grid gap-x-10 gap-y-8 lg:grid-cols-12`}>
      <div className="lg:col-span-4">
        <SectionHead id="home-faq" eyebrow={t('home.faq.eyebrow')} title={t('home.faq.title')}>
          <Link to="/faq" className="btn-quiet -ml-2.5 lg:mt-2">
            {t('home.faq.more')}
            <Icon name="arrow-right" size={16} />
          </Link>
        </SectionHead>
      </div>
      <Reveal className="border-t border-line lg:col-span-8">
        {FAQ.map((key, i) => (
          <details key={key} data-reveal style={{ '--i': i }} className="group border-b border-line">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-control py-3 transition-colors duration-150 hover:text-accent [&::-webkit-details-marker]:hidden">
              <h3 className="heading-title">{t(`home.faq.${key}.q`)}</h3>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-muted transition-transform duration-200 ease-out group-open:rotate-45" aria-hidden="true">
                <Icon name="plus" size={14} />
              </span>
            </summary>
            <p className="max-w-[64ch] pb-6 pr-11 text-body text-muted">{t(`home.faq.${key}.a`)}</p>
          </details>
        ))}
      </Reveal>
    </section>
  )
}

function FinalCta() {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="home-final" className={`${SECTION} relative overflow-hidden pb-[calc(var(--space-section)*0.5)]`}>
      {/* The page ends on what it began with: a stretch of waveform cut by a red line. */}
      <Waveform bars={72} lines={[0.42]} seed={23} className="pointer-events-none absolute inset-y-[calc(var(--space-section)*0.5)] right-0 hidden w-[44%] opacity-70 md:block" />
      <div className="relative max-w-xl space-y-5">
        <h2 id="home-final" className="heading-headline">
          {t('home.final.title')}
        </h2>
        <p className="lede">{t('home.final.body')}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-3 pt-2">
          <Link to="/analyze" className="btn-primary btn-lg mr-3">
            {t('home.cta')}
            <Icon name="arrow-right" size={18} />
          </Link>
          <Link to="/community" className="btn-quiet">
            {t('home.final.community')}
          </Link>
          <Link to="/recent" className="btn-quiet">
            {t('home.final.recent')}
          </Link>
        </div>
      </div>
    </section>
  )
}
