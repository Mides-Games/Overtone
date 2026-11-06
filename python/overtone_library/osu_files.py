"""What a scan reads from a Songs folder: .osu headers, their red lines and their audio."""
from __future__ import annotations

import math
import os
import re
import stat as stat_module
from datetime import datetime, timezone
from pathlib import Path
import overtone as ta
from overtone_paths import data_root

from overtone_library.schema import SCHEMA_PATH


#: A section header line. Both patterns open on a newline, a literal the
#: regex engine can jump to; a ``^`` under re.M gave it none and cost the
#: header pass about 10 s of its 20 over 705 MB of .osu files.
_SECTION = re.compile(rb"\n[ \t]*\[([A-Za-z]+)\]")
#: A hit object line starts with its x coordinate; comments and blanks do not.
_OBJECT_LINE = re.compile(rb"\n[ \t]*[-0-9]")
_HIT_OBJECTS = b"[HitObjects]"
_SCHEMA_LINE = re.compile(r"^--\s*schema-version:\s*(\d+)\s*$", re.M)
_WORD = re.compile(r"\w+", re.UNICODE)


def schema_file_version(text: str | None = None) -> int:
    """The ``schema-version`` that ``library.sql`` states."""
    if text is None:
        text = SCHEMA_PATH.read_text(encoding="utf-8")
    match = _SCHEMA_LINE.search(text)
    if match is None:
        raise ValueError("library.sql states no schema-version.")
    return int(match.group(1))


