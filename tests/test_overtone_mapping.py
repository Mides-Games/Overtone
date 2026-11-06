"""Engine tests: A map's objects against the audio: writer, snap, density, mapset check, reference timing."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from overtone import (Analysis, TimingPoint, snap_timing_points, read_osu_beatmap,
                      set_beatmap_reds, write_osu_beatmap, alignment_report,
                      density_report, mapset_report)

from engine_support import (_CONTEXT_OSU, _FULL_OSU, _alignment_analysis,
                            _context_beatmap, _eighths, _mapset_osu, _write_osu,
                            setUpModule, tearDownModule)  # noqa: F401


class SnapAuditTests(unittest.TestCase):
    """Objects off the map's own grid, and what an inject would unsnap."""

    MAP = ("osu file format v14\r\n\r\n[General]\r\nAudioFilename: a.mp3\r\n\r\n"
           "[TimingPoints]\r\n1000,500,4,1,0,100,1,0\r\n5000,400,4,1,0,100,1,0\r\n\r\n"
           "[HitObjects]\r\n"
           "256,192,500,1,0,0:0:0:0:\r\n"      # before the first red line, on 1/1
           "256,192,1000,1,0,0:0:0:0:\r\n"     # 1/1
           "256,192,1250,1,0,0:0:0:0:\r\n"     # 1/2
           "256,192,1167,1,0,0:0:0:0:\r\n"     # 1/3: 1166.67, rounded
           "256,192,1125,1,0,0:0:0:0:\r\n"     # 1/4
           "256,192,1300,1,0,0:0:0:0:\r\n"     # off: nearest tick 1/12 at 1291.67
           "256,192,5200,1,0,0:0:0:0:\r\n"     # second red line (150 BPM): 1/2
           "256,192,70000,1,0,0:0:0:0:\r\n"    # past a 60 s audio, 1/2 of line two
           "broken line\r\n")

    def beatmap(self) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes(self.MAP.encode("utf-8"))
            return read_osu_beatmap(path)

    def test_objects_are_placed_on_their_own_red_line(self):
        from overtone import snap_audit

        report = snap_audit(self.beatmap(), duration_s=60.0)
        self.assertTrue(report["ok"])
        self.assertEqual((report["objects"], report["unparsed"], report["red_lines"]), (8, 1, 2))
        self.assertEqual(len(report["unsnapped"]), 1)
        off = report["unsnapped"][0]
        self.assertEqual((off["time_ms"], off["nearest_divisor"]), (1300.0, 12))
        self.assertAlmostEqual(off["off_ms"], round(1300 - (1000 + 7 / 12 * 500), 3))
        self.assertEqual(report["by_divisor"]["1"], 2)   # 500 and 1000
        # 1250; 5200 and 70000 on the second line's 400 ms beat (162.5 beats in)
        self.assertEqual(report["by_divisor"]["2"], 3)
        self.assertEqual(report["by_divisor"]["3"], 1)
        self.assertEqual(report["by_divisor"]["4"], 1)
        self.assertEqual(report["before_first_red"], [500.0])
        self.assertEqual(report["past_audio"], [70000.0])
        json.dumps(report)

    def test_a_shifted_detection_says_what_an_inject_would_unsnap(self):
        from overtone import snap_audit

        analysis = Analysis("x.wav", 60.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(1010.0, 120.0, 1.0, 0)], 128, 44100, 1.0)
        report = snap_audit(self.beatmap(), analysis)
        moved = report["with_detected_timing"]
        # 10 ms later, 120 BPM throughout: every snapped object moves off
        # except the ones a fine tick still catches within 2 ms. 1300, off
        # the map's grid, lands 1.7 ms from a 1/12 tick of the shifted one
        # and comes back on.
        self.assertGreater(len(moved["would_unsnap"]), 0)
        self.assertEqual(moved["would_snap"], 1)
        self.assertNotIn(1300.0, [m["time_ms"] for m in moved["would_unsnap"]])

    def test_no_red_lines_is_said_not_guessed(self):
        from overtone import snap_audit

        report = snap_audit({"timing": {"reds": []}, "hitobjects": [{"time": 5.0}]})
        self.assertEqual((report["ok"], report["reason"]), (False, "no_red_lines"))

    def test_rounding_up_to_2_ms_is_snapped_and_export_keeps_1_ms(self):
        from overtone import snap_audit

        # 61 ranked maps put 272 objects 1-2 ms from a tick: whole-ms objects on a
        # fractional beat. 1.5 ms is snapped, 2.5 ms is not.
        beatmap = {"timing": {"reds": [(1000.0, 180.0)]},
                   "hitobjects": [{"time": 1335.0, "kind": "circle"},     # 1/1 at 1333.33
                                  {"time": 1669.0, "kind": "circle"}]}    # 1/1 at 1666.67
        report = snap_audit(beatmap)
        self.assertEqual([o["time_ms"] for o in report["unsnapped"]], [1669.0])
        # Export snapping keeps its own 1 ms: a detected change 1.5 ms off the
        # previous grid stays where the music put it. (Both once shared one
        # name, and the audit's definition silently set export's too.)
        points = [TimingPoint(1000.0, 180.0, 0.9, 0), TimingPoint(21001.5, 181.0, 0.9, 60)]
        self.assertEqual(snap_timing_points(points)[1].offset_ms, 21001.5)


class SnapDivisorTests(unittest.TestCase):
    """Where the song needs 1/3, 1/4 or 1/6, per section."""

    @staticmethod
    def _analysis(points, attacks_s, duration=60.0, weight=1.0):
        analysis = Analysis("x.wav", duration, np.zeros(0), np.zeros(0),
                            points, 128, 44100, 1.0)
        analysis.attack_times = np.array(attacks_s, dtype=np.float64)
        analysis.attack_weights = np.full(len(attacks_s), weight)
        return analysis

    def test_triplets_read_third_quarters_read_quarter(self) -> None:
        from overtone import snap_divisors
        points = [TimingPoint(1000.0, 120.0, 0.9, 0)]
        triplets = [1.0 + k / 6.0 for k in range(13)]
        report = snap_divisors(self._analysis(points, triplets))
        json.dumps(report)
        section = report["sections"][0]
        self.assertEqual(section["divisor"], "1/3")
        self.assertEqual((section["attacks"], section["thirds"]), (13, 8))
        quarters = [1.0 + k * 0.125 for k in range(17)]
        plain = snap_divisors(self._analysis(points, quarters))["sections"][0]
        self.assertEqual((plain["divisor"], plain["thirds"], plain["sixths"]), ("1/4", 0, 0))

    def test_sixth_notes_read_sixth_and_swing_reads_other(self) -> None:
        from overtone import snap_divisors
        points = [TimingPoint(1000.0, 120.0, 0.9, 0)]
        sixths = [1.0 + (k + (1 / 6 if k % 2 == 0 else 5 / 6)) * 0.5 for k in range(6)]
        sixths += [1.0, 2.0]
        report = snap_divisors(self._analysis(points, sixths))["sections"][0]
        self.assertEqual((report["divisor"], report["sixths"]), ("1/6", 6))
        swung = [1.0 + k * 0.5 + (0.025 if k % 2 else 0.0) for k in range(9)]
        off = snap_divisors(self._analysis(points, swung))["sections"][0]
        self.assertEqual((off["divisor"], off["thirds"]), ("1/4", 0))
        self.assertGreater(off["finer"], 0)
        tight = snap_divisors(self._analysis(points, swung), tol_ms=5.0)["sections"][0]
        self.assertEqual((tight["divisor"], tight["other"]), ("1/4", 4))

    def test_sections_verdict_apart_and_empties_stay_quarter(self) -> None:
        from overtone import snap_divisors
        points = [TimingPoint(1000.0, 120.0, 0.9, 0), TimingPoint(5000.0, 120.0, 0.9, 10)]
        attacks = [1.0 + k / 6.0 for k in range(13)] + [5.0 + k * 0.125 for k in range(9)]
        report = snap_divisors(self._analysis(points, attacks))
        self.assertEqual([s["divisor"] for s in report["sections"]], ["1/3", "1/4"])
        self.assertEqual(snap_divisors(self._analysis(points, []))["sections"][0]["attacks"], 0)
        self.assertEqual(snap_divisors(self._analysis(points, []))["sections"][0]["divisor"], "1/4")
        bare = self._analysis([], [])
        self.assertEqual(snap_divisors(bare), {"sections": []})
        with self.assertRaises(ValueError):
            snap_divisors(self._analysis(points, [1.0]), tol_ms=0)

    def test_quiet_thirds_under_loud_quarters_stay_quarter(self) -> None:
        from overtone import snap_divisors
        points = [TimingPoint(1000.0, 120.0, 0.9, 0)]
        quarters = [1.0 + k * 0.5 for k in range(9)]
        thirds = [1.0 + k / 6.0 for k in (2, 4, 8, 10, 14, 16, 20, 22)]
        analysis = self._analysis(points, quarters + thirds)
        analysis.attack_weights = np.array([1.0] * 9 + [0.05] * 8)
        section = snap_divisors(analysis)["sections"][0]
        self.assertEqual(section["thirds"], 8)
        self.assertLess(section["third_share"], 0.10)
        self.assertEqual(section["divisor"], "1/4")


