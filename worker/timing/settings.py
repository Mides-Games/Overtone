"""The result format, the engine's defaults, the modes, a job's options and the drum stems."""
from __future__ import annotations

import contextlib
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import overtone as ta  # noqa: E402


FORMAT = "timing-result"
VERSION = 1
#: ``timing-result v1.2``: ``version`` stays 1 so every v1 reader (the API's
#: check, the exports) reads it unchanged; ``minor`` 1 added the read-only
#: evidence the result page draws (``beats``, ``downbeats_ms``, ``onsets``,
#: ``onset_envelope``, per-section drift, ``swing``, ``pulse_hints``); ``minor``
#: 2 adds how the analysis was asked for (W11.1, W3.21, W12.19): ``mode``,
#: ``options``, ``hint_checks`` and ``stretch``. Nothing in a v1 field changes.
MINOR = 2

#: The engine generation the site's ``analyses.engine`` column records.
ENGINE = "v3"

#: How sure a section has to be for each of the three levels the site shows
#: (the legend on the home page: high confidence, medium, check by ear).
#: ``MEDIUM`` is the engine's own default ``min_confidence``: below it the
#: engine itself would not have kept the change. ``HIGH`` is not a measured
#: threshold; it is where a section stops needing a second look on the
#: synthetic corpus, where every section scores 0.99+. Real music sits lower
#: (Corpus B is still research), which is why every level says "check by ear"
#: somewhere on the page.
HIGH = 0.90
MEDIUM = 0.75
#: A grid residual past this is worth saying out loud: the desktop shell's
#: LOOSE_RESIDUAL_MS, measured on Corpus B on 2026-09-28 (30 ms fires on one
#: ranked track of 15, the one a mapper would reject). Copied, not imported.
LOOSE_RESIDUAL_MS = 30.0


def default_params() -> dict:
    """The analysis parameters a site analysis runs with.

    These are what the desktop app ran with for someone who never opened its
    settings: ``TimingAnalyzerApp.PRESETS["variable"]`` (delta 1.5,
    persistence 12, confidence 75 %), pulse Auto, prefer the map's BPM, refine
    beats, the v3 Python engine. ``analyze_audio``'s own defaults then add the
    osu! conventions, drift following and the Beat This! vote. They are
    written here rather than read from the desktop shell because that shell is
    leaving the repository, and because a server must not pick up whatever a
    developer last set in their own window.
    """
    return {"min_delta": 1.5, "persistence": 12, "min_confidence": 0.75,
            "prefer_map_bpm": True, "refine_beats": True, "force_subdivision": 0.0}


# ── Modes and the person's hints (W11.1, W3.21, W12.19) ─────────────────────

#: How long the person is willing to wait, not which engine runs (W11.1).
#: ``normal`` is the analysis every result had before modes existed, exactly.
MODES = ("fast", "normal", "strict")
DEFAULT_MODE = "normal"

#: What each mode changes, and nothing else:
#:
#: - ``vote``: whether Beat This! votes on the red lines (it still needs the
#:   model to be there; a worker without it votes in no mode);
#: - ``judges``: whether Beat This! is asked about the octave at all (the
#:   local, section and song octave judges). Off, every judge gets "no
#:   answer", which each one already reads as "leave the engine's octave";
#: - ``flags``: engine switches set for the job and restored after it.
#:
#: ``fast`` is the engine without the network: about a tenth of the time on
#: a quiet machine (docs/deploy.md, W2.4). ``strict`` is ``normal`` until a
#: switch is measured to help on real music. The engine's switches that are
#: off (PIECEWISE_GRID, CONSTANT_GRID, SONG_OCTAVE_BEAT_THIS) are the
#: candidates, each "off until measured on the server" in python/overtone.py;
#: none has a held-out measurement yet (docs/timeline.md, 2026-10-27), so none
#: is switched on here. W11.4, the phase polish, is what is meant to fill it.
#: ``drums``: whether the mode separates every song's drums (STEMS_EVERY_SONG).
#: Fast does not: the separator would add ~5-8 s per minute of audio to a mode
#: whose point is the wait (site/api/src/utils/estimate.js); a band's hint
#: still separates in it.
MODE_SETTINGS = {
    "fast": {"vote": False, "judges": False, "drums": False, "flags": {}},
    "normal": {"vote": True, "judges": True, "drums": True, "flags": {}},
    "strict": {"vote": True, "judges": True, "drums": True, "flags": {}},
}

#: Hints a person can give before analysing (W3.21), and their bounds. The
#: API checks the same bounds; the worker checks again, since what it is
#: handed decides what the engine is asked.
HINT_BPM = (30.0, 400.0)
HINT_METER = (1, 16)
TEMPO_HINTS = ("constant", "changes")
#: The shortest stretch worth analysing: the engine wants two seconds, and a
#: tempo needs a few bars.
MIN_STRETCH_S = 10.0
#: How far an approximate BPM may be from the reading before the result says
#: so: a person's "about 170" is a guess, not a measurement.
APPROX_SLACK = 0.10


