# Phases 12–18 — Everything that makes the app comfortable to use

Weight is not a constraint. The MSI already carries ~1.15 GB of models; adding
another 200 MB of UI polish is not a category change. What matters is whether
a mapper who opens Overtone every day *enjoys* using it.

This document lists every dependency, every framework, and every subsystem
that would raise the comfort ceiling — graphical fidelity, keyboard flow,
theming, project persistence, accessibility, third-party integration. Each
one is evaluated on what it adds, its licence, its runtime cost, and how much
work the migration takes.

Everything here is **free-software**, offline, and bundleable in the same MSI
described in [`11-msi-distribution.md`](11-msi-distribution.md).

---

## Phase 12 — Modern desktop UI

The current stack is Tkinter. It cannot draw rounded corners, cannot
GPU-accelerate a timeline, cannot host a live spectrogram at 60 fps, and its
theming is limited to what ttk styles allow. All fixable by switching frontend
frameworks.

### The choice: PySide6 + pyqtgraph

Considered:

| Framework | Licence | Weight | Strength | Verdict |
|---|---|---|---|---|
| **PySide6** | LGPL-3.0 | ~100 MB | Native Qt6, cross-platform, GPU compositor, hardware-accel timeline | **Chosen.** Best fit for a DAW-adjacent app |
| PyQt6 | GPL/Commercial | ~100 MB | Same as PySide6, worse licence for MIT project | rejected on licence |
| Kivy | MIT | ~80 MB | Touch-first, mobile roots | not desktop-native enough |
| DearPyGui | MIT | ~30 MB | Immediate mode, extremely fast | too game-engine-like for a productivity app |
| customtkinter | MIT | ~5 MB | Tk with skinning | still Tk under the hood — no real GPU |
| Flet | Apache-2.0 | ~200 MB | Flutter for Python | web-shaped, not native |
| wxPython | wxWindows | ~40 MB | Native controls | dated feel; poor timeline story |

**PySide6** is the Qt for Python binding maintained by the Qt Company itself,
LGPL-3.0. It gives us:

- **QGraphicsScene** for the timeline canvas — a proper GPU-accelerated scene
  graph with retained-mode rendering. Zoom, scroll, rotate, animate with real
  transforms, not per-pixel Tk `create_line` calls.
- **QOpenGLWidget** for the spectrogram — 60 fps CQT display, live.
- **QML** for animated UI panels — sidebar transitions, hover cards, modals.
- **QSS** (Qt Style Sheets) — real theming, including gradients, drop
  shadows, per-widget rounded corners, and the whole design language of
  `docs/04-ui-ux.md`.
- **QAction / QShortcut** — full keyboard model with chords, remappable.
- **Native window frame** — real minimise/maximise/close buttons, real
  file-drag onto the window, real Windows integration (`QWinTaskbarButton`
  for progress in the taskbar).

### pyqtgraph for the timeline and spectrogram

**pyqtgraph** (MIT, ~15 MB) is what everyone in the scientific Python world
uses for real-time plotting on top of Qt. It draws the waveform, the onset
bed, the beat grid, the tempo curve, the spectrogram, and the attack markers
all on the same GPU-accelerated scene, at 60 fps, on a laptop.

Compared to matplotlib, pyqtgraph is 20–50× faster on identical plots. That
matters when the timeline scrolls smoothly through a 5-minute track.

### Sub-phase 12.1 — PySide6 shell and layout parity (5 days)

- Recreate the current window layout in PySide6 with QGridLayout.
- Port the results table to `QTableView` with a proper model.
- Port the timing-point editor to a `QFormLayout`.
- Port the tempo trace to a `pyqtgraph.PlotWidget`.
- Everything the current app does, in Qt, no regressions.

### Sub-phase 12.2 — QGraphicsScene timeline (7 days)

- Replace the flat canvas with a `QGraphicsScene`.
- Layers as `QGraphicsItemGroup`: waveform, onset bed, grid, attacks,
  sections, tempo curve, red lines, hitsound lanes.
- Zoom cursor-anchored, pan smooth, selection with rubber band.
- Layers toggleable from a legend.

### Sub-phase 12.3 — Real-time spectrogram (3 days)

