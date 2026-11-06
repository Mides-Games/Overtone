"""What the index answers at once: search, and the maps that share an audio file."""
from __future__ import annotations

import os
import time
from contextlib import closing
from pathlib import Path
import overtone as ta
from overtone_library.osu_files import _ROW, _WORD, _match_query
from overtone_library.schema import SEARCH_LIMIT


class Searching:
    """Library's what the index answers at once: search, and the maps that share an audio file."""

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
