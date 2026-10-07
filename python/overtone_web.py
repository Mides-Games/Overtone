"""Overtone web shell: the app's UI as HTML/CSS in a native WebView2 window.

The Tk GUI in ``overtone.py`` cannot draw rounded corners, soft
shadows or a GPU-composited timeline; a web view can, and the same frontend
(``app/``) moves unchanged to Tauri when the Rust engine replaces this Python
backend. The engine is not touched here: this module is a thin bridge that
calls exactly what the Tk GUI calls (``analyze_audio``, ``snap_timing_points``,
``rebuild_with_subdivision``) and turns the result into JSON.

Run it with the repo interpreter::

    .venv/Scripts/python.exe python/overtone_web.py [audio-file]

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
import time
from pathlib import Path

import numpy as np

import overtone as ta
import overtone_combine as tc
import overtone_hotkey
import overtone_library
import overtone_rust
import overtone_train as tr
from overtone_paths import data_root

HERE = Path(__file__).resolve().parent
#: Source checkout: the engine lives in ``python/``, data at the repo root.
#: Frozen build: modules sit beside the data inside the contents folder.
ROOT = HERE if getattr(sys, "frozen", False) else HERE.parent
APP_DIR = ROOT / "app"
ICON_ICO = ROOT / "assets" / "logo.ico"
LOGO_PNG = ROOT / "assets" / "logo.png"

AUDIO_TYPES = ("Audio files (*.wav;*.flac;*.ogg;*.mp3;*.m4a;*.aac;*.opus;*.aiff)",
               "All files (*.*)")
#: The picker offers the other games' timing beside osu!'s own, since the
#: reference grading reads all of them.
OSU_TYPES = ("osu! beatmap (*.osu)", "Timing from another game (*.qua;*.sm;*.ssc)",
             "All files (*.*)")
CSV_TYPES = ("CSV (*.csv)", "All files (*.*)")
WAV_TYPES = ("WAV (*.wav)", "All files (*.*)")
OSZ_TYPES = ("osu! beatmap package (*.osz)", "All files (*.*)")
#: Dropped files are staged here so "analyze the last song", the song header
#: and .osz export keep working after the drag: a temp file that vanishes
#: after the analysis would leave all three pointing at nothing.
DROP_DIR = data_root() / "drops"
PULSE_FACTORS = {"auto": 0.0, "/4": 0.25, "/2": 0.5, "x1": 1.0, "x2": 2.0, "x4": 4.0}
#: Songs whose detection settings are remembered (per-song presets), the one
#: analysed longest ago forgotten first: 182 bytes each in the config as it is
#: written, so 200 take 36 kB of its 256 kB.
SONG_OPTIONS_LIMIT = 200
#: What a song remembers of the settings its analysis ran with. The engine is
#: a preference about speed, not about the song, so it stays one setting.
SONG_OPTION_KEYS = ("delta", "persistence", "confidence", "pulse", "prefer_map_bpm",
                    "refine_beats")
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
#: A grid residual past this is worth saying out loud. 5 ms was the first
#: guess and Corpus B refused it: over the 15 ranked tracks the precision
#: engine answers, a residual over 5 ms fires on all 15, and 10 of those are
#: readings that land on the mapper's own red lines. A warning that always
#: fires says nothing. Real music sits at 11-28 ms; 30 ms fires on exactly one
#: track of the 15, and that one is the reading a mapper would reject
#: (i-remember, 38.7 ms, none of its lines within 50 ms). Measured 2026-09-28,
#: bench/corpus_b.py.
LOOSE_RESIDUAL_MS = 30.0
#: A song's timing work between sessions: JSON in <output folder>/Projects,
#: its points and locks, keyed by the audio's SHA-256 (roadmap 14.1).
PROJECT_FORMAT = "overtone-project"
PROJECT_VERSION = 1
#: Hitsound profiles the Propose card offers (docs/06 §11): the JSON files
#: in ``profiles/`` beside the app, by name. The page chooses a name from
#: that list; a path never comes from the page.
PROFILE_DIR = ROOT / "profiles"
#: The profile the CLI bakes in: always offered, and decided without a file.
DEFAULT_PROFILE = "balanced"
_PROFILE_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,39}")


def hitsound_profile_names() -> list[str]:
    """The profiles a proposal may use: ``balanced`` first, then every
    ``profiles/<name>.json`` whose name is lowercase letters, digits, ``-``
    and ``_``, in name order. A name is all the page ever sees or sends."""
    try:
        stems = sorted(p.stem for p in PROFILE_DIR.glob("*.json") if p.is_file())
    except OSError:
        stems = []
    return [DEFAULT_PROFILE] + [name for name in stems
                                if name != DEFAULT_PROFILE and _PROFILE_NAME.fullmatch(name)]


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
    return Path(os.environ.get("LOCALAPPDATA", str(ROOT))) / "osu!" / "Songs"


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

#: osu!'s skinnable hitsound names — a sample set, a hit or slider sound, an
#: optional index. A mapset's own samples, never a new encode of its song:
#: listed as candidates, every mapset with custom samples showed Audio swap.
HITSOUND_SAMPLE_NAME = re.compile(
    r"^(normal|soft|drum)-(hit(normal|whistle|finish|clap)|slider(slide|whistle|tick))\d*\.",
    re.IGNORECASE)


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


def _engine_file() -> str:
    """The file the engine's code is read from: ``overtone.py``, or in a frozen
    build the executable, whose archive holds the modules. There
    ``overtone.__file__`` names a file inside the bundle that does not exist."""
    return sys.executable if getattr(sys, "frozen", False) else ta.__file__


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


#: The stages an analysis announces, by the id the page names each one by in
#: the user's language. A test holds this to every message the engine sends,
#: so a reworded message cannot silently lose its name.
STAGES = {
    "Loading and normalizing audio…": "load",
    "Detecting attacks at sample resolution…": "attacks",
    "Scanning pulse coherence…": "coherence",
    "Resolving the beat octave…": "octave",
    "Fitting tempo sections…": "sections",
    "No fittable grid — falling back to the beat tracker…": "fallback",
    "Extracting transients and tempo hypotheses…": "transients",
    "Tracking beats (hybrid DP + PLP + peaks)…": "tracking",
    "Resolving half/double-time pulse…": "pulse",
    "Computing local tempo and persistent changes…": "local",
    "Analysing with the Rust engine…": "rust",
}


def stage_id(message: str) -> str | None:
    """The stage a progress message announces, or None for one the table does
    not know. The fallback's message carries its reason after the fixed text."""
    return next((sid for text, sid in STAGES.items() if message.startswith(text)), None)


#: What a stop raises through the engine: from the engine's own checkpoints
#: inside its stages, from the progress callback between them, and from the
#: worker before a result replaces the one on screen. The engine's class, a
#: BaseException, so the engine's fallbacks never mistake it for a failure.
AnalysisStopped = ta.AnalysisStopped


# ---------------------------------------------------------------------------
# Bridge exposed to JavaScript as window.pywebview.api
# ---------------------------------------------------------------------------

