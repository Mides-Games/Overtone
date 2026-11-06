"""Overtone's library index: every beatmap under an osu! Songs folder, in SQLite.

The index answers three questions without walking the folder again: which
maps match what the user types (FTS5 full-text search), which maps use this
exact audio file (a size lookup plus at most a hash or two, and the hashes
are remembered), and what the folder holds (sets, difficulties, first BPM).
A fourth costs seconds per song and is kept once answered: whose red lines
disagree with their own audio (the health check, graded by the reference
timing card's own grading). A fifth costs the same and is kept the same way:
what each song's audio reads as (the BPM cache, ``Library.analyze``).

It is derived data. The Songs folder stays the truth: a scan reads each
.osu's header, skips files whose size and modification time are unchanged,
and drops rows for files that are gone. Deleting the database loses nothing
but the time of the next scan, which is why a damaged one is rebuilt rather
than repaired.

The schema is ``python/library.sql``. Its ``schema-version`` line
is ``SCHEMA_VERSION`` here, stored in ``PRAGMA user_version``; a database
from a newer schema is refused, never rewritten.
"""
from __future__ import annotations

import os  # noqa: F401  -- the tests patch os.scandir as the scan sees it

import overtone as ta  # noqa: F401
from overtone_library.schema import (  # noqa: F401
    ANALYSIS_FORMAT,
    ANALYSIS_JOBS,
    ANALYSIS_VERDICTS,
    COMMIT_SECONDS,
    DamagedIndex,
    FAILURES_KEPT,
    HEALTH_GRADER,
    HEALTH_VERDICTS,
    MIGRATIONS,
    PROGRESS_SECONDS,
    READERS,
    READ_AHEAD,
    ROOT,
    SCHEMA_PATH,
    SCHEMA_VERSION,
    SEARCH_LIMIT,
    _DAMAGED_CODES,
    _HERE,
    is_damaged)
from overtone_library.osu_files import (  # noqa: F401
    _BEATMAP_COLUMNS,
    _HIT_OBJECTS,
    _OBJECT_LINE,
    _ROW,
    _SCHEMA_LINE,
    _SECTION,
    _UPSERT_BEATMAP,
    _WORD,
    _int,
    _match_query,
    _missing_audio,
    _now,
    _parse_osu_header,
    _read_folder,
    _red_lines,
    _stat,
    audio_in_folder,
    default_path,
    read_osu_header,
    safe_audio_name,
    schema_file_version)
from overtone_library.engines import (  # noqa: F401
    HEALTH_MIN_ATTACKS,
    HEALTH_MIN_SHARE,
    _ANALYSIS_COLUMNS,
    _UPSERT_ANALYSIS,
    _UPSERT_HEALTH,
    _analyse_audio,
    _analysis_dict,
    _attacks,
    _health_verdict,
    beat_vote,
    engine_fingerprint,
    health_actionable)
from overtone_library.index import (  # noqa: F401
    Library)
