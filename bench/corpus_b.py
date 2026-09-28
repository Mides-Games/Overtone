"""Corpus B: the engine against hand-timed ranked maps (Phase 10.0).

Corpus A, the 24 synthetic fixtures of ``benchmark.py``, has exact truth and
clean drums. Corpus B is the opposite: 20 ranked or loved maps from the
user's own osu! Songs folder, listed in ``bench/corpus_b.json`` by folder,
file name and SHA-1, across the six categories of
``docs/10-precision-plan.md``. Their truth is a mapper's red lines. The audio
is copyrighted and never committed; a track whose files are missing or no
longer hash the same is skipped and named, never guessed at.

    python bench/corpus_b.py                     # Python v3 engine, cached
    python bench/corpus_b.py --engine rust       # overtone-cli (OVERTONE_CLI)
    python bench/corpus_b.py --only vampires     # some tracks
    python bench/corpus_b.py --refresh --jobs 3  # analyse again, three at once
    python bench/corpus_b.py --onsets            # and where each track's sound starts

The question, per red line of the map: does the timing Overtone would export
(whole-millisecond offsets, as the app writes them) put a beat within 5 ms
of it? The detected red line in force there (the last one at or before it,
with half a map beat of slack, as ``benchmark.py`` scores) is run forwards
or backwards to the map's line, and the signed gap to its nearest beat is
the error: positive when Overtone's beat comes later. A grid read an octave
or two slow is split to the map's beat first, so the octave is judged on its
own (as a count) and not twice. A refused track misses every line. Reported:

- the share of red lines within 2, 5, 10 and 50 ms, pooled over every line
  and as the mean of the tracks (the four drift maps hold most of the lines);
- the signed error's median, quartiles and worst: real audio reads about
  24 ms late against ranked maps, most of it the maps' own lines sitting
  before the sound (``--onsets``), and that is reported as it is, never
  subtracted from the headline;
- per map section, the detected BPM against the map's, octave-normalised,
  and how many sections were read at another octave;
- all of it per category, with each analysis's time.

``--onsets`` also reads where each track's sound itself starts, against the
map's beats and against Overtone's: the energy above 4 kHz averaged over
each grid's beats, and the point where that average first holds 10 % of its
rise. It decodes every track (about a minute) and splits the late reading
into what the map's lines do and what the engine does.

Analyses are cached in ``bench/.cache/corpus_b/`` (git-ignored), keyed by
the audio's hash and the hash of the engine code that produced them, so a
re-score is instant and an engine change is never served a stale answer.
The summary is written as JSON beside them unless ``--json`` says where.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import overtone as ta  # noqa: E402

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "corpus_b.json"
CACHE_DIR = HERE / ".cache" / "corpus_b"
SONGS = Path(r"C:\osu!\Songs")
ENGINES = ("python", "rust")

#: The plan's bars (5, 10 and 50 ms) and a tighter one.
TOLERANCES_MS = (2.0, 5.0, 10.0, 50.0)
HEADLINE_MS = 5.0
#: The benchmark's BPM bar, and the gap past which compare_map_timing calls
#: a map and a detection different tempi.
BPM_TOLERANCES = (0.05, 1.0)
#: Bumped when the cached analysis changes shape.
CACHE_FORMAT = 3
#: v3's refusals: no BPM rather than a guess. The Rust engine refuses with
#: SidecarRefused. Any other exception is an error, and is reported as one.
V3_REFUSALS = ("Not enough beats detected", "No rhythmic pulse found",
               "Detected tempo is outside the usable range", "No steady pulse could be fitted")


# ---------------------------------------------------------------------------
# Scoring: pure functions of red lines, (offset_ms, bpm) pairs
# ---------------------------------------------------------------------------

def governing(detected: list[tuple[float, float]], offset_ms: float,
              map_beat_ms: float) -> int:
    """The detected red line in force at a map red line: the last one at or
    before it, with half a map beat of slack, so a change found a hair late
    still counts as that change; the first line when none comes before, as
    osu! runs the first red line backwards."""
    index = 0
    for n, (start, _bpm) in enumerate(detected):
        if start <= offset_ms + 0.5 * map_beat_ms:
            index = n
    return index


def octave_of(det_bpm: float, map_bpm: float) -> float:
    """The power of two nearest the detected-to-map BPM ratio (1 = same)."""
    return 2.0 ** round(math.log2(det_bpm / map_bpm))


def grid_error_ms(offset_ms: float, map_bpm: float, det_offset_ms: float,
                  det_bpm: float) -> float:
    """Signed distance from a map red line to the nearest beat of a detected
    grid; positive when the detected beat comes after the line.

    A grid read an octave or two slower than the map is split to the map's
    beat first, which is where its half beats already fall; a faster one is
    used as it is.
    """
    map_beat = 60000.0 / map_bpm
    det_beat = 60000.0 / det_bpm
    step = det_beat / 2 ** max(0, round(math.log2(det_beat / map_beat)))
    beats = round((offset_ms - det_offset_ms) / step)
    return det_offset_ms + beats * step - offset_ms


def score_track(map_reds: list[tuple[float, float]],
                detected: list[tuple[float, float]]) -> list[dict]:
    """One row per map red line: the detected line in force there, the
    signed grid error, and the octave-normalised BPM error of its section.
    With nothing detected, every error is None: a miss, not a zero."""
    rows = []
    for offset, bpm in map_reds:
        row = {"offset_ms": offset, "bpm": bpm, "line": None, "error_ms": None,
               "bpm_error": None, "octave": None}
        if detected:
            n = governing(detected, offset, 60000.0 / bpm)
            det_offset, det_bpm = detected[n]
            octave = octave_of(det_bpm, bpm)
            row.update(line=n, error_ms=grid_error_ms(offset, bpm, det_offset, det_bpm),
                       bpm_error=abs(det_bpm / octave - bpm), octave=octave)
        rows.append(row)
    return rows


def quartiles(values: list[float]) -> dict | None:
    """Median and quartiles (the medians of each half); None when empty."""
    if not values:
        return None
    ordered = sorted(values)
    half = len(ordered) // 2
    lower, upper = ordered[:half], ordered[len(ordered) - half:]
    return {"n": len(ordered), "median": statistics.median(ordered),
            "q1": statistics.median(lower) if lower else ordered[0],
            "q3": statistics.median(upper) if upper else ordered[-1]}


def tally(rows: list[dict], shift_ms: float = 0.0) -> dict:
    """What a set of rows says: shares within each bar, the signed error,
    BPM agreement and octaves. ``shift_ms`` is subtracted from every error
    first; only the labelled diagnostic passes anything but 0."""
    lines = len(rows)
    errors = [r["error_ms"] for r in rows if r["error_ms"] is not None]
    within = {f"{tol:g}": sum(abs(e - shift_ms) <= tol for e in errors)
              for tol in TOLERANCES_MS}
    bpm_errors = [r["bpm_error"] for r in rows if r["bpm_error"] is not None]
    octaves = Counter(f"x{r['octave']:g}" for r in rows if r["octave"] is not None)
    return {
        "lines": lines,
        "undetected": lines - len(errors),
        "within": within,
        "share": {k: (v / lines if lines else None) for k, v in within.items()},
        "error_ms": quartiles(errors),
        "abs_error_ms": quartiles([abs(e) for e in errors]),
        "worst_error_ms": max((abs(e) for e in errors), default=None),
        "near_error_ms": quartiles([e for e in errors if abs(e) <= max(TOLERANCES_MS)]),
        "bpm_within": {f"{tol:g}": sum(e <= tol for e in bpm_errors) for tol in BPM_TOLERANCES},
        "bpm_error": quartiles(bpm_errors),
        "worst_bpm_error": max(bpm_errors, default=None),
        "octaves": dict(sorted(octaves.items())),
    }


def aggregate(tracks: list[dict]) -> dict:
    """Every line pooled, and beside it the tracks' own shares averaged, so
    one song's 236 red lines do not stand for twenty songs."""
    summary = tally([row for t in tracks for row in t["rows"]])
    summary["tracks"] = len(tracks)
    shares = [t["tally"]["share"] for t in tracks if t["tally"]["lines"]]
    summary["track_mean_share"] = {
        key: sum(s[key] for s in shares) / len(shares) if shares else None
        for key in summary["share"]}
    return summary


