"""Phase 10 timing stages: the engine against one slice of the Songs folder at a time.

single_bpm.py scores every one-red-line map at once. This scores the folder
in stages -- anime first, then bands whose drummers drift and change tempo --
so each stage gets its own baseline, its own fixes and its own confirmation
before the next one starts. The stages are SQL conditions over the library
index, listed in bench/stages.json.

    .venv/Scripts/python.exe bench/stages.py --list
    .venv/Scripts/python.exe bench/stages.py anime-single --jobs 3
    .venv/Scripts/python.exe bench/stages.py anime-single --save-baseline
    .venv/Scripts/python.exe bench/stages.py anime-single --compare   # after an engine change

The mapper's red lines are the truth: ranked and loved timings are mappable
by construction, so no listening is needed. ``--ranked-db`` holds a stage to
exactly those: maps the local osu!.db lists as ranked, approved or loved
(bench/mapper_agreement.py reads it). Without it every map of the stage
counts, graveyard timings included, and its report says so. Every song is assigned by a hash
of its audio bytes -- one group per recording and per set folder, so no song or
set straddles the two -- to **dev** (70 %, where changes are tuned) or **held
out** (30 %, never looked at while tuning). A change counts only if it improves
the held-out part as well, and Corpus A stays green.

``--cohort bench/accuracy.local.json`` scores a locked cohort instead of the
index's current maps (bench/accuracy_manifest.py freezes one): the same maps,
hashes and splits on every run, a changed map stops the run, and a
``confirmation`` cohort is reported as its own part.

Per map, every red line is scored with corpus_b's scoring:

- tempo ok: every red line at the map's octave and within 0.05 BPM
- joint 5 ms: tempo ok and every red line within 5 ms (the roadmap's bar)
- conv. 5 / 10 ms: the same after the mappers' red-line convention (the
  median signed error of the **dev** part, 10.0a's ~21 ms lead) is taken
  off. The constant is fitted on dev and applied to held-out, so the
  held-out figure is an honest estimate of an export-time convention; it is
  a diagnostic until the convention is decided, never an engine change.

Analyses share single_bpm's cache, so songs it already analysed cost nothing.
A measurement, not a gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import statistics
from urllib.parse import quote

import numpy as np
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "bench"))

import overtone as ta  # noqa: E402
import overtone_library as lib  # noqa: E402
import corpus_b as cb  # noqa: E402
import single_bpm as sb  # noqa: E402
import diagnose  # noqa: E402

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "stages.json"
OUT_DIR = HERE / ".cache" / "stages"
BPM_BAR = 0.05
#: The owner's ear (2026-10-28): a line within half a BPM of the map's,
#: 199 for 198.89, is a tidy reading of the same tempo, not a wrong one.
#: Reported beside tempo_ok, which keeps the 0.05 bar the baseline names.
BPM_EAR = 0.5
CHANGE_TOLERANCE_MS = 20.0


def octave_steps(lines: list) -> int:
    """Count adjacent half/double-time candidates within 3%, not proven errors."""
    return sum(any(abs((float(b) / float(a)) / factor - 1) <= .03
                   for factor in (.25, .5, 2., 4.))
               for (_, a, *_), (_, b, *_) in zip(lines, lines[1:]) if a > 0 and b > 0)


def change_point_counts(map_lines: list[tuple[float, float]],
                        engine_lines: list[tuple[float, float]],
                        tolerance_ms: float = CHANGE_TOLERANCE_MS) -> dict:
    """One-to-one tempo-change matching; meter-only red lines are excluded."""
    threshold = diagnose.CHANGE_SHARE

    def changes(lines: list[tuple[float, float]]) -> list[float]:
        return [float(offset) for (offset, bpm), (_previous_offset, previous_bpm)
                in zip(lines[1:], lines[:-1])
                if previous_bpm > 0 and abs(bpm / previous_bpm - 1.0) > threshold]

    truth, predicted = changes(map_lines), changes(engine_lines)
    pairs = sorted((abs(p - t), p, t) for p in predicted for t in truth
                   if abs(p - t) <= tolerance_ms)
    used_pred, used_truth, errors = set(), set(), []
    for _distance, p, t in pairs:
        if p in used_pred or t in used_truth:
            continue
        used_pred.add(p)
        used_truth.add(t)
        errors.append(p - t)
    tp, fp, fn = len(errors), len(predicted) - len(used_pred), len(truth) - len(used_truth)
    precision = tp / (tp + fp) if tp + fp else (1.0 if not truth else 0.0)
    recall = tp / (tp + fn) if tp + fn else (1.0 if not predicted else 0.0)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"true": len(truth), "predicted": len(predicted), "tp": tp, "fp": fp, "fn": fn,
            "precision": precision, "recall": recall, "f1": f1,
            "matched_error_ms": cb.quartiles(errors), "tolerance_ms": tolerance_ms}


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def is_holdout(folder: str, share: float) -> bool:
    """Legacy folder split. Kept for callers that have no audio identity."""
    digest = hashlib.sha1(folder.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 2 ** 32 < share


def audio_identity(audio: Path) -> str:
    """Content identity for grouping alternate paths to the same recording."""
    hasher = hashlib.sha1()
    with audio.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def audio_split(audio_sha1: str, share: float) -> str:
    """Split by audio bytes so alternate sets/difficulties cannot leak a song
    across dev and holdout. SHA-1 is used only as a stable partition key."""
    digest = bytes.fromhex(audio_sha1)
    value = int.from_bytes(digest[:4], "big") / 2 ** 32
    return "holdout" if value < share else "dev"


SPLIT_RULE = ("sha1(audio bytes) grouped by shared audio or set folder; the group's smallest "
              "hash, first 32 bits / 2^32 < holdout_share is held out")


def assign_splits(songs: list[dict], share: float) -> None:
    """One split per song *and* set: songs sharing a recording or a set folder
    form one group, keyed by its smallest audio hash. A set whose difficulties
    use two audio files, or one recording in two sets, cannot straddle dev and
    held out. Re-encoded copies of a song have different bytes and are not
    joined here: bench/accuracy_audit.py is where those are looked for."""
    parent = list(range(len(songs)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    first: dict[tuple[str, str], int] = {}
    for n, song in enumerate(songs):
        for key in (("audio", song["audio_sha1"]),
                    ("folder", Path(song["folder"]).name.casefold())):
            if key in first:
                parent[find(n)] = find(first[key])
            else:
                first[key] = n
    keys: dict[int, str] = {}
    for n, song in enumerate(songs):
        root = find(n)
        keys[root] = min(keys.get(root, song["audio_sha1"]), song["audio_sha1"])
    for n, song in enumerate(songs):
        song["split_key"] = keys[find(n)]
        song["split"] = audio_split(song["split_key"], share)


def cohort_songs(manifest: dict) -> list[dict]:
    """The songs of a locked cohort (bench/accuracy_manifest.py), straight from
    its entries: the same maps, audio and split every run, whatever the
    library index says today. Every map carries the hash it was frozen with,
    so score_song refuses one that changed instead of dropping it."""
    by_audio: dict[str, dict] = {}
    for entry in manifest["entries"]:
        audio = entry["audio_path"]
        song = by_audio.setdefault(audio, {
            "audio": audio, "audio_sha1": entry["audio_sha1"],
            "folder": entry.get("folder_path") or str(Path(audio).parent),
            "split": entry["split"], "split_key": entry.get("split_key", entry["audio_sha1"]),
            "maps": []})
        if (song["audio_sha1"], song["split"]) != (entry["audio_sha1"], entry["split"]):
            raise ValueError(f"one audio path with two identities or splits: {audio}")
        song["maps"].append({"file": entry["file"], "path": entry["osu_path"],
                             "osu_sha1": entry["osu_sha1"]})
    return list(by_audio.values())


def ranked_maps(osu_db: Path) -> tuple[set[tuple[str, str]], dict]:
    """(song folder, .osu file) of every map osu!.db lists as ranked,
    approved or loved, casefolded, and the database's header."""
    import mapper_agreement as ma
    header, maps = ma.parse_osu_db(osu_db.read_bytes())
    return {(m.folder.casefold(), m.filename.casefold()) for m in maps}, header