def clean_options(raw) -> dict:
    """The hints that are well formed, as plain numbers and words; anything
    else is dropped (the API refuses it before it gets here)."""
    if not isinstance(raw, dict):
        return {}
    out = {}

    def number(key, low, high):
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        return value if math.isfinite(value) and low <= value <= high else None

    if raw.get("tempo") in TEMPO_HINTS:
        out["tempo"] = raw["tempo"]
    bpm = number("bpm", *HINT_BPM)
    low, high = number("bpm_min", *HINT_BPM), number("bpm_max", *HINT_BPM)
    if bpm is not None:
        out["bpm"] = bpm
    elif low is not None and high is not None and low < high:
        out["bpm_min"], out["bpm_max"] = low, high
    meter = raw.get("meter")
    if isinstance(meter, int) and not isinstance(meter, bool) and HINT_METER[0] <= meter <= HINT_METER[1]:
        out["meter"] = meter
    start, end = number("start_s", 0.0, 4 * 3600.0), number("end_s", 0.0, 4 * 3600.0)
    if start is not None and end is not None and end - start >= MIN_STRETCH_S:
        out["start_s"], out["end_s"] = start, end
    if raw.get("band") is True:
        out["band"] = True
    return out


#: The separator's share of a job's time: the job ends at 3x the audio's length
#: (worker/isolate.py), so the separator stops at 1.5x and leaves the engine the
#: rest, reading the mix if it has to. Measured on the VPS (2026-10-31, 6 cores):
#: 0.47x the length with the glibc build, 0.63x with the static one.
STEMS_TIME_SHARE = 1.5
STEMS_MIN_TIMEOUT_S = 60.0

#: Every song's drums separated for the grid, not only a live band's
#: (STEMS_DRUMS where the separator is installed). Measured on the server
#: against the same code without it (cd0b4ac, 2026-11-02), share of the songs'
#: time read right: bands-variable +9.0 dev / +4.4 held out, anime-variable
#: +3.0 / +3.6, anime-single +9.8 / +7.4, at 1.2-2.5x an analysis's time with
#: Stemsplit v0.2.0. Without the separator, or when it fails, the mix is read.
#: OVERTONE_STEMS=0 in the worker's environment turns it off without an edit.
STEMS_EVERY_SONG = True


def stems_every_song() -> bool:
    """Whether every song's drums are separated (STEMS_EVERY_SONG, OVERTONE_STEMS)."""
    return STEMS_EVERY_SONG and os.environ.get("OVERTONE_STEMS", "1") != "0"


def stems_timeout(seconds: float | None) -> float | None:
    """How long the separator may run on audio this long; None when unknown."""
    return max(STEMS_MIN_TIMEOUT_S, STEMS_TIME_SHARE * seconds) if seconds else None


def stems_available() -> bool:
    """Whether the drums separator a live band's hint asks for is installed:
    the stemsplit binary and its weights (python/overtone.py, STEMS_DRUMS)."""
    import shutil
    binary = shutil.which(ta.STEMSPLIT_CLI) or os.path.isfile(ta.STEMSPLIT_CLI)
    model = ta.STEMSPLIT_MODEL or os.fspath(ta.ROOT / "assets" / "models" / ta.STEMSPLIT_WEIGHTS)
    return bool(binary) and os.path.isfile(model)


def octave_window(options: dict) -> tuple[float, float] | None:
    """The octave the engine reads the song at when the person named a tempo:
    the engine's own MAP_OCTAVE_RANGE (one octave, 120-240 by default) moved
    to sit around their BPM or the middle of their range. None without a
    tempo hint, and None when the hint already lies inside the default
    window: the engine reads that octave anyway, so it runs untouched."""
    lo, hi = ta.MAP_OCTAVE_RANGE
    if "bpm" in options:
        centre = options["bpm"]
        if lo <= centre <= hi:
            return None
    elif "bpm_min" in options:
        if lo <= options["bpm_min"] and options["bpm_max"] <= hi:
            return None
        centre = math.sqrt(options["bpm_min"] * options["bpm_max"])
    else:
        return None
    return (round(centre / math.sqrt(2.0), 3), round(centre * math.sqrt(2.0), 3))


@contextlib.contextmanager
def engine_settings(mode: str, window: tuple[float, float] | None, stems: bool = False,
                    stems_timeout_s: float | None = None):
    """The engine switched as ``mode``, the octave window and a live band's
    drums (``stems``) ask, for one job, and put back as it was after it,
    whatever happens. The worker's analysis process runs one job at a time,
    so nothing else sees the switches."""
    settings = MODE_SETTINGS[mode]
    flags = {**settings["flags"], **({"STEMS_DRUMS": True} if stems else {})}
    if stems and stems_timeout_s:
        flags["STEMSPLIT_TIMEOUT_S"] = float(stems_timeout_s)
    saved = {name: getattr(ta, name) for name in flags}
    saved["MAP_OCTAVE_RANGE"] = ta.MAP_OCTAVE_RANGE
    saved["_beat_this_judge_beats"] = ta._beat_this_judge_beats
    try:
        for name, value in flags.items():
            setattr(ta, name, value)
        if window is not None:
            ta.MAP_OCTAVE_RANGE = window
        if not settings["judges"]:
            ta._beat_this_judge_beats = lambda _y, _sr: None
        yield
    finally:
        for name, value in saved.items():
            setattr(ta, name, value)
