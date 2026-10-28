import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import reference from 'virtual:openapi'

import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import SectionHeader from '../components/ui/SectionHeader.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { curlExample } from '../lib/api-tokens.js'
import { groupOperations, prose } from '../lib/openapi-view.js'

/**
 * `/developers` (W12.20): how to call the API with a personal token, then the
 * API's reference, rendered from site/api/docs/openapi.yaml at build time
 * (scripts/openapi.mjs). The reference is the document as written, in English,
 * as the changelog is; the page around it is translated.
 *
 * Every string from the document is rendered as text (code spans as <code>),
 * never as HTML.
 */
/**
 * The method's colour. Red, amber and the tempo green mean red lines, "check
 * by ear" and the tempo curve everywhere on the site (docs/design.md, section
 * 12), so they mark no method: a read is the accent, a write is plain text.
 */
const METHOD_TONE = {
  GET: 'text-accent',
  POST: 'text-text',
  DELETE: 'text-text',
  PUT: 'text-text',
  PATCH: 'text-text',
}

/** The community clients (W13.22): clients/js and clients/python in the repository. Code, so not translated. */
const CLIENTS_URL = 'https://github.com/Mides-Projects/Overtone/tree/master/clients'
const CLIENTS = [
  {
    key: 'clientsJs',
    snippet: [
      "import { Overtone } from './overtone.mjs'",
      'const overtone = new Overtone({ token: process.env.OVERTONE_TOKEN })',
      "const analysis = await overtone.analyzeFile('song.mp3')",
      'console.log(analysis.result.global_bpm)',
    ].join('\n'),
  },
  {
    key: 'clientsPython',
    snippet: [
      'from overtone_client import Overtone',
      'overtone = Overtone(os.environ["OVERTONE_TOKEN"])',
      'analysis = overtone.analyze_file("song.mp3")',
      'print(analysis["result"]["global_bpm"])',
    ].join('\n'),
  },
]

