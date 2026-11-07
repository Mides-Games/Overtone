"""The main analysis entry points: analyze_audio, analyze_batch and assembly."""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import median_filter

from overtone_paths import app_version, data_root

from . import audio_io, beat_this, data_model, drum_signal, hybrid_tracker, octave_choice, onsets, params, phrases, precision_grid, red_lines, tempo_helpers, tempo_judge


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    if values.size == 0:
        return 0.0
    order = np.argsort(values)
    values, weights = values[order], np.maximum(weights[order], 0.0)
    total = float(np.sum(weights))
    if total <= 0:
        return float(np.median(values))
    cumulative = np.cumsum(weights) / total
    return float(values[int(np.searchsorted(cumulative, 0.5))])


def _assemble_analysis(path: str | os.PathLike[str], y: np.ndarray, sr: int, fit: dict,
                       min_delta: float, persistence: int, min_confidence: float,
                       factor: float) -> Analysis:
    """Build the public :class:`Analysis` from a precision fit."""
    sections: list[GridSection] = fit["sections"]
    # A time-signature change at a constant tempo is invisible to section
    # growth, which splits on measures per second. When the bar is provable
    # and the signature moves, the measure grid places the red lines instead.
    points = precision_grid.points_from_meter(sections, fit["times"], fit["weights"],
                               persistence, factor)
    if points is None:
        measures = precision_grid.section_measures(sections, fit["times"], fit["weights"])
        points = precision_grid._points_from_sections(sections, fit["first_sound"], persistence,
                                       fit["downbeat"], fit["meter_beats"], factor,
                                       measures)
    kept = [p for p in points if p.confidence >= min_confidence]
    if not kept and points:
        # Never hand back an empty map when a grid was clearly found.
        kept = [max(points, key=lambda p: p.confidence)]
    # Two sections can converge once each is refitted on its own attacks.
    final: list[TimingPoint] = kept[:1]
    for point in kept[1:]:
        # point.bpm already carries the pulse factor, so the threshold must too:
        # compared raw, ÷4 shrank a 3.5 BPM change to 0.875 and dropped it.
        if abs(point.bpm - final[-1].bpm) >= min_delta * factor:
            final.append(point)
    beats = precision_grid._synth_beats(sections, factor)
    local = precision_grid._local_bpm_curve(fit["times"], fit["weights"], sections, beats, factor)
    durations = np.array([max(s.end_s - s.start_s, 1e-6) for s in sections])
    bpms = np.array([s.bpm * factor for s in sections])
    global_bpm = _weighted_median(bpms, durations)
    residual = float(np.average([s.residual_ms for s in sections], weights=durations))
    natural = precision_grid._synth_beats(sections, 1.0)          # the un-multiplied beat grid
    base_frames = natural * sr / params.FIT_HOP if natural.size else np.zeros(0)
    return data_model.Analysis(str(path), y.size / sr, beats, local, final, params.FIT_HOP, sr,
                    factor, global_bpm, tempo_helpers._stability(local),
                    fit["meter"], fit["env"], np.asarray(base_frames, dtype=float),
                    fit["times"], fit["weights"], sections, fit["meter_beats"],
                    fit["downbeat"], residual, "precision")