- CQT computed once per audio, cached.
- `QOpenGLWidget` display, brightness / contrast / colour-map controls.
- Optional overlay on the waveform.

### Sub-phase 12.4 — Theming (4 days)

- QSS stylesheets for **three themes**:
  1. **Dark** ("Console": violet graphite, signal-cyan accent) — default. Built in the web
     shell on 2026-09-24, with its light counterpart.
  2. **Light** — the tokens from `docs/04-ui-ux.md` in reverse.
  3. **High contrast** — accessibility, WCAG AAA.
- User-defined themes: point the app at a QSS file, hot-reload on save.
- Font family and size configurable in Settings.

### Dependencies

```
pyside6                6.7.*      LGPL-3.0    ~100 MB
pyqtgraph              0.13.*     MIT         ~15 MB
qtawesome              1.3.*      MIT         ~5 MB   (Font Awesome / Material Design icons as QIcon)
qt-material            2.14.*     BSD-2       ~2 MB   (starter themes)
```

**Migration cost**: ~20 days. The engine is untouched; only the presentation
layer changes.

---

## Phase 13 — Audio playback engine

The current app writes a WAV click track and asks the user to open it in a
DAW. That is a symptom of not having playback. A mapper should hear the
audio + click *inside* Overtone, scrub it, loop a section, and edit live.

### The choice: sounddevice + a lock-free ring buffer

**sounddevice** (MIT, ~2 MB, wraps PortAudio) is the standard low-latency
audio library in Python. It provides:

- A callback that runs on the audio thread with a stable 5–10 ms buffer.
- Cross-platform WASAPI/ASIO/CoreAudio/ALSA backends.
- Sample-accurate playback position reporting.

### Sub-phase 13.1 — Transport (3 days)

- Play / pause / stop bound to Space, arrows for seek.
- Sample-accurate seek: no snapping to buffer boundaries.
- Volume, mute, stereo panning.

### Sub-phase 13.2 — Live click track (2 days)

- Click synthesised in the audio callback against the *current* timing
  points, not against a pre-rendered WAV.
- Edit a red line → the next click reflects it, no re-export.
- Accent per detected meter (fixes audit F-03 in the playback path too).

### Sub-phase 13.3 — Scrubbing and loop (2 days)

- Drag on the ruler to scrub. Hover to preview.
- Loop selection (Shift-drag).
- Loop current section (L key).

### Sub-phase 13.4 — Metronome tap capture (2 days)

- Tap tempo bound to Space during setup.
- Bar-position tap for the assisted mode of Phase 10.
- Latency compensation (measures the round-trip on first use).

### Sub-phase 13.5 — Waveform peaks pyramid (3 days)

- Min/max peaks pre-computed at LODs 256/1024/4096/16384 samples.
- Cache to disk keyed by `blake3(audio bytes)`.
- Timeline reads the LOD that matches its current zoom.

### Sub-phase 13.6 — MIDI input for tap (2 days)

- **mido** (MIT) + **python-rtmidi** (MIT) — MIDI in and out.
- Support any MIDI controller as a tap source (drum pads, keyboard).
- MIDI clock out — sync a hardware sequencer to Overtone's timing.

### Dependencies

```
sounddevice            0.5.*      MIT         ~2 MB
soundfile              0.13.*     BSD-3       already installed
numpy                  already installed
mido                   1.3.*      MIT         ~1 MB
python-rtmidi          1.5.*      MIT         ~3 MB
resampy                0.4.*      ISC         ~5 MB   (for resampling in playback)
```

**Migration cost**: ~14 days.

---

## Phase 14 — Project system

Right now everything lives in memory. Close the app and it's gone. A mapper
who spends 30 minutes hand-adjusting timing points wants that work saved,
recoverable after a crash, and portable to another machine.

### The choice: `.oto` project file, SQLite-backed, atomic writes

- Human-readable frontmatter (TOML) + a SQLite blob for large arrays
  (waveform peaks, spectrogram cache).
- Everything the app needs to reopen the project without recomputing.

### Sub-phase 14.1 — `.oto` project format (3 days)

