import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'

import { DocHeader, NextLinks } from '../components/ui/Doc.jsx'
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
    <article className="rise">
      <DocHeader eyebrow={t('learn.footer.title')} title={t('learn.glossary.title')} lede={t('learn.glossary.intro')} />

      <nav aria-label={t('learn.glossary.title')} className="mt-8 flex flex-wrap gap-2">
        {GLOSSARY.map((id) => (
          <a key={id} href={`#${id}`} className="btn-ghost btn-sm font-medium">
            {t(`learn.glossary.terms.${id}.term`)}
          </a>
        ))}
      </nav>

      {/* One row per term: the word on the left, its definitions at a reading measure on the right. */}
      <dl className="mt-12 border-t border-line">
        {GLOSSARY.map((id) => (
          <div
            key={id}
            id={id}
            tabIndex={-1}
            className={`relative grid gap-x-10 gap-y-2 border-b border-line py-7 outline-none lg:grid-cols-12 ${
              id === target ? 'before:absolute before:inset-y-0 before:-left-4 before:w-0.5 before:bg-accent sm:before:-left-6' : ''
            }`}
          >
            <dt className={`doc-heading lg:col-span-3 ${id === target ? 'text-accent' : ''}`}>{t(`learn.glossary.terms.${id}.term`)}</dt>
            <dd className="prose space-y-3 lg:col-span-9 [&>*+*]:mt-0">
              <p className="text-text">{t(`learn.glossary.terms.${id}.short`)}</p>
              <p>{t(`learn.glossary.terms.${id}.long`)}</p>
            </dd>
          </div>
        ))}
      </dl>

      <nav aria-label={t('learn.footer.title')} className="mt-10">
        <NextLinks
          links={[
            { to: '/how-it-works', label: t('learn.footer.how') },
            { to: '/faq', label: t('learn.footer.faq') },
          ]}
        />
      </nav>
    </article>
  )
}
