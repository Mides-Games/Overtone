""".osz export, .osu injection and the audio swap."""
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

from . import audio_io, exports, onsets, osu_read, params


# ---------------------------------------------------------------------------
# .osz export
# ---------------------------------------------------------------------------
#: Characters Windows refuses in a filename, plus the ones osu! trips over.
_UNSAFE_FILENAME = str.maketrans({c: "_" for c in '<>:"/\\|?*'})


def _safe_component(text: str, fallback: str) -> str:
    """A filename piece that is safe on Windows and readable afterwards.

    Path separators are already replaced, so traversal is not reachable, but a
    run of dots is collapsed as well: ".." inside an archive entry is harmless
    here and alarming everywhere else, and some extractors refuse it outright.
    A single dot survives, because "Mr. Blue" is a legitimate artist.
    """
    cleaned = " ".join(str(text).translate(_UNSAFE_FILENAME).split())
    cleaned = re.sub(r"\.{2,}", "_", cleaned)
    # Trimmed again after the cut: 80 characters can end in a space or a dot,
    # which Windows drops on extraction.
    return cleaned.strip(". ")[:80].rstrip(". ") or fallback


def _romanised(text: str) -> bool:
    """osu!'s romanised metadata fields take printable ASCII only."""
    return bool(text) and all(32 <= ord(ch) < 127 for ch in text)


def song_metadata(audio_path: str | os.PathLike[str]) -> dict:
    """What a beatmap made for this audio should call it (Phase 21: metadata
    from tags).

    A map beside it that plays this audio knows best: its [Metadata] as the
    mapper wrote it, romanised and Unicode fields apart, with its source.
    Otherwise the audio's own tags (ID3, Vorbis comments, RIFF INFO, as
    libsndfile reads them): a tag goes to the Unicode field as written, and to
    the romanised one only when it is plain ASCII, since romanising is a
    judgement, not a lookup. Fields found go under ``title``,
    ``title_unicode``, ``artist``, ``artist_unicode`` and ``source``; missing
    ones are left out, so a caller's defaults stay; ``from`` says which of
    "map", "tags" or "none" answered. An unreadable map or tag is skipped,
    never raised.
    """
    path = Path(audio_path)
    try:
        maps = sorted(path.parent.glob("*.osu"))
    except OSError:
        maps = []
    for osu in maps:
        try:
            beatmap = osu_read.read_osu_beatmap(osu)
        except (OSError, ValueError):
            continue
        general = beatmap.get("general") or {}
        if str(general.get("AudioFilename", "")).strip().lower() != path.name.lower():
            continue
        meta = beatmap.get("metadata") or {}
        found = {"title": meta.get("Title", ""), "title_unicode": meta.get("TitleUnicode", ""),
                 "artist": meta.get("Artist", ""), "artist_unicode": meta.get("ArtistUnicode", ""),
                 "source": meta.get("Source", "")}
        found = {key: " ".join(str(value).split()) for key, value in found.items()}
        found = {key: value for key, value in found.items() if value}
        if found.get("title") or found.get("artist"):
            return {**found, "from": "map"}
    try:
        with sf.SoundFile(str(path)) as handle:
            tags = handle.copy_metadata()
    except (RuntimeError, OSError, ValueError, TypeError):
        tags = {}
    out: dict = {}
    for key in ("title", "artist"):
        value = " ".join(str(tags.get(key, "") or "").split())
        if value:
            out[f"{key}_unicode"] = value
            if _romanised(value):
                out[key] = value
    return {**out, "from": "tags" if out else "none"}


def osu_beatmap_text(analysis: "Analysis", audio_filename: str,
                     metadata: dict | None = None, decimals: int = 0) -> str:
    """A complete, openable .osu carrying this analysis and nothing else.

    Timing a song from nothing is the one part of Tempora's workflow Overtone
    could not do: it could only inject red lines into a beatmap that already
    existed. This writes the beatmap.

    Deliberately minimal — no hit objects, no background, default difficulty
    settings. The point is a file a mapper can open in the editor with the
    timing already correct, not a playable map.
    """
    meta = {
        "title": "Untitled",
        "artist": "Unknown Artist",
        "creator": "Overtone",
        "version": "Timing",
        "source": "",
        "tags": "",
    }
    # One line each: a tag can hold a line break, which would end the field.
    meta.update({k: " ".join(str(v).split()) for k, v in (metadata or {}).items()
                 if v is not None})
    # The Unicode fields as given, else the romanised ones, as before.
    meta["title_unicode"] = meta.get("title_unicode") or meta["title"]
    meta["artist_unicode"] = meta.get("artist_unicode") or meta["artist"]

    timing = "\n".join(
        row for row in exports.osu_timing_text(analysis, decimals).splitlines()
        if row and not row.startswith("//")
    )
    if not timing:
        raise ValueError("This analysis has no usable timing points to export.")

    return "\n".join([
        "osu file format v14",
        "",
        "[General]",
        f"AudioFilename: {audio_filename}",
        "AudioLeadIn: 0",
        "PreviewTime: -1",
        "Countdown: 0",
        "SampleSet: Normal",
        "StackLeniency: 0.7",
        "Mode: 0",
        "LetterboxInBreaks: 0",
        "WidescreenStoryboard: 0",
        "",
        "[Editor]",
        "DistanceSpacing: 1",
        "BeatDivisor: 4",
        "GridSize: 4",
        "TimelineZoom: 1",
        "",
        "[Metadata]",
        f"Title:{meta['title']}",
        f"TitleUnicode:{meta['title_unicode']}",
        f"Artist:{meta['artist']}",
        f"ArtistUnicode:{meta['artist_unicode']}",
        f"Creator:{meta['creator']}",
        f"Version:{meta['version']}",
        f"Source:{meta['source']}",
        f"Tags:{meta['tags']}",
        "BeatmapID:0",
        "BeatmapSetID:-1",
        "",
        "[Difficulty]",
        "HPDrainRate:5",
        "CircleSize:4",
        "OverallDifficulty:7",
        "ApproachRate:9",
        "SliderMultiplier:1.4",
        "SliderTickRate:1",
        "",
        "[Events]",
        "//Background and Video events",
        "//Break Periods",
        "//Storyboard Layer 0 (Background)",
        "//Storyboard Layer 1 (Fail)",
        "//Storyboard Layer 2 (Pass)",
        "//Storyboard Layer 3 (Foreground)",
        "//Storyboard Layer 4 (Overlay)",
        "//Storyboard Sound Samples",
        "",
        "[TimingPoints]",
        timing,
        "",
        "",
        "[HitObjects]",
        "",
    ])


