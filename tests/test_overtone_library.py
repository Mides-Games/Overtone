"""Engine tests: The library index and its server."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from overtone import read_osu_beatmap

from engine_support import (_click_track, _mapset_osu, setUpModule, tearDownModule)  # noqa: F401


class LibraryIndexTests(unittest.TestCase):
    """Phase 24, SQL: the Songs folder in SQLite, searched and kept in step."""

    def setUp(self) -> None:
        import overtone_library
        self.ol = overtone_library
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.tmp = Path(scratch.name)
        self.songs = self.tmp / "Songs"
        self.library = overtone_library.Library(self.tmp / "index" / "library.sqlite3")

    def _set(self, folder: str, audio: bytes, diffs, artist="Band", title="Song",
             unicode_title="Song", tags="drum bass electronic") -> Path:
        path = self.songs / folder
        path.mkdir(parents=True)
        (path / "audio.ogg").write_bytes(audio)
        for version in diffs:
            text = _mapset_osu(version, audio="audio.ogg", tags=tags, objects=(1000, 1500, 2000))
            text = (text.replace("Artist:Band", f"Artist:{artist}")
                        .replace("Title:Song", f"Title:{title}")
                        .replace("TitleUnicode:Song", f"TitleUnicode:{unicode_title}"))
            (path / f"{artist} - {title} (Mapper) [{version}].osu").write_text(
                text, encoding="utf-8", newline="")
        return path

    def test_the_schema_file_states_the_version_the_code_reads(self):
        self.assertEqual(self.ol.schema_file_version(), self.ol.SCHEMA_VERSION)
        self.assertEqual(sorted(self.ol.MIGRATIONS), list(range(2, self.ol.SCHEMA_VERSION + 1)))
        with self.assertRaises(ValueError):
            self.ol.schema_file_version("CREATE TABLE t (x);")

    def test_a_header_reads_like_the_full_parser_without_the_objects(self):
        from overtone import read_osu_beatmap
        text = _mapset_osu("Insane", reds=((500, 333.333, 4), (60000, 250.0, 3)),
                           kiai=((20000, True),), objects=(1000, 1200, 1400, 1600))
        text = text.replace("[TimingPoints]", "[Events]\r\n//Storyboard\r\n"
                            "Sprite,Foreground,Centre,\"sb\\x[HitObjects].png\",320,240\r\n"
                            "\r\n[TimingPoints]")
        path = self.tmp / "map.osu"
        path.write_text(text, encoding="utf-8", newline="")
        header = self.ol.read_osu_header(path)
        full = read_osu_beatmap(path)
        self.assertEqual(header["objects"], len(full["hitobjects"]))
        self.assertEqual(header["red_lines"], len(full["timing"]["reds"]))
        self.assertAlmostEqual(header["first_bpm"], full["timing"]["reds"][0][1], places=3)
        self.assertEqual((header["version"], header["audio_file"], header["mode"]),
                         ("Insane", "song.mp3", 0))

    def test_red_lines_are_counted_as_the_parser_reads_them(self):
        from overtone import _parse_red_line
        lines = ["1000,500,4,2,0,60,1,0", "2000,-100,4,2,0,60,0,0", "3000,400",
                 "4000,-50", "5000,400,4,2,0,60,0,0", "6000,-400,4,2,0,60,1,0",
                 "7000,nan,4,2,0,60,1,0", "x,400,4,2,0,60,1,0", "8000,0,4,2,0,60,1,0",
                 "// comment", "", " 9000 , 300 ,4,2,0,60, 1 ,0"]
        want = [red for line in lines if (red := _parse_red_line(line)) is not None]
        count, first = self.ol._red_lines(lines)
        self.assertEqual(count, len(want))
        self.assertEqual(first, want[0][1])

    def test_a_scan_indexes_every_set_and_search_finds_them(self):
        self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy", "Hard"])
        self._set("2 Néko - Kaze", b"OggS" + bytes(200), ["Insane"], artist="Néko",
                  title="Kaze", unicode_title="風の歌", tags="vocaloid")
        (self.songs / "not a set").mkdir()
        seen = []
        report = self.library.scan(self.songs,
                                   progress=lambda done, total, removing: seen.append(total))
        json.dumps(report)
        self.assertEqual((report["sets"], report["beatmaps"], report["audio"]), (2, 3, 2))
        self.assertEqual((report["added"], report["failed"]), (3, 0))
        self.assertEqual(seen[-1], report["folders"])
        found = self.library.search("neko")                  # accents ignored
        self.assertEqual([s["name"] for s in found["sets"]], ["2 Néko - Kaze"])
        self.assertEqual(found["sets"][0]["beatmaps"][0]["objects"], 3)
        self.assertEqual(self.library.search("風の歌")["beatmaps"], 1)
        self.assertEqual(self.library.search("voc")["beatmaps"], 1)       # a prefix
        self.assertEqual(self.library.search("band hard")["beatmaps"], 1)  # every word
        self.assertEqual(self.library.search("")["beatmaps"], 3)
        for text in ('"', "AND", "-x", "title:", "a OR b", "(*)"):   # never FTS5 syntax
            with self.subTest(text=text):
                self.assertIn("sets", self.library.search(text))
        self.assertTrue(self.library.covers(self.songs))
        self.assertFalse(self.library.covers(self.tmp))

    def test_one_letter_lists_in_index_order_and_longer_words_are_ranked(self):
        self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy"], tags="sun")
        self._set("2 Sun - Sun", b"OggS" + bytes(200), ["Sun"], artist="Sun", title="Sun",
                  unicode_title="Sun", tags="sun")
        self.library.scan(self.songs)
        # Ranking every map a letter matches was most of a search's time; a
        # letter lists them as indexed, words rank the map named Sun first.
        self.assertEqual([s["name"] for s in self.library.search("s")["sets"]],
                         ["1 Band - Song", "2 Sun - Sun"])
        self.assertEqual([s["name"] for s in self.library.search("su")["sets"]],
                         ["2 Sun - Sun", "1 Band - Song"])
        self.assertEqual(self.library.search("s")["beatmaps"], self.library.search("su")["beatmaps"])

    def test_a_rescan_reads_only_what_changed_and_forgets_what_is_gone(self):
        first = self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy", "Hard"])
        second = self._set("2 Other - Tune", b"OggS" + bytes(200), ["Normal"],
                           artist="Other", title="Tune")
        self.library.scan(self.songs)
        again = self.library.scan(self.songs)
        self.assertEqual((again["unchanged"], again["added"], again["updated"]), (3, 0, 0))
        easy = next(first.glob("*Easy*.osu"))
        easy.write_text(easy.read_text(encoding="utf-8").replace("Version:Easy", "Version:Cup"),
                        encoding="utf-8", newline="")
        stat = easy.stat()
        import os
        os.utime(easy, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
        next(first.glob("*Hard*.osu")).unlink()
        for file in second.iterdir():
            file.unlink()
        second.rmdir()
        report = self.library.scan(self.songs)
        self.assertEqual((report["updated"], report["removed"], report["unchanged"]), (1, 2, 0))
        self.assertEqual((report["sets"], report["beatmaps"], report["audio"]), (1, 1, 1))
        self.assertEqual(self.library.search("cup")["beatmaps"], 1)
        self.assertEqual(self.library.search("easy")["beatmaps"], 0)   # the old text is gone
        self.assertEqual(self.library.search("tune")["beatmaps"], 0)

    def test_same_audio_comes_from_the_index_and_keeps_its_hashes(self):
        from overtone import find_same_audio_maps
        audio = b"OggS" + bytes(range(100))
        song = self.tmp / "song.ogg"
        song.write_bytes(audio)
        self._set("1 A - B", audio, ["Hard"])
        self._set("2 C - D", b"OggS" + bytes(reversed(range(100))), ["Easy"])   # same size
        self._set("3 E - F", b"OggS" + bytes(300), ["Normal"])
        self.library.scan(self.songs)
        report = self.library.same_audio_maps(song)
        walked = find_same_audio_maps(song, self.songs)
        json.dumps(report)
        self.assertTrue(report["indexed"])
        self.assertEqual(report["same_size"], 2)
        self.assertEqual([(m["audio"], [b["difficulty"] for b in m["beatmaps"]])
                          for m in report["matches"]],
                         [(m["audio"], [b["difficulty"] for b in m["beatmaps"]])
                          for m in walked["matches"]])
        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect(self.library.path)) as db:
            hashed = db.execute("SELECT COUNT(*) FROM audio WHERE sha256 IS NOT NULL").fetchone()[0]
        self.assertEqual(hashed, 2)

    def test_an_index_from_a_newer_schema_or_no_database_is_refused(self):
        import sqlite3
        from contextlib import closing
        self.library.stats()
        with closing(sqlite3.connect(self.library.path)) as db:
            db.execute(f"PRAGMA user_version = {self.ol.SCHEMA_VERSION + 1}")
        with self.assertRaises(ValueError):
            self.library.stats()
        self.library.reset()
        self.assertFalse(self.library.path.exists())
        self.assertEqual(self.library.stats()["beatmaps"], 0)   # rebuilt empty
        self.library.reset()
        self.library.path.write_bytes(b"not a database, just bytes" * 40)
        with self.assertRaises(ValueError):
            self.library.stats()
        with self.assertRaises(ValueError):
            self.library.scan(self.tmp / "missing")

    def test_progress_counts_folders_in_the_index_and_says_what_is_removed(self):
        from unittest import mock
        import shutil
        for n in range(6):
            self._set(f"{n} Band - Song{n}", b"OggS" + bytes(100 + n), ["Easy"], title=f"Song{n}")
        (self.songs / "not a set").mkdir()
        parsed: list[str] = []
        real = self.ol._parse_osu_header

        def parse(raw, name, size=None):
            parsed.append(name)
            return real(raw, name, size)

        calls = []
        with mock.patch.object(self.ol, "_parse_osu_header", parse), \
                mock.patch.object(self.ol, "PROGRESS_SECONDS", 0.0):
            report = self.library.scan(self.songs, progress=lambda done, total, removing:
                                       calls.append((done, total, removing, len(parsed))))
        total = report["folders"]                        # the root, 6 sets, "not a set"
        self.assertEqual(total, 8)
        # From (0, total) as soon as the folder is listed, one call per folder
        # here, and a folder is counted only once its maps are parsed and
        # written (both on the scanning thread, before the call): the reader
        # threads' lead never shows. Before, each call ran one folder ahead
        # of the work and the last came before the removals.
        self.assertEqual([(d, t, r) for d, t, r, _p in calls],
                         [(done, total, 0) for done in range(total + 1)])
        self.assertEqual([p for _d, _t, _r, p in calls], [0, 0, 1, 2, 3, 4, 5, 6, 6])
        for folder in ("0 Band - Song0", "1 Band - Song1"):
            shutil.rmtree(self.songs / folder)
        calls.clear()
        with mock.patch.object(self.ol, "PROGRESS_SECONDS", 3600.0):
            again = self.library.scan(self.songs, progress=lambda done, total, removing:
                                      calls.append((done, total, removing)))
        total = again["folders"]
        # Throttled to the first and the last, and then the rows being removed.
        self.assertEqual(calls, [(0, total, 0), (total, total, 0), (total, total, 2)])
        self.assertEqual((again["removed"], again["beatmaps"]), (2, 4))

    def test_a_folder_that_cannot_be_listed_keeps_its_maps_and_is_named(self):
        from unittest import mock
        self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy", "Hard"])
        locked = self._set("2 Other - Tune", b"OggS" + bytes(200), ["Normal"],
                           artist="Other", title="Tune")
        self.library.scan(self.songs)
        real = os.scandir

        def scandir(path="."):
            if os.fspath(path) == str(locked):
                raise PermissionError(13, "Access is denied", str(locked))
            return real(path)

        with mock.patch.object(self.ol.os, "scandir", scandir):
            report = self.library.scan(self.songs)
        # Not listed is not gone: before, its maps were reported removed and
        # dropped, with no failure named.
        self.assertEqual((report["removed"], report["failed"], report["beatmaps"],
                          report["sets"], report["audio"]), (0, 1, 3, 2, 2))
        self.assertEqual(report["failures"][0]["path"], str(locked))
        self.assertEqual(self.library.search("tune")["beatmaps"], 1)
        self.assertEqual(self.library.stats()["failed"], 1)       # kept for the page
        again = self.library.scan(self.songs)
        self.assertEqual((again["failed"], again["unchanged"], again["removed"]), (0, 3, 0))
        self.assertEqual(self.library.stats()["failures"], [])

    def test_a_map_that_cannot_be_opened_keeps_its_row_until_it_can(self):
        from unittest import mock
        folder = self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy", "Hard"])
        self.library.scan(self.songs)
        hard = next(folder.glob("*Hard*.osu"))
        hard.write_text(hard.read_text(encoding="utf-8").replace("Version:Hard", "Version:Harder"),
                        encoding="utf-8", newline="")
        stat = hard.stat()
        os.utime(hard, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
        real_open = open

        def held(path, *args, **kwargs):          # osu! writing it, say
            if os.fspath(path) == str(hard):
                raise PermissionError(13, "The file is in use", str(hard))
            return real_open(path, *args, **kwargs)

        with mock.patch.object(self.ol, "open", held, create=True):
            report = self.library.scan(self.songs)
        self.assertEqual((report["failed"], report["removed"], report["updated"],
                          report["beatmaps"]), (1, 0, 0, 2))
        self.assertEqual([s["beatmaps"][0]["version"] for s in self.library.search("hard")["sets"]],
                         ["Hard"])                    # the row it had
        again = self.library.scan(self.songs)
        self.assertEqual((again["failed"], again["updated"], again["unchanged"]), (0, 1, 1))
        self.assertEqual(self.library.search("harder")["beatmaps"], 1)

    def test_files_that_are_not_beatmaps_are_failures_not_blank_maps(self):
        folder = self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy", "Hard"])
        (folder / "empty.osu").write_bytes(b"")
        (folder / "junk.osu").write_bytes(bytes(range(256)) * 4)
        report = self.library.scan(self.songs)
        self.assertEqual((report["beatmaps"], report["added"], report["failed"]), (2, 2, 2))
        self.assertTrue(all("not a beatmap" in f["detail"] for f in report["failures"]),
                        report["failures"])
        for path in (folder / "empty.osu", folder / "junk.osu"):
            with self.assertRaises(ValueError):
                self.ol.read_osu_header(path)
        easy = next(folder.glob("*Easy*.osu"))
        easy.write_bytes(b"")                       # emptied since the last scan
        again = self.library.scan(self.songs)
        # Its row goes, counted as failed, never as removed: the file is there.
        self.assertEqual((again["beatmaps"], again["failed"], again["removed"]), (1, 3, 0))
        self.assertEqual(self.library.search("easy")["beatmaps"], 0)
        # Past the size limit only the limit is read, and the true size is said.
        from unittest import mock
        (folder / "huge.osu").write_bytes(b"osu file format v14\r\n" + b"x" * 260_000)
        with mock.patch.object(self.ol.ta, "MAX_OSU_BYTES", 100_000):
            read = dict((p, v) for kind, p, v in self.ol._read_folder(str(folder), {})["maps"])
            huge = self.library.scan(self.songs)
        self.assertEqual(len(read[str(folder / "huge.osu")][2]), 100_001)
        self.assertIn("huge.osu is 0.3 MB", next(f["detail"] for f in huge["failures"]
                                                 if f["path"].endswith("huge.osu")))

    def test_a_damaged_index_is_rebuilt_by_the_next_scan(self):
        import sqlite3
        from contextlib import closing
        self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy", "Hard"])
        for damage in ("junk", "truncated", "pages overwritten"):
            with self.subTest(damage=damage):
                self.library.reset()
                self.library.scan(self.songs)
                with closing(sqlite3.connect(self.library.path)) as db:
                    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                size = self.library.path.stat().st_size
                with open(self.library.path, "r+b") as handle:
                    if damage == "junk":
                        handle.write(b"not a database, just bytes" * 40)
                    elif damage == "truncated":
                        handle.truncate(size // 2)
                    else:                             # every page after the first
                        handle.seek(4096)
                        handle.write(bytes(range(256)) * ((size - 4096) // 256))
                with self.assertRaises((ValueError, sqlite3.DatabaseError)) as caught:
                    self.library.stats()
                self.assertTrue(self.ol.is_damaged(caught.exception), caught.exception)
                # Before, every call failed from here on, a scan included.
                report = self.library.scan(self.songs)
                self.assertTrue(report.get("rebuilt"))
                self.assertEqual((report["beatmaps"], report["added"]), (2, 2))
                self.assertEqual(self.library.search("band")["beatmaps"], 2)

    def test_a_busy_index_is_not_damaged_and_a_newer_one_is_refused_not_rebuilt(self):
        import sqlite3
        from contextlib import closing
        self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy"])
        self.library.scan(self.songs)
        holder = sqlite3.connect(self.library.path)
        holder.execute("BEGIN IMMEDIATE")
        try:
            with closing(sqlite3.connect(self.library.path, timeout=0)) as db, \
                    self.assertRaises(sqlite3.OperationalError) as caught:
                db.execute("INSERT INTO meta (key, value) VALUES ('x', 'y')")
        finally:
            holder.rollback()
            holder.close()
        self.assertFalse(self.ol.is_damaged(caught.exception))
        with closing(sqlite3.connect(self.library.path)) as db:
            db.execute(f"PRAGMA user_version = {self.ol.SCHEMA_VERSION + 1}")
        with self.assertRaises(ValueError) as newer:
            self.library.scan(self.songs)
        self.assertFalse(self.ol.is_damaged(newer.exception))
        self.assertTrue(self.library.path.exists())      # never rewritten

    def test_a_version_1_index_gains_the_health_and_analysis_tables_and_keeps_its_maps(self):
        import sqlite3
        from contextlib import closing
        self._set("1 Band - Song", b"OggS" + bytes(100), ["Easy", "Hard"])
        self.library.scan(self.songs)

        def health_schema():
            with closing(sqlite3.connect(self.library.path)) as db:
                return (db.execute("PRAGMA user_version").fetchone()[0],
                        sorted(" ".join(sql.split()) for (sql,) in db.execute(
                            "SELECT sql FROM sqlite_master WHERE tbl_name IN ('health', "
                            "'analysis') AND sql IS NOT NULL")))

        fresh = health_schema()
        with closing(sqlite3.connect(self.library.path)) as db:
            db.execute("DROP TABLE health")
            db.execute("DROP TABLE analysis")
            db.execute("PRAGMA user_version = 1")
        self.assertEqual(self.library.stats()["beatmaps"], 2)     # opened: migrated
        self.assertEqual(health_schema(), fresh)
        self.assertEqual(fresh[0], self.ol.SCHEMA_VERSION)

    def _clicks(self, name: str, duration: float = 24.0, **tempo) -> Path:
        folder = self.songs / name
        folder.mkdir(parents=True)
        # A kick every 500 ms from 250 (``change_at``/``second_bpm`` move it on).
        _click_track(folder / "audio.wav", 120.0, duration=duration, **tempo)
        return folder

    @staticmethod
    def _timed(folder: Path, version: str, reds, audio: str = "audio.wav",
               first: int = 1000, last: int = 23500) -> Path:
        path = folder / f"Band - Clicks (Mapper) [{version}].osu"
        path.write_text(_mapset_osu(version, audio=audio, reds=reds, objects=(first, last)),
                        encoding="utf-8", newline="")
        return path

    def test_health_grades_each_map_against_its_audio_and_keeps_the_verdict(self):
        from unittest import mock
        clicks = self._clicks("1 Band - Clicks")
        self._timed(clicks, "True", ((250, 500.0, 4), (8250, 500.0, 4), (16250, 500.0, 4)))
        twin = self._timed(clicks, "Twin", ((250, 500.0, 4), (8250, 500.0, 4), (16250, 500.0, 4)))
        moved = self._timed(clicks, "Moved", ((250, 500.0, 4), (8250, 500.0, 4), (16270, 500.0, 4)))
        self._timed(clicks, "Untimed", ())
        gone = self.songs / "2 Band - Gone"
        gone.mkdir()
        self._timed(gone, "Lost", ((250, 500.0, 4),), audio="missing.mp3")
        self.library.scan(self.songs)
        seen = []
        run = self.library.health(engine="python", progress=lambda done, total: seen.append((done, total)))
        json.dumps(run)
        self.assertEqual((run["graded"], run["audio"], run["pending"]), (5, 2, 0))
        self.assertEqual(seen, [(0, 2), (1, 2), (2, 2)])
        report = self.library.health_report(self.ol.HEALTH_VERDICTS)
        json.dumps(report)
        # Worst first: the moved line, the missing audio, no timing, then the rest.
        self.assertEqual([(m["version"], m["verdict"]) for m in report["maps"]],
                         [("Moved", "check"), ("Lost", "no_audio"), ("Untimed", "no_timing"),
                          ("True", "ok"), ("Twin", "ok")])
        moved_report = report["maps"][0]
        self.assertEqual([(c["index"], c["issues"]) for c in moved_report["checks"]], [(2, ["offset"])])
        self.assertAlmostEqual(moved_report["checks"][0]["relative_ms"], -20.0, delta=2.0)
        self.assertAlmostEqual(moved_report["worst_ms"], 20.0, delta=2.0)
        self.assertEqual(report["counts"], {"check": 1, "error": 0, "no_audio": 1, "unsure": 0,
                                            "no_timing": 1, "ok": 2, "ungraded": 0})
        # A rerun grades nothing; a changed .osu is graded alone, a new grading
        # grades everything again.
        self.assertEqual(self.library.health(engine="python")["graded"], 0)
        stat = moved.stat()
        os.utime(moved, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
        self.assertEqual(self.library.health(engine="python")["graded"], 1)
        with mock.patch.object(self.ol, "HEALTH_GRADER", self.ol.HEALTH_GRADER + 1):
            self.assertEqual(self.library.health(engine="python")["graded"], 5)
        twin.unlink()                    # gone since the scan: the next scan's to drop
        with mock.patch.object(self.ol, "HEALTH_GRADER", self.ol.HEALTH_GRADER + 2):
            run = self.library.health(engine="python")
        self.assertEqual((run["graded"], run["counts"]["error"]), (4, 0))

    def test_health_grades_a_map_where_it_is_played(self):
        import soundfile as sf
        # A pack: another song at 124 BPM, then this one on the map's 120 BPM
        # grid from 12.25 s. Graded on every attack, a pack map read up to
        # 1,019 ms of drift from the songs around it (-723 ms here); between
        # its own first and last objects it is right.
        folder = self.songs / "1 Various - Pack"
        folder.mkdir(parents=True)
        sr = 44100
        kicks = np.r_[np.arange(0.25, 12.0, 60 / 124), np.arange(12.25, 24.0, 0.5)]
        y = np.zeros(24 * sr, dtype=np.float32)
        t = np.arange(int(0.04 * sr)) / sr
        kick = (np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.006)).astype(np.float32)
        for at in kicks:
            y[int(at * sr):int(at * sr) + kick.size] += kick
        sf.write(str(folder / "audio.wav"), y, sr)
        self._timed(folder, "Its own part", ((250, 500.0, 4),), first=12500, last=23500)
        self._timed(folder, "Whole file", ((250, 500.0, 4),), first=1000, last=23500)
        self.library.scan(self.songs)
        self.library.health(engine="python")
        maps = self.library.health_report(self.ol.HEALTH_VERDICTS)["maps"]
        self.assertEqual([(m["version"], m["verdict"]) for m in maps],
                         [("Whole file", "check"), ("Its own part", "ok")])
        self.assertGreater(maps[0]["worst_ms"], 20.0)

    def test_health_stops_between_audio_files_and_resumes(self):
        import threading
        for n in (1, 2):
            self._timed(self._clicks(f"{n} Band - Clicks{n}", duration=12.0), f"Map{n}",
                        ((250, 500.0, 4),))
        self.library.scan(self.songs)
        stop = threading.Event()
        stop.set()
        self.assertEqual(self.library.health(engine="python", stop=stop)["graded"], 0)
        first = self.library.health(engine="python", limit=1)
        self.assertEqual((first["graded"], first["pending"], first["counts"]["ungraded"]), (1, 1, 1))
        second = self.library.health(engine="python")
        self.assertEqual((second["graded"], second["pending"], second["counts"]["ok"]), (1, 0, 2))
        with self.assertRaises(ValueError):
            self.library.health(engine="cobol")

    def test_health_reads_the_same_verdicts_through_the_rust_engine(self):
        import overtone_rust as rs
        if rs.find_cli() is None:
            self.skipTest("overtone-cli is not built (cargo build --release -p overtone-cli)")
        from unittest import mock
        clicks = self._clicks("1 Band - Clicks")
        self._timed(clicks, "True", ((250, 500.0, 4), (8250, 500.0, 4), (16250, 500.0, 4)))
        self._timed(clicks, "Moved", ((250, 500.0, 4), (8250, 500.0, 4), (16270, 500.0, 4)))
        self.library.scan(self.songs)
        self.library.health(engine="python")
        python = self.library.health_report(self.ol.HEALTH_VERDICTS)["maps"]
        with mock.patch.object(self.ol, "HEALTH_GRADER", self.ol.HEALTH_GRADER + 1):
            self.assertEqual(self.library.health(engine="rust")["graded"], 2)
        rust = self.library.health_report(self.ol.HEALTH_VERDICTS)["maps"]
        self.assertEqual([(m["version"], m["verdict"]) for m in rust],
                         [(m["version"], m["verdict"]) for m in python])
        self.assertEqual({m["engine"] for m in rust}, {"rust"})
        self.assertAlmostEqual(rust[0]["worst_ms"], python[0]["worst_ms"], delta=0.5)

    # -- the BPM cache ----------------------------------------------------------
    def test_analysis_reads_each_songs_audio_once_and_keeps_it(self):
        from unittest import mock
        clicks = self._clicks("1 Band - Clicks", duration=4.0)
        self._timed(clicks, "Easy", ((250, 500.0, 4),))
        self._timed(clicks, "Hard", ((250, 500.0, 4),))
        gone = self.songs / "2 Band - Gone"
        gone.mkdir()
        self._timed(gone, "Lost", ((250, 500.0, 4),), audio="missing.mp3")
        self.library.scan(self.songs)
        found = {"verdict": "ok", "grid": "precision", "bpm": 120.0, "stability": 0.99,
                 "meter": "4/4", "residual_ms": 0.4, "duration": 4.0,
                 "lines": json.dumps([[250.0, 120.0, 4]]), "seconds": 0.01}
        seen = []
        with mock.patch.object(self.ol, "_analyse_audio", return_value=found) as engine:
            run = self.library.analyze(engine="python",
                                       progress=lambda done, total: seen.append((done, total)))
            json.dumps(run)
            # The two difficulties share one audio file, read once.
            self.assertEqual(engine.call_count, 1)
            self.assertEqual((run["analysed"], run["pending"]), (2, 0))
            self.assertEqual(seen, [(0, 2), (1, 2), (2, 2)])
            self.assertEqual(run["counts"], {"ok": 1, "refused": 0, "error": 0, "no_audio": 1,
                                             "pending": 0})
            # Nothing changed: nothing read. A touched file is read alone, a
            # changed engine reads everything again.
            self.assertEqual(self.library.analyze(engine="python")["analysed"], 0)
            audio = clicks / "audio.wav"
            stat = audio.stat()
            os.utime(audio, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
            self.assertEqual(self.library.analyze(engine="python")["analysed"], 1)
            with mock.patch.object(self.ol, "engine_fingerprint", return_value="another"):
                self.assertEqual(self.library.analyze(engine="python")["analysed"], 2)
            self.assertEqual(engine.call_count, 3)
        cached = self.library.analyses([str(audio), str(gone / "missing.mp3"), "elsewhere.ogg"])
        self.assertEqual(sorted(cached), sorted([str(audio), str(gone / "missing.mp3")]))
        self.assertEqual(cached[str(audio)]["lines"], [{"offset_ms": 250.0, "bpm": 120.0, "meter": 4}])
        self.assertEqual((cached[str(audio)]["bpm"], cached[str(audio)]["engine"]), (120.0, "python"))
        self.assertEqual(cached[str(gone / "missing.mp3")]["verdict"], "no_audio")
        self.assertIsNone(cached[str(gone / "missing.mp3")]["bpm"])
        # A song gone from the folder takes its analysis with it.
        import shutil
        shutil.rmtree(gone)
        self.library.scan(self.songs)
        with mock.patch.object(self.ol, "_analyse_audio", return_value=found):
            self.assertEqual(self.library.analyze(engine="python")["dropped"], 1)
        with self.assertRaises(ValueError):
            self.library.analyze(engine="cobol")

    def test_analysis_keeps_a_refusal_without_inventing_a_bpm(self):
        from unittest import mock
        with mock.patch.object(self.ol.ta, "analyze_audio",
                               side_effect=ValueError("No rhythmic pulse found")):
            refused = self.ol._analyse_audio("noise.wav", "python")
        self.assertEqual((refused["verdict"], refused["detail"]), ("refused", "No rhythmic pulse found"))
        self.assertNotIn("bpm", refused)
        with mock.patch.object(self.ol.ta, "analyze_audio", side_effect=RuntimeError("Cannot load")):
            self.assertEqual(self.ol._analyse_audio("broken.mp3", "python")["verdict"], "error")

    def test_the_beat_this_vote_is_part_of_what_an_analysis_came_from(self):
        from unittest import mock
        with mock.patch.object(self.ol.ta, "_beat_this_session", return_value=None):
            without = self.ol.engine_fingerprint("python")
            self.assertFalse(self.ol.beat_vote())
        with mock.patch.object(self.ol.ta, "_beat_this_session", return_value=object()):
            self.assertNotEqual(self.ol.engine_fingerprint("python"), without)
            self.assertTrue(self.ol.beat_vote())

    def test_analysis_through_the_rust_engine_reads_the_click_tempo(self):
        import overtone_rust as rs
        if rs.find_cli() is None:
            self.skipTest("overtone-cli is not built (cargo build --release -p overtone-cli)")
        clicks = self._clicks("1 Band - Clicks")
        self._timed(clicks, "Easy", ())
        self.library.scan(self.songs)
        run = self.library.analyze(engine="rust", jobs=2)
        self.assertEqual((run["analysed"], run["counts"]["ok"]), (1, 1))
        found = self.library.analyses([str(clicks / "audio.wav")])[str(clicks / "audio.wav")]
        self.assertEqual((found["engine"], found["verdict"], found["grid"]), ("rust", "ok", "precision"))
        self.assertAlmostEqual(found["bpm"], 120.0, delta=0.05)
        self.assertAlmostEqual(found["lines"][0]["bpm"], 120.0, delta=0.05)


class LibraryAudioPathTests(unittest.TestCase):
    """An .osu names its audio, and anyone can write an .osu: the name is
    never followed out of its song folder, at scan, analysis or health."""

    def setUp(self) -> None:
        import overtone_library
        self.ol = overtone_library
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.tmp = Path(scratch.name)
        self.songs = self.tmp / "Songs"
        self.folder = self.songs / "1 Band - Song"
        self.folder.mkdir(parents=True)
        (self.folder / "audio.wav").write_bytes(b"RIFF" + bytes(64))
        (self.folder / "sub").mkdir()
        self.outside = self.tmp / "outside.wav"
        self.outside.write_bytes(b"RIFF" + bytes(64))
        self.library = overtone_library.Library(self.tmp / "index" / "library.sqlite3")

    def _link(self) -> bool:
        try:
            os.symlink(self.outside, self.folder / "link.wav")
        except (OSError, NotImplementedError):  # Windows without the privilege
            return False
        return True

    def test_only_a_bare_file_name_is_an_audio_name(self):
        for bad in ("../outside.wav", "..\\outside.wav", "/etc/passwd", "\\\\host\\share\\a.wav",
                    "C:\\a.wav", "C:a.wav", "sub/a.wav", "..", ".", "", "a\0.wav"):
            self.assertFalse(self.ol.safe_audio_name(bad), repr(bad))
        for good in ("audio.wav", "..audio..mp3", "Song (TV Size).ogg", "風.mp3"):
            self.assertTrue(self.ol.safe_audio_name(good), good)

    def test_only_a_regular_file_inside_the_folder_is_found(self):
        self.assertEqual(self.ol.audio_in_folder(self.folder, "audio.wav"),
                         os.path.realpath(self.folder / "audio.wav"))
        for name in ("../outside.wav", str(self.outside), "sub", "missing.wav", ".."):
            self.assertIsNone(self.ol.audio_in_folder(self.folder, name), name)
        if self._link():
            self.assertIsNone(self.ol.audio_in_folder(self.folder, "link.wav"))

    def test_the_scan_keeps_no_name_that_leaves_the_folder(self):
        (self.folder / "Band - Song (Mapper) [Hard].osu").write_text(
            _mapset_osu("Hard", audio="../../outside.wav", objects=(1000, 2000)),
            encoding="utf-8", newline="")
        self.library.scan(self.songs)
        beatmap = self.library.search("band")["sets"][0]["beatmaps"][0]
        self.assertEqual(beatmap["audio_file"], "")

    def test_an_index_holding_such_a_name_never_decodes_it(self):
        import sqlite3
        from contextlib import closing
        (self.folder / "Band - Song (Mapper) [Hard].osu").write_text(
            _mapset_osu("Hard", audio="audio.wav", objects=(1000, 2000)),
            encoding="utf-8", newline="")
        self.library.scan(self.songs)
        names = ["../../outside.wav", str(self.outside), "sub"]
        if self._link():
            names.append("link.wav")
        for name in names:
            # An index written before the scan refused such names.
            with closing(sqlite3.connect(self.library.path)) as db, db:
                db.execute("UPDATE beatmaps SET audio_file = ?", (name,))
            with mock.patch.object(self.ol, "_analyse_audio") as engine, \
                    mock.patch.object(self.ol, "_attacks") as attacks:
                run = self.library.analyze(engine="python")
                self.library.health(engine="python")
            engine.assert_not_called()
            attacks.assert_not_called()
            self.assertEqual(run["counts"]["no_audio"], 1, name)
            cached = self.library.analyses([os.path.join(self.folder, name)])
            self.assertIn("refused", next(iter(cached.values()))["detail"], name)
            self.assertEqual(self.library.health_report(("no_audio",))["counts"]["no_audio"], 1)


class LibraryServerTests(unittest.TestCase):
    """The library API: the index and the BPM cache over HTTP, behind a token."""

    def setUp(self) -> None:
        import threading
        import overtone_library
        import overtone_server
        self.server_module = overtone_server
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.tmp = Path(scratch.name)
        songs = self.tmp / "Songs" / "1 Band - Song"
        songs.mkdir(parents=True)
        (songs / "audio.ogg").write_bytes(b"OggS" + bytes(100))
        (songs / "Band - Song (Mapper) [Hard].osu").write_text(
            _mapset_osu("Hard", audio="audio.ogg", objects=(1000, 2000)), encoding="utf-8",
            newline="")
        self.audio = str(songs / "audio.ogg")
        self.service = overtone_server.Service(self.tmp / "Songs", self.tmp / "library.sqlite3",
                                               engine="python")
        self.server = overtone_server.serve(self.service, "127.0.0.1", 0, "secret", log=False)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.ol = overtone_library

    def _call(self, method: str, path: str, body=None, token: str | None = "secret"):
        import urllib.error
        import urllib.request
        data = body if isinstance(body, bytes) else (
            json.dumps(body).encode() if body is not None else None)
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if token is not None:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=10) as reply:
                return reply.status, json.loads(reply.read())
        except urllib.error.HTTPError as exc:
            with exc:
                raw = exc.read()
            return exc.code, json.loads(raw) if raw.startswith(b"{") else raw

    def _wait(self, job: str) -> dict:
        import time
        # An analysis loads the Beat This! model first: seconds, more on a busy machine.
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            state = self._call("GET", "/api/status")[1]["jobs"][job]
            if not state["running"]:
                return state
            time.sleep(0.05)
        self.fail(f"the {job} never ended")

    def test_every_request_needs_the_token(self):
        self.assertEqual(self._call("GET", "/api/status", token=None)[0], 401)
        self.assertEqual(self._call("GET", "/api/status", token="wrong")[0], 401)
        self.assertEqual(self._call("POST", "/api/scan", {}, token=None)[0], 401)
        self.assertEqual(self._call("GET", "/api/status")[0], 200)

    def test_a_scan_then_an_analysis_fill_the_songs_with_their_bpm(self):
        from unittest import mock
        self.assertEqual(self._call("POST", "/api/scan"), (202, {"started": "scan"}))
        scan = self._wait("scan")
        self.assertIsNone(scan["error"])
        self.assertEqual(scan["result"]["added"], 1)
        status, songs = self._call("GET", "/api/songs?q=band")
        self.assertEqual(status, 200)
        beatmap = songs["sets"][0]["beatmaps"][0]
        self.assertEqual((beatmap["audio_path"], beatmap["analysis"]), (self.audio, None))
        found = {"verdict": "ok", "grid": "precision", "bpm": 150.0, "lines": "[[1000.0, 150.0, 4]]"}
        with mock.patch.object(self.ol, "_analyse_audio", return_value=found):
            self.assertEqual(self._call("POST", "/api/analyze", {"limit": 5})[0], 202)
            analysis = self._wait("analyze")
        self.assertIsNone(analysis["error"])
        self.assertEqual((analysis["done"], analysis["result"]["analysed"]), (1, 1))
        beatmap = self._call("GET", "/api/songs?q=band")[1]["sets"][0]["beatmaps"][0]
        self.assertEqual((beatmap["analysis"]["bpm"], beatmap["analysis"]["verdict"]), (150.0, "ok"))
        from urllib.parse import quote
        status, one = self._call("GET", f"/api/analysis?path={quote(self.audio)}")
        self.assertEqual((status, one["lines"]), (200, [{"offset_ms": 1000.0, "bpm": 150.0, "meter": 4}]))
        self.assertEqual(self._call("GET", "/api/analysis?path=elsewhere.ogg")[0], 404)
        self.assertEqual(self._call("GET", "/api/status")[1]["analysis"]["ok"], 1)

    def test_bad_requests_are_named_not_run(self):
        self.assertEqual(self._call("POST", "/api/analyze", {"limit": "many"})[0], 400)
        self.assertEqual(self._call("POST", "/api/analyze", b"[1, 2]")[0], 400)
        self.assertEqual(self._call("POST", "/api/analyze", b"{not json")[0], 400)
        self.assertEqual(self._call("GET", "/api/songs?limit=lots")[0], 400)
        self.assertEqual(self._call("GET", "/api/analysis")[0], 400)
        self.assertEqual(self._call("GET", "/api/nothing")[0], 404)
        self.assertEqual(self._call("DELETE", "/api/status")[0], 501)
        self.assertEqual(self._call("POST", "/api/stop"), (200, {"stopping": False}))

    def test_one_run_of_each_job_at_a_time(self):
        import threading
        release = threading.Event()
        self.assertTrue(self.service.analyze_job.start(lambda progress, stop: release.wait(5)))
        self.addCleanup(release.set)
        self.assertEqual(self._call("POST", "/api/analyze")[0], 409)
        self.assertEqual(self._call("POST", "/api/stop"), (202, {"stopping": True}))
        self.assertTrue(self.service.analyze_job.stop.is_set())
        release.set()
        self._wait("analyze")

    def test_the_server_can_turn_the_beat_this_vote_off(self):
        import overtone as ta
        from unittest import mock
        with mock.patch.object(ta, "_BEAT_THIS_SESSION", [object()]):
            self.assertTrue(self._call("GET", "/api/status")[1]["beat_vote"])
            self.server_module.disable_beat_vote()
            self.assertFalse(self._call("GET", "/api/status")[1]["beat_vote"])
            self.assertEqual(ta._BEAT_THIS_SESSION, [None])

    def test_measurement_runs_are_queued_followed_and_refused_over_http(self):
        import time
        status, overview = self._call("GET", "/api/v1/runs")
        self.assertEqual(status, 200)
        self.assertIn("anime-single", [s["id"] for s in overview["stages"]])
        self.assertEqual((overview["runs"], overview["queue"]["running"]), ([], None))
        self.assertEqual(self._call("POST", "/api/v1/runs", {"tool": "rm"})[0], 400)
        self.assertEqual(self._call("POST", "/api/v1/runs", {"stage": "anime-single",
                                                              "jobs": 99})[0], 400)
        # No index yet: the run is queued, fails, and says why in its log.
        status, meta = self._call("POST", "/api/v1/runs", {"stage": "anime-single",
                                                            "engine": "python", "max_songs": 1})
        self.assertEqual((status, meta["state"]), (202, "queued"))
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            detail = self._call("GET", f"/api/v1/runs/{meta['id']}")[1]
            if detail["state"] not in ("queued", "running"):
                break
            time.sleep(0.1)
        self.assertEqual(detail["state"], "failed")
        self.assertTrue(detail["log"])
        self.assertEqual(self._call("GET", f"/api/v1/runs/{meta['id']}/result")[0], 404)
        self.assertEqual(self._call("POST", f"/api/v1/runs/{meta['id']}/stop"),
                         (200, {"stopping": False}))
        for bad in ("nope", "..%2F..%2Fetc", "20261025-000000-abcdef"):
            self.assertEqual(self._call("GET", f"/api/v1/runs/{bad}")[0], 404)
        self.assertEqual([r["id"] for r in self._call("GET", "/api/v1/runs")[1]["runs"]],
                         [meta["id"]])

    def test_sessions_are_signed_by_the_token_and_expire(self):
        sessions = self.server_module.Sessions("secret")
        cookie = sessions.new()
        self.assertTrue(sessions.valid(cookie))
        self.assertFalse(self.server_module.Sessions("another").valid(cookie))
        self.assertFalse(sessions.valid(cookie[:-1] + ("0" if cookie[-1] != "0" else "1")))
        self.assertFalse(sessions.valid(None))
        expired = self.server_module.Sessions("secret", ttl=-1)
        self.assertFalse(expired.valid(expired.new()))

    def test_the_runs_page_signs_in_with_the_token_and_serves_nothing_else(self):
        import http.client
        port = self.server.server_address[1]

        def request(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            connection.request(method, path, body=body, headers=headers or {})
            reply = connection.getresponse()
            data = reply.read()
            connection.close()
            return reply.status, dict(reply.getheaders()), data

        form = {"Content-Type": "application/x-www-form-urlencoded"}
        status, headers, _ = request("GET", "/")
        self.assertEqual((status, headers["Location"]), (303, "/login"))
        self.assertEqual(request("GET", "/login")[0], 200)
        self.assertEqual(request("POST", "/login", "token=wrong", form)[0], 401)
        status, headers, _ = request("POST", "/login", "token=secret", form)
        self.assertEqual(status, 303)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        cookie = headers["Set-Cookie"].split(";")[0]
        status, _, page = request("GET", "/", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertIn(b"/api/v1/runs", page)
        self.assertEqual(request("GET", "/api/v1/whoami", headers={"Cookie": cookie})[0], 200)
        # Nothing but the page: no file beside it, no desktop bridge.
        for path in ("/../python/overtone.py", "/server_page/runs.html", "/index.html"):
            self.assertEqual(request("GET", path, headers={"Cookie": cookie})[0], 404, path)
        call = json.dumps({"args": []})
        self.assertEqual(request("POST", "/api/v1/bridge/settings", call,
                                 {"Cookie": cookie, "X-Overtone": "1"})[0], 404)
        # A cookie alone changes nothing: no cross-site form can add the header.
        run = json.dumps({"tool": "rm"})
        self.assertEqual(request("POST", "/api/v1/runs", run, {"Cookie": cookie})[0], 401)
        self.assertEqual(request("POST", "/api/v1/runs", run,
                                 {"Cookie": cookie, "X-Overtone": "1"})[0], 400)
        status, headers, _ = request("POST", "/logout", headers={"Cookie": cookie,
                                                                 "X-Overtone": "1"})
        self.assertEqual((status, headers["Location"]), (303, "/login"))
        # The bearer token still works for scripts.
        self.assertEqual(request("GET", "/api/status",
                                 headers={"Authorization": "Bearer secret"})[0], 200)

    def test_the_library_analysis_yields_to_measurement_runs(self):
        import threading
        import time
        import types
        server = self.server_module

        class Job:
            def __init__(self, running=False):
                self.running, self.stop = running, threading.Event()

            def state(self):
                return {"running": self.running}

        class Fake:
            def __init__(self, queue):
                self.queue, self.analysed = queue, 0
                self.scan_job, self.analyze_job = Job(), Job()
                self.runs = types.SimpleNamespace(state=lambda: self.queue)

            def scan(self):
                return server.HTTPStatus.CONFLICT, {}

            def analyze(self):
                self.analysed += 1
                self.analyze_job.running = True

        busy = Fake({"running": None, "queued": ["r1"]})
        server._every_once(busy, poll=0)
        self.assertEqual(busy.analysed, 0)

        idle = Fake({"running": None, "queued": []})

        def sleep(_seconds):
            if idle.analyze_job.stop.is_set():
                idle.analyze_job.running = False
            idle.queue = {"running": "r2", "queued": []}

        with mock.patch.object(server.time, "sleep", sleep):
            server._every_once(idle, poll=0)
        self.assertEqual(idle.analysed, 1)
        self.assertTrue(idle.analyze_job.stop.is_set())
        self.assertIs(server.time, time)

    def _serve(self, **limits) -> int:
        """A second server on the same service, with its own limits; its port."""
        import threading
        server = self.server_module.serve(self.service, "127.0.0.1", 0, "secret", log=False,
                                          **limits)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server.server_address[1]

    @staticmethod
    def _request(port, method, path, body=None, headers=None):
        import http.client
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            reply = connection.getresponse()
            return reply.status, dict(reply.getheaders()), reply.read()
        finally:
            connection.close()

    def test_wrong_tokens_are_limited_across_the_server_without_a_sleep(self):
        import time
        now = [1000.0]
        logins = self.server_module.FailedLogins(limit=3, window=60.0, clock=lambda: now[0])
        port = self._serve(logins=logins)
        form = {"Content-Type": "application/x-www-form-urlencoded"}

        def bearer(token):
            return self._request(port, "GET", "/api/status",
                                 headers={"Authorization": f"Bearer {token}"})

        started = time.monotonic()
        self.assertEqual(bearer("wrong")[0], 401)
        self.assertEqual(self._request(port, "POST", "/login", "token=wrong", form)[0], 401)
        self.assertEqual(bearer("nope")[0], 401)
        # No guess holds its thread asleep any more (it was a second each).
        self.assertLess(time.monotonic() - started, 1.0)
        # Past the limit no token is checked at all, the right one included.
        status, headers, _ = bearer("secret")
        self.assertEqual((status, headers.get("Retry-After")), (429, "60"))
        status, _, page = self._request(port, "POST", "/login", "token=secret", form)
        self.assertEqual(status, 429)
        self.assertIn(b"Too many wrong tokens", page)
        # A signed-in browser keeps working, and asking with no token is no guess.
        cookie = f"{self.server_module.SESSION_COOKIE}={self.service.sessions.new()}"
        self.assertEqual(self._request(port, "GET", "/api/v1/whoami",
                                       headers={"Cookie": cookie})[0], 200)
        self.assertEqual(self._request(port, "GET", "/api/status")[0], 401)
        now[0] += 30
        self.assertEqual(bearer("secret")[0], 429)
        now[0] += 30
        self.assertEqual(bearer("secret")[0], 200)

    def test_idle_connections_are_capped_and_dropped(self):
        import socket
        import time
        port = self._serve(max_connections=3, timeout=2.0)
        idle = [socket.create_connection(("127.0.0.1", port), timeout=10) for _ in range(2)]
        self.addCleanup(lambda: [sock.close() for sock in idle])
        # Below the cap, connections that say nothing do not hold up a request.
        status, _, _ = self._request(port, "GET", "/api/status",
                                     headers={"Authorization": "Bearer secret"})
        self.assertEqual(status, 200)
        idle.append(socket.create_connection(("127.0.0.1", port), timeout=10))
        # At the cap, one more is told so and closed, never given a thread.
        with socket.create_connection(("127.0.0.1", port), timeout=10) as extra:
            reply = b""
            while chunk := extra.recv(4096):
                reply += chunk
        self.assertTrue(reply.startswith(b"HTTP/1.0 503 "), reply[:40])
        self.assertIn(b"Retry-After", reply)
        # An idle connection is dropped once it has said nothing for the timeout.
        started = time.monotonic()
        for sock in idle:
            self.assertEqual(sock.recv(1), b"")
        self.assertLess(time.monotonic() - started, 8.0)
        deadline = time.monotonic() + 5
        while True:
            try:
                status = self._request(port, "GET", "/api/status",
                                       headers={"Authorization": "Bearer secret"})[0]
            except OSError:
                status = None
            if status == 200 or time.monotonic() > deadline:
                break
            time.sleep(0.05)
        self.assertEqual(status, 200)

    def test_the_token_is_generated_once_and_kept_private(self):
        from unittest import mock
        path = self.tmp / "token"
        with mock.patch.dict(os.environ, {self.server_module.TOKEN_ENV: ""}):
            first = self.server_module.load_token(str(path))
            self.assertGreaterEqual(len(first), 32)
            self.assertEqual(self.server_module.load_token(str(path)), first)
        if os.name != "nt":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        from_env = "e" * self.server_module.MIN_TOKEN
        with mock.patch.dict(os.environ, {self.server_module.TOKEN_ENV: from_env}):
            self.assertEqual(self.server_module.load_token(str(path)), from_env)
        # A short token is guessable: the server refuses to start on one.
        with mock.patch.dict(os.environ, {self.server_module.TOKEN_ENV: "from-env"}):
            with self.assertRaises(SystemExit):
                self.server_module.load_token(str(path))
        path.write_text("short", encoding="utf-8")
        with mock.patch.dict(os.environ, {self.server_module.TOKEN_ENV: ""}):
            with self.assertRaises(SystemExit):
                self.server_module.load_token(str(path))


if __name__ == "__main__":
    unittest.main()
