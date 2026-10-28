import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LAB_WINDOW_S, labReport, labTrials, mp3GaplessInfo, presented, readHead, vote } from '../../lib/offset-lab.js'

const NUDGE_LIMIT = 500
const label = (shift) => (shift === 0 ? '±0' : `${shift > 0 ? '+' : '−'}${Math.abs(shift)}`)

/**
 * The offset lab (W7), the desktop app's: what the file says about its own
 * delay, and a blind test of which click shift sounds in time, played with
 * the page's own player (its loop, its clicks) and applied, when the reader
 * asks, as the page's nudge. See lib/offset-lab.js.
 */
export default function OffsetLab({ player, snapshot, lines, nudgeMs, onAdjust, audioFile = null }) {
  const { t } = useTranslation()
  const [header, setHeader] = useState(null)
  const [lab, setLab] = useState({ trials: [], at: 0, heard: [false, false], votes: {}, playing: null })
  const timer = useRef(0)

  useEffect(() => {
    let live = true
    setHeader(null)
    if (audioFile) readHead(audioFile).then((head) => live && setHeader(head ? mp3GaplessInfo(head, audioFile.name) : null))
    return () => {
      live = false
    }
  }, [audioFile])

  const stopPlaying = () => {
    clearTimeout(timer.current)
    timer.current = 0
    player.setClickShift(0)
  }
  // Leaving the page or the editor mid-presentation puts the clicks back where the lines are.
  useEffect(() => () => stopPlaying(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const done = lab.trials.length > 0 && lab.at >= lab.trials.length
  const live = lab.trials.length > 0 && !done
  const blocked = !snapshot.ready ? 'noAudio' : snapshot.rate !== 1 ? 'rate' : !snapshot.clicksOn ? 'clicks' : null

  // The reader's loop when there is one, else the first red line: the same passage every time.
  const startPoint = () => (snapshot.range ? snapshot.range.a : Math.max(0, (lines[0]?.timeMs ?? 0) / 1000))

  function start() {
    if (blocked) return
    stopPlaying()
    setLab({ trials: labTrials(), at: 0, heard: [false, false], votes: {}, playing: null })
  }

  async function hear(which) {
    if (!live || blocked) return
    const trial = lab.trials[lab.at]
    stopPlaying()
    player.setClickShift(presented(trial, which))
    await player.play(startPoint())
    setLab((l) => ({ ...l, playing: which }))
    timer.current = setTimeout(() => {
      player.stop()
      stopPlaying()
      setLab((l) => ({ ...l, playing: null, heard: l.heard.map((h, i) => h || i === which) }))
    }, LAB_WINDOW_S * 1000)
  }

  function pick(which) {
    if (!live || !lab.heard[0] || !lab.heard[1]) return
    stopPlaying()
    player.stop()
    setLab((l) => ({ ...l, votes: vote(l.votes, l.trials[l.at], which), at: l.at + 1, heard: [false, false], playing: null }))
  }

  function cancel() {
    stopPlaying()
    if (lab.playing !== null) player.stop()
    setLab({ trials: [], at: 0, heard: [false, false], votes: {}, playing: null })
  }

  const report = done ? labReport(lab.votes) : null
  const proposed = report?.best ? Math.max(-NUDGE_LIMIT, Math.min(NUDGE_LIMIT, nudgeMs + report.best.shift)) : null

  return (
    <details className="rounded-control border border-line bg-surface">
      <summary className="cursor-pointer px-3 py-2 text-label font-semibold">{t('lab.title')}</summary>
      <div className="space-y-3 border-t border-line px-3 py-3">
        <p className="text-caption text-dim">{t('lab.sub')}</p>
        <p className="readout text-caption text-text">
          {!audioFile
            ? t('lab.headerNeedsAudio')
            : header === null
              ? '…'
              : header.present
                ? t('lab.header', { encoder: header.encoder, delay: header.delaySamples, delayMs: header.delayMs, pad: header.paddingSamples, padMs: header.paddingMs })
                : t('lab.noTag')}
        </p>

        <div className="space-y-2">
          <h4 className="label">{t('lab.testTitle')}</h4>
          <p className="text-caption text-dim">{t('lab.testSub', { seconds: LAB_WINDOW_S })}</p>
          {blocked && <p className="text-caption text-amber">{t(`lab.blocked.${blocked}`)}</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" className="tool-btn px-2.5" onClick={start} disabled={Boolean(blocked) || live}>
              {t('lab.start')}
            </button>
            {[0, 1].map((which) => (
              <button key={`h${which}`} type="button" className="tool-btn px-2.5" onClick={() => hear(which)} disabled={!live || Boolean(blocked)} aria-pressed={lab.playing === which}>
                {t('lab.hear', { n: which + 1 })}
                {lab.heard[which] ? ' ✓' : ''}
              </button>
            ))}
            {[0, 1].map((which) => (
              <button key={`v${which}`} type="button" className="tool-btn px-2.5" onClick={() => pick(which)} disabled={!live || !lab.heard[0] || !lab.heard[1]}>
                {t('lab.vote', { n: which + 1 })}
              </button>
            ))}
            {(live || done) && (
              <button type="button" className="tool-btn px-2.5" onClick={cancel}>
                {done ? t('lab.again') : t('lab.cancel')}
              </button>
            )}
          </div>
          <p className="text-caption text-dim" aria-live="polite">
            {live ? t('lab.trial', { k: lab.at + 1, n: lab.trials.length }) : ''}
          </p>
        </div>

        {report && (
          <div className="space-y-2">
            <div className="overflow-x-auto rounded-control border border-line">
              <table className="w-full text-left text-caption">
                <thead className="bg-surface-2">
                  <tr className="label">
                    <th className="px-2 py-1.5 font-semibold">{t('lab.shift')}</th>
                    <th className="px-2 py-1.5 font-semibold">{t('lab.wins')}</th>
                    <th className="px-2 py-1.5 font-semibold">{t('lab.interval')}</th>
                  </tr>
                </thead>
                <tbody className="readout divide-y divide-line">
                  {report.rows.map((row) => (
                    <tr key={row.shift} className={report.best?.shift === row.shift ? 'text-accent' : ''}>
                      <td className="px-2 py-1">{label(row.shift)} ms</td>
                      <td className="px-2 py-1">
                        {row.wins}/{row.n}
                      </td>
                      <td className="px-2 py-1">
                        {Math.round(row.lo * 100)}–{Math.round(row.hi * 100)} %
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2" role="status">
              <p className="text-caption text-text">
                {report.best
                  ? t('lab.best', { shift: label(report.best.shift), lo: Math.round(report.best.lo * 100), hi: Math.round(report.best.hi * 100) })
                  : t('lab.none')}
              </p>
              {report.best && (
                <button type="button" className="tool-btn px-2.5" disabled={proposed === nudgeMs} onClick={() => onAdjust((a) => ({ ...a, nudgeMs: proposed }))}>
                  {t('lab.apply', { ms: `${proposed > 0 ? '+' : ''}${proposed}` })}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  )
}
