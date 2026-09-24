"""Overtone's library index: every beatmap under an osu! Songs folder, in SQLite.

The index answers three questions without walking the folder again: which
maps match what the user types (FTS5 full-text search), which maps use this
exact audio file (a size lookup plus at most a hash or two, and the hashes
are remembered), and what the folder holds (sets, difficulties, first BPM).

It is derived data. The Songs folder stays the truth: a scan reads each
.osu's header, skips files whose size and modification time are unchanged,
and drops rows for files that are gone. Deleting the database loses nothing
but the time of the next scan.

The schema is ``library.sql`` beside this file. Its ``schema-version`` line
is ``SCHEMA_VERSION`` here, stored in ``PRAGMA user_version``; a database
from a newer schema is refused, never rewritten.
"""

from __future__ import annotations

import math
import os
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import overtone as ta

SCHEMA_PATH = Path(__file__).resolve().with_name("library.sql")
#: The version of ``library.sql`` this code reads and writes.
SCHEMA_VERSION = 1
#: ``MIGRATIONS[n]`` takes a version ``n - 1`` database to version ``n``.
#: Version 1 is the schema file itself, so there is nothing here yet.
MIGRATIONS: dict[int, str] = {}
#: The most beatmaps one search returns; the list is for picking, not reading.
SEARCH_LIMIT = 200
#: How often, in folders, a scan reports progress.
PROGRESS_EVERY = 100

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
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Overtone" / "library.sqlite3"


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


def read_osu_header(path: str | os.PathLike[str]) -> dict:
    """What the index keeps of one .osu, without parsing its hit objects.

    Only [General], [Metadata] and the red lines of [TimingPoints] are
    decoded; [Events] (whole storyboards, some of them) is skipped and
    [HitObjects] only counted. Undecodable bytes become U+FFFD rather than
    dropping the map: a broken tag should not hide a whole set.
    """
    raw = Path(path).read_bytes()
    if len(raw) > ta.MAX_OSU_BYTES:
        raise ValueError(f"{Path(path).name} is {len(raw) / 1e6:.1f} MB — that is not a beatmap.")
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
        "audio_file": general.get("AudioFilename", "").strip(),
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


