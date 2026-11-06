"""What the engine test modules share: synthetic tracks, sample maps and the
write-history scratch folder each module points the engine at.
"""
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from overtone import (
    HOP,
    MIN_PULSE_GAP,
    _load_audio,
    _onset_envelope,
    _pulse_gap,
    _pulse_log10p,
    _meter_from_grid,
    Analysis,
    GridSection,
    TimingPoint,
    _choose_subdivision,
    _fill_missed_beats,
    _atomic_grid_candidates,
    _expand_fit,
    _global_tempo_guides,
    _is_red_line,
    _recentre_phase,
    _refine_grid,
    _retime_onsets,
    _robust_local_bpms,
    _segment_tempi,
    _tune_boundary,
    add_timing_point,
    analysis_summary,
    analyze_audio,
    delete_timing_point,
    export_click_track,
    inject_osu_timing_points,
    nudge_timing_point,
    osu_timing_text,
    rebuild_with_subdivision,
    rescale_section,
    export_osz,
    osu_beatmap_text,
    section_measures,
    detect_bar,
    meter_segments,
    points_from_meter,
    _points_from_sections,
    snap_timing_points,
    suggest_section_pulse,
    update_timing_point,
    validate_timing_points,
    read_osu_red_lines,
    compare_map_timing,
    scan_beatmap_folder,
    analyze_batch,
    read_osu_beatmap,
    set_beatmap_reds,
    write_osu_beatmap,
    alignment_report,
    analysis_report,
    density_report,
    suggest_missing_lines,
    add_red_line,
    beatmap_text,
    mapset_report,
    main,
)
from bench.mapper_agreement import OsuDbFormatError, parse_osu_db


#: The write-history log points at a scratch folder for each test module, so
#: writer tests never land in real history. Removed afterwards.
_HISTORY_SCRATCH: list[tempfile.TemporaryDirectory] = []


def setUpModule() -> None:
    _HISTORY_SCRATCH.append(tempfile.TemporaryDirectory(prefix="overtone-history-"))
    os.environ["OVERTONE_HISTORY_DIR"] = _HISTORY_SCRATCH[-1].name


def tearDownModule() -> None:
    os.environ.pop("OVERTONE_HISTORY_DIR", None)
    _HISTORY_SCRATCH.pop().cleanup()



def _click_track(path: Path, bpm: float, duration: float = 12.0,
                 change_at: float | None = None, second_bpm: float = 140.0,
                 sr: int = 44100) -> None:
    import soundfile as sf
    y = np.zeros(int(sr * duration), dtype=np.float32)
    n = int(0.04 * sr)
    t = np.arange(n) / sr
    kick = (np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.006)).astype(np.float32)
    tt = 0.25
    while tt < duration - 0.2:
        idx = int(tt * sr)
        y[idx:idx + n] += kick
        current = bpm if change_at is None or tt < change_at else second_bpm
        tt += 60.0 / current
    sf.write(str(path), y, sr)


def _click_ramp(path: Path, bpm0: float, bpm1: float, duration: float,
                sr: int = 44100) -> np.ndarray:
    """A click on every beat of a tempo ramping from ``bpm0`` to ``bpm1``: no
    grid fits it, so it reaches the fallback tracker. Returns each click's
    time, to the sample it starts on."""
    import soundfile as sf
    y = np.zeros(int(sr * duration), dtype=np.float32)
    n = int(0.03 * sr)
    t = np.arange(n) / sr
    click = (np.sin(2 * np.pi * 1800 * t) * np.exp(-t / 0.004)).astype(np.float32) * 0.9
    clicks, tt = [], 0.5
    while tt < duration - 0.5:
        i = int(round(tt * sr))
        y[i:i + n] += click
        clicks.append(i / sr)
        tt += 60.0 / (bpm0 + (bpm1 - bpm0) * tt / duration)
    sf.write(str(path), y, sr)
    return np.asarray(clicks)


