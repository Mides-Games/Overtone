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
import sys
import threading
from pathlib import Path

import numpy as np

import overtone as ta

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
        "warnings": _warnings(analysis),
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
        #: Undo/redo stacks: snapshots of the point list before each mutation.
        #: A fresh analysis replaces the whole map, so it clears both.
        self._history: list[list] = []
        self._future: list[list] = []
        #: Locked points, by value: the editor refuses them and a fresh
        #: analysis re-merges them, so a verified red line survives both.
        #: Value-based on purpose — neighbours can come and go without
        #: shifting anything, and undo/redo re-match by offset.
        self._locked: list[dict] = []
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
        return {"ok": True, "result": analysis_payload(self._analysis),
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
        return {"ok": True, "result": analysis_payload(self._analysis),
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
            },
            "presets": ta.TimingAnalyzerApp.PRESETS,
            # pywebview serves app/ as the web root, so ../assets is out of
            # reach; the one image the page needs travels as a data URI.
            "logo": _logo_uri(),
            # A file handed over on the command line ("Open with Overtone") is
            # analysed straight away; the user asked for exactly that file.
            "autorun": autorun,
            "recent": self._recent(),
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
        return {"ok": True, "result": analysis_payload(self._analysis),
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
        return {"ok": True, "result": analysis_payload(self._analysis),
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
        return {"ok": True, "text": ta.osu_timing_text(self._analysis)}

    def save_csv(self) -> dict:
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        target = self._save_dialog("overtone-timing.csv", CSV_TYPES)
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
        target = self._save_dialog("overtone-click.wav", WAV_TYPES)
        if not target:
            return {"ok": False, "key": "cancelled"}
        try:
            ta.export_click_track(self._analysis, target)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "path": target}

    def save_osz(self) -> dict:
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        audio = self._cfg.get("file") or self._analysis.source
        stem = Path(str(audio)).stem or "overtone"
        target = self._save_dialog(f"{stem}.osz", OSZ_TYPES)
        if not target:
            return {"ok": False, "key": "cancelled"}
        try:
            info = ta.export_osz(self._analysis, target, audio_path=audio)
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

    def inject_preview(self, osu_path: str) -> dict:
        """Dry run first, like the Tk GUI's confirmation dialog data."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            summary = ta.inject_osu_timing_points(osu_path, self._analysis, dry_run=True)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "summary": summary}

    def inject_apply(self, osu_path: str) -> dict:
        """Replace the red lines, keeping what they replace in a backup (never overwritten)."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            summary = ta.inject_osu_timing_points(osu_path, self._analysis, backup=True)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "summary": summary}

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

    # -- helpers (not exposed: underscored) ----------------------------------
    def _save_dialog(self, filename: str, file_types) -> str | None:
        import webview
        if self._window is None:
            return None
        chosen = self._window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=filename, file_types=file_types)
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
                # Verified red lines survive re-analysis: re-merge them as
                # hand-placed points (confidence 1.0, bar preserved), skipping
                # any the fresh map already found so locks never duplicate.
                points = list(result.points)
                beats = np.asarray(result.beats, dtype=np.float64)
                for lock in self._locked:
                    if any(abs(p.offset_ms - lock["offset_ms"]) < 1.0 for p in points):
                        continue
                    idx = (int(np.argmin(np.abs(beats * 1000.0 - lock["offset_ms"])))
                           if beats.size else 0)
                    points.append(ta.TimingPoint(
                        lock["offset_ms"], lock["bpm"], 1.0, idx,
                        lock["meter"], lock["meter_known"], manual=True))
                points.sort(key=lambda p: p.offset_ms)
                result.points = points
            self._analysis = result
            self._history.clear()
            self._future.clear()
            self._emit("onResult", analysis_payload(result))
        except Exception as exc:  # noqa: BLE001 -- the UI shows the message
            self._emit("onError", str(exc))
        finally:
            self._busy.release()

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
        recent = [path] + [p for p in self._cfg.get("recent", []) if p != path]
        self._cfg["recent"] = recent[:self.RECENT_LIMIT]
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