def _legacy_analysis(path: str | os.PathLike[str], y: np.ndarray, sr: int,
                     min_delta: float, persistence: int, prefer_map_bpm: bool,
                     min_confidence: float, say: Callable[[str], None],
                     factor: float, refine_beats: bool, heard=None,
                     activation=None) -> Analysis:
    """v2 tracker path: used when no regular pulse grid can be fitted.

    It refuses audio with no pulse at all instead of tracking one: a beat
    tracker always finds *some* beats, so on white noise it used to report
    127.68 BPM. A tempo that drifts or ramps still passes; noise does not.

    Its beats sit on the onset envelope's peaks, after the sound starts, so
    with ``refine_beats`` they and the red lines on them are moved by the lag
    measured on the song (_tracker_lag). Sections, BPMs, the pulse and the
    meter are still read on the tracker's own beats. From the tracked beats
    on it is _tracker_result, which the ×2 / ÷2 rebuild runs as well.
    """
    say("Extracting transients and tempo hypotheses…")
    hop = params.HOP
    onset = onsets._onset_envelope(y, sr, hop)
    if onset.size < 8:
        raise ValueError("Not enough beats detected. Try a file with clearer percussion.")
    if hybrid_tracker._pulse_gap(onset, sr, hop) < params.MIN_PULSE_GAP:
        raise ValueError("No rhythmic pulse found: this audio sounds like noise or has no beat, "
                         "so there is no BPM to report.")
    try:
        frame_tempi, tracker_bpm = hybrid_tracker._tempo_readings(onset, sr, hop)
    except Exception:
        frame_tempi = tracker_bpm = None
    guides = tempo_helpers._global_tempo_guides(onset, sr, hop, frame_tempi)
    prior = guides[0][0] if guides else None

    network = hybrid_tracker._dbn_frames(activation, sr, hop, onset.shape[-1]) if params.DBN_TRACKER else None
    if network is None and params.BEAT_THIS_TRACKER:
        network = beat_this._beat_this_frames(heard, sr, hop, onset.shape[-1])
    if network is not None:
        say("Tracking beats (Beat This!)…")
        beat_frames = network
    else:
        say("Tracking beats (hybrid DP + PLP + peaks)…")
        beat_frames = hybrid_tracker._track_beats_hybrid(onset, sr, hop, prior, tracker_bpm)
    if len(beat_frames) < 8:
        raise ValueError("Not enough beats detected. Try a file with clearer percussion.")
    if refine_beats:
        beat_frames = hybrid_tracker._refine_beats_to_transients(beat_frames, onset, sr, hop)

    say("Resolving half/double-time pulse…")
    # ``factor`` multiplies the pulse the tracker settles on, as it does the
    # precision engine's: 0 or 1 is that pulse. It was read as an absolute
    # subdivision, so 1 switched the octave choice off and 0.5 / 0.25 were
    # dropped without a word.
    auto_subdivision = tempo_helpers._choose_subdivision(onset, beat_frames, prefer_map_bpm, guides)
    subdivision = auto_subdivision * float(factor) if factor else auto_subdivision

    say("Computing local tempo and persistent changes…")
    result = hybrid_tracker._tracker_result(str(path), y.size / sr, onset, np.asarray(beat_frames, dtype=float),
                             sr, hop, subdivision, float(auto_subdivision), min_delta,
                             persistence, min_confidence, refine_beats)
    if len(result.beats) < 8:
        raise ValueError("Detected tempo is outside the usable range.")
    return hybrid_tracker._moved_by(result, hybrid_tracker._tracker_lag(y, sr, result.beats) if refine_beats else 0.0)


