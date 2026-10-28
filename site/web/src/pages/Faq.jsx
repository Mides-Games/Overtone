import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'

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
      <p className="text-label text-amber">
        {t('learn.faq.limits.unreachable')}{' '}
        <Link to="/status" className="text-accent hover:underline">
          {t('legal.footer.status')} →
        </Link>
      </p>
    )
  }
  return (
    <ul className="list-disc space-y-1.5 pl-5 leading-relaxed text-muted marker:text-dim">
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
    <article className="rise mx-auto max-w-[72ch] space-y-8">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('learn.faq.title')}</h1>
        <p className="text-body leading-relaxed text-muted">
          {t('learn.faq.intro')}{' '}
          <Link to="/glossary" className="text-accent hover:underline">
            {t('learn.footer.glossary')}
          </Link>
          {' · '}
          <Link to="/how-it-works" className="text-accent hover:underline">
            {t('learn.footer.how')}
          </Link>
        </p>
      </header>

      <nav aria-label={t('learn.faq.title')}>
        <ul className="space-y-1.5 text-label">
          {list.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`} className="text-muted hover:text-text hover:underline">
                {item.q}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {list.map((item) => (
        <section key={item.id} id={item.id} className="scroll-mt-36 space-y-3 border-t border-line pt-6">
          <h2 className="font-display text-title font-bold">{item.q}</h2>
          {item.id === 'limits' && <Limits />}
          {(item.a ?? []).map((text) => (
            <p key={text} className="leading-relaxed text-muted">
              {text}
            </p>
          ))}
          {item.links && (
            <p className="flex flex-wrap gap-4 text-label">
              {item.links.map((link) => (
                <Link key={link.to} to={link.to} className="text-accent hover:underline">
                  {link.label} →
                </Link>
              ))}
            </p>
          )}
        </section>
      ))}
    </article>
  )
}