class SwingLaneTests(unittest.TestCase):
    """Where the off-beat eighth falls, eight beats at a time."""

    POINTS = [TimingPoint(1000.0, 120.0, 0.9, 0)]

    @staticmethod
    def _beats(places, beats=16, start=1.0, beat=0.5):
        """An attack on each beat and at each of ``places`` within it."""
        return np.array([start + k * beat + p * beat for k in range(beats) for p in (0.0,) + places])

    def _lane(self, times, points=None, weights=None, duration=9.0, **kwargs):
        from overtone import swing_lane
        weights = np.ones(len(times)) if weights is None else np.asarray(weights, dtype=float)
        report = swing_lane(self.POINTS if points is None else points, times, weights,
                            duration, **kwargs)
        json.dumps(report)
        return report

    def test_straight_eighths_read_straight(self) -> None:
        report = self._lane(self._beats((0.5,)))
        self.assertEqual([w["feel"] for w in report["windows"]], ["straight", "straight"])
        self.assertEqual([w["at"] for w in report["windows"]], [0.5, 0.5])
        self.assertEqual((report["swung"], report["measured"], report["spans"]), (0, 2, []))
        self.assertEqual(report["windows"][0]["start_ms"], 1000.0)
        self.assertEqual(report["windows"][1]["end_ms"], 9000.0)

    def test_a_light_swing_reads_its_place_and_its_snap(self) -> None:
        report = self._lane(self._beats((0.58,)))
        window = report["windows"][0]
        self.assertEqual((window["feel"], window["at"], window["ratio"], window["late_ms"]),
                         ("swing", 0.58, 1.38, 40.0))
        # 290 ms into a 500 ms beat: nothing coarser than 1/12 lands within 15 ms
        self.assertEqual((window["snap"], window["divisor"], window["snap_off_ms"]), ("7/12", 12, -1.7))
        self.assertEqual(len(report["spans"]), 1)
        span = report["spans"][0]
        self.assertEqual((span["start_ms"], span["end_ms"], span["windows"], span["at"], span["snap"]),
                         (1000.0, 9000.0, 2, 0.58, "7/12"))

    def test_triplet_swing_and_shuffle_land_on_the_snaps_mappers_use(self) -> None:
        triplet = self._lane(self._beats((2 / 3,)))["windows"][0]
        self.assertEqual((triplet["feel"], triplet["snap"], triplet["divisor"], triplet["ratio"]),
                         ("swing", "2/3", 3, 2.0))
        shuffle = self._lane(self._beats((0.75,)))["windows"][0]
        self.assertEqual((shuffle["feel"], shuffle["snap"], shuffle["divisor"], shuffle["ratio"]),
                         ("swing", "3/4", 4, 3.0))

    def test_triplets_and_sixteenths_are_not_swing(self) -> None:
        thirds = self._lane(self._beats((1 / 3, 2 / 3)))["windows"][0]
        self.assertEqual((thirds["feel"], thirds["snap"]), ("triplets", "2/3"))
        sixteenths = self._lane(self._beats((0.25, 0.5, 0.75)))["windows"][0]
        self.assertEqual(sixteenths["feel"], "straight")

    def test_the_beat_is_measured_from_its_own_attacks(self) -> None:
        # the whole song 20 ms after its grid: the swing is where it was
        window = self._lane(self._beats((0.58,)) + 0.02)["windows"][0]
        self.assertEqual((window["feel"], window["at"], window["on_ms"]), ("swing", 0.58, 20.0))

    def test_nothing_on_the_off_beat_says_none(self) -> None:
        beats_only = self._lane(self._beats(()))
        self.assertEqual([w["feel"] for w in beats_only["windows"]], ["none", "none"])
        self.assertEqual(beats_only["measured"], 0)
        silent = self._lane(np.zeros(0))
        self.assertEqual([w["feel"] for w in silent["windows"]], ["none", "none"])
        self.assertEqual(self._lane(np.zeros(0), points=[])["windows"], [])

    def test_a_faint_straight_eighth_under_a_loud_swung_one(self) -> None:
        times = self._beats((0.5, 0.66))
        faint = np.tile([1.0, 0.2, 1.0], 16)
        self.assertEqual(self._lane(times, weights=faint)["windows"][0]["feel"], "swing")
        heard = np.tile([1.0, 0.3, 1.0], 16)
        self.assertEqual(self._lane(times, weights=heard)["windows"][0]["feel"], "straight")

    def test_a_swing_on_too_few_beats_is_not_one(self) -> None:
        times = [1.0 + k * 0.5 + (0.33 if k % 8 < 3 else 0.25) for k in range(16)]
        times = np.sort(np.concatenate([self._beats(()), times]))
        self.assertEqual([w["feel"] for w in self._lane(times)["windows"]], ["straight", "straight"])

    def test_windows_restart_at_red_lines_and_short_remainders_join(self) -> None:
        points = [TimingPoint(1000.0, 120.0, 0.9, 0), TimingPoint(5500.0, 120.0, 0.9, 9)]
        times = np.concatenate([self._beats((0.66,), beats=9), self._beats((0.5,), beats=13, start=5.5)])
        report = self._lane(times, points=points, duration=12.0)
        self.assertEqual([(w["beats"], w["feel"]) for w in report["windows"]],
                         [(9, "swing"), (8, "straight"), (5, "straight")])
        self.assertEqual([(s["start_ms"], s["end_ms"]) for s in report["spans"]], [(1000.0, 5500.0)])

    def test_bad_input(self) -> None:
        from overtone import swing_lane
        with self.assertRaises(ValueError):
            swing_lane(self.POINTS, np.zeros(0), np.zeros(0), 9.0, tol_ms=0)
        with self.assertRaises(ValueError):
            swing_lane(self.POINTS, np.zeros(0), np.zeros(0), 9.0, window_beats=1)
        times = np.append(self._beats((0.58,)), [np.nan, np.inf])
        report = self._lane(times, weights=np.ones(3))  # a weight per attack or none
        self.assertEqual(report["windows"][0]["feel"], "swing")

    def test_the_benchmark_fixtures_read_their_truth(self) -> None:
        # bench/benchmark.py places each off-beat hat at step / 2 + swing * step
        golden = Path(__file__).resolve().parent.parent / "bench" / "golden"
        for case, truth in (("swing-120", 0.58), ("shuffle-96", 0.66), ("edm-174", None)):
            vector = json.loads((golden / f"{case}.json").read_text(encoding="utf-8"))
            points = [TimingPoint(p["offset_ms"], p["bpm"], p["confidence"], 0)
                      for p in vector["result"]["points"]]
            report = self._lane(np.asarray(vector["attacks"]["times_s"]), points=points,
                                weights=vector["attacks"]["weights"],
                                duration=vector["result"]["duration_s"])
            feels = {w["feel"] for w in report["windows"]}
            if truth is None:
                self.assertEqual(feels, {"straight"}, case)
                continue
            self.assertEqual(feels, {"swing"}, case)
            for window in report["windows"]:
                self.assertAlmostEqual(window["at"], truth, delta=0.005, msg=case)