def analyze_audio(path: str | os.PathLike[str], min_delta: float = 1.5,
                  persistence: int = 12, prefer_map_bpm: bool = True,
                  min_confidence: float = 0.75,
                  progress: Callable[[str], None] | None = None,
                  force_subdivision: float = 0, refine_beats: bool = True,
                  engine: str = "auto", osu_conventions: bool = True,
                  follow_drift: bool = params.DRIFT_FOLLOW, beat_vote: bool = True) -> Analysis:
    """Analyse an audio file and return stable timing points.

    Most common formats work when libsndfile supports them. For MP3/M4A and
    other compressed formats, install FFmpeg so librosa can use its fallback.

    The default ``engine="auto"`` runs the v3 precision grid fitter and falls
    back to the v2 beat tracker only when the audio has no fittable pulse
    (rubato, free time, no percussion). ``engine="legacy"`` forces the v2 path,
    ``engine="precision"`` refuses to fall back.

    ``force_subdivision`` multiplies the detected beat rate (0 = auto; 0.5
    halves it, 2 doubles it). Use it when you *know* the song's octave — e.g.
    a 225 BPM stream reported as 112 BPM — or from the GUI pulse selector.
    ``osu_conventions`` reads the result as osu! maps are timed: at the octave
    in MAP_OCTAVE_RANGE and at the whole BPM where the attacks agree. Off, the
    engine's own reading comes back -- what the golden vectors pin, since the
    Rust engine gets the same conventions from overtone_rust.py.
    ``beat_vote`` lets Beat This! replace the precision engine's red lines
    where they explain the attacks clearly better (_beat_this_vote).
    ``follow_drift`` adds red lines where the tempo drifts (_follow_drift);
    on by default (DRIFT_FOLLOW).
    ``refine_beats`` re-times every attack on the raw waveform at sample
    resolution (and moves the fallback tracker's beats by the lag read that
    way); disable it only to diagnose whether that snapping drifts.
    """
    if min_delta <= 0 or persistence < 2 or not 0 <= min_confidence <= 1:
        raise ValueError("Minimum delta must be positive, persistence at least 2, confidence between 0 and 1.")
    if engine not in ("auto", "precision", "legacy"):
        raise ValueError("Engine must be 'auto', 'precision' or 'legacy'.")
    if force_subdivision and float(force_subdivision) not in params.ALLOWED_FACTORS:
        raise ValueError(f"Subdivision must be one of {sorted(params.ALLOWED_FACTORS)} (or 0 for auto).")
    say = progress or (lambda _message: None)
    y, sr = audio_io._load_audio(path, say)
    # Beat This! hears the mix it was trained on; the grid, the drums.
    y_mix, y = y, drum_signal._percussive(y, sr)
    factor = float(force_subdivision) if force_subdivision else 1.0

    if engine in ("auto", "precision"):
        failure = ""
        try:
            fit = precision_grid._precision_engine(y, sr, min_delta, persistence, prefer_map_bpm,
                                    refine_beats, say)
        except Exception as exc:
            if engine == "precision":
                raise
            # Falling back is correct, but doing it *silently* would hide a real
            # bug behind merely-worse numbers, so say what went wrong.
            fit, failure = None, f" ({type(exc).__name__}: {exc})"
        if fit is not None:
            analysis = _assemble_analysis(path, y, sr, fit, min_delta, persistence,
                                          min_confidence, factor)
            if force_subdivision or not prefer_map_bpm or not osu_conventions:
                return analysis
            analysis = red_lines._fold_to_map_octave(analysis, min_delta, persistence, min_confidence)
            analysis = red_lines._snap_whole_bpm(analysis, min_delta, persistence, min_confidence)
            if follow_drift:
                analysis = red_lines._follow_drift(analysis)
            analysis = red_lines._change_points(analysis)
            before, before_beats = float(analysis.global_bpm), analysis.beats
            if beat_vote and beat_this._beat_this_session() is not None:
                say("Checking the beats with Beat This!…")
                analysis = beat_this._beat_this_vote(analysis, y_mix, sr)
            analysis = red_lines._fold_local_to_map_octave(
                analysis, before, before_beats, lambda: red_lines._beat_this_tempo(y_mix, sr))
            analysis = beat_this._song_octave_by_beat_this(analysis, lambda: beat_this._beat_this_judge_beats(y_mix, sr))
            return phrases._tidy_bpms(octave_choice._lines_on_downbeats(phrases._phrase_lines(phrases._snap_whole_points(tempo_judge._tempo_judge(octave_choice._octave_rule(octave_choice._smooth_octaves(
                red_lines._fold_lines_to_song_octave(analysis, lambda: beat_this._beat_this_judge_beats(y_mix, sr)))), lambda: (y_mix, sr))))))
        if engine == "precision":
            raise ValueError(
                "No steady pulse could be fitted. Try engine='auto' or a file with clearer percussion.")
        say("No fittable grid — falling back to the beat tracker…" + failure)
    analysis = _legacy_analysis(path, y, sr, min_delta, persistence, prefer_map_bpm,
                                min_confidence, say, float(force_subdivision), refine_beats,
                                heard=lambda: beat_this._beat_this_judge_beats(y_mix, sr),
                                activation=lambda: beat_this._beat_this_activation(y_mix, sr))
    if force_subdivision or not prefer_map_bpm or not osu_conventions:
        return analysis
    tracked = red_lines._local_tempo_track(analysis)
    if tracked is None:
        return phrases._tidy_bpms(red_lines._fold_to_map_octave(analysis, min_delta, persistence, min_confidence))
    tracked = red_lines._fold_local_to_map_octave(tracked, float(analysis.global_bpm), analysis.beats,
                                        lambda: red_lines._beat_this_tempo(y_mix, sr))
    tracked = beat_this._song_octave_by_beat_this(tracked, lambda: beat_this._beat_this_judge_beats(y_mix, sr))
    tracked = octave_choice._smooth_octaves(red_lines._fold_lines_to_song_octave(tracked, lambda: beat_this._beat_this_judge_beats(y_mix, sr)))
    tracked = drum_signal._guard_tracker(tracked, lambda: beat_this._beat_this_judge_beats(y_mix, sr))
    tracked = drum_signal._follow_drummer(tracked, y_mix, sr)
    tracked = red_lines._piecewise_grid(tracked, lambda: beat_this._beat_this_judge_beats(y_mix, sr))
    tracked = phrases._with_attacks(red_lines._constant_grid(tracked, lambda: beat_this._beat_this_judge_beats(y_mix, sr)), y, sr)
    tracked = red_lines._snap_constant_line(tracked)
    tracked = tempo_judge._tempo_judge(tracked, lambda: (y_mix, sr))
    return phrases._tidy_bpms(octave_choice._lines_on_downbeats(phrases._phrase_lines(tracked)))


