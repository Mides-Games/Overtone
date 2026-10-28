import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ACCENT_NAMES, ACCENTS } from '../../lib/accents.js'
import { LINK_KINDS, move, PROFILE_LIMITS, updateProfile, userTimings } from '../../lib/social.js'
import { songLine } from '../../lib/timings.js'
import Icon from '../ui/Icon.jsx'
import SectionHeader from '../ui/SectionHeader.jsx'
import { SkeletonRows } from '../ui/Skeleton.jsx'

/**
 * The owner's edit of their profile (2026-10-28): a shown name over Mides'
 * one, an About text, four links, an accent, and the pinned timings. The
 * photo, banner and username are Mides', refreshed at each sign-in: the form
 * says so and links to Mides' settings, the one place they change.
 *
 * The API decides (site/api utils/profile.js); the caps here only let the
 * form say so first. A link the API refuses names its kind, so the message
 * says which field to fix.
 */
export default function ProfileEditor({ edit, username, onSaved }) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState(edit.displayName ?? '')
  const [about, setAbout] = useState(edit.about ?? '')
  const [links, setLinks] = useState(() => Object.fromEntries(LINK_KINDS.map((kind) => [kind, edit.links?.[kind] ?? ''])))
  const [accent, setAccent] = useState(edit.accent ?? null)
  const [state, setState] = useState(null)

  async function save(event) {
    event.preventDefault()
    setState({ busy: true })
    try {
      const saved = await updateProfile({ displayName, about, links, accent })
      setLinks(Object.fromEntries(LINK_KINDS.map((kind) => [kind, saved.links?.[kind] ?? ''])))
      setState({ saved: true })
      onSaved(saved)
    } catch (error) {
      const kind = error.details?.kind
      setState({
        error:
          error.code === 'BAD_LINK' && kind
            ? t('social.profile.editor.badLink', { site: t(`social.profile.links.${kind}`) })
            : t('social.profile.editor.failed', { message: error.message }),
      })
    }
  }

  return (
    <div className="space-y-12">
      <form onSubmit={save} className="space-y-8" aria-labelledby="profile-edit-title">
        <SectionHeader id="profile-edit-title" title={t('social.profile.editor.title')} lede={t('social.profile.editor.intro')} />

        <div className="flex items-start gap-3 rounded-control border border-line p-4">
          <Icon name="user" size={18} className="mt-0.5 shrink-0 text-dim" />
          <p className="text-caption text-muted">
            {t('social.profile.editor.photoNote')}{' '}
            {edit.midesSettingsUrl && (
              <a href={edit.midesSettingsUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
                {t('social.profile.editor.photoLink')}
                <Icon name="external" size={13} />
                <span className="sr-only">{t('common.newTab')}</span>
              </a>
            )}
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="label block">{t('social.profile.editor.displayName')}</span>
            <input
              type="text"
              className="field"
              value={displayName}
              maxLength={PROFILE_LIMITS.displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={edit.midesDisplayName ?? username}
              autoComplete="nickname"
            />
            <span className="block text-caption text-dim">
              {t('social.profile.editor.displayNameHint', { name: edit.midesDisplayName ?? username })}
            </span>
          </label>

          <label className="block space-y-1.5 lg:row-span-2">
            <span className="label block">{t('social.profile.editor.about')}</span>
            <textarea
              className="field min-h-36"
              value={about}
              maxLength={PROFILE_LIMITS.about}
              onChange={(e) => setAbout(e.target.value)}
              rows={6}
            />
            <span className="readout block text-caption text-dim">
              {t('social.profile.editor.aboutHint', { max: PROFILE_LIMITS.about })} · {[...about].length}/{PROFILE_LIMITS.about}
            </span>
          </label>
        </div>

        <fieldset className="space-y-3">
          <legend className="label mb-2">{t('social.profile.links.title')}</legend>
          <p className="text-caption text-dim">{t('social.profile.editor.linksHint')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {LINK_KINDS.map((kind) => (
              <label key={kind} className="block space-y-1.5">
                <span className="text-label text-muted">{t(`social.profile.links.${kind}`)}</span>
                {/* Text, not type="url": the browser's own check would refuse "osu.ppy.sh/u/name", which the API reads as https. */}
                <input
                  type="text"
                  inputMode="url"
                  className="field"
                  value={links[kind]}
                  maxLength={200}
                  onChange={(e) => setLinks((old) => ({ ...old, [kind]: e.target.value }))}
                  placeholder={t(`social.profile.editor.placeholders.${kind}`)}
                  autoComplete="url"
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="label mb-2">{t('social.profile.editor.accent')}</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('social.profile.editor.accent')}>
            {[null, ...ACCENT_NAMES].map((name) => {
              const on = accent === name
              return (
                <button
                  key={name ?? 'default'}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setAccent(name)}
                  className={`btn-ghost btn-sm ${on ? 'border-text' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-3.5 w-3.5 rounded-full border border-line-strong"
                    style={{ background: name ? `linear-gradient(135deg, ${ACCENTS[name].light.accent} 50%, ${ACCENTS[name].dark.accent} 50%)` : 'var(--accent)' }}
                  />
                  {t(`social.profile.editor.accents.${name ?? 'default'}`)}
                  {on && <Icon name="check" size={13} />}
                </button>
              )
            })}
          </div>
          <p className="text-caption text-dim">{t('social.profile.editor.accentHint')}</p>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={state?.busy}>
            {state?.busy ? t('common.loading') : t('social.profile.editor.save')}
          </button>
          <span aria-live="polite" className="text-caption text-muted">
            {state?.saved ? t('social.profile.editor.saved') : ''}
          </span>
          {state?.error && (
            <span role="alert" className="text-caption text-red">
              {state.error}
            </span>
          )}
        </div>
      </form>

      <ShowcaseEditor ids={edit.showcase} username={username} onSaved={onSaved} />
    </div>
  )
}

/** Pin up to six of one's own published timings, and put them in order. Each change is saved at once. */
function ShowcaseEditor({ ids, username, onSaved }) {
  const { t } = useTranslation()
  const [pinned, setPinned] = useState(ids)
  const [mine, setMine] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    userTimings(username, { sort: 'new' }, { limit: 50 })
      .then((data) => alive && setMine(data.timings))
      .catch(() => alive && setError(t('social.failed')))
    return () => {
      alive = false
    }
  }, [username, t])

  async function change(next) {
    setError(null)
    const before = pinned
    setPinned(next)
    try {
      const saved = await updateProfile({ showcase: next })
      setPinned(saved.showcase)
      onSaved(saved)
    } catch (failure) {
      setPinned(before)
      setError(t('social.profile.editor.failed', { message: failure.message }))
    }
  }

  const byId = new Map((mine ?? []).map((timing) => [timing.id, timing]))
  const label = (id) => {
    const timing = byId.get(id)
    return timing ? songLine(timing) || id : id
  }
  const full = pinned.length >= PROFILE_LIMITS.showcase

  return (
    <section aria-labelledby="profile-showcase-edit" className="space-y-5">
      <SectionHeader
        id="profile-showcase-edit"
        title={t('social.profile.showcaseEditor.title')}
        lede={t('social.profile.showcaseEditor.hint', { max: PROFILE_LIMITS.showcase })}
      />
      {pinned.length > 0 && (
        <ol className="divide-y divide-line border-y border-line">
          {pinned.map((id, i) => (
            <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="flex min-w-0 items-center gap-3">
                <span className="readout w-5 shrink-0 text-caption text-dim">{i + 1}</span>
                <span className="min-w-0 break-words text-label font-medium text-text">{label(id)}</span>
              </span>
              <span className="flex gap-1.5">
                <button type="button" className="btn-quiet btn-sm" onClick={() => change(move(pinned, i, -1))} disabled={i === 0}>
                  <Icon name="chevron-up" size={15} />
                  <span className="sr-only">{t('social.profile.showcaseEditor.up')}</span>
                </button>
                <button type="button" className="btn-quiet btn-sm" onClick={() => change(move(pinned, i, 1))} disabled={i === pinned.length - 1}>
                  <Icon name="chevron-down" size={15} />
                  <span className="sr-only">{t('social.profile.showcaseEditor.down')}</span>
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => change(pinned.filter((x) => x !== id))}>
                  {t('social.profile.showcaseEditor.unpin')}
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {mine === null ? (
        !error && <SkeletonRows rows={2} label={t('common.loading')} className="border-y border-line" />
      ) : mine.length === 0 ? (
        <p className="text-label text-dim">{t('social.profile.showcaseEditor.none')}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {mine
            .filter((timing) => !pinned.includes(timing.id))
            .map((timing) => (
              <li key={timing.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 break-words text-label text-muted">{songLine(timing) || timing.id}</span>
                <button type="button" className="btn-ghost btn-sm" onClick={() => change([...pinned, timing.id])} disabled={full}>
                  <Icon name="plus" size={14} />
                  {t('social.profile.showcaseEditor.pin')}
                </button>
              </li>
            ))}
        </ul>
      )}
      {full && <p className="text-caption text-dim">{t('social.profile.showcaseEditor.full')}</p>}
      {error && (
        <p role="alert" className="text-caption text-red">
          {error}
        </p>
      )}
    </section>
  )
}
