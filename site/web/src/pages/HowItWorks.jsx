import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import PipelineDiagram from '../components/learn/PipelineDiagram.jsx'
import Sources from '../components/learn/Sources.jsx'
import usePageMeta from '../hooks/usePageMeta.js'

/**
 * How the engine gets from the audio to the red lines (W12.12), for a mapper.
 *
 * Every sentence is in the locale files under `learn.how` and was written from
 * the documents each step cites (docs/05-dsp-pipeline.md, docs/site.md,
 * python/overtone.py, worker/timing_result.py). The only accuracy figures
 * quoted are the synthetic benchmark's, the same ones the disclaimer quotes;
 * real-map measurements (Corpus B) are named as research, without a number,
 * until the site publishes them. A change to the engine that changes a step
 * has to change this text too.
 */
const heading = 'font-display text-title font-bold'
const paragraph = 'leading-relaxed text-muted'

function Paragraphs({ items }) {
  return (items ?? []).map((text) => (
    <p key={text} className={paragraph}>
      {text}
    </p>
  ))
}

export default function HowItWorks() {
  const { t } = useTranslation()
  usePageMeta(t('learn.how.title'), t('learn.how.description'))
  const steps = t('learn.how.steps', { returnObjects: true })
  const ear = t('learn.how.ear', { returnObjects: true })
  const time = t('learn.how.time', { returnObjects: true })
  const bench = t('learn.how.bench', { returnObjects: true })
  const list = Array.isArray(steps) ? steps : []

  return (
    <article className="rise mx-auto max-w-[72ch] space-y-10">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('learn.how.title')}</h1>
        <p className="text-body leading-relaxed text-muted">{t('learn.how.intro')}</p>
      </header>

      <PipelineDiagram steps={list} title={t('learn.how.diagram.title')} desc={t('learn.how.diagram.desc')} />

      <ol className="space-y-8">
        {list.map((step) => (
          <li key={step.id} id={`step-${step.id}`} className="scroll-mt-36 space-y-3">
            <h2 className={heading}>{step.h}</h2>
            <Paragraphs items={step.p} />
            <Sources items={step.src} />
          </li>
        ))}
      </ol>

      <section className="space-y-3 rounded-panel border border-amber/40 bg-amber/5 p-4">
        <h2 className={heading}>{ear.h}</h2>
        <Paragraphs items={ear.p} />
        <ul className="list-disc space-y-1.5 pl-5 leading-relaxed text-muted marker:text-dim">
          {(ear.li ?? []).map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <Paragraphs items={ear.after} />
        <p className="text-label">
          <Link to="/disclaimer" className="text-accent hover:underline">
            {t('legal.footer.disclaimer')} →
          </Link>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className={heading}>{time.h}</h2>
        <Paragraphs items={time.p} />
        <Sources items={time.src} />
        <p className="text-label">
          <Link to="/stats" className="text-accent hover:underline">
            {t('learn.footer.stats')} →
          </Link>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className={heading}>{bench.h}</h2>
        <Paragraphs items={bench.p} />
        <Sources items={bench.src} />
      </section>

      <nav className="flex flex-wrap gap-4 border-t border-line pt-6 text-label">
        <Link to="/faq" className="text-accent hover:underline">
          {t('learn.footer.faq')} →
        </Link>
        <Link to="/glossary" className="text-accent hover:underline">
          {t('learn.footer.glossary')} →
        </Link>
      </nav>
    </article>
  )
}