class MapWriterTests(unittest.TestCase):
    @staticmethod
    def _kiai_map(timing: str):
        lines = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
                 "[TimingPoints]"] + timing.split("\n") + ["", "[HitObjects]",
                 "256,192,1000,1,0,0:0:0:0:", ""]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes("\r\n".join(lines).encode("utf-8"))
            return read_osu_beatmap(path)

    def _write(self, raw: bytes, name: str = "map.osu"):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / name
            target.write_bytes(raw)
            beatmap = read_osu_beatmap(target)
            out = Path(tmp) / ("out-" + name)
            info = write_osu_beatmap(out, beatmap)
            result = out.read_bytes()
        json.dumps(info)
        return beatmap, result, info

    def test_untouched_file_round_trips_byte_identical(self) -> None:
        for newline in ("\n", "\r\n"):
            raw = _FULL_OSU.replace("\n", newline).encode("utf-8")
            _beatmap, result, info = self._write(raw)
            self.assertEqual(result, raw)
            self.assertTrue(info["bytes"] > 0)
            self.assertFalse(info["backup"])  # new path: nothing to protect

    def test_bom_and_missing_trailing_newline_survive(self) -> None:
        raw = b"\xef\xbb\xbf" + _FULL_OSU.encode("utf-8")
        _beatmap, result, _info = self._write(raw)
        self.assertEqual(result, raw)
        raw = _FULL_OSU.encode("utf-8").rstrip(b"\n")
        _beatmap, result, _info = self._write(raw)
        self.assertEqual(result, raw)

    def test_mixed_line_endings_survive_read_write_and_set_reds(self) -> None:
        # A CRLF map with bare LFs, as in a real one from the Songs folder
        # (a lone "\n" before [Colours]). Bytes, not _write_osu: text mode
        # would translate the endings on Windows before the reader saw them.
        red = b"1000,400,4,1,0,100,1,0"
        raw = (_FULL_OSU.replace("\n", "\r\n").encode("utf-8")
               .replace(b"osu file format v14\r\n", b"osu file format v14\n")
               .replace(b"[Metadata]\r\n", b"[Metadata]\n")
               .replace(red + b"\r\n", red + b"\n")
               .replace(b"\r\n[Colours]", b"\n[Colours]"))
        self.assertEqual(raw.count(b"\r\n"), _FULL_OSU.count("\n") - 4)
        beatmap, result, info = self._write(raw)
        self.assertEqual(result, raw)
        self.assertFalse(info["backup"])
        self.assertEqual(beatmap["newline"], "\r\n")
        # An edit keeps every other line's ending; a new red takes the ending
        # of the red it replaces, and one past the old count the file's own.
        one, two = b"1000,60000,4,1,0,100,1,0", b"5000,30000,4,1,0,100,1,0"
        for reds, expected in (([one], raw.replace(red + b"\n", one + b"\n")),
                               ([one, two], raw.replace(red + b"\n",
                                                        one + b"\n" + two + b"\r\n"))):
            with tempfile.TemporaryDirectory() as tmp:
                target = Path(tmp) / "map.osu"
                target.write_bytes(raw)
                beatmap = read_osu_beatmap(target)
                self.assertEqual(set_beatmap_reds(beatmap, [r.decode() for r in reds]), 1)
                write_osu_beatmap(target, beatmap)
                self.assertEqual(target.read_bytes(), expected)
                self.assertEqual(Path(str(target) + ".bak").read_bytes(), raw)

    def test_set_reds_changes_only_reds_with_pristine_backup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            original = _FULL_OSU.encode("utf-8")
            target.write_bytes(original)
            beatmap = read_osu_beatmap(target)
            replaced = set_beatmap_reds(beatmap, ["1000,60000.000000000000,4,1,0,100,1,0"])
            self.assertEqual(replaced, 1)
            self.assertEqual(beatmap["timing"]["reds"], [(1000.0, 1.0)])
            self.assertEqual(beatmap["timing"]["greens"], ["2000,-100,4,2,0,100,0,0"])
            info = write_osu_beatmap(target, beatmap)
            self.assertTrue(info["backup"])
            kept = [line for line in target.read_text(encoding="utf-8").splitlines()
                    if line.strip() and not line.strip().startswith("//")]
            before = [line for line in original.decode("utf-8").splitlines()
                      if line.strip() and not line.strip().startswith("//")]
            self.assertEqual(len(kept), len(before))
            self.assertEqual([l for l in kept if "Combo1" in l or "bg.jpg" in l],
                             [l for l in before if "Combo1" in l or "bg.jpg" in l])
            # A second write keeps the pristine original, never the last write,
            # and keeps what it replaces beside it.
            first_write = target.read_bytes()
            set_beatmap_reds(beatmap, ["1000,30000.000000000000,4,1,0,100,1,0"])
            info = write_osu_beatmap(target, beatmap)
            self.assertEqual(Path(str(target) + ".bak").read_bytes(), original)
            self.assertEqual(info["backup"], str(target) + ".bak2")
            self.assertEqual(Path(info["backup"]).read_bytes(), first_write)

    def test_set_reds_without_timing_section_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[General]\nAudioFilename: a.mp3\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                set_beatmap_reds(read_osu_beatmap(target), ["1,500,4,1,0,100,1,0"])

    @staticmethod
    def _kiai_reads(beatmap, times_ms):
        from overtone import _TimingCursor
        cursor = _TimingCursor(beatmap)
        return [cursor.at(t)[1].kiai for t in times_ms]

    def test_chorus_kiai_opens_and_closes_carrying_state(self) -> None:
        from overtone import set_chorus_kiai, sound_events
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n1500,-100,4,2,1,60,0,0")
        before = sound_events(beatmap)
        result = set_chorus_kiai(beatmap, [(1000.0, 2000.0)])
        json.dumps(result)
        # The map's own green inside the chorus would switch kiai off half
        # way through: it is lit too, not left to cancel the chorus.
        self.assertEqual(result, {"added": 2, "flipped": 1, "kept": 0})
        self.assertEqual(sound_events(beatmap), before)
        greens = beatmap["timing"]["greens"]
        self.assertEqual([(g.split(",")[0], g.split(",")[7]) for g in greens],
                         [("1000", "1"), ("1500", "1"), ("2000", "0")])
        self.assertTrue(greens[0].startswith("1000,-100,"))
        self.assertEqual(self._kiai_reads(beatmap, [900, 1200, 1700, 2100]), [False, True, True, False])
        # Second run changes nothing: kiai already reads right.
        self.assertEqual(set_chorus_kiai(beatmap, [(1000.0, 2000.0)]),
                         {"added": 0, "flipped": 0, "kept": 2})

    def test_chorus_kiai_keeps_touching_choruses_lit(self) -> None:
        # Two choruses back to back: the seam closed kiai right after the
        # second one opened, so only the first was lit (Master of Tides).
        from overtone import set_chorus_kiai
        beatmap = self._kiai_map("0,500,4,2,1,70,1,0\n2000,-100,4,2,1,60")
        result = set_chorus_kiai(beatmap, [(1000.0, 2000.0), (2000.0, 3000.0)])
        self.assertEqual(result, {"added": 2, "flipped": 1, "kept": 0})
        self.assertEqual(self._kiai_reads(beatmap, [900, 1500, 2000, 2500, 3100]),
                         [False, True, True, True, False])
        # An old six-field green takes the defaults osu! reads for the rest.
        self.assertIn("2000,-100,4,2,1,60,0,1", beatmap["timing"]["greens"])

    def test_chorus_kiai_lights_a_red_line_inside_and_gives_back_the_maps_own(self) -> None:
        from overtone import set_chorus_kiai, sound_events
        # A tempo change inside the chorus carries its own kiai bit (off); the
        # mapper's own kiai from 1800 runs past the chorus and stays.
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n1400,400,4,2,1,70,1,0\n"
                                 "1800,-100,4,2,1,70,0,1\n2500,-100,4,2,1,70,0,0")
        before = sound_events(beatmap)
        result = set_chorus_kiai(beatmap, [(1000.0, 2000.0)])
        self.assertEqual(result, {"added": 2, "flipped": 0, "kept": 1})
        self.assertEqual(sound_events(beatmap), before)
        self.assertEqual(self._kiai_reads(beatmap, [1200, 1500, 1900, 2200, 2600]),
                         [True, True, True, True, False])
        self.assertEqual([g.split(",")[0] for g in beatmap["timing"]["greens"]],
                         ["1000", "1400", "1800", "2500"])

    def test_chorus_kiai_follows_a_red_line_to_its_last_decimal(self) -> None:
        # Rounded to three decimals, a green meant to follow a lazer-precision
        # red line landed before it, and the red line switched kiai off again.
        from overtone import set_chorus_kiai
        beatmap = self._kiai_map("0,500,4,2,1,70,1,0\n1500.0114440535,400,4,2,1,70,1,0")
        set_chorus_kiai(beatmap, [(1000.0, 2000.0)])
        self.assertIn("1500.0114440535,-100,4,2,1,70,0,1", beatmap["timing"]["greens"])
        self.assertEqual(self._kiai_reads(beatmap, [1600]), [True])

    def test_chorus_kiai_writes_nothing_before_the_first_red_line(self) -> None:
        # osu! reads the first line's settings back to the song's start: a
        # green before it would become what the whole intro reads.
        from overtone import set_chorus_kiai
        beatmap = self._kiai_map("5000,500,4,2,1,70,1,0")
        set_chorus_kiai(beatmap, [(1000.0, 8000.0)])
        times = [float(g.split(",")[0]) for g in beatmap["timing"]["greens"]]
        self.assertEqual(times, [5000.0, 8000.0])
        self.assertEqual(self._kiai_reads(beatmap, [6000, 9000]), [True, False])

    def test_chorus_kiai_keeps_each_lines_own_ending(self) -> None:
        from overtone import set_chorus_kiai, write_osu_beatmap
        raw = ("osu file format v14\r\n\r\n[General]\r\nAudioFilename: audio.mp3\r\n\r\n"
               "[TimingPoints]\r\n1000,500,4,2,1,70,1,0\n3000,-100,4,2,1,60,0,0\r\n\r\n"
               "[HitObjects]\r\n256,192,1000,1,0,0:0:0:0:\r\n").encode("utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes(raw)
            beatmap = read_osu_beatmap(path)
            set_chorus_kiai(beatmap, [(1500.0, 2000.0)])
            write_osu_beatmap(path, beatmap, backup=False)
            written = path.read_bytes()
        # The red line's bare LF survives the insert; the new greens take CRLF.
        self.assertIn(b"1000,500,4,2,1,70,1,0\n1500,", written)
        self.assertIn(b"1500,-100,4,2,1,70,0,1\r\n2000,-100,4,2,1,70,0,0\r\n3000,", written)

    def test_chorus_kiai_flips_a_green_instead_of_doubling(self) -> None:
        from overtone import set_chorus_kiai
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n1000,-100,4,2,1,70,0,0")
        result = set_chorus_kiai(beatmap, [(1000.0, 2000.0)])
        self.assertEqual((result["flipped"], result["added"]),
                         (1, 1))
        self.assertEqual(len(beatmap["timing"]["greens"]), 2)

    @staticmethod
    def _breaks_map(events: str, objects: str):
        lines = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
                 "[Events]"] + events.split("\n") + ["", "[TimingPoints]",
                 "0,500,4,2,0,70,1,0", "", "[HitObjects]"] + objects.split("\n") + [""]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes("\r\n".join(lines).encode("utf-8"))
            return read_osu_beatmap(path)

    _BREAK_SECTIONS = [
        {"start_s": 0.0, "end_s": 10.0, "kind": "verse", "level_db": -8.0},
        {"start_s": 10.0, "end_s": 40.0, "kind": "chorus", "level_db": -14.0},
    ]

    def test_suggest_breaks_cuts_quiet_gaps(self) -> None:
        from overtone import suggest_breaks
        beatmap = self._breaks_map(
            "//Background and Video events\n//Break Periods",
            "256,192,1000,1,0,0:0:0:0:\n256,192,2000,1,0,0:0:0:0:\n256,192,30000,1,0,0:0:0:0:")
        spans = suggest_breaks(beatmap, self._BREAK_SECTIONS)
        json.dumps(spans)
        self.assertEqual(spans, [{"start_ms": 10000, "end_ms": 30000, "kind": "chorus",
                                  "under_db": 6.0, "gap_s": 28.0}])

    def test_suggest_breaks_silent_where_loud_or_short(self) -> None:
        from overtone import suggest_breaks
        beatmap = self._breaks_map(
            "//Break Periods",
            "256,192,1000,1,0,0:0:0:0:\n256,192,2000,1,0,0:0:0:0:\n256,192,6000,1,0,0:0:0:0:")
        loud = [dict(s, level_db=-8.0) for s in self._BREAK_SECTIONS]
        self.assertEqual(suggest_breaks(beatmap, loud), [])
        self.assertEqual(suggest_breaks(beatmap, self._BREAK_SECTIONS), [])

    def test_set_map_breaks_adds_after_the_comment_and_dedupes(self) -> None:
        from overtone import set_map_breaks
        beatmap = self._breaks_map(
            "//Background and Video events\n//Break Periods",
            "256,192,1000,1,0,0:0:0:0:")
        self.assertEqual(set_map_breaks(beatmap, [(10000.0, 30000.0)]),
                         {"added": 1, "kept": 0})
        lines = next(s for s in beatmap["sections"] if s["name"] == "Events")["lines"]
        self.assertEqual(lines[1:3], ["//Break Periods", "2,10000,30000"])
        self.assertEqual(set_map_breaks(beatmap, [(10000.0, 30000.0)]),
                         {"added": 0, "kept": 1})

    def test_set_map_breaks_refuses_junk_and_missing_events(self) -> None:
        from overtone import set_map_breaks
        beatmap = self._breaks_map("//Break Periods", "256,192,1000,1,0,0:0:0:0:")
        with self.assertRaises(ValueError):
            set_map_breaks(beatmap, [(5000.0, 5000.0)])
        with self.assertRaises(ValueError):
            set_map_breaks(beatmap, [(9000.0, 4000.0)])
        bare = self._kiai_map("0,500,4,2,0,70,1,0")
        with self.assertRaises(ValueError):
            set_map_breaks(bare, [(10000.0, 30000.0)])

    def test_constant_scroll_compensates_bpm_changes(self) -> None:
        from overtone import set_constant_scroll, sound_events
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n2000,400,4,2,1,70,1,0")
        before = sound_events(beatmap)
        result = set_constant_scroll(beatmap)
        json.dumps(result)
        self.assertEqual(result, {"added": 1, "flipped": 0, "kept": 0})
        self.assertEqual(sound_events(beatmap), before)
        self.assertEqual(beatmap["timing"]["greens"], ["2000,-125,4,2,1,70,0,0"])
        self.assertEqual(set_constant_scroll(beatmap), {"added": 0, "flipped": 0, "kept": 1})

    def test_constant_scroll_leaves_reference_tempo_alone(self) -> None:
        from overtone import set_constant_scroll
        same = self._kiai_map("1000,500,4,2,1,70,1,0\n2000,500,4,2,1,70,1,0")
        self.assertEqual(set_constant_scroll(same), {"added": 0, "flipped": 0, "kept": 0})
        single = self._kiai_map("1000,500,4,2,1,70,1,0")
        self.assertEqual(set_constant_scroll(single), {"added": 0, "flipped": 0, "kept": 0})
        with self.assertRaises(ValueError):
            set_constant_scroll({"sections": []})

    def test_constant_scroll_rewrites_a_wrong_green(self) -> None:
        from overtone import set_constant_scroll
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n2000,400,4,2,1,70,1,0\n"
                                 "2000,-100,4,2,1,70,0,0")
        self.assertEqual(set_constant_scroll(beatmap), {"added": 0, "flipped": 1, "kept": 0})
        self.assertEqual(beatmap["timing"]["greens"], ["2000,-125,4,2,1,70,0,0"])

    def test_constant_scroll_scales_the_maps_own_greens(self) -> None:
        # Only a green at the red line went in before: the map's 0.5x and
        # 1.25x after the change stayed relative to 150 BPM and undid it at
        # the first one. Every green under the change now scales by 120/150.
        from overtone import set_constant_scroll, sound_events
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n1500,-133.333333333333,4,2,1,70,0,0\n"
                                 "2000,400,4,2,1,70,1,0\n2500,-200,4,2,1,70,0,0\n"
                                 "3000,-80,4,2,1,70,0,0")
        before = sound_events(beatmap)
        self.assertEqual(set_constant_scroll(beatmap), {"added": 1, "flipped": 2, "kept": 0})
        self.assertEqual(sound_events(beatmap), before)
        self.assertEqual(beatmap["timing"]["greens"],
                         ["1500,-133.333333333333,4,2,1,70,0,0", "2000,-125,4,2,1,70,0,0",
                          "2500,-250,4,2,1,70,0,0", "3000,-100,4,2,1,70,0,0"])
        # Normalised now: a second run finds the span constant and scales nothing.
        self.assertEqual(set_constant_scroll(beatmap), {"added": 0, "flipped": 0, "kept": 1})

    def test_constant_scroll_keeps_a_span_normalised_by_hand(self) -> None:
        from overtone import set_constant_scroll
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n2000,400,4,2,1,70,1,0\n"
                                 "2000,-125,4,2,1,70,0,0\n2500,-250,4,2,1,70,0,0")
        self.assertEqual(set_constant_scroll(beatmap), {"added": 0, "flipped": 0, "kept": 1})
        self.assertEqual(beatmap["timing"]["greens"],
                         ["2000,-125,4,2,1,70,0,0", "2500,-250,4,2,1,70,0,0"])

    def test_constant_scroll_green_follows_a_red_line_to_its_last_decimal(self) -> None:
        from overtone import set_constant_scroll
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n2000.0114440535,400,4,2,1,70,1,0")
        set_constant_scroll(beatmap)
        self.assertEqual(beatmap["timing"]["greens"], ["2000.0114440535,-125,4,2,1,70,0,0"])

    def test_scroll_profile_follows_scroll_and_nothing_else(self) -> None:
        from overtone import scroll_profile, set_chorus_kiai, set_constant_scroll, set_section_volumes
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n1500,-125,4,2,1,70,0,0\n"
                                 "2000,400,4,2,1,70,1,0")
        plain = scroll_profile(beatmap)
        set_chorus_kiai(beatmap, [(1200.0, 1800.0)])
        set_section_volumes(beatmap, [{"start_s": 1.0, "end_s": 1.8, "level_db": -6.0},
                                      {"start_s": 1.8, "end_s": 9.0, "level_db": 0.0}])
        self.assertEqual(scroll_profile(beatmap), plain)       # light and sound, not scroll
        set_constant_scroll(beatmap)
        self.assertNotEqual(scroll_profile(beatmap), plain)

    def test_constant_scroll_refuses_to_move_slider_ends(self) -> None:
        # A slider lasts by the SV it starts under: scaled, its tail and
        # repeats leave their beats. The first version moved slider ends on
        # 194 of 225 local maps with BPM changes.
        from overtone import ScrollMovesSliders, set_constant_scroll
        timing = "1000,500,4,2,1,70,1,0\n2000,400,4,2,1,70,1,0"
        lines = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
                 "[Difficulty]", "SliderMultiplier:1.4", "", "[TimingPoints]"] + timing.split("\n") + [
                 "", "[HitObjects]", "256,192,1200,2,0,L|356:192,1,140", "256,192,2400,2,0,L|356:192,1,140",
                 "256,192,2800,2,0,L|356:192,1,140", ""]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes("\r\n".join(lines).encode("utf-8"))
            beatmap = read_osu_beatmap(path)
        with self.assertRaises(ScrollMovesSliders) as refused:
            set_constant_scroll(beatmap)
        # Two sliders start after the change; the one before it stays out of it.
        self.assertEqual((refused.exception.count, refused.exception.first_ms), (2, 2400.0))
        self.assertEqual(beatmap["timing"]["greens"], [])

    def test_constant_scroll_refuses_a_multiplier_osu_cannot_play(self) -> None:
        from overtone import set_constant_scroll
        # 120 -> 60 BPM doubles every multiplier: 8.33x would become 16.7x.
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n2000,1000,4,2,1,70,1,0\n"
                                 "2500,-12,4,2,1,70,0,0")
        with self.assertRaisesRegex(ValueError, "2500"):
            set_constant_scroll(beatmap)

    _VOLUME_SECTIONS = [
        {"start_s": 0.0, "end_s": 10.0, "kind": "verse", "level_db": -8.0},
        {"start_s": 10.0, "end_s": 40.0, "kind": "chorus", "level_db": -14.0},
    ]

    @staticmethod
    def _volumes_read(beatmap, times_ms):
        from overtone import _TimingCursor
        cursor = _TimingCursor(beatmap)
        return [cursor.at(t)[1].volume for t in times_ms]

    def test_section_volumes_follow_energy_and_keep_the_mappers(self) -> None:
        from overtone import set_section_volumes
        # The verse, loudest, changes volume at 1500: the mapper's, kept. The
        # chorus plays 60 throughout: set to its target, the anchor being the
        # volume the verse plays longest (60), not the one at its start (70).
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n1500,-100,4,2,1,60,0,0")
        result = set_section_volumes(beatmap, self._VOLUME_SECTIONS)
        json.dumps(result)
        self.assertEqual(result, {"added": 1, "flipped": 0, "kept": 0, "mapper": 1, "set": 1})
        self.assertEqual(beatmap["timing"]["greens"],
                         ["1500,-100,4,2,1,60,0,0", "10000,-100,4,2,1,30,0,0"])
        self.assertEqual(self._volumes_read(beatmap, [1200, 5000, 20000]), [70, 60, 30])
        self.assertEqual(set_section_volumes(beatmap, self._VOLUME_SECTIONS),
                         {"added": 0, "flipped": 0, "kept": 1, "mapper": 1, "set": 0})

    def test_section_volumes_leave_a_mappers_volume_at_a_section_start(self) -> None:
        # A green at the chorus start with its own volume is the mapper's
        # choice: the old tool rewrote it to the target.
        from overtone import set_section_volumes
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0\n"
                                 "10000,-100,4,2,1,60,0,0")
        self.assertEqual(set_section_volumes(beatmap, self._VOLUME_SECTIONS),
                         {"added": 0, "flipped": 0, "kept": 1, "mapper": 1, "set": 0})
        self.assertEqual(beatmap["timing"]["greens"], ["10000,-100,4,2,1,60,0,0"])

    def test_section_volumes_set_a_flat_section_all_the_way_through(self) -> None:
        # The map plays 60 everywhere: an SV green and a tempo change inside
        # the quiet verse would each have put 60 back a beat in. Both take the
        # target, and the loud chorus after it keeps its 60.
        from overtone import set_section_volumes, sound_events
        beatmap = self._kiai_map("0,500,4,2,1,60,1,0\n4000,-125,4,2,1,60,0,0\n"
                                 "6000,400,4,2,1,60,1,0")
        sections = [{"start_s": 0.0, "end_s": 10.0, "kind": "verse", "level_db": -12.0},
                    {"start_s": 10.0, "end_s": 40.0, "kind": "chorus", "level_db": -6.0}]
        before = [(e["time"], e["sounds"], e["normal_set"]) for e in sound_events(beatmap)]
        result = set_section_volumes(beatmap, sections)
        # A green at the verse start and at the red line inside, the SV
        # green's volume rewritten, and a green giving the chorus its 60 back.
        self.assertEqual(result, {"added": 3, "flipped": 1, "kept": 1, "mapper": 0, "set": 1})
        self.assertEqual(self._volumes_read(beatmap, [1000, 5000, 7000, 12000]), [30, 30, 30, 60])
        self.assertIn("4000,-125,4,2,1,30,0,0", beatmap["timing"]["greens"])
        self.assertIn("6000,-100,4,2,1,30,0,0", beatmap["timing"]["greens"])
        self.assertIn("10000,-100,4,2,1,60,0,0", beatmap["timing"]["greens"])
        self.assertEqual([(e["time"], e["sounds"], e["normal_set"]) for e in sound_events(beatmap)],
                         before)
        self.assertEqual(set_section_volumes(beatmap, sections),
                         {"added": 0, "flipped": 0, "kept": 2, "mapper": 0, "set": 0})

    def test_section_volumes_anchor_on_what_the_loudest_part_plays_longest(self) -> None:
        # A 5 % mute at the loudest section's start (Master of Tides has one)
        # would have scaled every target from 5.
        from overtone import set_section_volumes
        beatmap = self._kiai_map("0,500,4,2,1,70,1,0\n10000,-100,4,2,1,5,0,0\n"
                                 "10200,-100,4,2,1,80,0,0")
        sections = [{"start_s": 0.0, "end_s": 10.0, "kind": "verse", "level_db": -12.0},
                    {"start_s": 10.0, "end_s": 40.0, "kind": "chorus", "level_db": -6.0}]
        set_section_volumes(beatmap, sections)
        self.assertEqual(self._volumes_read(beatmap, [5000]), [40])      # 80 at -6 dB

    def test_section_volumes_follow_a_red_line_to_its_last_decimal(self) -> None:
        # Rounded to 17837.011, the green landed before a lazer-precision red
        # line at 17837.0114440535, which then put its own volume back.
        from overtone import set_section_volumes
        beatmap = self._kiai_map("0,500,4,2,1,60,1,0\n1700.0114440535,400,4,2,1,60,1,0")
        sections = [{"start_s": 0.0, "end_s": 10.0, "kind": "verse", "level_db": -12.0},
                    {"start_s": 10.0, "end_s": 40.0, "kind": "chorus", "level_db": -6.0}]
        set_section_volumes(beatmap, sections)
        self.assertIn("1700.0114440535,-100,4,2,1,30,0,0", beatmap["timing"]["greens"])
        self.assertEqual(self._volumes_read(beatmap, [1800]), [30])

    def test_section_volumes_write_nothing_before_the_first_red_line(self) -> None:
        # A green at 20 s before a first red line at 44 s became what the whole
        # intro read, the anchor's section included: a second run then
        # rescaled everything from it (a real map, Age Of Reason).
        from overtone import set_section_volumes
        beatmap = self._kiai_map("44000,500,4,2,1,52,1,0")
        sections = [{"start_s": 0.0, "end_s": 20.0, "kind": "intro", "level_db": 0.0},
                    {"start_s": 20.0, "end_s": 60.0, "kind": "verse", "level_db": -6.0},
                    {"start_s": 60.0, "end_s": 90.0, "kind": "chorus", "level_db": -3.0}]
        first = set_section_volumes(beatmap, sections)
        times = [float(g.split(",")[0]) for g in beatmap["timing"]["greens"]]
        self.assertTrue(all(t >= 44000 for t in times), times)
        self.assertEqual(first["added"], 2)          # the verse from 44 s, and the chorus's own back
        self.assertEqual(set_section_volumes(beatmap, sections)["added"]
                         + set_section_volumes(beatmap, sections)["flipped"], 0)

    def test_section_volumes_never_go_under_osus_floor(self) -> None:
        # A fade 47 dB under the loudest section came out at volume 0.
        from overtone import MIN_SAMPLE_VOLUME, set_section_volumes
        beatmap = self._kiai_map("0,500,4,2,1,70,1,0")
        sections = [{"start_s": 0.0, "end_s": 10.0, "kind": "chorus", "level_db": 0.0},
                    {"start_s": 10.0, "end_s": 12.0, "kind": "outro", "level_db": -47.0}]
        set_section_volumes(beatmap, sections)
        self.assertEqual(self._volumes_read(beatmap, [11000]), [MIN_SAMPLE_VOLUME])

    def test_section_volumes_silent_without_levels_or_timing(self) -> None:
        from overtone import set_section_volumes
        beatmap = self._kiai_map("1000,500,4,2,1,70,1,0")
        nothing = {"added": 0, "flipped": 0, "kept": 0, "mapper": 0, "set": 0}
        self.assertEqual(set_section_volumes(beatmap, []), nothing)
        self.assertEqual(set_section_volumes(beatmap, [{"start_s": 0.0}]), nothing)
        with self.assertRaises(ValueError):
            set_section_volumes({"sections": []}, self._VOLUME_SECTIONS)


