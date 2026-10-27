import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { createToken, curlExample, listTokens, NAME_MAX, revokeToken, SCOPES, tokenFormProblem } from '../lib/api-tokens.js'

/**
 * `/settings/tokens` (W12.20): the signed-in person's personal API tokens.
 * Self-contained on purpose, so the settings page (W12.15) can link to it or
 * hold it as a section without either knowing the other's insides.
 *
 * A new token's secret is shown once, here, and kept nowhere: not in state
 * after the page is left, not in storage. The list never has it.
 */
export default function Tokens() {
  const { t, i18n } = useTranslation()
  usePageMeta(t('platform.tokens.title'), t('platform.tokens.intro'))
  const { account } = useAuth()
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [made, setMade] = useState(null)

  const load = () =>
    listTokens()
      .then((d) => {
        setData(d)
        setFailed(false)
      })
      .catch(() => setFailed(true))

  useEffect(() => {
    if (account) load()
  }, [account])

  if (account === undefined) return <BrandLoader className="py-16" />
  if (account === null) return <Navigate to="/login" replace state={{ from: '/settings/tokens' }} />

  const when = (iso) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : t('platform.tokens.never'))

  return (
    <div className="rise space-y-8">
      <header className="space-y-2">
        <p className="label text-accent">{t('platform.tokens.eyebrow')}</p>
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('platform.tokens.title')}</h1>
        <p className="max-w-[64ch] text-muted">{t('platform.tokens.intro')}</p>
        <Link to="/developers" className="inline-block text-label text-accent hover:underline">
          {t('platform.tokens.docs')} →
        </Link>
      </header>

      {made && <Secret made={made} onDone={() => setMade(null)} />}

      <NewToken
        full={data ? data.tokens.length >= data.max : false}
        onMade={(token) => {
          setMade(token)
          load()
        }}
      />

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="label">{t('platform.tokens.yours')}</h2>
          {data && <span className="readout text-caption text-dim">{t('platform.tokens.count', { count: data.tokens.length, max: data.max })}</span>}
        </div>
        {failed && (
          <p role="alert" className="text-label text-red">
            {t('platform.tokens.loadFailed')}
          </p>
        )}
        {!data && !failed && <BrandLoader className="py-6" />}
        {data && data.tokens.length === 0 && (
          <p className="rounded-panel border border-dashed border-line-strong px-5 py-8 text-center text-label text-muted">{t('platform.tokens.none')}</p>
        )}
        {data && data.tokens.length > 0 && (
          <ul className="divide-y divide-line rounded-panel border border-line">
            {data.tokens.map((token) => (
              <TokenRow key={token.id} token={token} when={when} onRevoked={load} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Secret({ made, onDone }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(made.token)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <section role="status" className="space-y-3 rounded-panel border border-accent/50 bg-accent/5 p-4 sm:p-5">
      <h2 className="font-display text-[17px] font-semibold">{t('platform.tokens.madeTitle', { name: made.name })}</h2>
      <p className="text-label text-text">{t('platform.tokens.madeOnce')}</p>
      <code className="readout block break-all rounded-control border border-line-strong bg-surface-2 px-3 py-2 text-label select-all">{made.token}</code>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={copy}>
          {copied === 'ok' ? t('platform.tokens.copied') : copied === 'failed' ? t('platform.tokens.copyFailed') : t('platform.tokens.copy')}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          {t('platform.tokens.done')}
        </button>
      </div>
      <p className="text-caption text-dim">{t('platform.tokens.tryIt')}</p>
      <code className="readout block overflow-x-auto whitespace-pre rounded-control bg-surface-3 px-3 py-2 text-caption">
        {curlExample(window.location.origin)}
      </code>
    </section>
  )
}

function NewToken({ full, onMade }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState(['read:analyses', 'read:timings'])
  const [state, setState] = useState({ kind: 'idle' })

  async function submit(event) {
    event.preventDefault()
    const problem = tokenFormProblem(name, scopes)
    if (problem) return setState({ kind: 'error', message: t(`platform.tokens.problems.${problem}`, { max: NAME_MAX }) })
    setState({ kind: 'busy' })
    try {
      const made = await createToken(name.trim(), scopes)
      setName('')
      setState({ kind: 'idle' })
      onMade(made)
    } catch (error) {
      setState({ kind: 'error', message: error.code === 'TOKEN_LIMIT' ? t('platform.tokens.problems.limit') : t('platform.tokens.problems.failed') })
    }
  }

  const toggle = (scope) => setScopes((list) => (list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope]))

  return (
    <form onSubmit={submit} className="panel space-y-4 p-5 sm:p-6">
      <h2 className="label">{t('platform.tokens.newTitle')}</h2>
      <label className="block space-y-1.5">
        <span className="text-label">{t('platform.tokens.name')}</span>
        <input
          type="text"
          value={name}
          maxLength={NAME_MAX * 2}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('platform.tokens.namePlaceholder')}
          className="field w-full"
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-label">{t('platform.tokens.scopes')}</legend>
        {SCOPES.map((scope) => (
          <label key={scope} className="flex cursor-pointer items-start gap-3 rounded-control border border-line bg-surface-2 px-3 py-2.5">
            <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} className="mt-0.5 accent-[var(--accent)]" />
            <span className="space-y-0.5">
              <span className="readout block text-label">{scope}</span>
              <span className="block text-caption text-dim">{t(`platform.tokens.scope.${scope.replace(':', '_')}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <button type="submit" className="btn-primary" disabled={full || state.kind === 'busy'}>
        {state.kind === 'busy' ? t('platform.tokens.making') : t('platform.tokens.make')}
      </button>
      {full && <p className="text-caption text-dim">{t('platform.tokens.problems.limit')}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="text-label text-red">
          {state.message}
        </p>
      )}
      <p className="text-caption leading-relaxed text-dim">{t('platform.tokens.note')}</p>
    </form>
  )
}

function TokenRow({ token, when, onRevoked }) {
  const { t } = useTranslation()
  const [state, setState] = useState('idle') // idle | confirm | busy | failed
  async function revoke() {
    setState('busy')
    try {
      await revokeToken(token.id)
      onRevoked()
    } catch {
      setState('failed')
    }
  }
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="truncate text-label font-semibold">{token.name}</p>
        <p className="flex flex-wrap gap-1.5">
          {token.scopes.map((scope) => (
            <span key={scope} className="chip-accent readout">
              {scope}
            </span>
          ))}
        </p>
        <p className="text-caption text-dim">
          {t('platform.tokens.created', { when: when(token.createdAt) })} · {t('platform.tokens.lastUsed', { when: when(token.lastUsedAt) })}
        </p>
        {state === 'failed' && (
          <p role="alert" className="text-caption text-red">
            {t('platform.tokens.revokeFailed')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {state === 'confirm' ? (
          <>
            <button type="button" className="btn-primary" onClick={revoke}>
              {t('platform.tokens.revokeConfirm')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setState('idle')}>
              {t('platform.tokens.keep')}
            </button>
          </>
        ) : (
          <button type="button" className="btn-ghost" disabled={state === 'busy'} onClick={() => setState('confirm')}>
            {t('platform.tokens.revoke')}
          </button>
        )}
      </div>
    </li>
  )
}
