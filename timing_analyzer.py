"""Tempo map analyser for osu! beatmapping.

The detector estimates beat locations first and only then derives tempo from
several adjacent beat intervals.  This is substantially less jumpy than using
one global BPM estimate, while the persistence and delta filters prevent tiny
performance/drift variations from becoming red timing points.
"""
from __future__ import annotations

import argparse
import csv
import os
import queue
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import median_filter


@dataclass(frozen=True)
class TimingPoint:
    offset_ms: float
    bpm: float
    confidence: float
    beat_index: int


@dataclass
class Analysis:
    source: str
    duration: float
    beats: np.ndarray
    local_bpms: np.ndarray
    points: list[TimingPoint]
    hop_length: int
    sample_rate: int
    subdivision: int


def _robust_local_bpms(beats: np.ndarray, radius: int = 4) -> np.ndarray:
    """Use a median of neighbouring beat intervals to reject missed/noisy hits."""
    intervals = np.diff(beats)
    raw = 60.0 / np.maximum(intervals, 1e-5)
    width = min(len(raw) if len(raw) % 2 else len(raw) - 1, radius * 2 + 1)
    smooth = median_filter(raw, size=max(1, width), mode="nearest")
    # One output per beat; copy the last local tempo to its trailing beat.
    return np.append(smooth, smooth[-1])


def _segment_tempi(beats: np.ndarray, bpms: np.ndarray, min_delta: float,
                    persistence: int) -> list[TimingPoint]:
    """Create stable tempo regions from beat-level estimates.

    A candidate must differ from the current region by ``min_delta`` and stay
    near its own median for ``persistence`` beats.  The start is backdated to
    the first candidate beat, important for accurate red-line placement.
    """
    if len(beats) == 0:
        return []
    points: list[TimingPoint] = []
    start, current = 0, float(np.median(bpms[:min(len(bpms), persistence)]))

    def add(index: int, tempo: float, region: np.ndarray) -> None:
        spread = float(np.median(np.abs(region - np.median(region)))) if len(region) else 0.0
        confidence = max(0.0, min(1.0, 1.0 - spread / max(tempo * 0.04, 0.5)))
        points.append(TimingPoint(float(beats[index] * 1000), float(tempo), confidence, index))

    add(0, current, bpms[:persistence])
    i = persistence
    while i < len(bpms):
        candidate = float(np.median(bpms[i:min(i + persistence, len(bpms))]))
        stable = bpms[i:min(i + persistence, len(bpms))]
        is_stable = len(stable) >= persistence and np.max(np.abs(stable - candidate)) < max(min_delta, candidate * 0.012)
        if is_stable and abs(candidate - current) >= min_delta:
            # Confirm it is a meaningful, sustained new tempo.
            add(i, candidate, stable)
            start, current = i, candidate
            i += persistence
        else:
            i += 1

    # Refine each displayed BPM using its complete assigned region.
    refined: list[TimingPoint] = []
    for n, point in enumerate(points):
        end = points[n + 1].beat_index if n + 1 < len(points) else len(bpms)
        tempo = float(np.median(bpms[point.beat_index:end]))
        refined.append(TimingPoint(point.offset_ms, tempo, point.confidence, point.beat_index))
    # Refinement can make two initially distinct noisy regions converge. Do
    # not export a red line unless its final BPM still clears the filter.
    final = [refined[0]]
    for point in refined[1:]:
        if abs(point.bpm - final[-1].bpm) >= min_delta:
            final.append(point)
    return final


def _subdivision_support(onset: np.ndarray, beat_frames: np.ndarray, factor: int) -> float:
    """Measure whether attacks exist at the proposed grid positions."""
    if factor == 1:
        positions = beat_frames.astype(float)
    else:
        # Score only *new* positions. Including the already-detected beats
        # would make an empty half-time grid look strong by construction.
        positions = np.concatenate([np.linspace(a, b, factor, endpoint=False)[1:]
                                    for a, b in zip(beat_frames[:-1], beat_frames[1:])])
    values = []
    for index in np.rint(positions).astype(int):
        values.append(float(np.max(onset[max(0, index - 2):min(len(onset), index + 3)])))
    return float(np.median(values))