def export_osz(analysis: "Analysis", destination: str | os.PathLike[str],
               audio_path: str | os.PathLike[str] | None = None,
               metadata: dict | None = None, decimals: int = 0) -> dict:
    """Write a .osz: the audio plus a beatmap carrying this timing.

    The archive is built in a temporary file and renamed into place, so an
    interrupted export cannot leave a half-written .osz that osu! will refuse
    and the user will not think to delete. What the caller does not name comes
    from the song (``song_metadata``: a map beside it, else the audio's tags),
    then from the file's name; ``metadata`` in the result says what was used
    and where it came from.
    """
    import zipfile

    source = Path(audio_path) if audio_path else Path(getattr(analysis, "source", ""))
    if not source.is_file():
        raise ValueError(f"Audio file not found: {source}")
    size = source.stat().st_size
    if size > params.MAX_OSZ_AUDIO_BYTES:
        raise ValueError(
            f"{source.name} is {size / 1e6:.0f} MB; that is not a beatmap's audio.")

    # Drop keys the caller passed as None -- a CLI flag that was not given
    # arrives as None, and keeping it would shadow the default with "None".
    meta = {k: v for k, v in (metadata or {}).items() if v is not None}
    given = bool(meta.get("title") or meta.get("artist"))
    found = song_metadata(source)
    taken = []
    for field in ("title", "artist"):
        # A name the caller gave is both fields' unless it gave the Unicode one too.
        if field not in meta:
            for key in (field, f"{field}_unicode"):
                if key in found and key not in meta:
                    meta[key] = found[key]
                    taken.append(key)
    if "source" in found and "source" not in meta:
        meta["source"] = found["source"]
        taken.append("source")
    origin = found["from"] if taken else "given" if given else "none"
    meta.setdefault("title", source.stem)
    artist = _safe_component(meta.get("artist", "Unknown Artist"), "Unknown Artist")
    title = _safe_component(meta.get("title", "Untitled"), "Untitled")
    creator = _safe_component(meta.get("creator", "Overtone"), "Overtone")
    version = _safe_component(meta.get("version", "Timing"), "Timing")

    # Stem and extension apart: through _safe_component whole, a name over 80
    # characters lost its ".mp3", and "Title....mp3" came out "Title_mp3".
    suffix = re.sub(r"[^.a-z0-9]", "", source.suffix.lower())
    audio_name = _safe_component(source.stem, "audio") + suffix
    osu_name = f"{artist} - {title} ({creator}) [{version}].osu"
    text = osu_beatmap_text(analysis, audio_name, meta, decimals)

    target = Path(destination)
    temp = target.with_name(target.name + ".part")
    try:
        with open(temp, "wb") as handle:
            with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(osu_name, text.encode("utf-8"))
                archive.write(source, audio_name)
            _sync(handle)
        os.replace(temp, target)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise
    return {"osu": osu_name, "audio": audio_name,
            "points": len(exports.snap_timing_points(list(analysis.points))),
            "bytes": target.stat().st_size,
            "metadata": {"title": meta["title"], "artist": meta.get("artist", "Unknown Artist"),
                         "title_unicode": meta.get("title_unicode") or meta["title"],
                         "artist_unicode": (meta.get("artist_unicode")
                                            or meta.get("artist", "Unknown Artist")),
                         "from": origin}}


# ---------------------------------------------------------------------------
# .osu injection
# ---------------------------------------------------------------------------

def _sync(handle) -> None:
    """Push a temp file's bytes to the disk before it is renamed into place.

    The OS may persist a rename before the data it points at. After a power
    cut or a crash between the two, the name then holds an empty or
    zero-filled file and the content it replaced is gone. Syncing first
    leaves the old file or the complete new one, never neither.
    """
    handle.flush()
    os.fsync(handle.fileno())


