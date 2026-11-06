"""The index itself: one SQLite file, and the questions it answers."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from overtone_library.osu_files import default_path
from overtone_library.schema import (
    DamagedIndex,
    MIGRATIONS,
    SCHEMA_PATH,
    SCHEMA_VERSION,
    is_damaged)
from overtone_library.scanning import Scanning
from overtone_library.searching import Searching
from overtone_library.health import Health
from overtone_library.analyses import Analyses


class Library(Scanning, Searching, Health, Analyses):
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
