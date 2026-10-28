import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import reference from 'virtual:openapi'

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
const METHOD_TONE = {
  GET: 'text-accent',
  POST: 'text-tempo',
  DELETE: 'text-red',
  PUT: 'text-amber',
  PATCH: 'text-amber',
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
    <div className="rise space-y-10">
      <header className="space-y-3">
        <p className="label text-accent">{t('platform.developers.eyebrow')}</p>
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('platform.developers.title')}</h1>
        <p className="max-w-[68ch] text-muted">{t('platform.developers.intro')}</p>
      </header>

      <section className="panel space-y-4 p-5 sm:p-6">
        <h2 className="label">{t('platform.developers.startTitle')}</h2>
        <ol className="list-decimal space-y-2 pl-5 text-label text-text marker:text-dim">
          <li>
            {t('platform.developers.step1')}{' '}
            {/* Underlined: it sits inside the step's sentence (WCAG 1.4.1, index.css). */}
            <Link to="/settings/tokens" className="text-accent underline underline-offset-2">
              {t('platform.developers.tokensLink')} →
            </Link>
          </li>
          <li>{t('platform.developers.step2')}</li>
          <li>{t('platform.developers.step3')}</li>
        </ol>
        <code className="readout block overflow-x-auto whitespace-pre rounded-control bg-surface-3 px-3 py-2 text-caption">{curlExample(origin)}</code>
        <ul className="space-y-1.5 text-caption leading-relaxed text-dim">
          <li>{t('platform.developers.ruleScopes')}</li>
          <li>{t('platform.developers.ruleLimit')}</li>
          <li>{t('platform.developers.ruleBrowser')}</li>
          <li>{t('platform.developers.ruleAudio')}</li>
        </ul>
      </section>

      {/* W13.22: the clients kept in the repository, so a script need not start from curl. */}
      <section className="panel space-y-4 p-5 sm:p-6">
        <div className="space-y-1">
          <h2 className="label">{t('platform.developers.clientsTitle')}</h2>
          <p className="max-w-[68ch] text-label text-muted">{t('platform.developers.clientsIntro')}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {CLIENTS.map((client) => (
            <div key={client.key} className="min-w-0 space-y-2">
              <p className="text-label text-text">{t(`platform.developers.${client.key}`)}</p>
              <code className="readout block overflow-x-auto whitespace-pre rounded-control bg-surface-3 px-3 py-2 text-caption">{client.snippet}</code>
            </div>
          ))}
        </div>
        <p className="text-caption text-dim">{t('platform.developers.clientsBot')}</p>
        <a href={CLIENTS_URL} target="_blank" rel="noopener" className="inline-block text-label text-accent underline underline-offset-2">
          {t('platform.developers.clientsLink')} ↗
        </a>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 className="font-display text-title font-bold">
              {reference.title} <span className="readout text-label text-dim">{reference.version}</span>
            </h2>
            <p className="text-caption text-dim">
              {t('platform.developers.base')} <code className="readout">{reference.server}</code> · {t('platform.developers.englishNote')}
            </p>
          </div>
          <div className="flex gap-1.5" role="group" aria-label={t('platform.developers.filter')}>
            {['all', 'token'].map((key) => (
              <button key={key} type="button" className="tool-btn px-2.5" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {t(`platform.developers.show.${key}`)}
              </button>
            ))}
          </div>
        </div>

        <details className="panel p-4">
          <summary className="cursor-pointer text-label font-semibold">{t('platform.developers.overview')}</summary>
          <Prose text={reference.description} className="mt-3" />
        </details>

        {groups.map((group) => (
          <section key={group.name} className="space-y-2">
            <h3 className="label">{group.name}</h3>
            <ul className="space-y-2">
              {group.operations.map((op) => (
                <Operation key={op.id} op={op} />
              ))}
            </ul>
          </section>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-title font-bold">{t('platform.developers.schemas')}</h2>
        <ul className="space-y-2">
          {reference.schemas.map((schema) => (
            <li key={schema.name} id={`schema-${schema.name}`}>
              <details className="panel p-4">
                <summary className="cursor-pointer">
                  <span className="readout text-label font-semibold">{schema.name}</span>
                  {schema.description && <span className="ml-2 text-caption text-dim">{schema.description}</span>}
                </summary>
                {schema.fields?.length ? <Fields fields={schema.fields} /> : <p className="readout mt-2 text-caption text-dim">{schema.type}</p>}
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
      <details className="rounded-panel border border-line bg-surface">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <span className={`readout w-14 shrink-0 text-label font-bold ${METHOD_TONE[op.method] ?? ''}`}>{op.method}</span>
          <code className="readout min-w-0 break-all text-label text-text">{op.path}</code>
          <span className="min-w-0 flex-1 text-caption text-muted">
            <Inline text={op.summary} />
          </span>
          {op.tokenScope && (
            <span className="chip-accent readout" title={t('platform.developers.tokenHint')}>
              {op.tokenScope === 'any' ? t('platform.developers.anyToken') : op.tokenScope}
            </span>
          )}
        </summary>
        <div className="space-y-4 border-t border-line px-4 py-3">
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
        <code key={i} className="readout rounded bg-surface-3 px-1 text-text">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    )
}