- Format documented at `docs/13-project-format.md`.
- Includes: audio path (relative or absolute + hash), timing points with
  full metadata, undo history, UI state (which panels open, cursor
  position), user notes, analysis cache pointer.
- Atomic write via `os.replace`.
- Backup on save: last 5 versions kept.

### Sub-phase 14.2 — Auto-save + crash recovery (2 days)

- Journal of edits appended to `.oto.journal` on every change.
- On crash + restart, offer to replay the journal.
- Auto-save every 60 seconds if the project is dirty.

### Sub-phase 14.3 — Full undo/redo (3 days)

- Command pattern, every user action a command with `do`/`undo`.
- Multi-branch history (like a git tree) — you can undo, branch off,
  redo the other branch later.
- Persistent across app restarts via the journal.

### Sub-phase 14.4 — Batch processing (4 days)

- Queue of tracks to analyse, run in background.
- Windows toast notification when finished.
- Result table with sortable columns.
- "Retry failed" button.

### Sub-phase 14.4b — Organised output folders (2 days)

**The complaint that motivated this.** The current app writes exports wherever
the user's Save-As dialog lands, and the repo itself had `STK_timing_points.osu.txt`
sitting loose in the root. There is no consistent home for what Overtone
produces.

**The policy going forward.** Every artefact the app writes lives under a
central, discoverable location. The user never has to remember where anything
went.

