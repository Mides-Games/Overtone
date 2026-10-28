import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import Comments from '../components/social/Comments.jsx'
import TimingSocial, { UploaderLink, useTimingSocial } from '../components/social/TimingSocial.jsx'
import { shortDate, UploaderMark, uploaderName } from '../components/TimingList.jsx'
import { useDocumentMeta } from '../hooks/useDocumentMeta.js'
import { ratingLabel } from '../lib/social.js'
import { comparePath } from '../lib/compare.js'
import { bpmLabel, checkTimingAudio, publicTiming, songLine } from '../lib/timings.js'
import { ACCENT_HEADER, accentWash, Result } from './AnalysisResult.jsx'

/**
 * A published timing's own page (W3.27), for anyone: the song, who timed it
 * and when, and the result as its uploader sees it, read-only but for the
 * reader's own adjustments. The audio is the reader's own file: the page
 * hashes it and asks the server whether it is this timing's audio (the
 * timing's hash never comes to the browser), and only then plays it against
 * the clicks and offers the .osz.
 *
 * Under the result (W6): its stars, who used it, the reader's collections,
 * and comments, which may point at a time in the song (W13.15).
 */
export default function TimingPage() {
  const { t, i18n } = useTranslation()
  const { id } = useParams()
  const [timing, setTiming] = useState(null)
  const [error, setError] = useState(null)
  // W13.24: the cover of the visitor's own copy of the song, once it is checked.
  const [accent, setAccent] = useState(null)
  const [social, updateSocial] = useTimingSocial(id)
  const playerRef = useRef(null)
  const resultRef = useRef(null)

  useEffect(() => {
    let alive = true
    setTiming(null)
    setError(null)
    publicTiming(id)
      .then((data) => alive && setTiming(data))
      .catch((failure) => alive && setError(failure.status === 404 ? 'notFound' : 'network'))
    return () => {
      alive = false
    }
  }, [id])

  const verify = useCallback((digest) => checkTimingAudio(id, digest), [id])
  const song = timing ? songLine(timing) ?? t('timings.untitled') : null
  useDocumentMeta(
    timing
      ? {
          title: `${song} · Overtone`,
          description: [
            timing.bpm === null ? null : `${bpmLabel(timing.bpm)} BPM`,
            t('timings.redLines', { count: timing.redLines }),
            timing.uploader ? t('timings.timedBy', { name: timing.uploader.username }) : t('timings.timedAnonymously'),
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : {},
  )

  if (error === 'notFound') {
    return (
      <div className="panel space-y-3 p-6">
        <h1 className="font-display text-title font-bold uppercase">{t('timings.page.notFoundTitle')}</h1>
        <p className="text-label text-muted">{t('timings.page.notFound')}</p>
        <Link to="/recent" className="btn-ghost">
          {t('timings.page.toRecent')}
        </Link>
      </div>
    )
  }
  if (!timing) {
    return error === 'network' ? <p className="text-label text-dim">{t('result.reconnecting')}</p> : <BrandLoader className="py-16" />
  }

  // What the result view and the .osz read: the names stand in for the tags.
  const analysis = { id, status: 'done', result: timing.result, tagTitle: timing.title, tagArtist: timing.artist, filename: null }

  // A comment's m:ss (W13.15): the player goes there and the map comes into view.
  const seek = (ms) => {
    playerRef.current?.seek(ms / 1000)
    resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const position = () => playerRef.current?.position() ?? null

  return (
    <div className="space-y-8">
      <header className={`rise flex flex-wrap items-end justify-between gap-4 ${accent ? ACCENT_HEADER : ''}`} style={accentWash(accent)}>
        <div className="min-w-0 space-y-2">
          <p className="label text-accent" style={accent ? { color: accent.ink } : undefined}>
            {t('timings.page.eyebrow')}
          </p>
          <h1 className="font-display text-[clamp(1.5rem,1.2rem+1.2vw,2.1rem)] font-bold break-words">{timing.title ?? t('timings.untitled')}</h1>
          {timing.artist && <p className="text-body text-muted">{timing.artist}</p>}
          <div className="flex flex-wrap items-center gap-2 text-caption text-dim">
            <UploaderMark uploader={timing.uploader} size={24} />
            <span>
              {timing.uploader ? <UploaderLink uploader={timing.uploader} linked={Boolean(social?.uploaderProfile)} /> : uploaderName(t, timing)} ·{' '}
              {t('timings.page.published', { date: shortDate(timing.publishedAt, i18n.language) })}
            </span>
            {social && (
              <span className="readout">
                · <span className="text-amber">★</span> {ratingLabel(social.rating.average)} ({social.rating.count}) ·{' '}
                {t('social.uses.short', { count: social.uses.count })}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {/* W12.11: this timing against one of the visitor's own, or another published one. */}
          <Link to={comparePath({ id })} className="btn-ghost">
            {t('compare.action')}
          </Link>
          <Link to="/analyze" className="btn-ghost">
            {t('timings.page.yourOwn')}
          </Link>
        </div>
      </header>

      <div ref={resultRef} className="scroll-mt-20">
        <Result id={id} analysis={analysis} verify={verify} csvHref={`/api/v1/timings/${id}/timing.csv`} playerRef={playerRef} onAccent={setAccent} />
      </div>

      {social && <TimingSocial id={id} social={social} onChange={updateSocial} />}
      {social === false && <p className="text-caption text-dim">{t('social.failed')}</p>}
      <Comments id={id} durationS={timing.result?.duration_s ?? 0} onSeek={seek} position={position} />
    </div>
  )
}
