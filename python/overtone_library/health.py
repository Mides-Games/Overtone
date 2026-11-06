"""The health check: whose red lines disagree with their own audio."""
from __future__ import annotations

import json
import os
import time
from contextlib import closing
import overtone as ta
import overtone_rust
from overtone_library.engines import _UPSERT_HEALTH, _health_verdict
from overtone_library.osu_files import (
    _missing_audio,
    _now,
    _stat,
    audio_in_folder,
    safe_audio_name)
from overtone_library import schema
from overtone_library.schema import HEALTH_VERDICTS, SEARCH_LIMIT
from overtone_library import engines


class Health:
    """Library's the health check: whose red lines disagree with their own audio."""

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
            audio_path = os.path.join(folder, audio) if safe_audio_name(audio) else ""
            found = audio_in_folder(folder, audio)
            audio_stat = _stat(found) if found else (-1, -1)
            # A .osu gone since the scan is the next scan's to drop, not an error.
            stale = [(path, stat) for path, stat in ((path, _stat(path)) for path in paths)
                     if stat[0] >= 0 and kept.get(path) != (*stat, *audio_stat, schema.HEALTH_GRADER)]
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
            return (path, *stat, *audio_stat, schema.HEALTH_GRADER, engine, verdict, lines, flagged,
                    worst, common, detail, now)

        found = audio_in_folder(os.path.dirname(audio_path), os.path.basename(audio_path)) \
            if audio_path else None
        if audio_stat[0] < 0 or found is None:
            detail = (_missing_audio(os.path.dirname(audio_path), os.path.basename(audio_path))
                      if audio_path else "No audio file is not in the folder.")
            return [row(path, stat, "no_audio", detail=detail) for path, stat in stale]
        try:
            times, weights, duration = engines._attacks(found, engine)
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