The default layout, all under `%USERPROFILE%\Documents\Overtone\`:

```
Documents\Overtone\
├─ Exports\
│  ├─ <Artist> - <Title>\
│  │  ├─ <Version>.osu             # inject / snapshot exports
│  │  ├─ <Version>.osz             # full beatmap archives (Phase 5)
│  │  ├─ click_track.wav           # generated metronome
│  │  ├─ timing.csv                # tabular export
│  │  └─ report.pdf                # analysis report (Phase 17)
│  └─ index.sqlite                 # what was exported, when, from which project
├─ Projects\
│  ├─ <Artist> - <Title>.oto       # per-song project files (14.1)
│  └─ .autosave\                   # journals for crash recovery (14.2)
├─ Templates\                      # user report templates (17)
├─ Plugins\                        # user-installed plugins (17.1)
├─ Themes\                         # user-defined QSS themes (12.4)
└─ Screenshots\                    # in-app screenshot shortcut
```

**Rules the app enforces:**

- **Every "Export …" action defaults to the corresponding subfolder**, not
  to `%USERPROFILE%\Desktop\` or wherever the last dialog was. Save-As is
  offered as an alternative, never as the default.
- **The Artist / Title subfolder is created on first export for that song**
  and reused for every later export of the same song. All artefacts from
  one song sit together.
- **`Exports\index.sqlite`** records: what file was written, when, from
  which project, with which analysis version and confidence. The user can
  answer "when did I last export a click track for this song?" without
  digging.
- **Nothing lands loose next to the installed app.** The `Program Files\Overtone\`
  tree is read-only after install; user output never touches it.
- **The user can point the whole tree elsewhere** in Settings → Storage.
  Useful for a mapper who keeps everything on a project drive. Moving the
  root moves the layout, atomically.
- **The Recycle Bin is the escape valve**. Nothing overwrites without moving
  the previous version there first.

**Repository hygiene as part of this.** The one loose sample fixture in
the repo (`STK_timing_points.osu.txt`) has been moved to `fixtures/` where
new hand-timed samples will also live as the project grows.

### Sub-phase 14.5 — Advanced I/O (5 days)

- Import from Tempora `.tempora` project (their format is JSON).
- Import from Ableton Live warp markers (`.als` XML gzip).
- Import from Guitar Pro tempo track.
- Export to MIDI (`.mid`) with tempo track.
- Export to text tap list.
- Export to Praat / audio-tools TextGrid.
- Export analysis report to PDF (Phase 17).

### Dependencies

```
tomli-w                1.1.*      MIT         ~10 KB
peewee                 3.17.*     MIT         ~1 MB   (thin ORM over SQLite)
mido                   (already added in 13)
lxml                   5.*        BSD-3       ~8 MB   (Ableton .als parsing)
```

**Cost**: ~17 days.

---

## Phase 15 — Deep osu! integration

The app currently reads and writes `.osu`. It could do far more.

### Sub-phase 15.1 — osu! Songs browser (3 days)

- Sidebar panel with the user's `osu!/Songs/` folder tree.
- Search by artist / title / mapper.
- Drag a mapset onto the workspace to load it.
- Show ranked/loved/graveyard status from the local `osu!.db`.

### Sub-phase 15.2 — osu!lazer support (4 days)

- Parse the lazer database format (SQLite + realm).
- Read and write `.osu` v128 (lazer's version).
- Handle decimal offsets natively.
- Convert stable ↔ lazer where possible.

### Sub-phase 15.3 — Editor integration (2 days)

- "Open in osu! editor" button — spawns osu! with `--diff` pointed at the
  timed map.
- "Reload from editor" — if the user made changes in osu!, pull them back.

### Sub-phase 15.4 — Beatmap diff (2 days)

- Compare Overtone's proposal against an existing map's timing.
- Per-red-line diff view: offset, BPM, meter.
- One-click accept / reject per point.

### Sub-phase 15.5 — Custom sample library (3 days)

- Detect all `hitsound` samples in the user's skin.
- Preview any sample by clicking.
- Assign a sample to a hitsound category (Phase 6 hitsound engine).

### Dependencies

```
osu-db                 0.3.*      MIT         ~2 MB   (parse osu!stable's osu!.db)
sqlite3                stdlib     -           for lazer's realm export
```

**Cost**: ~14 days.

---

## Phase 16 — Localization and accessibility

Overtone already has English and Spanish. Nine more languages get it in
front of the whole international mapping community.

### Sub-phase 16.1 — Full i18n framework (3 days)

- **Babel** (BSD-3) + **gettext** — the standard.
- `.po` / `.mo` files per language.
- Language switcher in the app; hot-reload without restart.
- Numeric formatting (comma vs period decimals) locale-aware.

### Sub-phase 16.2 — Translations (rolling, community-driven)

Starter set from machine translation + native review:

- Japanese, Korean, Chinese (Simplified + Traditional), Portuguese (BR),
  French, German, Russian, Polish, Turkish, Vietnamese, Indonesian, Thai.

### Sub-phase 16.3 — Screen reader support (4 days)

- **QAccessible** interfaces on every widget.
- Tested with NVDA on Windows.
- Every visual signal has a text equivalent for a screen reader.

### Sub-phase 16.4 — Keyboard-only navigation (2 days)

- Every action reachable without a mouse.
- Focus rings visible.
- Configurable keyboard shortcuts editor.

### Sub-phase 16.5 — Font size and contrast (1 day)

- Font size slider in Settings, live preview.
- High-contrast theme (already in 12.4).
- Colour-blind palettes for the timeline (protanopia, deuteranopia,
  tritanopia).

### Dependencies

```
babel                  2.16.*     BSD-3       ~10 MB
pyside6-accessibility  bundled with pyside6
```

**Cost**: ~10 days plus rolling translation work.

---

## Phase 17 — Plugin API and reports

### Sub-phase 17.1 — Plugin API (5 days)

- Load Python modules from `%APPDATA%\Overtone\plugins\`.
- Restricted with `RestrictedPython` (ZPL-2.1, ~1 MB). Its own README says it
  "is not a sandbox system": plugins are opt-in, installed by the user, and
  trusted like any other code they install.
- Extension points: custom analyzer, custom exporter, custom theme, custom
  hitsound decision.
- Plugin manifest with declared permissions.

### Sub-phase 17.2 — Report generation (4 days)

- **PDF reports** via **ReportLab** (BSD-3, ~10 MB): analysis summary,
  timing points table, tempo trace, diagnostic notes.
- **HTML reports** via jinja2 (BSD-3, ~1 MB) with **plotly** (MIT, ~40 MB)
  interactive charts.
- Templates customizable in `%APPDATA%\Overtone\report_templates\`.

### Sub-phase 17.3 — Insights dashboard (3 days)

- Local usage stats: sessions, analyses, average project duration.
- Personal timing metrics: average error, most-used features.
- Nothing sent anywhere. Optional opt-out.

### Dependencies

```
RestrictedPython       7.4.*      ZPL-2.1     ~1 MB   (restricted execution — not a sandbox)
reportlab              4.2.*      BSD-3       ~10 MB
jinja2                 3.1.*      BSD-3       ~1 MB
plotly                 5.24.*     MIT         ~40 MB
kaleido                0.4.*      MIT         ~50 MB   (plotly-to-PNG for reports)
```

**Cost**: ~12 days.

---

## Phase 18 — Advanced input and multi-display

### Sub-phase 18.1 — Multi-monitor (2 days)

- Timeline can pop out into its own window.
- Second window holds the results table.
- Layouts saved per monitor configuration.

### Sub-phase 18.2 — Live audio input (3 days)

- Use `sounddevice` input side.
- Loopback capture on Windows via WASAPI loopback.
- Tap along to a song playing in another app; feed the taps to the assisted
  mode.

### Sub-phase 18.3 — Video preview (2 days)

- **python-vlc** (LGPL-2.1, uses installed VLC or bundled libVLC) or
  **ffpyplayer** (LGPL-3.0).
- Chosen: bundle libVLC (~40 MB) so no external install is needed.
- Play the map's video background synchronised with the audio and click.

### Sub-phase 18.4 — Gamepad and MIDI controller (2 days)

- **pygame.joystick** (LGPL-2.1) or **inputs** (BSD-3) for gamepads.
- Existing MIDI (Phase 13.6) extended to any Control Change.
- Configurable mappings.

### Dependencies

```
python-vlc             3.0.*      LGPL-2.1    ~2 MB (bindings) + libVLC ~40 MB
inputs                 0.5.*      BSD-3       ~1 MB (gamepad)
pygame                 2.6.*      LGPL-2.1    ~15 MB (fallback input)
```

**Cost**: ~9 days.

---

## Cumulative additions to the installer

| Component | Size |
|---|---:|
| PySide6 | ~100 MB |
| pyqtgraph | ~15 MB |
| qtawesome + icons | ~5 MB |
| sounddevice + PortAudio | ~2 MB |
| mido + python-rtmidi | ~4 MB |
| resampy | ~5 MB |
| ReportLab | ~10 MB |
| jinja2 | ~1 MB |
| plotly + kaleido | ~90 MB |
| libVLC + bindings | ~42 MB |
| lxml | ~8 MB |
| pygame | ~15 MB |
| Babel | ~10 MB |
| Icons, sounds, templates | ~15 MB |
| **Comfort dependencies total** | **~322 MB** |

Plus Phase 10's ~1.15 GB precision stack. Total MSI: **~1.5 GB**.

With Phase 10.13.4 size reduction applied (INT8 quantisation, drums-only
Demucs, no bundled madmom), the final installer lands around **~800 MB**.

## Timeline

| Phase | Days |
|---:|---:|
| 12 (Modern UI) | 20 |
| 13 (Audio playback) | 14 |
| 14 (Project system) | 17 |
| 15 (osu! integration) | 14 |
| 16 (i18n + a11y) | 10 |
| 17 (Plugins + reports) | 12 |
| 18 (Advanced input) | 9 |
| **Total** | **~96 days** |

Doable in parallel with the Phase 10 precision work. Each sub-phase is a
separate PR, orthogonal to the engine changes.

## Priority ordering

If forced to pick, order for maximum user delight per unit of work:

1. **Phase 12** (Modern UI) — the biggest first impression.
2. **Phase 13** (Playback + metronome) — makes the tool self-contained.
3. **Phase 14.1–14.3** (Project + auto-save + undo) — no more lost work.
4. **Phase 15.1–15.3** (osu! Songs, lazer, editor) — where mappers live.
5. **Phase 12.4** (Themes) — every user styles their tool.
6. Everything else, in whichever order makes sense at the time.

## What is deliberately *not* here

- **Cloud sync**. Offline-first policy holds.
- **Auto-updater**. No network at runtime.
- **Telemetry sent anywhere**. All stats stay local.
- **In-app store / marketplace**. Overtone is a tool, not a platform.
- **Web version**. Sub-phase, maybe, after the desktop app is stable.