def _choose_subdivision(onset: np.ndarray, beat_frames: np.ndarray,
                        prefer_map_bpm: bool) -> int:
    """Resolve half/double-time with onset evidence, not blind multiplication."""
    if len(beat_frames) < 4:
        return 1
    base_bpm = 60.0 / np.median(np.diff(beat_frames)) * 44100.0 / 256.0
    base_support = max(_subdivision_support(onset, beat_frames, 1), 1e-9)
    best_factor, best_score = 1, 1.0
    for factor in (2, 4):
        bpm = base_bpm * factor
        support_ratio = _subdivision_support(onset, beat_frames, factor) / base_support
        # A bounded mapping-range preference only breaks close calls. Missing
        # in-between attacks can never force a doubled BPM.
        range_bonus = 0.22 if prefer_map_bpm and 120 <= bpm <= 300 else 0.0
        score = support_ratio + range_bonus
        if support_ratio >= 0.42 and score > best_score:
            best_factor, best_score = factor, score
    return best_factor


def _insert_subdivisions(beat_frames: np.ndarray, factor: int) -> np.ndarray:
    if factor == 1:
        return beat_frames
    pieces = [np.linspace(a, b, factor, endpoint=False) for a, b in zip(beat_frames[:-1], beat_frames[1:])]
    return np.rint(np.append(np.concatenate(pieces), beat_frames[-1])).astype(int)


