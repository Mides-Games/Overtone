import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate } from 'react-router'

import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import SectionHeader from '../components/ui/SectionHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { createToken, curlExample, listTokens, NAME_MAX, revokeToken, SCOPES, tokenFormProblem } from '../lib/api-tokens.js'

/**
 * `/settings/tokens` (W12.20): the signed-in person's personal API tokens, a
 * sub-page of `/settings` (W12.15), whose "API tokens" section leads here.
 * Apart because tokens belong to an account and need a sign-in, while the
 * rest of the settings are this browser's.
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

  if (account === undefined) return <SkeletonRows rows={3} label={t('common.loading')} className="border-y border-line" />
  if (account === null) return <Navigate to="/login" replace state={{ from: '/settings/tokens' }} />

  const when = (iso) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : t('platform.tokens.never'))

  return (
    <div className="space-y-12">
      <PageHeader
        back={{ to: '/settings', label: t('platform.tokens.eyebrow') }}
        title={t('platform.tokens.title')}
        lede={t('platform.tokens.intro')}
        action={
          <Link to="/developers" className="btn-quiet -mr-2.5">
            <Icon name="code" size={16} />
            {t('platform.tokens.docs')}
            <Icon name="arrow-right" size={16} />
          </Link>
        }
      />

      {made && <Secret made={made} onDone={() => setMade(null)} />}

      <div className="grid gap-x-12 gap-y-12 lg:grid-cols-12">
        <NewToken
          className="lg:col-span-5"
          full={data ? data.tokens.length >= data.max : false}
          onMade={(token) => {
            setMade(token)
            load()
          }}
        />

        <section aria-labelledby="tokens-yours" className="min-w-0 space-y-5 lg:col-span-7">
          <SectionHeader
            id="tokens-yours"
            title={t('platform.tokens.yours')}
            action={data && <span className="readout text-label text-muted">{t('platform.tokens.count', { count: data.tokens.length, max: data.max })}</span>}
          />
          {failed && (
            <p role="alert" className="text-label text-red">
              {t('platform.tokens.loadFailed')}
            </p>
          )}
          {!data && !failed && <SkeletonRows rows={2} label={t('common.loading')} className="border-y border-line" />}
          {data && data.tokens.length === 0 && <EmptyState title={t('platform.tokens.none')} className="border-y border-line" />}
          {data && data.tokens.length > 0 && (
            <ul className="divide-y divide-line border-y border-line">
              {data.tokens.map((token) => (
                <TokenRow key={token.id} token={token} when={when} onRevoked={load} />
              ))}
            </ul>
          )}
        </section>
      </div>
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
    <section role="status" className="pop-in space-y-4 rounded-panel border border-accent/50 bg-accent/5 p-5 sm:p-6" style={{ '--origin': 'top center' }}>
      <h2 className="heading-title flex items-center gap-2">
        <Icon name="key" size={18} className="text-accent" />
        {t('platform.tokens.madeTitle', { name: made.name })}
      </h2>
      <p className="text-body text-text">{t('platform.tokens.madeOnce')}</p>
      <code className="readout block select-all break-all rounded-control border border-line-strong bg-surface-3 px-3 py-2.5 text-label text-text">{made.token}</code>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={copy}>
          <Icon name={copied === 'ok' ? 'check' : 'copy'} size={16} />
          {copied === 'ok' ? t('platform.tokens.copied') : copied === 'failed' ? t('platform.tokens.copyFailed') : t('platform.tokens.copy')}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          {t('platform.tokens.done')}
        </button>
      </div>
      <p className="text-caption text-muted">{t('platform.tokens.tryIt')}</p>
      <code tabIndex={0} className="readout block overflow-x-auto whitespace-pre rounded-control bg-surface-3 px-3 py-2.5 text-caption text-text">
        {curlExample(window.location.origin)}
      </code>
    </section>
  )
}

function NewToken({ full, onMade, className = '' }) {
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
  const invalid = state.kind === 'error'

  return (
    <form onSubmit={submit} aria-labelledby="tokens-new" className={`panel h-fit space-y-5 p-5 sm:p-6 ${className}`} noValidate>
      <h2 id="tokens-new" className="heading-title">
        {t('platform.tokens.newTitle')}
      </h2>
      <label className="block space-y-1.5">
        <span className="label block">{t('platform.tokens.name')}</span>
        <input
          type="text"
          value={name}
          maxLength={NAME_MAX * 2}
          onChange={(e) => {
            setName(e.target.value)
            if (invalid) setState({ kind: 'idle' })
          }}
          placeholder={t('platform.tokens.namePlaceholder')}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'tokens-error' : undefined}
          className="field w-full"
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="label mb-2">{t('platform.tokens.scopes')}</legend>
        {SCOPES.map((scope) => (
          <label
            key={scope}
            className="flex cursor-pointer items-start gap-3 rounded-control border border-line px-3 py-2.5 transition-colors duration-150 ease-out hover:border-line-hover has-checked:border-accent/50 has-checked:bg-accent/5"
          >
            <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
            <span className="space-y-0.5">
              <span className="readout block text-label text-text">{scope}</span>
              <span className="block text-caption text-muted">{t(`platform.tokens.scope.${scope.replace(':', '_')}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <button type="submit" className="btn-primary" disabled={full || state.kind === 'busy'}>
        <Icon name="plus" size={16} />
        {state.kind === 'busy' ? t('platform.tokens.making') : t('platform.tokens.make')}
      </button>
      {full && <p className="text-caption text-dim">{t('platform.tokens.problems.limit')}</p>}
      {invalid && (
        <p id="tokens-error" role="alert" className="text-label text-red">
          {state.message}
        </p>
      )}
      <p className="text-caption text-dim">{t('platform.tokens.note')}</p>
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
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <p className="flex items-center gap-2 text-body font-semibold text-text">
          <Icon name="key" size={16} className="text-dim" />
          <span className="truncate">{token.name}</span>
        </p>
        <p className="flex flex-wrap gap-1.5">
          {token.scopes.map((scope) => (
            <span key={scope} className="chip-accent normal-case">
              {scope}
            </span>
          ))}
        </p>
        <p className="readout text-caption text-dim">
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
            <button type="button" className="btn-ghost btn-sm border-red/50 text-red" onClick={revoke}>
              <Icon name="trash" size={14} />
              {t('platform.tokens.revokeConfirm')}
            </button>
            <button type="button" className="btn-quiet btn-sm" onClick={() => setState('idle')}>
              {t('platform.tokens.keep')}
            </button>
          </>
        ) : (
          <button type="button" className="btn-ghost btn-sm" disabled={state === 'busy'} onClick={() => setState('confirm')}>
            {t('platform.tokens.revoke')}
          </button>
        )}
      </div>
    </li>
  )
}
