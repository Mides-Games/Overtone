# osu! Timing Analyzer v2

Local desktop app that extracts BPMs and offsets from audio, built for creating osu! red timing points. English is the default UI language (Español available in the dropdown). It will not promise impossible accuracy — music without clear percussion, rubato, swing and soft-transient production still needs manual review — but normal micro-fluctuations will not become BPM changes.

![stack](https://img.shields.io/badge/python-3.10%2B-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Install & run

```powershell
python -m pip install -r requirements.txt
python timing_analyzer.py
```

CLI analysis:

```powershell
python timing_analyzer.py "C:\path\song.wav" --delta 1.5 --persistence 12 --stats --csv timing.csv --click click.wav
```

- `--delta 1.5` is the minimum gap between the current tempo and a new one: 225 → 225.2 stays on one point, a sustained 225 → 227 is added.
- `--persistence 12` demands that many steady beats before a change is exported (kills false positives; raise to 20+ for constant-tempo songs, lower to 8 only when hunting very short sections manually).
- `--min-confidence 75` filters shaky sections.
- `--click click.wav` writes a metronome aligned to the red lines — **listen to it against the song** before mapping.
- `--stats` prints global BPM, stability, meter guess and every section.
- `--subdivision 2` forces the pulse octave (fixes half-time locks, e.g. 112 read instead of 225). Default `auto`.

GUI presets (detection card): **⚡ Variable** = 1.5 / 12 / 75 (default — songs that change often), **🛡 Steady** = 2.0 / 20 / 85 (constant-tempo songs, fewer false red lines).

For MP3/M4A/AAC install FFmpeg and make sure it is on `PATH`. WAV/FLAC/OGG usually open directly via SoundFile.

## How the detection works (v2 engine)

1. Mono 44.1 kHz load with peak normalization (SoundFile fast path, librosa fallback).
2. Normalized onset-strength envelope (`librosa.onset.onset_strength`, STFT-flux fallback).
3. **Hybrid beat tracking**: `beat_track` (tight DP) + PLP + peak-picking fallback compete; the most clock-regular candidate wins, then every beat is re-anchored to its nearest transient with parabolic **sub-frame** correction (no integer rounding — at 225 BPM one frame already spans ~2 % of tempo).
4. **Gap filling**: isolated dropped beats are interpolated when both sides agree on the tempo; long silences and abrupt jumps are never paved over.
5. **Local tempo** = median of neighbouring beat intervals (7-beat window) with MAD outlier rejection (a single missed beat cannot drag the curve).
6. **Half/double-time** is resolved with onset evidence at subdivided grid positions plus tempogram hypotheses — never blind ×2. An out-of-range pulse (e.g. 112) doubles on moderate evidence; an in-range one needs strong evidence.
7. **Segmentation** requires a `min_delta` gap sustained for `persistence` beats with one-outlier tolerance; confirmed starts **backtrack** to the midpoint crossing so red lines land on the change, not a dozen beats late. Confidence blends steadiness with section length.

Headline extras per analysis: **global BPM** (tempogram-guided, octave-aware), **stability score**, **meter guess** (4/4 vs 3/4 vs 6/8) and **pulse subdivision** (×1/×2/×4).

## Troubleshooting: reads exactly HALF the BPM (e.g. 112 instead of 225)

That is a *half-time lock*: the tracker settled on every-other beat. Two knock-on effects explain the rest — 225 vs 222.2 differ by only ~1.4 BPM at half speed (112.5 vs 111.1), which falls below `--delta` and collapses into one "constant" section, and integer-frame timing (±1 frame ≈ ±2 % at 225 BPM) blurs the two apart.

What changed in v2.1:

- The octave resolver now **disfavours out-of-range base pulses**: 112 (outside 120–300) only needs moderate in-between attack evidence to double to 224, while an in-range pulse still needs strong evidence.
- Beat times are **sub-frame** (parabolic transient correction, no integer rounding), so 225 vs 222.2 no longer flip-flops on frame quantization.
- Leading silence is trimmed so the first red line sits on the first attack, not at 0 ms.

If auto still locks half on your track (sparse drums, no off-beat content to anchor the doubling):

1. GUI: set **Pulse → ×2** and Analyze, or press the **×2** button after analyzing (instant, no re-tracking).
2. CLI: `python timing_analyzer.py song.mp3 --subdivision 2 --stats`.
3. Always export the click track and listen: a correct map clicks *with* the song; a halved one clicks every other beat.

## Known limits (honest audit)

- **Rubato / live drums / heavy swing**: no fixed grid exists; expect extra sections and fix by hand.
- **Half-time *feel* sections** (same grid, half energy): BPM correctly stays put — map the feel, not a new red line.
- **Sparse/breakdown bars**: the grid is interpolated through short gaps; breaks longer than ~8 beats restart the grid, so check the first offset after each break.
- **Songs that truly change pulse per section** (e.g. 128 verse → 140 half-time chorus): the pulse decision is global; fix that chorus with Pulse ×2/÷2 or `--subdivision`.
- **Compressed formats** (MP3/M4A/AAC) need FFmpeg on `PATH`; without it only WAV/FLAC/OGG decode.

## App features

- Stat cards: global BPM, sections (+ meter), beats, stability.
- Sortable results table (`# / offset / BPM / beat length / confidence`); click a row to highlight its section on the trace.
- **④ Edit timing points**: select a row to load offset/BPM, then Apply, Add, Delete (§1 is protected), nudge ±1/±5 ms, or **2× § / ÷2 §** per-section octave fix. Hand-added points carry 100 % confidence (you vouch for them).
- **Inject .osu…**: writes the red lines straight into a beatmap's `[TimingPoints]` — greens and everything else preserved byte-for-byte (CRLF-safe), `.bak` backup first, audio-filename mismatch warning, confirmation dialog. CLI: `--inject map.osu`.
- **Per-section pulse hints**: sections reading below 120 BPM with strong off-beat support are flagged in Details… (`§N: try ×2`) and under the editor — doubling stays one manual click, never automatic (a 112 half-time *feel* is often correct).
- Tempo-trace canvas: onset bed + tempo curve + section shading + red-line markers.
- One-click **Export CSV**, **Copy .osu** (`[TimingPoints]`-ready), **Click track…** (verification metronome), **Details…** (text report).
- **Tap tempo** card for a manual cross-check.
- Progress bar, background-thread analysis (UI never freezes), prefs + language persisted to `~/.timing_analyzer.json`.
- Shortcuts: `Ctrl+O` open, `Ctrl+C` copy points, `F5` analyze.
- Always verify the first beat and every transition in the osu! editor. For gradual tempo drifts, lower persistence or add manual points.

## Tests

```powershell
python -m unittest test_timing_analyzer -v
```

Covers segmentation, octave logic, grid snapping, English default, synthetic 128 BPM detection (±3 %), a 120→140 change, and click-track export.

## Resumen en español

La interfaz usa inglés por defecto; elige **Español** en el desplegable. El flujo recomendado: analiza → revisa la curva → exporta el click track → escúchalo contra la canción → pega los puntos rojos en `[TimingPoints]` → verifica offsets en el editor de osu!.

## License

MIT — do what you want, credit appreciated.