class Library:
    """One index file. Every call opens its own connection, so the bridge's
    threads can share one Library, and a scan never holds the file between
    calls."""

    def __init__(self, path: str | os.PathLike[str] | None = None) -> None:
        self.path = Path(path) if path is not None else default_path()

    # -- opening -------------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        try:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise ValueError(
                    f"The library index was written by a newer Overtone (schema {version}; "
                    f"this one reads {SCHEMA_VERSION}).")
            if version == 0:
                db.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
                db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                db.execute("PRAGMA journal_mode = WAL")
            else:
                for step in range(version + 1, SCHEMA_VERSION + 1):
                    db.executescript(MIGRATIONS[step])
                    db.execute(f"PRAGMA user_version = {step}")
        except sqlite3.DatabaseError as exc:
            db.close()
            raise ValueError(f"Could not open the library index {self.path}: {exc}") from exc
        except BaseException:
            db.close()
            raise
        return db

    def reset(self) -> None:
        """Forget the index: it is rebuilt by the next scan."""
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(f"{self.path}{suffix}").unlink()
            except FileNotFoundError:
                pass

    # -- scanning ------------------------------------------------------------
    def scan(self, root: str | os.PathLike[str], progress=None) -> dict:
        """Bring the index in step with the Songs folder at ``root``.

        One folder level below ``root``, the shape of a Songs folder, plus
        ``root`` itself. Only .osu files whose size or modification time
        changed are read; rows for files that are gone are deleted, so the
        index holds one Songs folder, the last one scanned. ``progress``,
        when given, is called with ``(folders_done, folders_total)``.
        """
        base = Path(os.path.abspath(root))
        if not base.is_dir():
            raise ValueError(f"{base} is not a folder.")
        started = time.perf_counter()
        try:
            with os.scandir(base) as entries:
                folders = [str(base)] + sorted(e.path for e in entries if e.is_dir())
        except OSError as exc:
            raise ValueError(f"Could not list {base}: {exc}") from exc
        counts = {"added": 0, "updated": 0, "unchanged": 0, "removed": 0, "failed": 0}
        failures: list[dict] = []
        with closing(self._connect()) as db, db:
            known = {row[0]: row[1:] for row in db.execute(
                "SELECT path, size, mtime_ns, audio_file FROM beatmaps")}
            known_audio = {row[0]: row[1:] for row in db.execute(
                "SELECT path, size, mtime_ns FROM audio")}
            set_ids = dict(db.execute("SELECT folder, id FROM sets"))
            seen_maps: set[str] = set()
            seen_audio: set[str] = set()
            seen_sets: set[str] = set()
            for done, folder in enumerate(folders, 1):
                if done % PROGRESS_EVERY == 0 or done == len(folders):
                    # Committed as it goes: a scan stopped halfway keeps what
                    # it read, and the next one starts from there.
                    db.commit()
                    if progress is not None:
                        progress(done, len(folders))
                try:
                    with os.scandir(folder) as entries:
                        files = [e for e in entries if e.is_file()]
                except OSError:
                    continue
                osus = [e for e in files if e.name.lower().endswith(".osu")]
                if not osus:
                    continue
                set_id = set_ids.get(folder)
                if set_id is None:
                    set_id = db.execute("INSERT INTO sets (folder, name) VALUES (?, ?)",
                                        (folder, Path(folder).name)).lastrowid
                    set_ids[folder] = set_id
                seen_sets.add(folder)
                audio_names: set[str] = set()
                for entry in osus:
                    try:
                        stat = entry.stat()
                    except OSError:
                        continue
                    seen_maps.add(entry.path)
                    old = known.get(entry.path)
                    if old is not None and old[0] == stat.st_size and old[1] == stat.st_mtime_ns:
                        counts["unchanged"] += 1
                        audio_names.add(old[2].lower())
                        continue
                    try:
                        header = read_osu_header(entry.path)
                    except (OSError, ValueError) as exc:
                        counts["failed"] += 1
                        failures.append({"path": entry.path, "detail": str(exc)})
                        seen_maps.discard(entry.path)
                        continue
                    db.execute(_UPSERT_BEATMAP, (set_id, entry.path, stat.st_size,
                                                 stat.st_mtime_ns,
                                                 *(header[c] for c in _BEATMAP_COLUMNS[3:])))
                    counts["updated" if old is not None else "added"] += 1
                    audio_names.add(header["audio_file"].lower())
                by_name = {e.name.lower(): e for e in files}
                for name in audio_names:
                    entry = by_name.get(name)
                    if not name or entry is None:
                        continue
                    try:
                        stat = entry.stat()
                    except OSError:
                        continue
                    seen_audio.add(entry.path)
                    if known_audio.get(entry.path) == (stat.st_size, stat.st_mtime_ns):
                        continue
                    # A changed file loses its hash: the next lookup computes it again.
                    db.execute("INSERT INTO audio (path, set_id, size, mtime_ns, sha256) "
                               "VALUES (?, ?, ?, ?, NULL) ON CONFLICT(path) DO UPDATE SET "
                               "set_id = excluded.set_id, size = excluded.size, "
                               "mtime_ns = excluded.mtime_ns, sha256 = NULL",
                               (entry.path, set_id, stat.st_size, stat.st_mtime_ns))
            gone = [(path,) for path in known if path not in seen_maps]
            counts["removed"] = len(gone)
            db.executemany("DELETE FROM beatmaps WHERE path = ?", gone)
            db.executemany("DELETE FROM audio WHERE path = ?",
                           [(path,) for path in known_audio if path not in seen_audio])
            db.executemany("DELETE FROM sets WHERE folder = ?",
                           [(folder,) for folder in set_ids if folder not in seen_sets])
            seconds = time.perf_counter() - started
            for key, value in (("root", str(base)), ("scanned_at", _now()),
                               ("scan_seconds", f"{seconds:.3f}")):
                db.execute("INSERT INTO meta (key, value) VALUES (?, ?) "
                           "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
        return {**self.stats(), **counts, "folders": len(folders),
                "failures": failures[:20], "seconds": round(seconds, 3)}

    # -- reading -------------------------------------------------------------
    def stats(self) -> dict:
        """What the index holds and when it was last brought in step."""
        with closing(self._connect()) as db:
            meta = dict(db.execute("SELECT key, value FROM meta"))
            sets, beatmaps, audio = (db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                                     for table in ("sets", "beatmaps", "audio"))
        return {"path": str(self.path), "schema": SCHEMA_VERSION,
                "root": meta.get("root"), "scanned_at": meta.get("scanned_at"),
                "scan_seconds": float(meta["scan_seconds"]) if "scan_seconds" in meta else None,
                "sets": sets, "beatmaps": beatmaps, "audio": audio}

    def covers(self, root: str | os.PathLike[str]) -> bool:
        """Whether the index was built from this Songs folder."""
        indexed = self.stats()["root"]
        return bool(indexed) and os.path.normcase(indexed) == os.path.normcase(
            os.path.abspath(root))

    def search(self, text: str, limit: int = SEARCH_LIMIT) -> dict:
        """Beatmaps matching every word typed, best first, grouped by set.

        Artist, title (romanised and Unicode), creator, difficulty, source
        and tags are searched, each word as a prefix, accents ignored. No
        words lists the library in folder order.
        """
        limit = max(1, min(int(limit), SEARCH_LIMIT))
        query = _match_query(text)
        started = time.perf_counter()
        with closing(self._connect()) as db:
            if query is None:
                rows = db.execute(f"SELECT {_ROW} FROM beatmaps b JOIN sets s ON s.id = b.set_id "
                                  "ORDER BY s.folder, b.version LIMIT ?", (limit,)).fetchall()
            else:
                rows = db.execute(f"SELECT {_ROW} FROM beatmap_search "
                                  "JOIN beatmaps b ON b.id = beatmap_search.rowid "
                                  "JOIN sets s ON s.id = b.set_id "
                                  "WHERE beatmap_search MATCH ? ORDER BY rank LIMIT ?",
                                  (query, limit)).fetchall()
        sets: dict[str, dict] = {}
        for (bid, path, artist, title, artist_u, title_u, creator, version, mode, audio_file,
             red_lines, first_bpm, objects, folder, name) in rows:
            group = sets.setdefault(folder, {
                "folder": folder, "name": name, "artist": artist, "title": title,
                "artist_unicode": artist_u, "title_unicode": title_u, "creator": creator,
                "beatmaps": []})
            group["beatmaps"].append({
                "id": bid, "path": path, "version": version, "creator": creator,
                "mode": mode, "audio_file": audio_file, "red_lines": red_lines,
                "first_bpm": first_bpm, "objects": objects})
        return {"query": text or "", "sets": list(sets.values()), "beatmaps": len(rows),
                "limited": len(rows) == limit,
                "ms": round((time.perf_counter() - started) * 1000, 2)}

    def same_audio_maps(self, audio_path: str | os.PathLike[str]) -> dict:
        """``find_same_audio_maps`` answered from the index.

        Audio of the same size is hashed only when the index has no hash for
        it, or the file changed since; the hash is then kept. A listed .osu
        deleted since the scan is left out. The reply has the walk's shape
        plus ``indexed`` and ``scanned_at``, because an index can be older
        than the folder: a map added since the last scan is not in it.
        """
        audio = Path(audio_path)
        if not audio.is_file():
            raise ValueError(f"{audio} is not a file.")
        size = audio.stat().st_size
        want: str | None = None
        matches: list[dict] = []
        with closing(self._connect()) as db, db:
            meta = dict(db.execute("SELECT key, value FROM meta"))
            scanned = db.execute("SELECT COUNT(*) FROM audio").fetchone()[0]
            rows = db.execute("SELECT a.path, a.set_id, a.mtime_ns, a.sha256, s.folder "
                              "FROM audio a JOIN sets s ON s.id = a.set_id "
                              "WHERE a.size = ? ORDER BY a.path", (size,)).fetchall()
            # The song's own row first, when it sits in the folder: its kept
            # hash is then the one compared against, and the song is never
            # read again.
            mine = os.path.normcase(os.path.abspath(audio))
            rows.sort(key=lambda row: os.path.normcase(row[0]) != mine)
            same_size = 0
            for path, set_id, mtime_ns, digest, folder in rows:
                try:
                    stat = os.stat(path)
                except OSError:
                    continue
                if stat.st_size != size:
                    continue
                same_size += 1
                if digest is None or stat.st_mtime_ns != mtime_ns:
                    try:
                        digest = ta._file_digest(Path(path))
                    except OSError:
                        continue
                    db.execute("UPDATE audio SET sha256 = ?, mtime_ns = ? WHERE path = ?",
                               (digest, stat.st_mtime_ns, path))
                if want is None:
                    want = digest if os.path.normcase(path) == mine else ta._file_digest(audio)
                if digest != want:
                    continue
                name = Path(path).name.lower()
                beatmaps = [{"path": osu, "difficulty": ta._mapset_difficulty_name(
                                Path(osu), {"metadata": {"Version": version}})}
                            for osu, version, audio_file in db.execute(
                                "SELECT path, version, audio_file FROM beatmaps "
                                "WHERE set_id = ? ORDER BY path", (set_id,))
                            if audio_file.lower() == name and os.path.isfile(osu)]
                matches.append({"folder": folder, "audio": path, "beatmaps": beatmaps})
        matches.sort(key=lambda match: match["audio"])
        return {"root": meta.get("root"), "scanned": scanned, "same_size": same_size,
                "matches": matches, "indexed": True, "scanned_at": meta.get("scanned_at")}