# ---------------------------------------------------------------------------
# Where the sound starts (--onsets): the late reading taken apart
# ---------------------------------------------------------------------------

#: A click, a snare and a hat all start at their first sample above this,
#: where a kick's body or a bass swells for milliseconds.
ONSET_HIGHPASS_HZ = 4000.0
#: Each beat's window, before and after the beat, in seconds.
ONSET_WINDOW_S = (0.100, 0.150)
#: The sound starts where the average first holds this share of its rise.
ONSET_RISE = 0.10


def grid_beats(lines: list[tuple[float, float]], duration_s: float) -> list[float]:
    """Beat times (s) of red lines ``(offset_ms, bpm)``: each line's beats up
    to the next line, the first line run back to 0 s, as osu! runs it."""
    beats = []
    for n, (offset, bpm) in enumerate(lines):
        step = 60000.0 / bpm
        end = lines[n + 1][0] if n + 1 < len(lines) else duration_s * 1000.0
        k = -math.floor(offset / step) if n == 0 else 0
        while offset + k * step < end:
            beats.append((offset + k * step) / 1000.0)
            k += 1
    return beats


def high_band_energy(y, sr: int) -> np.ndarray:
    """Energy above ONSET_HIGHPASS_HZ, filtered forwards and backwards and
    averaged over a centred millisecond, so that it adds no lag of its own."""
    sos = signal.butter(4, ONSET_HIGHPASS_HZ, "highpass", fs=sr, output="sos")
    band = signal.sosfiltfilt(sos, np.asarray(y, dtype=np.float64))
    width = int(round(0.001 * sr)) | 1
    return np.convolve(band * band, np.ones(width) / width, mode="same")