def _write_synced(path: Path, payload: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(payload)
        _sync(handle)


def history_path(history_dir: str | os.PathLike[str] | None = None) -> Path:
    """Where the write log lives: beside the result cache, never the app.
    ``OVERTONE_HISTORY_DIR`` overrides it (the test suite points it at a
    scratch folder so no test run lands in real history)."""
    if history_dir is not None:
        return Path(history_dir) / "writes.jsonl"
    override = os.environ.get("OVERTONE_HISTORY_DIR")
    base = Path(override) if override else data_root()
    return base / "writes.jsonl"


def log_write(path: str | os.PathLike[str], op: str, backup: str | None,
              summary: dict | None = None,
              history_dir: str | os.PathLike[str] | None = None) -> dict:
    """Append one write entry: when, what operation, which file, which backup
    holds the replaced bytes, and a small summary. Never fails the write it
    records: a log that cannot be kept is skipped, not raised."""
    entry = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "op": str(op), "path": str(path),
             "backup": str(backup) if backup else None,
             "summary": dict(summary or {})}
    try:
        log = history_path(history_dir)
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
        lines = log.read_text(encoding="utf-8").splitlines()
        if len(lines) > 2 * params.HISTORY_LIMIT:
            log.write_text("\n".join(lines[-params.HISTORY_LIMIT:]) + "\n", encoding="utf-8")
    except OSError:
        pass
    return entry


def read_history(history_dir: str | os.PathLike[str] | None = None) -> list[dict]:
    """The write log, newest first; malformed lines are skipped, not fatal."""
    try:
        lines = history_path(history_dir).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    entries = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("path"):
            entries.append(entry)
    entries.reverse()
    return entries


def _reds_of_text(text: str) -> list[tuple[float, float]]:
    """Every red line of .osu text as ``(offset_ms, bpm)``."""
    reds = []
    in_timing = False
    for line in osu_read._osu_lines(text):
        stripped = line.strip()
        if stripped.startswith("["):
            in_timing = stripped.lower() == "[timingpoints]"
            continue
        if in_timing and stripped and not stripped.startswith("//"):
            red = osu_read._parse_red_line(line)
            if red is not None:
                reds.append(red)
    return reds


def diff_reds(old_text: str, new_text: str) -> dict:
    """Red lines old vs new: added and removed offsets, and offsets both hold
    whose BPM moved. Offsets pair within 1 ms, BPM past 0.001 counts as
    moved; lists show the first 20, counts cover all. Plain JSON types."""
    old, new = _reds_of_text(old_text), _reds_of_text(new_text)
    used = [False] * len(new)
    added, removed, changed = [], [], []
    for offset, bpm in old:
        match = next((j for j, (o, _b) in enumerate(new)
                      if not used[j] and abs(o - offset) <= 1.0), None)
        if match is None:
            removed.append(round(offset, 1))
            continue
        used[match] = True
        if abs(new[match][1] - bpm) > 0.001:
            changed.append({"offset": round(offset, 1),
                            "old_bpm": round(bpm, 4), "new_bpm": round(new[match][1], 4)})
    for j, (offset, bpm) in enumerate(new):
        if not used[j]:
            added.append({"offset": round(offset, 1), "bpm": round(bpm, 4)})
    return {"added": added[:20], "removed": [round(o, 1) for o in removed[:20]],
            "changed": changed[:20], "n_added": len(added),
            "n_removed": len(removed), "n_changed": len(changed)}