def _from_nearest_ms(times, targets, reach: float = 0.06) -> np.ndarray:
    """Each time less its nearest target, in ms (+ when later); those with no
    target within ``reach`` seconds are left out."""
    times, targets = np.asarray(times, dtype=float), np.asarray(targets, dtype=float)
    right = np.clip(np.searchsorted(targets, times), 1, targets.size - 1)
    nearest = np.where(np.abs(times - targets[right - 1]) <= np.abs(times - targets[right]),
                       targets[right - 1], targets[right])
    gap = times - nearest
    return gap[np.abs(gap) <= reach] * 1000.0


def _two_points():
    beats = np.arange(0.0, 20.0, 0.5)
    return beats, [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(5000.0, 140.0, 0.8, 10)]


def _section_analysis(mid_amp: float, bpm: float = 112.4):
    from overtone import Analysis
    sr, hop = 44100, 256
    step = int(round(60.0 / bpm * sr / hop))
    onset = np.zeros(3000, dtype=np.float32)
    grid = np.arange(50, 2900, step)
    onset[grid] = 1.0
    onset[((grid[:-1] + grid[1:]) / 2).astype(int)] = mid_amp
    beats = grid.astype(float) * hop / sr
    local = np.full(len(beats), bpm)
    return Analysis("synthetic", float(beats[-1] + 2), beats, local,
                    [TimingPoint(float(beats[0] * 1000), bpm, 0.9, 0)],
                    hop, sr, 1, bpm, 1.0, "4/4", onset, grid)


def _timing_rows(text: str) -> list[list[str]]:
    rows, inside = [], False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "[TimingPoints]":
            inside = True
            continue
        if inside and stripped.startswith("["):
            break
        if inside and stripped and not stripped.startswith("//"):
            rows.append([f.strip() for f in stripped.split(",")])
    return rows


def _heard_at(text: str, t: float) -> tuple:
    """What osu! plays at time t: (SV, sample set, index, volume, kiai).

    Written independently of the injector on purpose: a red line resets SV to
    1, a green sets it to -100/beatLength, both set the sample fields; points
    at the same time apply red first; before the first point, the first
    point's settings apply.
    """
    points = []
    for n, f in enumerate(_timing_rows(text)):
        length = float(f[1])
        red = length > 0 and (len(f) < 7 or f[6] == "1")
        points.append((float(f[0]), 0 if red else 1, n, length, red,
                       int(f[3]), int(f[4]), int(f[5]), int(f[7]) & 1))
    points.sort()
    active = [q for q in points if q[0] <= t] or points[:1]
    sv, heard = 1.0, None
    for time, _o, _n, length, red, sample_set, index, volume, kiai in active:
        sv = 1.0 if red else (-100.0 / length if length < 0 else sv)
        heard = (sample_set, index, volume, kiai)
    return (round(sv, 9),) + heard


# ---------------------------------------------------------------------------
# v3 precision engine
# ---------------------------------------------------------------------------