def sound_start_ms(energy: np.ndarray, sr: int, beats) -> dict | None:
    """Where the sound starts against ``beats``, in ms, + when after them.

    Each beat's window of ``energy`` is scaled to its own peak, so a loud bar
    does not outvote a quiet one, and the windows are averaged. The start is
    the last point before the average's peak (from 40 ms before the beat to
    100 ms after) at or under ONSET_RISE of its rise from the level before the
    beat (the median 100 to 40 ms before). ``contrast`` is that peak over that
    level: how clear the average is. None when no beat has a whole window.
    """
    before, after = (int(round(s * sr)) for s in ONSET_WINDOW_S)
    total = np.zeros(before + after)
    count = 0
    for beat in beats:
        i = int(round(beat * sr))
        if i < before or i + after > len(energy):
            continue
        window = energy[i - before:i + after]
        peak = float(window.max())
        if peak > 0:
            total += window / peak
            count += 1
    if not count:
        return None
    mean = total / count
    t = (np.arange(before + after) - before) / sr
    floor = float(np.median(mean[(t >= -0.100) & (t <= -0.040)]))
    zone = np.flatnonzero((t >= -0.040) & (t <= 0.100))
    top = int(zone[np.argmax(mean[zone])])
    level = floor + ONSET_RISE * (float(mean[top]) - floor)
    below = np.flatnonzero(mean[:top + 1] <= level)
    start = float(t[below[-1]]) if below.size else float(t[0])
    return {"start_ms": 1000.0 * start, "contrast": float(mean[top]) / max(floor, 1e-12),
            "beats": count}


