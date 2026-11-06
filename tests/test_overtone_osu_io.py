"""Engine tests: .osu and .osz reading and writing, the audio swap and the write history."""
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
from overtone import (Analysis, TimingPoint, _is_red_line, _robust_local_bpms,
                      inject_osu_timing_points, export_osz, osu_beatmap_text,
                      snap_timing_points, read_osu_red_lines, compare_map_timing,
                      scan_beatmap_folder, read_osu_beatmap, beatmap_text)

from engine_support import (_FULL_OSU, _MAP_OSU, _SOUND_MAP, _compare_analysis,
                            _copy_map, _grid_analysis, _heard_at, _timing_rows,
                            _write_osu, setUpModule, tearDownModule)  # noqa: F401


class OsuInjectTests(unittest.TestCase):
    FAKE_OSU = ("osu file format v14\n[General]\nAudioFilename: song.mp3\n"
                "[TimingPoints]\n"
                "353,266.666666666667,4,2,0,100,1,0\n"
                "1000,500,4,2,0,60,0,0\n"
                "13153,270.270270270270,4,2,0,85,1,1\n"
                "[HitObjects]\n64,80,1000,1,0\n")

    def _analysis(self, source="song.mp3"):
        from types import SimpleNamespace
        return SimpleNamespace(source=source,
                               points=[TimingPoint(360.0, 224.0, 0.95, 1),
                                       TimingPoint(14000.0, 222.0, 0.9, 60)])

    def test_replace_reds_keeps_greens_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            original = self.FAKE_OSU.replace("\n", "\r\n").encode("utf-8")
            target.write_bytes(original)
            summary = inject_osu_timing_points(target, self._analysis())
            out = target.read_bytes()
            self.assertEqual(summary["reds_replaced"], 2)
            self.assertEqual(summary["reds_added"], 2)
            self.assertEqual(summary["greens_kept"], 1)
            self.assertFalse(summary["audio_mismatch"])
            self.assertIn(b"1000,500,4,2,0,60,0,0\r\n", out)  # green untouched
            self.assertNotIn(b"266.666666666667", out)  # old red gone
            self.assertTrue((Path(str(target) + ".bak")).is_file())
            self.assertEqual((Path(str(target) + ".bak")).read_bytes(), original)
            # Idempotent: injecting again changes nothing.
            inject_osu_timing_points(target, self._analysis(), backup=False)
            second = target.read_bytes()
            inject_osu_timing_points(target, self._analysis(), backup=False)
            self.assertEqual(target.read_bytes(), second)

    def test_missing_section_and_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "empty.osu"
            target.write_text("[General]\n[HitObjects]\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                inject_osu_timing_points(target, self._analysis())
            target2 = Path(tmp) / "other.osu"
            target2.write_text("[General]\nAudioFilename: song.mp3\n[TimingPoints]\n", encoding="utf-8")
            summary = inject_osu_timing_points(target2, self._analysis(source="different.wav"),
                                               backup=False)
            self.assertEqual(summary["reds_replaced"], 0)
            self.assertTrue(summary["audio_mismatch"])


class InjectDiffTests(unittest.TestCase):
    FAKE_OSU = ("osu file format v14\n[General]\nAudioFilename: song.mp3\n"
                "[TimingPoints]\n"
                "353,266.666666666667,4,2,0,100,1,0\n"
                "1000,500,4,2,0,60,0,0\n"
                "13153,270.270270270270,4,2,0,85,1,1\n"
                "[HitObjects]\n64,80,1000,1,0\n")

    def _analysis(self):
        from types import SimpleNamespace
        return SimpleNamespace(source="song.mp3",
                               points=[TimingPoint(360.0, 224.0, 0.95, 1),
                                       TimingPoint(14000.0, 222.0, 0.9, 60)])

    def test_pairs_by_order_with_drift_and_leftovers(self) -> None:
        from overtone import inject_diff
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_bytes(self.FAKE_OSU.replace("\n", "\r\n").encode("utf-8"))
            diff = inject_diff(target, self._analysis())
            json.dumps(diff)
            self.assertEqual(len(diff["pairs"]), 2)
            first, second = diff["pairs"]
            self.assertEqual(first["old"], {"offset_ms": 353.0, "bpm": 225.0, "meter": 4})
            self.assertEqual(first["new"], {"offset_ms": 360, "bpm": 224.0, "meter": 4})
            self.assertEqual((first["delta_offset_ms"], first["delta_bpm"]), (7.0, -1.0))
            self.assertAlmostEqual(first["drift_end_ms"], -49.89, places=2)
            self.assertEqual(second["old"], {"offset_ms": 13153.0, "bpm": 222.0, "meter": 4})
            self.assertEqual(second["new"], {"offset_ms": 14000, "bpm": 222.0, "meter": 4})
            self.assertEqual((second["delta_offset_ms"], second["delta_bpm"]), (847.0, 0.0))
            self.assertIsNone(second["drift_end_ms"])
            self.assertEqual((diff["removed"], diff["added"]), ([], []))

    def test_empty_sides_and_missing_points(self) -> None:
        from types import SimpleNamespace
        from overtone import inject_diff
        with tempfile.TemporaryDirectory() as tmp:
            bare = Path(tmp) / "bare.osu"
            bare.write_text("[General]\n[TimingPoints]\n[HitObjects]\n", encoding="utf-8")
            diff = inject_diff(bare, self._analysis())
            self.assertEqual((diff["pairs"], diff["removed"]), ([], []))
            self.assertEqual(len(diff["added"]), 2)
            with self.assertRaises(ValueError):
                inject_diff(bare, SimpleNamespace(source="song.mp3", points=[]))
            with self.assertRaises(ValueError):
                inject_diff(Path(tmp) / "missing.osu", self._analysis())

    def test_extra_old_lines_ride_along_as_removed(self) -> None:
        from types import SimpleNamespace
        from overtone import inject_diff
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_bytes(self.FAKE_OSU.replace("\n", "\r\n").encode("utf-8"))
            one = SimpleNamespace(source="song.mp3",
                                  points=[TimingPoint(360.0, 224.0, 0.95, 1)])
            diff = inject_diff(target, one)
            json.dumps(diff)
            self.assertEqual(len(diff["pairs"]), 1)
            self.assertEqual(diff["removed"],
                             [{"offset_ms": 13153.0, "bpm": 222.0, "meter": 4}])
            self.assertEqual(diff["added"], [])


class InjectMapsetTests(unittest.TestCase):
    FAKE_OSU = ("osu file format v14\n[General]\nAudioFilename: song.mp3\n"
                "[TimingPoints]\n353,266.666666666667,4,2,0,100,1,0\n"
                "[HitObjects]\n64,80,1000,1,0\n")

    def _analysis(self):
        from types import SimpleNamespace
        return SimpleNamespace(source="song.mp3",
                               points=[TimingPoint(360.0, 224.0, 0.95, 1)])

    def _folder(self, tmp: str) -> Path:
        root = Path(tmp)
        (root / "easy.osu").write_bytes(self.FAKE_OSU.replace("\n", "\r\n").encode("utf-8"))
        (root / "hard.osu").write_bytes(self.FAKE_OSU.replace("\n", "\r\n").encode("utf-8"))
        (root / "broken.osu").write_text("[General]\n[HitObjects]\n", encoding="utf-8")
        return root

    def test_dry_run_writes_nothing_and_a_bad_map_does_not_stop_the_rest(self) -> None:
        from overtone import inject_mapset
        with tempfile.TemporaryDirectory() as tmp:
            root = self._folder(tmp)
            report = inject_mapset(root, self._analysis(), dry_run=True)
            json.dumps(report)
            self.assertEqual((report["ok"], report["failed"]), (2, 1))
            self.assertEqual([f["file"] for f in report["files"]],
                             ["broken.osu", "easy.osu", "hard.osu"])
            broken = next(f for f in report["files"] if f["file"] == "broken.osu")
            self.assertFalse(broken["ok"])
            self.assertIn("TimingPoints", broken["error"])
            self.assertFalse((root / "easy.osu.bak").exists())

    def test_apply_writes_every_difficulty_with_its_backup(self) -> None:
        from overtone import inject_mapset
        with tempfile.TemporaryDirectory() as tmp:
            root = self._folder(tmp)
            report = inject_mapset(root, self._analysis())
            self.assertEqual((report["ok"], report["failed"]), (2, 1))
            for name in ("easy.osu", "hard.osu"):
                out = (root / name).read_bytes()
                self.assertNotIn(b"266.666666666667", out)
                self.assertTrue((Path(str(root / name) + ".bak")).is_file())
            with self.assertRaises(ValueError):
                inject_mapset(root / "missing", self._analysis())
            (root / "easy.osu").unlink()
            (root / "hard.osu").unlink()
            (root / "broken.osu").unlink()
            with self.assertRaises(ValueError):
                inject_mapset(root, self._analysis())


class InjectKeepsWhatPlaysTests(unittest.TestCase):
    """Injection changes the timing and nothing a player hears or sees scroll.

    Before this, every new red line was written as Normal / 100 % / no kiai and
    the section was left out of time order: re-injecting a hitsounded map with
    kiai silently flattened it.
    """

    # Soft 60 % from 400; kiai from 20 s; a red at 30 s re-states Soft 60 with
    # kiai; kiai off at 45 s. A 2.0x slider-velocity green at 22 s.
    MAP = ("osu file format v14\n[General]\nAudioFilename: song.mp3\n\n"
           "[TimingPoints]\n"
           "400,400,4,2,0,60,1,0\n"
           "20000,-100,4,2,0,60,0,1\n"
           "22000,-50,4,2,0,60,0,1\n"
           "30000,375,4,2,0,60,1,1\n"
           "45000,-100,4,2,1,40,0,0\n"
           "\n[HitObjects]\n")
    OBJECTS = [1000, 5000, 19000, 20500, 22500, 25000, 29000, 30500, 31000,
               33000, 39000, 41000, 44000, 46000, 50000]

    def _map(self, tmp: str, text: str = "", newline: str = "\n", bom: bool = False) -> Path:
        text = text or self.MAP + "".join(f"256,192,{t},1,0\n" for t in self.OBJECTS)
        path = Path(tmp) / "map.osu"
        data = text.replace("\n", newline).encode("utf-8")
        path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + data)
        return path

    def _analysis(self):
        from types import SimpleNamespace
        # red lines that do not sit where the old ones were
        return SimpleNamespace(source="song.mp3", meter="4/4",
                               points=[TimingPoint(500.0, 150.0, 0.95, 0),
                                       TimingPoint(25000.0, 160.0, 0.9, 60),
                                       TimingPoint(40000.0, 170.0, 0.9, 100)])

    def test_every_object_plays_as_before(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp)
            before = path.read_text(encoding="utf-8")
            inject_osu_timing_points(path, self._analysis(), backup=False)
            after = path.read_text(encoding="utf-8")
        for t in self.OBJECTS:
            self.assertEqual(_heard_at(after, t), _heard_at(before, t), f"object at {t} ms")

    def test_new_red_lines_carry_the_state_they_land_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp)
            inject_osu_timing_points(path, self._analysis(), backup=False)
            reds = [r for r in _timing_rows(path.read_text(encoding="utf-8")) if r[6] == "1"]
        # offsets as exported: 25000 is 100 ms off the 150 BPM grid, so export
        # snapping (rounding noise only) leaves it where it is
        self.assertEqual([r[0] for r in reds], ["500", "25000", "40000"])
        self.assertEqual(reds[0][3:8], ["2", "0", "60", "1", "0"])   # Soft 60, before kiai
        self.assertEqual(reds[1][3:8], ["2", "0", "60", "1", "1"])   # inside the kiai
        self.assertEqual(reds[2][3:8], ["2", "0", "60", "1", "1"])

    def test_timing_section_is_in_time_order_red_before_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp)
            summary = inject_osu_timing_points(path, self._analysis(), backup=False)
            rows = _timing_rows(path.read_text(encoding="utf-8"))
        keys = [(float(r[0]), 0 if r[6] == "1" else 1) for r in rows]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(summary["reds_replaced"], 2)
        self.assertEqual(summary["reds_added"], 3)
        self.assertEqual(summary["greens_kept"], 3)
        self.assertGreater(summary["greens_added"], 0)  # SV 2.0 around the moved reds

    def test_original_greens_are_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, newline="\r\n")
            inject_osu_timing_points(path, self._analysis(), backup=False)
            out = path.read_bytes()
        for green in (b"20000,-100,4,2,0,60,0,1\r\n", b"22000,-50,4,2,0,60,0,1\r\n",
                      b"45000,-100,4,2,1,40,0,0\r\n"):
            self.assertIn(green, out)
        self.assertNotIn(b"\r\r\n", out)

    def test_injecting_twice_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, newline="\r\n")
            inject_osu_timing_points(path, self._analysis(), backup=False)
            first = path.read_bytes()
            summary = inject_osu_timing_points(path, self._analysis(), backup=False)
            self.assertEqual(path.read_bytes(), first)
        self.assertEqual(summary["greens_added"], 0)

    def test_bom_and_missing_final_newline_survive(self):
        text = self.MAP + "256,192,1000,1,0"  # no newline at the end of the file
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, text=text, newline="\r\n", bom=True)
            original = path.read_bytes()
            inject_osu_timing_points(path, self._analysis(), backup=False)
            out = path.read_bytes()
        self.assertTrue(out.startswith(b"\xef\xbb\xbfosu file format v14\r\n"))
        head = original[:original.index(b"[TimingPoints]")]
        self.assertTrue(out.startswith(head))
        self.assertTrue(out.endswith(b"\r\n\r\n[HitObjects]\r\n256,192,1000,1,0"))

    def test_a_map_without_timing_gets_plain_red_lines(self):
        text = "osu file format v14\n[General]\nAudioFilename: song.mp3\n\n[TimingPoints]\n\n[HitObjects]\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, text=text)
            summary = inject_osu_timing_points(path, self._analysis(), backup=False)
            rows = _timing_rows(path.read_text(encoding="utf-8"))
        self.assertEqual(summary["greens_added"], 0)
        self.assertEqual([r[3:8] for r in rows], [["1", "0", "100", "1", "0"]] * 3)