def restore_write(path: str | os.PathLike[str], backup: str | os.PathLike[str],
                  history_dir: str | os.PathLike[str] | None = None) -> dict:
    """Restore a backup over its file, keeping the current bytes as a new
    backup first: no restore ever destroys. Atomic temp-plus-rename, logged
    as a restore. Missing files refuse with a message, not a traceback."""
    target, spare = Path(path), Path(backup)
    if not target.is_file():
        raise ValueError(f"{target.name} is gone: nothing to restore over.")
    if not spare.is_file():
        raise ValueError(f"{spare.name} is gone: nothing to restore from.")
    payload = spare.read_bytes()
    kept = _backup_before_write(target, target.read_bytes())
    _atomic_write_bytes(target, payload)
    log_write(target, "restore", str(kept), {}, history_dir)
    return {"backup": str(kept)}


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Write via a sibling temp file, synced, then renamed.

    Injecting rewrites the user's beatmap in place. Truncating the real file
    and then failing mid-write would destroy work that may not exist anywhere
    else, so the new content is only ever swapped in once it is complete.

    A file the user made read-only is refused, as Windows refuses it: on
    Linux a rename replaces a read-only file whenever its folder is
    writable, and a server would have rewritten such a map (robustness gate
    on the owner's server, 2026-10-26).
    """
    if path.exists() and not os.access(path, os.W_OK):
        raise PermissionError(f"{path.name} is read-only; it was left as it was.")
    temp = path.with_name(path.name + ".part")
    try:
        _write_synced(temp, payload)
        os.replace(temp, path)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def _backup_before_write(path: Path, raw: bytes) -> Path:
    """Keep ``raw``, the bytes a write is about to replace; return where.

    The first backup is ``map.osu.bak`` and stays pristine for good. Each later
    write keeps what it replaces in the next free ``.bak2``, ``.bak3``... unless
    the newest backup already holds exactly those bytes. A backup is written
    to a temp file and renamed into place, so a full disk or a lock halfway
    through leaves no truncated ``.bak`` for a retry to trust; os.rename, not
    os.replace, because on Windows it refuses an existing target, so no
    backup is ever overwritten.
    """
    newest, number = None, 1
    while True:
        spare = Path(f"{path}.bak{number if number > 1 else ''}")
        if not spare.exists():
            break
        newest, number = spare, number + 1
    if newest is not None and newest.read_bytes() == raw:
        return newest
    temp = spare.with_name(spare.name + ".part")
    try:
        _write_synced(temp, raw)
        os.rename(temp, spare)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise
    return spare


def _is_red_line(line: str) -> bool:
    """True for an uninherited (red) timing line, across every .osu version.

    Format v3-v4 wrote only ``time,beatLength``; v5+ added the ``uninherited``
    flag in field 7. A negative beat length has always meant "inherited", and
    that beats a contradictory flag — otherwise a legacy map keeps its old red
    lines *and* gains the new ones.
    """
    fields = line.split(",")
    if len(fields) < 2:
        return False
    try:
        inherited_by_length = float(fields[1]) < 0
    except ValueError:
        return False
    if len(fields) >= 7:
        return fields[6].strip() == "1" and not inherited_by_length
    return not inherited_by_length


@dataclass(frozen=True)
class _PlayState:
    """What a timing point makes audible from its time on.

    Red lines reset slider velocity to 1.0; green lines set it. Both set the
    hitsound sample set, index, volume and kiai. Timing (BPM, meter) is not
    part of it: that is exactly what injection is asked to change.
    """
    sv: float
    sample_set: int
    sample_index: int
    volume: int
    kiai: bool

    def same_as(self, other: "_PlayState") -> bool:
        return (abs(self.sv - other.sv) <= 1e-9 * max(1.0, abs(other.sv))
                and (self.sample_set, self.sample_index, self.volume, self.kiai)
                == (other.sample_set, other.sample_index, other.volume, other.kiai))


def _timing_point_fields(line: str) -> dict | None:
    """One [TimingPoints] line with osu!'s defaults for the fields old formats omit."""
    fields = [f.strip() for f in line.split(",")]
    if len(fields) < 2:
        return None
    try:
        time = float(fields[0])
        beat_length = float(fields[1])
        if not (np.isfinite(time) and np.isfinite(beat_length)):
            return None                      # "inf" or "nan": a line osu! cannot read

        def number(n: int, default: int) -> int:
            return int(float(fields[n])) if len(fields) > n and fields[n] else default

        return {"time": time, "beat_length": beat_length, "red": _is_red_line(line),
                "meter": number(2, 4), "sample_set": number(3, 0),
                "sample_index": number(4, 0), "volume": number(5, 100),
                "effects": number(7, 0)}
    except (ValueError, OverflowError):
        return None


def _apply_point(state: "_PlayState | None", point: dict) -> _PlayState:
    if point["red"]:
        sv = 1.0
    elif point["beat_length"] < 0:
        sv = -100.0 / point["beat_length"]
    else:
        sv = state.sv if state is not None else 1.0
    return _PlayState(sv, point["sample_set"], point["sample_index"], point["volume"],
                      bool(point["effects"] & 1))


def _ordered(points: list[dict]) -> list[dict]:
    """Time order, a red before a green at the same time (osu!'s own order)."""
    return sorted(points, key=lambda q: (q["time"], 0 if q["red"] else 1, q["order"]))


def _states_at_events(points: list[dict], events: list[float]) -> list["_PlayState | None"]:
    """The audible state at each event time; before the first point, the first
    point's settings apply, as in osu!."""
    ordered = _ordered(points)
    first = _apply_point(None, ordered[0]) if ordered else None
    out: list[_PlayState | None] = []
    state, i = None, 0
    for time in events:
        while i < len(ordered) and ordered[i]["time"] <= time + 1e-6:
            state = _apply_point(state, ordered[i])
            i += 1
        out.append(state if state is not None else first)
    return out


def inject_osu_timing_points(osu_path: str | os.PathLike[str],
                             analysis: Analysis,
                             backup: bool = True,
                             dry_run: bool = False,
                             decimals: int = 0) -> dict:
    """Replace the red (uninherited) lines of an .osu with this analysis.

    Only the timing changes. Each new red line takes the sample set, index,
    volume and kiai the original map had at its time, and where moving the red
    lines would change what plays — slider velocity, which a red line resets,
    or the hitsound state an old red line set — a green line carrying the
    original values is added at that time. So the map sounds and scrolls as it
    did, with the new timing; nothing the user did not ask for changes.

    Green lines keep their exact bytes, and so does everything outside
    [TimingPoints]: the BOM, each line's own line ending, a missing final
    newline. The timing section is written in time order, a red before a green
    at the same time. Unless ``backup`` is False, what the write replaces is
    kept first (see _backup_before_write): the pristine ``.bak`` on the first
    inject, a ``.bak2``, ``.bak3``... after the mapper has worked on the map
    since; no backup is ever overwritten. With ``dry_run`` nothing is written.
    Returns ``reds_replaced``, ``reds_added``, ``greens_kept``,
    ``greens_added``, ``backup`` (the path holding the replaced bytes, or
    None) and an ``audio_mismatch`` warning when the .osu's AudioFilename
    differs from the analysed file.
    """
    path = Path(osu_path)
    if not path.is_file():
        raise ValueError(f"{path} is not a file.")
    size = path.stat().st_size
    if size > params.MAX_OSU_BYTES:
        raise ValueError(f"{path.name} is {size / 1e6:.1f} MB — that is not a beatmap.")
    new_rows = [row for row in exports.osu_timing_text(analysis, decimals).splitlines()
                if row and not row.startswith("//")]
    if not new_rows:
        raise ValueError("This analysis has no usable timing points to inject.")

    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Could not decode {path.name} as UTF-8.") from exc
    newline = "\r\n" if b"\r\n" in raw else "\n"
    lines = osu_read._osu_lines(text, keepends=True)  # every line keeps its own ending

    header_idx = next((n for n, line in enumerate(lines)
                       if line.strip() == "[TimingPoints]"), None)
    if header_idx is None:
        raise ValueError("No [TimingPoints] section found in this .osu file.")
    end_idx = len(lines)
    for n in range(header_idx + 1, len(lines)):
        stripped = lines[n].strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            end_idx = n
            break
    body = lines[header_idx + 1:end_idx]
    # Blank lines closing the section stay where they are; so do comments and
    # anything else that is not a point, above the points.
    tail_start = len(body)
    while tail_start > 0 and not body[tail_start - 1].strip():
        tail_start -= 1
    tail = body[tail_start:]
    others: list[str] = []
    originals: list[dict] = []
    for n, line in enumerate(body[:tail_start]):
        point = _timing_point_fields(line.strip()) if line.strip() else None
        if point is None:
            others.append(line)
        else:
            point.update(order=n, raw=line)
            originals.append(point)
    old_reds = [q for q in originals if q["red"]]
    greens = [q for q in originals if not q["red"]]

    # New reds carry the state the original map had at their own time.
    parsed = [(row, _timing_point_fields(row)) for row in new_rows]
    parsed = [(row, q) for row, q in parsed if q is not None]
    carried = _states_at_events(originals, [q["time"] for _row, q in parsed])
    omit_barline = {round(q["time"]) for q in old_reds if q["effects"] & 8}
    reds: list[dict] = []
    for (row, q), state in zip(parsed, carried):
        fields = [f.strip() for f in row.split(",")]
        if state is not None:
            effects = (1 if state.kiai else 0) | (8 if round(q["time"]) in omit_barline else 0)
            fields[3:6] = [str(state.sample_set), str(state.sample_index), str(state.volume)]
            fields[7] = str(effects)
            q.update(sample_set=state.sample_set, sample_index=state.sample_index,
                     volume=state.volume, effects=effects)
        q.update(order=-1, raw=",".join(fields) + newline)
        reds.append(q)

    # Wherever the new set would play differently, a green restores the original.
    events = sorted({q["time"] for q in originals} | {q["time"] for q in reds})
    wanted = _states_at_events(originals, events)
    added: list[dict] = []
    for time, want in zip(events, wanted):
        if want is None:
            continue
        have = _states_at_events(reds + greens + added, [time])[0]
        if have is not None and have.same_as(want):
            continue
        governing = [q for q in reds if q["time"] <= time + 1e-6] or reds[:1]
        meter = governing[-1]["meter"] if governing else 4
        stamp = (f"{time:.{int(decimals)}f}" if decimals > 0 else str(int(round(time))))
        row = (f"{stamp},{-100.0 / want.sv:.12g},{meter},{want.sample_set},"
               f"{want.sample_index},{want.volume},0,{1 if want.kiai else 0}")
        point = _timing_point_fields(row)
        point.update(order=len(body) + len(added), raw=row + newline)
        added.append(point)

    out_body = others + [q["raw"] for q in _ordered(reds + greens + added)] + tail
    # The last line of the section needs an ending even if the file's last
    # line did not have one (the section is followed by more content).
    if end_idx < len(lines) and out_body and not out_body[-1].endswith(("\n", "\r")):
        out_body[-1] += newline

    audio_name = ""
    for line in lines[:header_idx]:
        if line.startswith("AudioFilename:"):
            audio_name = line.split(":", 1)[1].strip()
            break
    analysed_name = Path(getattr(analysis, "source", "")).name

    spare = None
    if not dry_run:
        if backup:
            spare = _backup_before_write(path, raw)
        # Bytes, not write_text: on Windows, text mode would translate our
        # existing "\r\n" into "\r\r\n".
        payload = "".join(lines[:header_idx + 1] + out_body + lines[end_idx:]).encode("utf-8")
        if bom:
            payload = b"\xef\xbb\xbf" + payload
        _atomic_write_bytes(path, payload)
        log_write(path, "inject", str(spare) if spare else None,
                  {"reds_replaced": len(old_reds), "reds_added": len(reds)})

    return {"reds_replaced": len(old_reds), "reds_added": len(reds),
            "greens_kept": len(greens), "greens_added": len(added),
            "backup": str(spare) if spare else None,
            "audio_mismatch": bool(audio_name and analysed_name
                                   and audio_name.lower() != analysed_name.lower()),
            "osu_audio": audio_name, "analysed_audio": analysed_name}


def inject_mapset(folder: str | os.PathLike[str], analysis: Analysis,
                  backup: bool = True, dry_run: bool = False,
                  decimals: int = 0) -> dict:
    """Replace the red lines of every difficulty in a song folder (Phase 21).

    One confirmation for the whole mapset: each ``.osu`` in ``folder`` goes
    through :func:`inject_osu_timing_points` with this analysis, and one bad
    map never stops the rest — its error rides along in its own entry. With
    ``dry_run`` nothing is written anywhere. Plain JSON types:
    ``{"folder", "files": [{"file", "ok", ...summary | "error"}], "ok",
    "failed"}``.
    """
    root = Path(folder)
    if not root.is_dir():
        raise ValueError(f"{root} is not a folder.")
    try:
        maps = sorted(p for p in root.iterdir()
                      if p.is_file() and p.suffix.lower() == ".osu")
    except OSError as exc:
        raise ValueError(f"Could not list {root}: {exc}") from exc
    if not maps:
        raise ValueError(f"No difficulties in {root}.")
    files = []
    for path in maps:
        try:
            summary = inject_osu_timing_points(path, analysis, backup=backup,
                                               dry_run=dry_run, decimals=decimals)
            diff = inject_diff(path, analysis, decimals=decimals)
        except (ValueError, OSError) as exc:
            files.append({"file": path.name, "ok": False, "error": str(exc)})
            continue
        files.append({"file": path.name, "ok": True, **summary, "diff": diff})
    return {"folder": str(root), "files": files,
            "ok": sum(1 for f in files if f["ok"]),
            "failed": sum(1 for f in files if not f["ok"])}


def inject_diff(osu_path: str | os.PathLike[str], analysis: Analysis,
                decimals: int = 0) -> dict:
    """Each old red line beside its new value, and the drift it causes
    (Phase 21, Inject diff).

    Pairs the map's red lines with the analysis' new ones by order: the i-th
    span's timing moves from the i-th old line to the i-th new one, which is
    what the inject writes. ``drift_end_ms`` is where an object sitting at the
    old span's end lands off the new grid — the offset shift plus the span
    length times the beat change, exact given the pairing — or None past the
    last old line, where no span ends. Lines beyond the shorter side ride
    along as ``removed`` (the map's) or ``added`` (the analysis'). Read only,
    plain JSON types.
    """
    path = Path(osu_path)
    if not path.is_file():
        raise ValueError(f"{path} is not a file.")
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except (OSError, ValueError) as exc:
        raise ValueError(f"Could not read {path.name}: {exc}") from exc
    old = []
    inside = False
    for line in osu_read._osu_lines(text):
        stripped = line.strip()
        if stripped == "[TimingPoints]":
            inside = True
            continue
        if inside and stripped.startswith("[") and stripped.endswith("]"):
            break
        if not inside:
            continue
        point = _timing_point_fields(stripped) if stripped else None
        if point is not None and point["red"]:
            old.append({"offset_ms": round(point["time"], 3),
                        "bpm": round(60000.0 / point["beat_length"], 3),
                        "meter": point["meter"]})
    new = []
    for line in exports.osu_timing_text(analysis, decimals).splitlines():
        point = _timing_point_fields(line.strip()) if line.strip() else None
        if point is not None and point["red"]:
            new.append({"offset_ms": round(point["time"], 3),
                        "bpm": round(60000.0 / point["beat_length"], 3),
                        "meter": point["meter"]})
    if not new:
        raise ValueError("This analysis has no usable timing points to inject.")
    pairs = []
    for i, (before, after) in enumerate(zip(old, new)):
        end = old[i + 1]["offset_ms"] if i + 1 < len(old) else None
        drift = None
        if end is not None:
            drift = round((after["offset_ms"] - before["offset_ms"])
                          + (end - before["offset_ms"])
                          * ((60000.0 / before["bpm"]) / (60000.0 / after["bpm"]) - 1), 2)
        pairs.append({"old": before, "new": after,
                      "delta_offset_ms": round(after["offset_ms"] - before["offset_ms"], 3),
                      "delta_bpm": round(after["bpm"] - before["bpm"], 3),
                      "drift_end_ms": drift})
    return {"pairs": pairs, "removed": old[len(new):], "added": new[len(old):]}


# ---------------------------------------------------------------------------
# Audio swap (Phase 19): one mapset's times onto a new encode of its audio
# ---------------------------------------------------------------------------


def _swap_envelope(y: np.ndarray, sr: int) -> np.ndarray:
    """Onset-strength envelope at the comparison rate, for tempo checks."""
    hop = max(1, sr // 86)
    return onsets._fast_onset_envelope(np.asarray(y, dtype=np.float32), sr, hop).astype(np.float64)


def _envelope_period(envelope: np.ndarray, sr: int, hop: int) -> float:
    """Dominant onset period in seconds, 40-400 BPM; octave errors are the
    caller's to normalise, here by comparing up to an octave."""
    working = envelope - envelope.mean()
    n = len(working)
    spectrum = np.abs(np.fft.rfft(working, n)) ** 2
    autocorr = np.fft.irfft(spectrum)[:n] / max(1, n)
    lo, hi = int(60.0 / 400 * sr / hop), int(60.0 / 40 * sr / hop)
    lo, hi = max(1, lo), min(n - 1, max(lo + 1, hi))
    return float(np.argmax(autocorr[lo:hi + 1]) + lo) * hop / sr


def shift_samples(old: np.ndarray, new: np.ndarray, sr: int) -> dict:
    """How far map times move from the old audio to the new one (Phase 19).

    Both mono at one rate: downsampled once to the comparison rate, then a
    full cross-correlation, parabolically refined. Returns ``shift_ms`` with
    ``peak``, ``sharp`` and ``tempo_ratio`` beside it. Refuses instead of
    guessing: a weak or dull peak is no alignment, and a tempo ratio past a
    quarter beat over a song is not a shift. Pure; plain JSON types.
    """
    old = np.asarray(old, dtype=np.float64).ravel()
    new = np.asarray(new, dtype=np.float64).ravel()
    if old.size < sr or new.size < sr:
        raise ValueError("Both audios must hold at least a second to align.")
    if sr % params.SWAP_SR:
        raise ValueError(f"Comparison needs a multiple of {params.SWAP_SR} Hz, got {sr}.")
    factor = sr // params.SWAP_SR
    old_d = signal.resample_poly(old - old.mean(), 1, factor)
    new_d = signal.resample_poly(new - new.mean(), 1, factor)
    n = 1
    while n < len(old_d) + len(new_d):
        n *= 2
    corr = np.fft.irfft(np.fft.rfft(old_d, n) * np.conj(np.fft.rfft(new_d, n)), n)
    denom = float(np.sqrt((old_d @ old_d) * (new_d @ new_d)))
    corr = corr / denom if denom > 0 else corr * 0.0
    peak_idx = int(np.argmax(corr))
    lag = peak_idx if peak_idx <= n // 2 else peak_idx - n
    if 0 < peak_idx < n - 1:
        y0, y1, y2 = corr[peak_idx - 1], corr[peak_idx], corr[peak_idx + 1]
        if y0 - 2 * y1 + y2 < 0:
            lag += 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
    peak, sharp = float(corr[peak_idx]), float(corr[peak_idx] / max(1e-9, np.median(np.abs(corr))))
    old_e = _swap_envelope(np.asarray(old, dtype=np.float32), sr)
    new_e = _swap_envelope(np.asarray(new, dtype=np.float32), sr)
    hop = max(1, sr // 86)
    raw = _envelope_period(new_e, sr, hop) / max(1e-9, _envelope_period(old_e, sr, hop))
    ratio = min((abs(raw / k - 1.0), raw / k) for k in (0.5, 1.0, 2.0))[1]
    ratio = float(ratio)
    # Tempo first: a mismatch names itself even when some peak survived it.
    if abs(ratio - 1.0) > params.SWAP_MAX_TEMPO_DRIFT:
        raise ValueError(f"Tempo mismatch (ratio {ratio:.4f}): times do not map by one shift.")
    if peak < params.SWAP_MIN_PEAK or sharp < params.SWAP_MIN_SHARP:
        raise ValueError(f"No reliable alignment (peak {peak:.2f}, sharpness {sharp:.0f}): "
                         "these do not sound like two encodes of one song.")
    # The lag is old-against-new; map times move the other way.
    return {"shift_ms": round(-lag / params.SWAP_SR * 1000.0, 3), "peak": round(peak, 4),
            "sharp": round(sharp, 1), "tempo_ratio": round(ratio, 5)}


def audio_shift(old_path: str | os.PathLike[str], new_path: str | os.PathLike[str]) -> dict:
    """``shift_samples`` on two decoded files: mono 44.1 kHz from the loader,
    so any two formats it reads compare. Refusals read as messages."""
    old_y, old_sr = audio_io._load_audio(old_path, lambda _message: None)
    new_y, new_sr = audio_io._load_audio(new_path, lambda _message: None)
    if old_sr != new_sr:
        raise ValueError(f"Sample rates differ ({old_sr} vs {new_sr}).")
    return shift_samples(np.asarray(old_y, dtype=np.float64),
                         np.asarray(new_y, dtype=np.float64), old_sr)


def _shifted_number(text: str, shift_ms: float, decimals: int = 3) -> str:
    """A time field moved by the shift: whole milliseconds stay whole (what
    osu!stable reads), the rest keeps ``decimals`` places like inject."""
    value = round(float(text) + shift_ms, decimals)
    whole = round(value)
    if abs(value - whole) < 0.5 * 10 ** -decimals:
        return str(int(whole))
    return f"{value:.{decimals}f}"


def shift_osu_text(text: str, shift_ms: float, audio_name: str | None = None,
                   decimals: int = 3) -> tuple[str, dict]:
    """Every time of one .osu moved by ``shift_ms`` (Phase 19, Audio swap).

    Red and green offsets, object starts, spinner and hold ends, a set
    PreviewTime and editor bookmarks; optionally the AudioFilename with it.
    AudioLeadIn stays: it is a wait before the song starts, not a moment in
    it, and moving it refused every encode with less silence up front on a
    map with a lead-in of 0. Lines keep their shape and order — only the
    numbers move. Storyboard times are not parsed anywhere and stay as they
    were, stated here instead of hidden. An object, preview or bookmark
    landing before zero, and a missing section the move needs, refuses the
    whole text: half a shifted mapset is a corruption, not a subset. Timing
    lines may sit before zero, as osu! allows (a first red line at -3189 ms
    refused a whole real mapset). Returns the shifted text (split
    lines, no trailing newline) with the red lines and objects moved (every
    timing line moves; greens are not counted as red lines).
    """
    lines = osu_read._osu_lines(text)
    section = ""
    out: list[str] = []
    seen = {"timing": False, "objects": False, "general": False, "editor": False}
    moved = {"reds": 0, "objects": 0}

    def move(raw: str) -> str:
        shifted = _shifted_number(raw, shift_ms, decimals)
        if float(shifted) < 0:
            raise ValueError(f"A time lands before zero ({raw} ms): refusing.")
        return shifted

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]") and len(stripped) > 2:
            section = stripped[1:-1].lower()
            out.append(line)
            continue
        if not stripped or stripped.startswith("//"):
            out.append(line)
            continue
        if section == "timingpoints":
            seen["timing"] = True
            fields = line.split(",")
            if len(fields) < 2:
                raise ValueError(f"Unusable timing line: {stripped[:40]}.")
            # A timing line may sit before zero — a first red line there lines
            # the bars up — so only objects and marks refuse a negative time.
            fields[0] = _shifted_number(fields[0], shift_ms, decimals)
            moved["reds"] += _is_red_line(stripped)
            out.append(",".join(fields))
        elif section == "hitobjects":
            seen["objects"] = True
            fields = line.split(",")
            if len(fields) < 5:
                raise ValueError(f"Unusable object line: {stripped[:40]}.")
            try:
                type_bits = int(fields[3])
            except ValueError:
                raise ValueError(f"Unusable object line: {stripped[:40]}.")
            fields[2] = move(fields[2])
            rest = fields[5:]
            if type_bits & 128 and rest:
                head, colon, tail = rest[0].partition(":")
                rest[0] = move(head) + colon + tail if colon else move(head)
            elif type_bits & 8 and rest:
                rest[0] = move(rest[0])
            fields[5:] = rest
            moved["objects"] += 1
            out.append(",".join(fields))
        elif section == "general":
            seen["general"] = True
            name, colon, value = line.partition(":")
            key = name.strip().lower()
            if key == "previewtime" and colon:
                number = value.strip()
                if number and float(number) >= 0:
                    out.append(f"{name.strip()}: {move(number)}")
                    continue
            if key == "audiofilename" and colon and audio_name is not None:
                out.append(f"{name}: {audio_name}")
                continue
            out.append(line)
        elif section == "editor":
            seen["editor"] = True
            name, colon, value = line.partition(":")
            if name.strip().lower() == "bookmarks" and colon and value.strip():
                try:
                    marks = [move(mark) for mark in value.split(",") if mark.strip()]
                except ValueError:
                    raise ValueError("A bookmark lands before zero: refusing.")
                out.append(f"{name}: {','.join(marks)}")
                continue
            out.append(line)
        else:
            out.append(line)
    if not seen["timing"] or not seen["objects"]:
        raise ValueError("No [TimingPoints] or [HitObjects] to move.")
    return "\n".join(out), moved


def preview_audio_swap(map_paths: list, shift_ms: float, decimals: int = 3) -> dict:
    """What a shift would move, read only: per map the red lines, objects and
    new audio name, without touching a byte."""
    rows = []
    for raw in map_paths:
        path = Path(raw)
        try:
            text = path.read_bytes().decode("utf-8-sig")
            _shifted, moved = shift_osu_text(text, shift_ms, decimals=decimals)
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            rows.append({"file": path.name, "ok": False, "error": str(exc)})
            continue
        rows.append({"file": path.name, "ok": True, **moved})
    return {"shift_ms": round(float(shift_ms), 3), "maps": rows,
            "refused": sum(1 for row in rows if not row["ok"])}


def apply_audio_swap(map_paths: list, shift_ms: float, audio_name: str | None = None,
                     dry_run: bool = False, decimals: int = 3) -> dict:
    """Move every time of every map by ``shift_ms``, each file backed up
    first and logged, through the atomic writer. A refusal anywhere writes
    nothing anywhere: the preview runs first inside, and one bad map stops
    the set. Returns per-file bytes written and backups."""
    paths = [Path(raw) for raw in map_paths]
    preview = preview_audio_swap(paths, shift_ms, decimals)
    if preview["refused"]:
        bad = next(row for row in preview["maps"] if not row["ok"])
        raise ValueError(f"{bad['file']}: {bad['error']}")
    if dry_run:
        return {**preview, "written": False}
    rows = []
    for path in paths:
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError(f"Could not decode {path.name} as UTF-8.") from exc
        shifted, _moved = shift_osu_text(text, shift_ms, audio_name, decimals)
        newline = "\r\n" if b"\r\n" in raw else "\n"
        if raw.endswith((b"\n", b"\r")):
            shifted += "\n"
        payload = shifted.replace("\n", newline).encode("utf-8")
        if raw.startswith(b"\xef\xbb\xbf"):
            payload = b"\xef\xbb\xbf" + payload
        spare = _backup_before_write(path, raw)
        _atomic_write_bytes(path, payload)
        log_write(path, "swap", str(spare), {"shift_ms": round(float(shift_ms), 3)})
        rows.append({"file": path.name, "bytes": len(payload), "backup": str(spare)})
    return {**preview, "written": True, "maps": rows}