def analyze_batch(folder: str | os.PathLike[str], min_delta: float = 1.5,
                  persistence: int = 12, prefer_map_bpm: bool = True,
                  min_confidence: float = 0.75, force_subdivision: float = 0.0,
                  refine_beats: bool = True, progress=None,
                  engine: str = "auto") -> list[dict]:
    """Analyze every audio file in a folder; one bad file never stops the rest.

    Phase 8 batch entry point (single flat folder — osu! song folders are
    flat, and so is this). Each row is plain JSON types: ``{"file", "ok",
    "global_bpm", "points", "duration", "error"}`` with the file's basename,
    sorted by name so two runs print the same table.
    """
    root = Path(folder)
    if not root.is_dir():
        raise ValueError(f"{root} is not a folder.")
    try:
        names = sorted(p.name for p in root.iterdir()
                       if p.is_file() and p.suffix.lower() in params.AUDIO_EXTENSIONS)
    except OSError as exc:
        raise ValueError(f"Could not list {root}: {exc}") from exc
    rows: list[dict] = []
    for name in names:
        try:
            analysis = analyze_audio(str(root / name), min_delta, persistence,
                                     prefer_map_bpm, min_confidence, progress,
                                     force_subdivision, refine_beats, engine)
        except (ValueError, RuntimeError, OSError) as exc:
            rows.append({"file": name, "ok": False, "global_bpm": 0.0,
                         "points": 0, "duration": 0.0, "error": str(exc)})
            continue
        rows.append({"file": name, "ok": True,
                     "global_bpm": round(float(analysis.global_bpm), 4),
                     "points": len(analysis.points),
                     "duration": round(float(analysis.duration), 2), "error": ""})
    return rows


def rebuild_with_subdivision(analysis: Analysis, factor: float,
                             min_delta: float = 1.5, persistence: int = 12,
                             min_confidence: float = 0.75) -> Analysis:
    """Re-resolve an existing analysis at another pulse octave, no re-analysis.

    Powers the GUI "×2 / ÷2" quick fix. With a precision analysis this is exact
    — the fitted grids are simply read at a different beat rate. With the
    fallback tracker's, the beats it tracked are split or thinned again and
    finished by the analysis's own steps (_tracker_result), so a rebuild at
    the analysis's own pulse gives the analysis back. Raises ``ValueError``
    for an unsupported factor or an analysis with no stored grid.
    """
    if float(factor) not in params.ALLOWED_FACTORS:
        raise ValueError(f"Subdivision factor must be one of {sorted(params.ALLOWED_FACTORS)}.")
    factor = float(factor)
    if getattr(analysis, "local_tempo", False):
        return red_lines._rescale_local(analysis, factor)
    if analysis.sections:
        fit = {"times": analysis.attack_times, "weights": analysis.attack_weights,
               "env": analysis.onset, "sections": analysis.sections,
               "meter": analysis.meter, "meter_beats": analysis.meter_beats,
               "downbeat": analysis.downbeat_class,
               "first_sound": precision_grid._first_on_grid(analysis.attack_times, analysis.sections[0])}
        rebuilt = _assemble_analysis(analysis.source, np.zeros(1), analysis.sample_rate,
                                     fit, min_delta, persistence, min_confidence, factor)
        return data_model.Analysis(analysis.source, analysis.duration, rebuilt.beats,
                        rebuilt.local_bpms, rebuilt.points, rebuilt.hop_length,
                        rebuilt.sample_rate, factor,
                        rebuilt.global_bpm, rebuilt.stability, rebuilt.meter,
                        rebuilt.onset, rebuilt.base_frames, rebuilt.attack_times,
                        rebuilt.attack_weights, rebuilt.sections, rebuilt.meter_beats,
                        rebuilt.downbeat_class, rebuilt.fit_residual_ms, "precision")
    if analysis.base_frames is None or len(analysis.base_frames) < 4:
        raise ValueError("This analysis has no stored beat grid to rebuild from.")
    rebuilt = hybrid_tracker._tracker_result(analysis.source, analysis.duration, analysis.onset,
                              analysis.base_frames, analysis.sample_rate,
                              analysis.hop_length, factor,
                              float(getattr(analysis, "auto_subdivision", 0.0)),
                              min_delta, persistence, min_confidence,
                              bool(getattr(analysis, "refine_beats", True)))
    # There is no audio here to read the lag on, so the song's own moves the
    # new beats; a rebuild's beats, read on the audio, lag within 2.5 ms of it.
    return hybrid_tracker._moved_by(rebuilt, float(getattr(analysis, "beat_shift_s", 0.0)))