def default_path() -> Path:
    """Where the index lives: beside the result cache, never beside the app."""
    return data_root() / "library.sqlite3"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _int(value: str, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _red_lines(lines: list[str]) -> tuple[int, float | None]:
    """How many red lines, and the first one's BPM.

    What ``_parse_red_line`` accepts, line for line, in one pass: a green
    line is dropped on its flag before any number is parsed, and there is
    no numpy scalar per line. A map carries a hundred timing lines on
    average, most of them green, and this is the scan's hottest loop.
    """
    count, first = 0, None
    for line in lines:
        fields = line.strip().split(",")
        if len(fields) < 2 or (len(fields) >= 7 and fields[6].strip() != "1"):
            continue
        try:
            offset, beat = float(fields[0]), float(fields[1])
        except ValueError:
            continue
        if not (math.isfinite(offset) and math.isfinite(beat)) or beat <= 0:
            continue
        count += 1
        if first is None:
            first = 60000.0 / beat
    return count, first


def safe_audio_name(name: str) -> bool:
    """Whether an .osu's ``AudioFilename`` can only name a file of its own
    song folder: a bare file name, with no separator, drive, parent or NUL.
    The name comes from a file anyone can write; joined to the folder as it
    is, ``../`` or an absolute path would send the decoder anywhere."""
    return (bool(name) and name not in (".", "..") and not os.path.isabs(name)
            and not any(char in name for char in "/\\:\0"))


def audio_in_folder(folder: str | os.PathLike[str], name: str) -> str | None:
    """The audio ``name`` of song folder ``folder``, when it is a regular file
    inside that folder once every link is followed; None otherwise (missing,
    a refused name, a directory, a link that leads out). The path returned
    is the resolved one, so what is decoded is what was checked."""
    if not safe_audio_name(name):
        return None
    try:
        root = os.path.realpath(folder, strict=True)
        real = os.path.realpath(os.path.join(folder, name), strict=True)
        inside = os.path.commonpath([os.path.normcase(root), os.path.normcase(real)])
        regular = stat_module.S_ISREG(os.stat(real).st_mode)
    except (OSError, ValueError):
        return None
    if not regular or inside != os.path.normcase(root) or real == root:
        return None
    return real


def _missing_audio(folder: str, name: str) -> str:
    """Why a song folder's audio was not read, for the row that says so."""
    if not safe_audio_name(name):
        return f"{name!r} is not a file name in its song folder; refused."
    if os.path.lexists(os.path.join(folder, name)):
        return f"{name} is not a regular file inside its song folder; refused."
    return f"{name} is not in the folder."


def read_osu_header(path: str | os.PathLike[str]) -> dict:
    """What the index keeps of one .osu, without parsing its hit objects.

    Only [General], [Metadata] and the red lines of [TimingPoints] are
    decoded; [Events] (whole storyboards, some of them) is skipped and
    [HitObjects] only counted. Undecodable bytes become U+FFFD rather than
    dropping the map: a broken tag should not hide a whole set. A file with
    none of those four sections (an empty one, as osu! leaves nine of in one
    Songs folder, or junk) raises ``ValueError``: it is not a beatmap, and
    listed it would read as a difficulty with no name.
    """
    return _parse_osu_header(Path(path).read_bytes(), Path(path).name)


def _parse_osu_header(raw: bytes, name: str, size: int | None = None) -> dict:
    """``read_osu_header`` on bytes already read; ``name`` and ``size`` (the
    file's, when only its start was read) are for messages."""
    if len(raw) > ta.MAX_OSU_BYTES:
        raise ValueError(f"{name} is {(size or len(raw)) / 1e6:.1f} MB — that is not a beatmap.")
    if not raw or raw.isspace():
        raise ValueError(f"{name} is empty — that is not a beatmap.")
    # [HitObjects] is the last section and most of the file: find it with a
    # plain byte search, and look for the others only before it.
    cut = raw.find(_HIT_OBJECTS)
    while cut > 0 and raw[cut - 1:cut] not in (b"\n", b" ", b"\t"):
        cut = raw.find(_HIT_OBJECTS, cut + 1)
    head = b"\n" + (raw if cut < 0 else raw[:cut])
    marks = list(_SECTION.finditer(head))
    spans: dict[bytes, tuple[int, int]] = {}
    for n, mark in enumerate(marks):
        end = marks[n + 1].start() if n + 1 < len(marks) else len(head)
        spans.setdefault(mark.group(1), (mark.end(), end))
    if cut < 0 and not any(section in spans for section in (b"General", b"Metadata",
                                                           b"TimingPoints")):
        raise ValueError(f"{name} has no [General], [Metadata], [TimingPoints] or "
                         "[HitObjects] — that is not a beatmap.")
    objects = 0
    if cut >= 0:
        tail = raw[cut + len(_HIT_OBJECTS):]
        after = _SECTION.search(tail)
        objects = len(_OBJECT_LINE.findall(tail, 0, after.start() if after else len(tail)))

    def lines(name: bytes) -> list[str]:
        span = spans.get(name)
        return head[span[0]:span[1]].decode("utf-8", errors="replace").splitlines() if span else []

    general = ta._osu_key_values(lines(b"General"))
    metadata = ta._osu_key_values(lines(b"Metadata"))
    red_lines, first_bpm = _red_lines(lines(b"TimingPoints"))
    return {
        "artist": metadata.get("Artist", ""),
        "title": metadata.get("Title", ""),
        "artist_unicode": metadata.get("ArtistUnicode", ""),
        "title_unicode": metadata.get("TitleUnicode", ""),
        "creator": metadata.get("Creator", ""),
        "version": metadata.get("Version", ""),
        "source": metadata.get("Source", ""),
        "tags": metadata.get("Tags", ""),
        "mode": _int(general.get("Mode", "0")),
        # A name that could leave the song folder is not kept (safe_audio_name).
        "audio_file": audio if safe_audio_name(audio := general.get("AudioFilename", "").strip())
                      else "",
        "red_lines": red_lines,
        "first_bpm": round(first_bpm, 3) if first_bpm is not None else None,
        "objects": objects,
    }


def _match_query(text: str) -> str | None:
    """The user's words as an FTS5 query: every word, each as a prefix.

    Words are quoted, so nothing a user types is read as FTS5 syntax
    (``AND``, ``-``, ``:`` and quotes are all plain text here).
    """
    words = _WORD.findall(text or "")
    return " ".join(f'"{word}"*' for word in words) or None


_BEATMAP_COLUMNS = ("path", "size", "mtime_ns", "artist", "title", "artist_unicode",
                    "title_unicode", "creator", "version", "source", "tags", "mode",
                    "audio_file", "red_lines", "first_bpm", "objects")
_UPSERT_BEATMAP = (
    f"INSERT INTO beatmaps (set_id, {', '.join(_BEATMAP_COLUMNS)}) "
    f"VALUES (?, {', '.join('?' for _ in _BEATMAP_COLUMNS)}) "
    f"ON CONFLICT(path) DO UPDATE SET set_id = excluded.set_id, "
    + ", ".join(f"{c} = excluded.{c}" for c in _BEATMAP_COLUMNS if c != "path"))
_ROW = ("b.id, b.path, b.artist, b.title, b.artist_unicode, b.title_unicode, b.creator, "
        "b.version, b.mode, b.audio_file, b.red_lines, b.first_bpm, b.objects, s.folder, s.name")


def _read_folder(folder: str, known: dict) -> dict:
    """One song folder's files, for ``Library.scan`` to parse and write.

    Runs on a reader thread, so it only lists, stats and reads: parsing
    stays on the scanning thread, which keeps the Python work in one place
    and lets these threads spend their time waiting on the disk. Each .osu
    comes back ``unchanged`` (size and time as indexed), ``read`` (with its
    bytes) or ``unreadable`` (it could not be opened: locked, no permission,
    a path Windows will not open), and the folder's files by lower-case
    name, for the audio the maps name. A folder that cannot be listed comes
    back with ``error`` alone.
    """
    try:
        with os.scandir(folder) as entries:
            files = [entry for entry in entries if entry.is_file()]
    except OSError as exc:
        return {"folder": folder, "error": str(exc)}
    maps: list[tuple[str, str, object]] = []
    for entry in files:
        if not entry.name.lower().endswith(".osu"):
            continue
        old = known.get(entry.path)
        try:
            stat = entry.stat()
            if old is not None and old[0] == stat.st_size and old[1] == stat.st_mtime_ns:
                maps.append(("unchanged", entry.path, None))
                continue
            with open(entry.path, "rb") as handle:
                # Past the limit a file is refused anyway: never hold more.
                raw = handle.read(ta.MAX_OSU_BYTES + 1)
        except OSError as exc:
            maps.append(("unreadable", entry.path, str(exc)))
            continue
        maps.append(("read", entry.path, (stat.st_size, stat.st_mtime_ns, raw)))
    return {"folder": folder, "error": None, "maps": maps,
            "files": {entry.name.lower(): entry for entry in files}}


def _stat(path: str) -> tuple[int, int]:
    """A file's size and modification time, or (-1, -1) when it is not there."""
    try:
        stat = os.stat(path)
    except (OSError, ValueError):
        return -1, -1
    return stat.st_size, stat.st_mtime_ns
