"""Reading a Songs folder into the index."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from overtone_library import osu_files, schema
from overtone_library.osu_files import (
    _BEATMAP_COLUMNS,
    _UPSERT_BEATMAP,
    _now,
    _read_folder)
from overtone_library.schema import (
    COMMIT_SECONDS,
    FAILURES_KEPT,
    READERS,
    READ_AHEAD,
    SCHEMA_VERSION,
    is_damaged)


class Scanning:
    """Library's reading a Songs folder into the index."""

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
                            header = osu_files._parse_osu_header(raw, os.path.basename(path), size)
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
                    if progress is not None and (done == total or now - reported >= schema.PROGRESS_SECONDS):
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
