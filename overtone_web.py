"""Overtone web shell: the app's UI as HTML/CSS in a native WebView2 window.

The Tk GUI in ``overtone.py`` cannot draw rounded corners, soft
shadows or a GPU-composited timeline; a web view can, and the same frontend
(``app/``) moves unchanged to Tauri when the Rust engine replaces this Python
backend. The engine is not touched here: this module is a thin bridge that
calls exactly what the Tk GUI calls (``analyze_audio``, ``snap_timing_points``,
``rebuild_with_subdivision``) and turns the result into JSON.

Run it with the repo interpreter::

    .venv/Scripts/python.exe overtone_web.py [audio-file]

Preferences are shared with the Tk GUI through ``~/.overtone.json``, so both
frontends remember the same file and detection settings.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sqlite3
import sys
import threading
from pathlib import Path

import numpy as np

import overtone as ta
import overtone_library
import overtone_rust

HERE = Path(__file__).resolve().parent
APP_DIR = HERE / "app"
ICON_ICO = HERE / "assets" / "logo.ico"
LOGO_PNG = HERE / "assets" / "logo.png"

AUDIO_TYPES = ("Audio files (*.wav;*.flac;*.ogg;*.mp3;*.m4a;*.aac;*.opus;*.aiff)",
               "All files (*.*)")
OSU_TYPES = ("osu! beatmap (*.osu)", "All files (*.*)")
CSV_TYPES = ("CSV (*.csv)", "All files (*.*)")
WAV_TYPES = ("WAV (*.wav)", "All files (*.*)")
OSZ_TYPES = ("osu! beatmap package (*.osz)", "All files (*.*)")
#: Dropped files are staged here so "analyze the last song", the song header
#: and .osz export keep working after the drag: a temp file that vanishes
#: after the analysis would leave all three pointing at nothing.
DROP_DIR = Path(os.environ.get("LOCALAPPDATA", str(HERE))) / "Overtone" / "drops"
PULSE_FACTORS = {"auto": 0.0, "/4": 0.25, "/2": 0.5, "x1": 1.0, "x2": 2.0, "x4": 4.0}
#: What the page is told a song is, so WebAudio knows how to decode it.
AUDIO_MIME = {".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg",
              ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
              ".opus": "audio/ogg", ".aiff": "audio/aiff"}
#: .osu offsets as whole ms (stable) up to this many decimals (lazer).
MAX_OFFSET_DECIMALS = 3
#: The interface's scale, as a factor of its designed size.
UI_SCALE_RANGE = (0.8, 1.5)
#: Themes the page knows; "system" follows Windows' app mode. Dark is the
#: default, so nobody's window changes colour on an update.
THEMES = ("system", "dark", "light")
#: A tap calibration past this is not latency but taps that missed the click.
TAP_LATENCY_LIMIT_MS = 250.0
#: The trace needs the shape of the onset envelope, not its 40 k frames.
ONSET_BINS = 1600
LOOSE_RESIDUAL_MS = 5.0


# ---------------------------------------------------------------------------
# Payload: Analysis -> JSON-safe dict
# ---------------------------------------------------------------------------

def _pool_max(values: np.ndarray, bins: int) -> np.ndarray:
    """Max-pool to ``bins`` buckets so a narrow attack survives downsampling."""
    values = np.asarray(values, dtype=np.float64)
    if values.size <= bins:
        return values
    edges = np.linspace(0, values.size, bins + 1).astype(np.int64)
    return np.maximum.reduceat(values, edges[:-1])


def _warnings(analysis: ta.Analysis) -> list[dict]:
    """Things a mapper must check by ear before trusting the numbers.

    The engine owns every point-level rule (``validate_timing_points`` is the
    single source of truth, so the Tk GUI will read the same findings when it
    is wired); the shell only adds the two result-level notes the engine has
    no keys for — fallback engine and loose grid.
    """
    notes: list[dict] = []
    note = getattr(analysis, "backend_note", "")
    if note:
        notes.append({"level": "info", "key": "warn_rust_fallback", "values": {"why": note}})
    if analysis.engine != "precision":
        notes.append({"level": "warn", "key": "warn_legacy"})
    for finding in ta.validate_timing_points(analysis):
        values = dict(finding["values"])
        values["n"] = finding["index"] + 1
        notes.append({"level": "info" if finding["level"] == "info" else "warn",
                      "key": "v_" + finding["key"], "values": values})
    if analysis.engine == "precision" and analysis.fit_residual_ms > LOOSE_RESIDUAL_MS:
        notes.append({"level": "info", "key": "warn_loose",
                      "values": {"ms": f"{analysis.fit_residual_ms:.1f}"}})
    return notes


def analysis_payload(analysis: ta.Analysis, click: dict | None = None) -> dict:
    """Everything the frontend draws, as plain JSON types. ``click`` carries
    the metronome settings (``subdivision``, ``accent``) the clicks follow.

    Points are snapped exactly as the Tk table and the exporters snap them, so
    what the user reads is what gets written to the .osu.
    """
    points = ta.snap_timing_points(analysis.points)
    beats = np.asarray(analysis.beats, dtype=np.float64)
    local = np.asarray(analysis.local_bpms, dtype=np.float64)
    onset = np.asarray(analysis.onset, dtype=np.float64)
    frame_s = analysis.hop_length / float(analysis.sample_rate) if analysis.sample_rate else 0.0
    pooled = _pool_max(onset, ONSET_BINS)
    peak = float(pooled.max()) if pooled.size else 0.0
    return {
        "source": Path(analysis.source).name,
        "path": str(analysis.source),
        "duration": float(analysis.duration),
        "global_bpm": float(analysis.global_bpm),
        "stability": float(analysis.stability),
        "meter": analysis.meter,
        "engine": analysis.engine,
        # Which implementation produced it: results predating the choice, and
        # every v3 run, read "python".
        "backend": getattr(analysis, "backend", "python"),
        "subdivision": float(analysis.subdivision),
        "residual_ms": float(analysis.fit_residual_ms),
        "beat_count": int(beats.size),
        "points": [{"offset_ms": p.offset_ms, "bpm": p.bpm,
                    "beat_ms": 60000.0 / p.bpm if p.bpm > 0 else 0.0,
                    "confidence": p.confidence, "meter": p.meter,
                    "meter_known": p.meter_known} for p in points],
        "sections": [{"start_s": s.start_s, "end_s": s.end_s, "bpm": s.bpm,
                      "residual_ms": s.residual_ms, "coverage": s.coverage}
                     for s in analysis.sections],
        "trace": {"t": beats.round(4).tolist(),
                  "bpm": local.round(3).tolist() if local.size == beats.size else []},
        "onset": {"span_s": float(onset.size * frame_s),
                  "v": (pooled / peak).round(3).tolist() if peak > 0 else []},
        "warnings": _warnings(analysis),
        # The live click plays the schedule the WAV export writes, and the
        # payload is rebuilt on every edit, so the click follows the edits.
        "clicks": _clicks(analysis, click or {}),
        # What red lines snap to when dragged, and what the drift lane plots.
        "attacks": _attacks_payload(analysis),
    }


def _attacks_payload(analysis: ta.Analysis) -> dict:
    """The detected attacks, to 0.01 ms, with weights scaled to the strongest.
    Empty for a fallback result, which keeps none."""
    times = np.asarray(getattr(analysis, "attack_times", []), dtype=np.float64)
    weights = np.asarray(getattr(analysis, "attack_weights", []), dtype=np.float64)
    if times.size == 0 or weights.size != times.size:
        return {"t": [], "w": []}
    peak = float(weights.max()) if weights.size else 0.0
    scaled = weights / peak if peak > 0 else np.zeros_like(weights)
    return {"t": times.round(5).tolist(), "w": scaled.round(3).tolist()}


def _clicks(analysis: ta.Analysis, click: dict) -> dict:
    """The click schedule as two flat lists: seconds (to the microsecond)
    and each click's level (2 bar, 1 beat, 0 subdivision)."""
    try:
        schedule = ta.click_schedule(analysis, subdivision=int(click.get("subdivision", 1)),
                                     accent=bool(click.get("accent", True)))
    except (ValueError, TypeError, AttributeError):
        schedule = []
    return {"t": [round(t, 6) for t, _level in schedule],
            "level": [level for _t, level in schedule]}


def _default_songs() -> Path:
    """Where osu! (stable) keeps its songs when installed with the defaults.
    Read when asked, so a test that moves LOCALAPPDATA moves it too."""
    return Path(os.environ.get("LOCALAPPDATA", str(HERE))) / "osu!" / "Songs"


