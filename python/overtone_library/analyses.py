"""The BPM cache: what each song's audio reads as, kept once answered."""
from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import overtone_rust
from overtone_library.engines import (
    _ANALYSIS_COLUMNS,
    _UPSERT_ANALYSIS,
    _analysis_dict,
    beat_vote)
from overtone_library.osu_files import _missing_audio, _now, _stat, audio_in_folder
from overtone_library.schema import ANALYSIS_JOBS, ANALYSIS_VERDICTS
from overtone_library import engines


class Analyses:
    """Library's the BPM cache: what each song's audio reads as, kept once answered."""

    # -- the BPM cache: each song's audio analysed once ------------------------
    def analyze(self, engine: str | None = None, progress=None, limit: int | None = None,
                stop=None, jobs: int | None = None) -> dict:
        """Analyse the audio of every indexed song not already in the cache.

        One row per audio file a beatmap plays, so the difficulties of a set
        share one analysis. A row holds while the file's size and
        modification time and ``engine_fingerprint`` are what it was made
        from; the rest are analysed by ``engine`` ("rust", the default when
        ``overtone-cli`` is found, or v3's "python"), ``jobs`` at a time for
        Rust and one at a time for v3, and each is committed as it finishes,
        so a run cut short (``limit`` files, or ``stop`` set) loses nothing.
        With the Beat This! vote on, Rust also runs one at a time: the vote
        runs in this process (``ANALYSIS_JOBS``).
        Rows of audio no beatmap plays any more are dropped. ``progress``,
        when given, hears ``(done, total)``.
        """
        if engine is None:
            engine = "rust" if overtone_rust.find_cli() is not None else "python"
        if engine not in ("rust", "python"):
            raise ValueError(f"No analysis engine called {engine!r}.")
        vote = beat_vote()
        jobs = 1 if engine == "python" or vote else max(1, int(jobs or ANALYSIS_JOBS))
        fingerprint = engines.engine_fingerprint(engine)
        started = time.perf_counter()
        with closing(self._connect()) as db, db:
            audio = {os.path.join(folder, name): (folder, name) for folder, name in db.execute(
                "SELECT DISTINCT s.folder, b.audio_file FROM beatmaps b "
                "JOIN sets s ON s.id = b.set_id WHERE b.audio_file != ''")}
            kept = {row[0]: row[1:] for row in db.execute(
                "SELECT path, size, mtime_ns, engine, engine_hash FROM analysis")}
            gone = [path for path in kept if path not in audio]
            db.executemany("DELETE FROM analysis WHERE path = ?", ((p,) for p in gone))
        work = []
        for path in sorted(audio):
            # Only a regular file inside its song folder is looked at: a name
            # from an .osu that leads elsewhere is never stat'ed or decoded.
            found = audio_in_folder(*audio[path])
            stat = _stat(found) if found else (-1, -1)
            if kept.get(path) != (*stat, engine, fingerprint):
                work.append((path, stat, found))
        total = len(work) if limit is None else min(len(work), max(0, int(limit)))
        if progress is not None:
            progress(0, total)

        def one(item):
            path, stat, real = item
            if stop is not None and stop.is_set():
                return None
            if stat[0] < 0 or real is None:
                found = {"verdict": "no_audio", "detail": _missing_audio(*audio[path])}
            else:
                found = engines._analyse_audio(real, engine)
            return tuple([path, *stat, engine, fingerprint] + [
                found.get(c, d) for c, d in (("verdict", ""), ("grid", ""), ("bpm", None),
                                             ("stability", None), ("meter", ""),
                                             ("residual_ms", None), ("duration", None),
                                             ("lines", "[]"), ("detail", ""),
                                             ("seconds", None))] + [_now()])

        done = 0
        with closing(self._connect()) as db, ThreadPoolExecutor(max_workers=jobs) as pool:
            # Rust runs in its own processes, so threads are enough to keep
            # ``jobs`` of them busy; rows are written here, on one thread.
            for row in pool.map(one, work[:total]):
                if row is None:
                    continue
                with db:
                    db.execute(_UPSERT_ANALYSIS, row)
                done += 1
                if progress is not None:
                    progress(done, total)
        return {"engine": engine, "engine_hash": fingerprint, "beat_vote": vote, "jobs": jobs,
                "analysed": done,
                "pending": len(work) - done, "dropped": len(gone),
                "counts": self.analysis_counts(),
                "seconds": round(time.perf_counter() - started, 3)}

    def analysis_counts(self) -> dict:
        """How many audio files have each verdict, and how many songs' audio
        no run has analysed yet (``pending``)."""
        with closing(self._connect()) as db:
            counts = dict(db.execute("SELECT verdict, COUNT(*) FROM analysis GROUP BY verdict"))
            audio = db.execute("SELECT COUNT(*) FROM (SELECT DISTINCT b.set_id, "
                               "lower(b.audio_file) FROM beatmaps b "
                               "WHERE b.audio_file != '')").fetchone()[0]
        analysed = sum(counts.values())
        return {**{v: counts.get(v, 0) for v in ANALYSIS_VERDICTS},
                "pending": max(0, audio - analysed)}

    def analyses(self, paths) -> dict:
        """The cached analysis of each of these audio paths that has one."""
        paths = list(dict.fromkeys(os.fspath(p) for p in paths))
        found = {}
        with closing(self._connect()) as db:
            for start in range(0, len(paths), 500):
                chunk = paths[start:start + 500]
                for row in db.execute(
                        f"SELECT {', '.join(_ANALYSIS_COLUMNS)} FROM analysis "
                        f"WHERE path IN ({', '.join('?' for _ in chunk)})", chunk):
                    found[row[0]] = _analysis_dict(row)
        return found
