import { useTranslation } from 'react-i18next'

import PipelineDiagram from '../components/learn/PipelineDiagram.jsx'
import Sources from '../components/learn/Sources.jsx'
import { Contents, DocHeader, DocLayout, NextLinks } from '../components/ui/Doc.jsx'
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
 *
 * Set as long-form reading (components/ui/Doc.jsx): the pipeline as a signal
 * chain across the page, then the steps at a reading measure beside a
 * contents list. A step's heading carries its number as a readout, the way
 * the diagram does, so the locale's own "1." prefix is dropped from the text.
 */
const stepTitle = (h) => String(h).replace(/^\s*\d+\.\s*/, '')

function Paragraphs({ items }) {
  return (items ?? []).map((text) => <p key={text}>{text}</p>)
}

export default function HowItWorks() {
  const { t } = useTranslation()
  usePageMeta(t('learn.how.title'), t('learn.how.description'))
  const steps = t('learn.how.steps', { returnObjects: true })
  const ear = t('learn.how.ear', { returnObjects: true })
  const time = t('learn.how.time', { returnObjects: true })
  const bench = t('learn.how.bench', { returnObjects: true })
  const list = Array.isArray(steps) ? steps : []
  const number = (i) => String(i + 1).padStart(2, '0')

  const contents = [
    ...list.map((step, i) => ({ id: `step-${step.id}`, label: stepTitle(step.h), number: number(i) })),
    { id: 'check-by-ear', label: ear.h },
    { id: 'analysis-time', label: time.h },
    { id: 'measured', label: bench.h },
  ]

  return (
    <article className="rise">
      <DocHeader eyebrow={t('learn.footer.title')} title={t('learn.how.title')} lede={t('learn.how.intro')} />

      <div className="mt-10">
        <PipelineDiagram steps={list} title={t('learn.how.diagram.title')} desc={t('learn.how.diagram.desc')} />
      </div>

      <DocLayout contents={<Contents label={t('legal.contents')} items={contents} />}>
        <div className="space-y-14">
          <ol className="space-y-14">
            {list.map((step, i) => (
              <li key={step.id} id={`step-${step.id}`} className="prose">
                <h2 className="doc-heading flex items-baseline gap-3">
                  <span className="readout shrink-0 text-[0.8em] font-medium text-accent">{number(i)}</span>
                  <span>{stepTitle(step.h)}</span>
                </h2>
                <Paragraphs items={step.p} />
                <Sources items={step.src} />
              </li>
            ))}
          </ol>

          {/* The one note the page is for: amber, the colour of "check by ear" on every page. */}
          <section id="check-by-ear" aria-labelledby="check-by-ear-h" className="prose border-l-2 border-amber pl-5 sm:pl-6">
            <p className="chip-amber">{t('home.checkByEar')}</p>
            <h2 id="check-by-ear-h" className="doc-heading">
              {ear.h}
            </h2>
            <Paragraphs items={ear.p} />
            <ul>
              {(ear.li ?? []).map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <Paragraphs items={ear.after} />
            <NextLinks links={[{ to: '/disclaimer', label: t('legal.footer.disclaimer') }]} />
          </section>

          <section id="analysis-time" aria-labelledby="analysis-time-h" className="prose">
            <h2 id="analysis-time-h" className="doc-heading">
              {time.h}
            </h2>
            <Paragraphs items={time.p} />
            <Sources items={time.src} />
            <NextLinks links={[{ to: '/stats', label: t('learn.footer.stats') }]} />
          </section>

          <section id="measured" aria-labelledby="measured-h" className="prose">
            <h2 id="measured-h" className="doc-heading">
              {bench.h}
            </h2>
            <Paragraphs items={bench.p} />
            <Sources items={bench.src} />
          </section>

          <nav aria-label={t('learn.footer.title')} className="max-w-[70ch] border-t border-line pt-6">
            <NextLinks
              links={[
                { to: '/faq', label: t('learn.footer.faq') },
                { to: '/glossary', label: t('learn.footer.glossary') },
              ]}
            />
          </nav>
        </div>
      </DocLayout>
    </article>
  )
}