def measure_onsets(found: list[tuple[dict, Path]], analyses: dict[str, dict]) -> dict:
    """--onsets: per track, where the sound starts after the map's beats and
    after Overtone's, read from the audio itself (``sound_start_ms``)."""
    print("\nwhere the sound starts, + when after the beat (energy above "
          f"{ONSET_HIGHPASS_HZ / 1000:g} kHz, {ONSET_RISE:.0%} of its rise; c: its contrast):")
    print(f"  {'track':<18} {'audio':<8} {'after the map':>16} {'after Overtone':>16}")
    rows = []
    for track, folder in found:
        audio = folder / track["audio"]
        y, sr = ta._load_audio(audio, lambda _message: None)
        energy = high_band_energy(y, sr)
        duration = len(y) / sr
        kind = audio.suffix.lower().lstrip(".")
        if kind == "mp3" and ta.mp3_gapless_info(audio).get("present"):
            kind = "mp3 LAME"
        on_map = sound_start_ms(energy, sr, grid_beats(
            ta.read_osu_red_lines(folder / track["osu"]), duration))
        lines = [(line[0], line[1]) for line in analyses[track["id"]]["lines"]]
        on_overtone = sound_start_ms(energy, sr, grid_beats(lines, duration)) if lines else None
        rows.append({"id": track["id"], "audio": kind, "map": on_map, "overtone": on_overtone})
        cells = [f"{r['start_ms']:+6.1f} (c {r['contrast']:4.1f})" if r else f"{'-':>16}"
                 for r in (on_map, on_overtone)]
        print(f"  {track['id']:<18} {kind:<8} {cells[0]:>16} {cells[1]:>16}", flush=True)
    summary = {}
    for side in ("map", "overtone"):
        for kind in ("all", "mp3 LAME", "mp3", "ogg"):
            values = [r[side]["start_ms"] for r in rows
                      if r[side] and kind in ("all", r["audio"])]
            if values:
                summary.setdefault(side, {})[kind] = quartiles(values)
    for side, label in (("map", "the map's beats"), ("overtone", "Overtone's beats")):
        if side in summary:
            parts = ", ".join(f"{kind} {q['median']:+.1f} ({q['n']})"
                              for kind, q in summary[side].items() if kind != "all")
            q = summary[side]["all"]
            print(f"  after {label}: median {q['median']:+.1f} ms, IQR {q['q1']:+.1f}..{q['q3']:+.1f} "
                  f"over {q['n']} tracks; {parts}")
    return {"tracks": rows, "summary": summary}


# ---------------------------------------------------------------------------
# Files: find each track, refuse any that changed
# ---------------------------------------------------------------------------

def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hashes_match(folder: Path, track: dict) -> str | None:
    """None when both files are there with the manifest's hashes; else why not."""
    osu, audio = folder / track["osu"], folder / track["audio"]
    if not osu.is_file():
        return f"no {track['osu']}"
    if not audio.is_file():
        return f"no {track['audio']}"
    if sha1_file(osu) != track["sha1_osu"]:
        return "the .osu changed (SHA-1 differs)"
    if sha1_file(audio) != track["sha1_audio"]:
        return "the audio changed (SHA-1 differs)"
    return None


def locate(track: dict, songs: Path) -> dict:
    """The track's files, verified. A set downloaded again can land in
    another folder ('123 Artist - Title (1)'): one with the same set ID and
    both files hashing the same is the same track. Anything else is skipped."""
    primary = songs / track["folder"]
    problem = _hashes_match(primary, track)
    if problem is None:
        return {"ok": True, "folder": primary}
    others = []
    if not primary.is_dir():
        prefix = f"{track['set_id']} "
        try:
            with os.scandir(songs) as entries:
                others = sorted(Path(e.path) for e in entries
                                if e.is_dir() and e.name.startswith(prefix))
        except OSError:
            others = []
        for folder in others:
            if _hashes_match(folder, track) is None:
                return {"ok": True, "folder": folder}
        problem = "folder not found" + (f" ({len(others)} other folder(s) of the set "
                                        "do not hold the same files)" if others else "")
    return {"ok": False, "reason": problem}


# ---------------------------------------------------------------------------
# Analyses, cached per audio hash and engine code
# ---------------------------------------------------------------------------