def build_stage(stage: dict, db_path: Path, share: float,
                ranked: set[tuple[str, str]] | None = None) -> tuple[list[dict], list[str]]:
    """The stage's maps grouped by song audio, each checked on disk; with
    ``ranked``, only the maps in it."""
    db_uri = f"file:{quote(str(db_path.resolve()).replace(chr(92), '/'), safe='/:')}?mode=ro"
    db = sqlite3.connect(db_uri, uri=True)
    rows = db.execute(
        "SELECT beatmaps.path, sets.folder FROM beatmaps JOIN sets ON beatmaps.set_id = sets.id"
        f" WHERE {stage['where']} ORDER BY sets.folder, beatmaps.path").fetchall()
    db.close()
    skipped: list[str] = []
    unranked = 0
    by_audio: dict[str, dict] = {}
    for path, folder_name in rows:
        osu = Path(path)
        if ranked is not None and (Path(folder_name).name.casefold(),
                                   osu.name.casefold()) not in ranked:
            unranked += 1
            continue
        if not osu.is_file():
            skipped.append(f"{folder_name}/{osu.name}: map no longer there")
            continue
        audio = sb._audio_of(osu.parent, osu)
        if audio is None:
            skipped.append(f"{folder_name}/{osu.name}: song not found")
            continue
        audio_key = str(audio)
        if audio_key not in by_audio:
            by_audio[audio_key] = {
                "audio": audio_key, "audio_sha1": audio_identity(audio),
                "folder": folder_name, "maps": []}
        song = by_audio[audio_key]
        song["maps"].append({"file": osu.name, "path": str(osu)})
    if unranked:
        skipped.append(f"{unranked} maps not ranked, approved or loved in osu!.db")
    songs = list(by_audio.values())
    assign_splits(songs, share)
    return songs, skipped