def _drum_track(path: Path, sections, duration: float = 24.0, sr: int = 44100,
                hats: bool = True, seed: int = 7) -> list[tuple[float, float]]:
    """Kick/snare/hat pattern with a known grid. Returns [(start_s, bpm)]."""
    import soundfile as sf
    rng = np.random.default_rng(seed)

    def kick():
        n = int(0.18 * sr)
        t = np.arange(n) / sr
        sweep = 2 * np.pi * np.cumsum(120 * np.exp(-t / 0.03) + 45) / sr
        return (np.sin(sweep) * np.exp(-t / 0.055)
                + rng.standard_normal(n) * np.exp(-t / 0.0025) * 0.35).astype(np.float32)

    def snare():
        n = int(0.16 * sr)
        t = np.arange(n) / sr
        return ((rng.standard_normal(n) * np.exp(-t / 0.045)) * 0.7
                + np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.03) * 0.5).astype(np.float32) * 0.7

    def hat():
        n = int(0.05 * sr)
        t = np.arange(n) / sr
        return (rng.standard_normal(n) * np.exp(-t / 0.008)).astype(np.float32) * 0.28

    KICK, SNARE, HAT = kick(), snare(), hat()
    buffer = np.zeros(int(duration * sr) + sr, dtype=np.float32)

    def place(sample, at, gain=1.0):
        i = int(round(at))
        end = min(len(buffer), i + len(sample))
        if 0 <= i < end:
            buffer[i:end] += sample[:end - i] * gain

    truth, t, beat, si = [], sections[0][0], 0, 0
    truth.append((t, sections[0][1]))
    while t < duration:
        while si + 1 < len(sections) and t >= sections[si + 1][0] - 1e-9:
            si += 1
            truth.append((t, sections[si][1]))
            beat = 0
        step = 60.0 / sections[si][1]
        place(KICK if beat % 4 in (0, 2) else SNARE, t * sr, 1.0 if beat % 4 == 0 else 0.85)
        if hats:
            place(HAT, t * sr, 0.7)
            place(HAT, (t + step / 2) * sr, 0.5)
        t += step
        beat += 1
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), (buffer[:int(duration * sr)] / max(peak, 1e-9) * 0.9), sr)
    return truth


def _offset_error_ms(offset_ms: float, true_start_s: float, bpm: float) -> float:
    """Distance from a detected offset to the nearest true beat, in ms."""
    step = 60.0 / bpm
    d = (offset_ms / 1000.0 - true_start_s) / step
    return abs(d - round(d)) * step * 1000.0


def _grid_analysis(offsets_bpms):
    """A 30 s analysis at 120 BPM carrying the given (offset_ms, bpm) points."""
    points = [TimingPoint(float(ms), float(bpm), 0.9, n) for n, (ms, bpm) in enumerate(offsets_bpms)]
    return Analysis("synthetic.wav", 30.0, np.arange(60) * 0.5, np.full(60, 120.0), points,
                    HOP, 44100, 1.0, 120.0, 1.0, "4/4", np.zeros(4000, dtype=np.float32))


def _accented_attacks(segments, start=0.5):
    """Attack times and weights: a heavy downbeat, light beats. segments = [(bpm, bars, beats)]."""
    times, weights, t = [], [], start
    for bpm, bars, beats in segments:
        for _bar in range(bars):
            for b in range(beats):
                times.append(t)
                weights.append(1.0 if b == 0 else 0.25)
                t += 60.0 / bpm
    return np.asarray(times), np.asarray(weights)


def _accented_track(path: Path, segments, sr: int = 44100) -> None:
    """Kick-like thump on every downbeat, a quiet tick on the other beats."""
    import soundfile as sf
    times, weights = _accented_attacks(segments)
    buffer = np.zeros(int((times[-1] + 2.0) * sr), dtype=np.float32)
    n = int(0.12 * sr)
    tt = np.arange(n) / sr
    rng = np.random.default_rng(5)
    thump = (np.sin(2 * np.pi * 60 * tt) * np.exp(-tt / 0.05)
             + rng.standard_normal(n) * np.exp(-tt / 0.004) * 0.4).astype(np.float32)
    for t, w in zip(times, weights):
        i = int(round(t * sr))
        buffer[i:i + n] += thump[:len(buffer) - i] * w
    sf.write(str(path), buffer / np.max(np.abs(buffer)) * 0.9, sr)


def _validation_analysis(points, duration=60.0) -> Analysis:
    beats = np.arange(0.5, duration, 0.4)
    return Analysis(
        source="test", duration=duration, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=list(points),
        hop_length=512, sample_rate=22050, subdivision=1.0,
        global_bpm=150.0, stability=0.9,
        onset=np.zeros(100, dtype=np.float32), engine="precision",
        fit_residual_ms=0.4)