class AlignmentTests(unittest.TestCase):
    def test_aligned_map_is_clean(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = _context_beatmap(tmp)
        times = [1.0, 1.1, 1.2, 1.4, 5.0, 8.0]
        report = alignment_report(
            _alignment_analysis(times, np.ones(len(times))), beatmap)
        self.assertEqual((report["objects"], report["matched"]), (6, 6))
        self.assertEqual((report["attacks"], report["covered"]), (6, 6))
        self.assertEqual(report["offenders"], [])
        self.assertEqual(report["uncovered"], [])
        self.assertEqual(report["findings"], [])
        json.dumps(report)

    def test_shifted_object_and_stray_attack_are_flagged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = _context_beatmap(
                tmp, _CONTEXT_OSU.replace("80,192,1100,", "80,192,1300,"))
        times = [1.0, 1.1, 1.2, 1.4, 5.0, 8.0, 30.0, 20.0]
        weights = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.1]
        report = alignment_report(_alignment_analysis(times, weights), beatmap)
        self.assertEqual(report["offenders"], [{"time": 1300.0, "kind": "circle", "ms": 100.0}])
        # The abandoned attack joins the stray; the weak one stays unreported.
        self.assertEqual(report["uncovered"], [1100.0, 30000.0])
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("warn", "objects_off_grid"), ("warn", "attacks_without_objects")])
        self.assertEqual(report["findings"][0]["values"], {"n": 1, "worst": 100.0})

    def test_no_attacks_reports_instead_of_inventing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = _context_beatmap(tmp)
        report = alignment_report(_alignment_analysis([], []), beatmap)
        self.assertEqual(report["objects"], 6)
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("info", "no_attacks")])