def engine_fingerprint(engine: str, cli: Path | None) -> str:
    """The code that produced an analysis: overtone.py writes the red lines
    for both engines; the Rust engine adds its bridge and its binary."""
    files = [ROOT / "overtone.py"]
    if engine == "rust":
        files += [ROOT / "overtone_rust.py", cli]
    digest = hashlib.sha1(f"corpus_b cache {CACHE_FORMAT}".encode())
    for path in files:
        digest.update(sha1_file(path).encode())
    return digest.hexdigest()[:16]


def exported_lines(analysis) -> list[list[float]]:
    """The red lines the app would write, [offset_ms, bpm, meter], read back
    from ``osu_timing_text``: whole-millisecond offsets, as exported."""
    lines = []
    for line in ta.osu_timing_text(analysis).splitlines():
        if line.startswith("//"):
            continue
        fields = line.split(",")
        lines.append([float(fields[0]), 60000.0 / float(fields[1]), int(fields[2])])
    return lines


def octave_margin(analysis) -> float | None:
    """The weakest section's octave margin, or None when there is none to read.

    ``analysis_evidence`` reports it per section: the seeded candidate's
    coherence less the strongest an octave away. The smallest over the
    sections is what a verdict has to stand on, since one section read an
    octave out is a wrong answer for the whole track.
    """
    try:
        evidence = ta.analysis_evidence(analysis)
    except Exception:  # noqa: BLE001 -- evidence is a report, never a blocker
        return None
    margins = [s["octave_margin"] for s in evidence.get("sections", [])
               if s.get("octave_margin") is not None]
    return min(margins) if margins else None


def analyse(audio: str, engine: str, cli: str | None) -> dict:
    """Run one engine on one file. Never raises: a refusal or an error is an
    answer, recorded with the engine's own message."""
    started = time.perf_counter()
    result: dict = {"lines": [], "path": None, "message": None}
    try:
        if engine == "rust":
            import overtone_rust
            analysis = overtone_rust.analyze(audio, cli=Path(cli))
        else:
            analysis = ta.analyze_audio(audio)
        result.update(lines=exported_lines(analysis), path=str(analysis.engine),
                      global_bpm=float(analysis.global_bpm),
                      attacks=int(len(analysis.attack_times)),
                      duration_s=float(analysis.duration),
                      # What the engine says about its own answer, kept beside
                      # what the mapper says about it: the two together are
                      # what calibrates a verdict the app can show.
                      residual_ms=float(analysis.fit_residual_ms),
                      stability=float(analysis.stability),
                      sections=int(len(analysis.sections)),
                      confidence=(min((p.confidence for p in analysis.points), default=0.0)),
                      # The weakest section's octave margin: how much better
                      # the seeded grid cohered than the best grid an octave
                      # away. A grid read at twice the tempo fits beautifully,
                      # so residual and stability cannot see that mistake and
                      # this is the only number that can.
                      octave_margin=octave_margin(analysis))
    except Exception as exc:  # noqa: BLE001 - every failure is reported, none hidden
        refused = type(exc).__name__ == "SidecarRefused" or (
            isinstance(exc, ValueError) and str(exc).startswith(V3_REFUSALS))
        result.update(path="refused" if refused else "error",
                      message=f"{type(exc).__name__}: {exc}")
    result["seconds"] = round(time.perf_counter() - started, 2)
    return result


def run_analyses(todo: list[tuple[dict, str]], engine: str, cli: Path | None, jobs: int):
    """Each (track, analysis) as it finishes, in manifest order, with a line
    of progress: a whole corpus takes minutes, and silence reads as a hang."""
    audios = [audio for _track, audio in todo]
    args = (audios, [engine] * len(audios), [str(cli) if cli else None] * len(audios))
    pool = ProcessPoolExecutor(max_workers=jobs) if jobs > 1 and len(audios) > 1 else None
    try:
        results = (pool.map if pool else map)(analyse, *args)
        for (track, _audio), result in zip(todo, results):
            print(f"  {track['id']:<18} {result['path']:<9} {result['seconds']:7.1f} s", flush=True)
            yield track, result
    finally:
        if pool:
            pool.shutdown()