_MAP_OSU = "\n".join([
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "",
    "[TimingPoints]",
    "// a comment line",
    "1000,400,4,1,0,100,1,0",
    "2000,-50,4,2,0,100,0,0",
    "3000,500",
    "4000.5,333.333333333333,4,1,0,100,1,0",
    "oops,not-a-line",
    "",
    "[HitObjects]",
    "",
])


def _write_osu(tmp: str, text: str, name: str = "map.osu") -> str:
    target = str(Path(tmp) / name)
    Path(target).write_text(text, encoding="utf-8")
    return target


def _compare_analysis(points, duration=60.0) -> Analysis:
    beats = np.arange(0.5, duration, 0.4)
    return Analysis(
        source="test", duration=duration, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=list(points),
        hop_length=512, sample_rate=22050, subdivision=1.0)


_FULL_OSU = "\n".join([
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "AudioLeadIn: 0",
    "Mode: 0",
    "CustomTag: keep me",
    "",
    "[Editor]",
    "Bookmarks: 1000,2000",
    "",
    "[Metadata]",
    "Title:Test",
    "Artist:Me",
    "Creator:Mapper",
    "Version:Hard",
    "",
    "[Difficulty]",
    "HPDrainRate:5",
    "CircleSize:4",
    "",
    "[Events]",
    "//Background and Video events",
    '0,0,"bg.jpg",0,0',
    "",
    "[TimingPoints]",
    "1000,400,4,1,0,100,1,0",
    "2000,-100,4,2,0,100,0,0",
    "",
    "[Colours]",
    "Combo1 : 255,0,0",
    "",
    "[HitObjects]",
    "256,192,1000,1,0,0:0:0:0:",
    "100,100,2000,2,0,B|150:150|200:100,2,120.5,2|1,0:0|0:0,0:0:0:0:",
    "256,192,5000,8,0,8000,0:0:0:0:",
    "192,192,9000,132,0,9500:0:0:0:0:",
    "broken,line",
    "",
])


_CONTEXT_OSU = "\n".join([
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "",
    "[Difficulty]",
    "SliderMultiplier:1.0",
    "",
    "[TimingPoints]",
    "1000,400,4,1,0,100,1,0",
    "",
    "[HitObjects]",
    "64,192,1000,5,0,0:0:0:0:",
    "80,192,1100,1,0,0:0:0:0:",
    "96,192,1200,1,2,2:0:0:25:",
    "400,100,1400,5,0,0:0:0:0:",
    "100,300,5000,1,0,0:0:0:0:",
    "256,192,8000,8,0,9000,0:0:0:0:",
    "",
])


def _alignment_analysis(times, weights) -> Analysis:
    beats = np.arange(0.5, 60.0, 0.4)
    return Analysis(
        source="test", duration=60.0, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=[],
        hop_length=512, sample_rate=22050, subdivision=1.0,
        attack_times=np.asarray(times, dtype=float),
        attack_weights=np.asarray(weights, dtype=float))


def _context_beatmap(tmp: str, text: str = _CONTEXT_OSU):
    target = Path(tmp) / "map.osu"
    target.write_text(text, encoding="utf-8")
    return read_osu_beatmap(target)


def _reds_map(reds) -> dict:
    return {"timing": {"reds": list(reds), "greens": []}}


def _mapset_osu(version: str, audio: str = "song.mp3", reds=((1000, 400.0, 4), (30000, 300.0, 4)),
                lead_in: str | None = "0", preview: str | None = "12000",
                tags: str = "drum bass electronic", kiai=(), objects=()) -> str:
    """A small but complete difficulty, CRLF like the osu! editor writes."""
    lines = ["osu file format v14", "", "[General]", f"AudioFilename: {audio}"]
    if lead_in is not None:
        lines.append(f"AudioLeadIn: {lead_in}")
    if preview is not None:
        lines.append(f"PreviewTime: {preview}")
    lines += ["", "[Metadata]", "Title:Song", "TitleUnicode:Song", "Artist:Band",
              "ArtistUnicode:Band", "Creator:Mapper", f"Version:{version}", "Source:",
              f"Tags:{tags}", "", "[TimingPoints]"]
    lines += [f"{offset},{beat!r},{meter},2,0,60,1,0" for offset, beat, meter in reds]
    lines += [f"{time},-100,4,2,0,60,0,{1 if on else 0}" for time, on in kiai]
    lines += ["", "[HitObjects]"]
    lines += [f"256,192,{time},1,0,0:0:0:0:" for time in objects]
    return "\r\n".join(lines) + "\r\n"


