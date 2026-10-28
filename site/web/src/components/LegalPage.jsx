import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'
import { Contents, DocHeader, DocLayout, NextLinks } from './ui/Doc.jsx'

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
      <mark key={i} className="rounded-[4px] border border-amber/50 bg-amber/10 px-1.5 py-0.5 text-amber [box-decoration-break:clone]">
        <span className="label mr-1.5 text-amber">{t('legal.toBeSet')}:</span>
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/**
 * A heading's anchor: lower-case words joined by hyphens, Latin accents
 * dropped, any other script kept as it is (a Cyrillic or Japanese heading
 * used to come out empty, so every section of the Russian page shared one
 * id). An anchor already taken, or none at all, falls back to the section's
 * number, so the ids stay unique.
 */
const slug = (text) =>
  String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')

export function anchors(headings) {
  const seen = new Set()
  return headings.map((h, i) => {
    let id = slug(h) || `section-${i + 1}`
    if (seen.has(id)) id = `${id}-${i + 1}`
    seen.add(id)
    return id
  })
}

export default function LegalPage({ page, draft = true, children }) {
  const { t, i18n } = useTranslation()
  usePageMeta(t(`legal.${page}.title`), t(`legal.${page}.description`))
  const sections = t(`legal.${page}.sections`, { returnObjects: true })
  const list = Array.isArray(sections) ? sections : []
  const ids = anchors(list.map((section) => section.h))

  // The page's whole width (owner's call, 2026-10-27: the 72ch column read as
  // cramped): the layout takes the row, the text keeps a reading measure
  // (.prose, about 70ch) and on wide screens the contents list stays beside it.
  return (
    <article className="rise">
      <DocHeader eyebrow={t('legal.footer.title')} title={t(`legal.${page}.title`)} lede={t(`legal.${page}.intro`)}>
        <p className="readout text-caption text-dim">{t('legal.updated', { date: t('legal.date') })}</p>
        {/* W12.16: any language but English says the English text is the one that binds. */}
        {!i18n.language?.startsWith('en') && (
          <p className="callout">
            {t('legal.translationNote')}{' '}
            <button type="button" className="link font-medium" onClick={() => i18n.changeLanguage('en')} lang="en">
              English
            </button>
          </p>
        )}
        {draft && <p className="callout callout-amber text-text">{t('legal.draft')}</p>}
      </DocHeader>

      <DocLayout
        contents={list.length > 1 && <Contents label={t('legal.contents')} items={list.map((section, i) => ({ id: ids[i], label: section.h }))} />}
      >
        {children}

        <div className="space-y-12">
          {list.map((section, i) => (
            <section key={ids[i]} id={ids[i]} aria-labelledby={`${ids[i]}-h`} className="prose">
              <h2 id={`${ids[i]}-h`} className="doc-heading">
                {section.h}
              </h2>
              {section.p?.map((text) => (
                <p key={text}>
                  <Text>{text}</Text>
                </p>
              ))}
              {section.li && (
                <ul>
                  {section.li.map((text) => (
                    <li key={text}>
                      <Text>{text}</Text>
                    </li>
                  ))}
                </ul>
              )}
              {section.after?.map((text) => (
                <p key={text}>
                  <Text>{text}</Text>
                </p>
              ))}
              <NextLinks links={section.links} />
            </section>
          ))}
        </div>
      </DocLayout>
    </article>
  )
}
