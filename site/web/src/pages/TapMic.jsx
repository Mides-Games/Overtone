import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { NextLinks } from '../components/ui/Doc.jsx'
import Icon from '../components/ui/Icon.jsx'
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
  const listening = state.kind === 'listening'
  const done = listening ? state.done : 0

  return (
    <article className="rise space-y-10">
      <header className="max-w-[70ch] space-y-4">
        <p className="eyebrow">{t('tapMic.eyebrow')}</p>
        <h1 className="heading-headline">{t('tapMic.title')}</h1>
        <p className="lede">{t('tapMic.intro')}</p>
      </header>

      <div className="grid items-start gap-x-10 gap-y-10 lg:grid-cols-12">
        <section aria-label={t('tapMic.title')} className="panel overflow-hidden lg:col-span-7">
          {/* The controls: the length, then one button that is Listen, Stop and Again in turn, so the
              keyboard's focus stays on it through a whole reading (Space starts, Space stops). */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('tapMic.length')}>
              <span className="label mr-1.5">{t('tapMic.length')}</span>
              {DURATIONS.map((s) => (
                <button key={s} type="button" className="tool-btn readout px-2.5" aria-pressed={seconds === s} disabled={busy} onClick={() => setSeconds(s)}>
                  {t('tapMic.seconds', { n: s })}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`${listening ? 'btn-ghost' : 'btn-primary'} min-w-32`}
              onClick={() => {
                if (listening) stop()
                else if (!busy) listen()
              }}
              aria-disabled={busy && !listening ? 'true' : undefined}
            >
              <Icon name={listening ? 'stop' : 'mic'} size={18} />
              {listening ? t('tapMic.stop') : reading ? t('tapMic.again') : t('tapMic.listen')}
            </button>
          </div>

          {/* The display: what the microphone hears while it listens, the reading after. */}
          <div className="p-4 sm:p-5">
            <div aria-live="polite" className="panel-well flex min-h-56 flex-col justify-between gap-6 p-4 sm:p-5">
              {state.kind === 'idle' && <p className="text-label text-muted">{t('tapMic.permission')}</p>}
              {state.kind === 'asking' && <p className="text-label text-muted">{t('tapMic.asking')}</p>}
              {listening && (
                <div className="space-y-5">
                  <p className="readout text-label text-text">{t('tapMic.listening', { percent: Math.round(done * 100) })}</p>
                  <div
                    className="h-1 overflow-hidden rounded-full bg-line-strong"
                    role="progressbar"
                    aria-label={t('tapMic.listeningLabel')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(done * 100)}
                  >
                    <div className="h-full origin-left bg-accent transition-transform duration-100 ease-out" style={{ transform: `scaleX(${Math.max(0.02, done)})` }} />
                  </div>
                  <LevelMeter level={level} />
                </div>
              )}
              {state.kind === 'reading' && <p className="text-label text-muted">{t('tapMic.reading')}</p>}
              {state.kind === 'error' && (
                <p role="alert" className="text-label text-red">
                  {t(`tapMic.errors.${state.code}`)}
                </p>
              )}
              {reading && <Reading reading={reading} />}
              {!reading && (
                <p aria-hidden="true" className="readout text-display font-medium leading-none text-dim">
                  –<span className="unit">BPM</span>
                </p>
              )}
            </div>
          </div>
        </section>

        <section aria-labelledby="tap-mic-limits" className="min-w-0 space-y-4 lg:col-span-5">
          <h2 id="tap-mic-limits" className="heading-title">
            {t('tapMic.limitsTitle')}
          </h2>
          <ul className="prose text-label">
            {['private', 'precision', 'octave', 'changes', 'room', 'offset'].map((key) => (
              <li key={key}>{t(`tapMic.limits.${key}`)}</li>
            ))}
          </ul>
          <div className="border-t border-line pt-4">
            <p className="text-label text-muted">{t('tapMic.forTiming')}</p>
            <NextLinks links={[{ to: '/analyze', label: t('nav.analyze') }]} className="mt-1" />
          </div>
        </section>
      </div>
    </article>
  )
}

/** The input level as a row of segments, like a channel meter; the quiet warning beside it. */
const SEGMENTS = 24
function LevelMeter({ level }) {
  const { t } = useTranslation()
  const lit = Math.round(level * SEGMENTS)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-caption">
      <span className="label">{t('tapMic.level')}</span>
      <span className="flex h-3 items-stretch gap-[3px]" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span key={i} className={`w-1.5 rounded-[1px] ${i < lit ? 'bg-accent' : 'bg-line-strong'}`} />
        ))}
      </span>
      {level < 0.05 && <span className="text-amber">{t('tapMic.quiet')}</span>}
    </div>
  )
}

function Reading({ reading }) {
  const { t } = useTranslation()
  if (reading.kind !== 'tempo') {
    return <p className="callout callout-amber text-text">{t(`tapMic.result.${reading.kind}`)}</p>
  }
  const confidence = Math.round(reading.confidence * 100)
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <span className="readout text-display font-medium leading-none text-text">
          {formatBpm(Number(reading.bpm.toFixed(1)))}
          <span className="unit">BPM</span>
        </span>
        <span className={confidence >= 60 ? 'chip-accent' : 'chip-amber'}>{t('tapMic.confidence', { percent: confidence })}</span>
      </p>
      {reading.alternatives.length > 0 && (
        <p className="readout text-label text-muted">
          {t('tapMic.alternatives', { list: reading.alternatives.map((b) => formatBpm(Number(b.toFixed(1)))).join(' · ') })}
        </p>
      )}
      <p className="readout text-caption text-dim">{t('tapMic.heard', { seconds: reading.seconds.toFixed(1) })}</p>
    </div>
  )
}
