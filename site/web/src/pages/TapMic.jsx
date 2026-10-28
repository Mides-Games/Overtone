import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'
// A file of its own, never inlined: the site's policy (script-src 'self') refuses a data: worklet.
import workletUrl from '../lib/mic-recorder.worklet.js?url&no-inline'
import { micTempo } from '../lib/song-spectra.js'
import { formatBpm } from '../lib/timing.js'

const DURATIONS = [6, 10, 15]

/**
 * A tempo from the microphone (W13.12): the browser listens for a few
 * seconds, the spectral worker reads the onset envelope's period
 * (lib/mic-tempo.js), and the page proposes a BPM with its confidence, or
 * says it heard no steady pulse. Nothing is uploaded or kept: the samples live
 * in this page until the reading, and the microphone is closed when it ends.
 * The permission is asked only when the reader presses Listen.
 */
export default function TapMic() {
  const { t } = useTranslation()
  usePageMeta(t('tapMic.title'), t('tapMic.description'))
  const [seconds, setSeconds] = useState(10)
  // idle | asking | listening | reading | done | error
  const [state, setState] = useState({ kind: 'idle' })
  const [level, setLevel] = useState(0)
  const session = useRef(null)

  const close = () => {
    const s = session.current
    session.current = null
    if (!s) return
    clearInterval(s.timer)
    s.stream?.getTracks().forEach((track) => track.stop())
    s.node?.port.close()
    s.ctx?.close().catch(() => {})
  }
  useEffect(() => close, [])

  async function listen() {
    close()
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode !== 'function') return setState({ kind: 'error', code: 'unsupported' })
    setState({ kind: 'asking' })
    let stream
    try {
      // The room as it is: no echo cancelling, no noise gate, no gain riding, all of which flatten attacks.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    } catch (error) {
      return setState({ kind: 'error', code: error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'denied' : 'noMic' })
    }
    const s = { stream, chunks: [], samples: 0 }
    session.current = s
    try {
      const Context = window.AudioContext || window.webkitAudioContext
      s.ctx = new Context()
      await s.ctx.audioWorklet.addModule(workletUrl)
      const source = s.ctx.createMediaStreamSource(stream)
      s.node = new AudioWorkletNode(s.ctx, 'overtone-recorder')
      // Pulled through a silent gain: a node no one listens to may not run.
      const mute = s.ctx.createGain()
      mute.gain.value = 0
      source.connect(s.node).connect(mute).connect(s.ctx.destination)
      const want = Math.round(seconds * s.ctx.sampleRate)
      let peak = 0
      s.node.port.onmessage = (event) => {
        if (session.current !== s) return
        const block = event.data
        s.chunks.push(block)
        s.samples += block.length
        let sum = 0
        for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
        peak = Math.max(peak * 0.85, Math.sqrt(sum / block.length))
        if (s.samples >= want) finish(s)
      }
      s.timer = setInterval(() => {
        if (session.current !== s) return
        setLevel(Math.min(1, peak * 6))
        setState({ kind: 'listening', done: Math.min(1, s.samples / want) })
      }, 100)
      setState({ kind: 'listening', done: 0 })
    } catch {
      close()
      setState({ kind: 'error', code: 'failed' })
    }
  }

  async function finish(s) {
    const rate = s.ctx.sampleRate
    const mono = new Float32Array(s.samples)
    let at = 0
    for (const chunk of s.chunks) {
      mono.set(chunk, at)
      at += chunk.length
    }
    close()
    setLevel(0)
    setState({ kind: 'reading' })
    try {
      const reading = await micTempo([mono], rate)
      setState({ kind: 'done', reading })
    } catch {
      setState({ kind: 'error', code: 'failed' })
    }
  }

  function stop() {
    const s = session.current
    if (s && s.samples > 0) finish(s)
    else {
      close()
      setState({ kind: 'idle' })
    }
  }

  const busy = state.kind === 'asking' || state.kind === 'listening' || state.kind === 'reading'
  const reading = state.kind === 'done' ? state.reading : null

  return (
    <article className="rise mx-auto max-w-[72ch] space-y-8">
      <header className="space-y-3">
        <p className="label text-accent">{t('tapMic.eyebrow')}</p>
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('tapMic.title')}</h1>
        <p className="text-body leading-relaxed text-muted">{t('tapMic.intro')}</p>
      </header>

      <section className="panel space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('tapMic.length')}>
            <span className="label mr-1">{t('tapMic.length')}</span>
            {DURATIONS.map((s) => (
              <button key={s} type="button" className="tool-btn px-2.5" aria-pressed={seconds === s} disabled={busy} onClick={() => setSeconds(s)}>
                {t('tapMic.seconds', { n: s })}
              </button>
            ))}
          </div>
          {state.kind === 'listening' ? (
            <button type="button" className="btn-primary h-10 min-w-28" onClick={stop}>
              {t('tapMic.stop')}
            </button>
          ) : (
            <button type="button" className="btn-primary h-10 min-w-28" onClick={listen} disabled={busy}>
              {reading ? t('tapMic.again') : t('tapMic.listen')}
            </button>
          )}
        </div>

        <div aria-live="polite" className="space-y-3">
          {state.kind === 'idle' && <p className="text-label text-dim">{t('tapMic.permission')}</p>}
          {state.kind === 'asking' && <p className="text-label text-dim">{t('tapMic.asking')}</p>}
          {state.kind === 'listening' && (
            <div className="space-y-2">
              <p className="text-label text-text">{t('tapMic.listening', { percent: Math.round(state.done * 100) })}</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={t('tapMic.listeningLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.done * 100)}>
                <div className="h-full bg-accent" style={{ width: `${Math.max(2, state.done * 100)}%` }} />
              </div>
              <div className="flex items-center gap-2 text-caption text-dim">
                <span>{t('tapMic.level')}</span>
                <span className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                  <span className="block h-full bg-lavender transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
                </span>
                {level < 0.05 && <span className="text-amber">{t('tapMic.quiet')}</span>}
              </div>
            </div>
          )}
          {state.kind === 'reading' && <p className="text-label text-dim">{t('tapMic.reading')}</p>}
          {state.kind === 'error' && (
            <p role="alert" className="text-label text-red">
              {t(`tapMic.errors.${state.code}`)}
            </p>
          )}
          {reading && <Reading reading={reading} />}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="label">{t('tapMic.limitsTitle')}</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-label leading-relaxed text-muted marker:text-dim">
          {['private', 'precision', 'octave', 'changes', 'room', 'offset'].map((key) => (
            <li key={key}>{t(`tapMic.limits.${key}`)}</li>
          ))}
        </ul>
        <p className="text-label text-muted">
          {t('tapMic.forTiming')}{' '}
          <Link to="/analyze" className="text-accent hover:underline">
            {t('nav.analyze')} →
          </Link>
        </p>
      </section>
    </article>
  )
}

function Reading({ reading }) {
  const { t } = useTranslation()
  if (reading.kind !== 'tempo') {
    return <p className="text-label text-amber">{t(`tapMic.result.${reading.kind}`)}</p>
  }
  const confidence = Math.round(reading.confidence * 100)
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="readout font-display text-[2.4rem] font-bold leading-none text-text">{formatBpm(Number(reading.bpm.toFixed(1)))}</span>
        <span className="label">BPM</span>
        <span className={`readout text-label ${confidence >= 60 ? 'text-accent' : 'text-amber'}`}>{t('tapMic.confidence', { percent: confidence })}</span>
      </p>
      {reading.alternatives.length > 0 && (
        <p className="text-label text-muted">
          {t('tapMic.alternatives', { list: reading.alternatives.map((b) => formatBpm(Number(b.toFixed(1)))).join(' · ') })}
        </p>
      )}
      <p className="text-caption text-dim">{t('tapMic.heard', { seconds: reading.seconds.toFixed(1) })}</p>
    </div>
  )
}