def cache_path(engine: str, track: dict, fingerprint: str) -> Path:
    return CACHE_DIR / f"{engine}-{track['id']}-{track['sha1_audio'][:12]}-{fingerprint}.json"


def read_cache(path: Path) -> dict | None:
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return cached if cached.get("format") == CACHE_FORMAT else None


def write_cache(path: Path, analysis: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".part")
    temp.write_text(json.dumps({"format": CACHE_FORMAT, **analysis}, indent=1), encoding="utf-8")
    os.replace(temp, path)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def _pct(value: float | None, digits: int = 1) -> str:
    return "-" if value is None else f"{100.0 * value:.{digits}f}"


def print_report(engine: str, tracks: list[dict], skipped: list[dict],
                 categories: dict, summary: dict) -> None:
    head = (f"{'track':<18} {'category':<12} {'path':<9} {'lines':>5} {'det':>4} "
            f"{'<=2':>4} {'<=5':>4} {'<=10':>4} {'<=50':>4} {'median':>7} {'IQR':>15} "
            f"{'BPM<=.05':>8} {'dBPM':>6} {'octave':>13} {'s':>6}")
    print(head)
    print("-" * len(head))
    for t in tracks:
        s = t["tally"]
        err = s["error_ms"]
        median = "-" if err is None else f"{err['median']:+.1f}"
        iqr = "-" if err is None else f"{err['q1']:+.1f}..{err['q3']:+.1f}"
        sections = s["lines"] - s["undetected"]
        bpm_ok = (f"{s['bpm_within']['0.05']}/{sections}" if sections else "-")
        dbpm = "-" if s["bpm_error"] is None else f"{s['bpm_error']['median']:.2f}"
        octaves = ",".join(f"{k}:{v}" for k, v in s["octaves"].items() if k != "x1") or "-"
        print(f"{t['id']:<18} {t['category']:<12} {t['path']:<9} {s['lines']:>5} "
              f"{t['detected']:>4} {_pct(s['share']['2'], 0):>4} {_pct(s['share']['5'], 0):>4} "
              f"{_pct(s['share']['10'], 0):>4} {_pct(s['share']['50'], 0):>4} "
              f"{median:>7} {iqr:>15} {bpm_ok:>8} {dbpm:>6} {octaves:>13} {t['seconds']:>6.1f}")
    for t in skipped:
        print(f"{t['id']:<18} {t['category']:<12} SKIPPED: {t['reason']}")
    print("path: the engine's own path (refused: no BPM given); lines: the map's red lines; "
          "det: Overtone's.\n<=N: % of the map's red lines with an Overtone beat within N ms; "
          "median, IQR: the signed error in ms,\n+ when Overtone is later; BPM<=.05 and dBPM: "
          "map sections within 0.05 BPM, and the median |error|,\noctave-normalised; octave: "
          "sections read at another octave; s: the analysis's seconds.")

    print("\nper category: % of red lines within 2 / 5 / 10 / 50 ms, pooled "
          "(mean of the tracks); signed error median [IQR]")
    for name, s in categories.items():
        err = s["error_ms"]
        spread = "-" if err is None else f"{err['median']:+.1f} [{err['q1']:+.1f}..{err['q3']:+.1f}]"
        shares = " / ".join(f"{_pct(s['share'][f'{tol:g}'])} ({_pct(s['track_mean_share'][f'{tol:g}'])})"
                            for tol in TOLERANCES_MS)
        print(f"  {name:<12} {s['tracks']:>2} tracks {s['lines']:>5} lines  {shares}  {spread}")

    s = summary["all"]
    err, near = s["error_ms"], s["near_error_ms"]
    sections = s["lines"] - s["undetected"]
    print(f"\nCorpus B, {engine} engine: {s['tracks']} tracks scored, {len(skipped)} skipped; "
          f"{s['lines']} red lines, {s['undetected']} with nothing detected")
    for tol in TOLERANCES_MS:
        key = f"{tol:g}"
        mark = "  <- headline" if tol == HEADLINE_MS else ""
        print(f"  within {tol:>4g} ms   {_pct(s['share'][key]):>5} % of the red lines   "
              f"{_pct(s['track_mean_share'][key]):>5} % per track (mean){mark}")
    if err is not None:
        print(f"  signed error   median {err['median']:+.1f} ms, IQR {err['q1']:+.1f}..{err['q3']:+.1f}; "
              f"|error| median {s['abs_error_ms']['median']:.1f}, worst {s['worst_error_ms']:.1f} "
              f"(all {err['n']} lines)")
    if near is not None:
        print(f"                 median {near['median']:+.1f} ms, IQR {near['q1']:+.1f}..{near['q3']:+.1f} "
              f"(the {near['n']} lines within {max(TOLERANCES_MS):g} ms)")
        per_track = summary["track_median_error_ms"]
        formats = ", ".join(f"{fmt} {q['median']:+.1f} ({q['n']})"
                            for fmt, q in per_track.items() if fmt != "all")
        print(f"                 median {per_track['all']['median']:+.1f} ms over the "
              f"{per_track['all']['n']} tracks' own medians of those lines; {formats}")
    if s["bpm_error"] is not None:
        print(f"  BPM, per map section (octave-normalised): {s['bpm_within']['0.05']}/{sections} within "
              f"0.05, {s['bpm_within']['1']}/{sections} within 1, median |error| "
              f"{s['bpm_error']['median']:.3f}, worst {s['worst_bpm_error']:.2f}")
    octaves = ", ".join(f"{k} {v}" for k, v in s["octaves"].items()) or "-"
    print(f"  octave of each section's reading against the map: {octaves}")
    diag = summary.get("diagnostic")
    if diag:
        print(f"  diagnostic only, not a result: less the median error of the lines within "
              f"{max(TOLERANCES_MS):g} ms ({diag['shift_ms']:+.1f} ms), {_pct(diag['share_5'])} % "
              f"would be within 5 ms")
    print(f"  analysis time {summary['analysis_seconds']:.0f} s "
          f"({summary['cached']} of {s['tracks']} from the cache); run {summary['run_seconds']:.1f} s")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", choices=ENGINES, default="python")
    parser.add_argument("--songs", default=str(SONGS), help="the osu! Songs folder (read only)")
    parser.add_argument("--manifest", default=str(MANIFEST))
    parser.add_argument("--only", nargs="*", metavar="ID", help="score just these tracks")
    parser.add_argument("--refresh", action="store_true", help="analyse again, ignoring the cache")
    parser.add_argument("--jobs", type=int, default=1, help="analyses at once (each can take ~2 GB)")
    parser.add_argument("--onsets", action="store_true",
                        help="also read where each track's sound starts against the map's beats "
                             "and Overtone's (decodes every track again)")
    parser.add_argument("--cli", help="overtone-cli binary (default: OVERTONE_CLI, then the build)")
    parser.add_argument("--json", help="where to write the summary "
                                       "(default: bench/.cache/corpus_b/summary-<engine>.json)")
    args = parser.parse_args(argv)
    run_started = time.perf_counter()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    tracks = manifest["tracks"]
    if args.only:
        unknown = sorted(set(args.only) - {t["id"] for t in tracks})
        if unknown:
            print(f"Unknown track(s): {', '.join(unknown)}")
            return 2
        tracks = [t for t in tracks if t["id"] in args.only]

    cli = None
    if args.engine == "rust":
        import overtone_rust
        cli = Path(args.cli) if args.cli else overtone_rust.find_cli()
        if cli is None or not cli.is_file():
            print("No overtone-cli: set OVERTONE_CLI, pass --cli, or build it with "
                  "cargo build --release -p overtone-cli")
            return 2
    fingerprint = engine_fingerprint(args.engine, cli)

    songs = Path(args.songs)
    found, skipped = [], []
    for track in tracks:
        where = locate(track, songs)
        if where["ok"]:
            found.append((track, where["folder"]))
        else:
            skipped.append({"id": track["id"], "category": track["category"],
                            "reason": where["reason"]})

    analyses: dict[str, dict] = {}
    todo = []
    for track, folder in found:
        cached = None if args.refresh else read_cache(cache_path(args.engine, track, fingerprint))
        if cached is not None:
            analyses[track["id"]] = {**cached, "cached": True}
        else:
            todo.append((track, str(folder / track["audio"])))
    if todo:
        print(f"analysing {len(todo)} track(s) with the {args.engine} engine"
              f"{f', {args.jobs} at a time' if args.jobs > 1 else ''}:", flush=True)
    for track, result in run_analyses(todo, args.engine, cli, args.jobs):
        if result["path"] != "error":
            write_cache(cache_path(args.engine, track, fingerprint), result)
        analyses[track["id"]] = {**result, "cached": False}

    scored = []
    for track, folder in found:
        analysis = analyses[track["id"]]
        map_reds = ta.read_osu_red_lines(folder / track["osu"])
        detected = [(line[0], line[1]) for line in analysis["lines"]]
        rows = score_track(map_reds, detected)
        scored.append({"id": track["id"], "category": track["category"],
                       "format": Path(track["audio"]).suffix.lower(),
                       "path": analysis["path"], "message": analysis.get("message"),
                       "detected": len(detected), "seconds": analysis["seconds"],
                       "cached": analysis["cached"], "tally": tally(rows), "rows": rows,
                       # The engine's own account of the answer, so a verdict
                       # shown in the app can be calibrated against the
                       # mapper's rather than guessed at.
                       "said": {key: analysis.get(key) for key in
                                ("residual_ms", "stability", "sections", "confidence",
                                 "attacks", "duration_s", "octave_margin")}})

    categories = {}
    for name in manifest["categories"]:
        members = [t for t in scored if t["category"] == name]
        if members:
            categories[name] = aggregate(members)
    summary = {"all": aggregate(scored)}
    near = summary["all"]["near_error_ms"]
    if near is not None:
        # How much of the gap one constant offset would close, read where the
        # grid is roughly right. Fitted on this corpus, so it flatters: shown
        # apart, never as the result.
        shifted = tally([row for t in scored for row in t["rows"]], shift_ms=near["median"])
        summary["diagnostic"] = {"shift_ms": near["median"], "share_5": shifted["share"]["5"]}
    # The late reading, a track at a time as the roadmap measured it (each
    # map's own median, then the median of the maps; Phase 22), and per
    # format, since the decoder is a suspect: MP3 and OGG are kept apart.
    medians: dict[str, list[float]] = {}
    for t in scored:
        near_track = t["tally"]["near_error_ms"]
        if near_track is not None:
            medians.setdefault("all", []).append(near_track["median"])
            medians.setdefault(t["format"], []).append(near_track["median"])
    summary["track_median_error_ms"] = {key: quartiles(values)
                                        for key, values in sorted(medians.items())}
    summary["analysis_seconds"] = sum(t["seconds"] for t in scored)
    summary["cached"] = sum(t["cached"] for t in scored)
    summary["run_seconds"] = time.perf_counter() - run_started

    print()
    print_report(args.engine, scored, skipped, categories, summary)
    errors = [t for t in scored if t["path"] == "error"]
    for t in errors:
        print(f"ERROR {t['id']}: {t['message']}")
    if args.onsets:
        summary["onsets"] = measure_onsets(found, analyses)

    out = Path(args.json) if args.json else CACHE_DIR / f"summary-{args.engine}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "engine": args.engine, "fingerprint": fingerprint,
        "run": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "manifest": {"version": manifest.get("version"), "tracks": len(manifest["tracks"])},
        "tolerances_ms": list(TOLERANCES_MS), "headline_ms": HEADLINE_MS,
        "summary": summary, "categories": categories, "skipped": skipped,
        "tracks": scored,
    }, indent=1), encoding="utf-8")
    print(f"  summary: {out}")
    return 1 if skipped or errors else 0


if __name__ == "__main__":
    sys.exit(main())