def _run_cli(argv, analysis=None):
    """main() on ``argv`` -> (exit code, stdout, stderr).

    The analysis is stubbed with ``analysis`` when given (a function stands in
    for analyze_audio itself).
    """
    import contextlib
    import io
    import sys
    from unittest import mock
    import overtone
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(sys, "argv", ["overtone.py", *argv]))
        if callable(analysis):
            stack.enter_context(mock.patch.object(overtone, "analyze_audio", analysis))
        elif analysis is not None:
            stack.enter_context(mock.patch.object(overtone, "analyze_audio",
                                                  return_value=analysis))
        stack.enter_context(contextlib.redirect_stdout(out))
        stack.enter_context(contextlib.redirect_stderr(err))
        try:
            main()
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


def _eighths(bpm=150.0, start=1.0, stop=61.0, jitter_ms=1.5, seed=1):
    """Attacks on the 8ths of a steady grid, beats twice as loud, a little jitter."""
    beat = 60.0 / bpm
    times = np.arange(start, stop, beat / 2)
    weights = np.where(np.arange(times.size) % 2 == 0, 1.0, 0.5)
    times = times + np.random.default_rng(seed).normal(0.0, jitter_ms / 1000.0, times.size)
    return times, weights


def _structure_report(bounds, kinds, groups, levels, duration=64.0, energy=None):
    """``overtone-cli structure``'s JSON for hand-made sections."""
    edges = [0.0] + list(bounds) + [duration]
    repeats = [groups.count(g) for g in groups]
    return {"duration": duration, "boundaries": list(bounds),
            "sections": [{"start_s": edges[i], "end_s": edges[i + 1], "kind": kinds[i],
                          "group": groups[i], "repeats": repeats[i], "level_db": levels[i]}
                         for i in range(len(kinds))],
            "energy": list(energy if energy is not None else np.linspace(0.1, 1.0, 128)),
            "energy_hop": 0.5,
            "rules": {"window_s": 0.5, "edge_blind_s": 4.0, "intro_max_s": 12.0},
            "timings_s": {"structure": 0.1, "classify": 0.1}}


_SOUND_MAP = """osu file format v14

[General]
AudioFilename: audio.mp3
SampleSet: Soft

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
0,500,4,0,0,70,1,0
2000,-50,4,3,2,40,0,0

[HitObjects]
256,192,1000,1,8,0:0:0:0:
256,192,1500,1,2,1:2:0:0:
256,192,1995,1,4,0:0:0:0:
256,192,2500,2,0,L|356:192,1,140,4|8,0:0|3:1,0:0:0:0:
256,192,3000,2,2,L|326:192,2,70
256,192,4000,12,4,5000,0:0:0:0:
256,192,6000,1,0,0:0:0:0:hit.wav
64,192,7000,128,2,7500:0:0:0:0:
bad line
"""


def _copy_map(objects, timing="0,500,4,2,0,70,1,0", sample_set="Soft"):
    return (f"osu file format v14\n\n[General]\nAudioFilename: audio.mp3\nSampleSet: {sample_set}\n\n"
            "[Difficulty]\nSliderMultiplier:1.4\n\n"
            f"[TimingPoints]\n{timing}\n\n[HitObjects]\n" + "\n".join(objects) + "\n")