class DensityTests(unittest.TestCase):
    def _report(self, text, **kwargs):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(text, encoding="utf-8")
            report = density_report(read_osu_beatmap(target), **kwargs)
        json.dumps(report)
        return report

    def test_stream_section_reads_ten_per_second(self) -> None:
        lines = ["osu file format v14", "", "[HitObjects]"]
        lines += [f"64,192,{n * 100},1,0,0:0:0:0:" for n in range(21)]
        report = self._report("\n".join(lines) + "\n")
        self.assertEqual(report["objects"], 21)
        self.assertEqual(len(report["buckets"]), 1)
        bucket = report["buckets"][0]
        self.assertEqual((bucket["objects"], bucket["stream"]), (21, 21))
        self.assertAlmostEqual(bucket["per_second"], 4.2)
        self.assertEqual(report["peak_per_second"], 4.2)

    def test_mixed_map_splits_stream_jump_single(self) -> None:
        report = self._report(_CONTEXT_OSU)
        self.assertEqual(report["objects"], 6)
        self.assertEqual((report["stream"], report["jump"], report["single"]), (3, 1, 2))
        self.assertEqual(len(report["buckets"]), 2)
        self.assertEqual(report["buckets"][0]["objects"], 4)
        self.assertEqual(report["buckets"][1]["objects"], 2)

    def test_empty_map_and_bad_bucket(self) -> None:
        report = self._report("[General]\n")
        self.assertEqual(report, {"objects": 0, "buckets": [], "peak_per_second": 0.0,
                                  "mean_per_second": 0.0, "stream": 0, "jump": 0, "single": 0})
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[General]\n", encoding="utf-8")
            beatmap = read_osu_beatmap(target)
        with self.assertRaises(ValueError):
            density_report(beatmap, bucket_s=0)