def score_song(song: dict, analysis: dict) -> list[dict]:
    """One verdict per map of the song, every red line scored."""
    if audio_identity(Path(song["audio"])) != song["audio_sha1"]:
        raise ValueError(f"audio changed during analysis: {song['audio']}")
    detected = [(line[0], line[1]) for line in analysis["lines"]]
    out = []
    for entry in song["maps"]:
        # A locked cohort's map was frozen with its hash: it is scored as it
        # was or the run stops. Dropping it would shrink the denominator.
        locked = entry.get("osu_sha1")
        try:
            osu_hash = audio_identity(Path(entry["path"]))
            reds = ta.read_osu_red_lines(entry["path"])
        except (OSError, ValueError) as exc:
            if locked:
                raise ValueError(f"locked map unreadable: {entry['path']}") from exc
            continue
        if audio_identity(Path(entry["path"])) != osu_hash:
            raise ValueError(f"map changed while scoring: {entry['path']}")
        if locked and osu_hash != locked:
            raise ValueError(f"locked map changed since the cohort was frozen: {entry['path']}")
        if not reds:
            if locked:
                raise ValueError(f"locked map has no red lines: {entry['path']}")
            continue
        rows = cb.score_track(reds, detected)
        change_points = change_point_counts([(float(o), float(b)) for o, b in reds], detected)
        d_map, d_eng = beat_distances(reds, detected, analysis.get("duration_s") or 0.0)
        bar_hits = lines_on_bars(reds, detected, analysis.get("duration_s") or 0.0)
        out.append({"file": entry["file"], "folder": Path(song["folder"]).name,
                    "folder_name": Path(song["folder"]).name,
                    "folder_path": str(song["folder"]),
                    "audio_filename": Path(song["audio"]).name,
                    "osu_sha1": osu_hash,
                    "audio_sha1": song["audio_sha1"], "split": song["split"],
                    "split_key": song.get("split_key", song["audio_sha1"]),
                    "path": analysis["path"], "map_lines": len(reds),
                    "duration_s": analysis.get("duration_s"),
                    "detected_lines": len(detected), "rows": rows,
                    "change_points": change_points,
                    "lines": [[round(float(o), 1), round(float(b), 3)] for o, b in detected],
                    "d_map": d_map, "d_eng": d_eng, "bar_hits": bar_hits,
                    **({"message": analysis["message"]} if analysis.get("message") else {}),
                    **{k: analysis.get(k) for k in ("global_bpm", "octave_margin", "offbeat_ratio",
                                                    "residual_ms", "stability", "backend")}})
    return out


#: How near a map's bar line an engine red line must start to count as on it.
BAR_TOL_MS = 20.0


