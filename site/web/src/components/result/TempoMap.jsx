import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pageKeyIgnored } from '../../lib/keys.js'
import { forgetProgress, readLayers, songSpectra, writeLayers } from '../../lib/song-spectra.js'
import { formatBpm, formatClock, governing, lowerBound } from '../../lib/timing.js'
import { layout, paintMap, paintOverview, readPalette } from './draw.js'
import { RED_LINES_TABLE_ID } from './RedLinesTable.jsx'

/** The closest zoom, seconds across the whole map. */
const MIN_SPAN_S = 0.5
/** A click this close to a red line (CSS px) picks the line instead of seeking. */
const LINE_PICK_PX = 6
const OVERVIEW_H = 34

/**
 * The tempo map: the result drawn on a timeline you can zoom (wheel, pinch,
 * + / -), pan (drag, the overview), seek (click) and loop (Shift-drag), with
 * the playhead following the song. Two canvases: the map, repainted when the
 * view or the data change, and an overlay for what moves every frame.
 *
 * `song` ({ id, buffer }, once the reader's file is decoded) feeds the two
 * optional lanes, the bands (W13.6) and the spectrogram (W13.7): worked out
 * in a worker (lib/song-spectra.js) the first time either is on, and kept for
 * the session.
 */
export default function TempoMap({ data, player, snapshot, selected, hovered, onSelect, onHover, clockRef, focus, song = null, children }) {
  const { t } = useTranslation()
  const [layers, setLayers] = useState(readLayers)
  const [spectra, setSpectra] = useState(null)
  // null, a fraction while the worker runs, or 'error'.
  const [spectraState, setSpectraState] = useState(null)
  const specCache = useRef({})
  const wanted = layers.bands || layers.spectrogram
  const songId = song?.id ?? null
  const songBuffer = song?.buffer ?? null
  useEffect(() => {
    setSpectra(null)
    if (!wanted || !songBuffer) return setSpectraState(null)
    let live = true
    const onProgress = (done) => live && setSpectraState(done)
    setSpectraState(0)
    songSpectra(songId, songBuffer, onProgress).then(
      (result) => {
        if (!live) return
        setSpectra(result)
        setSpectraState(null)
      },
      () => live && setSpectraState('error'),
    )
    return () => {
      live = false
      forgetProgress(songId, onProgress)
    }
  }, [wanted, songId, songBuffer])
  const toggleLayer = (key) =>
    setLayers((now) => {
      const next = { ...now, [key]: !now[key] }
      writeLayers(next)
      return next
    })
  const bandLabels = useMemo(() => ({ low: t('tempo.bands.lowShort'), mid: t('tempo.bands.midShort'), high: t('tempo.bands.highShort') }), [t])
  const wrapRef = useRef(null)
  const mapRef = useRef(null)
  const overlayRef = useRef(null)
  const overviewRef = useRef(null)
  const overviewBase = useRef(null)
  const view = useRef({ a: 0, b: Math.max(data.durationS, MIN_SPAN_S) })
  const drag = useRef(null)
  const pointers = useRef(new Map())
  const hoverX = useRef(null)
  const geometry = useRef(null)
  const [width, setWidth] = useState(0)
  const [palette, setPalette] = useState(readPalette)
  const [follow, setFollow] = useState(true)
  const [viewLabel, setViewLabel] = useState(null)
  const [tip, setTip] = useState(null)

  const showBands = layers.bands && Boolean(spectra)
  const showSpec = layers.spectrogram && Boolean(spectra)
  const L = useMemo(() => (width ? layout(width, { bands: showBands, spectrogram: showSpec }) : null), [width, showBands, showSpec])
  const duration = Math.max(data.durationS, MIN_SPAN_S)

  // The theme's class lands on <html> in the provider's own effect, after this
  // component's: watch the class itself, not the context value.
  useEffect(() => {
    setPalette(readPalette())
    const observer = new MutationObserver(() => setPalette(readPalette()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // The map follows its box's width.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const observer = new ResizeObserver(() => setWidth(Math.floor(wrap.clientWidth)))
    observer.observe(wrap)
    setWidth(Math.floor(wrap.clientWidth))
    return () => observer.disconnect()
  }, [])

  const clampView = useCallback(
    (a, span) => {
      const s = Math.min(Math.max(span, MIN_SPAN_S), duration)
      const start = Math.min(Math.max(a, 0), duration - s)
      view.current = { a: start, b: start + s }
    },
    [duration],
  )

  const sizeCanvas = (canvas, w, h) => {
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }

  const paintOverlay = useCallback(() => {
    const canvas = overlayRef.current
    const g = geometry.current
    if (!canvas || !g || !L) return
    const ctx = sizeCanvas(canvas, L.width, L.height)
    ctx.clearRect(0, 0, L.width, L.height)
    const { a, b } = view.current
    const X = (s) => L.x0 + ((s - a) / (b - a)) * (L.x1 - L.x0)
    const c = palette
    const top = L.tempoTop
    const foot = L.driftBottom
    const band =
      drag.current?.kind === 'loop' && drag.current.to !== null
        ? span(drag.current.from, drag.current.to)
        : snapshot.practice
          ? snapshot.practice
          : snapshot.loopOn
            ? (snapshot.range ?? (snapshot.playing ? player.loop : null))
            : null
    if (band) {
      const x = Math.max(X(band.a), L.x0)
      const w = Math.min(X(band.b), L.x1) - x
      if (w > 0) {
        ctx.globalAlpha = 0.14
        ctx.fillStyle = c.accent
        ctx.fillRect(x, top, w, foot - top)
        ctx.globalAlpha = 0.8
        ctx.fillRect(x, top, 1.5, foot - top)
        ctx.fillRect(x + w - 1.5, top, 1.5, foot - top)
        ctx.globalAlpha = 1
      }
    }
    if (hoverX.current !== null && !drag.current) {
      ctx.strokeStyle = c.muted
      ctx.lineWidth = 1
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(Math.round(hoverX.current) + 0.5, top)
      ctx.lineTo(Math.round(hoverX.current) + 0.5, foot)
      ctx.stroke()
      ctx.setLineDash([])
    }
    const pos = player.heardPosition()
    if (snapshot.ready && (snapshot.playing || pos > 0)) {
      const x = Math.round(X(pos)) + 0.5
      if (x >= L.x0 && x <= L.x1) {
        ctx.strokeStyle = c.text
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(x, top - 4)
        ctx.lineTo(x, foot)
        ctx.stroke()
        ctx.fillStyle = c.text
        ctx.beginPath()
        ctx.moveTo(x - 5, top - 9)
        ctx.lineTo(x + 5, top - 9)
        ctx.lineTo(x, top - 3)
        ctx.fill()
      }
    }
    if (clockRef?.current) clockRef.current.textContent = formatClock(pos * 1000)

    // The overview: its cached base, the view box, the playhead.
    const ov = overviewRef.current
    if (ov && overviewBase.current) {
      const octx = sizeCanvas(ov, L.width, OVERVIEW_H)
      octx.setTransform(1, 0, 0, 1, 0, 0)
      octx.drawImage(overviewBase.current, 0, 0)
      const dpr = window.devicePixelRatio || 1
      octx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const OX = (s) => (s / duration) * L.width
      const va = OX(a)
      const vw = Math.max(3, OX(b) - va)
      if (b - a < duration - 1e-6) {
        octx.globalAlpha = 0.15
        octx.fillStyle = c.accent
        octx.fillRect(va, 0, vw, OVERVIEW_H)
        octx.globalAlpha = 1
        octx.strokeStyle = c.accent
        octx.lineWidth = 1.5
        octx.strokeRect(va + 0.75, 0.75, vw - 1.5, OVERVIEW_H - 1.5)
      }
      if (snapshot.ready && (snapshot.playing || pos > 0)) {
        octx.fillStyle = c.text
        octx.fillRect(Math.round(OX(pos)), 0, 1.5, OVERVIEW_H)
      }
    }
  }, [L, palette, snapshot, player, clockRef, duration])

  const paint = useCallback(() => {
    if (!L || !mapRef.current) return
    const ctx = sizeCanvas(mapRef.current, L.width, L.height)
    const lanes = { spectra, specCache: specCache.current, bandLabels }
    geometry.current = paintMap(ctx, L, view.current, { ...data, ...lanes, selected, hovered }, palette)
    const { a, b } = view.current
    const zoomed = b - a < duration - 1e-6
    setViewLabel((old) => (!zoomed ? null : old && old.a === a && old.b === b ? old : { a, b }))
    paintOverlay()
  }, [L, data, selected, hovered, palette, paintOverlay, duration, spectra, bandLabels])

  // The overview's base, once per data and size.
  useEffect(() => {
    if (!L) return
    const dpr = window.devicePixelRatio || 1
    const base = overviewBase.current ?? document.createElement('canvas')
    base.width = Math.round(L.width * dpr)
    base.height = Math.round(OVERVIEW_H * dpr)
    const ctx = base.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paintOverview(ctx, L.width, OVERVIEW_H, { ...data, selected }, palette)
    overviewBase.current = base
  }, [L?.width, data, selected, palette]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    paint()
  }, [paint])

  // A line picked in the table comes into view.
  useEffect(() => {
    if (selected === null || selected === undefined) return
    const line = data.lines[selected]
    if (!line) return
    const s = line.timeMs / 1000
    const { a, b } = view.current
    if (s < a || s > b) {
      clampView(s - (b - a) * 0.25, b - a)
      paint()
    }
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  // A span from "Check here" comes into view whole (zoomed out to hold it when it is longer than the view), and the
  // map into the page when asked.
  useEffect(() => {
    if (!focus) return
    const { a, b } = view.current
    if (focus.a < a || focus.b > b) {
      const width = Math.max(b - a, (focus.b - focus.a) * 1.2)
      clampView(focus.a - (width - (focus.b - focus.a)) / 2, width)
      paint()
    }
    if (focus.scroll) wrapRef.current?.closest('section')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every frame while the song plays: the playhead, the clock, and the view turning its page.
  useEffect(() => {
    if (!snapshot.playing) {
      paintOverlay()
      return undefined
    }
    let raf = 0
    const frame = () => {
      const { a, b } = view.current
      const pos = player.heardPosition()
      if (follow && b - a < duration - 1e-6 && !drag.current && (pos > b - (b - a) * 0.02 || pos < a)) {
        clampView(pos - (b - a) * 0.08, b - a)
        paint()
      } else paintOverlay()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [snapshot.playing, follow, paint, paintOverlay, player, clampView, duration])

  const secondsAt = (x) => {
    const { a, b } = view.current
    return a + ((x - L.x0) / (L.x1 - L.x0)) * (b - a)
  }
  const xOf = (s) => {
    const { a, b } = view.current
    return L.x0 + ((s - a) / (b - a)) * (L.x1 - L.x0)
  }
  const localX = (event) => {
    const rect = overlayRef.current.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const lineAt = (x) => {
    let best = -1
    let distance = LINE_PICK_PX + 1
    data.lines.forEach((line, i) => {
      const d = Math.abs(xOf(line.timeMs / 1000) - x)
      if (d < distance) {
        distance = d
        best = i
      }
    })
    return best
  }
  /** The nearest beat of the grid, so a drawn loop repeats whole beats; Alt leaves it free. */
  const beatAt = (s, free) => {
    const grid = data.grid.t
    if (free || !grid.length) return Math.min(Math.max(s, 0), duration)
    const i = lowerBound(grid, s)
    const near = [i - 1, i].filter((j) => j >= 0 && j < grid.length)
    return near.reduce((best, j) => (Math.abs(grid[j] - s) < Math.abs(best - s) ? grid[j] : best), grid[near[0]])
  }

  const zoomBy = useCallback(
    (factor, at) => {
      const { a, b } = view.current
      const s = at ?? (snapshot.ready && (snapshot.playing || player.pos > 0) ? player.heardPosition() : (a + b) / 2)
      const next = Math.min(Math.max((b - a) * factor, MIN_SPAN_S), duration)
      clampView(s - (s - a) * (next / (b - a)), next)
      paint()
    },
    [clampView, paint, duration, snapshot, player],
  )
  const fit = useCallback(() => {
    clampView(0, duration)
    paint()
  }, [clampView, paint, duration])

  // The wheel zooms at the pointer (a sideways scroll pans); fully zoomed out it leaves the page its scroll.
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !L) return undefined
    const onWheel = (event) => {
      const { a, b } = view.current
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault()
        clampView(a + (event.deltaX / (L.x1 - L.x0)) * (b - a), b - a)
        paint()
        return
      }
      if (event.deltaY > 0 && b - a >= duration - 1e-6) return
      event.preventDefault()
      const { x } = localX(event)
      const scale = event.deltaMode === 1 ? 40 : 1
      zoomBy(Math.exp(event.deltaY * scale * 0.0015), secondsAt(Math.min(Math.max(x, L.x0), L.x1)))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }) // re-bound each render: it reads the current layout and view helpers

  function onPointerDown(event) {
    if (!L || (event.pointerType === 'mouse' && event.button !== 0)) return
    overlayRef.current.setPointerCapture(event.pointerId)
    const { x } = localX(event)
    pointers.current.set(event.pointerId, x)
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()]
      drag.current = { kind: 'pinch', distance: Math.abs(p - q) || 1, at: secondsAt((p + q) / 2), view: { ...view.current } }
      return
    }
    drag.current = event.shiftKey
      ? { kind: 'loop', x0: x, from: beatAt(secondsAt(x), event.altKey), to: null, moved: false }
      : { kind: 'pan', x0: x, a: view.current.a, b: view.current.b, moved: false }
  }

  function onPointerMove(event) {
    if (!L) return
    const { x, y } = localX(event)
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, x)
    const current = drag.current
    if (current?.kind === 'pinch' && pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()]
      const ratio = current.distance / (Math.abs(p - q) || 1)
      const span = (current.view.b - current.view.a) * ratio
      const at = current.at
      clampView(at - (at - current.view.a) * ratio, span)
      paint()
      return
    }
    if (current) {
      if (Math.abs(x - current.x0) > 3) current.moved = true
      if (!current.moved) return
      if (current.kind === 'pan') {
        const ds = ((x - current.x0) / (L.x1 - L.x0)) * (current.b - current.a)
        clampView(current.a - ds, current.b - current.a)
        paint()
      } else if (current.kind === 'loop') {
        current.to = beatAt(secondsAt(x), event.altKey)
        paintOverlay()
      }
      return
    }
    if (event.pointerType !== 'mouse') return
    // Hover: the cursor, the line under it, and what the map says there.
    const inside = x >= L.x0 && x <= L.x1 && y >= 0 && y <= L.driftBottom
    hoverX.current = inside ? x : null
    const near = lineAt(x)
    overlayRef.current.style.cursor = near >= 0 ? 'pointer' : 'crosshair'
    if ((near >= 0 ? near : null) !== hovered) onHover(near >= 0 ? near : null)
    if (inside) {
      const s = secondsAt(x)
      const g = governing(data.lines, s)
      const line = data.lines[g]
      const bt = data.beats?.t_ms ?? []
      const j = Math.min(bt.length - 1, lowerBound(bt, s * 1000))
      const local = bt.length && data.beats.bpm.length ? data.beats.bpm[Math.max(0, j)] * data.factor : null
      setTip({
        x,
        s,
        local,
        line: line ? line.bpm : null,
        confidence: line ? data.sections[line.index]?.confidence : null,
        before: data.lines.length > 0 && s < data.lines[0].timeMs / 1000,
        other: data.other?.length ? data.other[governing(data.other, s)].bpm : null,
      })
    } else setTip(null)
    paintOverlay()
  }

  function onPointerUp(event) {
    pointers.current.delete(event.pointerId)
    const current = drag.current
    if (current?.kind === 'pinch') {
      if (pointers.current.size === 0) drag.current = null
      return
    }
    drag.current = null
    if (!current || !L) return
    const { x } = localX(event)
    if (current.kind === 'loop') {
      const range = current.moved && current.to !== null ? span(current.from, current.to) : null
      if (range && range.b - range.a >= 0.05) player.setRange(range)
      else if (!current.moved) player.setRange(null)
      paintOverlay()
      return
    }
    if (current.moved) return
    const near = lineAt(x)
    if (near >= 0) onSelect(near)
    else if (snapshot.ready && x >= L.x0 && x <= L.x1) player.seek(secondsAt(x))
  }

  function onPointerLeave() {
    hoverX.current = null
    setTip(null)
    if (hovered !== null) onHover(null)
    paintOverlay()
  }

  // Keys, anywhere on the page but in a field: Space plays, arrows step a beat (Shift: a bar),
  // + and - zoom, 0 fits, [ and ] walk the red lines, L loops, C mutes the clicks, F follows.
  // The shortcut help (components/CommandPalette.jsx) lists the same keys: change both together.
  useEffect(() => {
    const onKey = (event) => {
      if (pageKeyIgnored(event)) return
      const target = event.target
      const grid = data.grid
      const step = (dir, bar) => {
        const pos = player.position()
        const i = lowerBound(grid.t, pos + (dir > 0 ? 1e-3 : -1e-3))
        let j = dir > 0 ? i : i - 1
        if (bar) while (j >= 0 && j < grid.t.length && grid.level[j] !== 2) j += dir
        if (j >= 0 && j < grid.t.length) player.seek(grid.t[j])
      }
      const handled = {
        ' ': () => snapshot.ready && player.toggle(),
        ArrowRight: () => snapshot.ready && step(1, event.shiftKey),
        ArrowLeft: () => snapshot.ready && step(-1, event.shiftKey),
        '+': () => zoomBy(0.6),
        '=': () => zoomBy(0.6),
        '-': () => zoomBy(1 / 0.6),
        _: () => zoomBy(1 / 0.6),
        0: () => fit(),
        '[': () => onSelect(Math.max(0, (selected ?? 1) - 1)),
        ']': () => onSelect(Math.min(data.lines.length - 1, (selected ?? -1) + 1)),
        l: () => player.setLoopOn(!snapshot.loopOn),
        c: () => player.setVolumes({ clicksOn: !snapshot.clicksOn }),
        f: () => setFollow((on) => !on),
      }[event.key.length === 1 ? event.key.toLowerCase() : event.key]
      if (!handled) return
      if (event.key === ' ' && target instanceof HTMLButtonElement) return // the button itself answers
      event.preventDefault()
      handled()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [data, player, snapshot, selected, zoomBy, fit, onSelect])

  function onOverview(event) {
    if (!L) return
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId)
    else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = event.currentTarget.getBoundingClientRect()
    const s = ((event.clientX - rect.left) / rect.width) * duration
    const { a, b } = view.current
    if (b - a >= duration - 1e-6) clampView(s - duration * 0.05, duration * 0.1)
    else clampView(s - (b - a) / 2, b - a)
    paint()
  }

  return (
    <section className="panel overflow-hidden" aria-label={t('tempo.mapLabel')}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="label">{t('tempo.mapTitle')}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {viewLabel && (
            <span className="readout mr-1 text-caption text-dim">
              {formatClock(viewLabel.a * 1000)} – {formatClock(viewLabel.b * 1000)}
            </span>
          )}
          <button type="button" className="tool-btn" onClick={() => zoomBy(1 / 0.6)} aria-label={t('tempo.zoomOut')} title={t('tempo.zoomOut')}>
            −
          </button>
          <button type="button" className="tool-btn" onClick={() => zoomBy(0.6)} aria-label={t('tempo.zoomIn')} title={t('tempo.zoomIn')}>
            +
          </button>
          <button type="button" className="tool-btn px-2.5" onClick={fit} disabled={!viewLabel}>
            {t('tempo.fit')}
          </button>
          <button type="button" className="tool-btn px-2.5" aria-pressed={follow} onClick={() => setFollow((on) => !on)} title={t('tempo.followHint')}>
            {t('tempo.follow')}
          </button>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
          <button type="button" className="tool-btn px-2.5" aria-pressed={layers.bands} onClick={() => toggleLayer('bands')} title={t('tempo.bands.hint')}>
            {t('tempo.bands.toggle')}
          </button>
          <button type="button" className="tool-btn px-2.5" aria-pressed={layers.spectrogram} onClick={() => toggleLayer('spectrogram')} title={t('tempo.spectrogram.hint')}>
            {t('tempo.spectrogram.toggle')}
          </button>
        </div>
      </div>
      {wanted && (spectraState !== null || !songBuffer) && (
        <p className="border-b border-line px-3 py-1.5 text-caption text-dim" role="status">
          {!songBuffer
            ? t('tempo.layers.needSong')
            : spectraState === 'error'
              ? t('tempo.layers.failed')
              : t('tempo.layers.working', { percent: Math.round(spectraState * 100) })}
        </p>
      )}

      <div ref={wrapRef} className="relative select-none" style={{ height: L ? L.height : 300 }}>
        <canvas ref={mapRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
        <canvas
          ref={overlayRef}
          className="absolute inset-0 h-full w-full cursor-crosshair"
          style={{ touchAction: 'pan-y' }}
          role="img"
          aria-label={t('tempo.canvasLabel', { count: data.lines.length })}
          aria-describedby={RED_LINES_TABLE_ID}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
        {tip && L && (
          <div
            className="pointer-events-none absolute z-10 min-w-36 rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-caption shadow-lg"
            style={{ left: Math.min(tip.x + 12, L.width - 160), top: L.tempoTop + 4 }}
          >
            <Row k={t('tempo.tipTime')} v={formatClock(tip.s * 1000)} />
            {tip.local !== null && <Row k={t('tempo.tipLocal')} v={tip.local.toFixed(2)} />}
            <Row k={t('tempo.tipLine')} v={formatBpm(tip.line)} />
            {tip.other !== null && <Row k={data.otherLabel ?? t('compare.other')} v={formatBpm(tip.other)} />}
            {tip.confidence !== null && tip.confidence !== undefined && <Row k={t('strip.confidence')} v={`${Math.round(tip.confidence * 100)}%`} />}
            {tip.before && <p className="mt-1 max-w-48 text-dim">{t('tempo.tipBefore')}</p>}
          </div>
        )}
      </div>

      <canvas
        ref={overviewRef}
        className="block w-full cursor-pointer border-t border-line"
        style={{ height: OVERVIEW_H, touchAction: 'none' }}
        aria-label={t('tempo.overview')}
        onPointerDown={onOverview}
        onPointerMove={onOverview}
      />

      {children}
      <Legend
        hints={data.hints}
        swing={data.swing}
        subdivision={data.subdivision ?? 1}
        other={data.other?.length ? data.otherLabel ?? t('compare.other') : null}
        bands={showBands}
        spectrogram={showSpec}
        spectraSeconds={spectra?.totalMs ? spectra.totalMs / 1000 : null}
      />
    </section>
  )
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-dim">{k}</span>
      <span className="readout text-text">{v}</span>
    </div>
  )
}

const span = (from, to) => (to === null || from === to ? null : { a: Math.min(from, to), b: Math.max(from, to) })

function Legend({ hints, swing, subdivision, other = null, bands = false, spectrogram = false, spectraSeconds = null }) {
  const { t } = useTranslation()
  const items = [
    ['var(--red)', t('tempo.legend.lines')],
    ['var(--tempo)', t('tempo.legend.tempo')],
    ['var(--accent)', t('tempo.legend.onsets')],
    ['var(--line-strong)', t('tempo.legend.grid')],
    ...(subdivision > 1 ? [['var(--line)', t('listening.legendSubs', { n: subdivision })]] : []),
    ['var(--amber)', t('tempo.legend.drift')],
    ...(other ? [['var(--compare)', other]] : []),
    ...(spectrogram ? [['var(--muted)', t('tempo.spectrogram.legend')]] : []),
    ...(bands ? [['var(--text)', t('tempo.bands.legend')]] : []),
  ]
  return (
    <div className="space-y-1 border-t border-line px-3 py-2">
      {hints.map((hint) => (
        <p key={`h${hint.boundary_ms}`} className="text-caption text-amber">
          {t('tempo.hint', { from: formatClock(hint.from_ms), to: formatClock(hint.to_ms) })}
        </p>
      ))}
      {swing.map((s) => (
        <p key={`s${s.start_ms}`} className="text-caption text-tempo">
          {t('tempo.swing', { from: formatClock(s.start_ms), to: formatClock(s.end_ms), snap: s.snap ?? '–', late: s.late_ms ?? '–' })}
        </p>
      ))}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-dim">
        {items.map(([tone, label]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
            {label}
          </li>
        ))}
      </ul>
      {(bands || spectrogram) && (
        <p className="text-caption text-dim">
          {bands && t('tempo.bands.note')} {spectraSeconds !== null && t('tempo.layers.done', { seconds: spectraSeconds.toFixed(1) })}
        </p>
      )}
      <p className="hidden text-caption text-dim sm:block">{t('tempo.howTo')}</p>
      <p className="text-caption text-dim sm:hidden">{t('tempo.howToTouch')}</p>
    </div>
  )
}
