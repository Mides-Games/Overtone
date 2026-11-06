"""Where the index lives, the schema it is built from and its migrations, and a damaged file."""
from __future__ import annotations

import sqlite3
from pathlib import Path


#: The engine lives in ``python/``, data at the repo root.
_HERE = Path(__file__).resolve().parent.parent
ROOT = _HERE.parent
SCHEMA_PATH = ROOT / "python" / "library.sql"
#: The version of ``library.sql`` this code reads and writes.
SCHEMA_VERSION = 3
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
    3: """
CREATE TABLE IF NOT EXISTS analysis (
    path         TEXT PRIMARY KEY,
    size         INTEGER NOT NULL,
    mtime_ns     INTEGER NOT NULL,
    engine       TEXT NOT NULL,
    engine_hash  TEXT NOT NULL,
    verdict      TEXT NOT NULL,
    grid         TEXT NOT NULL DEFAULT '',
    bpm          REAL,
    stability    REAL,
    meter        TEXT NOT NULL DEFAULT '',
    residual_ms  REAL,
    duration     REAL,
    lines        TEXT NOT NULL DEFAULT '[]',
    detail       TEXT NOT NULL DEFAULT '',
    seconds      REAL,
    analyzed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_bpm ON analysis(verdict, bpm);
""",
}
#: An analysis verdict: a grid was found; the engine found no pulse (noise,
#: pads, free time) and gives no BPM; the audio could not be read; the audio
#: is not in the folder.
ANALYSIS_VERDICTS = ("ok", "refused", "error", "no_audio")
#: Raised whenever what an analysis row holds changes shape, so a rerun
#: analyses again what an older one stored. A change to the engine's code
#: needs no bump: ``engine_hash`` already stales those rows.
ANALYSIS_FORMAT = 1
#: Audio files the Rust engine analyses at once when the Beat This! vote is
#: off. On one 90 s fixture (2026-10-25) overtone-cli peaked at 56 MB and the
#: whole Rust path at 101 MB in 2.3 s, so a few fit beside a server. The vote
#: reads the audio in Python and runs its model: 1.46 GB and 50 s on the same
#: file, and v3 alone took 1.78 GB and 42 s, so either runs one at a time.
ANALYSIS_JOBS = 2
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
