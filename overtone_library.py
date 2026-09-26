"""Overtone's library index: every beatmap under an osu! Songs folder, in SQLite.

The index answers three questions without walking the folder again: which
maps match what the user types (FTS5 full-text search), which maps use this
exact audio file (a size lookup plus at most a hash or two, and the hashes
are remembered), and what the folder holds (sets, difficulties, first BPM).
A fourth costs seconds per song and is kept once answered: whose red lines
disagree with their own audio (the health check, graded by the reference
timing card's own grading).

It is derived data. The Songs folder stays the truth: a scan reads each
.osu's header, skips files whose size and modification time are unchanged,
and drops rows for files that are gone. Deleting the database loses nothing
but the time of the next scan, which is why a damaged one is rebuilt rather
than repaired.

The schema is ``library.sql`` beside this file. Its ``schema-version`` line
is ``SCHEMA_VERSION`` here, stored in ``PRAGMA user_version``; a database
from a newer schema is refused, never rewritten.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import overtone as ta
import overtone_rust

SCHEMA_PATH = Path(__file__).resolve().with_name("library.sql")
#: The version of ``library.sql`` this code reads and writes.
SCHEMA_VERSION = 2
#: ``MIGRATIONS[n]`` takes a version ``n - 1`` database to version ``n``, as
#: library.sql stood at version n: frozen here, since the file moves on. A
#: test holds a migrated index to a new one.
MIGRATIONS: dict[int, str] = {
    2: """
