import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'

/**
 * One legal page (W4.5-W4.7): the title, the draft note, the date, and the
 * sections of `legal.<page>` in the locale files. A section is
 * `{ h, p?, li?, after?, links? }`: its heading, paragraphs, a list,
 * paragraphs after the list and links to the other pages.
 *
 * `[[...]]` in a string is something the owner still has to decide (an
 * address, a jurisdiction, a contact). It is drawn as an amber box that says
 * so, never as text that reads as settled.
 */
function Text({ children }) {
  const { t } = useTranslation()
  const parts = String(children).split(/\[\[(.+?)\]\]/)
  return parts.map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-[4px] border border-amber/50 bg-amber/10 px-1.5 py-0.5 text-amber">
        <span className="label mr-1.5 text-amber">{t('legal.toBeSet')}:</span>
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/** A heading's anchor: lower-case words joined by hyphens, accents dropped. */
const anchor = (text) =>
  String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export default function LegalPage({ page, draft = true, children }) {
  const { t } = useTranslation()
  usePageMeta(t(`legal.${page}.title`), t(`legal.${page}.description`))
  const sections = t(`legal.${page}.sections`, { returnObjects: true })
  const list = Array.isArray(sections) ? sections : []

  // The page's whole width (owner's call, 2026-10-27: the 72ch column read as
  // cramped): the text takes it, and on wide screens a contents list stays
  // beside it, so the lines do not run on for the full row.
  return (
    <article className="rise space-y-8">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t(`legal.${page}.title`)}</h1>
        <p className="readout text-caption text-dim">{t('legal.updated', { date: t('legal.date') })}</p>
        {draft && (
          <p className="rounded-control border border-amber/40 bg-amber/10 px-3 py-2 text-label leading-relaxed text-amber">{t('legal.draft')}</p>
        )}
        <p className="text-body leading-relaxed text-muted">{t(`legal.${page}.intro`)}</p>
      </header>

      <div className="gap-10 lg:grid lg:grid-cols-[minmax(12rem,15rem)_1fr]">
        {list.length > 1 && (
          <nav aria-label={t('legal.contents')} className="hidden lg:block">
            <div className="sticky top-28 space-y-2">
              <p className="label">{t('legal.contents')}</p>
              <ol className="space-y-1.5 border-l border-line pl-3 text-label">
                {list.map((section) => (
                  <li key={section.h}>
                    <a href={`#${anchor(section.h)}`} className="text-muted transition hover:text-accent">
                      {section.h}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </nav>
        )}

        <div className="min-w-0 space-y-8 lg:col-start-2">
          {children}

          {list.map((section) => (
            <section key={section.h} id={anchor(section.h)} className="scroll-mt-28 space-y-3">
              <h2 className="font-display text-title font-bold">{section.h}</h2>
              {section.p?.map((text) => (
                <p key={text} className="leading-relaxed text-muted">
                  <Text>{text}</Text>
                </p>
              ))}
              {section.li && (
                <ul className="list-disc space-y-1.5 pl-5 leading-relaxed text-muted marker:text-dim">
                  {section.li.map((text) => (
                    <li key={text}>
                      <Text>{text}</Text>
                    </li>
                  ))}
                </ul>
              )}
              {section.after?.map((text) => (
                <p key={text} className="leading-relaxed text-muted">
                  <Text>{text}</Text>
                </p>
              ))}
              {section.links && (
                <p className="flex flex-wrap gap-4 text-label">
                  {section.links.map((link) => (
                    <Link key={link.to} to={link.to} className="text-accent hover:underline">
                      {link.label} →
                    </Link>
                  ))}
                </p>
              )}
            </section>
          ))}
        </div>
      </div>
    </article>
  )
}