class OszExportTests(unittest.TestCase):
    """Timing a song from nothing — the part of Tempora's flow v3 could not do.

    v3 could only inject red lines into a beatmap that already existed. These
    cover writing the beatmap.
    """

    def _analysis(self, source="song.wav"):
        return Analysis(source, 30.0, np.zeros(0), np.zeros(0),
                        [TimingPoint(298.0, 224.0, 0.98, 0, 4, True),
                         TimingPoint(13240.0, 226.5, 0.94, 1, 3, True)],
                        512, 44100, 1, 224.0, 1.0, "4/4")

    @staticmethod
    def _audio(path: Path) -> Path:
        import soundfile as sf
        sf.write(str(path), np.zeros(4410, dtype=np.float32), 44100)
        return path

    def test_archive_holds_the_audio_and_one_beatmap(self):
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            out = Path(tmp) / "map.osz"
            written = export_osz(self._analysis(), out, audio)
            self.assertTrue(out.is_file())
            with zipfile.ZipFile(out) as archive:
                self.assertIsNone(archive.testzip())
                names = archive.namelist()
                osu = [n for n in names if n.endswith(".osu")]
                self.assertEqual(len(osu), 1, names)
                self.assertIn("song.wav", names)
                text = archive.read(osu[0]).decode("utf-8")
            # The beatmap must point at the name the archive actually used, or
            # osu! opens a map with no audio.
            self.assertIn(f"AudioFilename: {written['audio']}", text)
            self.assertEqual(written["points"], 2)

    @staticmethod
    def _tagged(path: Path, **tags) -> Path:
        import soundfile as sf
        with sf.SoundFile(str(path), "w", samplerate=44100, channels=1, format="WAV") as handle:
            for key, value in tags.items():
                setattr(handle, key, value)
            handle.write(np.zeros(4410, dtype=np.float32))
        return path

    @staticmethod
    def _osu_in(out: Path) -> tuple[str, str]:
        import zipfile
        with zipfile.ZipFile(out) as archive:
            name = next(n for n in archive.namelist() if n.endswith(".osu"))
            return name, archive.read(name).decode("utf-8")

    def test_the_song_is_named_by_its_tags_unicode_kept_apart(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._tagged(Path(tmp) / "track01.wav", title="信仰は儚き人間の為に", artist="YUI")
            written = export_osz(self._analysis(), Path(tmp) / "map.osz", audio)
            name, text = self._osu_in(Path(tmp) / "map.osz")
        self.assertEqual(written["metadata"]["from"], "tags")
        self.assertIn("TitleUnicode:信仰は儚き人間の為に\n", text)
        self.assertIn("Title:track01\n", text)          # no romanisation invented
        self.assertIn("Artist:YUI\n", text)
        self.assertIn("ArtistUnicode:YUI\n", text)
        self.assertTrue(name.startswith("YUI - track01 (Overtone)"), name)

    def test_a_map_beside_the_audio_names_it_best(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._tagged(Path(tmp) / "audio.wav", title="Wrong", artist="Wrong")
            (Path(tmp) / "a.osu").write_text(
                "osu file format v14\n\n[General]\nAudioFilename: other.mp3\n\n[Metadata]\n"
                "Title:Not This\nArtist:Not This\n", encoding="utf-8")
            (Path(tmp) / "b.osu").write_text(
                "osu file format v14\n\n[General]\nAudioFilename: audio.wav\n\n[Metadata]\n"
                "Title:Shinkou wa Hakanaki Ningen no Tame ni\nTitleUnicode:信仰は儚き人間の為に\n"
                "Artist:KISIDA KYODAN\nArtistUnicode:岸田教団\nSource:Touhou\n", encoding="utf-8")
            written = export_osz(self._analysis(), Path(tmp) / "map.osz", audio)
            _name, text = self._osu_in(Path(tmp) / "map.osz")
        self.assertEqual(written["metadata"]["from"], "map")
        for line in ("Title:Shinkou wa Hakanaki Ningen no Tame ni", "TitleUnicode:信仰は儚き人間の為に",
                     "Artist:KISIDA KYODAN", "ArtistUnicode:岸田教団", "Source:Touhou"):
            self.assertIn(line + "\n", text)

    def test_a_name_given_wins_and_nothing_found_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._tagged(Path(tmp) / "song.wav", title="Tagged", artist="Tagger")
            written = export_osz(self._analysis(), Path(tmp) / "a.osz", audio, {"title": "Mine"})
            _name, text = self._osu_in(Path(tmp) / "a.osz")
            bare = export_osz(self._analysis(), Path(tmp) / "b.osz", self._audio(Path(tmp) / "plain.wav"))
        # The title given is both title fields; the artist still comes from the tags.
        for line in ("Title:Mine", "TitleUnicode:Mine", "Artist:Tagger"):
            self.assertIn(line + "\n", text)
        self.assertEqual(written["metadata"]["from"], "tags")
        self.assertEqual((bare["metadata"]["from"], bare["metadata"]["title"]), ("none", "plain"))

    def test_a_tag_with_a_line_break_stays_one_field(self):
        text = osu_beatmap_text(self._analysis(), "song.mp3", {"title": "Two\nLines", "artist": "A\r\nB"})
        self.assertIn("Title:Two Lines\n", text)
        self.assertIn("ArtistUnicode:A B\n", text)

    def test_the_audio_keeps_its_extension_whatever_its_name(self):
        import zipfile
        long_name = ("Some Artist Name feat. Another Artist - A Rather Long Song "
                     "Title (Extended Club Mix)")
        for stem in (long_name, "Title...", "Hmm...."):
            with self.subTest(stem=stem), tempfile.TemporaryDirectory() as tmp:
                audio = self._audio(Path(tmp) / f"{stem}.wav")
                out = Path(tmp) / "map.osz"
                written = export_osz(self._analysis(), out, audio)
                name = written["audio"]
                self.assertTrue(name.endswith(".wav"), name)
                self.assertEqual(name, name.strip())
                self.assertNotIn("..", name)
                with zipfile.ZipFile(out) as archive:
                    self.assertIn(name, archive.namelist())
                    osu = next(n for n in archive.namelist() if n.endswith(".osu"))
                    self.assertIn(f"AudioFilename: {name}\n",
                                  archive.read(osu).decode("utf-8").replace("\r\n", "\n"))

    def test_the_beatmap_has_every_section_osu_expects(self):
        text = osu_beatmap_text(self._analysis(), "song.mp3")
        self.assertTrue(text.startswith("osu file format v14"))
        for section in ("[General]", "[Editor]", "[Metadata]", "[Difficulty]",
                        "[Events]", "[TimingPoints]", "[HitObjects]"):
            self.assertIn(section, text, section)

    def test_each_points_own_meter_reaches_the_beatmap(self):
        text = osu_beatmap_text(self._analysis(), "song.mp3")
        body = text[text.index("[TimingPoints]"):]
        rows = [r for r in body.splitlines()[1:] if r.strip()][:2]
        self.assertEqual(rows[0].split(",")[2], "4")
        self.assertEqual(rows[1].split(",")[2], "3")

    def test_unsafe_metadata_cannot_escape_the_filename(self):
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            out = Path(tmp) / "map.osz"
            written = export_osz(self._analysis(), out, audio,
                                 {"artist": "../../evil", "title": 'a:b"c|d?e*f'})
            for bad in ("..", "/", "\\", ":", '"', "|", "?", "*"):
                self.assertNotIn(bad, written["osu"], f"{bad!r} in {written['osu']!r}")
            with zipfile.ZipFile(out) as archive:
                for name in archive.namelist():
                    self.assertFalse(Path(name).is_absolute())
                    self.assertNotIn("..", name)

    def test_an_empty_analysis_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            empty = Analysis("song.wav", 30.0, np.zeros(0), np.zeros(0), [],
                             512, 44100, 1, 0.0, 0.0, "4/4")
            with self.assertRaises(ValueError):
                export_osz(empty, Path(tmp) / "map.osz", audio)

    def test_missing_audio_is_refused_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "map.osz"
            with self.assertRaises(ValueError):
                export_osz(self._analysis(), out, Path(tmp) / "nope.wav")
            self.assertFalse(out.exists())
            self.assertFalse((Path(tmp) / "map.osz.part").exists())

    def test_a_failed_export_leaves_no_half_written_archive(self):
        # An interrupted export must not leave a .osz osu! will refuse and the
        # user will not think to delete.
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            out = Path(tmp) / "map.osz"
            broken = Analysis("song.wav", 30.0, np.zeros(0), np.zeros(0),
                              [TimingPoint(0.0, 0.0, 1.0, 0)],
                              512, 44100, 1, 0.0, 0.0, "4/4")
            with self.assertRaises(ValueError):
                export_osz(broken, out, audio)
            self.assertFalse(out.exists())
            self.assertFalse((Path(tmp) / "map.osz.part").exists())


class ConfigAndInjectHardeningTests(unittest.TestCase):
    LEGACY_OSU = ("osu file format v4\n[General]\nAudioFilename: song.mp3\n"
                  "[TimingPoints]\n500,344.827\n1200,-50\n[HitObjects]\n")

    def _analysis(self):
        from types import SimpleNamespace
        return SimpleNamespace(source="song.mp3", meter="4/4",
                               points=[TimingPoint(431.0, 174.0, 0.95, 1)])

    def test_legacy_two_field_red_lines_are_replaced(self):
        self.assertTrue(_is_red_line("500,344.827"))
        self.assertFalse(_is_red_line("1200,-50"))
        self.assertFalse(_is_red_line("1200,-50,4,2,0,60,1,0"))   # negative wins
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "old.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            summary = inject_osu_timing_points(target, self._analysis(), backup=False)
            out = target.read_text(encoding="utf-8")
        self.assertEqual(summary["reds_replaced"], 1)
        self.assertEqual(summary["greens_kept"], 1)
        self.assertNotIn("500,344.827", out)
        self.assertIn("1200,-50", out)

    def test_every_rename_follows_a_sync(self):
        # A rename can reach the disk before its data: a crash in between left
        # map.osu (or its .bak, or the .osz) empty or zero-filled.
        import os
        from unittest import mock
        import overtone
        events = []

        def record(name, real):
            def call(*args):
                events.append(name)
                return real(*args)
            return call

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            audio = Path(tmp) / "song.mp3"
            audio.write_bytes(b"\xff\xfb" * 64)
            with mock.patch.object(overtone.os, "fsync", record("fsync", os.fsync)), \
                    mock.patch.object(overtone.os, "replace", record("replace", os.replace)), \
                    mock.patch.object(overtone.os, "rename", record("rename", os.rename)):
                inject_osu_timing_points(target, self._analysis())
                export_osz(_grid_analysis([(431.0, 174.0)]), Path(tmp) / "map.osz", audio)
            self.assertTrue(Path(str(target) + ".bak").is_file())
        self.assertEqual(events, ["fsync", "rename", "fsync", "replace", "fsync", "replace"])

    def test_backup_keeps_the_pristine_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            inject_osu_timing_points(target, self._analysis())
            inject_osu_timing_points(target, self._analysis())
            spare = Path(str(target) + ".bak").read_text(encoding="utf-8")
        self.assertEqual(spare, self.LEGACY_OSU)

    def test_a_failed_backup_leaves_no_truncated_bak(self):
        # A full disk or an AV lock halfway through the backup used to leave a
        # truncated .bak; the retry saw it existed, kept it for good, and
        # overwrote the map with no usable backup.
        from unittest import mock
        import overtone
        real_write = overtone._write_synced

        def disk_full(path, data):
            if ".bak" in path.name:
                real_write(path, data[: len(data) // 2])
                raise OSError(28, "No space left on device")
            return real_write(path, data)

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            original = target.read_bytes()
            with mock.patch.object(overtone, "_write_synced", disk_full):
                with self.assertRaises(OSError):
                    inject_osu_timing_points(target, self._analysis())
            self.assertEqual(target.read_bytes(), original)  # the map was not touched
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ["map.osu"])
            summary = inject_osu_timing_points(target, self._analysis())  # space freed
            self.assertEqual(Path(str(target) + ".bak").read_bytes(), original)
            self.assertEqual(summary["backup"], str(target) + ".bak")

    def test_every_inject_keeps_what_it_overwrites(self):
        # Hours of mapping between two injects used to be overwritten with no
        # backup: the .bak held the pre-first-inject file, and the summary still
        # said backup=True. The .bak stays pristine; the state each inject
        # replaces goes to the next free name, once.
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            original = target.read_bytes()
            first = inject_osu_timing_points(target, self._analysis())
            self.assertEqual(first["backup"], str(target) + ".bak")
            mapped = target.read_bytes() + b"256,192,1000,1,0,0:0:0:0:\n"  # the mapper's work
            target.write_bytes(mapped)
            second = inject_osu_timing_points(target, self._analysis())
            self.assertEqual(second["backup"], str(target) + ".bak2")
            self.assertEqual(Path(str(target) + ".bak").read_bytes(), original)
            self.assertEqual(Path(str(target) + ".bak2").read_bytes(), mapped)
            # Nothing new to keep: these injects replace bytes .bak2 already holds.
            self.assertEqual(target.read_bytes(), mapped)
            third = inject_osu_timing_points(target, self._analysis())
            fourth = inject_osu_timing_points(target, self._analysis())
            self.assertEqual(third["backup"], str(target) + ".bak2")
            self.assertEqual(fourth["backup"], str(target) + ".bak2")
            self.assertFalse(Path(str(target) + ".bak3").exists())

    def test_inject_refuses_an_empty_analysis(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            with self.assertRaises(ValueError):
                inject_osu_timing_points(
                    target, SimpleNamespace(source="s", points=[], meter="4/4"))
            with self.assertRaises(ValueError):
                inject_osu_timing_points(Path(tmp) / "missing.osu", self._analysis())
            self.assertEqual(target.read_text(encoding="utf-8"), self.LEGACY_OSU)

    def test_local_bpm_helper_handles_degenerate_input(self):
        self.assertEqual(len(_robust_local_bpms(np.zeros(0))), 0)
        self.assertEqual(len(_robust_local_bpms(np.array([1.0]))), 1)


class MapReaderTests(unittest.TestCase):
    def test_reads_reds_skips_greens_and_broken_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reds = read_osu_red_lines(_write_osu(tmp, _MAP_OSU))
        self.assertEqual(len(reds), 3)
        self.assertAlmostEqual(reds[0][0], 1000.0)
        self.assertAlmostEqual(reds[0][1], 150.0)
        self.assertAlmostEqual(reds[1][0], 3000.0)  # legacy two-field line
        self.assertAlmostEqual(reds[1][1], 120.0)
        self.assertAlmostEqual(reds[2][0], 4000.5)  # lazer decimal offset
        self.assertAlmostEqual(reds[2][1], 180.0, places=4)

    def test_missing_section_missing_file_or_no_reds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                read_osu_red_lines(_write_osu(tmp, "[General]\n", name="a.osu"))
            with self.assertRaises(ValueError):
                read_osu_red_lines(str(Path(tmp) / "missing.osu"))
            greens = _write_osu(tmp, "[TimingPoints]\n2000,-50,4,2,0,100,0,0\n", name="b.osu")
            self.assertEqual(read_osu_red_lines(greens), [])

    def test_round_trip_through_the_own_exporter(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        with tempfile.TemporaryDirectory() as tmp:
            reds = read_osu_red_lines(
                _write_osu(tmp, osu_beatmap_text(analysis, "audio.mp3")))
        snapped = snap_timing_points(analysis.points)
        self.assertEqual(len(reds), len(snapped))
        for (offset, bpm), point in zip(reds, snapped):
            self.assertLessEqual(abs(offset - point.offset_ms), 0.5)  # whole-ms file
            self.assertAlmostEqual(bpm, point.bpm, places=6)


class MapCompareTests(unittest.TestCase):
    def _report(self, analysis, text):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            report = compare_map_timing(_write_osu(tmp, text), analysis)
        json.dumps(report)  # sections and findings stay plain JSON types
        return report

    def test_identical_map_is_clean(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        report = self._report(analysis, osu_beatmap_text(analysis, "audio.mp3"))
        self.assertEqual(len(report["sections"]), 2)
        for row in report["sections"]:
            self.assertLess(row["bpm_error"], 0.05)
            self.assertLessEqual(row["offset_error_ms"], 0.5)
            self.assertEqual(row["octave"], 1)
        self.assertEqual(report["findings"], [])

    def test_shifted_line_warns_with_milliseconds(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        lines = osu_beatmap_text(analysis, "audio.mp3").splitlines()
        lines = [line.replace("30500,", "30530,") if line.startswith("30500,") else line
                 for line in lines]
        report = self._report(analysis, "\n".join(lines))
        offset = [f for f in report["findings"] if f["key"] == "map_offset"]
        self.assertEqual(len(offset), 1)
        self.assertEqual(offset[0]["level"], "warn")
        self.assertEqual(offset[0]["values"], {"ms": "30.0"})

    def test_doubled_map_bpm_is_an_octave_question(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        lines = osu_beatmap_text(analysis, "audio.mp3").splitlines()
        # Halve the second line's beat length: the map runs at 2x detection.
        for n, line in enumerate(lines):
            if line.startswith("30500,"):
                fields = line.split(",")
                fields[1] = repr(float(fields[1]) / 2)
                lines[n] = ",".join(fields)
        report = self._report(analysis, "\n".join(lines))
        octave = [f for f in report["findings"] if f["key"] == "map_octave"]
        self.assertEqual(len(octave), 1)
        self.assertEqual(octave[0]["level"], "info")
        self.assertEqual(octave[0]["values"]["octave"], "x0.5")
        self.assertNotIn("map_bpm", [f["key"] for f in report["findings"]])

    def test_empty_sides_report_instead_of_crashing(self) -> None:
        greens = "[TimingPoints]\n2000,-50,4,2,0,100,0,0\n"
        report = self._report(_compare_analysis([TimingPoint(500.0, 150.0, 0.9, 0)]), greens)
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("error", "map_no_reds")])
        report = compare_map_timing("whatever.osu", _compare_analysis([]))
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("error", "no_detected")])


class FolderScanTests(unittest.TestCase):
    def _song(self, tmp: str, audio: str = "song.mp3") -> Path:
        root = Path(tmp) / "123 Artist - Title"
        root.mkdir()
        (root / audio).write_bytes(b"RIFF....")
        (root / "map [Easy].osu").write_text(
            "[General]\nAudioFilename: song.mp3\n\n[TimingPoints]\n1000,400,4,1,0,100,1,0\n",
            encoding="utf-8")
        (root / "map [Hard].osu").write_text(
            "[General]\nAudioFilename: song.mp3\n\n[TimingPoints]\n1000,500,4,1,0,100,1,0\n",
            encoding="utf-8")
        return root

    def test_finds_audio_and_difficulties_sorted(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            scan = scan_beatmap_folder(self._song(tmp))
        self.assertTrue(scan["audio"].endswith("song.mp3"))
        self.assertEqual(len(scan["beatmaps"]), 2)
        self.assertEqual(scan["beatmaps"], sorted(scan["beatmaps"]))
        self.assertTrue(scan["audio_from"].endswith("[Easy].osu"))
        json.dumps(scan)

    def test_single_audio_without_maps_is_enough(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "song"
            root.mkdir()
            (root / "audio.ogg").write_bytes(b"OggS....")
            scan = scan_beatmap_folder(root)
        self.assertTrue(scan["audio"].endswith("audio.ogg"))
        self.assertEqual(scan["beatmaps"], [])
        self.assertIsNone(scan["audio_from"])

    def test_ambiguity_returns_no_audio_rather_than_guessing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "song"
            root.mkdir()
            (root / "a.mp3").write_bytes(b"ID3.....")
            (root / "b.mp3").write_bytes(b"ID3.....")
            scan = scan_beatmap_folder(root)
        self.assertIsNone(scan["audio"])

    def test_missing_named_audio_falls_back_to_the_single_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._song(tmp)
            (root / "song.mp3").unlink()
            (root / "other.wav").write_bytes(b"RIFF....")
            scan = scan_beatmap_folder(root)
        self.assertTrue(scan["audio"].endswith("other.wav"))
        self.assertIsNone(scan["audio_from"])

    def test_not_a_folder_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                scan_beatmap_folder(str(Path(tmp) / "missing"))


class MapFullReaderTests(unittest.TestCase):
    def _read(self, text, **kwargs):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            newline = kwargs.get("newline", "\n")
            target.write_bytes(text.replace("\n", newline).encode("utf-8"))
            beatmap = read_osu_beatmap(target)
        json.dumps(beatmap)  # everything stays plain JSON types
        return beatmap

    def test_sections_and_known_keys_with_unknowns_preserved(self) -> None:
        beatmap = self._read(_FULL_OSU)
        self.assertEqual(beatmap["format"], 14)
        self.assertEqual([s["name"] for s in beatmap["sections"]],
                         ["General", "Editor", "Metadata", "Difficulty",
                          "Events", "TimingPoints", "Colours", "HitObjects"])
        self.assertEqual(beatmap["general"]["AudioFilename"], "audio.mp3")
        self.assertEqual(beatmap["general"]["CustomTag"], "keep me")
        self.assertEqual(beatmap["metadata"]["Version"], "Hard")
        self.assertEqual(beatmap["difficulty"]["CircleSize"], "4")
        colours = next(s for s in beatmap["sections"] if s["name"] == "Colours")
        self.assertEqual(colours["lines"], ["Combo1 : 255,0,0", ""])
        events = next(s for s in beatmap["sections"] if s["name"] == "Events")
        self.assertIn('0,0,"bg.jpg",0,0', events["lines"])

    def test_timing_reds_and_greens(self) -> None:
        timing = self._read(_FULL_OSU)["timing"]
        self.assertEqual(timing["reds"], [(1000.0, 150.0)])
        self.assertEqual(timing["greens"], ["2000,-100,4,2,0,100,0,0"])

    def test_hitobjects_all_kinds(self) -> None:
        objects = self._read(_FULL_OSU)["hitobjects"]
        self.assertEqual([o["kind"] for o in objects],
                         ["circle", "slider", "spinner", "hold", "unparsed"])
        circle, slider, spinner, hold, broken = objects
        self.assertEqual((circle["x"], circle["y"], circle["time"]), (256, 192, 1000))
        self.assertFalse(circle["new_combo"])
        self.assertEqual(circle["hit_sample"]["volume"], 0)
        self.assertEqual(slider["curve"], {"curve_type": "B", "points": [(150, 150), (200, 100)]})
        self.assertEqual(slider["slides"], 2)
        self.assertAlmostEqual(slider["length"], 120.5)
        self.assertEqual(slider["edge_sounds"], "2|1")
        self.assertEqual(slider["edge_sets"], "0:0|0:0")
        self.assertEqual(spinner["end_time"], 8000)
        self.assertTrue(hold["new_combo"])  # type 132 carries the combo flag
        self.assertEqual(hold["end_time"], 9500)
        self.assertEqual(broken["raw"], "broken,line")

    def test_crlf_and_missing_file(self) -> None:
        beatmap = self._read(_FULL_OSU, newline="\r\n")
        self.assertEqual(beatmap["format"], 14)
        self.assertEqual(len(beatmap["hitobjects"]), 5)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                read_osu_beatmap(str(Path(tmp) / "missing.osu"))

    def test_decimal_time_survives_as_float(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[HitObjects]\n256,192,1000.5,1,0,0:0:0:0:\n",
                              encoding="utf-8")
            objects = read_osu_beatmap(target)["hitobjects"]
        self.assertEqual(len(objects), 1)
        self.assertEqual(objects[0]["kind"], "circle")
        self.assertAlmostEqual(objects[0]["time"], 1000.5)


class SoundEventTests(unittest.TestCase):
    """Phase 6, P-1: every object as the sounds osu! plays for it."""

    def _events(self, text=_SOUND_MAP):
        from overtone import read_osu_beatmap, sound_events
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = read_osu_beatmap(_write_osu(tmp, text))
        events = sound_events(beatmap)
        json.dumps(events)
        return events

    def test_circles_inherit_from_the_timing_point_then_the_map(self):
        events = self._events()
        first, second, late = events[0], events[1], events[2]
        # Timing point set 0 -> the map's SampleSet (Soft); volume from the point.
        self.assertEqual((first["sounds"], first["normal_set"], first["addition_set"],
                          first["index"], first["volume"]),
                         (["normal", "clap"], "soft", "soft", 0, 70))
        self.assertEqual(first["raw"]["normal_set"], 0)
        # The object's own sets win; its addition set is its own.
        self.assertEqual((second["sounds"], second["normal_set"], second["addition_set"]),
                         (["normal", "whistle"], "normal", "soft"))
        # 5 ms before a green line, the green line already applies.
        self.assertEqual((late["time"], late["normal_set"], late["index"], late["volume"]),
                         (1995.0, "drum", 2, 40))

    def test_slider_edges_carry_their_own_sounds_and_sets(self):
        events = [e for e in self._events() if e["object"] == 3]
        self.assertEqual([(e["part"], e["time"]) for e in events],
                         [("head", 2500.0), ("tail", 2750.0), ("body", 2500.0)])
        head, tail, body = events
        self.assertEqual((head["sounds"], head["normal_set"]), (["normal", "finish"], "drum"))
        self.assertEqual((tail["sounds"], tail["normal_set"], tail["addition_set"]),
                         (["normal", "clap"], "drum", "normal"))
        self.assertEqual((body["sounds"], body["end"]), (["slide"], 2750.0))

    def test_a_slider_without_edge_fields_sounds_its_own_bits_on_every_edge(self):
        events = [e for e in self._events() if e["object"] == 4]
        self.assertEqual([(e["part"], e["time"]) for e in events],
                         [("head", 3000.0), ("repeat", 3125.0), ("tail", 3250.0), ("body", 3000.0)])
        self.assertTrue(all(e["sounds"][-1] == "whistle" for e in events))
        self.assertEqual(events[-1]["sounds"], ["slide", "whistle"])

    def test_spinners_sound_at_their_end_holds_at_their_start_files_alone(self):
        events = self._events()
        spinner = next(e for e in events if e["object"] == 5)
        custom = next(e for e in events if e["object"] == 6)
        hold = next(e for e in events if e["object"] == 7)
        self.assertEqual((spinner["part"], spinner["time"], spinner["sounds"]),
                         ("spinner_end", 5000.0, ["normal", "finish"]))
        self.assertEqual((custom["file"], custom["raw"]["file"]), ("hit.wav", "hit.wav"))
        self.assertEqual((hold["part"], hold["time"], hold["sounds"]),
                         ("hold", 7000.0, ["normal", "whistle"]))
        self.assertFalse(any(e["object"] == 8 for e in events))    # the bad line

    def test_no_timing_points_still_places_every_head(self):
        text = _SOUND_MAP.split("[TimingPoints]")[0] + "[HitObjects]\n" + \
            _SOUND_MAP.split("[HitObjects]\n")[1]
        events = self._events(text)
        slider = [e["part"] for e in events if e["object"] == 3]
        self.assertEqual(slider, ["head"])                  # no beat length: no tail to place
        self.assertEqual((events[0]["normal_set"], events[0]["volume"]), ("soft", 100))


class ReaderFuzzRegressionTests(unittest.TestCase):
    """What bench/fuzz_reader.py found: each case once, fast."""

    @staticmethod
    def _read(tmp, data: bytes):
        from overtone import read_osu_beatmap
        path = Path(tmp) / "map.osu"
        path.write_bytes(data)
        return path, read_osu_beatmap(path)

    def test_a_header_with_stray_whitespace_comes_back_as_written(self):
        from overtone import beatmap_text
        text = _SOUND_MAP.replace("[General]", "[General]\t").replace("[HitObjects]", " [HitObjects] ")
        with tempfile.TemporaryDirectory() as tmp:
            _path, beatmap = self._read(tmp, text.replace("\n", "\r\n").encode("utf-8"))
        self.assertEqual(beatmap_text(beatmap), text.replace("\n", "\r\n"))
        self.assertEqual([s["name"] for s in beatmap["sections"]][0], "General")

    def test_unicode_line_separators_stay_inside_their_line_as_in_osu(self):
        from overtone import beatmap_text
        # osu! breaks lines at CR and LF only; U+2028, U+0085 and \v are text.
        text = _SOUND_MAP.replace("[Difficulty]", "[Metadata]\nTitle:A B\x85C\vD\n\n[Difficulty]")
        data = text.replace("\n", "\r\n").encode("utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            _path, beatmap = self._read(tmp, data)
        self.assertEqual(beatmap["metadata"]["Title"], "A B\x85C\vD")
        self.assertEqual(beatmap_text(beatmap).encode("utf-8"), data)
        self.assertEqual(beatmap["hitobjects"][0]["hit_sound"], 8)

    def test_a_timing_line_osu_cannot_read_is_skipped_not_fatal(self):
        from overtone import sound_events
        text = _SOUND_MAP.replace("2000,-50,4,3,2,40,0,0",
                                  "2000,-50,inf,3,2,40,0,0\ninf,500,4,2,0,70,1,0\n1000,nan,4,2,0,70,1,0")
        with tempfile.TemporaryDirectory() as tmp:
            _path, beatmap = self._read(tmp, text.replace("\n", "\r\n").encode("utf-8"))
        events = sound_events(beatmap)
        self.assertEqual((events[0]["normal_set"], events[0]["volume"]), ("soft", 70))

    def test_a_meter_beyond_any_real_map_reads_as_four(self):
        from overtone import _beatmap_red_rows
        text = _SOUND_MAP.replace("0,500,4,0,0,70,1,0", "0,500,18446744073709551616,0,0,70,1,0")
        with tempfile.TemporaryDirectory() as tmp:
            _path, beatmap = self._read(tmp, text.replace("\n", "\r\n").encode("utf-8"))
        self.assertEqual(_beatmap_red_rows(beatmap)[0][2], 4)


class AudioSwapTests(unittest.TestCase):
    """Phase 19, Audio swap: the shift between two encodes, every time moved."""

    @staticmethod
    def _clicks(bpm=150.0, seconds=8.0, seed=7):
        import math
        rng = np.random.default_rng(seed)
        y = np.zeros(int(seconds * 44100), dtype=np.float64)
        k = 0
        while True:
            t = 0.5 + k * 60.0 / bpm
            if t > seconds - 0.2:
                break
            n = int(0.03 * 44100)
            burst = np.exp(-np.arange(n) / (0.004 * 44100)) * (rng.random(n) - 0.5)
            y[int(t * 44100):int(t * 44100) + n] += (0.9 if k % 4 == 0 else 0.5) * burst
            k += 1
        return y / max(1e-9, np.abs(y).max())

    @staticmethod
    def _delayed(y, ms):
        shift = int(round(ms / 1000 * 44100))
        out = np.zeros_like(y)
        if shift >= 0:
            out[shift:] = y[:len(y) - shift]
        else:
            out[:shift] = y[-shift:]
        return out

    def test_a_shift_reads_sub_millisecond_and_refusals_refuse(self):
        from overtone import shift_samples
        base = self._clicks()
        self.assertAlmostEqual(shift_samples(base, self._delayed(base, 26.0), 44100)["shift_ms"],
                               26.0, delta=0.1)
        self.assertAlmostEqual(shift_samples(base, base, 44100)["shift_ms"], 0.0, delta=0.001)
        with self.assertRaises(ValueError):
            shift_samples(base, self._clicks(bpm=165.0), 44100)
        with self.assertRaises(ValueError):
            shift_samples(base, np.random.default_rng(1).standard_normal(len(base)), 44100)
        with self.assertRaises(ValueError):
            shift_samples(base[:100], base[:100], 44100)

    def test_every_time_moves_and_nothing_else(self):
        from overtone import read_osu_beatmap, shift_osu_text
        text = "\n".join([
            "osu file format v14", "", "[General]", "AudioFilename: old.mp3",
            "PreviewTime: 2000", "AudioLeadIn: 500", "", "[Editor]", "Bookmarks: 1000,2000",
            "", "[TimingPoints]", "1000,500,4,2,0,70,1,0", "1500,-100,4,2,0,60,0,0", "",
            "[HitObjects]",
            "256,192,1000,1,4,0:0:0:0:",
            "256,192,2000,2,2,L|356:192,1,140,2|2|2,0:0|0:0|0:0,0:0:0:30:",
            "256,192,3000,12,0,4000,0:0:0:0:",
            "100,100,5000,128,0,6000:0:0:0:0:", ""])
        shifted, moved = shift_osu_text(text, 26.0, audio_name="new.mp3")
        json.dumps(moved)
        # One red line and one green: both move, one counts as a red line.
        self.assertEqual((moved["reds"], moved["objects"]), (1, 4))
        self.assertIn("1026,500,4,2,0,70,1,0", shifted)
        self.assertIn("1526,-100,4,2,0,60,0,0", shifted)
        self.assertIn("256,192,1026,1,4,0:0:0:0:", shifted)
        self.assertIn("256,192,3026,12,0,4026,0:0:0:0:", shifted)
        self.assertIn("100,100,5026,128,0,6026:0:0:0:0:", shifted)
        self.assertIn("AudioFilename: new.mp3", shifted)
        self.assertIn("PreviewTime: 2026", shifted)
        # The lead-in is a wait before the song, not a moment in it.
        self.assertIn("AudioLeadIn: 500", shifted)
        self.assertIn("Bookmarks: 1026,2026", shifted)
        # The shifted text parses with every time moved.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes(shifted.replace("\n", "\r\n").encode("utf-8"))
            beatmap = read_osu_beatmap(path)
        self.assertEqual([o["time"] for o in beatmap["hitobjects"]],
                         [1026.0, 2026.0, 3026.0, 5026.0])

    def test_a_negative_landing_or_missing_section_refuses(self):
        from overtone import shift_osu_text
        text = _copy_map(["256,192,1000,1,0,0:0:0:0:"])
        with self.assertRaises(ValueError):
            shift_osu_text(text, -2000.0)
        with self.assertRaises(ValueError):
            shift_osu_text("[General]\n", 10.0)

    def test_an_encode_with_less_silence_moves_a_map_with_no_lead_in(self):
        # Every real map writes "AudioLeadIn: 0", and moving it refused every
        # negative shift at 0 ms although nothing timed landed before zero.
        from overtone import shift_osu_text
        text = _copy_map(["256,192,1000,1,0,0:0:0:0:"], timing="1000,500,4,2,0,70,1,0").replace(
            "[General]\n", "[General]\nAudioLeadIn: 0\n")
        shifted, moved = shift_osu_text(text, -40.0)
        self.assertIn("AudioLeadIn: 0", shifted)
        self.assertIn("960,500,4,2,0,70,1,0", shifted)
        self.assertIn("256,192,960,1,0,0:0:0:0:", shifted)
        self.assertEqual((moved["reds"], moved["objects"]), (1, 1))

    def test_a_red_line_before_zero_moves_like_any_other(self):
        # osu! allows a first red line before the song starts; the swap
        # refused every map of a real set with one at -3189 ms.
        from overtone import shift_osu_text
        text = _copy_map(["256,192,1000,1,0,0:0:0:0:"], timing="-3189,500,4,2,0,70,1,0")
        for shift, red, obj in ((40.0, "-3149,500,", "256,192,1040,"),
                                (-40.0, "-3229,500,", "256,192,960,")):
            shifted, _moved = shift_osu_text(text, shift)
            self.assertIn(red, shifted)
            self.assertIn(obj, shifted)

    def test_apply_moves_a_set_atomically_with_backups(self):
        from overtone import apply_audio_swap, preview_audio_swap, read_history
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "a.osu"
            second = Path(tmp) / "b.osu"
            for path in (first, second):
                path.write_bytes(_copy_map(["256,192,1000,1,0,0:0:0:0:"]).replace(
                    "\n", "\r\n").encode("utf-8"))
            preview = preview_audio_swap([first, second], 26.0)
            self.assertTrue(all(row["ok"] for row in preview["maps"]))
            self.assertEqual(preview["maps"][0]["objects"], 1)
            done = apply_audio_swap([first, second], 26.0, audio_name="new.mp3")
            self.assertTrue(done["written"])
            self.assertTrue(first.with_name("a.osu.bak").is_file())
            # One bad map stops the set before any byte moves.
            bad = Path(tmp) / "bad.osu"
            bad.write_bytes(b"junk")
            before = second.read_bytes()
            with self.assertRaises(ValueError):
                apply_audio_swap([second, bad], 10.0)
            self.assertEqual(second.read_bytes(), before)
            entries = [e for e in read_history() if e["op"] == "swap"]
        json.dumps([preview, done])
        self.assertEqual(len(entries), 2)


class WriteHistoryTests(unittest.TestCase):
    """Phase 19, History: every .osu write logged, diffed and restorable."""

    def test_log_and_read_round_trip_newest_first(self):
        from overtone import log_write, read_history
        with tempfile.TemporaryDirectory() as tmp:
            log_write("a.osu", "inject", "a.osu.bak", {"reds_added": 2}, history_dir=tmp)
            log_write("b.osu", "hitsounds", None, {}, history_dir=tmp)
            entries = read_history(tmp)
        json.dumps(entries)
        self.assertEqual([(e["op"], e["path"], e["backup"]) for e in entries],
                         [("hitsounds", "b.osu", None), ("inject", "a.osu", "a.osu.bak")])
        self.assertEqual(entries[1]["summary"], {"reds_added": 2})

    def test_torn_lines_do_not_hide_the_rest(self):
        from overtone import read_history
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "writes.jsonl").write_text('{"op": "x", "path": "a.osu"}\nbroken\n',
                                                    encoding="utf-8")
            self.assertEqual(len(read_history(tmp)), 1)

    def test_restore_keeps_the_current_bytes_as_a_new_backup(self):
        from overtone import read_history, restore_write
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_bytes(b"v2")
            target.with_name("map.osu.bak").write_bytes(b"v1")
            result = restore_write(target, target.with_name("map.osu.bak"), history_dir=tmp)
            self.assertEqual(target.read_bytes(), b"v1")
            self.assertEqual(Path(result["backup"]).read_bytes(), b"v2")
            self.assertEqual(read_history(tmp)[0]["op"], "restore")
            with self.assertRaises(ValueError):
                restore_write(target, Path(tmp) / "missing.bak", history_dir=tmp)

    def test_red_diff_pairs_offsets_and_names_movers(self):
        from overtone import diff_reds
        old = "[TimingPoints]\n1000,500,4,2,0,70,1,0\n2000,400,4,2,0,70,1,0\n3000,500,4,2,0,70,1,0\n"
        new = "[TimingPoints]\n1000,500,4,2,0,70,1,0\n2000,300,4,2,0,70,1,0\n4000,500,4,2,0,70,1,0\n"
        diff = diff_reds(old, new)
        json.dumps(diff)
        self.assertEqual((diff["n_added"], diff["n_removed"], diff["n_changed"]), (1, 1, 1))
        self.assertEqual(diff["changed"][0]["new_bpm"], 200.0)
        self.assertEqual(diff["added"][0]["offset"], 4000.0)


if __name__ == "__main__":
    unittest.main()