export default function Developers() {
  const { t } = useTranslation()
  usePageMeta(t('platform.developers.title'), t('platform.developers.intro'))
  const [filter, setFilter] = useState('all') // all | token
  const groups = useMemo(
    () => groupOperations(reference.operations.filter((op) => filter === 'all' || op.tokenScope)),
    [filter],
  )
  const origin = typeof window === 'undefined' ? 'https://overtone.midesprojects.com' : window.location.origin

  return (
    <div className="space-y-16">
      <PageHeader eyebrow={t('platform.developers.eyebrow')} title={t('platform.developers.title')} lede={t('platform.developers.intro')} />

      <section aria-labelledby="dev-start" className="grid gap-x-12 gap-y-8 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-5">
          <SectionHeader id="dev-start" title={t('platform.developers.startTitle')} />
          <ol className="space-y-4">
            {['step1', 'step2', 'step3'].map((key, i) => (
              <li key={key} className="flex gap-4 border-t border-line pt-4">
                <span className="readout w-6 shrink-0 text-title font-semibold text-accent">{i + 1}</span>
                <p className="text-body text-text">
                  {t(`platform.developers.${key}`)}
                  {key === 'step1' && (
                    <>
                      {' '}
                      {/* Underlined: it sits inside the step's sentence (WCAG 1.4.1, index.css). */}
                      <Link to="/settings/tokens" className="link inline-flex items-center gap-1">
                        {t('platform.developers.tokensLink')}
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ol>
        </div>
        <div className="min-w-0 space-y-6 lg:col-span-7">
          <div className="panel overflow-hidden">
            <p className="label border-b border-line px-4 py-2.5">curl</p>
            {/* In the tab order: a block that scrolls sideways must be reachable by keyboard (WCAG 2.1.1). */}
            <code tabIndex={0} className="readout block overflow-x-auto whitespace-pre px-4 py-3 text-label text-text">{curlExample(origin)}</code>
          </div>
          <ul className="space-y-3 text-label text-muted">
            {['ruleScopes', 'ruleLimit', 'ruleBrowser', 'ruleAudio'].map((key) => (
              <li key={key} className="flex gap-3">
                <Icon name="check" size={16} className="mt-0.5 text-accent" strokeWidth={2} />
                <span>{t(`platform.developers.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* W13.22: the clients kept in the repository, so a script need not start from curl. */}
      <section aria-labelledby="dev-clients" className="space-y-6 border-t border-line pt-12">
        <SectionHeader
          id="dev-clients"
          title={t('platform.developers.clientsTitle')}
          lede={t('platform.developers.clientsIntro')}
          action={
            <a href={CLIENTS_URL} target="_blank" rel="noopener" className="btn-quiet -mr-2.5">
              {t('platform.developers.clientsLink')}
              <Icon name="external" size={16} />
              <span className="sr-only">{t('common.newTab')}</span>
            </a>
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          {CLIENTS.map((client) => (
            <div key={client.key} className="panel min-w-0 overflow-hidden">
              <p className="label border-b border-line px-4 py-2.5">{t(`platform.developers.${client.key}`)}</p>
              <code tabIndex={0} className="readout block overflow-x-auto whitespace-pre px-4 py-3 text-caption text-text">{client.snippet}</code>
            </div>
          ))}
        </div>
        <p className="max-w-[72ch] text-label text-muted">{t('platform.developers.clientsBot')}</p>
      </section>

      <section aria-labelledby="dev-reference" className="space-y-8 border-t border-line pt-12">
        <SectionHeader
          id="dev-reference"
          eyebrow={reference.version}
          title={reference.title}
          lede={
            <>
              {t('platform.developers.base')} <code className="readout text-text">{reference.server}</code> · {t('platform.developers.englishNote')}
            </>
          }
          action={
            <div className="flex gap-1.5" role="group" aria-label={t('platform.developers.filter')}>
              {['all', 'token'].map((key) => (
                <button key={key} type="button" className="tool-btn px-3 font-sans" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {t(`platform.developers.show.${key}`)}
                </button>
              ))}
            </div>
          }
        />

        <details className="group border-y border-line">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-3.5 text-body font-semibold text-text [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" size={16} className="text-dim transition-transform duration-150 ease-out group-open:rotate-90" />
            {t('platform.developers.overview')}
          </summary>
          <Prose text={reference.description} className="max-w-[80ch] pb-5 pl-6" />
        </details>

        {groups.map((group) => (
          <section key={group.name} className="space-y-3">
            <h3 className="heading-title">{group.name}</h3>
            <ul className="divide-y divide-line border-y border-line">
              {group.operations.map((op) => (
                <Operation key={op.id} op={op} />
              ))}
            </ul>
          </section>
        ))}
      </section>

      <section aria-labelledby="dev-schemas" className="space-y-6 border-t border-line pt-12">
        <SectionHeader id="dev-schemas" title={t('platform.developers.schemas')} />
        <ul className="divide-y divide-line border-y border-line">
          {reference.schemas.map((schema) => (
            <li key={schema.name} id={`schema-${schema.name}`}>
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 py-3 [&::-webkit-details-marker]:hidden">
                  <Icon name="chevron-right" size={14} className="self-center text-dim transition-transform duration-150 ease-out group-open:rotate-90" />
                  <span className="readout text-label font-semibold text-text">{schema.name}</span>
                  {schema.description && <span className="min-w-0 flex-1 text-caption text-muted">{schema.description}</span>}
                </summary>
                <div className="pb-4 pl-6">
                  {schema.fields?.length ? <Fields fields={schema.fields} /> : <p className="readout text-caption text-dim">{schema.type}</p>}
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Operation({ op }) {
  const { t } = useTranslation()
  return (
    <li id={op.id}>
      <details className="group">
        <summary className="-mx-3 flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-control px-3 py-3 transition-colors duration-150 ease-out hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
          <span className={`readout w-14 shrink-0 text-label font-bold ${METHOD_TONE[op.method] ?? ''}`}>{op.method}</span>
          <code className="readout min-w-0 break-all text-label text-text">{op.path}</code>
          <span className="min-w-0 flex-1 basis-48 text-caption text-muted">
            <Inline text={op.summary} />
          </span>
          {op.tokenScope && (
            <span className="chip-accent normal-case" title={t('platform.developers.tokenHint')}>
              {op.tokenScope === 'any' ? t('platform.developers.anyToken') : op.tokenScope}
            </span>
          )}
          <Icon name="chevron-down" size={16} className="text-dim transition-transform duration-150 ease-out group-open:rotate-180" />
        </summary>
        <div className="panel-well mb-3 space-y-4 px-4 py-4">
          {op.description && <Prose text={op.description} />}
          {!op.tokenScope && <p className="text-caption text-dim">{t('platform.developers.browserOnly')}</p>}
          {op.params.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="label">{t('platform.developers.params')}</h4>
              <ul className="space-y-1 text-caption">
                {op.params.map((p) => (
                  <li key={`${p.in}-${p.name}`} className="flex flex-wrap gap-x-2">
                    <code className="readout text-text">{p.name}</code>
                    <span className="text-dim">
                      {p.in}
                      {p.required ? ` · ${t('platform.developers.required')}` : ''}
                    </span>
                    <code className="readout text-muted">{p.type}</code>
                    {p.description && (
                      <span className="w-full text-dim">
                        <Inline text={p.description} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {op.body && (
            <div className="space-y-1.5">
              <h4 className="label">
                {t('platform.developers.body')} <span className="readout normal-case text-dim">{op.body.type}</span>
              </h4>
              {op.body.fields ? <Fields fields={op.body.fields} /> : <code className="readout text-caption text-muted">{op.body.schema}</code>}
            </div>
          )}
          <div className="space-y-1.5">
            <h4 className="label">{t('platform.developers.responses')}</h4>
            <ul className="space-y-1 text-caption">
              {op.responses.map((r) => (
                <li key={r.status} className="flex flex-wrap gap-x-2">
                  <code className={`readout font-semibold ${r.status.startsWith('2') ? 'text-accent' : 'text-muted'}`}>{r.status}</code>
                  {r.schema && <code className="readout text-dim">{r.schema}</code>}
                  {r.description && (
                    <span className="text-text">
                      <Inline text={r.description} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </li>
  )
}

function Fields({ fields }) {
  const { t } = useTranslation()
  return (
    <ul className="mt-2 space-y-1 text-caption">
      {fields.map((f) => (
        <li key={f.name} className="flex flex-wrap gap-x-2">
          <code className="readout text-text">{f.name}</code>
          {f.required && <span className="text-dim">{t('platform.developers.required')}</span>}
          <code className="readout text-muted">{f.type}</code>
          {f.description && (
            <span className="w-full text-dim">
              <Inline text={f.description} />
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Paragraphs of the document's own text: blank lines split them, `code` spans become <code>. */
function Prose({ text, className = '' }) {
  return (
    <div className={`space-y-2 text-label leading-relaxed text-muted ${className}`}>
      {prose(text).map((paragraph, i) => (
        <p key={i}>
          <Inline text={paragraph} />
        </p>
      ))}
    </div>
  )
}

function Inline({ text }) {
  return String(text ?? '')
    .split(/(`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
        <code key={i} className="readout rounded border border-line px-1 text-text">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    )
}
