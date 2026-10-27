import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'
import { GLOSSARY } from '../lib/glossary.js'

/**
 * The glossary (W12.12): every term the result page underlines
 * (components/Term.jsx), with its short definition and the longer one. Each
 * entry's anchor is its id, so `/glossary#drift` lands on it; the router does
 * not scroll to a hash by itself, so this page does, and outlines the entry
 * it was sent to.
 */
export default function Glossary() {
  const { t } = useTranslation()
  usePageMeta(t('learn.glossary.title'), t('learn.glossary.description'))
  const { hash } = useLocation()
  const target = decodeURIComponent(hash.slice(1))

  useEffect(() => {
    if (!GLOSSARY.includes(target)) return
    const entry = document.getElementById(target)
    entry?.scrollIntoView({ block: 'start' })
    entry?.focus({ preventScroll: true })
  }, [target])

  return (
    <article className="rise mx-auto max-w-[72ch] space-y-8">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('learn.glossary.title')}</h1>
        <p className="text-body leading-relaxed text-muted">{t('learn.glossary.intro')}</p>
      </header>

      <nav aria-label={t('learn.glossary.title')} className="flex flex-wrap gap-2">
        {GLOSSARY.map((id) => (
          <a key={id} href={`#${id}`} className="tool-btn px-2.5">
            {t(`learn.glossary.terms.${id}.term`)}
          </a>
        ))}
      </nav>

      <dl className="space-y-3">
        {GLOSSARY.map((id) => (
          <div
            key={id}
            id={id}
            tabIndex={-1}
            className={`scroll-mt-36 space-y-2 rounded-panel border p-4 outline-none ${
              id === target ? 'border-accent/60 bg-accent/5' : 'border-line bg-surface'
            }`}
          >
            <dt className="font-display text-title font-bold">{t(`learn.glossary.terms.${id}.term`)}</dt>
            <dd className="space-y-2">
              <p className="leading-relaxed text-text">{t(`learn.glossary.terms.${id}.short`)}</p>
              <p className="leading-relaxed text-muted">{t(`learn.glossary.terms.${id}.long`)}</p>
            </dd>
          </div>
        ))}
      </dl>

      <nav className="flex flex-wrap gap-4 border-t border-line pt-6 text-label">
        <Link to="/how-it-works" className="text-accent hover:underline">
          {t('learn.footer.how')} →
        </Link>
        <Link to="/faq" className="text-accent hover:underline">
          {t('learn.footer.faq')} →
        </Link>
      </nav>
    </article>
  )
}
