"""Overtone web shell: the app's UI as HTML/CSS in a native WebView2 window.

The Tk GUI in ``timing_analyzer.py`` cannot draw rounded corners, soft
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
import sys
import threading
from pathlib import Path

import numpy as np

import timing_analyzer as ta

HERE = Path(__file__).resolve().parent
APP_DIR = HERE / "app"
ICON_ICO = HERE / "assets" / "logo.ico"
LOGO_PNG = HERE / "assets" / "logo.png"

AUDIO_TYPES = ("Audio files (*.wav;*.flac;*.ogg;*.mp3;*.m4a;*.aac;*.opus;*.aiff)",
               "All files (*.*)")
PULSE_FACTORS = {"auto": 0.0, "/4": 0.25, "/2": 0.5, "x1": 1.0, "x2": 2.0, "x4": 4.0}
#: The trace needs the shape of the onset envelope, not its 40 k frames.
ONSET_BINS = 1600
#: A red line this far after the first beat leaves the intro without timing.
LATE_FIRST_LINE_S = 2.0
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


def _warnings(analysis: ta.Analysis, points: list[ta.TimingPoint]) -> list[dict]:
    """Things a mapper must check by ear before trusting the numbers."""
    notes: list[dict] = []
    if analysis.engine != "precision":
        notes.append({"level": "warn", "key": "warn_legacy"})
    if points and analysis.beats.size:
        first_line = points[0].offset_ms / 1000.0
        first_beat = float(analysis.beats[0])
        if first_line - first_beat > LATE_FIRST_LINE_S:
            notes.append({"level": "warn", "key": "warn_late_first",
                          "values": {"line": f"{first_line:.1f}", "beat": f"{first_beat:.1f}"}})
    if analysis.engine == "precision" and analysis.fit_residual_ms > LOOSE_RESIDUAL_MS:
        notes.append({"level": "info", "key": "warn_loose",
                      "values": {"ms": f"{analysis.fit_residual_ms:.1f}"}})
    return notes


def analysis_payload(analysis: ta.Analysis) -> dict:
    """Everything the frontend draws, as plain JSON types.

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
        "warnings": _warnings(analysis, points),
    }


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
        if initial_file:
            self._cfg["file"] = initial_file

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
            },
            "presets": ta.TimingAnalyzerApp.PRESETS,
            # pywebview serves app/ as the web root, so ../assets is out of
            # reach; the one image the page needs travels as a data URI.
            "logo": _logo_uri(),
            # A file handed over on the command line ("Open with Overtone") is
            # analysed straight away; the user asked for exactly that file.
            "autorun": autorun,
        }

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
            self._analysis = ta.rebuild_with_subdivision(
                analysis, factor, params["min_delta"], params["persistence"],
                params["min_confidence"])
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "result": analysis_payload(self._analysis)}

    # -- helpers (not exposed: underscored) ----------------------------------
    def _worker(self, path: str, params: dict) -> None:
        try:
            result = run_analysis(path, params, self._emit_progress)
            self._analysis = result
            self._emit("onResult", analysis_payload(result))
        except Exception as exc:  # noqa: BLE001 -- the UI shows the message
            self._emit("onError", str(exc))
        finally:
            self._busy.release()

    def _emit_progress(self, message: str) -> None:
        self._emit("onProgress", message)

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
                "force_subdivision": PULSE_FACTORS[options.get("pulse", "auto")]}

    def _remember(self, path: str, options: dict) -> None:
        tk_pulse = {"/4": "÷4", "/2": "÷2", "x1": "×1", "x2": "×2", "x4": "×4"}
        self._cfg.update({"cfg_version": ta.TimingAnalyzerApp.CFG_VERSION, "file": path,
                          "delta": str(options["delta"]),
                          "persistence": str(options["persistence"]),
                          "confidence": str(options["confidence"]),
                          "pulse": tk_pulse.get(options.get("pulse", "auto"), "Auto"),
                          "prefer_map_bpm": bool(options.get("prefer_map_bpm", True)),
                          "refine_beats": bool(options.get("refine_beats", True))})
        self._persist()

    def _persist(self) -> None:
        ta.save_config(self._cfg)


def run_analysis(path: str, params: dict, progress=None) -> ta.Analysis:
    """The exact call the Tk worker makes, with the same argument order."""
    return ta.analyze_audio(path, params["min_delta"], params["persistence"],
                            params["prefer_map_bpm"], params["min_confidence"],
                            progress, params["force_subdivision"], params["refine_beats"])


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