class Api:
    """Every public method is callable from JS and returns JSON types.

    Attributes are underscored on purpose: pywebview walks public attributes
    of the js_api object, and the window must not be one of them.
    """

    def __init__(self, initial_file: str = "", autorun: bool = False,
                 save_projects: bool = False) -> None:
        self._window = None
        self._autorun = bool(initial_file) and autorun
        #: Each song's timing work kept in a project file after every edit
        #: (roadmap 14.1). Off unless the window asks: a bridge built for a
        #: test or a check must never write into the user's Documents.
        self._save_projects = bool(save_projects)
        self._project_dirty = False
        self._project_error = ""
        #: (source, SHA-256) of the analysed audio, the project's key.
        self._audio_sha: tuple[str, str] | None = None
        #: path -> ((size, mtime), key): each song's key for its remembered
        #: settings, read again only when the file changes.
        self._song_keys: dict[str, tuple[tuple[int, int], str]] = {}
        #: The page's options the running analysis was started with, and the
        #: pulse that analysis found: while the one on screen stays at that
        #: octave the song keeps its own pulse option, else the octave on screen.
        self._launch_options: dict = {}
        self._launch_subdivision: float | None = None
        self._analysis: ta.Analysis | None = None
        #: The Compile view's own state (roadmap 25.14): the ordered sources
        #: with their per-segment settings, the settings for all of them, the
        #: names, the output shape, and where the last build went. In memory
        #: only: a compilation is a few clicks to rebuild and nothing in the
        #: user's config is improved by a half-made one surviving a restart.
        self._compile: list[dict] = []
        self._compile_settings: dict = dict(tc.DEFAULT_SETTINGS)
        self._compile_metadata: dict = {}
        self._compile_format: dict = {"audio_format": tc.DEFAULT_AUDIO_FORMAT,
                                      "difficulty_from": "first", "osz": False}
        self._compile_out = ""
        #: The last loudness measurement, which is a decode per segment and so
        #: is asked for rather than taken: the view shows each song's level
        #: beside the gain it was given.
        self._compile_loudness: dict | None = None
        #: One segment's song read into phrases, by (path, size, mtime): the
        #: sidecar reads the audio once per file and a range picked from a
        #: phrase is the whole point of asking.
        self._compile_sections: dict = {}
        #: A build's own lock, beside the analysis's: the analysis's belongs to
        #: one analysis, and ``stop_analysis`` reads it to decide whether
        #: anything is running. The two refuse each other instead of sharing,
        #: because encoding a marathon and analysing a song are both heavy and
        #: this machine runs one heavy job at a time.
        self._compile_lock = threading.Lock()
        #: The Train view's own state (roadmap 26.21): one source map, the
        #: rate or target BPM, each stat's keep/lock/scale, the naming, the
        #: output shape, and where the last build went. In memory only, like
        #: the compilation: a copy is a few clicks to rebuild.
        self._train: dict = {"osu": None, "rate": 1.0, "target_bpm": None,
                             "from_bpm": None, "stats": {}, "naming": {},
                             "mods": [], "audio_format": "mp3", "osz": False, "out": ""}
        #: A build's own lock, beside the analysis's and the compilation's:
        #: resampling a song and encoding it is the same heavy job either way.
        self._train_lock = threading.Lock()
        #: The global hotkey's waiter, or None while it is off: one combination
        #: delivered by the OS as a message, never a hook in any keystroke's path.
        self._train_hotkey: overtone_hotkey.HotkeyWait | None = None
        self._busy = threading.Lock()
        #: Set by stop_analysis. The engine asks it at its checkpoints inside
        #: every stage (on the worker's thread only), the worker at every
        #: stage the engine announces and once more before a result replaces
        #: the last.
        self._stop = threading.Event()
        #: The running analysis's stages as they began, in seconds from _t0,
        #: and when its engine returned (None while it runs).
        self._stages: list[dict] = []
        self._t0 = 0.0
        self._engine_done: float | None = None
        #: The timings of the analysis that produced the result on screen.
        self._last_timings: dict | None = None
        self._cfg = ta.load_config()
        #: Undo/redo stacks: what each mutation replaced, as (analysis, its
        #: point list, the locks or None). The analysis is kept because a ×2/÷2
        #: swaps in a rebuilt one, beats and all; the locks only when the
        #: mutation changed them too. A fresh analysis clears both.
        self._history: list[tuple] = []
        self._future: list[tuple] = []
        #: Locked points, by value: the editor refuses them and a fresh
        #: analysis re-merges them, so a verified red line survives both.
        #: Value-based on purpose — neighbours can come and go without
        #: shifting anything, and undo/redo re-match by offset.
        self._locked: list[dict] = []
        #: (source, times, weights) detected for a reference grade when the
        #: engine that answered kept no attacks.
        self._ref_attacks: tuple | None = None
        #: (source, flux, sample_rate, samples) for the Audio view: decoding
        #: a song costs what an analysis does, and neither the flux nor the
        #: spectrogram changes with the zoom, so both are drawn from one read.
        self._bands: tuple | None = None
        #: The last assisted fit that was answered, waiting for "Add to timing".
        self._assisted: dict | None = None
        #: The song's bytes while the page fetches them for playback.
        self._audio_bytes: bytes | None = None
        #: The percussive stem's WAV bytes with the analysis that made them:
        #: HPSS costs seconds once, then rides the cache like structure.
        self._percussion: tuple | None = None
        #: Held while the library index scans, so two scans never interleave.
        self._scanning = threading.Lock()
        #: Held while the library health check grades, so two runs never
        #: interleave; the event stops it at the next audio file.
        self._health = threading.Lock()
        self._health_stop = threading.Event()
        #: The Rust engine's structure report, keyed by (path, size, mtime):
        #: the audio is read once, the bars are re-applied on every call.
        self._structure: tuple[tuple, dict] | None = None
        #: The engine-evidence report for the live analysis object: attacks
        #: and sections never move under edits, so identity is the key.
        self._evidence: tuple | None = None
        #: The decision's proposal units and the profile behind them, keyed
        #: by .osu name: proposing runs the CLI once (for one difficulty or
        #: all of them), and accept/reject iterates the cache. A write or an
        #: undo drops its file's entry, and another song all of them. A
        #: moved map refuses at apply time through the proposal's own
        #: staleness guard.
        self._decisions: dict[str, dict] = {}
        #: The last ramp fit, keyed by (analysis, drift, max lines): computing
        #: shells to the CLI, and Use reads the cache.
        self._ramps: tuple | None = None
        #: The bytes one hitsound apply replaced, for the one-level undo.
        self._decide_undo: dict | None = None
        #: Files re-snapped, by resolved path, with the digest of the bytes
        #: the re-snap wrote: while a file still holds exactly those bytes its
        #: objects left its own red lines, and a second re-snap would move
        #: them twice. Injecting or restoring changes the bytes and frees it.
        self._resnapped: dict[str, str] = {}
        #: The same for section volumes, by tool and path: its own output
        #: reads as done but for one case (a mapper's section at the volume
        #: just written before it), which must not be written twice. Constant
        #: scroll asks History instead, since its case spans sessions.
        self._tool_wrote: dict[str, str] = {}
        if initial_file:
            self._cfg["file"] = initial_file

    #: Cap, so an evening of nudging cannot grow memory without bound.
    UNDO_DEPTH = 50

    def _snapshot(self, locks: bool) -> tuple:
        return (self._analysis, list(self._analysis.points),
                [dict(lock) for lock in self._locked] if locks else None)

    def _push_history(self, locks: bool = False) -> None:
        """Keep what the coming mutation replaces; ``locks`` when it changes
        the locks too (a ×2/÷2 rescales them, a project brings its own)."""
        if self._analysis is None:
            return
        self._history.append(self._snapshot(locks))
        del self._history[:-self.UNDO_DEPTH]
        self._future.clear()
        # Every edit comes through here first: the song's project is saved
        # with the next reply, once the edit is in place.
        self._project_dirty = True

    def _step(self, source: list, target: list) -> str | None:
        """Put the newest snapshot of ``source`` back in place, keeping what it
        replaces on ``target`` (with the locks when the snapshot has them).
        Returns the pulse the song now keeps when the step changed the
        analysis (a ×2/÷2 undone or redone), else None."""
        analysis, points, locks = source.pop()
        target.append(self._snapshot(locks is not None))
        replaced = analysis is not self._analysis
        self._analysis = analysis
        self._analysis.points = points
        if locks is not None:
            self._locked = locks
        self._prune_locks()
        self._project_dirty = True
        return self._keep_song_pulse() if replaced else None

    def _keep_song_pulse(self) -> str | None:
        """The song keeps the octave on screen: its analysis's own pulse
        option while the analysis stands at the octave it found, else that
        octave forced, so analysing it again lands where the mapper put it.
        Returns the pulse option it now keeps, None for a song with no
        settings of its own."""
        if self._analysis is None:
            return None
        source = str(self._analysis.source)
        remembered = self.song_options(source)["options"]
        if remembered is None:
            return None
        factor = float(self._analysis.subdivision)
        if self._launch_subdivision is not None and abs(factor - self._launch_subdivision) < 1e-9:
            pulse = self._launch_options.get("pulse", "auto")
        else:
            pulse = next((key for key, value in PULSE_FACTORS.items() if value == factor), None)
        if pulse not in PULSE_FACTORS:
            return None
        if remembered["pulse"] != pulse:
            self._remember_song_options(source, {**remembered, "pulse": pulse})
        return pulse

    def history_state(self) -> dict:
        return {"undo": bool(self._history), "redo": bool(self._future)}

    def undo(self) -> dict:
        """Put back what the last edit replaced: its point list, and after a
        ×2/÷2 the analysis it rebuilt (beats, pulse, locks)."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not self._history:
            return {"ok": False, "key": "no_undo"}
        pulse = self._step(self._history, self._future)
        return {"ok": True, "result": self._payload(), "pulse": pulse,
                "selected": -1, "locks": self._lock_offsets(), **self.history_state()}

    def redo(self) -> dict:
        """Re-apply an undone edit. Any new edit discards the redo stack."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not self._future:
            return {"ok": False, "key": "no_redo"}
        pulse = self._step(self._future, self._history)
        return {"ok": True, "result": self._payload(), "pulse": pulse,
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
        if self._compile_lock.locked():
            return {"ok": False, "key": "busy"}     # a compilation is being written
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        self._remember(path, options)
        self._stop.clear()
        self._stages = []
        self._t0 = time.perf_counter()
        self._engine_done = None
        self._audio_sha = None              # the file may have changed at the same path
        self._launch_options = dict(options)
        threading.Thread(target=self._worker, args=(path, params), daemon=True).start()
        return {"ok": True}

    def stop_analysis(self) -> dict:
        """Stop the running analysis where it is: at the engine's next
        checkpoint, or by ending the Rust engine's process. The result on
        screen before it stays, as after a failed analysis."""
        if not self._busy.locked():
            return {"ok": False, "key": "not_running"}
        self._stop.set()
        return {"ok": True}

    def analysis_timings(self) -> dict:
        """How long the analysis on screen took, stage by stage (``cached``
        when it came from the result cache and ran none)."""
        if self._last_timings is None:
            return {"ok": False, "key": "first"}
        return {"ok": True, **self._last_timings}

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
        self._push_history(locks=True)
        self._analysis = rebuilt
        for lock in self._locked:
            lock["bpm"] *= rebuilt.subdivision / analysis.subdivision
        return {"ok": True, "result": self._payload(), "pulse": self._keep_song_pulse(),
                "locks": self._lock_offsets(), **self.history_state()}

    # -- live confidence threshold (Phase 20): the same sections, read again --
    def _at_confidence(self, percent) -> list | dict:
        """The red lines the analysis on screen gives at a minimum confidence
        of ``percent``: its fitted sections read again, at its own pulse and
        with the current minimum change and persistence, as the ×2/÷2 buttons
        read them at another pulse, and a fallback result's stored beats the
        same way (a rebuild at its own pulse gives it back since 2026-09-26).
        A result with neither refuses (``no_grid``), as ×2/÷2 does."""
        analysis = self._analysis
        if analysis is None:
            return {"ok": False, "key": "first"}
        if not analysis.sections and analysis.base_frames is None:
            return {"ok": False, "key": "no_grid"}
        try:
            value = float(percent)
        except (TypeError, ValueError):
            return {"ok": False, "key": "bad_values"}
        if isinstance(percent, bool) or not np.isfinite(value) or not 0.0 <= value <= 100.0:
            return {"ok": False, "key": "bad_values"}
        params = self._params(self.state()["options"])
        try:
            rebuilt = ta.rebuild_with_subdivision(
                analysis, analysis.subdivision, params["min_delta"], params["persistence"],
                value / 100.0)
        except ValueError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return rebuilt.points

    def confidence_preview(self, percent) -> dict:
        """The red lines a minimum confidence of ``percent`` would give the
        analysis on screen, snapped as the page shows them. Read only."""
        points = self._at_confidence(percent)
        if isinstance(points, dict):
            return points
        return {"ok": True, "percent": float(percent),
                "points": [{"offset_ms": p.offset_ms, "bpm": p.bpm, "confidence": p.confidence}
                           for p in ta.snap_timing_points(points)]}

    def confidence_apply(self, percent) -> dict:
        """Make the red lines on screen what ``percent`` gives, locked lines
        kept, as one undoable edit; and keep ``percent`` as the setting the
        next analysis starts from, the song's own included, so analysing it
        again gives these lines. Nothing is analysed again here."""
        points = self._at_confidence(percent)
        if isinstance(points, dict):
            return points
        self._push_history()
        self._analysis.points = self._merge_locks(points, self._analysis.beats)
        value = float(percent)
        self._cfg["confidence"] = str(int(value) if value.is_integer() else value)
        source = str(self._analysis.source)
        remembered = self.song_options(source)["options"]
        if remembered is not None:
            self._remember_song_options(source, {**remembered, "confidence": value})
        else:
            self._persist()
        return {"ok": True, "result": self._payload(), "selected": -1,
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
        self._save_project()                  # a lock is work too; no payload follows
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

    def edit_meter(self, index: int, meter: int) -> dict:
        """Change one red line's bar length (beats per bar), its beat kept."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._is_locked(index):
            return {"ok": False, "key": "locked"}
        try:
            index = int(index)
            points = ta.set_meter(self._analysis.points, index, meter)
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return self._edited(index, None)

    def edit_split(self, index: int, at_ms: float) -> dict:
        """Split one section where its tempo changes: a red line on its grid's
        beat nearest ``at_ms``, both halves refitted to their attacks."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if self._is_locked(index):
            return {"ok": False, "key": "locked"}
        try:
            index = int(index)
            times, weights = self._attacks()
            points, report = ta.split_section(
                self._analysis.points, self._analysis.beats, index, float(at_ms), times, weights,
                float(self._analysis.duration) * 1000.0)
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return {**self._edited(None, report["split_ms"]), "report": report}

    def edit_merge(self, index: int) -> dict:
        """Merge one section with the next: that red line goes, the span is
        refitted from this one's line. Locked lines refuse, as they do any edit."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            index = int(index)
            for held in (index, index + 1):
                if self._is_locked(held):
                    return {"ok": False, "key": "locked", "index": held}
            times, weights = self._attacks()
            points, report = ta.merge_sections(
                self._analysis.points, self._analysis.beats, index, times, weights,
                float(self._analysis.duration) * 1000.0)
        except (ValueError, TypeError, IndexError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._push_history()
        self._analysis.points = points
        return {**self._edited(index, None), "report": report}

    # -- exports and .osu injection (same engine calls as the Tk GUI) -----
    def osu_text(self) -> dict:
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        return {"ok": True, "text": ta.osu_timing_text(
            self._analysis, decimals=self._settings()["offset_decimals"])}

    #: The other games this writes timing for, by the id the page asks with.
    OTHER_GAMES = ("quaver", "stepmania")

    def other_game_text(self, game: str) -> dict:
        """The same red lines as another game's timing, with the check.

        Read only, and honest about its limits: the reply carries what
        :func:`overtone.verify_export` found by reading the text back — how
        far the written grid's beats sit from Overtone's — and no claim that
        the game accepts the file, because none has opened one here.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if game not in self.OTHER_GAMES:
            return {"ok": False, "key": "bad_game"}
        try:
            if game == "quaver":
                text = ta.quaver_timing_text(
                    self._analysis, decimals=self._settings()["offset_decimals"])
            else:
                text = ta.stepmania_timing_text(self._analysis)
            check = ta.verify_export(self._analysis, text, game)
        except (ValueError, TypeError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "game": game, "text": text, "check": check}

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
        # The song's name comes from its own maps or its tags: say which.
        return {"ok": True, "path": target, "points": info["points"],
                "metadata": info["metadata"]}

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

    def import_osz(self, osz_path: str, songs_dir: str = "") -> dict:
        """An `.osz` file into Songs, then adopted like an imported folder.

        What double-clicking an `.osz` does now that the installer associates
        it: the archive is read and its files copied under
        `Songs/<archive name>` — never moved, never overwritten into a folder
        that already holds beatmaps (opening that set is the honest answer to
        importing it twice). A zip with no `.osu` inside is not a beatmap
        archive; a member escaping the folder refuses the whole import.
        Returns what `import_folder` would, plus whether anything was written.
        """
        import zipfile

        source = Path(str(osz_path))
        if not source.is_file():
            return {"ok": False, "key": "bad_file", "detail": source.name}
        root = Path(str(songs_dir) or self._songs_root())
        try:
            with zipfile.ZipFile(source) as archive:
                members = archive.infolist()
                for member in members:
                    target = Path(member.filename)
                    if member.is_dir() or not member.filename.strip():
                        continue
                    if target.is_absolute() or ".." in target.parts:
                        return {"ok": False, "key": "bad_archive",
                                "detail": f"{member.filename} escapes the folder."}
                sheets = [m for m in members
                          if not m.is_dir() and m.filename.lower().endswith(".osu")]
                if not sheets:
                    return {"ok": False, "key": "bad_archive",
                            "detail": f"{source.name} holds no .osu file."}
                folder = root / source.stem
                folder.mkdir(parents=True, exist_ok=True)
                wrote = False
                if not any(folder.glob("*.osu")):
                    for member in members:
                        if member.is_dir() or not member.filename.strip():
                            continue
                        target = folder / Path(member.filename)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        if not target.is_file():
                            with archive.open(member) as origin, \
                                    open(target, "wb") as copy:
                                copy.write(origin.read())
                            wrote = True
        except zipfile.BadZipFile:
            return {"ok": False, "key": "bad_file", "detail": source.name}
        except OSError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        reply = self.import_folder(folder)
        reply["wrote"] = wrote
        return reply

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
        Hitsound samples are not songs and are left out. Read only, no
        analysis needed."""
        base = Path(str(folder))
        if not base.is_dir():
            return {"ok": False, "key": "bad_folder"}
        try:
            audios = sorted(p.name for p in base.iterdir()
                            if p.suffix.lower() in ta.AUDIO_EXTENSIONS and p.is_file()
                            and not HITSOUND_SAMPLE_NAME.match(p.name))
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
            return self._playback_reply(name, ta.hitsound_playback(ta.read_osu_beatmap(path), folder,
                                                                   skin=self._skin()))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}

    @staticmethod
    def _playback_reply(name: str, plan: dict) -> dict:
        """A playback plan as the page schedules it: columns of events and
        objects, and the bytes of each sample they play. A sample with no
        audio in it (a mute) says so, so the page does not count it as one
        it failed to decode."""
        samples = {}
        for key, sample in plan["samples"].items():
            path = Path(sample["path"])
            raw = path.read_bytes()
            data = _playable_sample(raw)
            samples[key] = {"source": sample["source"], "name": path.name,
                            "empty": ta._sample_empty(path, len(raw)),
                            "data": base64.b64encode(data).decode("ascii")}
        return {"ok": True, "file": name,
                "events": {"t": [e["t"] for e in plan["events"]],
                           "keys": [e["keys"] for e in plan["events"]],
                           "volume": [e["volume"] for e in plan["events"]],
                           "adds": [e["adds"] for e in plan["events"]]},
                "loops": {"t": [b["t"] for b in plan["loops"]],
                          "end": [b["end"] for b in plan["loops"]],
                          "keys": [b["keys"] for b in plan["loops"]],
                          "volume": [b["volume"] for b in plan["loops"]]},
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

    # -- sample bank (Phase 6, H6) ---------------------------------------------
    def _skin(self) -> Path | None:
        """The skin folder playback asks before Overtone's own samples: the
        one chosen in the settings, while it is still there."""
        folder = self._settings()["skin_folder"]
        return Path(folder) if folder and Path(folder).is_dir() else None

    @staticmethod
    def _same_folder(a: Path | None, b: Path | None) -> bool:
        if a is None or b is None:
            return False
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))

    def sample_bank(self, folder: str = "") -> dict:
        """What a sample folder holds, named as osu! names it (H6): ``folder``,
        or with none the analysed song's own, whose missing samples fall back
        to the skin playback uses. Read only; nothing is remembered."""
        if folder:
            base = Path(str(folder))
        elif self._analysis is None:
            return {"ok": False, "key": "first"}
        else:
            base = Path(str(self._analysis.source)).parent
        if not base.is_absolute() or not base.is_dir():
            return {"ok": False, "key": "bad_folder"}
        skin = self._skin()
        try:
            bank = ta.sample_bank(base, skin=skin)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        song = self._analysis is not None and self._same_folder(
            base, Path(str(self._analysis.source)).parent)
        return {"ok": True, "bank": bank, "song": song, "in_use": self._same_folder(base, skin),
                "skin": str(skin) if skin else ""}

    def _skins_start(self) -> str:
        """Where the Samples card's folder dialog opens: beside the skin in
        use, else osu!'s Skins beside the Songs folder, else anywhere."""
        skin = self._skin()
        if skin is not None:
            return str(skin.parent)
        skins = Path(self._songs_root()).parent / "Skins"
        return str(skins) if skins.is_dir() else ""

    def pick_sample_folder(self) -> dict:
        """A folder dialog for the Samples card, and the bank of the folder
        chosen. Only read: choosing it for playback is a setting of its own."""
        import webview
        if self._window is None:
            return {"ok": False, "key": "cancelled"}
        chosen = self._window.create_file_dialog(webview.FOLDER_DIALOG,
                                                 directory=self._skins_start())
        if not chosen:
            return {"ok": False, "key": "cancelled"}
        return self.sample_bank(chosen[0] if isinstance(chosen, (list, tuple)) else str(chosen))

    def sample_audition(self, folder: str, file: str) -> dict:
        """One sample's bytes, for the page to hear: ``file`` is a hitsound
        sample's name (``soft-hitclap2.wav``), alone, inside ``folder``, an
        absolute folder the bank named (Overtone's own samples included).
        Nothing that is not named as a sample is read."""
        base, name = Path(str(folder or "")), str(file or "")
        path = base / name
        if (not name or Path(name).name != name or not HITSOUND_SAMPLE_NAME.match(name)
                or Path(name).suffix.lower() not in ta.SAMPLE_EXTENSIONS
                or not base.is_absolute() or not path.is_file()):
            return {"ok": False, "key": "sb_gone"}
        try:
            raw = path.read_bytes()
        except OSError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "folder": str(base), "file": name,
                "empty": ta._sample_empty(path, len(raw)),
                "data": base64.b64encode(_playable_sample(raw)).decode("ascii")}

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

    def hitsound_profiles(self, file: str | None = None) -> dict:
        """The hitsound profiles the Propose card offers, by name,
        ``balanced`` (the default) first.

        With a map, ``suggested`` names the profile its own metadata asks for
        (:func:`overtone.beatmap_genre`, the classifier the profiles were
        measured with) when one of that name is on disk; ``""`` when the map
        says nothing, when its genre has no profile, or when it cannot be
        read. A suggestion, never a choice: the page preselects it and the
        user can pick another, and nothing is decided until Propose is pressed.
        """
        names = hitsound_profile_names()
        suggested = ""
        name = str(file or "")
        # The same bare-name-beside-the-song rule every map call here uses: a
        # path never comes from the page.
        if name and self._analysis is not None and Path(name).name == name                 and name.lower().endswith(".osu"):
            path = Path(str(self._analysis.source)).parent / name
            if path.is_file():
                try:
                    genre = ta.beatmap_genre(ta.read_osu_beatmap(path))
                except (ValueError, OSError):
                    genre = ""
                suggested = genre if genre in names else ""
        return {"ok": True, "profiles": names, "default": DEFAULT_PROFILE,
                "suggested": suggested}

    def hitsound_decide_propose(self, file: str, profile: str | None = None) -> dict:
        """Propose every decidable point's sound through the Rust sidecar,
        decided with ``profile``: a name :meth:`hitsound_profiles` lists,
        ``balanced`` when none is given. Anything else is refused before the
        sidecar runs. One heavy job at a time; the units stay cached for
        accept/reject."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        name = DEFAULT_PROFILE if profile is None else profile
        if not isinstance(name, str) or name not in hitsound_profile_names():
            return {"ok": False, "key": "bad_profile"}
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            report = overtone_rust.hitsound(
                str(self._analysis.source), str(path),
                profile=None if name == DEFAULT_PROFILE else PROFILE_DIR / f"{name}.json")
        except overtone_rust.SidecarUnavailable:
            return {"ok": False, "key": "no_rust"}
        except (RuntimeError, ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        units = report.get("units", [])
        self._decisions[str(path.name)] = {"units": units, "profile": name}
        return {"ok": True, "file": str(path.name), "units": units, "profile": name}

    def hitsound_decide_propose_all(self, profile: str | None = None) -> dict:
        """Propose for every difficulty beside the song at once, the maps
        :meth:`song_maps` lists: one run of the sidecar analyses the audio
        once and decides each map on it, and each map's units are cached as
        its own proposal is, so choosing another difficulty shows them
        without running the sidecar again. A map the sidecar cannot read is
        that map's error alone. The profile is a listed name, as for one
        map; one heavy job at a time. Nothing is written."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        name = DEFAULT_PROFILE if profile is None else profile
        if not isinstance(name, str) or name not in hitsound_profile_names():
            return {"ok": False, "key": "bad_profile"}
        maps = self.song_maps().get("maps", [])
        if not maps:
            return {"ok": False, "key": "hsv_none"}
        folder = Path(str(self._analysis.source)).parent
        paths = [str(folder / m["file"]) for m in maps]
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            report = overtone_rust.hitsound(
                str(self._analysis.source), paths,
                profile=None if name == DEFAULT_PROFILE else PROFILE_DIR / f"{name}.json")
        except overtone_rust.SidecarUnavailable:
            return {"ok": False, "key": "no_rust"}
        except (RuntimeError, ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        # Each entry names the map it answers, as it was passed.
        answered = {entry.get("map"): entry for entry in report.get("maps", [])}
        rows = []
        for m, path in zip(maps, paths):
            entry = answered.get(path, {"error": "The engine did not answer for this map."})
            if "units" in entry:
                self._decisions[m["file"]] = {"units": entry["units"], "profile": name}
                rows.append({"file": m["file"], "difficulty": m["difficulty"],
                             "units": len(entry["units"])})
            else:
                rows.append({"file": m["file"], "difficulty": m["difficulty"],
                             "error": str(entry.get("error", ""))})
        return {"ok": True, "profile": name, "maps": rows}

    def hitsound_decide_cached(self, file: str) -> dict:
        """The proposal cached for one difficulty beside the song, as
        :meth:`hitsound_decide_propose` answered it, without running the
        sidecar: ``no_proposal`` when there is none."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        cached = self._decisions.get(str(path.name))
        if cached is None:
            return {"ok": False, "key": "no_proposal"}
        return {"ok": True, "file": str(path.name), "units": cached["units"],
                "profile": cached.get("profile", DEFAULT_PROFILE)}

    def hitsound_decide_proposed(self) -> dict:
        """Which difficulties beside the song have a proposal cached, in
        :meth:`song_maps` order, with its profile and how many sounds."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        rows = []
        for m in self.song_maps().get("maps", []):
            cached = self._decisions.get(m["file"])
            if cached is not None:
                rows.append({"file": m["file"], "difficulty": m["difficulty"],
                             "profile": cached.get("profile", DEFAULT_PROFILE),
                             "units": len(cached["units"])})
        return {"ok": True, "maps": rows}

    def _decide_units(self, path: Path, edits, choices=None) -> list | dict:
        """The cached proposal's units, none when hand edits come alone (they
        need no Rust), or a refusal: nothing to apply, or edits that are not a
        list of objects. ``choices`` swaps in the runner-ups the page chose."""
        if edits is not None and not (isinstance(edits, list)
                                      and all(isinstance(e, dict) for e in edits)):
            return {"ok": False, "key": "error", "detail": "edits must be a list of objects"}
        cached = self._decisions.get(str(path.name))
        if cached is None and not edits:
            return {"ok": False, "key": "no_proposal"}
        return self._chosen(cached["units"] if cached else [], choices)

    @staticmethod
    def _chosen(units: list, choices) -> list | dict:
        """The units with an alternative in place of the proposal wherever the
        page chose one: ``[object, part, edge, index]``, the index into that
        unit's ``alternatives`` (best first, as the CLI ranks them). An index
        the unit does not have, or a sound with no unit, refuses them all."""
        if not choices:
            return units
        if not (isinstance(choices, list) and all(
                isinstance(c, list) and len(c) == 4 and isinstance(c[3], int) for c in choices)):
            return {"ok": False, "key": "error",
                    "detail": "choices must be [object, part, edge, index] lists"}
        pick = {(c[0], c[1], c[2]): c[3] for c in choices}
        out = []
        for unit in units:
            index = pick.pop((unit.get("object"), unit.get("part"), unit.get("edge")), None)
            if index is None:
                out.append(unit)
                continue
            alternatives = unit.get("alternatives") or []
            if not 0 <= index < len(alternatives):
                return {"ok": False, "key": "error",
                        "detail": f"The sound at {unit.get('time_ms')} ms has no alternative {index}."}
            out.append({**unit, "proposal": alternatives[index]})
        if pick:
            return {"ok": False, "key": "error",
                    "detail": f"{len(pick)} chosen sounds have no proposal: propose again."}
        return out

    def hitsound_decide_preview(self, file: str, accept: list | None = None,
                                edits: list | None = None, choices: list | None = None) -> dict:
        """What applying the cached proposal (with the chosen alternatives) and
        the hand edits would change. Read only."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        units = self._decide_units(path, edits, choices)
        if isinstance(units, dict):
            return units
        try:
            accepted = None if accept is None else {tuple(a) for a in accept}
            preview = ta.preview_proposals(ta.read_osu_beatmap(path), units, accepted, edits)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": str(path.name), "units": preview["units"],
                "accepted": preview["accepted"], "edited": preview["edited"],
                "chosen": len(choices or []), "would_change": preview["would_change"]}

    def hitsound_decide_playback(self, file: str, accept: list | None = None,
                                 edits: list | None = None, choices: list | None = None) -> dict:
        """The cached proposal and the hand edits as the transport plays them:
        the ticked changes made to the map in memory, exactly as the write
        would make them, then played as the written file would be. Nothing is
        written. Also counts the sounds that play differently from the file,
        and when the first of them falls (seconds), so the page can start
        just before it."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        units = self._decide_units(path, edits, choices)
        if isinstance(units, dict):
            return units
        try:
            accepted = None if accept is None else {tuple(a) for a in accept}
            beatmap = ta.read_osu_beatmap(path)
            skin = self._skin()
            written = ta.hitsound_playback(beatmap, path.parent, skin=skin)
            changes = ta.proposal_changes(beatmap, units, accepted)
            edited = ta.edit_changes(beatmap, edits, changes["changes"])
            ta.set_object_hitsounds(beatmap, edited["changes"])
            plan = ta.hitsound_playback(beatmap, path.parent, skin=skin)
            reply = self._playback_reply(str(path.name), plan)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        # Hitsound fields never move a sound, so both lists hold the same
        # sounds in the same order; a slider's slide is a sound too.
        differ = sorted([b["t"] for part in ("events", "loops")
                         for a, b in zip(written[part], plan[part]) if a != b])
        return {**reply, "proposal": True, "units": changes["units"],
                "accepted": changes["accepted"], "edited": edited["edited"],
                "chosen": len(choices or []), "differs": len(differ),
                "first": differ[0] if differ else None}

    def hitsound_decide_apply(self, file: str, accept: list | None = None,
                              copy: bool = False, edits: list | None = None,
                              choices: list | None = None) -> dict:
        """Write the accepted proposals and the hand edits through P-2: over
        the original with a backup, or onto a ``<name>_hitsounded.osu`` copy
        that must not exist. Remembers the replaced bytes for the one-level
        undo."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        units = self._decide_units(path, edits, choices)
        if isinstance(units, dict):
            return units
        dest = path.with_name(path.stem + "_hitsounded.osu") if copy else None
        try:
            accepted = None if accept is None else {tuple(a) for a in accept}
            if dest is None:
                previous = path.read_bytes()
            result = ta.apply_proposals(path, units, accepted, dest, edits=edits)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        # Written, the proposal is spent, as the page clears it: choosing the
        # difficulty again must not bring it back.
        self._decisions.pop(str(path.name), None)
        if dest is None:
            self._decide_undo = {"path": str(path), "bytes": previous}
        else:
            self._decide_undo = None
        return {"ok": True, "file": str(path.name), "changed": result["changed"],
                "written": result["written"], "backup": result["backup"],
                "dest": result["dest"], "undo": self._decide_undo is not None}

    # -- hitsound difficulty (Phase 6, H5 export) ------------------------------
    def _hsdiff_paths(self, file: str, fill: bool):
        """The source .osu beside the analysed song, and the difficulties to
        fill from: the song's others, the ones with most objects first."""
        path = self._decide_file(file)
        if isinstance(path, dict):
            return path
        others = []
        if fill:
            maps = self.song_maps().get("maps", [])
            others = [path.parent / m["file"] for m in sorted(maps, key=lambda m: -m["objects"])
                      if m["file"] != path.name]
        return path, others

    def _hsdiff(self, file: str, fill: bool, preview: bool) -> dict:
        found = self._hsdiff_paths(file, bool(fill))
        if isinstance(found, dict):
            return found
        path, others = found
        dest = ta.hitsound_difficulty_path(path)
        if dest.exists():
            return {"ok": False, "key": "hsd_exists", "dest": dest.name}
        try:
            result = ta.write_hitsound_difficulty(path, others, preview=preview)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "dest": Path(result["dest"]).name,
                "others": len(others), "written": result["written"],
                **{k: result[k] for k in ("circles", "from_source", "from_others", "merged",
                                          "stacked", "stacked_times", "inexact", "inexact_times")}}

    def hitsound_difficulty_preview(self, file: str, fill: bool = True) -> dict:
        """What the hitsound difficulty built from ``file`` would hold, and
        whether every circle plays its sound exactly. Read only."""
        return self._hsdiff(file, fill, True)

    def hitsound_difficulty_write(self, file: str, fill: bool = True) -> dict:
        """Write the hitsound difficulty as a new .osu beside ``file``: it
        never replaces one, and History lists it."""
        return self._hsdiff(file, fill, False)

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
        # A proposal made since the write was decided on the bytes just replaced.
        self._decisions.pop(path.name, None)
        return {"ok": True, "file": path.name, "backup": str(backup)}

    # --- Compile: several maps and their songs as one (Phase 25, row 25.14) ---

    def compile_state(self) -> dict:
        """The segment list, the settings, and what they would build.

        Everything the Compile view draws comes from here, and it is
        recomputed on every change rather than patched: planning reads a few
        `.osu` files and each song's header, which costs milliseconds, and a
        list that cannot drift from its plan is worth more than that.

        ``plan`` is the compilation document; ``check`` is the dry run, which
        is None while any segment refuses, since there is nothing to build.
        """
        sources = [dict(spec) for spec in self._compile]
        reply: dict = {"ok": True, "sources": sources,
                       "settings": dict(self._compile_settings),
                       "metadata": dict(self._compile_metadata),
                       "format": dict(self._compile_format),
                       "out": self._compile_out,
                       "loudness": self._compile_loudness,
                       "plan": None, "check": None,
                       "busy": self._busy.locked() or self._compile_lock.locked()}
        if not sources:
            return reply
        try:
            plan = tc.plan_compilation(sources, self._compile_settings)
        except (ValueError, OSError) as exc:
            reply["ok"] = False
            reply["key"] = "error"
            reply["detail"] = str(exc)
            return reply
        reply["plan"] = plan
        if plan["usable"]:
            try:
                reply["check"] = tc.build_compilation(
                    plan, self._compile_out or "compilation", dry_run=True,
                    allow_existing=True, metadata=self._compile_metadata,
                    difficulty=self._compile_format["difficulty_from"],
                    audio_format=self._compile_format["audio_format"])
                reply["occupied"] = self._compile_occupied()
            except (ValueError, OSError) as exc:
                reply["key"] = "cannot_build"
                reply["detail"] = str(exc)
        return reply

    def _compile_occupied(self) -> str:
        """The beatmap already in the chosen output folder, if any. A build
        into it is adding to a mapset, which is a thing to say out loud."""
        folder = Path(self._compile_out) if self._compile_out else None
        if folder is None or not folder.is_dir():
            return ""
        found = sorted(path.name for path in folder.iterdir()
                       if path.suffix.lower() == ".osu")
        return found[0] if found else ""

    def compile_add(self, paths: list | None = None) -> dict:
        """Add difficulties to the compilation, in the order they arrive.

        With no paths the window asks for files; several at once, since a
        marathon is several maps. A map already in the list is added again
        rather than refused: the same difficulty twice, at two ranges, is a
        reasonable thing to want.
        """
        chosen = [str(path) for path in (paths or []) if str(path).strip()]
        if not chosen:
            chosen = self._pick_osu_files()
        if not chosen:
            return {"ok": False, "key": "nothing_picked"}
        missing = [path for path in chosen if not Path(path).is_file()]
        if missing:
            return {"ok": False, "key": "bad_file", "detail": Path(missing[0]).name}
        for path in chosen:
            self._compile.append({"osu": path})
        self._compile_loudness = None
        return self.compile_state()

    def compile_add_open_song(self) -> dict:
        """Add every difficulty beside the song that is open, if any."""
        file = self._cfg.get("file") or ""
        folder = Path(str(file)).parent if file else None
        if folder is None or not folder.is_dir():
            return {"ok": False, "key": "no_song"}
        found = sorted(path for path in folder.glob("*.osu"))
        if not found:
            return {"ok": False, "key": "no_maps"}
        for path in found:
            self._compile.append({"osu": str(path)})
        return self.compile_state()

    def compile_remove(self, index: int) -> dict:
        if not 0 <= int(index) < len(self._compile):
            return {"ok": False, "key": "bad_index"}
        self._compile.pop(int(index))
        self._compile_loudness = None
        return self.compile_state()

    def compile_clear(self) -> dict:
        self._compile = []
        self._compile_loudness = None
        return self.compile_state()

    def compile_move(self, index: int, delta: int) -> dict:
        """Move one segment up or down. The order given is the order built."""
        index, delta = int(index), int(delta)
        target = index + delta
        if not (0 <= index < len(self._compile) and 0 <= target < len(self._compile)):
            return {"ok": False, "key": "bad_index"}
        self._compile[index], self._compile[target] = \
            self._compile[target], self._compile[index]
        return self.compile_state()

    def compile_update(self, index: int, changes: dict) -> dict:
        """A segment's own range, gain or gap. An empty value clears it, so a
        typed range can be given back to the objects."""
        if not 0 <= int(index) < len(self._compile):
            return {"ok": False, "key": "bad_index"}
        spec = dict(self._compile[int(index)])
        for key, value in dict(changes or {}).items():
            if key not in tc.SOURCE_KEYS or key == "osu":
                return {"ok": False, "key": "bad_values", "detail": str(key)}
            if value in (None, ""):
                spec.pop(key, None)
                continue
            try:
                spec[key] = float(value)
            except (TypeError, ValueError):
                return {"ok": False, "key": "bad_values", "detail": str(key)}
        self._compile[int(index)] = spec
        # A level was measured over a range; a new range is a new question.
        if {"start_ms", "end_ms"} & set(changes or {}):
            self._compile_loudness = None
        return self.compile_state()

    def compile_settings(self, changes: dict) -> dict:
        """The settings that shape the whole compilation."""
        settings = dict(self._compile_settings)
        for key, value in dict(changes or {}).items():
            if key not in tc.DEFAULT_SETTINGS:
                return {"ok": False, "key": "bad_values", "detail": str(key)}
            if key in ("strict", "junction_breaks", "junction_bookmarks",
                       "start_on_downbeat"):
                settings[key] = bool(value)
            elif key == "preview_from":
                settings[key] = "first" if value in ("first", None, "") else int(value)
            else:
                try:
                    settings[key] = max(0.0, float(value))
                except (TypeError, ValueError):
                    return {"ok": False, "key": "bad_values", "detail": str(key)}
        self._compile_settings = settings
        return self.compile_state()

    def compile_metadata(self, changes: dict) -> dict:
        """What the compilation says it is. An empty field goes back to chosen."""
        metadata = dict(self._compile_metadata)
        for key, value in dict(changes or {}).items():
            if key not in tc.METADATA_FIELDS:
                return {"ok": False, "key": "bad_values", "detail": str(key)}
            text = " ".join(str(value).split())
            if text:
                metadata[key] = text
            else:
                metadata.pop(key, None)
        self._compile_metadata = metadata
        return self.compile_state()

    def compile_format(self, changes: dict) -> dict:
        """The audio format, the difficulty choice and whether to zip."""
        chosen = dict(self._compile_format)
        for key, value in dict(changes or {}).items():
            if key == "audio_format":
                if value not in tc.AUDIO_FORMATS:
                    return {"ok": False, "key": "bad_values", "detail": str(value)}
                chosen[key] = str(value)
            elif key == "difficulty_from":
                if value not in tc.DIFFICULTY_CHOICES:
                    return {"ok": False, "key": "bad_values", "detail": str(value)}
                chosen[key] = str(value)
            elif key == "osz":
                chosen[key] = bool(value)
            else:
                return {"ok": False, "key": "bad_values", "detail": str(key)}
        self._compile_format = chosen
        return self.compile_state()

    def compile_sections(self, index: int) -> dict:
        """The phrases of one segment's song, to pick a range from.

        ``overtone-cli structure`` reads that song once; the answer is kept
        by path, size and modification time, so picking from the same song
        again costs nothing. No analysis is needed and nothing is written:
        this is the structure view's own engine, asked about a file instead
        of about the open song.

        A phrase becomes a range through ``compile_update`` like any other —
        the edges are the phrase's own, and ``start_on_downbeat`` is what
        puts them on a bar line.
        """
        if not 0 <= int(index) < len(self._compile):
            return {"ok": False, "key": "bad_index"}
        if self._busy.locked() or self._compile_lock.locked():
            return {"ok": False, "key": "busy"}
        segment = tc.read_segment(self._compile[int(index)]["osu"],
                                  audio=self._compile[int(index)].get("audio"))
        path = segment["audio"]["path"]
        if not path:
            return {"ok": False, "key": "no_audio"}
        source = Path(path)
        try:
            stat = source.stat()
        except OSError:
            return {"ok": False, "key": "bad_file"}
        key = (str(source), stat.st_size, stat.st_mtime_ns)
        if key not in self._compile_sections:
            try:
                report = overtone_rust.structure(source)
            except overtone_rust.SidecarUnavailable:
                return {"ok": False, "key": "no_rust"}
            except (RuntimeError, OSError) as exc:
                return {"ok": False, "key": "error", "detail": str(exc)}
            self._compile_sections[key] = [
                {"kind": str(row.get("kind") or ""),
                 "start_ms": round(float(row["start_s"]) * 1000.0, 3),
                 "end_ms": round(float(row["end_s"]) * 1000.0, 3),
                 "level_db": round(float(row.get("level_db") or 0.0), 2),
                 "repeats": int(row.get("repeats") or 0)}
                for row in report.get("sections", ())
                if float(row.get("end_s", 0.0)) > float(row.get("start_s", 0.0))]
        return {"ok": True, "segment": int(index), "file": source.name,
                "sections": self._compile_sections[key]}

    def compile_match_loudness(self, target: str = "median") -> dict:
        """Measure every song and set the gains so none of them jumps.

        A decode per segment, so it runs on the same lock the build does and
        answers with events: ``onCompileProgress`` per song, then
        ``onCompileLoudness``. The gains land on the segments as if they had
        been typed, so they can be changed afterwards.
        """
        if not self._compile:
            return {"ok": False, "key": "no_sources"}
        try:
            plan = tc.plan_compilation(self._compile, self._compile_settings)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if self._busy.locked():
            return {"ok": False, "key": "busy"}
        if not self._compile_lock.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        threading.Thread(target=self._loudness_worker, args=(plan, target),
                         daemon=True).start()
        return {"ok": True}

    def _loudness_worker(self, plan: dict, target) -> None:
        try:
            report = tc.loudness_plan(
                plan, target,
                progress=lambda step, done, total: self._emit(
                    "onCompileProgress", {"step": step, "done": done, "total": total}))
            for row in report["segments"]:
                if 0 <= row["segment"] < len(self._compile) and row["lufs"] is not None:
                    self._compile[row["segment"]]["gain_db"] = row["gain_db"]
            self._compile_loudness = report
            self._emit("onCompileLoudness", {"ok": True, "loudness": report})
        except (ValueError, OSError) as exc:
            self._emit("onCompileLoudness", {"ok": False, "key": "error",
                                             "detail": str(exc)})
        except Exception as exc:  # noqa: BLE001 -- the view shows the message
            self._emit("onCompileLoudness", {"ok": False, "key": "error",
                                             "detail": f"{type(exc).__name__}: {exc}"})
        finally:
            self._compile_lock.release()

    def compile_order(self, rule: str = "tempo") -> dict:
        """An order to put the songs in, proposed and not applied.

        Cheap: it reads the plan the view already has. The reply carries the
        proposal beside the whole state, and ``compile_reorder`` is what puts
        it into effect once somebody says so.
        """
        if len(self._compile) < 3:
            return {"ok": False, "key": "too_few"}
        try:
            plan = tc.plan_compilation(self._compile, self._compile_settings)
            proposal = tc.order_plan(plan, str(rule), self._compile_loudness)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {**self.compile_state(), "proposal": proposal}

    def compile_reorder(self, order: list) -> dict:
        """Put the songs in the order given, which is the proposal's or any
        other: the view asks, this obeys."""
        try:
            wanted = [int(n) for n in (order or [])]
        except (TypeError, ValueError):
            return {"ok": False, "key": "bad_values"}
        if sorted(wanted) != list(range(len(self._compile))):
            return {"ok": False, "key": "bad_values"}
        self._compile = [self._compile[n] for n in wanted]
        if self._compile_loudness:
            # The levels were measured per segment, and the segments moved.
            self._compile_loudness = None
        return self.compile_state()

    def compile_pick_folder(self) -> dict:
        """Where to build. Remembered until the window closes, so Build can
        ask once and then be a button."""
        folder = self.pick_folder()
        if not folder:
            return {"ok": False, "key": "nothing_picked"}
        self._compile_out = str(folder)
        return self.compile_state()

    def compile_build(self, folder: str = "", allow_existing: bool = False) -> dict:
        """Build it. Starts a worker; the report arrives as a JS event.

        Encoding a marathon takes seconds and the window must stay alive, so
        this follows the analysis's shape: the same lock, so one heavy job
        runs at a time, and events for progress and the result. There is no
        stop: a half-written mapset is worse than waiting for a short one.
        """
        out = str(folder or self._compile_out or "")
        if not out:
            return {"ok": False, "key": "no_folder"}
        if not self._compile:
            return {"ok": False, "key": "no_sources"}
        self._compile_out = out
        occupied = self._compile_occupied()
        if occupied and not allow_existing:
            return {"ok": False, "key": "folder_occupied", "detail": occupied}
        try:
            plan = tc.plan_compilation(self._compile, self._compile_settings)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if not plan["usable"]:
            return {"ok": False, "key": "plan_refused",
                    "detail": "; ".join(row.get("why", "") for row in plan["refusals"])}
        if self._busy.locked():
            return {"ok": False, "key": "busy"}     # an analysis is running
        if not self._compile_lock.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        threading.Thread(target=self._compile_worker, args=(plan, out),
                         daemon=True).start()
        return {"ok": True}

    def _compile_worker(self, plan: dict, folder: str) -> None:
        try:
            report = tc.build_compilation(
                plan, folder, allow_existing=True, metadata=self._compile_metadata,
                difficulty=self._compile_format["difficulty_from"],
                audio_format=self._compile_format["audio_format"],
                osz=bool(self._compile_format["osz"]),
                progress=lambda step, done, total: self._emit(
                    "onCompileProgress", {"step": step, "done": done, "total": total}))
            self._emit("onCompileDone", {"ok": True, "report": report})
        except (ValueError, OSError) as exc:
            self._emit("onCompileDone", {"ok": False, "key": "error",
                                         "detail": str(exc)})
        except Exception as exc:  # noqa: BLE001 -- the view shows the message
            self._emit("onCompileDone", {"ok": False, "key": "error",
                                         "detail": f"{type(exc).__name__}: {exc}"})
        finally:
            self._compile_lock.release()

    # ------------------------------------------------------------------
    # Train — a practice copy of one map at another speed (Phase 26, 26.21)
    # ------------------------------------------------------------------

    def _train_plan(self) -> dict | None:
        """The plan for the picked map, or None while none is picked."""
        if not self._train.get("osu"):
            return None
        settings = self._train
        try:
            return tr.plan_practice(
                settings["osu"], rate=settings.get("rate"),
                target_bpm=settings.get("target_bpm"),
                from_bpm=settings.get("from_bpm"),
                stats=dict(settings.get("stats") or {}),
                naming=dict(settings.get("naming") or {}),
                mods=list(settings.get("mods") or []))
        except (ValueError, OSError):
            return None

    def train_state(self) -> dict:
        """The source map, the rate and stats, and what they would build.

        Everything the Train view draws comes from here, and it is
        recomputed on every change rather than patched: planning reads one
        `.osu` file and its header, which costs milliseconds, and a view
        that cannot drift from its plan is worth more than that.

        ``plan`` is the practice document; ``check`` is the dry run, which
        is None while the source refuses, since there is nothing to build.
        """
        reply: dict = {"ok": True, "source": self._train.get("osu"),
                       "settings": {key: self._train.get(key)
                                    for key in ("rate", "target_bpm", "from_bpm",
                                                "stats", "naming", "mods",
                                                "audio_format", "osz", "out")},
                       "plan": None, "check": None, "feel": None,
                       "busy": self._busy.locked() or self._train_lock.locked(),
                       "hotkey": self._train_hotkey_ensure()}
        if not self._train.get("osu"):
            return reply
        try:
            plan = self._train_plan()
        except (ValueError, OSError) as exc:
            reply["ok"] = False
            reply["key"] = "error"
            reply["detail"] = str(exc)
            return reply
        if plan is None:
            reply["ok"] = False
            reply["key"] = "error"
            return reply
        reply["plan"] = plan
        if plan["usable"]:
            try:
                reply["check"] = tr.build_practice(
                    plan, self._train.get("out") or "practice", dry_run=True,
                    allow_existing=True,
                    audio_format=self._train.get("audio_format") or "mp3")
                reply["occupied"] = self._train_occupied()
                reply["feel"] = tr.feel_of(
                    plan["source"]["osu"], plan["rate"], plan["stats"]["values"],
                    plan["mods"])
            except (ValueError, OSError) as exc:
                reply["key"] = "cannot_build"
                reply["detail"] = str(exc)
        return reply

    def train_pick(self, paths: list | None = None) -> dict:
        """The map to copy. With no paths the window asks for one file."""
        chosen = [str(path) for path in (paths or []) if str(path).strip()]
        if not chosen:
            chosen = self._pick_osu_files()[:1]
        if not chosen:
            return {"ok": False, "key": "nothing_picked"}
        if not Path(chosen[0]).is_file():
            return {"ok": False, "key": "bad_file", "detail": Path(chosen[0]).name}
        self._train["osu"] = chosen[0]
        return self.train_state()

    def train_use_open(self) -> dict:
        """The open song's own map, if the song beside it has one to copy."""
        file = self._cfg.get("file") or ""
        folder = Path(str(file)).parent if file else None
        if folder is None or not folder.is_dir():
            return {"ok": False, "key": "no_song"}
        if str(file).lower().endswith(".osu") and Path(str(file)).is_file():
            self._train["osu"] = str(file)
            return self.train_state()
        found = sorted(path for path in folder.glob("*.osu"))
        if not found:
            return {"ok": False, "key": "no_maps"}
        self._train["osu"] = str(found[0])
        return self.train_state()

    def train_detect(self) -> dict:
        """The map from what osu! writes outside itself — measured, in order.

        The window title, the newest replay, the newest `.osu`: the first that
        resolves wins and becomes the source; where every signal misses, the
        reply names everything tried and the library search (which needs
        nothing from osu!) is the answer.
        """
        songs = self._songs_root()
        try:
            found = tr.detect_map(songs)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if found["osu"]:
            self._train["osu"] = found["osu"]
            state = self.train_state()
            state["detection"] = found
            return state
        return {"ok": False, "key": "no_signal",
                "detail": "; ".join(f"{row['signal']}: "
                                    f"{row.get('file') or row.get('title') or row.get('why', '')}"
                                    for row in found["signals"]) or "no Songs folder",
                "signals": found["signals"]}

    def train_clear(self) -> dict:
        """No map, back to a rate of one."""
        self._train["osu"] = None
        self._train["target_bpm"] = None
        self._train["from_bpm"] = None
        return self.train_state()

    def train_set(self, changes: dict) -> dict:
        """The rate, the target, the stats, the naming and the output shape."""
        changes = dict(changes or {})
        unknown = sorted(set(changes) - {"rate", "target_bpm", "from_bpm", "stats",
                                         "naming", "mods", "audio_format", "osz", "out"})
        if unknown:
            return {"ok": False, "key": "error",
                    "detail": f"Unknown setting(s): {', '.join(unknown)}."}
        if "rate" in changes:
            value = changes["rate"]
            if value is not None:
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    return {"ok": False, "key": "error",
                            "detail": f"The rate ({changes['rate']!r}) is not a number."}
            self._train["rate"] = value
            self._train["target_bpm"] = None
            self._train["from_bpm"] = None
        for key in ("target_bpm", "from_bpm"):
            if key in changes:
                value = changes[key]
                if value is not None:
                    try:
                        value = float(value)
                    except (TypeError, ValueError):
                        return {"ok": False, "key": "error",
                                "detail": f"{key} ({changes[key]!r}) is not a number."}
                self._train[key] = value
                if key == "target_bpm":
                    self._train["rate"] = None
        if "stats" in changes:
            if not isinstance(changes["stats"], dict):
                return {"ok": False, "key": "error",
                        "detail": "Stats arrive as {hp|cs|ar|od: keep|scale|number}."}
            self._train["stats"] = dict(changes["stats"])
        if "naming" in changes:
            if not isinstance(changes["naming"], dict):
                return {"ok": False, "key": "error",
                        "detail": "Naming arrives as {version: text}."}
            self._train["naming"] = dict(changes["naming"])
        if "mods" in changes:
            mods = changes["mods"] or []
            if isinstance(mods, str):
                mods = [mods]
            if not isinstance(mods, list) or any(not isinstance(m, str) for m in mods):
                return {"ok": False, "key": "error",
                        "detail": "Mods arrive as a list like [HR, DT]."}
            self._train["mods"] = [str(m).upper() for m in mods]
        if "audio_format" in changes:
            if changes["audio_format"] not in ("mp3", "wav"):
                return {"ok": False, "key": "error",
                        "detail": f"Format {changes['audio_format']!r} is not mp3 or wav."}
            self._train["audio_format"] = changes["audio_format"]
        if "osz" in changes:
            self._train["osz"] = bool(changes["osz"])
        if "out" in changes:
            self._train["out"] = str(changes["out"] or "")
        return self.train_state()

    def train_copies(self) -> dict:
        """Every practice copy the write log knows, with what each would free."""
        try:
            return {"ok": True, **tr.list_copies()}
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}

    def train_remove(self, folders: list | None = None, dry_run: bool = False) -> dict:
        """Remove practice copies, showing first what goes. A dry run frees
        nothing; without one, only what the log names leaves."""
        try:
            return {"ok": True,
                    **tr.remove_copies([str(f) for f in (folders or [])],
                                       dry_run=bool(dry_run))}
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}

    def train_presets(self) -> dict:
        """Every saved setup, by name."""
        try:
            return {"ok": True, **tr.list_presets()}
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}

    def train_preset_save(self, name: str = "", settings: dict | None = None) -> dict:
        """Keep this setup under a name. No source map travels with it."""
        try:
            saved = tr.save_preset(name, settings or {})
            return {"ok": True, "saved": saved, **tr.list_presets()}
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}

    def train_preset_delete(self, name: str = "") -> dict:
        """Forget a setup."""
        try:
            tr.delete_preset(name)
            return {"ok": True, **tr.list_presets()}
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}

    def train_preset_apply(self, name: str = "") -> dict:
        """A saved setup onto the current view: rate, target, stats, naming,
        mods and output shape, everything a preset carries."""
        try:
            presets = tr.list_presets()["presets"]
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if str(name) not in presets:
            return {"ok": False, "key": "error",
                    "detail": f"No preset named {name!r}."}
        settings = dict(presets[str(name)].get("settings", {}))
        for key in ("rate", "target_bpm", "from_bpm", "stats", "naming",
                    "mods", "audio_format", "osz"):
            if key in settings:
                self._train[key] = settings[key]
        return self.train_state()

    def _train_hotkey_fire(self) -> None:
        """What the hotkey builds: the copy that is set up, like the button."""
        try:
            self.train_build()
        except Exception:  # noqa: BLE001 -- the waiter swallows it anyway
            pass

    def _train_hotkey_ensure(self) -> dict:
        """The waiter matching the remembered switch, started or stopped."""
        want = bool(self._cfg.get("train_hotkey"))
        if not want:
            if self._train_hotkey is not None:
                self._train_hotkey.stop()
                self._train_hotkey = None
            return {"available": overtone_hotkey.available(), "on": False}
        if not overtone_hotkey.available():
            return {"available": False, "on": False}
        waiter = self._train_hotkey
        if waiter is None or not waiter.is_alive():
            waiter = overtone_hotkey.HotkeyWait(callback=self._train_hotkey_fire)
            waiter.start()
            waiter.ready.wait(timeout=5)
            if waiter.error:
                return {"available": True, "on": False, "error": waiter.error}
            self._train_hotkey = waiter
        return {"available": True, "on": True}

    def train_hotkey(self, on: bool = True) -> dict:
        """Build the copy that is set up, from anywhere: Ctrl+Alt+B.

        One combination delivered by the OS as a message; no keystroke but
        that one passes through Overtone. Remembered in the config, so the
        next window waits again. Off Windows, or with the combination taken,
        it says so instead of pretending.
        """
        self._cfg["train_hotkey"] = bool(on)
        self._persist()
        if not on and self._train_hotkey is not None:
            self._train_hotkey.stop()
            self._train_hotkey = None
            return {"ok": True, "hotkey": {"available": overtone_hotkey.available(),
                                           "on": False}}
        if on:
            if not overtone_hotkey.available():
                return {"ok": False, "key": "error",
                        "detail": "A global hotkey needs Windows."}
            state = self._train_hotkey_ensure()
            if not state["on"]:
                return {"ok": False, "key": "error",
                        "detail": f"Ctrl+Alt+B is already taken: {state.get('error', '')}"}
            return {"ok": True, "hotkey": state}
        return {"ok": True, "hotkey": self._train_hotkey_ensure()}

    def _train_occupied(self) -> str:
        """The beatmap already in the chosen output folder, if any."""
        folder = Path(self._train.get("out")) if self._train.get("out") else None
        if folder is None or not folder.is_dir():
            return ""
        found = sorted(path.name for path in folder.iterdir()
                       if path.suffix.lower() == ".osu")
        return found[0] if found else ""

    def train_pick_folder(self) -> dict:
        """Where to build. Remembered until the window closes."""
        folder = self.pick_folder()
        if not folder:
            return {"ok": False, "key": "nothing_picked"}
        self._train["out"] = str(folder)
        return self.train_state()

    def train_build(self, allow_existing: bool = False) -> dict:
        """Build it. Starts a worker; the report arrives as a JS event.

        A resample and an encode take seconds and the window must stay
        alive, so this follows the compilation's shape: its own lock, so one
        heavy job runs at a time, and events for progress and the result.
        There is no stop: a half-written mapset is worse than waiting.
        """
        out = str(self._train.get("out") or "")
        if not out:
            return {"ok": False, "key": "no_folder"}
        if not self._train.get("osu"):
            return {"ok": False, "key": "no_sources"}
        occupied = self._train_occupied()
        if occupied and not allow_existing:
            return {"ok": False, "key": "folder_occupied", "detail": occupied}
        try:
            plan = self._train_plan()
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if plan is None or not plan["usable"]:
            return {"ok": False, "key": "plan_refused",
                    "detail": "; ".join(row.get("why", "")
                                        for row in (plan or {}).get("refusals", ()))}
        if self._busy.locked():
            return {"ok": False, "key": "busy"}     # an analysis is running
        if not self._train_lock.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        threading.Thread(target=self._train_worker, args=(plan, out),
                         daemon=True).start()
        return {"ok": True}

    def _train_worker(self, plan: dict, folder: str) -> None:
        try:
            report = tr.build_practice(
                plan, folder, allow_existing=True,
                audio_format=self._train.get("audio_format") or "mp3",
                osz=bool(self._train.get("osz")), grade=True,
                progress=lambda step, done, total: self._emit(
                    "onTrainProgress", {"step": step, "done": done, "total": total}))
            report["kind"] = "copy"
            self._emit("onTrainDone", {"ok": True, "report": report})
        except (ValueError, OSError) as exc:
            self._emit("onTrainDone", {"ok": False, "key": "error",
                                       "detail": str(exc)})
        except Exception as exc:  # noqa: BLE001 -- the view shows the message
            self._emit("onTrainDone", {"ok": False, "key": "error",
                                       "detail": f"{type(exc).__name__}: {exc}"})
        finally:
            self._train_lock.release()

    def train_build_ladder(self, rates: list | None = None,
                           allow_existing: bool = False) -> dict:
        """Build every rung. Starts a worker; the report arrives as a JS event.

        One run, one mapset, one progress bar over the lot: the worker climbs
        the rungs in order on the Train lock, so an analysis and a ladder
        never run at once. A rung refused is a ladder refused, with the rung
        named, before anything is written.
        """
        out = str(self._train.get("out") or "")
        if not out:
            return {"ok": False, "key": "no_folder"}
        if not self._train.get("osu"):
            return {"ok": False, "key": "no_sources"}
        occupied = self._train_occupied()
        if occupied and not allow_existing:
            return {"ok": False, "key": "folder_occupied", "detail": occupied}
        try:
            plan = tr.plan_ladder(
                self._train["osu"], rates,
                stats=dict(self._train.get("stats") or {}),
                naming=dict(self._train.get("naming") or {}))
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        if not plan["usable"]:
            return {"ok": False, "key": "plan_refused",
                    "detail": "; ".join(row.get("why", "") for row in plan["refusals"])}
        if self._busy.locked():
            return {"ok": False, "key": "busy"}     # an analysis is running
        if not self._train_lock.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        threading.Thread(target=self._train_ladder_worker, args=(plan, out),
                         daemon=True).start()
        return {"ok": True}

    def _train_ladder_worker(self, plan: dict, folder: str) -> None:
        try:
            report = tr.build_ladder(
                plan, folder, allow_existing=True,
                audio_format=self._train.get("audio_format") or "mp3",
                osz=bool(self._train.get("osz")), grade=True,
                progress=lambda step, done, total: self._emit(
                    "onTrainProgress", {"step": step, "done": done, "total": total}))
            report["kind"] = "ladder"
            self._emit("onTrainDone", {"ok": True, "report": report})
        except (ValueError, OSError) as exc:
            self._emit("onTrainDone", {"ok": False, "key": "error",
                                       "detail": str(exc)})
        except Exception as exc:  # noqa: BLE001 -- the view shows the message
            self._emit("onTrainDone", {"ok": False, "key": "error",
                                       "detail": f"{type(exc).__name__}: {exc}"})
        finally:
            self._train_lock.release()

    def _pick_osu_files(self) -> list:
        """Several .osu files from one dialog, or nothing."""
        import webview

        if self._window is None:
            return []
        chosen = self._window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=True, file_types=OSU_TYPES)
        if not chosen:
            return []
        if isinstance(chosen, (list, tuple)):
            return [str(path) for path in chosen]
        return [str(chosen)]

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

    def _suggestion(self, osu_path: str, index) -> tuple[Path, dict, dict] | dict:
        """The map, read now, and its suggestion ``index`` as the list would
        show it now, or a refusal: ``suggestion_gone`` when the map or the
        analysis changed so that the list no longer holds it."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        path = Path(str(osu_path))
        if not path.is_file():
            return {"ok": False, "key": "bad_file"}
        if isinstance(index, bool) or not isinstance(index, int):
            return {"ok": False, "key": "suggestion_gone"}
        try:
            beatmap = ta.read_osu_beatmap(path)
            found = ta.suggest_missing_lines(self._analysis, beatmap)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        suggestion = next((s for s in found if s["index"] == index), None)
        if suggestion is None:
            return {"ok": False, "key": "suggestion_gone"}
        return path, beatmap, suggestion

    def suggest_preview(self, osu_path: str, index: int) -> dict:
        """What adding suggestion ``index`` to the map would write: the red
        line, the green that keeps slider velocity, and the objects and
        slider ends it times. Read only."""
        got = self._suggestion(osu_path, index)
        if isinstance(got, dict):
            return got
        path, beatmap, suggestion = got
        try:
            summary = ta.add_red_line(beatmap, suggestion["offset_ms"], suggestion["bpm"],
                                      suggestion["meter"],
                                      decimals=self._settings()["offset_decimals"])
        except ValueError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "suggestion": suggestion, "summary": summary}

    def suggest_apply(self, osu_path: str, index: int, offset_ms: float) -> dict:
        """Add suggestion ``index`` to the map, the file backed up first and
        the write logged. ``offset_ms`` is the time the page showed and was
        agreed to: a suggestion that has moved since is refused, not written."""
        got = self._suggestion(osu_path, index)
        if isinstance(got, dict):
            return got
        path, beatmap, suggestion = got
        try:
            shown = float(offset_ms)
        except (TypeError, ValueError):
            shown = float("nan")
        if not abs(shown - suggestion["offset_ms"]) <= 0.5:
            return {"ok": False, "key": "suggestion_gone"}
        try:
            summary = ta.add_red_line(beatmap, suggestion["offset_ms"], suggestion["bpm"],
                                      suggestion["meter"],
                                      decimals=self._settings()["offset_decimals"])
            written = ta.write_osu_beatmap(path, beatmap, op="suggestion",
                                           summary={"offset_ms": summary["offset_ms"],
                                                    "bpm": round(summary["bpm"], 4)})
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name, "summary": summary, "backup": written["backup"]}

    @staticmethod
    def _digest(path: str | Path) -> tuple[str, str]:
        import hashlib
        resolved = Path(str(path)).resolve()
        return str(resolved), hashlib.sha256(resolved.read_bytes()).hexdigest()

    def resnap_preview(self, osu_path: str) -> dict:
        """What moving this map's snapped objects onto the current grid would
        move, and what would stay. Read only. ``resnapped`` is true while the
        file still holds what a re-snap here wrote: its objects already left
        its red lines, so the numbers are a second move, not a first."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        if not Path(str(osu_path)).is_file():
            return {"ok": False, "key": "bad_file"}
        try:
            key, digest = self._digest(osu_path)
        except OSError as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        resnapped = self._resnapped.get(key) == digest
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
                "changed": changed, "left": result["left"], "skipped": result["skipped"],
                "resnapped": resnapped}

    def resnap_apply(self, osu_path: str) -> dict:
        """Move the snapped objects onto the current grid, the file backed up
        first and logged. Writes nothing when no time would actually change,
        and refuses a file this already re-snapped that nothing has changed
        since: the objects would move a second time."""
        preview = self.resnap_preview(osu_path)
        if not preview.get("ok"):
            return preview
        if preview["resnapped"]:
            return {"ok": False, "key": "resnapped"}
        if not preview["changed"]:
            return {**preview, "written": False, "backup": None}
        try:
            beatmap = ta.read_osu_beatmap(osu_path)
            diff = ta.inject_diff(osu_path, self._analysis,
                                  decimals=self._settings()["offset_decimals"])
            ta.resnap_objects(beatmap, diff["pairs"])
            written = ta.write_osu_beatmap(osu_path, beatmap, op="resnap")
            key, digest = self._digest(osu_path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._resnapped[key] = digest
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
        """Grade each red line of a chart against the song's attacks.

        An ``.osu``, or another game's timing — a Quaver ``.qua`` or a
        StepMania ``.sm``/``.ssc``, which state the same red lines in their
        own spelling and are read into the same shape. Read only. Whether the
        chart's audio is this exact file is answered for an ``.osu`` and left
        unanswered for the others, which name their audio but are not read
        for it.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        target = Path(str(osu_path))
        if not target.is_file():
            return {"ok": False, "key": "bad_file"}
        imported = target.suffix.lower() in ta.TIMING_FORMATS
        # Detecting attacks decodes the song: one heavy job at a time.
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            beatmap = (ta.read_timing_file(target) if imported
                       else ta.read_osu_beatmap(osu_path))
            times, weights = self._attacks()
            report = ta.grade_reference_timing(beatmap, times, weights,
                                               float(self._analysis.duration))
            same = None if imported else ta.same_audio(osu_path, beatmap,
                                                       self._analysis.source)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        return {"ok": True, "report": report, "same_audio": same,
                "format": beatmap.get("timing_format", "osu"),
                "path": str(osu_path), "file": target.name}

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

    @staticmethod
    def _library_error(exc: Exception) -> dict:
        """A damaged index has its own key: the page can say that a scan
        rebuilds it, which is the way out."""
        if overtone_library.is_damaged(exc):
            return {"ok": False, "key": "library_damaged", "detail": str(exc)}
        return {"ok": False, "key": "error", "detail": str(exc)}

    def library_state(self) -> dict:
        """Where the Songs folder is and what the index holds of it. When the
        index cannot be read, the folder facts still come back with why."""
        root = self._songs_root()
        library = overtone_library.Library()
        try:
            index = library.stats()
            current = library.covers(root)
        except (ValueError, OSError, sqlite3.Error) as exc:
            return {**self._library_error(exc), "songs": root,
                    "songs_found": Path(root).is_dir(), "scanning": self._scanning.locked()}
        return {"ok": True, "songs": root, "songs_found": Path(root).is_dir(),
                "index": index, "current": current, "scanning": self._scanning.locked()}

    def library_scan(self, folder: str = "") -> dict:
        """Bring the index in step with the Songs folder (the remembered one,
        else osu!'s default). Unchanged maps are skipped, so a rescan costs a
        folder listing; the first scan reads every header, and a damaged
        index is rebuilt. The page hears ``onLibraryProgress`` with the
        folders in the index, their total, and how many rows of maps that
        are gone are being removed after the last folder."""
        root = self._songs_root(folder)
        if not Path(root).is_dir():
            return {"ok": False, "key": "no_songs"}
        if not self._scanning.acquire(blocking=False):
            return {"ok": False, "key": "scan_running"}
        try:
            report = overtone_library.Library().scan(
                root, lambda done, total, removing: self._emit(
                    "onLibraryProgress", {"done": done, "total": total, "removing": removing}))
        except (ValueError, OSError, sqlite3.Error) as exc:
            return self._library_error(exc)
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
            return self._library_error(exc)
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

    # -- library health check: each map's red lines against its own audio ---
    def health_state(self) -> dict:
        """Verdict counts over the index, the engine a run would use, and
        whether one is going. Read only."""
        try:
            report = overtone_library.Library().health_report(())
        except (ValueError, OSError, sqlite3.Error) as exc:
            return self._library_error(exc)
        return {"ok": True, "counts": report["counts"],
                "engine": "rust" if overtone_rust.find_cli() else "python",
                "running": self._health.locked()}

    def health_start(self) -> dict:
        """Start grading what is new or changed, on a worker thread: progress
        and the end arrive as ``onHealthProgress`` / ``onHealthDone``. A run is
        resumable, so a stopped one loses nothing it already wrote."""
        if not self._health.acquire(blocking=False):
            return {"ok": False, "key": "health_running"}
        self._health_stop.clear()
        threading.Thread(target=self._health_worker, daemon=True).start()
        return {"ok": True}

    def health_stop(self) -> dict:
        """Stop the run at the next audio file; what it graded is kept."""
        if not self._health.locked():
            return {"ok": False, "key": "not_running"}
        self._health_stop.set()
        return {"ok": True}

    def _health_worker(self) -> None:
        try:
            run = overtone_library.Library().health(
                progress=lambda done, total: self._emit(
                    "onHealthProgress", {"done": done, "total": total}),
                stop=self._health_stop)
            self._emit("onHealthDone", {"ok": True, "run": run})
        except overtone_rust.SidecarUnavailable:
            self._emit("onHealthDone", {"ok": False, "key": "no_rust"})
        except (ValueError, OSError, sqlite3.Error) as exc:
            self._emit("onHealthDone", self._library_error(exc))
        finally:
            self._health_stop.clear()
            self._health.release()

    def health_report(self, verdicts=("check",), limit: int = 100) -> dict:
        """The graded maps with these verdicts, worst first, each with its
        evidence and whether any of its lines is solid enough to be worth a
        look (``actionable``); ``actionable`` also counts them for the card."""
        if isinstance(verdicts, str):              # JS passes one verdict bare
            verdicts = (verdicts,)
        try:
            report = overtone_library.Library().health_report(verdicts, limit)
        except (ValueError, OSError, sqlite3.Error) as exc:
            return self._library_error(exc)
        for m in report["maps"]:
            m["actionable"] = (m["verdict"] == "check"
                               and overtone_library.health_actionable(m.get("checks")))
        report["actionable"] = sum(1 for m in report["maps"] if m["actionable"])
        return {"ok": True, **report}

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
        if not self._ramps[2].get("recommend_ramps"):
            # The engine's own selector says the sections read better; on a
            # real song the lines are then jitter cut into two-attack grids.
            return {"ok": False, "key": "ramps_not_recommended"}
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

    def _already_written(self, tool: str, path: Path) -> bool:
        """True while the file still holds exactly what ``tool`` wrote into
        it this session."""
        try:
            key, digest = self._digest(path)
        except OSError:
            return False
        return self._tool_wrote.get(f"{tool}|{key}") == digest

    def _remember_write(self, tool: str, path: Path) -> None:
        try:
            key, digest = self._digest(path)
        except OSError:
            return
        self._tool_wrote[f"{tool}|{key}"] = digest

    @staticmethod
    def _scrolled_already(path: Path, beatmap: dict) -> bool:
        """True while the map scrolls exactly as this file's last scroll write
        left it (its History entry keeps the scroll profile): a normalised
        map is not normalised twice, whatever session it was in. On local
        mania and taiko maps a second run would have scaled over half of them
        again, their own green at each red line reading as not yet
        normalised. Writes that leave scroll alone (kiai, volumes, hitsounds)
        keep the file held; a restore, an inject, an SV edit or another copy
        of the map free it."""
        def key(value) -> str:
            return os.path.normcase(str(Path(str(value)).resolve()))
        try:
            target = key(path)
        except OSError:
            return False
        for entry in ta.read_history():
            try:
                if entry.get("op") != "scroll" or key(entry.get("path", "")) != target:
                    continue
            except OSError:
                continue
            return (entry.get("summary") or {}).get("profile") == ta.scroll_profile(beatmap)
        return False

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
        """What normalising this difficulty's scroll would add, rescale or
        keep, against its first red line's BPM. Read only. ``already`` is
        true while the file holds what a scroll write here made."""
        plan = self._scroll_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap = plan
        try:
            import copy
            result = ta.set_constant_scroll(copy.deepcopy(beatmap))
        except ta.ScrollMovesSliders as exc:
            return {"ok": False, "key": "scroll_sliders", "count": exc.count,
                    "first_ms": exc.first_ms}
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "file": path.name,
                "reference_bpm": round(beatmap["timing"]["reds"][0][1], 3),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"], "already": self._scrolled_already(path, beatmap)}

    def scroll_apply(self, file: str) -> dict:
        """Write the scroll greens into the difficulty, the file backed up
        first and logged. Sound, kiai and barlines never move. Refuses a file
        History says this tool normalised already: never scaled twice."""
        plan = self._scroll_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap = plan
        if self._scrolled_already(path, beatmap):
            return {"ok": False, "key": "already_written"}
        try:
            result = ta.set_constant_scroll(beatmap)
            written = ta.write_osu_beatmap(path, beatmap, op="scroll",
                                           summary={"profile": ta.scroll_profile(beatmap)})
        except ta.ScrollMovesSliders as exc:
            return {"ok": False, "key": "scroll_sliders", "count": exc.count,
                    "first_ms": exc.first_ms}
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
        """What writing section volumes would add, rewrite or keep, and how
        many sections are left to the map's own volumes. Read only."""
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
                "kept": result["kept"], "mapper": result["mapper"], "set": result["set"],
                "already": self._already_written("volumes", path)}

    def structure_volumes_apply(self, file: str) -> dict:
        """Write section volumes as green lines, the file backed up first and
        logged. Recomputes: the preview never decides. Refuses a file still
        holding what a volumes write here made."""
        plan = self._volumes_plan(file)
        if isinstance(plan, dict):
            return plan
        path, beatmap, sections = plan
        if self._already_written("volumes", path):
            return {"ok": False, "key": "already_written"}
        try:
            result = ta.set_section_volumes(beatmap, sections)
            written = ta.write_osu_beatmap(path, beatmap, op="volumes")
        except (ValueError, OSError) as exc:
            return {"ok": False, "key": "error", "detail": str(exc)}
        self._remember_write("volumes", path)
        return {"ok": True, "file": path.name, "sections": len(sections),
                "added": result["added"], "flipped": result["flipped"],
                "kept": result["kept"], "mapper": result["mapper"], "set": result["set"],
                "written": written["bytes"] > 0, "backup": written["backup"]}

    def snap_divisors(self) -> dict:
        """Which divisor each section needs, from the song's own attacks.
        Read only: 1/3, 1/4 or 1/6 per section with the counts behind it."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        return {"ok": True, "report": ta.snap_divisors(self._analysis)}

    def swing_lane(self) -> dict:
        """Where the music swings, eight beats of the working grid at a time.
        Read only. A fallback result keeps no attacks: they are detected once,
        as for a reference grading, so that case waits for any other heavy job."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        analysis = self._analysis
        held = len(analysis.attack_times) > 0 or (
            self._ref_attacks is not None and self._ref_attacks[0] == str(analysis.source))
        if not held and not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            times, weights = self._attacks()
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            if not held:
                self._busy.release()
        report = ta.swing_lane(analysis.points, times, weights, float(analysis.duration))
        return {"ok": True, "report": report}

    #: Columns a band lane is drawn with. The flux has a frame every 2.9 ms —
    #: 124,000 of them on a six-minute song — and no screen has the pixels,
    #: so each column keeps the loudest frame under it: a lane is read for
    #: where the hits are, and a mean would flatten every one of them.
    BAND_COLUMNS = 1600

    def _read_bands(self, source: str) -> dict | None:
        """Decode the song once for the Audio view and keep it: the waveform,
        its rate and its band flux. Both pictures there are drawn from this,
        and decoding costs what an analysis does. ``None`` once it is in
        hand; a refusal to hand straight back otherwise."""
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            y, sr = ta._load_audio(source, lambda _message: None)
            flux = ta.band_flux(y, sr, ta.FIT_HOP)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            self._busy.release()
        self._bands = (source, flux, float(sr), y)
        return None

    #: Rows the tempo map is drawn with: the swept rates are binned into this
    #: many bands of log2 period, so a column is a picture rather than 1,047
    #: numbers of JSON.
    TEMPO_MAP_ROWS = 128

    def tempo_map(self, rows: int = TEMPO_MAP_ROWS) -> dict:
        """Where the pulse is, over the whole song: R(t, f) as a picture.

        One byte a cell, base64, with the rows evenly spaced in **log2
        period** so an octave is the same height anywhere on it. The ridge —
        the strongest peak each window, followed with octave continuity —
        comes back beside it, and so do the red lines the analysis actually
        reports, because the two are not the same thing: R peaks at the pulse
        *and at every multiple of it*, so a ridge sitting an octave above the
        reported BPM is the sweep being honest, not a disagreement.

        A fallback result keeps no attacks; they are detected once per song
        as a reference grading does, so that case waits its turn.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            rows = max(16, min(512, int(rows)))
        except (TypeError, ValueError):
            return {"ok": False, "key": "error", "detail": "rows must be a number"}
        analysis = self._analysis
        held = len(analysis.attack_times) > 0 or (
            self._ref_attacks is not None and self._ref_attacks[0] == str(analysis.source))
        if not held and not self._busy.acquire(blocking=False):
            return {"ok": False, "key": "busy"}
        try:
            times, weights = self._attacks()
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        finally:
            if not held:
                self._busy.release()
        centres, freqs, columns = ta.coherence_map(times, weights)
        if columns.size == 0:
            return {"ok": True, "rows": 0, "columns": 0, "cells": "", "centres": [],
                    "bpm_lo": 0.0, "bpm_hi": 0.0, "ridge": [], "points": []}
        # Bin the swept rates into rows of equal log2 period: an octave is
        # then the same height wherever it sits, which is how tempo is read.
        periods = 1.0 / freqs
        logs = np.log2(periods)
        lo, hi = float(logs.min()), float(logs.max())
        which = np.clip(((logs - lo) / max(hi - lo, 1e-12) * (rows - 1)).round().astype(int),
                        0, rows - 1)
        binned = np.zeros((rows, columns.shape[0]), dtype=np.float64)
        for row in range(rows):
            members = which == row
            if members.any():
                binned[row] = columns[:, members].max(axis=1)
        packed = np.clip(np.rint(binned * 255.0), 0, 255).astype(np.uint8)
        at, period, _r = ta.map_ridge(centres, freqs, columns)
        return {"ok": True, "rows": int(rows), "columns": int(columns.shape[0]),
                "cells": base64.b64encode(packed.tobytes()).decode("ascii"),
                "centres": np.asarray(centres).round(3).tolist(),
                # the row axis, as BPM at the slowest and fastest rate swept
                "bpm_lo": round(60.0 / float(2 ** hi), 3),
                "bpm_hi": round(60.0 / float(2 ** lo), 3),
                "ridge": [[round(float(t), 3), round(60.0 / float(p), 3)]
                          for t, p in zip(at, period)],
                "points": [[round(float(p.offset_ms) / 1000.0, 3), round(float(p.bpm), 3)]
                           for p in ta.snap_timing_points(analysis.points)
                           if np.isfinite(p.bpm) and p.bpm > 0]}

    #: Columns the energy curve gets, and the balance lane's: both are one
    #: line about a whole song, and a wider line reads better than a comb.
    ENERGY_COLUMNS = 700

    def audio_energy(self, columns: int = ENERGY_COLUMNS) -> dict:
        """How loud the song is over time, 0 to 1, from the Audio view's decode.

        Read only. ``peak_db`` is the loudest column's RMS, which is what the
        curve is drawn against; a file with nothing in it says so with a peak
        under :data:`overtone.LOUDNESS_SILENT_DB` and a flat zero, rather than
        normalising silence against itself into a full line.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            columns = max(16, min(4000, int(columns)))
        except (TypeError, ValueError):
            return {"ok": False, "key": "error", "detail": "columns must be a number"}
        source = str(self._analysis.source)
        if self._bands is None or self._bands[0] != source:
            loaded = self._read_bands(source)
            if loaded is not None:
                return loaded
        _source, _flux, sr, y = self._bands
        try:
            curve, peak = ta.loudness_curve(y, int(sr), columns)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "curve": curve.round(4).tolist(), "peak_db": peak,
                "floor_db": -ta.LOUDNESS_FLOOR_DB, "columns": int(curve.size),
                "span_s": round(len(y) / float(sr), 4)}

    #: Columns the balance lane gets. Fewer than the lanes': it is a texture
    #: over tenths of a second and a wider line reads better than a comb.
    BALANCE_COLUMNS = 700

    def audio_balance(self, columns: int = BALANCE_COLUMNS) -> dict:
        """How much of each moment is a hit rather than a note, 0 to 1.

        Read only, from the Audio view's own decode. ``whole`` is the song's
        own share, weighted by energy like the lane: a silent frame has no
        balance to report."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            columns = max(16, min(4000, int(columns)))
        except (TypeError, ValueError):
            return {"ok": False, "key": "error", "detail": "columns must be a number"}
        source = str(self._analysis.source)
        if self._bands is None or self._bands[0] != source:
            loaded = self._read_bands(source)
            if loaded is not None:
                return loaded
        _source, _flux, sr, y = self._bands
        try:
            lane, loudness, whole = ta.percussive_balance(y, int(sr), columns)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        return {"ok": True, "lane": lane.round(4).tolist(), "whole": round(whole, 4),
                "heard": loudness.round(4).tolist(),
                "columns": int(lane.size), "span_s": round(len(y) / float(sr), 4)}

    #: Columns a drawn spectrogram gets. Wider than a screen on purpose, so
    #: the picture survives a window resize without being read again.
    SPECTROGRAM_COLUMNS = 1400

    def audio_spectrogram(self, columns: int = SPECTROGRAM_COLUMNS) -> dict:
        """The song's mel spectrogram, ready to draw.

        128 rows by ``columns``, one byte a cell: 0 is the floor (80 dB under
        the song's loudest moment) and 255 is that moment. A float per cell
        would be 180,000 numbers of JSON for one picture, so the grid travels
        as base64 bytes and the page paints it through an ImageData. Read
        only, and the decode is shared with the band lanes.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            columns = max(16, min(4000, int(columns)))
        except (TypeError, ValueError):
            return {"ok": False, "key": "error", "detail": "columns must be a number"}
        source = str(self._analysis.source)
        if self._bands is None or self._bands[0] != source:
            loaded = self._read_bands(source)
            if loaded is not None:
                return loaded
        _source, _flux, sr, y = self._bands
        try:
            grid = ta.mel_image(y, int(sr), columns)
        except Exception as exc:  # noqa: BLE001 -- shown to the user verbatim
            return {"ok": False, "key": "error", "detail": str(exc)}
        if grid.size == 0:
            return {"ok": True, "rows": 0, "columns": 0, "cells": "",
                    "hz": [], "span_s": 0.0, "floor_db": -ta.MEL_TOP_DB}
        # -80..0 dB to 0..255, floor first so the darkest cell is a true zero.
        cells = np.rint((grid + ta.MEL_TOP_DB) * (255.0 / ta.MEL_TOP_DB))
        packed = np.clip(cells, 0, 255).astype(np.uint8)
        return {"ok": True, "rows": int(packed.shape[0]), "columns": int(packed.shape[1]),
                "cells": base64.b64encode(packed.tobytes()).decode("ascii"),
                "hz": ta.mel_frequencies().round(1).tolist(),
                "floor_db": -ta.MEL_TOP_DB,
                "span_s": round(len(y) / float(sr), 4)}

    def audio_bands(self, columns: int = BAND_COLUMNS) -> dict:
        """The song's onset flux in seven bands, for the Audio view.

        Read only, and the audio is decoded once per song and kept: the flux
        is the same for any zoom, so the page asks once and draws from it.
        Values are scaled by the loudest column of **all** the bands, so the
        lanes stay comparable — a quiet band looks quiet, which is the point.
        """
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        try:
            columns = max(16, min(8000, int(columns)))
        except (TypeError, ValueError):
            return {"ok": False, "key": "error", "detail": "columns must be a number"}
        source = str(self._analysis.source)
        if self._bands is None or self._bands[0] != source:
            loaded = self._read_bands(source)
            if loaded is not None:
                return loaded
        _source, flux, sr, _y = self._bands
        if flux.size == 0:
            return {"ok": True, "lanes": [], "edges": ta.band_edges().round(1).tolist(),
                    "columns": 0, "span_s": 0.0, "peak_db": 0.0}
        frames = flux.shape[0]
        columns = min(columns, frames)
        edges = np.linspace(0, frames, columns + 1).astype(int)
        lanes = np.empty((ta.BAND_COUNT, columns), dtype=np.float64)
        for i in range(columns):
            lanes[:, i] = flux[edges[i]:max(edges[i + 1], edges[i] + 1)].max(axis=0)
        peak = float(lanes.max())
        scaled = (lanes / peak) if peak > 0 else lanes
        return {"ok": True,
                "lanes": [row.round(3).tolist() for row in scaled],
                "edges": ta.band_edges().round(1).tolist(),
                "columns": int(columns), "peak_db": round(peak, 3),
                "span_s": round(frames * ta.FIT_HOP / sr, 4)}

    def density_hints(self) -> dict:
        """Where a reported section holds a half- or double-time region.

        Read only, and a hint: the evidence for it, never a change to the
        timing. Costs nothing beyond the attacks the analysis already keeps,
        so it needs no turn among the heavy jobs. The fallback tracker reports
        no sections, so it has none to look inside and the list is empty."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        return {"ok": True, "hints": ta.density_hints(self._analysis)}

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
        skin = cfg.get("skin_folder")
        return {
            "output_folder": folder if isinstance(folder, str) and folder.strip() else "",
            # The skin playback asks before Overtone's own samples (H6); kept
            # as chosen even if it moves, and asked only while it is there.
            "skin_folder": skin if isinstance(skin, str) and skin.strip() else "",
            "export_ask": cfg.get("export_ask", True) is not False,
            "offset_decimals": decimals if 0 <= decimals <= MAX_OFFSET_DECIMALS else 0,
            "click_subdivision": subdivision if subdivision in ta.CLICK_SUBDIVISIONS else 1,
            "click_accent": cfg.get("click_accent", True) is not False,
            "ui_scale": scale if UI_SCALE_RANGE[0] <= scale <= UI_SCALE_RANGE[1] else 1.0,
            "reduced_motion": cfg.get("reduced_motion") is True,
            "theme": cfg.get("theme") if cfg.get("theme") in THEMES else "dark",
        }

    def diagnostics(self) -> dict:
        """What a bug report needs, as plain text the user copies and pastes where
        they choose. Nothing here leaves the machine: the window only copies it
        when asked, and shows it so the user can see exactly what was copied.
        """
        import platform
        import overtone_paths
        info = overtone_paths.build_info()
        cli = overtone_rust.find_cli()
        index = overtone_library.default_path()
        frozen = bool(getattr(sys, "frozen", False))
        lines = [
            f"Overtone {ta.APP_VERSION}",
            (f"build: commit {info.get('commit') or 'unknown'}, built {info.get('built') or 'unknown'}"
             if info else "build: a checkout, not a release build"),
            f"platform: {platform.platform()}",
            f"python: {platform.python_version()}" + ("  (frozen)" if frozen else ""),
            f"portable: {'yes' if overtone_paths.portable_root() else 'no'}",
            f"data folder: {overtone_paths.data_root()}",
            f"settings: {ta.CONFIG_PATH}",
            f"Rust engine: {cli if cli else 'not found'}",
            f"library index: {index} ({'present' if index.is_file() else 'not created yet'})",
        ]
        return {"ok": True, "text": "\n".join(lines) + "\n"}

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
                elif key == "skin_folder":              # "" plays no skin
                    if not isinstance(value, str):
                        return {"ok": False, "key": "bad_values"}
                    value = value.strip()
                    if value and not (Path(value).is_absolute() and Path(value).is_dir()):
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
        if self._project_dirty:
            self._save_project()
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

    # -- project: the song's timing work, kept between sessions (14.1) -----
    def _audio_digest(self) -> str | None:
        """The analysed file's SHA-256, read once per song; None when unreadable."""
        source = str(self._analysis.source)
        if self._audio_sha is None or self._audio_sha[0] != source:
            import hashlib
            digest = hashlib.sha256()
            try:
                with open(source, "rb") as handle:
                    for chunk in iter(lambda: handle.read(1 << 20), b""):
                        digest.update(chunk)
            except OSError:
                return None
            self._audio_sha = (source, digest.hexdigest())
        return self._audio_sha[1]

    def _project_path(self, digest: str) -> Path:
        """<output folder>/Projects/<song> [<first 8 of the SHA-256>].oto: the
        song's name to find it by, its bytes so two songs named alike never
        share one, and moving the audio keeps it."""
        s = self._settings()
        root = Path(s["output_folder"]) if s["output_folder"] else _default_output()
        return root / "Projects" / f"{self._song_folder_name()} [{digest[:8]}].oto"

    def _save_project(self) -> None:
        """Write the song's points and locks, atomically. A failed save never
        fails the edit that asked for it; project_state says why."""
        self._project_dirty = False
        if not self._save_projects or self._analysis is None:
            return
        digest = self._audio_digest()
        if digest is None:
            return
        source = Path(str(self._analysis.source))
        body = {"format": PROJECT_FORMAT, "version": PROJECT_VERSION, "app": ta.APP_VERSION,
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "audio": {"name": source.name, "path": str(source), "sha256": digest},
                "points": [{"offset_ms": p.offset_ms, "bpm": p.bpm, "confidence": p.confidence,
                            "meter": p.meter, "meter_known": p.meter_known, "manual": p.manual}
                           for p in self._analysis.points],
                "locks": [dict(lock) for lock in self._locked]}
        target = self._project_path(digest)
        partial = target.with_name(target.name + ".part")
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            partial.write_text(json.dumps(body, indent=1), encoding="utf-8")
            os.replace(partial, target)
            self._project_error = ""
        except OSError as exc:
            self._project_error = str(exc)

    def _read_project(self) -> dict | None:
        """This song's project when there is one and it is sound: its format,
        its audio's hash, and every point a finite, positive red line."""
        digest = self._audio_digest()
        if digest is None:
            return None
        try:
            with open(self._project_path(digest), encoding="utf-8") as handle:
                body = json.load(handle)
            if (body.get("format") != PROJECT_FORMAT or body.get("version") != PROJECT_VERSION
                    or body["audio"]["sha256"] != digest):
                return None
            points = [ta.TimingPoint(float(p["offset_ms"]), float(p["bpm"]), float(p["confidence"]), 0,
                                     int(p["meter"]), bool(p["meter_known"]), manual=bool(p["manual"]))
                      for p in body["points"]]
            locks = [{"offset_ms": float(lock["offset_ms"]), "bpm": float(lock["bpm"]),
                      "meter": int(lock["meter"]), "meter_known": bool(lock["meter_known"])}
                     for lock in body["locks"]]
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return None
        sound = all(np.isfinite(p.offset_ms) and np.isfinite(p.bpm) and p.bpm > 0
                    and 0 < p.meter <= ta.MAX_METER for p in points)
        if not points or not sound:
            return None
        return {"saved_at": str(body.get("saved_at", "")), "points": points, "locks": locks}

    def project_state(self) -> dict:
        """Whether this song has saved timing work that is not what is on
        screen, so the page can offer it back after an analysis."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        project = self._read_project()
        if project is None:
            return {"ok": True, "exists": False, "error": self._project_error}
        on_screen = [(round(p.offset_ms, 3), round(p.bpm, 6), p.meter) for p in self._analysis.points]
        saved = [(round(p.offset_ms, 3), round(p.bpm, 6), p.meter) for p in project["points"]]
        locks = sorted(round(lock["offset_ms"], 3) for lock in project["locks"])
        differs = saved != on_screen or locks != sorted(round(o, 3) for o in self._lock_offsets())
        return {"ok": True, "exists": True, "differs": differs, "saved_at": project["saved_at"],
                "points": len(project["points"]), "locks": len(project["locks"]),
                "error": self._project_error}

    def project_restore(self) -> dict:
        """Put the song's saved timing work back; undo returns to the analysis."""
        if self._analysis is None:
            return {"ok": False, "key": "first"}
        project = self._read_project()
        if project is None:
            return {"ok": False, "key": "no_project"}
        beats = np.asarray(self._analysis.beats, dtype=np.float64)
        points = [ta.TimingPoint(p.offset_ms, p.bpm, p.confidence,
                                 ta._nearest_beat_index(beats, p.offset_ms), p.meter,
                                 p.meter_known, manual=p.manual) for p in project["points"]]
        self._push_history(locks=True)
        self._analysis.points = sorted(points, key=lambda p: p.offset_ms)
        self._locked = project["locks"]
        return self._edited(0, None)

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
            cached = result is not None
            if result is None:
                # This analysis's stop flag, asked at the engine's checkpoints
                # on this thread alone (and the Rust engine's process ended).
                with ta.stop_requests(self._stop.is_set):
                    result = run_analysis(path, params, self._emit_progress)
                self._engine_done = time.perf_counter() - self._t0
                if not self._locked:
                    self._cache_save(path, params, result)
            else:
                # Content-keyed cache: the DSP is identical for byte twins,
                # but the path on the payload must be this file's.
                result.source = path
            # A cached result runs no stage, and an engine can answer as the
            # stop is asked: either way the result that was on screen stays.
            self._check_stop()
            if self._locked:
                result.points = self._merge_locks(result.points, result.beats)
            # Proposals are cached by .osu name, which another song's folder
            # can share: they belong to the audio they were decided on.
            if self._analysis is None or str(self._analysis.source) != str(result.source):
                self._decisions.clear()
            self._analysis = result
            self._assisted = None       # a fit belongs to the song it was made on
            self._history.clear()
            self._future.clear()
            # A fresh analysis is nobody's work: it must never overwrite the
            # project it may be about to be offered back from.
            self._project_dirty = False
            self._last_timings = self._timings(cached)
            # The song remembers the settings behind the result it is about
            # to show, before the page can ask for them.
            self._launch_subdivision = float(result.subdivision)
            self._remember_song_options(path, self._launch_options)
            self._emit("onResult", self._payload())
        except AnalysisStopped:
            self._emit("onStopped", self._timings(False))
        except Exception as exc:  # noqa: BLE001 -- the UI shows the message
            # Stopped, then refused before a checkpoint came: the user asked
            # for nothing more from this analysis, the refusal included.
            if self._stop.is_set():
                self._emit("onStopped", self._timings(False))
            else:
                self._emit("onError", str(exc))
        finally:
            self._busy.release()

    def _check_stop(self) -> None:
        if self._stop.is_set():
            raise AnalysisStopped()

    def _stage_rows(self, now: float) -> list[dict]:
        """Every stage so far with the seconds it took; the last one runs to ``now``."""
        ends = [stage["start_s"] for stage in self._stages[1:]] + [now]
        return [{"stage": stage["stage"], "message": stage["message"],
                 "seconds": round(end - stage["start_s"], 3)}
                for stage, end in zip(self._stages, ends)]

    def _timings(self, cached: bool) -> dict:
        """How long the analysis took, stage by stage. The last stage ends
        when the engine returned (or was stopped); the total also counts the
        cache check before the first stage and the save after the last. A
        cached result ran none."""
        now = time.perf_counter() - self._t0
        end = now if self._engine_done is None else self._engine_done
        return {"total_s": round(now, 3), "cached": cached, "stages": self._stage_rows(end)}

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
        """Each stage as it begins, with the time every earlier one took. The
        engine calls this between its stages, so a stop lands here too."""
        self._check_stop()
        now = time.perf_counter() - self._t0
        self._stages.append({"stage": stage_id(message), "message": message, "start_s": now})
        self._emit("onProgress", {"message": message, "stage": stage_id(message),
                                  "elapsed_s": round(now, 3),
                                  "done": self._stage_rows(now)[:-1]})

    # -- result cache (Phase 2: same audio plus same options, no recompute) --
    #: Entries kept and total bytes kept; payloads are small (pooled onset
    #: plus one value per beat), analyses are not.
    CACHE_ENTRIES = 10
    CACHE_BYTES = 50 * 1024 * 1024

    @staticmethod
    def _cache_dir() -> Path:
        directory = data_root() / "cache"
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
            engine_mtime = os.path.getmtime(_engine_file())
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

    # -- per-song presets: the settings each song was last analysed with -----
    def song_options(self, path: str) -> dict:
        """The detection settings this song's last analysis ran with, for the
        page to put back when the song is chosen again; ``options`` is None
        when it has none (never analysed here, forgotten, or unreadable)."""
        key = self._song_key(str(path))
        stored = self._cfg.get("song_options")
        entry = stored.get(key) if key is not None and isinstance(stored, dict) else None
        return {"ok": True, "options": None if entry is None else self._song_options_clean(entry)}

    def _song_key(self, path: str) -> str | None:
        """The song's key for its remembered settings: its audio's SHA-256
        (16 hex digits), so a copy, a moved file or a dropped one keeps them.
        Read again only when the file's size or modification time changes."""
        try:
            stat = os.stat(path)
        except OSError:
            return None
        stamp = (stat.st_size, stat.st_mtime_ns)
        known = self._song_keys.get(path)
        if known is not None and known[0] == stamp:
            return known[1]
        import hashlib
        digest = hashlib.sha256()
        try:
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
        except OSError:
            return None
        key = digest.hexdigest()[:16]
        self._song_keys[path] = (stamp, key)
        return key

    @staticmethod
    def _song_options_clean(entry) -> dict | None:
        """The remembered settings as the page's options, or None when one is
        missing or out of range (a hand-edited config, a shape from before)."""
        try:
            o = {"delta": float(entry["delta"]), "persistence": int(entry["persistence"]),
                 "confidence": float(entry["confidence"]), "pulse": entry["pulse"],
                 "prefer_map_bpm": entry["prefer_map_bpm"], "refine_beats": entry["refine_beats"]}
        except (TypeError, KeyError, ValueError, OverflowError):
            return None
        sound = (np.isfinite(o["delta"]) and o["delta"] > 0 and o["persistence"] >= 2
                 and np.isfinite(o["confidence"]) and 0.0 <= o["confidence"] <= 100.0
                 and isinstance(o["pulse"], str) and o["pulse"] in PULSE_FACTORS
                 and isinstance(o["prefer_map_bpm"], bool) and isinstance(o["refine_beats"], bool))
        return o if sound else None

    def _remember_song_options(self, path: str, options: dict) -> None:
        """Keep the settings a finished analysis ran with under its song's
        key, as the most recent; past SONG_OPTIONS_LIMIT songs, the one
        analysed longest ago is forgotten. Never fails the analysis."""
        entry = self._song_options_clean(options)
        key = self._song_key(path) if entry is not None else None
        if key is None:
            return
        stored = self._cfg.get("song_options")
        stored = dict(stored) if isinstance(stored, dict) else {}
        stored.pop(key, None)
        stored[key] = entry
        while len(stored) > SONG_OPTIONS_LIMIT:
            stored.pop(next(iter(stored)))
        self._cfg["song_options"] = stored
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
# Self-check: what an installed copy needs, found where the code looks
# ---------------------------------------------------------------------------

#: Overtone's own samples (``assets/samples.py``): per set, the four hits and
#: the two slider loops that play where a map names none of its own.
OWN_SAMPLES = tuple(f"{sample_set}-{sound}.wav" for sample_set in ("normal", "soft", "drum")
                    for sound in ("hitnormal", "hitwhistle", "hitfinish", "hitclap",
                                  "sliderslide", "sliderwhistle"))
#: The self-check's clicks fall every 0.4 s: 150 BPM for both engines.
SELF_CHECK_BPM = 150.0


def resource_files() -> dict[str, tuple[Path, ...]]:
    """The files the app reads beside its code, by what they are for. The
    installer bundles each one at the same path relative to the code (a test
    holds the two lists together), and the self-check looks for them."""
    return {"page": (APP_DIR / "index.html", APP_DIR / "app.js", APP_DIR / "styles.css"),
            "icon": (ICON_ICO, LOGO_PNG),
            "samples": tuple(ta.DEFAULT_SAMPLE_DIR / name for name in OWN_SAMPLES),
            "library schema": (overtone_library.SCHEMA_PATH,)}


def _need_files(*paths: Path) -> str:
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError("missing " + ", ".join(missing))
    return str(paths[0].parent)


def _check_schema() -> str:
    found = overtone_library.schema_file_version()
    if found != overtone_library.SCHEMA_VERSION:
        raise ValueError(f"library.sql states schema {found}, the code reads "
                         f"{overtone_library.SCHEMA_VERSION}")
    return f"{overtone_library.SCHEMA_PATH} (schema {found})"


def _check_window() -> str:
    """The window's libraries load: pythonnet, and the WebView2 assemblies,
    which pywebview only picks when the WebView2 runtime is installed.
    Importing them creates no window."""
    from webview.platforms import winforms
    if winforms.renderer != "edgechromium":
        raise RuntimeError(f"no WebView2 runtime: pywebview would use {winforms.renderer}")
    return f"pywebview renders with {winforms.renderer}"


def _click_track(path: Path) -> str:
    """Twenty seconds of noise bursts at SELF_CHECK_BPM, every fourth louder."""
    sr = 44_100
    y = np.zeros(20 * sr, dtype=np.float32)
    burst = np.exp(-np.arange(1300) / 180.0) * (np.random.default_rng(3).random(1300) - 0.5)
    for k, t in enumerate(np.arange(0.5, 19.5, 60.0 / SELF_CHECK_BPM)):
        start = int(t * sr)
        y[start:start + burst.size] += (0.9 if k % 4 == 0 else 0.5) * burst
    ta.sf.write(str(path), y, sr, subtype="PCM_16")
    return str(path)


def _check_bpm(analysis: ta.Analysis) -> str:
    if abs(analysis.global_bpm - SELF_CHECK_BPM) > 0.05:
        raise ValueError(f"read {analysis.global_bpm:.3f} BPM from clicks at {SELF_CHECK_BPM:g}")
    return f"{analysis.global_bpm:.3f} BPM"


def self_check() -> dict:
    """Whether this copy of the app has what it needs, looked up where the
    code looks for it: the page, the icon, Overtone's samples, the library
    schema, the window's libraries, and both engines on twenty seconds of
    clicks, the Rust one through the same sidecar call the app makes.

    The installer's smoke test runs it in the frozen executable
    (``Overtone.exe --self-check``), where every path above resolves inside
    the bundle. Opens no window, plays nothing, and writes only the clicks,
    in a temporary folder it removes.
    """
    import tempfile
    checks: list[dict] = []

    def check(name: str, run) -> None:
        try:
            checks.append({"name": name, "ok": True, "detail": run()})
        except Exception as exc:  # noqa: BLE001 -- a failed check is the result
            checks.append({"name": name, "ok": False, "detail": f"{type(exc).__name__}: {exc}"})

    files = resource_files()
    for name in ("page", "icon", "samples"):
        check(name, lambda paths=files[name]: _need_files(*paths))
    check("library schema", _check_schema)
    check("window", _check_window)
    with tempfile.TemporaryDirectory(prefix="overtone-check-") as scratch:
        clicks = Path(scratch) / "clicks.wav"
        check("audio write", lambda: _click_track(clicks))
        check("python engine", lambda: _check_bpm(ta.analyze_audio(str(clicks))))
        check("rust engine", lambda: f"{_check_bpm(overtone_rust.analyze(clicks))}, "
                                     f"{overtone_rust.find_cli()}")
    return {"ok": all(entry["ok"] for entry in checks), "version": ta.APP_VERSION,
            "frozen": bool(getattr(sys, "frozen", False)), "executable": sys.executable,
            "checks": checks}


def warm_up() -> dict:
    """Both engines' first calls, run before the user's first analysis.

    The first analysis in a process paid for what first calls compile and set
    up (librosa's numba kernels, scipy's filters, the FFT plans): measured in
    fresh processes, 1.0-1.4 s of a first grid analysis and 3.5-4.0 s of a
    first fallback one. The window runs this on a background thread, on the
    self-check's clicks in a temporary folder. It holds no lock and changes no
    state, so an analysis started meanwhile runs as ever. Returns the seconds
    each engine took, or the error, and never raises.
    """
    import tempfile
    took: dict = {}
    try:
        with tempfile.TemporaryDirectory(prefix="overtone-warm-") as scratch:
            clicks = _click_track(Path(scratch) / "clicks.wav")
            for engine in ("auto", "legacy"):
                start = time.perf_counter()
                ta.analyze_audio(clicks, engine=engine)
                took[engine] = round(time.perf_counter() - start, 3)
    except Exception as exc:  # noqa: BLE001 -- a warm-up must never disturb the app
        took["error"] = f"{type(exc).__name__}: {exc}"
    return took


def _run_self_check(report: str | None) -> None:
    """``--self-check [REPORT.json]``: the result as JSON in the file, or on
    stdout when none is named, and exit 0 only when every check passed. The
    window's executable has no console, so the smoke test names a file."""
    result = self_check()
    text = json.dumps(result, indent=2)
    if report:
        Path(report).write_text(text + "\n", encoding="utf-8")
    elif sys.stdout is not None:
        print(text)
    raise SystemExit(0 if result["ok"] else 1)


# ---------------------------------------------------------------------------
# Window
# ---------------------------------------------------------------------------

#: The window's own colours, matched to the page's ``--bg`` so the frame the
#: system paints before the first HTML frame is not a flash of another colour.
#: Kept here beside the window because that is the only place that needs them;
#: app/styles.css is where they are decided.
WINDOW_BG = {"dark": "#121019", "light": "#f5f4f8"}


def startup_theme() -> str:
    """``dark`` or ``light``: the saved theme, with ``system`` resolved.

    Read before the window exists, because the background colour and the
    caption are set once at creation. ``system`` asks Windows which app theme
    it is in (read only, HKCU); anything unreadable is dark, which is the
    app's own default.
    """
    try:
        theme = ta.load_config().get("theme")
    except Exception:  # noqa: BLE001 -- a broken config must not stop the window
        theme = None
    if theme in ("dark", "light"):
        return theme
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(
                    winreg.HKEY_CURRENT_USER,
                    r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
                light, _kind = winreg.QueryValueEx(key, "AppsUseLightTheme")
                return "light" if int(light) == 1 else "dark"
        except Exception:  # noqa: BLE001 -- no key, no value, no permission: dark
            pass
    return "dark"


def _dark_caption(window) -> None:
    """The title bar in the app's own theme, whatever Windows is in.

    pywebview darkens the caption only when the *system* theme is dark, and
    the app has its own light and dark themes now (the rail's theme button),
    so the two disagreed: a light app under a dark caption, or the reverse.
    Runs on the ``shown`` event because the native form does not exist before
    that.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        hwnd = int(window.native.Handle.ToInt32())
        on = ctypes.c_int(1 if startup_theme() == "dark" else 0)
        # DWMWA_USE_IMMERSIVE_DARK_MODE = 20 (Windows 10 20H1+ and 11)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(on), ctypes.sizeof(on))
    except Exception:  # noqa: BLE001 -- decoration must never block startup
        pass


def launch_target(api: Api, first: str) -> tuple[str, bool]:
    """The file to open for a command-line path, and whether to analyse it.

    A `.osz` archive is imported into Songs first (copied, never moved), and
    the song itself opens so Analyze just works; whatever refuses still opens
    the window — a failed import must never eat the launch. Anything else
    opens as it was handed over.
    """
    if first.lower().endswith(".osz") and Path(first).is_file():
        try:
            imported = api.import_osz(first)
            path = (imported.get("file") or {}).get("path", "") \
                if imported.get("ok") else first
            return path, bool(imported.get("ok") and imported.get("file"))
        except (ValueError, OSError):
            return first, False
    return first, bool(first)


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["--self-check"]:
        _run_self_check(args[1] if len(args) > 1 else None)
    import webview
    files = [a for a in args if not a.startswith("--")]
    api = Api("", autorun=False, save_projects=True)
    first = files[0] if files else ""
    target, run = launch_target(api, first)
    api._cfg["file"] = target
    api._autorun = run
    # Before the window exists: the taskbar reads the id when the window opens.
    ta.claim_taskbar_identity()
    window = webview.create_window(
        "Overtone", url=str(APP_DIR / "index.html"), js_api=api,
        width=1320, height=880, min_size=(960, 640),
        background_color=WINDOW_BG[startup_theme()])
    api._window = window
    window.events.shown += lambda: _dark_caption(window)
    # The first analysis would pay for first-call compilation: pay it now,
    # while the user picks a song. Not when a song given here is about to run.
    if not files:
        threading.Thread(target=warm_up, name="warm-up", daemon=True).start()
    webview.start(gui="edgechromium", icon=str(ICON_ICO) if ICON_ICO.is_file() else None,
                  private_mode=False,
                  storage_path=str(data_root() / "webview"))


if __name__ == "__main__":
    main()