def _fast_onset_envelope(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Fast spectral-flux envelope, independent of the slow beat tracker."""
    _, _, spectrum = signal.stft(y, fs=sr, nperseg=1024, noverlap=1024 - hop,
                                 boundary=None, padded=False)
    magnitude = np.abs(spectrum)
    return np.maximum(np.diff(magnitude, axis=1), 0).mean(axis=0).astype(np.float32)


def _peak_beats(onset: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Find musical attacks and reconstruct occasional missing beats."""
    frame_rate = sr / hop
    prominence = float(np.percentile(onset, 65))
    peaks, _ = signal.find_peaks(onset, distance=max(1, round(frame_rate * 0.18)),
                                 prominence=max(prominence, 1e-8))
    if len(peaks) < 8:
        return peaks.astype(int)
    gaps = np.diff(peaks)
    typical = float(np.median(gaps[(gaps > frame_rate * 0.18) & (gaps < frame_rate * 0.42)]))
    if not np.isfinite(typical) or typical <= 0:
        return peaks.astype(int)
    rebuilt = [int(peaks[0])]
    for left, right in zip(peaks[:-1], peaks[1:]):
        count = max(1, int(round((right - left) / typical)))
        rebuilt.extend(np.rint(np.linspace(left, right, count + 1)[1:]).astype(int).tolist())
    return np.asarray(rebuilt, dtype=int)


def analyze_audio(path: str | os.PathLike[str], min_delta: float = 1.5,
                  persistence: int = 8, prefer_map_bpm: bool = True,
                  min_confidence: float = 0.90,
                  progress: Callable[[str], None] | None = None) -> Analysis:
    """Analyse an audio file and return stable timing points.

    Most common formats work when libsndfile supports them.  For MP3/M4A and
    other compressed formats, install FFmpeg so librosa can use its fallback.
    """
    if min_delta <= 0 or persistence < 2 or not 0 <= min_confidence <= 1:
        raise ValueError("La diferencia mínima debe ser positiva, la persistencia al menos 2 y la confianza entre 0 y 100 %.")
    say = progress or (lambda _message: None)
    say("Cargando y normalizando el audio…")
    try:
        # SoundFile decodes this MP3 directly and avoids an unnecessary,
        # expensive resample when the source is already at 44.1 kHz.
        y, sr = sf.read(path, dtype="float32", always_2d=False)
        if y.ndim == 2:
            y = np.mean(y, axis=1, dtype=np.float32)
        if sr != 44100:
            y = librosa.resample(y, orig_sr=sr, target_sr=44100, res_type="soxr_hq")
            sr = 44100
    except Exception as primary_error:
        try:
            y, sr = librosa.load(path, sr=44100, mono=True, res_type="soxr_hq")
        except Exception as exc:
            raise RuntimeError(
                "No se pudo decodificar el audio. Para MP3/M4A/AAC instala FFmpeg y agrégalo a PATH; "
                "WAV/FLAC/OGG deberían abrirse directamente."
            ) from exc
    if len(y) < sr * 2:
        raise ValueError("El audio debe durar al menos dos segundos.")
    say("Extrayendo transitorios y beats…")
    hop = 256  # 5.8 ms at 44.1 kHz: adequate timing-grid resolution for mapping.
    onset = _fast_onset_envelope(y, sr, hop)
    beat_frames = _peak_beats(onset, sr, hop)
    if len(beat_frames) < 8:
        raise ValueError("No se detectaron suficientes beats. Prueba un archivo con percusión más clara.")
    say("Resolviendo si el pulso detectado es half-time…")
    subdivision = _choose_subdivision(onset, beat_frames, prefer_map_bpm)
    beat_frames = _insert_subdivisions(beat_frames, subdivision)
    # Direct conversion avoids invoking a secondary backend for a trivial
    # frame-to-seconds operation.
    beat_times = beat_frames.astype(np.float64) * hop / sr
    say("Calculando tempo local y cambios persistentes…")
    local = _robust_local_bpms(beat_times)
    # Remove clearly impossible detections before segmentation; osu maps rarely use these.
    valid = (local >= 30) & (local <= 600)
    if valid.sum() < 8:
        raise ValueError("El tempo detectado está fuera del rango utilizable.")
    candidates = _segment_tempi(beat_times[valid], local[valid], min_delta, persistence)
    points = [point for point in candidates if point.confidence >= min_confidence]
    return Analysis(str(path), len(y) / sr, beat_times[valid], local[valid], points, hop, sr, subdivision)


def export_csv(analysis: Analysis, destination: str | os.PathLike[str]) -> None:
    with open(destination, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["offset_ms", "bpm", "beat_index", "confidence"])
        writer.writerows((f"{p.offset_ms:.3f}", f"{p.bpm:.6f}", p.beat_index, f"{p.confidence:.3f}") for p in analysis.points)


def snap_timing_points(points: list[TimingPoint]) -> list[TimingPoint]:
    """Place each tempo change on the previous section's beat grid.

    osu! continues a red-line grid until the next red line.  Audio detection
    can find a transition a few milliseconds beside the attack; snapping it
    to the nearest beat of the preceding section avoids accumulated phase
    errors without inserting a timing point for every beat.
    """
    if not points:
        return []
    snapped = [points[0]]
    for point in points[1:]:
        previous = snapped[-1]
        beat_length = 60000.0 / previous.bpm
        beat_count = max(1, round((point.offset_ms - previous.offset_ms) / beat_length))
        offset = previous.offset_ms + beat_count * beat_length
        snapped.append(TimingPoint(offset, point.bpm, point.confidence, point.beat_index))
    return snapped


def osu_timing_text(analysis: Analysis) -> str:
    """Return uninherited (red) timing points ready for an .osu [TimingPoints] section."""
    # osu! only guarantees comments on their own lines.  Do not append a human
    # annotation after the Effects field: some parsers treat it as invalid.
    rows = ["// Generated by osu! Timing Analyzer"]
    for p in snap_timing_points(analysis.points):
        beat_length = 60000.0 / p.bpm
        rows.append(f"{p.offset_ms:.3f},{beat_length:.12f},4,1,0,100,1,0")
    return "\n".join(rows)


class TimingAnalyzerApp:
    TEXT = {
        "Español": {"title": "osu! Timing Analyzer", "subtitle": "BPM y offsets precisos para tu beatmap",
                    "language": "Idioma", "audio": "Archivo de audio", "open": "Abrir audio",
                    "delta": "Cambio mínimo (BPM)", "persistence": "Beats de confirmación",
                    "quality": "Confianza mínima (%)", "overview": "VISTA PREVIA DE TEMPO",
                    "preference": "Preferir BPM de mapa (120–300)", "analyze": "Analizar",
                    "csv": "Exportar CSV", "copy": "Copiar puntos .osu", "offset": "Offset (ms)",
                    "confidence": "Confianza", "hint": "1,5 BPM evita cambios como 225 → 225,2. Ajusta solo si el cambio es musicalmente real.",
                    "ready": "Selecciona un audio para comenzar.", "bad_file": "Selecciona un archivo de audio válido.",
                    "bad_values": "Los parámetros deben ser números válidos.", "preparing": "Preparando análisis…",
                    "error": "Error: {value}", "done": "Listo: {points} timing points, {beats} beats; pulso {mode}.",
                    "first": "Analiza un audio primero.", "saved": "CSV guardado: {path}",
                    "copied": "Puntos rojos copiados. Pégalos en [TimingPoints] de tu .osu.",
                    "normal": "normal", "confirmed": "x{factor} (subdivisión confirmada)", "all_audio": "Archivos de audio", "all": "Todos los archivos"},
        "English": {"title": "osu! Timing Analyzer", "subtitle": "Precise BPM and offsets for your beatmap",
                    "language": "Language", "audio": "Audio file", "open": "Open audio",
                    "delta": "Minimum change (BPM)", "persistence": "Confirmation beats",
                    "quality": "Minimum confidence (%)", "overview": "TEMPO PREVIEW",
                    "preference": "Prefer map BPM (120–300)", "analyze": "Analyze",
                    "csv": "Export CSV", "copy": "Copy .osu points", "offset": "Offset (ms)",
                    "confidence": "Confidence", "hint": "1.5 BPM ignores changes such as 225 → 225.2. Adjust only for musically real changes.",
                    "ready": "Choose an audio file to begin.", "bad_file": "Choose a valid audio file.",
                    "bad_values": "Parameters must be valid numbers.", "preparing": "Preparing analysis…",
                    "error": "Error: {value}", "done": "Done: {points} timing points, {beats} beats; pulse {mode}.",
                    "first": "Analyze audio first.", "saved": "CSV saved: {path}",
                    "copied": "Red timing points copied. Paste them in [TimingPoints] in your .osu file.",
                    "normal": "normal", "confirmed": "x{factor} (confirmed subdivision)", "all_audio": "Audio files", "all": "All files"},
    }

    def __init__(self) -> None:
        import tkinter as tk
        from tkinter import ttk
        self.tk, self.ttk = tk, ttk
        self.root = tk.Tk()
        self.root.minsize(860, 600)
        self.file, self.delta, self.persistence = tk.StringVar(), tk.StringVar(value="1.5"), tk.StringVar(value="20")
        self.minimum_confidence = tk.StringVar(value="90")
        self.language = tk.StringVar(value="Español")
        self.prefer_map_bpm = tk.BooleanVar(value=True)
        self.status = tk.StringVar()
        self.analysis: Analysis | None = None
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.widgets: dict[str, object] = {}
        self._theme()
        self._build()
        self._translate()

    def tr(self, key: str, **values: object) -> str:
        return self.TEXT[self.language.get()][key].format(**values)

    def _theme(self) -> None:
        style = self.ttk.Style(self.root)
        style.theme_use("clam")
        bg, panel, field, fg, muted, accent = "#090b10", "#11151d", "#181d27", "#edf2f7", "#9aa7b8", "#7c5cff"
        self.root.configure(bg=bg)
        style.configure("TFrame", background=bg)
        style.configure("Panel.TFrame", background=panel)
        style.configure("TLabel", background=bg, foreground=fg, font=("Segoe UI", 10))
        style.configure("Title.TLabel", background=bg, foreground=fg, font=("Segoe UI Semibold", 21))
        style.configure("Subtitle.TLabel", background=bg, foreground=muted, font=("Segoe UI", 10))
        style.configure("Hint.TLabel", background=panel, foreground=muted, font=("Segoe UI", 9))
        style.configure("Status.TLabel", background=panel, foreground="#b8c4d6", font=("Segoe UI", 10))
        style.configure("TEntry", fieldbackground=field, foreground=fg, insertcolor=fg, padding=8)
        style.configure("TCombobox", fieldbackground=field, background=field, foreground=fg, padding=6)
        style.map("TCombobox", fieldbackground=[("readonly", field)], foreground=[("readonly", fg)])
        style.configure("TCheckbutton", background=panel, foreground=fg, font=("Segoe UI", 10))
        style.map("TCheckbutton", background=[("active", panel)], foreground=[("active", fg)])
        style.configure("TButton", background="#252c38", foreground=fg, borderwidth=0, relief="flat", padding=(15, 9), font=("Segoe UI Semibold", 10))
        style.map("TButton", background=[("active", "#343d4d")])
        style.configure("Accent.TButton", background=accent, foreground="#ffffff", borderwidth=0, relief="flat", padding=(18, 9), font=("Segoe UI Semibold", 10))
        style.map("Accent.TButton", background=[("active", "#947dff")])
        style.configure("Treeview", background=panel, fieldbackground=panel, foreground=fg, rowheight=31, borderwidth=0, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", background="#1d2430", foreground=muted, relief="flat", font=("Segoe UI Semibold", 10), padding=(10, 8))
        style.map("Treeview", background=[("selected", "#322b59")], foreground=[("selected", fg)])

    def _build(self) -> None:
        ttk = self.ttk
        root = ttk.Frame(self.root, padding=(28, 24), style="TFrame")
        root.pack(fill="both", expand=True)
        header = ttk.Frame(root)
        header.grid(row=0, column=0, columnspan=6, sticky="ew")
        ttk.Label(header, style="Title.TLabel", text="osu! TIMING ANALYZER").pack(side="left")
        self.widgets["language"] = ttk.Label(header)
        self.widgets["language"].pack(side="right", padx=(0, 8))
        language_menu = ttk.Combobox(header, textvariable=self.language, values=("Español", "English"), state="readonly", width=11)
        language_menu.pack(side="right"); language_menu.bind("<<ComboboxSelected>>", lambda _event: self._translate())
        self.widgets["subtitle"] = ttk.Label(root, style="Subtitle.TLabel")
        self.widgets["subtitle"].grid(row=1, column=0, columnspan=6, sticky="w", pady=(2, 20))
        panel = ttk.Frame(root, padding=18, style="Panel.TFrame")
        panel.grid(row=2, column=0, columnspan=6, sticky="ew")
        self.widgets["audio"] = ttk.Label(panel, style="Hint.TLabel"); self.widgets["audio"].grid(row=0, column=0, sticky="w")
        ttk.Entry(panel, textvariable=self.file).grid(row=1, column=0, columnspan=4, sticky="ew", padx=(0, 10), pady=(4, 14))
        self.widgets["open"] = ttk.Button(panel, command=self.choose); self.widgets["open"].grid(row=1, column=4, sticky="ew", pady=(4, 14))
        self.widgets["delta"] = ttk.Label(panel, style="Hint.TLabel"); self.widgets["delta"].grid(row=2, column=0, sticky="w")
        ttk.Entry(panel, textvariable=self.delta, width=10).grid(row=3, column=0, sticky="w", pady=(4, 0))
        self.widgets["persistence"] = ttk.Label(panel, style="Hint.TLabel"); self.widgets["persistence"].grid(row=2, column=1, sticky="w")
        ttk.Entry(panel, textvariable=self.persistence, width=10).grid(row=3, column=1, sticky="w", pady=(4, 0))
        self.widgets["quality"] = ttk.Label(panel, style="Hint.TLabel"); self.widgets["quality"].grid(row=2, column=2, sticky="w")
        ttk.Entry(panel, textvariable=self.minimum_confidence, width=8).grid(row=3, column=2, sticky="w", pady=(4, 0))
        self.widgets["preference"] = ttk.Checkbutton(panel, variable=self.prefer_map_bpm); self.widgets["preference"].grid(row=2, column=3, columnspan=2, sticky="w")
        self.widgets["analyze"] = ttk.Button(panel, command=self.run, style="Accent.TButton"); self.widgets["analyze"].grid(row=3, column=3, sticky="e")
        self.widgets["csv"] = ttk.Button(panel, command=self.save_csv); self.widgets["csv"].grid(row=3, column=4, sticky="e", padx=(8, 0))
        panel.columnconfigure(0, weight=1); panel.columnconfigure(2, weight=1)
        action = ttk.Frame(root)
        action.grid(row=3, column=0, columnspan=6, sticky="ew", pady=(16, 10))
        self.widgets["copy"] = ttk.Button(action, command=self.copy_osu); self.widgets["copy"].pack(side="right")
        status_panel = ttk.Frame(root, padding=(14, 10), style="Panel.TFrame")
        status_panel.grid(row=4, column=0, columnspan=6, sticky="ew", pady=(0, 14))
        ttk.Label(status_panel, textvariable=self.status, style="Status.TLabel").pack(anchor="w")
        self.widgets["overview"] = ttk.Label(root, style="Hint.TLabel")
        self.widgets["overview"].grid(row=5, column=0, columnspan=6, sticky="w", pady=(0, 5))
        cols = ("offset", "bpm", "confidence")
        self.table = ttk.Treeview(root, columns=cols, show="headings", height=14)
        self.table.grid(row=6, column=0, columnspan=5, sticky="nsew")
        scroll = ttk.Scrollbar(root, orient="vertical", command=self.table.yview)
        scroll.grid(row=6, column=5, sticky="ns"); self.table.configure(yscrollcommand=scroll.set)
        self.preview = self.tk.Canvas(root, height=116, bg="#11151d", highlightthickness=0)
        self.preview.grid(row=7, column=0, columnspan=6, sticky="ew", pady=(14, 0))
        self.preview.bind("<Configure>", lambda _event: self._draw_preview())
        self.widgets["hint"] = ttk.Label(root, style="Hint.TLabel", wraplength=780)
        self.widgets["hint"].grid(row=8, column=0, columnspan=6, sticky="w", pady=(12, 0))
        root.columnconfigure(0, weight=1); root.columnconfigure(4, weight=1); root.rowconfigure(6, weight=1)

    def _translate(self) -> None:
        self.root.title(self.tr("title"))
        for key in ("language", "subtitle", "audio", "open", "delta", "persistence", "quality", "preference", "analyze", "csv", "copy", "hint", "overview"):
            self.widgets[key].configure(text=self.tr(key))  # type: ignore[union-attr]
        for key in ("offset", "bpm", "confidence"):
            self.table.heading(key, text=self.tr(key) if key != "bpm" else "BPM")
        if not self.analysis:
            self.status.set(self.tr("ready"))

    def choose(self) -> None:
        from tkinter import filedialog
        value = filedialog.askopenfilename(filetypes=[(self.tr("all_audio"), "*.wav *.flac *.ogg *.mp3 *.m4a *.aac *.opus *.aiff"), (self.tr("all"), "*.*")])
        if value: self.file.set(value)

    def run(self) -> None:
        if not Path(self.file.get()).is_file():
            self.status.set(self.tr("bad_file")); return
        try:
            delta, persistence = float(self.delta.get()), int(self.persistence.get())
            confidence = float(self.minimum_confidence.get()) / 100
            if not 0 <= confidence <= 1:
                raise ValueError
        except ValueError:
            self.status.set(self.tr("bad_values")); return
        self.status.set(self.tr("preparing"))
        threading.Thread(target=self._worker, args=(delta, persistence, self.prefer_map_bpm.get(), confidence), daemon=True).start()
        self.root.after(100, self._poll)

    def _worker(self, delta: float, persistence: int, prefer_map_bpm: bool, confidence: float) -> None:
        try:
            result = analyze_audio(self.file.get(), delta, persistence, prefer_map_bpm, confidence, lambda x: self.events.put(("status", x)))
            self.events.put(("done", result))
        except Exception as exc: self.events.put(("error", str(exc)))

    def _poll(self) -> None:
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "status": self.status.set(self._localize_engine_message(str(value)))
                elif kind == "error": self.status.set(self.tr("error", value=self._localize_engine_message(str(value))))
                else:
                    self.analysis = value  # type: ignore[assignment]
                    for item in self.table.get_children(): self.table.delete(item)
                    for p in self.analysis.points:
                        self.table.insert("", "end", values=(f"{p.offset_ms:.3f}", f"{p.bpm:.6f}", f"{p.confidence:.0%}"))
                    mode = self.tr("normal") if self.analysis.subdivision == 1 else self.tr("confirmed", factor=self.analysis.subdivision)
                    self.status.set(self.tr("done", points=len(self.analysis.points), beats=len(self.analysis.beats), mode=mode))
                    self._draw_preview()
        except queue.Empty:
            self.root.after(100, self._poll)

    def save_csv(self) -> None:
        if not self.analysis: self.status.set(self.tr("first")); return
        from tkinter import filedialog
        target = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")])
        if target: export_csv(self.analysis, target); self.status.set(self.tr("saved", path=target))

    def copy_osu(self) -> None:
        if not self.analysis: self.status.set(self.tr("first")); return
        self.root.clipboard_clear(); self.root.clipboard_append(osu_timing_text(self.analysis))
        self.status.set(self.tr("copied"))

    def _localize_engine_message(self, message: str) -> str:
        if self.language.get() == "Español":
            return message
        translations = {"Cargando y normalizando el audio…": "Loading and normalizing audio…",
                        "Extrayendo transitorios y beats…": "Extracting attacks and beats…",
                        "Resolviendo si el pulso detectado es half-time…": "Resolving whether the detected pulse is half-time…"}
        return translations.get(message, message)

    def _draw_preview(self) -> None:
        """Show the local tempo trace before the mapper exports its points."""
        canvas = self.preview
        canvas.delete("all")
        width, height = max(canvas.winfo_width(), 1), max(canvas.winfo_height(), 1)
        canvas.create_text(14, 14, anchor="w", fill="#9aa7b8", font=("Segoe UI", 9), text="TEMPO TRACE · BPM")
        if not self.analysis or len(self.analysis.local_bpms) < 2:
            canvas.create_text(width / 2, height / 2 + 8, fill="#657184", font=("Segoe UI", 10), text="Analyze an audio file to preview its tempo trace")
            return
        values, times = self.analysis.local_bpms, self.analysis.beats
        low, high = np.quantile(values, [0.05, 0.95])
        if high - low < 0.5:
            low, high = low - 1, high + 1
        pad_x, top, bottom = 14, 28, height - 12
        duration = max(float(times[-1]), 0.001)
        coords: list[float] = []
        for time, bpm in zip(times, values):
            x = pad_x + (width - pad_x * 2) * float(time) / duration
            y = bottom - (bottom - top) * float(np.clip((bpm - low) / (high - low), 0, 1))
            coords.extend((x, y))
        if len(coords) >= 4:
            canvas.create_line(*coords, fill="#7c5cff", width=2, smooth=True)
        for point in self.analysis.points:
            x = pad_x + (width - pad_x * 2) * (point.offset_ms / 1000) / duration
            canvas.create_line(x, top, x, bottom, fill="#4bd4a4", width=1)

    def start(self) -> None:
        self.root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Analizador de BPM y offsets para osu!")
    parser.add_argument("audio", nargs="?", help="Audio a analizar (sin argumento abre la interfaz)")
    parser.add_argument("--delta", type=float, default=1.5, help="Cambio mínimo de BPM (por defecto 1.5)")
    parser.add_argument("--persistence", type=int, default=20, help="Beats necesarios para confirmar cambio")
    parser.add_argument("--min-confidence", type=float, default=90, help="Confianza mínima de puntos exportados (0–100; por defecto 90)")
    parser.add_argument("--csv", help="Ruta CSV de salida")
    parser.add_argument("--no-map-preference", action="store_true", help="No preferir BPM de mapeo 120–300 al resolver half-time")
    args = parser.parse_args()
    if not args.audio:
        TimingAnalyzerApp().start(); return
    analysis = analyze_audio(args.audio, args.delta, args.persistence, not args.no_map_preference,
                             args.min_confidence / 100, print)
    print(osu_timing_text(analysis))
    if args.csv: export_csv(analysis, args.csv)


if __name__ == "__main__":
    main()
