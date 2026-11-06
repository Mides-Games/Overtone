"""One audio file in, one timing-result out."""
from __future__ import annotations

import contextlib
import sys
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import overtone as ta  # noqa: E402

from timing.checks import (
    AnalysisFailed,
    _shifted,
    audio_seconds,
    header_refusal,
    hint_checks,
    shift_result)  # noqa: E402
from timing.engine_info import stage_of  # noqa: E402
from timing.result import asked, build_result, refused_result  # noqa: E402
from timing import settings  # noqa: E402  -- stems_available, read at call time
from timing.settings import (
    DEFAULT_MODE,
    MIN_STRETCH_S,
    MODES,
    MODE_SETTINGS,
    clean_options,
    default_params,
    engine_settings,
    octave_window,
    stems_every_song,
    stems_timeout)  # noqa: E402


def analyse(path: str | Path, *, vote: bool, hash_: str,
            max_seconds: float | None = None,
            progress: Callable[[str, float], None] | None = None,
            mode: str = DEFAULT_MODE, options: dict | None = None) -> dict:
    """Run the engine on one file and return its ``timing-result v1``.

    ``vote`` says whether the Beat This! vote is available; ``mode`` says
    whether this job uses it (W11.1). ``options`` are the person's hints
    (W3.21): an expected tempo moves the octave window the engine reads the
    song at, a meter fills the bars the engine could not prove, a stretch
    (W12.19) is cut out of the decoded audio and analysed alone, its times
    put back in the song's timeline. The rest only flag the result
    (``hint_checks``). With no options and the default mode this is the
    analysis it always was.

    A ``ValueError`` from the engine is a refusal (no pulse, too short, too
    long), returned as a result. Anything else is a failure, raised as
    ``AnalysisFailed`` with the engine's message.
    """
    mode = mode if mode in MODES else DEFAULT_MODE
    options = clean_options(options)
    vote = bool(vote) and MODE_SETTINGS[mode]["vote"]
    window = octave_window(options)
    # The drums, separated, for the grid: every song's since STEMS_EVERY_SONG
    # (2026-11-02), a live band's on its hint even with it off. Without the
    # separator the mix is analysed and the result says so.
    stems = ((bool(options.get("band")) or (stems_every_song() and MODE_SETTINGS[mode]["drums"]))
             and settings.stems_available())

    def refuse(message: str, duration_s: float | None = None) -> dict:
        return {**refused_result(message, vote=vote, hash_=hash_, duration_s=duration_s),
                **asked(mode, options)}

    heavy = header_refusal(path, max_seconds)
    if heavy:
        return refuse(heavy)
    seconds = audio_seconds(path)
    if max_seconds and seconds is not None and seconds > max_seconds:
        return refuse(f"Audio is longer than {max_seconds / 60:g} minutes.", seconds)

    def say(message: str) -> None:
        found = stage_of(message)
        if found and progress is not None:
            progress(*found)

    params = default_params()
    stretch = None
    separator_failed = False
    with contextlib.ExitStack() as stack:
        source = Path(path)
        try:
            if "start_s" in options:
                # The whole song decoded once, as the engine decodes it, and the
                # stretch written out losslessly: the engine then reads exactly
                # those samples, and the offset back is a whole number of them.
                y, sr = ta._load_audio(str(path), say)
                full = len(y) / sr
                if max_seconds and full > max_seconds:
                    return refuse(f"Audio is longer than {max_seconds / 60:g} minutes.", full)
                first = int(round(options["start_s"] * sr))
                last = int(round(min(options["end_s"], full) * sr))
                if last - first < MIN_STRETCH_S * sr:
                    return refuse(f"The stretch to analyse holds less than {MIN_STRETCH_S:g} seconds of the audio.", full)
                folder = stack.enter_context(tempfile.TemporaryDirectory(prefix="overtone-stretch-"))
                source = Path(folder) / "stretch.wav"
                ta.sf.write(str(source), y[first:last], sr, subtype="FLOAT")
                del y
                stretch = {"start_ms": round(first / sr * 1000.0, 3), "end_ms": round(last / sr * 1000.0, 3),
                           "duration_s": round(full, 3)}
            def run(drums: bool):
                with engine_settings(mode, window, drums, stems_timeout(seconds)):
                    return ta.analyze_audio(
                        str(source), params["min_delta"], params["persistence"], params["prefer_map_bpm"],
                        params["min_confidence"], say, params["force_subdivision"], params["refine_beats"],
                        beat_vote=vote)

            try:
                analysis = run(stems)
            except ta.SeparatorFailed as exc:
                # out of memory, out of time, or broken on this host: the mix, said so
                print(f"[worker] drums separator failed, reading the mix: {exc}", file=sys.stderr)
                stems, separator_failed = False, True
                analysis = run(False)
        except ValueError as exc:
            return refuse(str(exc), seconds)
        except Exception as exc:  # noqa: BLE001 -- the job records why, the worker keeps going
            raise AnalysisFailed(str(exc) or type(exc).__name__) from exc
    if max_seconds and analysis.duration > max_seconds:
        return refuse(f"Audio is longer than {max_seconds / 60:g} minutes.", float(analysis.duration))
    if progress is not None:
        progress("result", 0.95)

    # A meter the person named fills the bars the engine could not prove: the
    # engine's own fallback for such a line is the analysis's meter, which was
    # a guess there. A bar it proved stays, and a different one is flagged.
    applied = 0
    if "meter" in options:
        applied = sum(1 for p in analysis.points if not p.meter_known)
        if applied:
            below = str(analysis.meter).split("/")[1] if "/" in str(analysis.meter) else "4"
            analysis = replace(analysis, meter=f"{options['meter']}/{below}")

    result = {**build_result(analysis, vote=vote, hash_=hash_), **asked(mode, options)}
    if stretch is not None:
        result = shift_result(result, stretch["start_ms"])
        result["osu_timing"] = ta.osu_timing_text(_shifted(analysis, stretch["start_ms"]))
        result["duration_s"] = stretch.pop("duration_s")
        result["stretch"] = stretch
    result["hint_checks"] = hint_checks(result, options, window, applied)
    if options.get("band"):
        key = "band_drums" if stems else "band_separator_failed" if separator_failed else "band_no_separator"
        result["hint_checks"].append({"level": "info" if stems else "warn", "key": key, "values": {}})
    elif stems or separator_failed:
        # what was read, said for every song now that every song is separated
        key = "band_drums" if stems else "band_separator_failed"
        result["hint_checks"].append({"level": "info" if stems else "warn", "key": key, "values": {}})
    return result