def lines_on_bars(reds, detected, duration_s: float) -> list[bool]:
    """For each engine red line after the first: does it start within
    BAR_TOL_MS of one of the map's bar lines? Bars are the map's own red
    lines and every 4 beats after each (4/4 assumed: a mapper starts a tempo
    change on beat 1). Chance is about one in four."""
    if len(detected) < 2 or not reds:
        return []
    end = (duration_s or 0.0) * 1000.0
    bars = []
    for n, (offset, bpm) in enumerate(reds):
        stop = reds[n + 1][0] if n + 1 < len(reds) else max(end, offset)
        bar = 4 * 60000.0 / bpm
        t = offset
        while t <= stop + 1e-6:
            bars.append(t)
            t += bar
    bars = np.asarray(sorted(bars))
    out = []
    for offset, _ in detected[1:]:
        i = np.clip(np.searchsorted(bars, offset), 1, bars.size - 1) if bars.size > 1 else 0
        near = np.abs(bars[max(i - 1, 0):i + 1] - offset).min()
        out.append(bool(near <= BAR_TOL_MS))
    return out


def beat_distances(reds, detected, duration_s: float) -> tuple[np.ndarray, np.ndarray]:
    """Beat by beat, from the map's first red line to the song's end: each
    map beat's signed distance to the nearest engine beat (ms, positive when
    the engine is late), and each engine beat's to the nearest map beat with
    the same sign. The first says how many map beats the engine has (recall),
    the second how many engine beats are real (precision: a grid read at
    double time has every other beat on nothing)."""
    empty = np.zeros(0)
    if not detected or duration_s <= 0:
        return empty, empty
    start = reds[0][0] / 1000.0
    mb = np.asarray([t for t in cb.grid_beats(reds, duration_s) if t >= start - 1e-6]) * 1000.0
    eb = np.asarray([t for t in cb.grid_beats(detected, duration_s) if t >= start - 1e-6]) * 1000.0
    if mb.size == 0 or eb.size == 0:
        return empty, empty

    def nearest(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
        i = np.clip(np.searchsorted(dst, src), 1, dst.size - 1) if dst.size > 1 else np.zeros(src.size, int)
        left, right = dst[np.maximum(i - 1, 0)], dst[i]
        return np.where(np.abs(left - src) <= np.abs(right - src), left, right) - src

    return nearest(mb, eb), -nearest(eb, mb)


def beat_f(m: dict, tol_ms: float, shift_ms: float) -> float:
    """F-measure of the engine's beats against the map's at ``tol_ms``."""
    if m["d_map"].size == 0 or m["d_eng"].size == 0:
        return 0.0
    recall = float(np.mean(np.abs(m["d_map"] - shift_ms) <= tol_ms))
    precision = float(np.mean(np.abs(m["d_eng"] - shift_ms) <= tol_ms))
    return 0.0 if recall + precision == 0 else 2 * recall * precision / (recall + precision)


def beat_convention(maps: list[dict]) -> float:
    """The median signed beat distance within 50 ms, over the dev maps."""
    d = np.concatenate([m["d_map"] for m in maps if m["d_map"].size] or [np.zeros(0)])
    d = d[np.abs(d) <= 50]
    return float(np.median(d)) if d.size else 0.0


def tempo_ok(m: dict) -> bool:
    return all(r["octave"] == 1 and r["bpm_error"] is not None and r["bpm_error"] <= BPM_BAR
               for r in m["rows"])


def tempo_near(m: dict) -> bool:
    return all(r["octave"] == 1 and r["bpm_error"] is not None and r["bpm_error"] <= BPM_EAR
               for r in m["rows"])


def joint(m: dict, tol_ms: float, shift_ms: float = 0.0) -> bool:
    return tempo_ok(m) and all(r["error_ms"] is not None and abs(r["error_ms"] - shift_ms) <= tol_ms
                               for r in m["rows"])


def convention(maps: list[dict]) -> float:
    """The median signed error of tempo-correct red lines within 50 ms."""
    errors = [r["error_ms"] for m in maps if tempo_ok(m) for r in m["rows"]
              if r["error_ms"] is not None and abs(r["error_ms"]) <= 50]
    return statistics.median(errors) if errors else 0.0


def summarise(maps: list[dict], shift_ms: float, beat_shift_ms: float = 0.0) -> dict:
    n = len(maps)
    songs = {m.get("audio_sha1", m["folder"]) for m in maps}
    octaves: dict[str, int] = {}
    for m in maps:
        first = m["rows"][0]["octave"]
        key = "none" if first is None else f"x{first:g}"
        octaves[key] = octaves.get(key, 0) + 1

    def share(pred) -> float | None:
        return sum(map(pred, maps)) / n if n else None

    # The same shares averaged over songs, so a 12-difficulty set is one vote.
    per_song: dict[str, list[dict]] = {}
    for m in maps:
        per_song.setdefault(m.get("audio_sha1", m["folder"]), []).append(m)

    def song_share(pred) -> float | None:
        if not per_song:
            return None
        return statistics.mean(sum(map(pred, ms)) / len(ms) for ms in per_song.values())

    def line_share(part: list[dict], tolerance_ms: float = 5.0) -> float | None:
        rows = [r for m in part for r in m["rows"]]
        if not rows:
            return None
        # Refusals/errors retain their red-line rows with null errors and are
        # therefore misses in the denominator.
        return sum(r["error_ms"] is not None and abs(r["error_ms"]) <= tolerance_ms
                   for r in rows) / len(rows)

    dense = [m for m in maps if m["map_lines"] >= 20 or
             (m.get("duration_s") and m["map_lines"] / (m["duration_s"] / 60.0) >= 1.0)]
    dense_song_values = []
    for audio in sorted({m.get("audio_sha1", m["folder"]) for m in dense}):
        value = line_share([m for m in dense if m.get("audio_sha1", m["folder"]) == audio])
        if value is not None:
            dense_song_values.append(value)

    def change_summary(part: list[dict]) -> dict:
        counts = [m.get("change_points", {}) for m in part]
        tp = sum(c.get("tp", 0) for c in counts)
        fp = sum(c.get("fp", 0) for c in counts)
        fn = sum(c.get("fn", 0) for c in counts)
        precision = tp / (tp + fp) if tp + fp else (1.0 if fn == 0 else 0.0)
        recall = tp / (tp + fn) if tp + fn else (1.0 if fp == 0 else 0.0)
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        offsets = [c["matched_error_ms"]["median"] for c in counts
                   if c.get("matched_error_ms")]
        return {"true": tp + fn, "predicted": tp + fp, "tp": tp, "fp": fp, "fn": fn,
                "precision": precision, "recall": recall, "f1": f1,
                "median_map_error_ms": statistics.median(offsets) if offsets else None,
                "tolerance_ms": CHANGE_TOLERANCE_MS}
    # Cluster bootstrap by song, not by red line or difficulty.
    ci = None
    if len(dense_song_values) >= 2:
        rng = np.random.default_rng(2710)
        sample = np.asarray(dense_song_values, dtype=float)
        draws = np.mean(rng.choice(sample, size=(10000, len(sample)), replace=True), axis=1)
        ci = [float(np.quantile(draws, 0.025)), float(np.quantile(draws, 0.975))]

    errors = [r["error_ms"] for m in maps for r in m["rows"] if r["error_ms"] is not None]
    # Red line by red line: on a map with tempo changes, how many of its lines
    # the engine has right, not only whether it has all of them.
    lines = [r for m in maps for r in m["rows"]]
    line_ok = [r for r in lines if r["octave"] == 1 and r["bpm_error"] is not None
               and r["bpm_error"] <= BPM_BAR]
    return {
        "maps": n, "songs": len(songs),
        "answered": sum(m["path"] not in ("refused", "error") for m in maps),
        "adjacent_octave_steps": sum(octave_steps(m.get("lines", [])) for m in maps),
        "maps_with_octave_steps": sum(octave_steps(m.get("lines", [])) > 0 for m in maps),
        "tempo_ok": share(tempo_ok),
        "tempo_near": share(tempo_near),
        "octave_x1": share(lambda m: m["rows"][0]["octave"] == 1),
        "joint_5": share(lambda m: joint(m, 5)),
        "conv_5": share(lambda m: joint(m, 5, shift_ms)),
        "conv_10": share(lambda m: joint(m, 10, shift_ms)),
        "song_tempo_ok": song_share(tempo_ok),
        "song_conv_10": song_share(lambda m: joint(m, 10, shift_ms)),
        "line_count_match": share(lambda m: m["map_lines"] == m["detected_lines"]),
        "redline_within_5ms": line_share(maps),
        "song_all_redlines_within_5ms": song_share(
            lambda m: all(r["error_ms"] is not None and abs(r["error_ms"]) <= 5
                          for r in m["rows"])),
        "beat_f5": (statistics.mean(beat_f(m, 5, beat_shift_ms) for m in maps) if maps else None),
        "dense_maps": len(dense),
        "dense_songs": len({m.get("audio_sha1", m["folder"]) for m in dense}),
        "dense_redlines": sum(m["map_lines"] for m in dense),
        "dense_redline_within_5ms": line_share(dense),
        "dense_song_macro_within_5ms": (statistics.mean(dense_song_values)
                                           if dense_song_values else None),
        "dense_song_macro_ci95": ci,
        "dense_definition": "map_lines >= 20 OR map_lines / audio_minutes >= 1",
        "change_points": change_summary(maps),
        "dense_change_points": change_summary(dense),
        "beat_f10": (statistics.mean(beat_f(m, 10, beat_shift_ms) for m in maps) if maps else None),
        "beat_f20": (statistics.mean(beat_f(m, 20, beat_shift_ms) for m in maps) if maps else None),
        "lines": len(lines),
        "line_on_bar": (lambda hits: sum(hits) / len(hits) if hits else None)(
            [h for m in maps for h in m.get("bar_hits", [])]),
        "line_tempo_ok": len(line_ok) / len(lines) if lines else None,
        "line_conv_10": (sum(r["error_ms"] is not None and abs(r["error_ms"] - shift_ms) <= 10
                              for r in line_ok) / len(lines)
                         if lines else None),
        "signed_error_ms": cb.quartiles(errors),
        "octaves": dict(sorted(octaves.items())),
    }


def pct(v: float | None) -> str:
    return "    -" if v is None else f"{100 * v:5.1f}"


def print_summary(title: str, s: dict, base: dict | None = None) -> None:
    def cell(key: str) -> str:
        text = pct(s[key])
        if base is not None and base.get(key) is not None and s[key] is not None:
            text += f" ({100 * (s[key] - base[key]):+.1f})"
        return text
    err = s["signed_error_ms"]
    signed = "-" if err is None else f"{err['median']:+.1f} [{err['q1']:+.1f}..{err['q3']:+.1f}]"
    print(f"  {title:<9} {s['maps']:>5} maps {s['songs']:>4} songs | tempo ok {cell('tempo_ok')} %"
          f" (within 0.5 BPM {cell('tempo_near')} %)"
          f" | octave x1 {cell('octave_x1')} % | joint 5 ms {cell('joint_5')} %"
          f" | conv 5 {cell('conv_5')} % | conv 10 {cell('conv_10')} %"
          f" | lines match {cell('line_count_match')} % | signed {signed} ms")
    print(f"  {'':<9} beats (F, convention off): within 10 ms {cell('beat_f10')} %,"
          f" within 20 ms {cell('beat_f20')} %")
    print(f"  {'':<9} red lines {s['lines']}: tempo ok {cell('line_tempo_ok')} %,"
          f" conv 10 {cell('line_conv_10')} %, engine changes on a bar line {cell('line_on_bar')} %")
    print(f"  {'':<9} per song: tempo ok {pct(s['song_tempo_ok'])} %, conv 10 {pct(s['song_conv_10'])} %;"
          f" answered {s['answered']}/{s['maps']}; octaves "
          + ", ".join(f"{k} {v}" for k, v in s["octaves"].items()))
    print(f"  {'':<9} adjacent octave-step candidates: {s['adjacent_octave_steps']} "
          f"in {s['maps_with_octave_steps']} maps (3% ratio tolerance)")
    ci = s["dense_song_macro_ci95"]
    interval = "-" if ci is None else f"[{100 * ci[0]:.1f}..{100 * ci[1]:.1f}]"
    print(f"  {'':<9} dense maps (>=20 reds or >=1/min): {s['dense_maps']} maps, "
          f"{s['dense_songs']} audios, {s['dense_redlines']} reds; within 5 ms "
          f"pooled {pct(s['dense_redline_within_5ms'])} %, audio-macro "
          f"{pct(s['dense_song_macro_within_5ms'])} % CI95 {interval}")
    for label, key in (("all", "change_points"), ("dense", "dense_change_points")):
        cp = s[key]
        if cp["true"] or cp["predicted"]:
            error = "-" if cp["median_map_error_ms"] is None else f"{cp['median_map_error_ms']:+.1f} ms"
            print(f"  {'':<9} {label} tempo changes: P/R/F1 "
                  f"{pct(cp['precision'])}/{pct(cp['recall'])}/{pct(cp['f1'])} %; "
                  f"TP/FP/FN {cp['tp']}/{cp['fp']}/{cp['fn']}; median {error} "
                  f"(±{cp['tolerance_ms']:g} ms)")


def main(argv: list[str] | None = None) -> int:
    manifest = load_manifest()
    ids = [s["id"] for s in manifest["stages"]]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("stage", nargs="?", choices=ids)
    parser.add_argument("--list", action="store_true", help="the stages and their sizes")
    parser.add_argument("--engine", choices=sb.ENGINES, default="python")
    parser.add_argument("--db", default=str(lib.default_path()), help="the library index (read only)")
    parser.add_argument("--jobs", type=int, default=1, help="analyses at once (each can take ~2 GB)")
    parser.add_argument("--split", choices=("dev", "holdout", "confirmation"),
                        help="one part only (the convention then needs dev: conv. figures are not read)")
    parser.add_argument("--max-songs", type=int, default=0, metavar="N", help="the first N songs only")
    parser.add_argument("--cli", help="overtone-cli binary (Rust engine)")
    parser.add_argument("--save-baseline", action="store_true",
                        help="keep this run as the stage's baseline (bench/.cache/stages/)")
    parser.add_argument("--compare", action="store_true", help="print the change against the baseline")
    parser.add_argument("--ranked-db", metavar="OSU_DB",
                        help="osu!.db: score only maps it lists as ranked, approved or loved")
    parser.add_argument("--cohort", metavar="MANIFEST",
                        help="a locked cohort (bench/accuracy_manifest.py): exactly its maps and splits")
    args = parser.parse_args(argv)
    if args.cohort and args.ranked_db:
        parser.error("--cohort already holds ranked maps only; drop --ranked-db")
    db_path = Path(args.db)
    share = manifest["holdout_share"]
    ranked, ranked_info = None, None
    if args.ranked_db:
        ranked, header = ranked_maps(Path(args.ranked_db))
        ranked_info = {"osu_db_version": header["version"], "ranked_maps": len(ranked)}
        print(f"osu!.db v{header['version']}: {len(ranked)} ranked, approved or loved maps")

    if args.list or not args.stage:
        for stage in sorted(manifest["stages"], key=lambda s: s["order"]):
            songs, skipped = build_stage(stage, db_path, share, ranked)
            held = sum(s["split"] == "holdout" for s in songs)
            print(f"{stage['order']}. {stage['id']:<16} {len(songs):>5} songs "
                  f"({len(songs) - held} dev / {held} held out), "
                  f"{sum(len(s['maps']) for s in songs):>5} maps, {len(skipped)} skipped -- {stage['title']}")
        return 0

    started = time.perf_counter()
    stage = next(s for s in manifest["stages"] if s["id"] == args.stage)
    cli = None
    if args.engine in ("rust", "app"):
        import overtone_rust
        cli = Path(args.cli) if args.cli else overtone_rust.find_cli()
        if cli is None or not cli.is_file():
            print("No overtone-cli: build it with cargo build --release -p overtone-cli")
            return 2
    fingerprint = sb.engine_fingerprint(args.engine, cli)
    cohort_info = None
    if args.cohort:
        import accuracy_manifest
        cohort_path = Path(args.cohort)
        if accuracy_manifest.verify(cohort_path):
            print("the cohort no longer matches its manifest: nothing scored")
            return 2
        cohort = json.loads(cohort_path.read_text(encoding="utf-8"))
        if cohort.get("stage") != stage["id"]:
            parser.error(f"the cohort was frozen from stage {cohort.get('stage')}, not {stage['id']}")
        share = cohort["holdout_share"]
        songs, skipped = cohort_songs(cohort), []
        ranked = True
        ranked_info = cohort.get("ranked") or {"from_cohort": True}
        cohort_info = {"manifest": cohort_path.name, "sha1": audio_identity(cohort_path),
                       "kind": cohort.get("cohort", "dev-holdout"), "maps": len(cohort["entries"])}
    else:
        songs, skipped = build_stage(stage, db_path, share, ranked)
    if args.split:
        songs = [s for s in songs if s["split"] == args.split]
    if args.max_songs:
        songs = songs[:args.max_songs]
    print(f"stage {stage['id']}: {len(songs)} songs, {sum(len(s['maps']) for s in songs)} maps, "
          f"{len(skipped)} skipped")

    analyses: dict[str, dict] = {}
    todo = []
    for n, song in enumerate(songs):
        song["id"] = f"s{n:05d}"
        cached = cb.read_cache(sb.cache_path(args.engine, song, fingerprint))
        if cached is not None:
            analyses[song["id"]] = cached
        else:
            todo.append((song, song["audio"]))
    print(f"{len(songs) - len(todo)} from the cache, {len(todo)} to analyse", flush=True)
    for song, result in cb.run_analyses(todo, args.engine, cli, args.jobs):
        if result["path"] != "error":
            cb.write_cache(sb.cache_path(args.engine, song, fingerprint), result)
        analyses[song["id"]] = result

    maps = [m for song in songs for m in score_song(song, analyses[song["id"]])]
    dev = [m for m in maps if m["split"] == "dev"]
    held = [m for m in maps if m["split"] == "holdout"]
    confirm = [m for m in maps if m["split"] == "confirmation"]
    shift = convention(dev)
    beat_shift = beat_convention(dev)
    summary = {"dev": summarise(dev, shift, beat_shift),
               "holdout": summarise(held, shift, beat_shift),
               "convention_ms": shift, "beat_convention_ms": beat_shift}
    if confirm:
        # Its convention comes from this run's dev part, never from itself;
        # a confirmation cohort alone has none, and conv. figures read 0 ms.
        summary["confirmation"] = summarise(confirm, shift, beat_shift)

    # A ranked-only run and an every-map run answer different questions:
    # each keeps its own report and its own baseline.
    kind = f"{stage['id']}-{args.engine}" + ("-ranked" if ranked is not None else "")
    if cohort_info:
        kind = f"{stage['id']}-{args.engine}-cohort-{Path(args.cohort).stem.split('.')[0]}"
    out = OUT_DIR / f"{kind}.json"
    base_path = OUT_DIR / f"{kind}-baseline.json"
    base = None
    if args.compare and base_path.is_file():
        base = json.loads(base_path.read_text(encoding="utf-8"))["summary"]
    print(f"\n{stage['title']} ({stage['id']}), {args.engine} engine, "
          f"convention fitted on dev: {shift:+.1f} ms")
    print_summary("dev", summary["dev"], base and base["dev"])
    print_summary("held out", summary["holdout"], base and base["holdout"])
    if "confirmation" in summary:
        print_summary("confirm", summary["confirmation"], base and base.get("confirmation"))
    if args.compare and base is None:
        print("  no baseline yet: run with --save-baseline first")

    # Why the rest are wrong, and how much of the songs' time each reason takes
    # (bench/diagnose.py): where the next fix pays most.
    diagnosis = {}
    for name, part in (("dev", dev), ("holdout", held), ("confirmation", confirm)):
        if part:
            diagnosis[name] = diagnose.diagnose(part, shift)
            diagnose.print_diagnosis("held out" if name == "holdout" else name, diagnosis[name])

    # The worst songs of the dev part: where to look next.
    failing: dict[str, list[str]] = {}
    for m in dev:
        if not tempo_ok(m):
            r = m["rows"][0]
            why = (m["path"] if r["octave"] is None else
                   f"x{r['octave']:g}" if r["octave"] != 1 else f"dBPM {r['bpm_error']:.2f}")
            failing.setdefault(m["folder"], []).append(why)
    if failing:
        print(f"\n  dev songs with a wrong tempo: {len(failing)} (first 15)")
        for folder, whys in list(failing.items())[:15]:
            print(f"    {folder[:70]:<70} {', '.join(sorted(set(whys)))}")

    payload = {"stage": stage, "engine": args.engine, "fingerprint": fingerprint,
               "holdout_share": share,
               "split_rule": SPLIT_RULE,
               "ranked": ranked_info, "cohort": cohort_info,
               "run": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "summary": summary, "diagnosis": diagnosis, "skipped": skipped,
               "maps": [{k: v for k, v in m.items() if k not in ("rows", "d_map", "d_eng")} | {
                   "beat_f5": beat_f(m, 5, beat_shift),
                   "beat_f10": beat_f(m, 10, beat_shift),
                   "tempo_ok": tempo_ok(m), "conv_10": joint(m, 10, shift),
                   "first": m["rows"][0], "rows": m["rows"]} for m in maps]}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    if args.save_baseline:
        base_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        print(f"\n  baseline saved: {base_path}")
    print(f"\n  written: {out}  ({time.perf_counter() - started:.0f} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