class MapsetReportTests(unittest.TestCase):
    """Proposal P1: what the difficulties of one set must share. Read only."""

    def _report(self, maps: dict, raw: dict | None = None) -> dict:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "123 Band - Song"
            root.mkdir()
            for name, text in maps.items():
                (root / f"Band - Song (Mapper) [{name}].osu").write_bytes(text.encode("utf-8"))
            for name, data in (raw or {}).items():
                (root / name).write_bytes(data)
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            report = mapset_report(root)
            after = {p.name: p.read_bytes() for p in root.iterdir()}
        self.assertEqual(before, after)  # read only: nothing written, nothing fixed
        json.dumps(report)
        return report

    def test_identical_mapset_has_no_differences(self) -> None:
        report = self._report({name: _mapset_osu(name) for name in ("Easy", "Hard", "Insane")})
        self.assertTrue(report["consistent"])
        self.assertEqual(report["differences"], 0)
        self.assertEqual(report["red_lines"], [])
        self.assertTrue(all(f["identical"] for f in report["fields"]))
        self.assertEqual([f["field"] for f in report["fields"]],
                         ["AudioFilename", "PreviewTime", "AudioLeadIn", "Artist", "ArtistUnicode",
                          "Title", "TitleUnicode", "Creator", "Source", "Tags"])
        self.assertEqual([d["difficulty"] for d in report["difficulties"]], ["Easy", "Hard", "Insane"])
        self.assertEqual(report["reference"], "Band - Song (Mapper) [Easy].osu")
        for entry in report["difficulties"]:
            self.assertTrue(entry["readable"])
            self.assertEqual(entry["red_lines"], 2)
            self.assertEqual(entry["checks"], {"red_lines": 0, "audio": [], "metadata": []})

    def test_shifted_red_line_is_reported_against_the_majority(self) -> None:
        # The odd one sorts first: the reference must still be a majority map,
        # so only Easy is flagged, not Hard and Insane for disagreeing with it.
        maps = {name: _mapset_osu(name) for name in ("Hard", "Insane")}
        maps["Easy"] = _mapset_osu("Easy", reds=((1000, 400.0, 4), (30005, 300.0, 4)))
        report = self._report(maps)
        self.assertFalse(report["consistent"])
        self.assertEqual(report["reference"], "Band - Song (Mapper) [Hard].osu")
        self.assertEqual(len(report["red_lines"]), 1)
        diff = report["red_lines"][0]
        self.assertEqual((diff["difficulty"], diff["kind"]), ("Easy", "offset"))
        self.assertEqual((diff["offset_ms"], diff["expected"], diff["found"]), (30000.0, 30000.0, 30005.0))
        checks = {d["difficulty"]: d["checks"]["red_lines"] for d in report["difficulties"]}
        self.assertEqual(checks, {"Easy": 1, "Hard": 0, "Insane": 0})

    def test_beat_length_meter_missing_and_extra_lines(self) -> None:
        base = ((1000, 400.0, 4), (30000, 300.0, 4))
        maps = {
            "A": _mapset_osu("A", reds=base),
            "B": _mapset_osu("B", reds=base),
            # 5e-7 ms off: the same number written twice, not a difference.
            "C": _mapset_osu("C", reds=((1000, 400.0000005, 4), (30000, 300.0, 4))),
            "D": _mapset_osu("D", reds=((1000, 400.01, 3), (30000, 300.0, 4), (60000, 250.0, 4))),
            "E": _mapset_osu("E", reds=((1000, 400.0, 4),)),
        }
        report = self._report(maps)
        self.assertEqual(report["reference"], "Band - Song (Mapper) [A].osu")
        kinds = sorted((d["difficulty"], d["kind"]) for d in report["red_lines"])
        self.assertEqual(kinds, [("D", "beat_length"), ("D", "extra"), ("D", "meter"), ("E", "missing")])
        beat = next(d for d in report["red_lines"] if d["kind"] == "beat_length")
        self.assertEqual((beat["expected"], beat["found"]), (400.0, 400.01))
        meter = next(d for d in report["red_lines"] if d["kind"] == "meter")
        self.assertEqual((meter["expected"], meter["found"]), (4, 3))
        self.assertEqual(next(d for d in report["red_lines"] if d["kind"] == "missing")["offset_ms"], 30000.0)
        self.assertEqual(next(d for d in report["red_lines"] if d["kind"] == "extra")["offset_ms"], 60000.0)

    def test_different_audio_filename_is_reported(self) -> None:
        maps = {name: _mapset_osu(name) for name in ("Easy", "Hard")}
        maps["Insane"] = _mapset_osu("Insane", audio="song (1).mp3")
        report = self._report(maps)
        self.assertFalse(report["consistent"])
        audio = next(f for f in report["fields"] if f["field"] == "AudioFilename")
        self.assertFalse(audio["identical"])
        self.assertEqual(audio["value"], "song.mp3")
        self.assertEqual(audio["differences"], [{"file": "Band - Song (Mapper) [Insane].osu",
                                                 "difficulty": "Insane", "value": "song (1).mp3"}])
        checks = {d["difficulty"]: d["checks"]["audio"] for d in report["difficulties"]}
        self.assertEqual(checks, {"Easy": [], "Hard": [], "Insane": ["AudioFilename"]})
        self.assertEqual(report["red_lines"], [])

    def test_defaults_and_tag_order_are_not_differences(self) -> None:
        maps = {
            "Easy": _mapset_osu("Easy", lead_in=None, preview="12000", tags="drum bass electronic"),
            "Hard": _mapset_osu("Hard", lead_in="0", preview="12000", tags="electronic  drum bass"),
            "Insane": _mapset_osu("Insane", lead_in="0", preview="-1", tags="drum bass electronic"),
        }
        report = self._report(maps)
        fields = {f["field"]: f for f in report["fields"]}
        self.assertTrue(fields["AudioLeadIn"]["identical"])
        self.assertTrue(fields["Tags"]["identical"])
        self.assertFalse(fields["PreviewTime"]["identical"])
        self.assertEqual([d["difficulty"] for d in fields["PreviewTime"]["differences"]], ["Insane"])

    def test_unreadable_osu_is_reported_without_stopping_the_rest(self) -> None:
        maps = {name: _mapset_osu(name) for name in ("Easy", "Hard")}
        maps["Normal"] = _mapset_osu("Normal", audio="other.mp3")
        report = self._report(maps, raw={"Band - Song (Mapper) [Broken].osu": b"\xff\xfe\x00 not utf-8"})
        self.assertEqual(report["unreadable"], 1)
        self.assertFalse(report["consistent"])
        broken = next(d for d in report["difficulties"] if not d["readable"])
        self.assertEqual((broken["difficulty"], broken["file"]), ("Broken", "Band - Song (Mapper) [Broken].osu"))
        self.assertIn("UTF-8", broken["detail"])
        self.assertEqual(sum(1 for d in report["difficulties"] if d["readable"]), 3)
        audio = next(f for f in report["fields"] if f["field"] == "AudioFilename")
        self.assertEqual([d["difficulty"] for d in audio["differences"]], ["Normal"])

    def test_kiai_spans_and_density_are_reported_per_difficulty(self) -> None:
        objects = [n * 250 for n in range(41)]  # 0 .. 10 s, 4 per second
        # Greens switch kiai on and off; a span still open at the last line
        # runs to the end of the map.
        maps = {
            "Easy": _mapset_osu("Easy", kiai=((5000, True), (20000, False), (40000, True)),
                                objects=objects),
            "Hard": _mapset_osu("Hard", kiai=((5000, True), (35000, False))),
        }
        report = self._report(maps)
        easy, hard = report["difficulties"]
        self.assertEqual(easy["kiai"], [{"start_ms": 5000.0, "end_ms": 20000.0},
                                        {"start_ms": 40000.0, "end_ms": None}])
        # A red line's own effects count: kiai off at 30000, before the green.
        self.assertEqual(hard["kiai"], [{"start_ms": 5000.0, "end_ms": 30000.0}])
        self.assertEqual(easy["density"]["objects"], 41)
        self.assertGreater(easy["density"]["peak_per_second"], 0)
        self.assertEqual(hard["density"], {"objects": 0, "mean_per_second": 0.0, "peak_per_second": 0.0})
        # Kiai and density are information, not consistency checks.
        self.assertTrue(report["consistent"])

    def test_folder_without_maps_and_missing_folder(self) -> None:
        report = self._report({})
        self.assertEqual((report["difficulties"], report["reference"]), ([], None))
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                mapset_report(Path(tmp) / "missing")


