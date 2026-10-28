import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'

import { Contents, DocHeader, DocLayout, NextLinks } from '../components/ui/Doc.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { api } from '../lib/api.js'

/**
 * The questions a mapper asks about a result (W12.12). The text is in the
 * locale files under `learn.faq.items`; each item is `{ id, q, a, links? }`
 * and its id is its anchor (`/faq#offset`).
 *
 * The limits are not written down here: they are read from
 * `GET /api/v1/health`, the one place the API states them, so the page cannot
 * go stale when the owner changes a quota.
 *
 * Set as long-form reading (components/ui/Doc.jsx): the questions beside the
 * answers on a wide screen, listed above them on a phone.
 */
function Limits() {
  const { t } = useTranslation()
  // undefined while asking, null when the API did not answer.
  const [limits, setLimits] = useState(undefined)

  useEffect(() => {
    let live = true
    api('/health')
      .then((health) => live && setLimits(health?.limits ?? null))
      .catch(() => live && setLimits(null))
    return () => {
      live = false
    }
  }, [])

  if (limits === undefined) return <p className="text-label text-dim">{t('learn.faq.limits.loading')}</p>
  if (!limits) {
    return (
      <div className="callout callout-amber">
        <p>{t('learn.faq.limits.unreachable')}</p>
        <NextLinks links={[{ to: '/status', label: t('legal.footer.status') }]} className="mt-1" />
      </div>
    )
  }
  return (
    <ul>
      <li>{t('learn.faq.limits.anon', { daily: limits.anonDailyLimit, pending: limits.anonMaxPending })}</li>
      <li>{t('learn.faq.limits.user', { daily: limits.userDailyLimit, pending: limits.userMaxPending })}</li>
      <li>{t('learn.faq.limits.size', { minutes: Math.floor(limits.maxAudioSeconds / 60), mb: limits.maxUploadMb })}</li>
    </ul>
  )
}

export default function Faq() {
  const { t } = useTranslation()
  usePageMeta(t('learn.faq.title'), t('learn.faq.description'))
  const items = t('learn.faq.items', { returnObjects: true })
  const list = Array.isArray(items) ? items : []
  const { hash } = useLocation()
  const target = decodeURIComponent(hash.slice(1))

  useEffect(() => {
    if (!target) return
    document.getElementById(target)?.scrollIntoView({ block: 'start' })
  }, [target])

  return (
    <article className="rise">
      <DocHeader eyebrow={t('learn.footer.title')} title={t('learn.faq.title')} lede={t('learn.faq.intro')}>
        <NextLinks
          links={[
            { to: '/glossary', label: t('learn.footer.glossary') },
            { to: '/how-it-works', label: t('learn.footer.how') },
          ]}
        />
      </DocHeader>

      <DocLayout contents={<Contents label={t('learn.faq.title')} items={list.map((item) => ({ id: item.id, label: item.q }))} />}>
        {/* Below 1024 px the questions are listed here, above the answers, instead of beside them. */}
        <nav aria-label={t('learn.faq.title')} className="mb-12 max-w-[70ch] lg:hidden">
          <ol className="divide-y divide-line border-y border-line">
            {list.map((item, i) => (
              <li key={item.id}>
                <a href={`#${item.id}`} className="flex items-baseline gap-3 py-2.5 text-label text-muted transition-colors duration-150 hover:text-text">
                  <span className="readout shrink-0 text-dim">{String(i + 1).padStart(2, '0')}</span>
                  {item.q}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-12">
          {list.map((item) => (
            <section key={item.id} id={item.id} aria-labelledby={`${item.id}-q`} className="prose">
              <h2 id={`${item.id}-q`} className="doc-heading">
                {item.q}
              </h2>
              {item.id === 'limits' && <Limits />}
              {(item.a ?? []).map((text) => (
                <p key={text}>{text}</p>
              ))}
              <NextLinks links={item.links} />
            </section>
          ))}
        </div>
      </DocLayout>
    </article>
  )
}