CREATE TABLE IF NOT EXISTS health (
    path            TEXT PRIMARY KEY,
    size            INTEGER NOT NULL,
    mtime_ns        INTEGER NOT NULL,
    audio_size      INTEGER NOT NULL,
    audio_mtime_ns  INTEGER NOT NULL,
    grader          INTEGER NOT NULL,
    engine          TEXT NOT NULL,
    verdict         TEXT NOT NULL,
    lines           INTEGER NOT NULL DEFAULT 0,
    flagged         INTEGER NOT NULL DEFAULT 0,
    worst_ms        REAL,
    common_ms       REAL,
    detail          TEXT NOT NULL DEFAULT '',
    graded_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS health_verdict ON health(verdict, worst_ms);
""",
}
#: A health verdict, worst first, the order a report lists them in: a red
#: line the attacks disagree with; the map or its audio could not be read;
#: the audio is not in the folder; nothing in the audio vouches either way
#: (every line too weak or with too few attacks); no red line at all; every
#: graded line where the attacks put it.
HEALTH_VERDICTS = ("check", "error", "no_audio", "unsure", "no_timing", "ok")
#: Raised whenever the grading changes, so a rerun grades again what an older
#: one judged. The engine that found the attacks is kept beside a verdict and
#: does not stale it: both find the same attacks (the golden gate's 27/27).
HEALTH_GRADER = 1
#: The most beatmaps one search returns; the list is for picking, not reading.
SEARCH_LIMIT = 200
#: The longest a scan goes without telling how far it is. A first scan once
#: sat 6-10 s between reports at one per 100 folders; a rescan of 4,800
#: folders takes about a second, so it makes a handful.
PROGRESS_SECONDS = 0.25
#: The longest a scan holds read rows uncommitted: a scan stopped halfway
#: keeps what it read. By time, not folders, so a rescan does not pay a disk
#: flush per 100 folders it barely touched.
COMMIT_SECONDS = 1.0
#: Threads reading .osu files. The first read of a file is what a first scan
#: waits on: small files never opened before took 10.05 ms each one at a
#: time, 2.95 ms on 4 threads and 3.25 ms on 8 (0.24 ms once read), and a
#: scan of 1,211 freshly copied maps went from 29.0 s to 7.1 s on 4. Parsing
#: and every database write stay on the scanning thread.
READERS = 4
#: Folders read ahead of the one being written, per reader thread.
READ_AHEAD = 8
#: How many failures a scan names; the count is always complete.
FAILURES_KEPT = 20
#: SQLite's result codes for a file that is not, or no longer, a database.
#: A busy or locked index (SQLITE_BUSY, 5) is not damage and is never rebuilt.
_DAMAGED_CODES = (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB)


class DamagedIndex(ValueError):
    """The index file is not a database any more; a scan rebuilds it."""


def is_damaged(exc: BaseException) -> bool:
    """Whether ``exc`` says the index file itself is broken: not busy, not
    from a newer schema, not a folder problem."""
    if isinstance(exc, DamagedIndex):
        return True
    code = getattr(exc, "sqlite_errorcode", None)
    return isinstance(exc, sqlite3.DatabaseError) and code is not None and (
        code & 0xFF) in _DAMAGED_CODES


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


def _attacks(audio: str, engine: str):
    """The attacks of one audio file and its length in seconds, as
    ``grade_reference_timing`` takes them."""
    if engine == "rust":
        return overtone_rust.attacks(audio)
    y, sr = ta._load_audio(audio, lambda _message: None)
    times, weights, _envelope = ta._detect_attacks(y, sr, ta.FIT_HOP)
    return times, weights, y.size / sr


def _health_verdict(report: dict) -> tuple[str, int, int, float | None, float | None, str]:
    """A grade as the health table keeps it: the verdict, the lines graded
    and flagged, the largest disagreement among the flagged, the map's
    common shift, and the flagged lines with the evidence behind each."""
    if not report["ok"]:
        verdict = "no_timing" if report["reason"] == "no_red_lines" else "unsure"
        return verdict, 0, 0, None, None, ""
    lines = report["lines"]
    flagged = [line for line in lines if line["verdict"] == "check"]
    verdict = "check" if flagged else "ok" if report["counts"]["ok"] else "unsure"

    def size(line: dict) -> float:
        return max(abs(line["relative_ms"]) if "offset" in line["issues"] else 0.0,
                   abs(line["drift_ms"]) if "drift" in line["issues"] else 0.0)

    def rounded(value):
        return None if value is None else round(value, 2)

    detail = json.dumps([{"index": line["index"], "offset_ms": line["offset_ms"],
                          "end_ms": round(line["end_ms"], 1), "bpm": round(line["bpm"], 3),
                          "fitted_bpm": round(line["fitted_bpm"], 3), "issues": line["issues"],
                          "relative_ms": rounded(line["relative_ms"]),
                          "offset_se_ms": rounded(line["offset_se_ms"]),
                          "drift_ms": rounded(line["drift_ms"]),
                          "drift_se_ms": rounded(line["drift_se_ms"]),
                          "attacks": line["attacks"], "share": round(line["share"], 3)}
                         for line in flagged]) if flagged else ""
    worst = round(max(size(line) for line in flagged), 2) if flagged else None
    return verdict, len(lines), len(flagged), worst, report["common_offset_ms"], detail


_UPSERT_HEALTH = (
    "INSERT INTO health (path, size, mtime_ns, audio_size, audio_mtime_ns, grader, engine, "
    "verdict, lines, flagged, worst_ms, common_ms, detail, graded_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET "
    + ", ".join(f"{c} = excluded.{c}" for c in (
        "size", "mtime_ns", "audio_size", "audio_mtime_ns", "grader", "engine", "verdict",
        "lines", "flagged", "worst_ms", "common_ms", "detail", "graded_at")))


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
            if is_damaged(exc):
                raise DamagedIndex(f"The library index {self.path} is damaged ({exc}); "
                                   "a scan rebuilds it.") from exc
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
        changed are read, ``READERS`` at a time; rows for files that are gone
        are deleted, so the index holds one Songs folder, the last one
        scanned. What could not be read is counted in ``failed`` and named
        in ``failures``, and is never reported gone: a folder that cannot be
        listed, or a .osu that cannot be opened, keeps what the index knew of
        it (the next scan tries again), while a file that is not a beatmap
        loses its row. A damaged index is deleted and the scan starts over
        (``rebuilt``).

        ``progress``, when given, is called with ``(done, total, removing)``:
        ``done`` folders of ``total`` are in the index, from ``(0, total)``
        as soon as the folder is listed, at most ``PROGRESS_SECONDS`` apart,
        and ``(total, total)`` once the last is written. When rows of files
        that are gone are about to be deleted, one more call says how many;
        the scan returns when they are.
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
        try:
            return self._scan(base, folders, progress, started)
        except (sqlite3.DatabaseError, ValueError) as exc:
            if not is_damaged(exc):
                raise
            # Derived data: the folder is the truth, so a broken file is
            # replaced, not repaired.
            self.reset()
            return {**self._scan(base, folders, progress, started), "rebuilt": True}

    def _scan(self, base: Path, folders: list[str], progress, started: float) -> dict:
        total = len(folders)
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
            unlisted: set[str] = set()   # folders that could not be listed
            not_maps: set[str] = set()   # .osu files that are not beatmaps

            def fail(path: str, detail: str) -> None:
                counts["failed"] += 1
                failures.append({"path": path, "detail": detail})

            def write(found: dict) -> None:
                folder = found["folder"]
                if found["error"] is not None:
                    unlisted.add(folder)
                    fail(folder, found["error"])
                    return
                rows, audio_names, kept = [], set(), False
                for kind, path, value in found["maps"]:
                    if kind == "read":
                        size, mtime_ns, raw = value
                        try:
                            header = _parse_osu_header(raw, os.path.basename(path), size)
                        except ValueError as exc:
                            # Not a beatmap (any more): its row goes, and it
                            # counts as failed, never as removed.
                            fail(path, str(exc))
                            not_maps.add(path)
                            continue
                        rows.append((path, size, mtime_ns, header))
                        audio_names.add(header["audio_file"].lower())
                    elif kind == "unchanged":
                        counts["unchanged"] += 1
                        seen_maps.add(path)
                        audio_names.add(known[path][2].lower())
                        kept = True
                    else:
                        fail(path, value)
                        # Could not open is not gone: the old row stays, and
                        # since its size and time no longer match, the next
                        # scan reads it again.
                        if path in known:
                            seen_maps.add(path)
                            audio_names.add(known[path][2].lower())
                            kept = True
                if not rows and not kept:
                    return
                set_id = set_ids.get(folder)
                if set_id is None:
                    set_id = db.execute("INSERT INTO sets (folder, name) VALUES (?, ?)",
                                        (folder, Path(folder).name)).lastrowid
                    set_ids[folder] = set_id
                seen_sets.add(folder)
                for path, size, mtime_ns, header in rows:
                    db.execute(_UPSERT_BEATMAP, (set_id, path, size, mtime_ns,
                                                 *(header[c] for c in _BEATMAP_COLUMNS[3:])))
                    counts["updated" if path in known else "added"] += 1
                    seen_maps.add(path)
                for name in sorted(audio_names):
                    entry = found["files"].get(name) if name else None
                    if entry is None:
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

            if progress is not None:
                progress(0, total, 0)
            reported = committed = time.perf_counter()
            pool = ThreadPoolExecutor(READERS, thread_name_prefix="library-read")
            try:
                window = READERS * READ_AHEAD
                ahead = deque(pool.submit(_read_folder, folder, known)
                              for folder in folders[:window])
                queued = len(ahead)
                done = 0
                while ahead:
                    found = ahead.popleft().result()
                    if queued < total:
                        ahead.append(pool.submit(_read_folder, folders[queued], known))
                        queued += 1
                    write(found)
                    done += 1
                    now = time.perf_counter()
                    if now - committed >= COMMIT_SECONDS:
                        db.commit()
                        committed = now
                    if progress is not None and (done == total or now - reported >= PROGRESS_SECONDS):
                        progress(done, total, 0)
                        reported = now
            finally:
                pool.shutdown(wait=True, cancel_futures=True)

            def outside(path: str) -> bool:
                return os.path.dirname(path) not in unlisted

            gone = [path for path in known
                    if path not in seen_maps and path not in not_maps and outside(path)]
            counts["removed"] = len(gone)
            if progress is not None and gone:
                progress(total, total, len(gone))
            db.executemany("DELETE FROM beatmaps WHERE path = ?",
                           [(path,) for path in gone + sorted(not_maps & known.keys())])
            db.executemany("DELETE FROM audio WHERE path = ?",
                           [(path,) for path in known_audio
                            if path not in seen_audio and outside(path)])
            db.executemany("DELETE FROM sets WHERE folder = ?",
                           [(folder,) for folder in set_ids
                            if folder not in seen_sets and folder not in unlisted])
            seconds = time.perf_counter() - started
            for key, value in (("root", str(base)), ("scanned_at", _now()),
                               ("scan_seconds", f"{seconds:.3f}"),
                               ("failed", str(counts["failed"])),
                               ("failures", json.dumps(failures[:FAILURES_KEPT]))):
                db.execute("INSERT INTO meta (key, value) VALUES (?, ?) "
                           "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
        return {**self.stats(), **counts, "folders": total,
                "failures": failures[:FAILURES_KEPT], "seconds": round(seconds, 3)}

    # -- reading -------------------------------------------------------------
    def stats(self) -> dict:
        """What the index holds, when it was last brought in step, and what
        that scan could not read."""
        with closing(self._connect()) as db:
            meta = dict(db.execute("SELECT key, value FROM meta"))
            sets, beatmaps, audio = (db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                                     for table in ("sets", "beatmaps", "audio"))
        return {"path": str(self.path), "schema": SCHEMA_VERSION,
                "root": meta.get("root"), "scanned_at": meta.get("scanned_at"),
                "scan_seconds": float(meta["scan_seconds"]) if "scan_seconds" in meta else None,
                "sets": sets, "beatmaps": beatmaps, "audio": audio,
                "failed": int(meta.get("failed", 0)),
                "failures": json.loads(meta.get("failures", "[]"))}

    def covers(self, root: str | os.PathLike[str]) -> bool:
        """Whether the index was built from this Songs folder."""
        indexed = self.stats()["root"]
        return bool(indexed) and os.path.normcase(indexed) == os.path.normcase(
            os.path.abspath(root))

    def search(self, text: str, limit: int = SEARCH_LIMIT) -> dict:
        """Beatmaps matching every word typed, best first, grouped by set.

        Artist, title (romanised and Unicode), creator, difficulty, source
        and tags are searched, each word as a prefix, accents ignored. No
        words lists the library in folder order. Words of one letter each
        are not ranked: the maps come in the index's own order.
        """
        limit = max(1, min(int(limit), SEARCH_LIMIT))
        query = _match_query(text)
        # One letter matches nearly every map ("s": 23,418 of 25,174), and
        # ranking them all was 124 of the 136 ms such a search took; in the
        # index's order FTS5 stops at the limit. A letter is not a search yet.
        order = ("beatmap_search.rowid" if query is not None
                 and all(len(word) == 1 for word in _WORD.findall(text)) else "rank")
        started = time.perf_counter()
        with closing(self._connect()) as db:
            if query is None:
                rows = db.execute(f"SELECT {_ROW} FROM beatmaps b JOIN sets s ON s.id = b.set_id "
                                  "ORDER BY s.folder, b.version LIMIT ?", (limit,)).fetchall()
            else:
                rows = db.execute(f"SELECT {_ROW} FROM beatmap_search "
                                  "JOIN beatmaps b ON b.id = beatmap_search.rowid "
                                  "JOIN sets s ON s.id = b.set_id "
                                  f"WHERE beatmap_search MATCH ? ORDER BY {order} LIMIT ?",
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

    # -- health: each map's red lines against its own audio (Phase 21) -------
    def health(self, engine: str | None = None, progress=None, limit: int | None = None,
               stop=None) -> dict:
        """Grade every indexed beatmap's red lines against its own audio.

        One audio file at a time: its attacks are found once, by the Rust
        sidecar (``engine`` "rust", the default when ``overtone-cli`` is
        found) or by v3's detector ("python"), and each .osu of the set that
        plays it is graded by ``grade_reference_timing`` from its first
        object to its last, where it is played. A verdict is kept
        with the sizes and times of the .osu and the audio it was made from
        and ``HEALTH_GRADER``, committed with its audio file, so a run cut
        short (``limit`` audio files graded, or ``stop`` set between two)
        loses nothing, and the next run grades only what is new or changed.
        Maps come from the last scan; ``progress``, when given, hears
        ``(done, total)`` audio files of this run's work.
        """
        if engine is None:
            engine = "rust" if overtone_rust.find_cli() is not None else "python"
        if engine not in ("rust", "python"):
            raise ValueError(f"No attack engine called {engine!r}.")
        started = time.perf_counter()
        work: list[tuple[str, tuple[int, int], list]] = []
        with closing(self._connect()) as db, db:
            db.execute("DELETE FROM health WHERE path NOT IN (SELECT path FROM beatmaps)")
            kept = {row[0]: row[1:] for row in db.execute(
                "SELECT path, size, mtime_ns, audio_size, audio_mtime_ns, grader FROM health")}
            groups: dict[tuple[str, str], tuple[str, list[str]]] = {}
            for path, folder, audio in db.execute(
                    "SELECT b.path, s.folder, b.audio_file FROM beatmaps b "
                    "JOIN sets s ON s.id = b.set_id ORDER BY s.folder, b.path"):
                groups.setdefault((folder, audio.lower()), (audio, []))[1].append(path)
        for (folder, _key), (audio, paths) in groups.items():
            audio_path = os.path.join(folder, audio) if audio else ""
            audio_stat = _stat(audio_path)
            # A .osu gone since the scan is the next scan's to drop, not an error.
            stale = [(path, stat) for path, stat in ((path, _stat(path)) for path in paths)
                     if stat[0] >= 0 and kept.get(path) != (*stat, *audio_stat, HEALTH_GRADER)]
            if stale:
                work.append((audio_path, audio_stat, stale))
        total = len(work) if limit is None else min(len(work), max(0, int(limit)))
        if progress is not None:
            progress(0, total)
        done = graded = 0
        with closing(self._connect()) as db:
            for audio_path, audio_stat, stale in work[:total]:
                if stop is not None and stop.is_set():
                    break
                rows = self._grade_audio(audio_path, audio_stat, stale, engine)
                with db:
                    db.executemany(_UPSERT_HEALTH, rows)
                done += 1
                graded += len(rows)
                if progress is not None:
                    progress(done, total)
        return {"engine": engine, "graded": graded, "audio": done, "pending": len(work) - done,
                "counts": self.health_report(())["counts"],
                "seconds": round(time.perf_counter() - started, 3)}

    @staticmethod
    def _grade_audio(audio_path: str, audio_stat: tuple[int, int], stale: list,
                     engine: str) -> list[tuple]:
        """The health rows of the maps in ``stale`` that play one audio file.

        A map is graded on the attacks between its first and last objects,
        where it is played: a pack or a practice map covers part of a long
        audio file, and its red lines said nothing of the songs around it
        (one read 1,019 ms of drift from them). Difficulties that share their
        red lines and that range, as most of a set's do, are graded once."""
        now = _now()

        def row(path, stat, verdict, lines=0, flagged=0, worst=None, common=None, detail=""):
            return (path, *stat, *audio_stat, HEALTH_GRADER, engine, verdict, lines, flagged,
                    worst, common, detail, now)

        if audio_stat[0] < 0:
            detail = f"{os.path.basename(audio_path) or 'No audio file'} is not in the folder."
            return [row(path, stat, "no_audio", detail=detail) for path, stat in stale]
        try:
            times, weights, duration = _attacks(audio_path, engine)
        except overtone_rust.SidecarUnavailable:
            raise
        except (RuntimeError, ValueError, OSError) as exc:
            return [row(path, stat, "error", detail=str(exc)) for path, stat in stale]
        rows, graded = [], {}
        for path, stat in stale:
            try:
                beatmap = ta.read_osu_beatmap(path)
            except (OSError, ValueError) as exc:
                rows.append(row(path, stat, "error", detail=str(exc)))
                continue
            objects = [obj for obj in beatmap["hitobjects"] if "time" in obj]
            first = min(obj["time"] for obj in objects) / 1000.0 if objects else 0.0
            last = min(duration, max(obj.get("end_time", obj["time"]) for obj in objects)
                       / 1000.0) if objects else duration
            key = (tuple(ta._beatmap_red_rows(beatmap)), first, last)
            if key not in graded:
                # 0.1 s either side: the objects' own sounds belong to them.
                inside = (times >= first - 0.1) & (times <= last + 0.1)
                graded[key] = _health_verdict(ta.grade_reference_timing(
                    beatmap, times[inside], weights[inside], last))
            rows.append(row(path, stat, *graded[key]))
        return rows

    def health_report(self, verdicts=("check",), limit: int = SEARCH_LIMIT) -> dict:
        """The graded maps with these verdicts, and the verdict counts over
        the index (``ungraded``: maps no run has graded yet). Worst first: by
        verdict, then by ``worst_ms``, the largest disagreement among a
        flagged map's lines. Each flagged line comes with the evidence behind
        it, as the reference timing card shows it: its offset against the
        map's common shift (``relative_ms``) or its drift by the span's end,
        each with its standard error, the attacks and the grid's share."""
        limit = max(1, min(int(limit), SEARCH_LIMIT))
        verdicts = [v for v in HEALTH_VERDICTS if v in verdicts]
        with closing(self._connect()) as db:
            counts = dict(db.execute("SELECT h.verdict, COUNT(*) FROM health h "
                                     "JOIN beatmaps b ON b.path = h.path GROUP BY h.verdict"))
            total = db.execute("SELECT COUNT(*) FROM beatmaps").fetchone()[0]
            order = " ".join(f"WHEN '{v}' THEN {n}" for n, v in enumerate(HEALTH_VERDICTS))
            rows = db.execute(
                "SELECT h.path, s.folder, s.name, b.artist, b.title, b.version, b.mode, h.verdict, "
                "h.lines, h.flagged, h.worst_ms, h.common_ms, h.detail, h.engine, h.graded_at "
                "FROM health h JOIN beatmaps b ON b.path = h.path JOIN sets s ON s.id = b.set_id "
                f"WHERE h.verdict IN ({', '.join('?' for _ in verdicts)}) "
                f"ORDER BY CASE h.verdict {order} END, h.worst_ms DESC, s.folder, b.version "
                "LIMIT ?", (*verdicts, limit)).fetchall() if verdicts else []
        maps = [{"path": path, "folder": folder, "set": name, "artist": artist, "title": title,
                 "version": version, "mode": mode, "verdict": verdict, "lines": lines,
                 "flagged": flagged, "worst_ms": worst, "common_ms": common,
                 "checks": json.loads(detail) if verdict == "check" and detail else [],
                 "detail": detail if verdict in ("error", "no_audio") else "",
                 "engine": engine, "graded_at": graded_at}
                for (path, folder, name, artist, title, version, mode, verdict, lines, flagged,
                     worst, common, detail, engine, graded_at) in rows]
        graded = sum(counts.values())
        return {"counts": {**{v: counts.get(v, 0) for v in HEALTH_VERDICTS},
                           "ungraded": total - graded},
                "maps": maps, "limited": len(rows) == limit}