class ReferenceTimingTests(unittest.TestCase):
    """Proposal P1: any map's red lines graded against the attacks."""

    @staticmethod
    def _grade(reds, times, weights, duration=61.0):
        from overtone import grade_reference_timing
        report = grade_reference_timing({"timing": {"reds": reds}}, times, weights, duration)
        json.dumps(report)
        return report

    def test_a_true_map_is_ok_and_a_late_map_is_one_shift(self):
        times, weights = _eighths()
        report = self._grade([(1000.0, 150.0)], times, weights)
        line = report["lines"][0]
        self.assertEqual((line["verdict"], line["issues"], line["divisor"]), ("ok", [], 2))
        self.assertEqual((line["offset_ms"], line["bpm"]), (1000.0, 150.0))  # the line itself
        self.assertLess(abs(line["drift_ms"]), 1.0)
        self.assertGreater(line["share"], 0.95)
        self.assertEqual(report["findings"], [])
        late = self._grade([(1010.0, 150.0)], times, weights)
        # The attacks sit 10 ms before the line: a negative offset, said once
        # for the map; the line agrees with the map's own shift.
        self.assertEqual(late["lines"][0]["verdict"], "ok")
        self.assertAlmostEqual(late["lines"][0]["offset_error_ms"], -10.0, delta=0.5)
        self.assertEqual([f["key"] for f in late["findings"]], ["ref_shift"])
        self.assertAlmostEqual(late["common_offset_ms"], -10.0, delta=0.5)

    def test_a_bpm_slightly_off_drifts_and_the_fit_says_by_how_much(self):
        times, weights = _eighths()
        for bpm in (150.1, 151.0, 155.0):
            with self.subTest(bpm=bpm):
                line = self._grade([(1000.0, bpm)], times, weights)["lines"][0]
                self.assertIn("drift", line["issues"])
                self.assertAlmostEqual(line["fitted_bpm"], 150.0, delta=0.01)
                # The map's 8th is short by (1 - 150/bpm) of the true one, over
                # every 8th of the span up to its last attack.
                atoms = (times[-1] - 1.0) / (30.0 / bpm)
                expected = atoms * (0.2 - 30.0 / bpm) * 1000.0
                self.assertAlmostEqual(line["drift_ms"], expected, delta=0.02 * expected)

    def test_a_shuffle_reads_at_a_third_and_an_octave_is_not_an_error(self):
        beat = 0.6
        on = np.arange(1.0, 61.0, beat)
        times = np.sort(np.r_[on, on + 2 * beat / 3])
        line = self._grade([(1000.0, 100.0)], times, np.ones(times.size))["lines"][0]
        self.assertEqual((line["verdict"], line["divisor"]), ("ok", 3))
        times, weights = _eighths()
        for bpm in (75.0, 300.0):
            with self.subTest(bpm=bpm):
                line = self._grade([(1000.0, bpm)], times, weights)["lines"][0]
                self.assertEqual(line["verdict"], "ok")
                self.assertAlmostEqual(line["fitted_bpm"], bpm, delta=0.01)

    def test_a_line_that_leaves_the_maps_shift_is_flagged(self):
        times, weights = _eighths()
        # The last line placed 12 ms late; the other two are the majority.
        report = self._grade([(1000.0, 150.0), (21000.0, 150.0), (41012.0, 150.0)],
                             times, weights)
        self.assertEqual([line["verdict"] for line in report["lines"]], ["ok", "ok", "check"])
        last = report["lines"][2]
        self.assertEqual(last["issues"], ["offset"])
        self.assertAlmostEqual(last["offset_error_ms"], -12.0, delta=1.0)
        self.assertAlmostEqual(last["relative_ms"], -12.0, delta=1.0)
        self.assertLess(last["offset_se_ms"], 1.0)
        self.assertEqual(report["counts"], {"ok": 2, "check": 1, "weak": 0, "too_few": 0})
        self.assertEqual(report["findings"], [])

    def test_two_lines_apart_are_a_split_not_a_verdict(self):
        times, weights = _eighths()
        # The median takes one side; which line is right needs an ear.
        report = self._grade([(1000.0, 150.0), (41012.0, 150.0)], times, weights)
        self.assertEqual(sum(line["verdict"] == "check" for line in report["lines"]), 1)
        self.assertEqual([f["key"] for f in report["findings"]], ["ref_split"])

    def test_loose_attacks_widen_the_error_instead_of_raising_a_flag(self):
        # 12 ms of jitter and 40 attacks: a 10 ms drift is inside the noise.
        # A flat 5 ms bar would flag it; two standard errors do not.
        times, weights = _eighths(stop=9.0, jitter_ms=12.0, seed=3)
        line = self._grade([(1000.0, 150.0)], times, weights, duration=9.0)["lines"][0]
        self.assertGreater(abs(line["drift_ms"]), 5.0)
        self.assertGreater(line["drift_se_ms"], 4.0)
        self.assertEqual(line["issues"], [])

    def test_a_shift_every_line_shares_flags_no_line(self):
        times, weights = _eighths()
        report = self._grade([(1025.0, 150.0), (31025.0, 150.0)], times, weights)
        self.assertEqual([line["verdict"] for line in report["lines"]], ["ok", "ok"])
        self.assertEqual([f["key"] for f in report["findings"]], ["ref_shift"])
        self.assertAlmostEqual(float(report["findings"][0]["values"]["ms"]), -25.0, delta=1.0)

    def test_too_few_weak_and_missing_evidence_are_said_not_guessed(self):
        times, weights = _eighths(stop=2.0)
        self.assertEqual(self._grade([(1000.0, 150.0)], times, weights)["lines"][0]["verdict"],
                         "too_few")
        rng = np.random.default_rng(7)
        noise = np.sort(rng.uniform(1.0, 61.0, 200))
        self.assertEqual(self._grade([(1000.0, 150.0)], noise, np.ones(200))["lines"][0]["verdict"],
                         "weak")
        self.assertEqual(self._grade([], *_eighths()), {"ok": False, "reason": "no_red_lines"})
        self.assertEqual(self._grade([(1000.0, 150.0)], np.zeros(0), np.zeros(0)),
                         {"ok": False, "reason": "no_attacks"})

    def test_attacks_before_the_first_line_are_counted(self):
        times, weights = _eighths(start=0.2)
        report = self._grade([(1000.0, 150.0)], times, weights)
        self.assertEqual(report["findings"], [{"level": "info", "key": "ref_before",
                                               "index": -1, "values": {"n": 4}}])

    def test_a_map_loads_as_hand_placed_points_with_its_own_meter(self):
        from overtone import reference_points
        text = ("osu file format v14\r\n\r\n[TimingPoints]\r\n"
                "1000,400,3,1,0,100,1,0\r\n2000,-50,4,1,0,100,0,0\r\n"
                "30000,375,4,1,0,100,1,0\r\n")
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = read_osu_beatmap(_write_osu(tmp, text))
        points = reference_points(beatmap, np.arange(0.5, 60.0, 0.4))
        self.assertEqual([(p.offset_ms, p.bpm, p.meter) for p in points],
                         [(1000.0, 150.0, 3), (30000.0, 160.0, 4)])
        self.assertTrue(all(p.manual and p.meter_known and p.confidence == 1.0 for p in points))
        # Hand-placed: export snapping never moves them onto each other.
        self.assertEqual(snap_timing_points(points), points)
        with self.assertRaises(ValueError):
            reference_points({"timing": {"reds": []}})

    def test_same_audio_compares_bytes_not_names(self):
        from overtone import same_audio
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "mine" / "song.mp3"
            song.parent.mkdir()
            song.write_bytes(b"ID3" + bytes(range(200)))
            folder = Path(tmp) / "set"
            folder.mkdir()
            osu = folder / "map.osu"
            beatmap = {"general": {"AudioFilename": "audio.mp3"}}
            self.assertIsNone(same_audio(osu, beatmap, song))        # map's audio missing
            (folder / "audio.mp3").write_bytes(song.read_bytes())
            self.assertTrue(same_audio(osu, beatmap, song))
            (folder / "audio.mp3").write_bytes(b"ID3" + bytes(reversed(range(200))))
            self.assertFalse(same_audio(osu, beatmap, song))         # same size, other bytes
            self.assertIsNone(same_audio(osu, {"general": {}}, song))

    def test_same_audio_maps_are_found_across_a_songs_folder(self):
        from overtone import find_same_audio_maps
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "song.ogg"
            song.write_bytes(b"OggS" + bytes(range(100)))
            songs = Path(tmp) / "Songs"
            twin, other, bigger = songs / "1 A - B", songs / "2 C - D", songs / "3 E - F"
            for folder in (twin, other, bigger):
                folder.mkdir(parents=True)
            (twin / "audio.ogg").write_bytes(song.read_bytes())
            _write_osu(str(twin), "[General]\nAudioFilename: audio.ogg\n\n[Metadata]\nVersion:Hard\n",
                       name="A - B (x) [Hard].osu")
            _write_osu(str(twin), "[General]\nAudioFilename: other.ogg\n", name="A - B (x) [Alt].osu")
            (other / "audio.ogg").write_bytes(b"OggS" + bytes(reversed(range(100))))
            (bigger / "audio.ogg").write_bytes(b"OggS" + bytes(300))
            report = find_same_audio_maps(song, songs)
        json.dumps(report)
        self.assertEqual((report["scanned"], report["same_size"]), (3, 2))
        self.assertEqual(len(report["matches"]), 1)
        match = report["matches"][0]
        self.assertTrue(match["audio"].endswith("audio.ogg"))
        self.assertEqual([m["difficulty"] for m in match["beatmaps"]], ["Hard"])


if __name__ == "__main__":
    unittest.main()