def _wav_bytes(path: Path) -> bytes:
    """Overtone's own decode of a song as a 16-bit mono WAV, in memory."""
    import io
    y, sr = ta._load_audio(path, lambda _message: None)
    buffer = io.BytesIO()
    ta.sf.write(buffer, y, sr, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def _default_output() -> Path:
    """Documents / Overtone: where exports go unless told otherwise, never next
    to the app (the output-file policy, roadmap 14.4b). Read when asked."""
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    return home / "Documents" / "Overtone"


#: WAV format tags osu!'s audio library plays and a browser does not: Ogg
#: Vorbis wrapped in a RIFF header (0x674F "Og" up to 0x6771). 5 of 20,000
#: local .wav samples were one; the Ogg stream inside is intact.
OGG_IN_WAV_TAGS = range(0x674F, 0x6772)


def _playable_sample(data: bytes) -> bytes:
    """A sample's bytes as a browser can decode them: an Ogg stream wrapped
    in a WAV header is handed over without the wrapper; anything else as is."""
    fmt = data.find(b"fmt ", 0, 64)
    if data[:4] == b"RIFF" and fmt >= 0 and len(data) >= fmt + 10:
        tag = int.from_bytes(data[fmt + 8:fmt + 10], "little")
        start = data.find(b"OggS")
        if tag in OGG_IN_WAV_TAGS and start >= 0:
            return data[start:]
    return data


def _open_link(link: str) -> None:
    """Hand a local protocol link (``osu://``) to the program registered for it.
    Raises OSError when none is, so the UI can say osu! is not installed."""
    if sys.platform == "win32":
        os.startfile(link)  # noqa: S606 -- a validated osu:// link, nothing else
    else:
        raise OSError("Opening osu! links is supported on Windows only.")


def _logo_uri() -> str:
    try:
        return "data:image/png;base64," + base64.b64encode(LOGO_PNG.read_bytes()).decode("ascii")
    except OSError:
        return ""


def _number(value: object, default, cast):
    """A hand-edited config must not stop the window from opening."""
    try:
        number = cast(float(value))
    except (TypeError, ValueError):
        return default
    return number if np.isfinite(number) else default


# ---------------------------------------------------------------------------
# Bridge exposed to JavaScript as window.pywebview.api
# ---------------------------------------------------------------------------

class Api:
    """Every public method is callable from JS and returns JSON types.

    Attributes are underscored on purpose: pywebview walks public attributes
    of the js_api object, and the window must not be one of them.
    """

    def __init__(self, initial_file: str = "", autorun: bool = False) -> None:
        self._window = None
        self._autorun = bool(initial_file) and autorun
        self._analysis: ta.Analysis | None = None
        self._busy = threading.Lock()
        self._cfg = ta.load_config()
        #: Undo/redo stacks: snapshots of the point list before each mutation.
        #: A fresh analysis replaces the whole map, so it clears both.
        self._history: list[list] = []
        self._future: list[list] = []
        #: Locked points, by value: the editor refuses them and a fresh
        #: analysis re-merges them, so a verified red line survives both.
        #: Value-based on purpose — neighbours can come and go without
        #: shifting anything, and undo/redo re-match by offset.
        self._locked: list[dict] = []
        #: (source, times, weights) detected for a reference grade when the
        #: engine that answered kept no attacks.
        self._ref_attacks: tuple | None = None
        #: The last assisted fit that was answered, waiting for "Add to timing".
        self._assisted: dict | None = None
        #: The song's bytes while the page fetches them for playback.
        self._audio_bytes: bytes | None = None
        #: The percussive stem's WAV bytes with the analysis that made them:
        #: HPSS costs seconds once, then rides the cache like structure.
        self._percussion: tuple | None = None
        #: Held while the library index scans, so two scans never interleave.
        self._scanning = threading.Lock()
        #: The Rust engine's structure report, keyed by (path, size, mtime):
        #: the audio is read once, the bars are re-applied on every call.
        self._structure: tuple[tuple, dict] | None = None
        #: The engine-evidence report for the live analysis object: attacks
        #: and sections never move under edits, so identity is the key.
        self._evidence: tuple | None = None
        #: The decision's proposal units, keyed by .osu name: proposing runs
        #: the CLI once, and accept/reject iterates the cache. A moved map
        #: refuses at apply time through the proposal's own staleness guard.
        self._decisions: dict[str, dict] = {}
        #: The last ramp fit, keyed by (analysis, drift, max lines): computing
        #: shells to the CLI, and Use reads the cache.
        self._ramps: tuple | None = None
        #: The bytes one hitsound apply replaced, for the one-level undo.
        self._decide_undo: dict | None = None
        if initial_file:
            self._cfg["file"] = initial_file

    #: Cap, so an evening of nudging cannot grow memory without bound.
    UNDO_DEPTH = 50

    def _push_history(self) -> None:
        if self._analysis is None:
            return
        self._history.append(list(self._analysis.points))
        del self._history[:-self.UNDO_DEPTH]
        self._future.clear()

    def history_state(self) -> dict:
        return {"undo": bool(self._history), "redo": bool(self._future)}

    def undo(self) -> dict:
        """Restore the point list from before the last edit."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not self._history:
            return {"ok": False, "key": "no_undo"}
        self._future.append(list(self._analysis.points))
        self._analysis.points = self._history.pop()
        self._prune_locks()
        return {"ok": True, "result": self._payload(),
                "selected": -1, "locks": self._lock_offsets(), **self.history_state()}

    def redo(self) -> dict:
        """Re-apply an undone edit. Any new edit discards the redo stack."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not self._future:
            return {"ok": False, "key": "no_redo"}
        self._history.append(list(self._analysis.points))
        self._analysis.points = self._future.pop()
        self._prune_locks()
        return {"ok": True, "result": self._payload(),
                "selected": -1, "locks": self._lock_offsets(), **self.history_state()}

    # -- state -----------------------------------------------------------
    def state(self) -> dict:
        cfg = self._cfg
        preset = ta.TimingAnalyzerApp.PRESETS["variable"]
        # Same migration as the Tk GUI: v1 configs stored conservative steady
        # values, so their detection numbers are dropped for the v2 defaults.
        tuned = int(cfg.get("cfg_version", 1)) >= ta.TimingAnalyzerApp.CFG_VERSION
        if not tuned:
            cfg = {k: v for k, v in cfg.items() if k not in ("delta", "persistence", "confidence")}
        file = str(cfg.get("file", "") or "")
        autorun, self._autorun = self._autorun, False  # fires once, not on reload
        return {
            "version": ta.APP_VERSION,
            "language": "es" if cfg.get("language") == "Español" else "en",
            "file": self._file_info(file) if file else None,
            "options": {
                "delta": _number(cfg.get("delta"), float(preset["delta"]), float),
                "persistence": _number(cfg.get("persistence"), int(preset["persistence"]), int),
                "confidence": _number(cfg.get("confidence"), float(preset["confidence"]), float),
                "pulse": self._pulse_key(str(cfg.get("pulse", "Auto"))),
                "prefer_map_bpm": bool(cfg.get("prefer_map_bpm", True)),
                "refine_beats": bool(cfg.get("refine_beats", True)),
                "engine": "rust" if cfg.get("engine") == "rust" else "python",
            },
            # The Rust engine is opt-in and only offered where it is built.
            "rust_available": overtone_rust.find_cli() is not None,
            "presets": ta.TimingAnalyzerApp.PRESETS,
            # pywebview serves app/ as the web root, so ../assets is out of
            # reach; the one image the page needs travels as a data URI.
            "logo": _logo_uri(),
            # A file handed over on the command line ("Open with Overtone") is
            # analysed straight away; the user asked for exactly that file.
            "autorun": autorun,
            "recent": self._recent(),
            "playback": self._playback(),
        }

    #: How many recent files the empty state offers back.
    RECENT_LIMIT = 8

    def _recent(self) -> list:
        """Remembered files that still exist, most recent first."""
        seen, out = set(), []
        for path in self._cfg.get("recent", []):
            if path not in seen and Path(str(path)).is_file():
                seen.add(path)
                out.append(self._file_info(str(path)))
        return out[:self.RECENT_LIMIT]

    def set_language(self, code: str) -> None:
        self._cfg["language"] = "Español" if code == "es" else "English"
        self._persist()

    def pick_audio(self) -> dict | None:
        import webview
        if self._window is None:
            return None
        chosen = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=AUDIO_TYPES)
        if not chosen:
            return None
        path = chosen[0] if isinstance(chosen, (list, tuple)) else str(chosen)
        self._cfg["file"] = path
        self._persist()
        return self._file_info(path)

    # -- analysis ----------------------------------------------------------
    def analyze(self, path: str, options: dict) -> dict:
        """Start an analysis on a worker thread; results arrive as JS events."""
        if not Path(path).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            params = self._params(options)
        except (TypeError, ValueError, KeyError):
            return {"ok": False, "key": "bad_values"}
        return self._launch(path, params, options)

    def analyze_bytes(self, filename: str, data_b64: str, options: dict) -> dict:
        """Analyse a file dragged onto the window.

        JavaScript cannot hand over a local path (the File API deliberately
        hides it), so the bytes travel as base64 and are staged under
        ``DROP_DIR`` first. From there on it is exactly an ``analyze``: the
        staged copy becomes the remembered file, so re-analysing, the header
        and .osz export all work.
        """
        try:
            raw = base64.b64decode(data_b64, validate=True)
        except ValueError:
            return {"ok": False, "key": "bad_drop"}
        if len(raw) > ta.MAX_OSZ_AUDIO_BYTES:
            return {"ok": False, "key": "too_big"}
        try:
            params = self._params(options)
        except (TypeError, ValueError, KeyError):
            return {"ok": False, "key": "bad_values"}
        DROP_DIR.mkdir(parents=True, exist_ok=True)
        stem = Path(str(filename)).name[:80] or "audio.wav"
        target = DROP_DIR / stem
        for n in range(2, 1000):
            if not target.exists():
                break
            target = DROP_DIR / f"{target.stem}-{n}{target.suffix}"
        try:
            target.write_bytes(raw)
        except OSError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        reply = self._launch(str(target), params, options)
        if not reply.get("ok"):
            try:
                target.unlink()
            except OSError:
                pass
        return reply

    def _launch(self, path: str, params: dict, options: dict) -> dict:
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        self._remember(path, options)
        threading.Thread(target=self._worker, args=(path, params), daemon=True).start()
        return {"ok": True}

    def rescale(self, mult: float) -> dict:
        """Instant x2 / /2 on the current result, as the Tk header buttons do."""
        analysis = self._analysis
        if analysis is None:
            return {"ok": False, "key": "first"}
        if not analysis.sections and analysis.base_frames is None:
            return {"ok": False, "key": "no_grid"}
        target = float(analysis.subdivision) * float(mult)
        factor = min(ta.ALLOWED_FACTORS, key=lambda f: abs(np.log2(f / target)))
        params = self._params(self.state()["options"])
        try:
            rebuilt = ta.rebuild_with_subdivision(
                analysis, factor, params["min_delta"], params["persistence"],
                params["min_confidence"])
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis = rebuilt
        for lock in self._locked:
            lock["bpm"] *= rebuilt.subdivision / analysis.subdivision
        return {"ok": True, "result": self._payload(),
                "locks": self._lock_offsets(), **self.history_state()}

    # -- point locks (Phase 4: a verified point survives edits and re-analysis)
    def _lock_offsets(self) -> list:
        return [lock["offset_ms"] for lock in self._locked]

    def _is_locked(self, index) -> bool:
        if self._analysis is None:
            return False
        try:
            point = self._analysis.points[int(index)]
        except (ValueError, TypeError, IndexError):
            return False
        return any(abs(lock["offset_ms"] - point.offset_ms) < 1e-6
                   for lock in self._locked)

    def _prune_locks(self) -> None:
        """Drop locks whose point is gone (only undo can remove one: locked
        points refuse delete, and every other edit keeps offsets). A pruned
        lock stays pruned — redo brings the point back, not the lock."""
        if self._analysis is None:
            self._locked.clear()
            return
        offsets = [p.offset_ms for p in self._analysis.points]
        self._locked = [lock for lock in self._locked
                        if any(abs(lock["offset_ms"] - offset) < 1e-6
                               for offset in offsets)]

    def locks(self) -> dict:
        return {"locks": self._lock_offsets()}

    def set_locked(self, index: int, locked: bool) -> dict:
        """Pin or release one point. Locked points refuse the editor."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            point = self._analysis.points[int(index)]
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if locked:
            if not self._is_locked(index):
                self._locked.append({"offset_ms": point.offset_ms, "bpm": point.bpm,
                                     "meter": point.meter, "meter_known": point.meter_known})
        else:
            self._locked = [lock for lock in self._locked
                            if abs(lock["offset_ms"] - point.offset_ms) >= 1e-6]
        return {"ok": True, "locked": self._is_locked(index),
                "locks": self._lock_offsets()}

    # -- manual editing (same helpers, same guards as the Tk editor) -----
    def _edited(self, index: int | None, seek: float | None) -> dict:
        points = self._analysis.points if self._analysis is not None else []
        if not points:
            selected = -1
        elif seek is None:
            selected = max(0, min(int(index), len(points) - 1))
        else:
            selected = min(range(len(points)),
                           key=lambda n: abs(points[n].offset_ms - seek))
        return {"ok": True, "result": self._payload(),
                "selected": selected, "locks": self._lock_offsets(),
                **self.history_state()}

    def edit_apply(self, index: int, offset_ms: float, bpm: float) -> dict:
        """Replace one point's offset/BPM, like the Tk editor's Apply."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._is_locked(index):
            return {"ok": False, "key": "locked"}
        try:
            index = int(index)
            offset = float(offset_ms)
            points = ta.update_timing_point(
                self._analysis.points, self._analysis.beats, index, offset, float(bpm))
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return self._edited(index, offset)

    def edit_add(self, offset_ms: float, bpm: float) -> dict:
        """Insert a hand-placed point, keeping the list sorted by offset."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            offset = float(offset_ms)
            points = ta.add_timing_point(
                self._analysis.points, self._analysis.beats, offset, float(bpm))
        except (ValueError, TypeError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return self._edited(None, offset)

    def edit_delete(self, index: int) -> dict:
        """Remove one point. The first point anchors the map and stays."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._is_locked(index):
            return {"ok": False, "key": "locked"}
        try:
            index = int(index)
            points = ta.delete_timing_point(self._analysis.points, index)
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return self._edited(index, None)

    def edit_nudge(self, index: int, delta_ms: float) -> dict:
        """Shift one point's offset; it stops at 0 ms coming from after it."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._is_locked(index):
            return {"ok": False, "key": "locked"}
        try:
            index = int(index)
            before = self._analysis.points[index].offset_ms
            target = before + float(delta_ms)
            points = ta.nudge_timing_point(
                self._analysis.points, self._analysis.beats, index, float(delta_ms))
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return self._edited(index, target)

    def edit_rescale(self, index: int, factor: float) -> dict:
        """Multiply one section's BPM (per-section x2//2 fix)."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._is_locked(index):
            return {"ok": False, "key": "locked"}
        try:
            index = int(index)
            points = ta.rescale_section(
                self._analysis.points, index, float(factor))
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return self._edited(index, None)

    # -- exports and .osu injection (same engine calls as the Tk GUI) -----
    def osu_text(self) -> dict:
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        return {"ok": True, "text": ta.osu_timing_text(
            self._analysis, decimals=self._settings()["offset_decimals"])}

    def save_csv(self) -> dict:
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        target = self._export_target("overtone-timing.csv", CSV_TYPES)
        if not target:
            return {"ok": False, "key": "cancelled"}
        try:
            ta.export_csv(self._analysis, target)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "path": target}

    def save_click(self) -> dict:
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        target = self._export_target("overtone-click.wav", WAV_TYPES)
        if not target:
            return {"ok": False, "key": "cancelled"}
        try:
            s = self._settings()
            ta.export_click_track(self._analysis, target, subdivision=s["click_subdivision"],
                                  accent=s["click_accent"])
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "path": target}

    def save_osz(self) -> dict:
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        audio = self._cfg.get("file") or self._analysis.source
        stem = Path(str(audio)).stem or "overtone"
        target = self._export_target(f"{stem}.osz", OSZ_TYPES)
        if not target:
            return {"ok": False, "key": "cancelled"}
        try:
            info = ta.export_osz(self._analysis, target, audio_path=audio,
                                 decimals=self._settings()["offset_decimals"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "path": target, "points": info["points"]}

    def pick_osu(self, directory: str = "") -> str | None:
        import webview
        if self._window is None:
            return None
        chosen = self._window.create_file_dialog(
            webview.OPEN_DIALOG, directory=directory or "", file_types=OSU_TYPES)
        if not chosen:
            return None
        return chosen[0] if isinstance(chosen, (list, tuple)) else str(chosen)

    def pick_folder(self) -> str | None:
        import webview
        if self._window is None:
            return None
        chosen = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if not chosen:
            return None
        return chosen[0] if isinstance(chosen, (list, tuple)) else str(chosen)

    def import_folder(self, folder: str) -> dict:
        """Scan a beatmap folder and adopt its audio as the current file.

        The difficulties stay listed (compare picker opens there), the audio
        becomes the remembered file so Analyze just works. A folder with maps
        but no readable audio still reports its beatmaps — there is nothing to
        analyse, but plenty to compare once audio arrives.
        """
        if not Path(str(folder)).is_dir():
            return {"ok": False, "key": "bad_folder"}
        try:
            scan = ta.scan_beatmap_folder(folder)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if not scan["audio"]:
            return {"ok": True, "folder": scan["folder"], "file": None,
                    "beatmaps": scan["beatmaps"]}
        self._cfg["file"] = scan["audio"]
        self._persist()
        return {"ok": True, "folder": scan["folder"],
                "file": self._file_info(scan["audio"]),
                "beatmaps": scan["beatmaps"]}

    def mapset_check(self, folder: str) -> dict:
        """Every difficulty of a beatmap folder side by side, for the Mapset view.

        Read only and independent of the analysis: a set can be checked
        before any song is analysed, and nothing is remembered or written.
        """
        if not Path(str(folder)).is_dir():
            return {"ok": False, "key": "bad_folder"}
        try:
            report = ta.mapset_report(folder)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report, "folder": Path(str(folder)).name}

    def audio_check(self, folder: str) -> dict:
        """Facts and stated bars for a mapset folder's own audio. Read only,
        no analysis needed: the file the maps name, or a refusal."""
        base = Path(str(folder))
        if not base.is_dir():
            return {"ok": False, "key": "bad_folder"}
        try:
            scanned = ta.scan_beatmap_folder(base)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if not scanned["audio"]:
            return {"ok": False, "key": "ms_no_audio"}
        try:
            report = ta.audio_file_report(Path(scanned["audio"]))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report}

    # -- audio swap: one mapset's times onto a new encode ---------------------
    @staticmethod
    def _swap_files(folder: str, old_audio: str, new_audio: str):
        """The two audio paths inside ``folder``, or a refusal."""
        base = Path(str(folder))
        if not base.is_dir():
            return {"ok": False, "key": "bad_folder"}
        old, new = str(old_audio or ""), str(new_audio or "")
        if Path(old).name != old or Path(new).name != new:
            return {"ok": False, "key": "bad_file"}
        old_path, new_path = base / old, base / new
        if old_path.suffix.lower() not in ta.AUDIO_EXTENSIONS or not old_path.is_file():
            return {"ok": False, "key": "bad_file"}
        if new_path.suffix.lower() not in ta.AUDIO_EXTENSIONS or not new_path.is_file():
            return {"ok": False, "key": "bad_file"}
        if old_path == new_path:
            return {"ok": False, "key": "sw_same_file"}
        try:
            maps = sorted(p for p in base.iterdir() if p.suffix.lower() == ".osu")
        except OSError:
            maps = []
        if not maps:
            return {"ok": False, "key": "ms_no_maps"}
        return old_path, new_path, maps

    def swap_audios(self, folder: str) -> dict:
        """The audio files of a mapset folder, with the one its maps name.
        Read only, no analysis needed."""
        base = Path(str(folder))
        if not base.is_dir():
            return {"ok": False, "key": "bad_folder"}
        try:
            audios = sorted(p.name for p in base.iterdir()
                            if p.suffix.lower() in ta.AUDIO_EXTENSIONS and p.is_file())
            current = ""
            for path in sorted(base.iterdir()):
                if path.suffix.lower() != ".osu":
                    continue
                try:
                    header = ta.read_osu_beatmap(path)["general"]
                except (ValueError, OSError):
                    continue
                current = str(header.get("AudioFilename", "")).strip()
                if current:
                    break
        except OSError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "audios": audios, "current": current}

    def swap_preview(self, folder: str, old_audio: str, new_audio: str) -> dict:
        """The shift between two encodes plus what moving the set would move.
        Decoding two songs is one heavy job at a time; nothing is written."""
        found = self._swap_files(folder, old_audio, new_audio)
        if isinstance(found, dict):
            return found
        old_path, new_path, maps = found
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            shift = ta.audio_shift(old_path, new_path)
            preview = ta.preview_audio_swap(maps, shift["shift_ms"],
                                            self._settings()["offset_decimals"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        return {"ok": True, "old": old_path.name, "new": new_path.name,
                "shift": shift, "maps": preview["maps"], "refused": preview["refused"]}

    def swap_apply(self, folder: str, old_audio: str, new_audio: str) -> dict:
        """Move every time of every difficulty by the measured shift, each
        file backed up first and logged. Refusals write nothing."""
        found = self._swap_files(folder, old_audio, new_audio)
        if isinstance(found, dict):
            return found
        old_path, new_path, maps = found
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            shift = ta.audio_shift(old_path, new_path)
            done = ta.apply_audio_swap(maps, shift["shift_ms"], new_path.name,
                                       decimals=self._settings()["offset_decimals"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        return {"ok": True, "old": old_path.name, "new": new_path.name,
                "shift": shift, "maps": done["maps"]}

    # -- hitsound playback (Phase 6, P-3) ------------------------------------
    def song_maps(self) -> dict:
        """The difficulties beside the analysed song that play this audio,
        for the transport's hitsound picker."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        source = Path(str(self._analysis.source))
        maps = []
        try:
            files = sorted(p for p in source.parent.iterdir() if p.suffix.lower() == ".osu")
        except OSError:
            files = []
        for path in files:
            try:
                header = overtone_library.read_osu_header(path)
            except (OSError, ValueError):
                continue
            if header["audio_file"].lower() == source.name.lower():
                maps.append({"file": path.name, "difficulty": header["version"] or path.stem,
                             "mode": header["mode"], "objects": header["objects"]})
        return {"ok": True, "maps": maps}

    def hitsound_playback(self, file: str) -> dict:
        """Every sound of one difficulty beside the song, with the bytes of
        each sample it plays, for the page to schedule on its own clock.
        Only a .osu in the analysed song's folder is read."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        folder = Path(str(self._analysis.source)).parent
        name = str(file or "")
        path = folder / name
        if Path(name).name != name or not name.lower().endswith(".osu") or not path.is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            plan = ta.hitsound_playback(ta.read_osu_beatmap(path), folder)
            samples = {}
            for key, sample in plan["samples"].items():
                data = _playable_sample(Path(sample["path"]).read_bytes())
                samples[key] = {"source": sample["source"], "name": Path(sample["path"]).name,
                                "data": base64.b64encode(data).decode("ascii")}
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": name,
                "events": {"t": [e["t"] for e in plan["events"]],
                           "keys": [e["keys"] for e in plan["events"]],
                           "volume": [e["volume"] for e in plan["events"]],
                           "adds": [e["adds"] for e in plan["events"]]},
                "objects": {"t": [o["t"] for o in plan["objects"]],
                            "end": [o["end"] for o in plan["objects"]],
                            "kind": [o["kind"] for o in plan["objects"]]},
                "samples": samples, "counts": plan["counts"]}

    def hitsound_report(self, file: str) -> dict:
        """One difficulty beside the song, sound by sound: its place in the
        bar and where each addition falls (H2). Read only."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        folder = Path(str(self._analysis.source)).parent
        name = str(file or "")
        path = folder / name
        if Path(name).name != name or not name.lower().endswith(".osu") or not path.is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            report = ta.hitsound_report(ta.read_osu_beatmap(path))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": name, "report": report}

    # -- hitsound copier (Phase 6, H1) ---------------------------------------
    @staticmethod
    def _copy_paths(folder: str, source: str, targets: list) -> tuple[Path, list[Path]] | dict:
        """The source and target .osu paths, all inside ``folder``, or a refusal."""
        base = Path(str(folder))
        if not base.is_dir():
            return {"ok": False, "key": "bad_folder"}
        if not isinstance(targets, list) or not targets:
            return {"ok": False, "key": "hs_no_targets"}
        paths = []
        for name in [source, *targets]:
            name = str(name or "")
            path = base / name
            if (Path(name).name != name or not name.lower().endswith(".osu")
                    or not path.is_file()):
                return {"ok": False, "key": "bad_file"}
            paths.append(path)
        if paths[0] in paths[1:] or len(set(paths[1:])) != len(paths) - 1:
            return {"ok": False, "key": "hs_same_file"}
        return paths[0], paths[1:]

    def _copy_plan(self, folder: str, source: str, targets: list, options: dict) -> dict:
        found = self._copy_paths(folder, source, targets)
        if isinstance(found, dict):
            return found
        source_path, target_paths = found
        volumes = bool((options or {}).get("volumes"))
        try:
            source_map = ta.read_osu_beatmap(source_path)
            plans = []
            for path in target_paths:
                report = ta.copy_hitsounds(source_map, ta.read_osu_beatmap(path), volumes=volumes)
                plans.append((path, report))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "plans": plans}

    @staticmethod
    def _copy_row(path: Path, report: dict) -> dict:
        return {"file": path.name, "objects": len(report["changes"]),
                **{k: report[k] for k in ("target_sounds", "matched", "changed", "unmatched",
                                          "unmatched_times", "index_conflicts")}}

    def hitsound_copy_preview(self, folder: str, source: str, targets: list,
                              options: dict | None = None) -> dict:
        """What copying ``source``'s hitsounds onto each target would change.
        Read only: nothing is written."""
        plan = self._copy_plan(folder, source, targets, options or {})
        if not plan["ok"]:
            return plan
        return {"ok": True, "source": str(source),
                "targets": [self._copy_row(path, report) for path, report in plan["plans"]]}

    def hitsound_copy_apply(self, folder: str, source: str, targets: list,
                            options: dict | None = None) -> dict:
        """Copy ``source``'s hitsounds onto each target .osu, as the preview
        said: only hitsound fields change, each file is backed up first."""
        plan = self._copy_plan(folder, source, targets, options or {})
        if not plan["ok"]:
            return plan
        rows = []
        for path, report in plan["plans"]:
            try:
                written = ta.write_object_hitsounds(path, report["changes"])
            except (ValueError, OSError) as exc:
                return {"ok": False, "key": "error", "detail": f"{path.name}: {exc}",
                        "done": rows}
            rows.append({**self._copy_row(path, report), "written": written["written"],
                         "backup": written["backup"]})
        return {"ok": True, "source": str(source), "targets": rows}

    # -- hitsound decision (Phase 6, H5) --------------------------------------
    @staticmethod
    def _decide_key(unit: dict) -> tuple:
        return (unit.get("object"), unit.get("part"), unit.get("edge"))

    def _decide_file(self, file: str):
        """The .osu path inside the analysed song's folder, or a refusal."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        name = str(file or "")
        path = Path(str(self._analysis.source)).parent / name
        if Path(name).name != name or not name.lower().endswith(".osu") or not path.is_file():
            return {"ok": False, "key": "bad_file"}
        return path

    def hitsound_decide_propose(self, file: str) -> dict:
        """Propose every decidable point's sound through the Rust sidecar.
        One heavy job at a time; the units stay cached for accept/reject."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            report = overtone_rust.hitsound(str(self._analysis.source), str(path))
        except overtone_rust.SidecarUnavailable:
            return {"ok": False, "key": "no_rust"}
        except (RuntimeError, ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        units = report.get("units", [])
        self._decisions[str(path.name)] = {"units": units}
        return {"ok": True, "file": str(path.name), "units": units}

    def hitsound_decide_preview(self, file: str, accept: list | None = None) -> dict:
        """What applying the cached proposal would change. Read only."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        cached = self._decisions.get(str(path.name))
        if cached is None:
            return {"ok": False, "key": "no_proposal"}
        try:
            accepted = None if accept is None else {tuple(a) for a in accept}
            preview = ta.preview_proposals(ta.read_osu_beatmap(path), cached["units"], accepted)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": str(path.name), "units": preview["units"],
                "accepted": preview["accepted"], "would_change": preview["would_change"]}

    def hitsound_decide_apply(self, file: str, accept: list | None = None,
                              copy: bool = False) -> dict:
        """Write the accepted proposals through P-2: over the original with a
        backup, or onto a ``<name>_hitsounded.osu`` copy that must not exist.
        Remembers the replaced bytes for the one-level undo."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        cached = self._decisions.get(str(path.name))
        if cached is None:
            return {"ok": False, "key": "no_proposal"}
        dest = path.with_name(path.stem + "_hitsounded.osu") if copy else None
        try:
            accepted = None if accept is None else {tuple(a) for a in accept}
            if dest is None:
                previous = path.read_bytes()
            result = ta.apply_proposals(path, cached["units"], accepted, dest)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if dest is None:
            self._decide_undo = {"path": str(path), "bytes": previous}
        else:
            self._decide_undo = None
        return {"ok": True, "file": str(path.name), "changed": result["changed"],
                "written": result["written"], "backup": result["backup"],
                "dest": result["dest"], "undo": self._decide_undo is not None}

    def hitsound_decide_undo(self) -> dict:
        """Restore the bytes the last in-place apply replaced, backing up the
        current file first and logging the write, as History lists every one.
        One level: a second undo has nothing to restore."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not self._decide_undo:
            return {"ok": False, "key": "no_undo"}
        path = Path(str(self._decide_undo["path"]))
        if not path.is_file():
            self._decide_undo = None
            return {"ok": False, "key": "bad_file"}
        try:
            backup = ta._backup_before_write(path, path.read_bytes())
            ta._atomic_write_bytes(path, bytes(self._decide_undo["bytes"]))
        except OSError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        ta.log_write(path, "restore", str(backup) if backup else None, {"undo": "hitsounds"})
        self._decide_undo = None
        return {"ok": True, "file": path.name, "backup": str(backup)}

    def inject_preview(self, osu_path: str) -> dict:
        """Dry run first, like the Tk GUI's confirmation dialog data."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            summary = ta.inject_osu_timing_points(
                osu_path, self._analysis, dry_run=True,
                decimals=self._settings()["offset_decimals"])
            diff = ta.inject_diff(osu_path, self._analysis,
                                  decimals=self._settings()["offset_decimals"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "summary": summary, "diff": diff}

    def inject_apply(self, osu_path: str) -> dict:
        """Replace the red lines, keeping what they replace in a backup (never overwritten)."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            summary = ta.inject_osu_timing_points(
                osu_path, self._analysis, backup=True,
                decimals=self._settings()["offset_decimals"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "summary": summary}

    def inject_all_preview(self) -> dict:
        """Dry run over every .osu beside the analysed song. Read only."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            report = ta.inject_mapset(Path(str(self._analysis.source)).parent,
                                      self._analysis, dry_run=True,
                                      decimals=self._settings()["offset_decimals"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report}

    def inject_all_apply(self) -> dict:
        """Replace the red lines of every .osu beside the analysed song,
        each file backed up first."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            report = ta.inject_mapset(Path(str(self._analysis.source)).parent,
                                      self._analysis, backup=True,
                                      decimals=self._settings()["offset_decimals"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report}

    def compare(self, osu_path: str) -> dict:
        """Per-section map-vs-detected table for the compare card."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            report = ta.compare_map_timing(osu_path, self._analysis)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report, "file": Path(osu_path).name}

    def align(self, osu_path: str) -> dict:
        """Map-vs-attack alignment for the alignment card."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            beatmap = ta.read_osu_beatmap(osu_path)
            report = ta.alignment_report(self._analysis, beatmap)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report, "file": Path(osu_path).name}

    def density(self, osu_path: str) -> dict:
        """Objects-per-second breakdown for the density card."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            report = ta.density_report(ta.read_osu_beatmap(osu_path))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report, "file": Path(osu_path).name}

    def snap(self, osu_path: str) -> dict:
        """The snap audit card: objects off the map's own grid and, with a
        result, what injecting it would unsnap."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            report = ta.snap_audit(ta.read_osu_beatmap(osu_path), self._analysis,
                                   float(self._analysis.duration))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "report": report, "file": Path(osu_path).name}

    def suggest(self, osu_path: str) -> dict:
        """Detected sections the map lacks, for the suggestions list."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            suggestions = ta.suggest_missing_lines(
                self._analysis, ta.read_osu_beatmap(osu_path))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "suggestions": suggestions, "file": Path(osu_path).name}

    def resnap_preview(self, osu_path: str) -> dict:
        """What moving this map's snapped objects onto the current grid would
        move, and what would stay. Read only."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            beatmap = ta.read_osu_beatmap(osu_path)
            diff = ta.inject_diff(osu_path, self._analysis,
                                  decimals=self._settings()["offset_decimals"])
            import copy
            work = copy.deepcopy(beatmap)
            result = ta.resnap_objects(work, diff["pairs"])
            before = [(o.get("time"), o.get("end_time")) for o in beatmap["hitobjects"]]
            after = [(o.get("time"), o.get("end_time")) for o in work["hitobjects"]]
            changed = sum(1 for b, a in zip(before, after) if b != a)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": Path(osu_path).name, "moved": result["moved"],
                "changed": changed, "left": result["left"], "skipped": result["skipped"]}

    def resnap_apply(self, osu_path: str) -> dict:
        """Move the snapped objects onto the current grid, the file backed up
        first and logged. Writes nothing when no time would actually change."""
        preview = self.resnap_preview(osu_path)
        if not preview.get("ok"):
            return preview
        if not preview["changed"]:
            return {**preview, "written": False, "backup": None}
        try:
            beatmap = ta.read_osu_beatmap(osu_path)
            diff = ta.inject_diff(osu_path, self._analysis,
                                  decimals=self._settings()["offset_decimals"])
            ta.resnap_objects(beatmap, diff["pairs"])
            written = ta.write_osu_beatmap(osu_path, beatmap)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {**preview, "written": True, "backup": written["backup"]}

    # -- reference timing: any map's red lines, graded by the attacks -------
    def _attacks(self) -> tuple[np.ndarray, np.ndarray]:
        """The analysed song's attacks. The fallback tracker keeps none, and
        those are the songs a hand-timed reference is for, so they are
        detected here once per song instead of refusing."""
        analysis = self._analysis
        times = np.asarray(analysis.attack_times, dtype=np.float64)
        if times.size:
            return times, np.asarray(analysis.attack_weights, dtype=np.float64)
        source = str(analysis.source)
        if self._ref_attacks is None or self._ref_attacks[0] != source:
            y, sr = ta._load_audio(source, lambda _message: None)
            found, weights, _env = ta._detect_attacks(y, sr, ta.FIT_HOP)
            self._ref_attacks = (source, found, weights)
        return self._ref_attacks[1], self._ref_attacks[2]

    def reference_grade(self, osu_path: str) -> dict:
        """Grade each red line of any .osu against the song's attacks. Read
        only; says whether the map's audio is this exact file."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        # Detecting attacks decodes the song: one heavy job at a time.
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            beatmap = ta.read_osu_beatmap(osu_path)
            times, weights = self._attacks()
            report = ta.grade_reference_timing(beatmap, times, weights,
                                               float(self._analysis.duration))
            same = ta.same_audio(osu_path, beatmap, self._analysis.source)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        return {"ok": True, "report": report, "same_audio": same,
                "path": str(osu_path), "file": Path(osu_path).name}

    def reference_load(self, osu_path: str) -> dict:
        """Make a map's red lines the working timing, as hand-placed points.
        One undo step; locked points stay, as they do through re-analysis."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            points = ta.reference_points(ta.read_osu_beatmap(osu_path), self._analysis.beats)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = self._merge_locks(points, self._analysis.beats)
        reply = self._edited(0, None)
        reply["loaded"] = len(points)
        return reply

    def reference_find(self, folder: str = "") -> dict:
        """Maps anywhere under a Songs folder whose audio is this exact file.

        With no folder, the one used last, else osu!'s default install; the
        folder is remembered. Only same-size audio is hashed, so a whole
        Songs folder costs a listing and a hash or two.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        root = str(folder or self._cfg.get("songs_folder") or _default_songs())
        if not Path(root).is_dir():
            return {"ok": False, "key": "no_songs"}
        report = self._indexed_same_audio(root)
        try:
            if report is None:
                report = ta.find_same_audio_maps(self._analysis.source, root)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if folder:
            self._cfg["songs_folder"] = root
            self._persist()
        return {"ok": True, "report": report}

    def _indexed_same_audio(self, root: str) -> dict | None:
        """The library index's answer, when it covers ``root`` and found maps.

        An index is as old as its last scan, so it only ever answers yes:
        when it finds nothing, the folder is walked, and a map added since
        the scan is still found.
        """
        library = overtone_library.Library()
        try:
            if not library.path.is_file() or not library.covers(root):
                return None
            report = library.same_audio_maps(self._analysis.source)
        except (ValueError, OSError, sqlite3.Error):
            return None
        return report if any(m["beatmaps"] for m in report["matches"]) else None

    # -- library index: the Songs folder, searchable ------------------------
    def _songs_root(self, folder: str = "") -> str:
        return str(folder or self._cfg.get("songs_folder") or _default_songs())

    def library_state(self) -> dict:
        """Where the Songs folder is and what the index holds of it."""
        root = self._songs_root()
        library = overtone_library.Library()
        try:
            index = library.stats()
            current = library.covers(root)
        except (ValueError, OSError, sqlite3.Error) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "songs": root, "songs_found": Path(root).is_dir(),
                "index": index, "current": current, "scanning": self._scanning.locked()}

    def library_scan(self, folder: str = "") -> dict:
        """Bring the index in step with the Songs folder (the remembered one,
        else osu!'s default). Unchanged maps are skipped, so a rescan costs a
        folder listing; the first scan reads every header. The page hears
        ``onLibraryProgress`` as folders are done."""
        root = self._songs_root(folder)
        if not Path(root).is_dir():
            return {"ok": False, "key": "no_songs"}
        if not self._scanning.acquire(blocking=False):
            return {"ok": False, "key": "scan_running"}
        try:
            report = overtone_library.Library().scan(
                root, lambda done, total: self._emit("onLibraryProgress",
                                                     {"done": done, "total": total}))
        except (ValueError, OSError, sqlite3.Error) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._scanning.release()
        if folder:
            self._cfg["songs_folder"] = root
            self._persist()
        return {"ok": True, "report": report}

    def library_search(self, text: str = "") -> dict:
        """Maps matching every word typed, grouped by set, best first."""
        try:
            result = overtone_library.Library().search(str(text or ""))
        except (ValueError, OSError, sqlite3.Error) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "result": result}

    def library_reset(self) -> dict:
        """Forget the index; the next scan rebuilds it from the folder."""
        if self._scanning.locked():
            return {"ok": False, "key": "scan_running"}
        try:
            overtone_library.Library().reset()
        except OSError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return self.library_state()

    # -- structure: the Rust engine's phrases on this song's bars -----------
    def structure(self) -> dict:
        """Phrases, labels and the evidence behind each, for the current song.

        ``overtone-cli structure`` reads the audio once per file; the phrase
        edges are snapped to the current red lines' proven downbeats on every
        call, so an edit in Timing moves them with it. Read only.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        source = Path(str(self._analysis.source))
        try:
            stat = source.stat()
        except OSError:
            return {"ok": False, "key": "bad_file"}
        key = (str(source), stat.st_size, stat.st_mtime_ns)
        if self._structure is None or self._structure[0] != key:
            try:
                report = overtone_rust.structure(source)
            except overtone_rust.SidecarUnavailable:
                return {"ok": False, "key": "no_rust"}
            except (RuntimeError, OSError) as exc:
                return {"ok": False, "key": "error", "detail": str(exc)}
            self._structure = (key, report)
        return {"ok": True, "file": source.name,
                "view": ta.structure_view(self._structure[1], self._analysis)}

    def evidence(self) -> dict:
        """The engine's alternatives for the open song: coherence candidates,
        the octave margin and half/double readings per section, residual and
        coverage beside each. Read only; cached on the live analysis, whose
        attacks and sections no edit moves."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._evidence is None or self._evidence[0] is not self._analysis:
            self._evidence = (self._analysis, ta.analysis_evidence(self._analysis))
        return {"ok": True, "evidence": self._evidence[1]}

    # -- ramps: the elastic curve as red lines --------------------------------
    def ramps(self, drift_ms: float = 5.0, max_lines=None) -> dict:
        """Fit the fewest red lines within the drift and show the trade-off.
        Shells to the CLI under the one-heavy-job lock; cached for Use.
        Read only until Use writes."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            drift = float(drift_ms)
        except (TypeError, ValueError):
            return {"ok": False, "key": "bad_values"}
        if not drift > 0:
            return {"ok": False, "key": "bad_values"}
        cap = None
        if max_lines not in (None, ""):
            try:
                cap = int(max_lines)
            except (TypeError, ValueError):
                return {"ok": False, "key": "bad_values"}
            if cap < 1:
                return {"ok": False, "key": "bad_values"}
        key = (drift, cap)
        cached = self._ramps
        if cached is None or cached[0] is not self._analysis or cached[1] != key:
            if not self._busy.acquire(blocking=False):
                return {"ok": False, "key": "busy"}
            try:
                report = overtone_rust.ramps(str(self._analysis.source), drift, cap,
                                             self._settings()["offset_decimals"])
            except overtone_rust.SidecarUnavailable:
                return {"ok": False, "key": "no_rust"}
            except overtone_rust.SidecarRefused as exc:
                return {"ok": False, "key": "no_grid", "detail": str(exc)}
            except (RuntimeError, ValueError, OSError) as exc:
                return {"ok": False, "key": "error", "detail": str(exc)}
            finally:
                self._busy.release()
            self._ramps = (self._analysis, key, report)
        return {"ok": True, "report": self._ramps[2]}

    def ramps_use(self) -> dict:
        """Make the fitted red lines the working timing, as hand-placed
        points. One undo step; locked points stay, as they do through
        re-analysis."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._ramps is None or self._ramps[0] is not self._analysis:
            return {"ok": False, "key": "no_ramps"}
        beats = np.asarray(self._analysis.beats, dtype=np.float64)
        points = [ta.TimingPoint(float(line["offset_ms"]), float(line["bpm"]), 1.0,
                                 ta._nearest_beat_index(beats, float(line["offset_ms"])),
                                 4, False, manual=True)
                  for line in self._ramps[2]["lines"]]
        if not points:
            return {"ok": False, "key": "no_ramps"}
        self._push_history()
        self._analysis.points = self._merge_locks(points, self._analysis.beats)
        reply = self._edited(0, None)
        reply["loaded"] = len(points)
        return reply

    # -- offset lab: the file's own delay, both decoders side by side -------
    def offset_lab(self) -> dict:
        """The analysed file's gapless numbers from its own header. Pure file
        reading: no job, no song decoding beyond the open analysis."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        return {"ok": True, "header": ta.mp3_gapless_info(str(self._analysis.source))}

    def offset_decoders(self) -> dict:
        """The first attack through each decoder, side by side: Python's
        against the Rust sidecar's, in milliseconds. Two decodes under the
        one-heavy-job lock; refusals say which side has nothing to compare."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            times = np.asarray(getattr(self._analysis, "attack_times", []), dtype=np.float64)
            if times.size:
                python_ms = round(float(times[0]) * 1000.0, 3)
            else:
                y, sr = ta._load_audio(str(self._analysis.source), lambda _message: None)
                detected, _weights, _env = ta._detect_attacks(y, sr)
                if detected.size == 0:
                    return {"ok": False, "key": "error", "detail": "no attacks detected"}
                python_ms = round(float(detected[0]) * 1000.0, 3)
            report = overtone_rust.analyze(str(self._analysis.source))
        except overtone_rust.SidecarUnavailable:
            return {"ok": False, "key": "no_rust"}
        except overtone_rust.SidecarRefused as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        except (RuntimeError, ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        rust_times = np.asarray(getattr(report, "attack_times", []), dtype=np.float64)
        if rust_times.size == 0:
            return {"ok": False, "key": "error", "detail": "no attacks decoded"}
        rust_ms = round(float(rust_times[0]) * 1000.0, 3)
        return {"ok": True, "python_ms": python_ms, "rust_ms": rust_ms,
                "delta_ms": round(rust_ms - python_ms, 3)}

    # -- structure bookmarks: section starts as editor bookmarks ------------
    def _bookmarks_plan(self, file: str):
        """The map plus the song's section starts in ms, or a refusal."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        view = self.structure()
        if not view.get("ok"):
            return view
        try:
            beatmap = ta.read_osu_beatmap(path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        starts = [s["start_s"] * 1000.0 for s in view["view"]["sections"]]
        return path, beatmap, starts

    def structure_bookmarks_preview(self, file: str) -> dict:
        """What writing the section starts as bookmarks would add. Read only."""
        plan = self._bookmarks_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, starts = plan
        try:
            import copy
            result = ta.set_editor_bookmarks(copy.deepcopy(beatmap),
                                             [round(s) for s in starts])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "starts": len(starts),
                "added": result["added"], "total": result["total"]}

    def structure_bookmarks_apply(self, file: str) -> dict:
        """Write the section starts into the map's bookmarks, merged with its
        own, the file backed up first and logged."""
        plan = self._bookmarks_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, starts = plan
        try:
            result = ta.set_editor_bookmarks(beatmap, [round(s) for s in starts])
            written = ta.write_osu_beatmap(path, beatmap, op="bookmarks")
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "added": result["added"],
                "total": result["total"], "written": written["bytes"] > 0,
                "backup": written["backup"]}

    # -- structure kiai: kiai on chorus sections ------------------------------
    def _kiai_plan(self, file: str):
        """The map plus the song's chorus spans in ms, or a refusal."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        view = self.structure()
        if not view.get("ok"):
            return view
        try:
            beatmap = ta.read_osu_beatmap(path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        spans = [(s["start_s"] * 1000.0, s["end_s"] * 1000.0)
                 for s in view["view"]["sections"] if s.get("kind") == "chorus"]
        if not spans:
            return {"ok": False, "key": "no_chorus"}
        return path, beatmap, spans

    def structure_kiai_preview(self, file: str) -> dict:
        """What writing kiai on the choruses would add, flip or keep. Read only."""
        plan = self._kiai_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, spans = plan
        try:
            import copy
            result = ta.set_chorus_kiai(copy.deepcopy(beatmap), spans)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "choruses": len(spans),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"]}

    def structure_kiai_apply(self, file: str) -> dict:
        """Write kiai on the choruses as green lines, the file backed up
        first and logged. Sound never changes: kiai is light, not sound."""
        plan = self._kiai_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, spans = plan
        try:
            result = ta.set_chorus_kiai(beatmap, spans)
            written = ta.write_osu_beatmap(path, beatmap, op="kiai")
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "choruses": len(spans),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"], "written": written["bytes"] > 0,
                "backup": written["backup"]}

    # -- structure breaks: quiet spans long enough for a break ----------------
    def _breaks_plan(self, file: str):
        """The map plus the song's suggested break spans, or a refusal."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        view = self.structure()
        if not view.get("ok"):
            return view
        try:
            beatmap = ta.read_osu_beatmap(path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return path, beatmap, ta.suggest_breaks(beatmap, view["view"]["sections"])

    def structure_breaks_preview(self, file: str) -> dict:
        """What writing the suggested breaks would add. Read only."""
        plan = self._breaks_plan(file)
        if isinstance(plan, dict):
            return plan
        path, _beatmap, spans = plan
        return {"ok": True, "file": path.name, "spans": spans}

    def structure_breaks_apply(self, file: str) -> dict:
        """Write the suggested breaks as 2,start,end lines, the file backed
        up first and logged. Recomputes the spans: the preview never decides."""
        plan = self._breaks_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, spans = plan
        if not spans:
            return {"ok": False, "key": "no_breaks"}
        try:
            result = ta.set_map_breaks(beatmap, [(s["start_ms"], s["end_ms"]) for s in spans])
            written = ta.write_osu_beatmap(path, beatmap, op="breaks")
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "breaks": len(spans),
                "added": result["added"], "kept": result["kept"],
                "written": written["bytes"] > 0, "backup": written["backup"]}

    # -- constant scroll: greens that cancel BPM changes ----------------------
    def _scroll_plan(self, file: str):
        """The map beside the analysed song, or a refusal."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        try:
            beatmap = ta.read_osu_beatmap(path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return path, beatmap

    def scroll_preview(self, file: str) -> dict:
        """What normalising this difficulty's scroll would add, rewrite or
        keep, against its first red line's BPM. Read only."""
        plan = self._scroll_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap = plan
        try:
            import copy
            result = ta.set_constant_scroll(copy.deepcopy(beatmap))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name,
                "reference_bpm": round(beatmap["timing"]["reds"][0][1], 3),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"]}

    def scroll_apply(self, file: str) -> dict:
        """Write the scroll greens into the difficulty, the file backed up
        first and logged. Sound, kiai and barlines never move."""
        plan = self._scroll_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap = plan
        try:
            result = ta.set_constant_scroll(beatmap)
            written = ta.write_osu_beatmap(path, beatmap, op="scroll")
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name,
                "reference_bpm": round(beatmap["timing"]["reds"][0][1], 3),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"], "written": written["bytes"] > 0,
                "backup": written["backup"]}

    # -- structure volume: hitsound volume from section energy ---------------
    def _volumes_plan(self, file: str):
        """The map plus the song's structure sections, or a refusal."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        view = self.structure()
        if not view.get("ok"):
            return view
        try:
            beatmap = ta.read_osu_beatmap(path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return path, beatmap, view["view"]["sections"]

    def structure_volumes_preview(self, file: str) -> dict:
        """What writing section volumes would add, rewrite or keep. Read only."""
        plan = self._volumes_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, sections = plan
        try:
            import copy
            result = ta.set_section_volumes(copy.deepcopy(beatmap), sections)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "sections": len(sections),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"]}

    def structure_volumes_apply(self, file: str) -> dict:
        """Write section volumes as green lines, the file backed up first and
        logged. Recomputes: the preview never decides."""
        plan = self._volumes_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, sections = plan
        try:
            result = ta.set_section_volumes(beatmap, sections)
            written = ta.write_osu_beatmap(path, beatmap, op="volumes")
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "sections": len(sections),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"], "written": written["bytes"] > 0,
                "backup": written["backup"]}

    def snap_divisors(self) -> dict:
        """Which divisor each section needs, from the song's own attacks.
        Read only: 1/3, 1/4 or 1/6 per section with the counts behind it."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        return {"ok": True, "report": ta.snap_divisors(self._analysis)}

    # -- assisted timing: two marked downbeats seed the grid ---------------
    def assisted_fit(self, first_ms: float, second_ms: float, bars: int, meter: int) -> dict:
        """Fit the grid two marked downbeats imply. Read only: the answer (or
        the refusal and why) is kept until "Add to timing" or the next fit."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            times, weights = self._attacks()
            fit = ta.assisted_grid(times, weights, first_ms, second_ms, bars, meter)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        self._assisted = fit if fit["ok"] else None
        return {"ok": True, "fit": fit}

    def assisted_apply(self) -> dict:
        """Add the last assisted line to the working timing: one undo step,
        locked points kept, points inside the span it holds dropped."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._assisted is None:
            return {"ok": False, "key": "no_fit"}
        fit, self._assisted = self._assisted, None
        points = ta.apply_assisted_grid(self._analysis.points, fit, self._analysis.beats)
        self._push_history()
        self._analysis.points = self._merge_locks(points, self._analysis.beats)
        return self._edited(None, fit["offset_ms"])

    # -- playback: the analysed song's bytes, handed to WebAudio ------------
    #: Bytes per chunk: one bridge call must stay small enough to be quick.
    AUDIO_CHUNK = 1 << 20

    def audio_open(self, kind: str = "file") -> dict:
        """Stage the analysed song for the page to fetch in chunks.

        ``file`` is the song as it is on disk, for the browser to decode.
        ``wav`` is Overtone's own decode as 16-bit mono WAV, for a format the
        browser cannot read (AIFF). ``percussion`` is the HPSS stem as WAV,
        computed once per analysis under the one-heavy-job lock. Only the
        analysed file is ever served: the page names no path.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        source = Path(str(self._analysis.source))
        try:
            if kind == "percussion":
                if self._percussion is None or self._percussion[0] is not self._analysis:
                    if not self._busy.acquire(blocking=False):
                        return {"ok": False, "key": "busy"}
                    try:
                        y, sr = ta._load_audio(source, lambda _message: None)
                        payload = ta.percussive_wav(y, sr)
                    finally:
                        self._busy.release()
                    self._percussion = (self._analysis, payload)
                payload = self._percussion[1]
                mime = "audio/wav"
            elif kind == "wav":
                payload = _wav_bytes(source)
                mime = "audio/wav"
            else:
                size = source.stat().st_size
                if size > ta.MAX_OSZ_AUDIO_BYTES:
                    return {"ok": False, "key": "too_big"}
                payload = source.read_bytes()
                mime = AUDIO_MIME.get(source.suffix.lower(), "application/octet-stream")
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._audio_bytes = payload
        chunks = (len(payload) + self.AUDIO_CHUNK - 1) // self.AUDIO_CHUNK
        return {"ok": True, "size": len(payload), "chunks": chunks, "mime": mime,
                "path": str(source)}

    def audio_chunk(self, index: int) -> dict:
        """One staged chunk as base64."""
        payload = self._audio_bytes
        try:
            index = int(index)
        except (TypeError, ValueError):
            return {"ok": False, "key": "bad_values"}
        if payload is None or not 0 <= index * self.AUDIO_CHUNK < max(len(payload), 1):
            return {"ok": False, "key": "no_audio_staged"}
        piece = payload[index * self.AUDIO_CHUNK:(index + 1) * self.AUDIO_CHUNK]
        return {"ok": True, "data": base64.b64encode(piece).decode("ascii")}

    def audio_close(self) -> None:
        """Drop the staged bytes once the page has decoded them."""
        self._audio_bytes = None

    def set_playback(self, prefs: dict) -> dict:
        """Remember the song and click levels. There is no latency offset: the
        song and the click leave through one AudioContext, so they cannot drift
        apart; calibrating latency matters for tapping, not for listening."""
        try:
            raw = {key: float(prefs[key]) for key in ("song_volume", "click_volume")}
            if "hitsound_volume" in prefs:           # optional: older pages send two
                raw["hitsound_volume"] = float(prefs["hitsound_volume"])
        except (KeyError, TypeError, ValueError):
            return {"ok": False, "key": "bad_values"}
        # Before clamping: max(0.0, nan) is 0.0, and a NaN would pass as silence.
        if not all(np.isfinite(v) for v in raw.values()):
            return {"ok": False, "key": "bad_values"}
        clean = {key: min(1.0, max(0.0, value)) for key, value in raw.items()}
        self._cfg.update(clean)
        self._persist()
        return {"ok": True, "playback": self._playback()}

    def set_tap_latency(self, ms: float) -> dict:
        """Remember how late this person's taps land on a click they hear
        (key travel, the hand, the ear): the calibration taps are judged by."""
        try:
            value = float(ms)
        except (TypeError, ValueError):
            return {"ok": False, "key": "bad_values"}
        if not np.isfinite(value) or abs(value) > TAP_LATENCY_LIMIT_MS:
            return {"ok": False, "key": "bad_latency"}
        self._cfg["tap_latency_ms"] = value
        self._persist()
        return {"ok": True, "playback": self._playback()}

    def _playback(self) -> dict:
        cfg = self._cfg
        latency = _number(cfg.get("tap_latency_ms"), 0.0, float)
        return {"song_volume": min(1.0, max(0.0, _number(cfg.get("song_volume"), 0.8, float))),
                "click_volume": min(1.0, max(0.0, _number(cfg.get("click_volume"), 0.6, float))),
                "hitsound_volume": min(1.0, max(0.0, _number(cfg.get("hitsound_volume"), 0.7, float))),
                "tap_latency_ms": latency if abs(latency) <= TAP_LATENCY_LIMIT_MS else 0.0}

    # -- settings (Phase 20): every option in one place -------------------
    def _settings(self) -> dict:
        """The saved settings, each checked: a hand-edited config falls back
        to the default for that one value, never to a crash."""
        cfg = self._cfg
        decimals = _number(cfg.get("offset_decimals"), 0, int)
        subdivision = _number(cfg.get("click_subdivision"), 1, int)
        scale = _number(cfg.get("ui_scale"), 1.0, float)
        folder = cfg.get("output_folder")
        return {
            "output_folder": folder if isinstance(folder, str) and folder.strip() else "",
            "export_ask": cfg.get("export_ask", True) is not False,
            "offset_decimals": decimals if 0 <= decimals <= MAX_OFFSET_DECIMALS else 0,
            "click_subdivision": subdivision if subdivision in ta.CLICK_SUBDIVISIONS else 1,
            "click_accent": cfg.get("click_accent", True) is not False,
            "ui_scale": scale if UI_SCALE_RANGE[0] <= scale <= UI_SCALE_RANGE[1] else 1.0,
            "reduced_motion": cfg.get("reduced_motion") is True,
            "theme": cfg.get("theme") if cfg.get("theme") in THEMES else "dark",
        }

    def settings(self) -> dict:
        return {"ok": True, "settings": self._settings(),
                "output_default": str(_default_output()), "cache": self._cache_info()}

    def set_settings(self, changes: dict) -> dict:
        """Change some settings; every value is checked before any is kept."""
        if not isinstance(changes, dict):
            return {"ok": False, "key": "bad_values"}
        clean: dict = {}
        try:
            for key, value in changes.items():
                if key == "output_folder":
                    value = str(value or "").strip()
                    if value and not Path(value).is_dir():
                        return {"ok": False, "key": "bad_folder"}
                elif key in ("export_ask", "click_accent", "reduced_motion"):
                    if not isinstance(value, bool):
                        return {"ok": False, "key": "bad_values"}
                elif key == "offset_decimals":
                    value = int(value)
                    if not 0 <= value <= MAX_OFFSET_DECIMALS:
                        return {"ok": False, "key": "bad_values"}
                elif key == "click_subdivision":
                    value = int(value)
                    if value not in ta.CLICK_SUBDIVISIONS:
                        return {"ok": False, "key": "bad_values"}
                elif key == "theme":
                    if value not in THEMES:
                        return {"ok": False, "key": "bad_values"}
                elif key == "ui_scale":
                    value = float(value)
                    if not (np.isfinite(value) and UI_SCALE_RANGE[0] <= value <= UI_SCALE_RANGE[1]):
                        return {"ok": False, "key": "bad_values"}
                else:
                    return {"ok": False, "key": "bad_values"}
                clean[key] = value
        except (TypeError, ValueError):
            return {"ok": False, "key": "bad_values"}
        self._cfg.update(clean)
        self._persist()
        reply = self.settings()
        # The click follows its settings at once, as it follows the edits.
        if self._analysis is not None and {"click_subdivision", "click_accent"} & clean.keys():
            reply["result"] = self._payload()
        return reply

    def pick_output_folder(self) -> dict:
        folder = self.pick_folder()
        if not folder:
            return {"ok": False, "key": "cancelled"}
        return self.set_settings({"output_folder": folder})

    def _payload(self) -> dict:
        s = self._settings()
        return analysis_payload(self._analysis, {"subdivision": s["click_subdivision"],
                                                 "accent": s["click_accent"]})

    def _cache_info(self) -> dict:
        entries = list(self._cache_dir().glob("*.pickle"))
        size = 0
        for entry in entries:
            try:
                size += entry.stat().st_size
            except OSError:
                pass
        return {"entries": len(entries), "bytes": size, "path": str(self._cache_dir()),
                "limit_entries": self.CACHE_ENTRIES, "limit_bytes": self.CACHE_BYTES}

    def cache_clear(self) -> dict:
        """Forget every cached analysis; the next one of each song runs again."""
        for entry in self._cache_dir().glob("*.pickle"):
            try:
                entry.unlink()
            except OSError:
                pass
        return {"ok": True, "cache": self._cache_info()}

    def _song_folder_name(self) -> str:
        """The song's name for its output folder: the osu! folder's "Artist -
        Title" when the audio sits in one, else the audio's own name."""
        source = Path(str(self._analysis.source))
        folder = re.sub(r"^\d+\s+", "", source.parent.name)
        name = folder if " - " in folder else source.stem
        return ta._safe_component(name, "Overtone export")

    def _export_target(self, filename: str, file_types) -> str | None:
        """Where an export goes: the output folder's folder for this song.
        Asked for, the save dialog opens there; not asked, the file lands
        there under a free name, never over an earlier export."""
        s = self._settings()
        root = Path(s["output_folder"]) if s["output_folder"] else _default_output()
        folder = root / self._song_folder_name()
        if s["export_ask"]:
            root.mkdir(parents=True, exist_ok=True)
            return self._save_dialog(filename, file_types, folder if folder.is_dir() else root)
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / filename
        stem, suffix = target.stem, target.suffix
        for n in range(2, 1000):
            if not target.exists():
                break
            target = folder / f"{stem} ({n}){suffix}"
        return str(target)

    # -- mod report: every finding as an osu! editor timestamp -------------
    def mod_report(self, osu_path: str) -> dict:
        """Every finding about one difficulty, as the lines a modder posts.
        Read only; the attacks are the ones reference timing uses."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            beatmap = ta.read_osu_beatmap(osu_path)
            times, weights = self._attacks()
            report = ta.mod_report(beatmap, times, weights, float(self._analysis.duration),
                                   self._analysis)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        return {"ok": True, "report": report, "file": Path(osu_path).name,
                "difficulty": ta._mapset_difficulty_name(Path(osu_path), beatmap)}

    def open_in_editor(self, stamp: str) -> dict:
        """Open the local osu! editor at a timestamp through its ``osu://`` link.
        Only a well-formed timestamp reaches the shell; nothing leaves the PC."""
        try:
            link = ta.mod_editor_link(str(stamp))
        except ValueError:
            return {"ok": False, "key": "bad_stamp"}
        try:
            _open_link(link)
        except OSError as exc:
            return {"ok": False, "key": "no_osu", "detail": str(exc)}
        return {"ok": True}

    # -- write history: every .osu write, its backup, restore ---------------
    def history(self) -> dict:
        """The write log, newest first: when, what operation, which file,
        which backup holds the replaced bytes. Global: needs no song."""
        entries = ta.read_history()
        return {"ok": True, "entries": [
            {"index": n, "ts": e.get("ts"), "op": e.get("op"),
             "file": Path(str(e.get("path", ""))).name, "path": e.get("path"),
             "backup": Path(str(e.get("backup", ""))).name if e.get("backup") else None,
             "backup_path": e.get("backup"), "summary": e.get("summary", {})}
            for n, e in enumerate(entries)]}

    def _history_entry(self, index: int):
        """The log entry at ``index`` (newest first), or None when the index
        names nothing logged."""
        try:
            n = int(index)
        except (TypeError, ValueError):
            return None
        entries = ta.read_history()
        return entries[n] if 0 <= n < len(entries) else None

    def history_diff(self, index: int) -> dict:
        """The timing diff of one entry: the backup's red lines against the
        file's current ones — shifted by the logged shift first for swaps,
        so what reads is what changed besides the move. Read only; missing
        files refuse."""
        entry = self._history_entry(index)
        if entry is None:
            return {"ok": False, "key": "bad_index"}
        try:
            current = Path(str(entry["path"])).read_bytes()
        except OSError:
            return {"ok": False, "key": "bad_file"}
        if not entry.get("backup"):
            return {"ok": False, "key": "no_backup"}
        try:
            old = Path(str(entry["backup"])).read_bytes()
        except OSError:
            return {"ok": False, "key": "no_backup"}
        old_text = old.decode("utf-8-sig", "replace")
        shift = (entry.get("summary") or {}).get("shift_ms")
        if entry.get("op") == "swap" and isinstance(shift, (int, float)):
            try:
                old_text = ta.shift_osu_text(old_text, float(shift))[0]
            except ValueError:
                pass
        return {"ok": True, "file": Path(str(entry["path"])).name,
                "diff": ta.diff_reds(old_text, current.decode("utf-8-sig", "replace"))}

    def history_restore(self, index: int) -> dict:
        """Restore one entry's backup over its file, keeping the current bytes
        as a new backup first. The restored bytes are logged as a restore."""
        entry = self._history_entry(index)
        if entry is None:
            return {"ok": False, "key": "bad_index"}
        if not entry.get("backup"):
            return {"ok": False, "key": "no_backup"}
        try:
            result = ta.restore_write(entry["path"], entry["backup"])
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": Path(str(entry["path"])).name,
                "backup": Path(str(result["backup"])).name}

    # -- helpers (not exposed: underscored) ----------------------------------
    def _save_dialog(self, filename: str, file_types, directory: Path | None = None) -> str | None:
        import webview
        if self._window is None:
            return None
        chosen = self._window.create_file_dialog(
            webview.SAVE_DIALOG, directory=str(directory or ""), save_filename=filename,
            file_types=file_types)
        if not chosen:
            return None
        return chosen[0] if isinstance(chosen, (list, tuple)) else str(chosen)

    def _worker(self, path: str, params: dict) -> None:
        try:
            result = None
            if not self._locked:
                result = self._cache_load(path, params)
            if result is None:
                result = run_analysis(path, params, self._emit_progress)
                if not self._locked:
                    self._cache_save(path, params, result)
            else:
                # Content-keyed cache: the DSP is identical for byte twins,
                # but the path on the payload must be this file's.
                result.source = path
            if self._locked:
                result.points = self._merge_locks(result.points, result.beats)
            self._analysis = result
            self._assisted = None       # a fit belongs to the song it was made on
            self._history.clear()
            self._future.clear()
            self._emit("onResult", self._payload())
        except Exception as exc:  # noqa: BLE001 -- the UI shows the message
            self._emit("onError", str(exc))
        finally:
            self._busy.release()

    def _merge_locks(self, points, beats) -> list:
        """Verified red lines survive a new point list (re-analysis, a loaded
        reference): re-merge them as hand-placed points (confidence 1.0, bar
        preserved), skipping any the new list already has so locks never
        duplicate."""
        points = list(points)
        beats = np.asarray(beats, dtype=np.float64)
        for lock in self._locked:
            if any(abs(p.offset_ms - lock["offset_ms"]) < 1.0 for p in points):
                continue
            idx = (int(np.argmin(np.abs(beats * 1000.0 - lock["offset_ms"])))
                   if beats.size else 0)
            points.append(ta.TimingPoint(
                lock["offset_ms"], lock["bpm"], 1.0, idx,
                lock["meter"], lock["meter_known"], manual=True))
        points.sort(key=lambda p: p.offset_ms)
        return points

    def _emit_progress(self, message: str) -> None:
        self._emit("onProgress", message)

    # -- result cache (Phase 2: same audio plus same options, no recompute) --
    #: Entries kept and total bytes kept; payloads are small (pooled onset
    #: plus one value per beat), analyses are not.
    CACHE_ENTRIES = 10
    CACHE_BYTES = 50 * 1024 * 1024

    @staticmethod
    def _cache_dir() -> Path:
        directory = Path(os.environ.get("LOCALAPPDATA", str(HERE))) / "Overtone" / "cache"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @staticmethod
    def _cache_key(path: str, params: dict) -> str | None:
        """Content hash plus app version plus engine code plus options.

        The engine mtime is in the key on purpose: editing the DSP must
        invalidate every cached result, or the suite would keep passing
        against yesterday's analyses. None when unreadable.
        """
        import hashlib
        try:
            digest = hashlib.sha256()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            engine_mtime = os.path.getmtime(ta.__file__)
            if params.get("engine") == "rust":
                # A rebuilt binary is a different engine, as an edited DSP is.
                binary = overtone_rust.find_cli()
                engine_mtime = [engine_mtime, os.path.getmtime(binary) if binary else None]
        except OSError:
            return None
        stamp = json.dumps([ta.APP_VERSION, engine_mtime, params],
                           sort_keys=True, default=str)
        return hashlib.sha256(
            f"{stamp}|".encode() + digest.digest()).hexdigest()

    def _cache_load(self, path: str, params: dict):
        """A cached Analysis, or None on any failure (a miss, never an error)."""
        import pickle
        key = self._cache_key(path, params)
        if key is None:
            return None
        try:
            with open(self._cache_dir() / (key + ".pickle"), "rb") as handle:
                result = pickle.load(handle)  # noqa: S301 -- own dir, own version key
        except Exception:  # noqa: BLE001 -- any cache failure is a miss
            return None
        return result if isinstance(result, ta.Analysis) else None

    def _cache_save(self, path: str, params: dict, result) -> None:
        """Persist an engine result; must never break the analysis it follows."""
        import pickle
        try:
            key = self._cache_key(path, params)
            if key is None:
                return
            target = self._cache_dir() / (key + ".pickle")
            tmp = target.with_suffix(".part")
            with open(tmp, "wb") as handle:
                pickle.dump(result, handle, protocol=4)
            os.replace(tmp, target)
            self._prune_cache()
        except (OSError, ValueError):
            pass

    def _prune_cache(self) -> None:
        """Newest entries survive, by count and by total bytes."""
        try:
            entries = sorted(self._cache_dir().glob("*.pickle"),
                             key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return
        kept, total = 0, 0
        for entry in entries:
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            if kept < self.CACHE_ENTRIES and total + size <= self.CACHE_BYTES:
                kept += 1
                total += size
            else:
                try:
                    entry.unlink()
                except OSError:
                    pass

    def _emit(self, handler: str, payload: object) -> None:
        if self._window is not None:
            self._window.evaluate_js(f"window.overtone && window.overtone.{handler}({json.dumps(payload)})")

    @staticmethod
    def _file_info(path: str) -> dict:
        p = Path(path)
        size = p.stat().st_size if p.is_file() else 0
        return {"path": str(p), "name": p.name, "folder": p.parent.name,
                "size_mb": round(size / 1_048_576, 1), "exists": p.is_file()}

    @staticmethod
    def _pulse_key(tk_value: str) -> str:
        return {"÷4": "/4", "÷2": "/2", "×1": "x1", "×2": "x2", "×4": "x4"}.get(tk_value, "auto")

    @staticmethod
    def _params(options: dict) -> dict:
        confidence = float(options["confidence"]) / 100.0
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("confidence")
        return {"min_delta": float(options["delta"]),
                "persistence": int(options["persistence"]),
                "min_confidence": confidence,
                "prefer_map_bpm": bool(options.get("prefer_map_bpm", True)),
                "refine_beats": bool(options.get("refine_beats", True)),
                "force_subdivision": PULSE_FACTORS[options.get("pulse", "auto")],
                "engine": "rust" if options.get("engine") == "rust" else "python"}

    def _remember(self, path: str, options: dict) -> None:
        tk_pulse = {"/4": "÷4", "/2": "÷2", "x1": "×1", "x2": "×2", "x4": "×4"}
        self._cfg.update({"cfg_version": ta.TimingAnalyzerApp.CFG_VERSION, "file": path,
                          "delta": str(options["delta"]),
                          "persistence": str(options["persistence"]),
                          "confidence": str(options["confidence"]),
                          "pulse": tk_pulse.get(options.get("pulse", "auto"), "Auto"),
                          "prefer_map_bpm": bool(options.get("prefer_map_bpm", True)),
                          "refine_beats": bool(options.get("refine_beats", True)),
                          "engine": "rust" if options.get("engine") == "rust" else "python"})
        recent = [path] + [p for p in self._cfg.get("recent", []) if p != path]
        self._cfg["recent"] = recent[:self.RECENT_LIMIT]
        self._persist()

    def _persist(self) -> None:
        ta.save_config(self._cfg)


def run_analysis(path: str, params: dict, progress=None) -> ta.Analysis:
    """The exact call the Tk worker makes, or the Rust engine when chosen.

    Rust runs only where it computes what v3 would: pulse Auto, the grid's own
    factor. Anything it cannot answer (no binary, no grid, since it has no
    beat-tracker fallback, or a file it cannot decode) goes to v3, and the
    result carries why, so a fallback is never silent.
    """
    note = ""
    if params.get("engine") == "rust":
        if params["force_subdivision"] != 0.0:
            note = "the Rust engine runs at the grid's own pulse only"
        else:
            if progress:
                progress("Analysing with the Rust engine…")
            try:
                result = overtone_rust.analyze(
                    path, min_delta=params["min_delta"], persistence=params["persistence"],
                    min_confidence=params["min_confidence"],
                    prefer_map_bpm=params["prefer_map_bpm"])
                result.backend = "rust"
                return result
            except Exception as exc:  # noqa: BLE001 -- v3 takes over and says why
                note = str(exc)
    result = ta.analyze_audio(path, params["min_delta"], params["persistence"],
                              params["prefer_map_bpm"], params["min_confidence"],
                              progress, params["force_subdivision"], params["refine_beats"])
    result.backend = "python"
    result.backend_note = note
    return result


# ---------------------------------------------------------------------------
# Window
# ---------------------------------------------------------------------------

def _dark_caption(window) -> None:
    """Dark title bar even when Windows itself is in light mode.

    pywebview only darkens the caption when the system theme is dark; the app
    is dark either way, and a white caption over it looks broken. Runs on the
    ``shown`` event because the native form does not exist before that.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        hwnd = int(window.native.Handle.ToInt32())
        on = ctypes.c_int(1)
        # DWMWA_USE_IMMERSIVE_DARK_MODE = 20 (Windows 10 20H1+ and 11)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(on), ctypes.sizeof(on))
    except Exception:  # noqa: BLE001 -- decoration must never block startup
        pass


def main(argv: list[str] | None = None) -> None:
    import webview
    args = list(sys.argv[1:] if argv is None else argv)
    files = [a for a in args if not a.startswith("--")]
    api = Api(files[0] if files else "", autorun=bool(files))
    # Before the window exists: the taskbar reads the id when the window opens.
    ta.claim_taskbar_identity()
    window = webview.create_window(
        "Overtone", url=str(APP_DIR / "index.html"), js_api=api,
        width=1320, height=880, min_size=(960, 640), background_color="#0B0F17")
    api._window = window
    window.events.shown += lambda: _dark_caption(window)
    webview.start(gui="edgechromium", icon=str(ICON_ICO) if ICON_ICO.is_file() else None,
                  private_mode=False,
                  storage_path=str(Path(os.environ.get("LOCALAPPDATA", HERE)) / "Overtone" / "webview"))


if __name__ == "__main__":
    main()
