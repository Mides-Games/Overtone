"""Engine tests: Editing a timing: manual points, suggestions, validation, exports, structure, assisted timing."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from overtone import (HOP, Analysis, TimingPoint, add_timing_point, analysis_summary,
                      delete_timing_point, export_click_track, nudge_timing_point,
                      osu_timing_text, rescale_section, snap_timing_points,
                      suggest_section_pulse, update_timing_point,
                      validate_timing_points, read_osu_beatmap, write_osu_beatmap,
                      suggest_missing_lines, add_red_line, beatmap_text)

from engine_support import (_eighths, _grid_analysis, _reds_map, _section_analysis,
                            _structure_report, _two_points, _validation_analysis,
                            _write_osu, setUpModule, tearDownModule)  # noqa: F401


class ManualEditTests(unittest.TestCase):
    def test_add_keeps_sorted_and_snaps_beat_index(self):
        beats, points = _two_points()
        out = add_timing_point(points, beats, 2500.0, 130.0)
        self.assertEqual([p.offset_ms for p in out], [0.0, 2500.0, 5000.0])
        self.assertEqual(out[1].beat_index, 5)
        self.assertEqual(out[1].confidence, 1.0)
        with self.assertRaises(ValueError):
            add_timing_point(points, beats, 2500.0, 0.0)

    def test_update_preserves_confidence_and_resorts(self):
        beats, points = _two_points()
        out = update_timing_point(points, beats, 1, 1000.0, 150.0)
        self.assertEqual([p.offset_ms for p in out], [0.0, 1000.0])
        self.assertEqual(out[1].confidence, 0.8)
        with self.assertRaises(ValueError):
            update_timing_point(points, beats, 7, 1000.0, 150.0)

    def test_delete_protects_first_point(self):
        _, points = _two_points()
        with self.assertRaises(ValueError):
            delete_timing_point(points, 0)
        out = delete_timing_point(points, 1)
        self.assertEqual(len(out), 1)
        with self.assertRaises(ValueError):
            delete_timing_point(points, 5)

    def test_nudge_clamps_at_zero(self):
        beats, points = _two_points()
        out = nudge_timing_point(points, beats, 0, -50.0)
        self.assertEqual(out[0].offset_ms, 0.0)
        out = nudge_timing_point(points, beats, 1, 4.0)
        self.assertAlmostEqual(out[1].offset_ms, 5004.0)

    def test_nudge_moves_a_line_before_zero_the_way_it_was_asked(self):
        # Every negative offset came out as 0, so -1 ms on -20 moved it +20.
        beats = np.arange(-0.02, 20.0, 0.5)
        points = [TimingPoint(-20.0, 120.0, 0.9, 0), TimingPoint(5000.0, 140.0, 0.9, 10)]
        self.assertEqual(nudge_timing_point(points, beats, 0, -1.0)[0].offset_ms, -21.0)
        self.assertEqual(nudge_timing_point(points, beats, 0, 5.0)[0].offset_ms, -15.0)
        self.assertEqual(nudge_timing_point(points, beats, 0, 30.0)[0].offset_ms, 10.0)
        # From at or after zero, a nudge still stops at zero.
        start = [TimingPoint(3.0, 120.0, 0.9, 0)]
        self.assertEqual(nudge_timing_point(start, beats, 0, -5.0)[0].offset_ms, 0.0)

    def test_nudge_refreshes_the_beat_index(self):
        beats = np.arange(0.0, 20.0, 0.5)
        points = [TimingPoint(1000.0, 120.0, 0.9, 2), TimingPoint(5000.0, 140.0, 0.9, 10)]
        self.assertEqual(nudge_timing_point(points, beats, 1, 1000.0)[1].beat_index, 12)

    def test_rescale_section(self):
        _, points = _two_points()
        out = rescale_section(points, 0, 2.0)
        self.assertAlmostEqual(out[0].bpm, 240.0)
        self.assertEqual(out[0].offset_ms, 0.0)
        out = rescale_section(points, 1, 0.5)
        self.assertAlmostEqual(out[1].bpm, 70.0)
        with self.assertRaises(ValueError):
            rescale_section(points, 0, 3.0)
        with self.assertRaises(ValueError):  # 400 × 2 = 800 exceeds the 600 cap
            rescale_section([TimingPoint(0.0, 400.0, 1.0, 0)], 0, 2.0)

    @staticmethod
    def _tempo_change():
        # 120 BPM for 20 beats from 0 ms, then 125 BPM from 10 s: one tempo
        # change the detector missed, under a single 120 BPM red line.
        first = np.arange(20) * 0.5
        second = 10.0 + np.arange(30) * 0.48
        times = np.concatenate([first, second])
        return times, np.ones_like(times)

    def test_split_puts_a_line_on_the_section_grid_and_refits_both_halves(self):
        from overtone import split_section
        times, weights = self._tempo_change()
        beats = np.arange(0.0, 25.0, 0.5)
        points = [TimingPoint(0.0, 120.0, 0.9, 0)]
        out, report = split_section(points, beats, 0, 10110.0, times, weights, 24500.0)
        self.assertEqual([p.offset_ms for p in out], [0.0, 10000.0])
        self.assertAlmostEqual(out[0].bpm, 120.0, delta=0.05)
        self.assertAlmostEqual(out[1].bpm, 125.0, delta=0.05)
        self.assertTrue(all(p.manual for p in out))
        self.assertEqual((out[1].meter_known, report["split_ms"]), (False, 10000.0))
        self.assertEqual([s["kept"] for s in report["sections"]], [None, None])

    def test_a_split_off_the_section_is_refused(self):
        from overtone import split_section
        times, weights = self._tempo_change()
        points = [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(10000.0, 125.0, 0.9, 20)]
        for at in (100.0, 9900.0, 12000.0):       # on the line, on the next, past it
            with self.subTest(at=at), self.assertRaises(ValueError):
                split_section(points, np.arange(0.0, 25.0, 0.5), 0, at, times, weights, 24500.0)

    def test_merge_drops_the_next_line_and_refits_the_whole_span(self):
        from overtone import merge_sections
        times = np.arange(40) * 0.5                   # a steady 120 BPM
        points = [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(10000.0, 118.0, 0.7, 20)]
        out, report = merge_sections(points, np.arange(0.0, 20.0, 0.5), 0, times,
                                     np.ones_like(times), 20000.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].offset_ms, 0.0)
        self.assertAlmostEqual(out[0].bpm, 120.0, delta=0.05)
        self.assertEqual((report["removed_ms"], report["sections"][0]["kept"]), (10000.0, None))
        with self.assertRaises(ValueError):
            merge_sections(out, np.arange(0.0, 20.0, 0.5), 0, times, np.ones_like(times), 20000.0)

    def test_too_few_or_scattered_attacks_keep_the_bpm_and_say_why(self):
        from overtone import merge_sections
        points = [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(10000.0, 118.0, 0.7, 20)]
        few = np.array([0.5, 1.0, 1.5])
        out, report = merge_sections(points, np.arange(0.0, 20.0, 0.5), 0, few,
                                     np.ones_like(few), 20000.0)
        self.assertEqual((out[0].bpm, report["sections"][0]["kept"]), (120.0, "few"))
        scattered = np.random.default_rng(3).uniform(0.0, 20.0, 60)
        out, report = merge_sections(points, np.arange(0.0, 20.0, 0.5), 0, np.sort(scattered),
                                     np.ones(60), 20000.0)
        self.assertEqual((out[0].bpm, report["sections"][0]["kept"]), (120.0, "weak"))

    def test_a_bar_length_change_keeps_the_beat(self):
        from overtone import set_meter
        points = [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(5000.6, 120.0, 0.9, 10, meter=4)]
        out = set_meter(points, 1, 3)
        # The bar is three beats now and known; the beat and the shown line stay.
        self.assertEqual((out[1].meter, out[1].meter_known, out[1].manual), (3, True, True))
        self.assertEqual((out[1].bpm, out[1].offset_ms), (120.0, 5000.0))
        self.assertEqual(out[0], points[0])
        for bad in (0, 17, 3.5, "3", True):
            with self.subTest(meter=bad), self.assertRaises(ValueError):
                set_meter(points, 1, bad)
        with self.assertRaises(ValueError):
            set_meter(points, 2, 3)

    def test_edits_start_from_the_line_as_it_is_shown(self):
        from overtone import merge_sections, split_section
        # Detected 0.6 ms after a beat of the grid before it: rounding noise,
        # shown and written on that beat. An edit makes the line hand-placed,
        # which snapping skips, so starting from the raw 5000.6 moved it first:
        # -1 ms showed 4999.6 and the .osu still read 5000.
        beats = np.arange(0.0, 30.0, 0.5)
        points = [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(5000.6, 120.0, 0.9, 10),
                  TimingPoint(15000.0, 125.0, 0.9, 30)]
        self.assertEqual(snap_timing_points(points)[1].offset_ms, 5000.0)
        for step in (-1.0, 1.0, 5.0):
            with self.subTest(step=step):
                nudged = snap_timing_points(nudge_timing_point(points, beats, 1, step))
                self.assertAlmostEqual(nudged[1].offset_ms, 5000.0 + step, places=9)
        # Edits that keep the line keep it where it was shown.
        self.assertEqual(rescale_section(points, 1, 2.0)[1].offset_ms, 5000.0)
        none = np.zeros(0)
        split, report = split_section(points, beats, 1, 7100.0, none, none, 30000.0)
        self.assertEqual([p.offset_ms for p in split[:3]], [0.0, 5000.0, 7000.0])
        merged, report = merge_sections(points, beats, 0, none, none, 30000.0)
        self.assertEqual((report["removed_ms"], [p.offset_ms for p in merged]),
                         (5000.0, [0.0, 15000.0]))
        merged, _report = merge_sections(points, beats, 1, none, none, 30000.0)
        self.assertEqual([p.offset_ms for p in merged], [0.0, 5000.0])


class SectionPulseTests(unittest.TestCase):
    def test_slow_section_with_offbeats_is_suggested(self):
        suggestions = suggest_section_pulse(_section_analysis(0.7))
        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0][:2], (0, 2))

    def test_slow_section_without_offbeats_is_not_suggested(self):
        self.assertEqual(suggest_section_pulse(_section_analysis(0.0)), [])

    def test_in_range_section_is_never_suggested(self):
        self.assertEqual(suggest_section_pulse(_section_analysis(0.9, bpm=224.0)), [])

    def test_pulse_hints_only_ever_suggest_doubling(self):
        """Documents a real gap, not desired behaviour — audit finding F-11.

        Every suggestion the helper can emit is ``x2``: it skips any point at
        or above ``low_bpm`` before looking at the audio, so a section reported
        at 175 BPM whose note rate has actually halved to 87.5 gets no hint.
        The benchmark cannot see this either (it normalizes octaves), and
        ``bench/gates.py coverage`` measures the signal that would drive the
        missing halving hint. When v4 adds it, this test should be replaced by
        one asserting the hint appears.
        """
        # A sparse, fast section: attacks on every other beat of the reported
        # grid, which is what a half-time region looks like from here.
        analysis = _section_analysis(0.0, bpm=200.0)
        self.assertEqual(suggest_section_pulse(analysis), [])
        factors = {factor for _idx, factor, _ratio in
                   suggest_section_pulse(_section_analysis(0.7))}
        self.assertEqual(factors, {2}, "the helper has no downward direction")


class HandPlacedPointsStayPutTests(unittest.TestCase):
    """Export snapping used to move any red line within a quarter beat of the
    previous grid — including the ones the mapper typed in."""

    BEATS = np.arange(0.0, 60.0, 0.5)

    def _rows(self, points):
        from types import SimpleNamespace
        text = osu_timing_text(SimpleNamespace(points=points, meter="4/4"))
        return [row.split(",")[0] for row in text.splitlines()[1:]]

    def test_a_hand_added_point_is_exported_where_it_was_typed(self):
        # 10100 ms is 0.2 beat off the 120 BPM grid: it used to leave as 10000.
        points = add_timing_point([TimingPoint(0.0, 120.0, 0.9, 0)], self.BEATS, 10100.0, 140.0)
        self.assertEqual(self._rows(points), ["0", "10100"])

    def test_nudging_one_line_does_not_move_the_next(self):
        points = [TimingPoint(353.0, 225.0, 0.9, 0), TimingPoint(13153.0, 222.0, 0.9, 48)]
        nudged = nudge_timing_point(points, self.BEATS, 0, 10.0)
        self.assertEqual(self._rows(nudged), ["363", "13153"])  # it used to write 13163

    def test_every_edit_marks_its_point(self):
        base = [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(8000.0, 130.0, 0.9, 16)]
        self.assertTrue(update_timing_point(base, self.BEATS, 1, 8010.0, 131.0)[1].manual)
        self.assertTrue(nudge_timing_point(base, self.BEATS, 1, 1.0)[1].manual)
        self.assertTrue(rescale_section(base, 1, 2.0)[1].manual)
        self.assertFalse(base[1].manual)


class ResnapTests(unittest.TestCase):
    @staticmethod
    def _map(objects: str):
        lines = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
                 "[TimingPoints]", "1000,500,4,2,0,70,1,0", "", "[HitObjects]"] + \
                objects.split("\n") + [""]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes("\r\n".join(lines).encode("utf-8"))
            return read_osu_beatmap(path)

    _SHIFT = [{"old": {"offset_ms": 1000.0, "bpm": 120.0, "meter": 4},
               "new": {"offset_ms": 1010.0, "bpm": 120.0, "meter": 4},
               "delta_offset_ms": 10.0, "delta_bpm": 0.0, "drift_end_ms": None}]

    def test_shift_moves_snapped_lists_the_rest(self) -> None:
        from overtone import resnap_objects
        beatmap = self._map("256,192,1000,1,0,0:0:0:0:\n"
                            "256,192,1500,1,0,0:0:0:0:\n"
                            "256,192,2000,2,0,B|320:192,1,100,0:0:0:0:\n"
                            "256,192,2500,12,0,3000,0:0:0:0:\n"
                            "256,192,1300,1,0,0:0:0:0:")
        result = resnap_objects(beatmap, self._SHIFT)
        json.dumps(result)
        self.assertEqual((result["moved"], result["skipped"]), (4, 0))
        self.assertEqual([(o["time_ms"], o["kind"]) for o in result["left"]],
                         [(1300.0, "circle")])
        objects = beatmap["hitobjects"]
        self.assertEqual([o["time"] for o in objects], [1010.0, 1510.0, 2010.0, 2510.0, 1300.0])
        spinner = next(o for o in objects if o["kind"] == "spinner")
        self.assertEqual(spinner["end_time"], 3010)
        self.assertEqual(beatmap["hitobjects"][2]["hit_sound"], 0)

    def test_tempo_change_scales_and_diff_shapes_fit(self) -> None:
        from overtone import inject_diff, resnap_objects
        from types import SimpleNamespace
        beatmap = self._map("256,192,1500,1,0,0:0:0:0:")
        pairs = [{"old": {"offset_ms": 1000.0, "bpm": 120.0, "meter": 4},
                  "new": {"offset_ms": 1000.0, "bpm": 150.0, "meter": 4},
                  "delta_offset_ms": 0.0, "delta_bpm": 30.0, "drift_end_ms": None}]
        result = resnap_objects(beatmap, pairs)
        self.assertEqual((result["moved"], beatmap["hitobjects"][0]["time"]), (1, 1400.0))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes(("osu file format v14\n[General]\nAudioFilename: a.mp3\n"
                              "[TimingPoints]\n1000,500,4,2,0,70,1,0\n"
                              "[HitObjects]\n256,192,1500,1,0,0:0:0:0:\n").encode("utf-8"))
            analysis = SimpleNamespace(source="a.mp3", points=[TimingPoint(1010.0, 120.0, 0.9, 0)])
            diff = inject_diff(path, analysis)
            beatmap = read_osu_beatmap(path)
            moved = resnap_objects(beatmap, diff["pairs"])
            self.assertEqual(moved["moved"], 1)
            self.assertEqual(beatmap["hitobjects"][0]["time"], 1510.0)
            self.assertEqual(read_osu_beatmap(path)["hitobjects"][0]["time"], 1500.0)

    def test_no_pairs_or_no_objects_refuses(self) -> None:
        from overtone import resnap_objects
        beatmap = self._map("256,192,1000,1,0,0:0:0:0:")
        with self.assertRaises(ValueError):
            resnap_objects(beatmap, [])
        with self.assertRaises(ValueError):
            resnap_objects({"sections": []}, self._SHIFT)


class ExportHardeningTests(unittest.TestCase):
    def _analysis(self, points, meter="4/4"):
        from types import SimpleNamespace
        return SimpleNamespace(source="song.mp3", points=points, meter=meter)

    def test_csv_carries_the_snapped_offsets(self):
        # 0.4 ms off the first section's grid: the table, .osu and click
        # track join it to 11000 ms; the CSV wrote the raw 11000.400.
        import csv
        from overtone import export_csv
        analysis = _grid_analysis([(1000.0, 120.0), (11000.4, 140.0)])
        with tempfile.TemporaryDirectory() as tmp:
            export_csv(analysis, Path(tmp) / "timing.csv")
            with open(Path(tmp) / "timing.csv", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
        self.assertEqual([row["offset_ms"] for row in rows], ["1000.000", "11000.000"])
        self.assertIn("\n11000,", osu_timing_text(analysis))

    def test_offsets_are_whole_milliseconds_by_default(self):
        text = osu_timing_text(self._analysis([TimingPoint(353.4137, 225.0, 1.0, 0)]))
        self.assertIn("\n353,", text)
        self.assertNotIn("353.4", text)
        detailed = osu_timing_text(self._analysis([TimingPoint(353.4137, 225.0, 1.0, 0)]), decimals=3)
        self.assertIn("353.414,", detailed)

    def test_meter_is_written_from_the_detection(self):
        text = osu_timing_text(self._analysis([TimingPoint(0.0, 120.0, 1.0, 0)], meter="3/4"))
        self.assertTrue(text.splitlines()[1].split(",")[2] == "3")

    def test_impossible_points_are_skipped_not_crashed(self):
        text = osu_timing_text(self._analysis([TimingPoint(0.0, 0.0, 1.0, 0),
                                               TimingPoint(10.0, 120.0, 1.0, 1)]))
        self.assertEqual(len(text.splitlines()), 2)      # comment + one usable row

    def test_snap_keeps_an_exact_offset_it_cannot_improve(self):
        # A change that genuinely does not sit on the old grid must not be
        # dragged onto it — the v3 fit already knows where it is.
        points = [TimingPoint(0.0, 120.0, 1.0, 0), TimingPoint(5250.0, 140.0, 1.0, 10)]
        self.assertEqual(snap_timing_points(points)[1].offset_ms, 5250.0)

    def test_click_track_survives_a_hand_edited_zero_bpm(self):
        from types import SimpleNamespace
        analysis = SimpleNamespace(duration=4.0, points=[TimingPoint(0.0, 120.0, 1.0, 0),
                                                         TimingPoint(2000.0, 0.0, 1.0, 4)])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "c.wav"
            export_click_track(analysis, out)
            self.assertTrue(out.is_file())


class ValidationTests(unittest.TestCase):
    def keys(self, analysis):
        return [(f["level"], f["key"]) for f in validate_timing_points(analysis)]

    def test_clean_map_has_no_findings_and_is_json(self) -> None:
        import json
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        findings = validate_timing_points(analysis)
        self.assertEqual(findings, [])
        json.dumps(findings)

    def test_two_lines_within_a_beat_are_a_duplicate(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(1000.0, 120.0, 0.9, 0), TimingPoint(1200.0, 120.0, 0.9, 1)])
        self.assertIn(("error", "dup_points"), self.keys(analysis))

    def test_section_shorter_than_a_bar_warns(self) -> None:
        # 150 BPM: 3 beats = 1200 ms, under the 4-beat bar.
        analysis = _validation_analysis(
            [TimingPoint(0.0, 150.0, 0.9, 0), TimingPoint(1200.0, 150.0, 0.9, 3)],
            duration=60.0)
        self.assertIn(("warn", "short_section"), self.keys(analysis))

    def test_fourfold_jump_is_impossible_but_twofold_is_a_question(self) -> None:
        impossible = _validation_analysis(
            [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(30000.0, 500.0, 0.9, 60)])
        self.assertIn(("error", "impossible_change"), self.keys(impossible))
        halved = _validation_analysis(
            [TimingPoint(0.0, 140.0, 0.9, 0), TimingPoint(30000.0, 280.0, 0.9, 70)])
        keys = self.keys(halved)
        self.assertIn(("info", "octave_check"), keys)
        self.assertNotIn(("error", "impossible_change"), keys)
        drift = _validation_analysis(
            [TimingPoint(0.0, 140.0, 0.9, 0), TimingPoint(30000.0, 150.0, 0.9, 70)])
        self.assertNotIn(("info", "octave_check"), self.keys(drift))

    def test_bad_numbers_never_raise(self) -> None:
        import json
        analysis = _validation_analysis(
            [TimingPoint(-50.0, 120.0, 0.9, 0),
             TimingPoint(10000.0, float("nan"), 0.5, 20)])
        keys = self.keys(analysis)
        self.assertIn(("error", "negative_offset"), keys)
        self.assertIn(("error", "bad_number"), keys)
        json.dumps(validate_timing_points(analysis))
        self.assertEqual(validate_timing_points(_validation_analysis([])), [])

    def test_first_line_long_after_the_music_warns(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(70393.1, 196.5, 0.74, 150)], duration=90.0)
        late = [f for f in validate_timing_points(analysis) if f["key"] == "late_first"]
        self.assertEqual(len(late), 1)
        self.assertEqual(late[0]["values"], {"line": "70.4", "beat": "0.5"})

    def test_point_past_the_end_of_the_audio_warns(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(65000.0, 150.0, 0.9, 150)],
            duration=60.0)
        self.assertIn(("warn", "past_end"), self.keys(analysis))

    def test_trailing_stub_section_warns(self) -> None:
        # Last red line two beats before the song ends.
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(59200.0, 150.0, 0.9, 145)],
            duration=60.0)
        self.assertIn(("warn", "short_section"), self.keys(analysis))

    def test_summary_carries_findings_for_cli_and_gui_details(self) -> None:
        clean = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        self.assertNotIn("Validation", analysis_summary(clean))
        dup = _validation_analysis(
            [TimingPoint(1000.0, 120.0, 0.9, 0), TimingPoint(1200.0, 120.0, 0.9, 1)])
        summary = analysis_summary(dup)
        self.assertIn("Validation (check by ear):", summary)
        self.assertIn("one is a duplicate", summary)
        halved = _validation_analysis(
            [TimingPoint(0.0, 140.0, 0.9, 0), TimingPoint(30000.0, 280.0, 0.9, 70)])
        self.assertIn("octave mistake?", analysis_summary(halved))


class SuggestTests(unittest.TestCase):
    def test_missing_section_is_proposed(self) -> None:
        import json
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        suggestions = suggest_missing_lines(analysis, _reds_map([(500.0, 150.0)]))
        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0]["index"], 1)
        self.assertAlmostEqual(suggestions[0]["offset_ms"], 30500.0)
        self.assertAlmostEqual(suggestions[0]["nearest_ms"], 30000.0)
        json.dumps(suggestions)

    def test_complete_and_empty_maps(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        self.assertEqual(suggest_missing_lines(
            analysis, _reds_map([(500.0, 150.0), (30500.0, 152.0)])), [])
        partial = suggest_missing_lines(analysis, _reds_map([]))
        self.assertEqual([s["index"] for s in partial], [1])
        self.assertIsNone(partial[0]["nearest_ms"])  # null, not Infinity: the JS bridge
        self.assertEqual(suggest_missing_lines(_validation_analysis([]), _reds_map([])), [])

    def test_tolerance_is_honoured_and_validated(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        # 300 ms off a 394.7 ms beat: inside one beat, outside half a beat.
        beatmap = _reds_map([(500.0, 150.0), (30800.0, 152.0)])
        self.assertEqual(suggest_missing_lines(analysis, beatmap), [])
        self.assertEqual(len(suggest_missing_lines(analysis, beatmap, tolerance_beats=0.5)), 1)
        with self.assertRaises(ValueError):
            suggest_missing_lines(analysis, beatmap, tolerance_beats=0)

    def test_an_octave_of_the_maps_own_tempo_is_marked(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(20500.0, 300.0, 0.8, 50),
             TimingPoint(40500.0, 152.0, 0.8, 100), TimingPoint(50500.0, 37.8, 0.8, 110)])
        found = suggest_missing_lines(analysis, _reds_map([(1000.0, 150.0)]))
        # x2 and /4 of the map's 150 BPM in force are marked; 152 is not.
        self.assertEqual([(s["map_bpm"], s["octave"]) for s in found],
                         [(150.0, 2.0), (150.0, None), (150.0, 0.25)])
        # Before the map's first red line its tempo still reads back.
        early = suggest_missing_lines(
            _validation_analysis([TimingPoint(500.0, 150.0, 0.9, 0),
                                  TimingPoint(20500.0, 75.0, 0.8, 50)]),
            _reds_map([(40000.0, 150.0)]))
        self.assertEqual((early[0]["map_bpm"], early[0]["octave"]), (150.0, 0.5))
        # No red line at all: nothing to be an octave of.
        bare = suggest_missing_lines(analysis, _reds_map([]))
        self.assertTrue(all(s["map_bpm"] is None and s["octave"] is None for s in bare))

    def test_the_meter_rides_along_when_proven(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0),
             TimingPoint(20500.0, 152.0, 0.8, 50, meter=3, meter_known=True),
             TimingPoint(40500.0, 150.0, 0.8, 100, meter=3)])
        found = suggest_missing_lines(analysis, _reds_map([(500.0, 150.0)]))
        self.assertEqual([(s["index"], s["meter"]) for s in found], [(1, 3), (2, None)])


class AddRedLineTests(unittest.TestCase):
    """One suggested red line into a map (Phase 9): that line, a green where
    the map would otherwise play differently, and nothing else."""

    #: CRLF like the editor writes, one bare-LF line, a BOM: every one of
    #: them must come back as it was.
    LINES = ["osu file format v14", "", "[General]", "AudioFilename: song.mp3",
             "SampleSet: Soft", "", "[Difficulty]", "SliderMultiplier:1.4", "",
             "[TimingPoints]", "1000,500,3,2,1,70,1,0", "5000,-125,3,2,1,60,0,1",
             "9000,-100,3,2,3,40,0,0", "20000,400,4,2,1,70,1,0", "", "",
             "[HitObjects]", "256,192,1000,1,0,0:0:0:0:", "256,192,6000,2,0,B|300:192,1,140",
             "256,192,8000,1,0,0:0:0:0:", "256,192,8500,2,0,B|300:192,2,70",
             "256,192,21000,2,0,B|300:192,1,140"]

    def _read(self, tmp: str) -> tuple[Path, dict]:
        path = Path(tmp) / "map.osu"
        text = "\r\n".join(self.LINES[:4]) + "\n" + "\r\n".join(self.LINES[4:]) + "\r\n"
        path.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
        return path, read_osu_beatmap(path)

    def _added(self, before: bytes, after: bytes) -> list[bytes]:
        """The lines ``after`` holds that ``before`` does not, with the rest
        of ``after`` required to be ``before`` byte for byte, in order."""
        old, new = before.splitlines(keepends=True), after.splitlines(keepends=True)
        extra, n = [], 0
        for line in new:
            if n < len(old) and line == old[n]:
                n += 1
            else:
                extra.append(line)
        self.assertEqual(n, len(old), "a line of the map changed or went missing")
        return extra

    def test_one_red_line_the_green_it_needs_and_nothing_else(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path, beatmap = self._read(tmp)
            before = path.read_bytes()
            summary = add_red_line(beatmap, 7000.0, 150.0)
            write_osu_beatmap(path, beatmap, op="suggestion")
            after = path.read_bytes()
        # The state in force at 7000 ms is the green at 5000: soft, index 1,
        # 60 %, kiai on, and 0.8x the slider velocity, which the red resets.
        self.assertEqual(self._added(before, after),
                         [b"7000,400.000000000000,3,2,1,60,1,1\r\n", b"7000,-125,3,2,1,60,0,1\r\n"])
        self.assertTrue(after.startswith(b"\xef\xbb\xbf"))
        self.assertEqual((summary["greens_added"], summary["meter"], summary["offset_ms"]), (1, 3, 7000.0))
        self.assertEqual(summary["map_bpm"], 120.0)  # the red at 1000 ms, in force there
        self.assertEqual([round(o) for o, _b in beatmap["timing"]["reds"]], [1000, 7000, 20000])

    def test_a_green_at_its_own_time_follows_it_and_needs_no_twin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path, beatmap = self._read(tmp)
            before = path.read_bytes()
            summary = add_red_line(beatmap, 9000.0, 150.0)
            write_osu_beatmap(path, beatmap, backup=False)
            after = path.read_bytes()
        self.assertEqual(self._added(before, after), [b"9000,400.000000000000,3,2,3,40,1,0\r\n"])
        self.assertLess(after.index(b"9000,400."), after.index(b"9000,-100,"))
        self.assertEqual(summary["greens_added"], 0)

    def test_before_the_first_red_it_carries_what_the_intro_played(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path, beatmap = self._read(tmp)
            before = path.read_bytes()
            summary = add_red_line(beatmap, 500.0, 150.0)
            write_osu_beatmap(path, beatmap, backup=False)
            added = self._added(before, path.read_bytes())
        self.assertEqual(added, [b"500,400.000000000000,3,2,1,70,1,0\r\n"])
        self.assertEqual(summary["map_bpm"], 120.0)  # the map's first red, read back to the start
        self.assertEqual((summary["objects"], summary["sliders"]), (0, 0))
        self.assertIsNone(summary["max_end_shift_ms"])

    def test_slider_ends_under_the_new_line_are_counted_and_measured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _path, beatmap = self._read(tmp)
            summary = add_red_line(beatmap, 7000.0, 150.0)
        # 8000 and 8500 fall under it; 21000 follows the red at 20000. The
        # slider at 8500 (70 px, 2 slides, 0.8x) takes 625 ms at 500 ms a
        # beat and 500 ms at 400: its end moves 125 ms earlier.
        self.assertEqual((summary["objects"], summary["sliders"], summary["slider_ends_moved"]),
                         (2, 1, 1))
        self.assertEqual(summary["max_end_shift_ms"], -125.0)

    def test_the_meter_given_or_the_maps_own(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _path, beatmap = self._read(tmp)
            self.assertEqual(add_red_line(beatmap, 22000.0, 150.0)["meter"], 4)
            self.assertEqual(add_red_line(beatmap, 30000.0, 150.0, meter=7)["row"].split(",")[2], "7")
            for bad in (0, 17, 2.5, True):
                with self.assertRaises(ValueError):
                    add_red_line(beatmap, 40000.0, 150.0, meter=bad)

    def test_decimals_as_inject_writes_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _path, beatmap = self._read(tmp)
            summary = add_red_line(beatmap, 7000.256, 150.0, decimals=2)
        self.assertTrue(summary["row"].startswith("7000.26,"))
        self.assertEqual(summary["offset_ms"], 7000.26)

    def test_refusals_leave_the_map_as_it_was(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path, beatmap = self._read(tmp)
            text = beatmap_text(beatmap)
            for offset, bpm in ((1000.4, 150.0), (float("nan"), 150.0), (7000.0, 0.0),
                                (7000.0, float("inf")), ("soon", 150.0)):
                with self.assertRaises(ValueError):
                    add_red_line(beatmap, offset, bpm)
            self.assertEqual(beatmap_text(beatmap), text)
            path.write_text("osu file format v14\n\n[General]\nAudioFilename: a.mp3\n",
                            encoding="utf-8")
            with self.assertRaises(ValueError):
                add_red_line(read_osu_beatmap(path), 7000.0, 150.0)


class StructureViewTests(unittest.TestCase):
    """Phase 19, Structure: phrases on the song's proven bars, labels with why."""

    @staticmethod
    def _analysis(points, duration=64.0):
        return Analysis("synthetic.wav", duration, np.arange(128) * 0.5, np.full(128, 120.0),
                        points, HOP, 44100, 1.0, 120.0, 1.0, "4/4",
                        np.zeros(4000, dtype=np.float32))

    def test_downbeats_follow_each_line_and_say_which_are_proven(self):
        from overtone import downbeat_times
        points = [TimingPoint(0.0, 120.0, 0.9, 0, 4, True),        # 2 s bars, proven
                  TimingPoint(8000.0, 90.0, 0.9, 1, 3, False)]     # 3/4 unproven: song's 4/4
        bars = downbeat_times(self._analysis(points, duration=20.0))
        self.assertEqual([round(t, 6) for t, _ in bars[:5]], [0.0, 2.0, 4.0, 6.0, 8.0])
        self.assertEqual([known for _, known in bars[:4]], [True] * 4)
        later = [(round(t, 4), known) for t, known in bars[4:]]
        self.assertEqual(later, [(8.0, False), (10.6667, False), (13.3333, False),
                                 (16.0, False), (18.6667, False)])
        manual = [TimingPoint(0.0, 120.0, 0.9, 0, 4, False, manual=True)]
        self.assertTrue(all(k for _, k in downbeat_times(self._analysis(manual, 10.0))))
        self.assertEqual(downbeat_times(self._analysis([], 10.0)), [])

    def test_edges_snap_to_proven_downbeats_and_say_how_far(self):
        from overtone import structure_view
        points = [TimingPoint(0.0, 120.0, 0.9, 0, 4, True)]        # bar lines every 2 s
        report = _structure_report([16.5, 31.2, 47.4], ["verse", "chorus", "verse", "chorus"],
                                   [0, 1, 0, 1], [-6.0, 0.0, -6.2, -0.1])
        view = structure_view(report, self._analysis(points))
        json.dumps(view)
        starts = [s["start_s"] for s in view["sections"]]
        self.assertEqual(starts, [0.0, 16.0, 32.0, 48.0])
        self.assertEqual([s["moved_ms"] for s in view["sections"]], [None, -500.0, 800.0, 600.0])
        self.assertEqual([s["end_s"] for s in view["sections"]], [16.0, 32.0, 48.0, 64.0])
        self.assertEqual([s["bar"] for s in view["sections"]], [1, 9, 17, 25])
        self.assertEqual([s["group"] for s in view["sections"]], ["A", "B", "A", "B"])
        # No proven bar within reach: the edge stays where the audio put it.
        unproven = [TimingPoint(0.0, 120.0, 0.9, 0, 4, False)]
        loose = structure_view(report, self._analysis(unproven))
        self.assertEqual([s["start_s"] for s in loose["sections"]], [0.0, 16.5, 31.2, 47.4])
        self.assertEqual([s["snapped"] for s in loose["sections"]], [True, False, False, False])
        far = [TimingPoint(0.0, 20.0, 0.9, 0, 4, True)]            # 12 s bars
        self.assertEqual(structure_view(report, self._analysis(far))["sections"][1]["start_s"], 16.5)
        # Before the first red line no bar is counted: no "bar 0".
        late = [TimingPoint(3000.0, 120.0, 0.9, 0, 4, True)]
        self.assertEqual([s["bar"] for s in structure_view(report, self._analysis(late))["sections"]],
                         [None, 8, 15, 23])

    @staticmethod
    def _lane(*spans):
        """An RMS lane at 0.5 s windows over 64 s: ``(from_s, level)`` pairs,
        each level held until the next pair."""
        t = np.arange(128) * 0.5
        lane = np.zeros(128)
        for start, level in spans:
            lane[t >= start] = level
        return lane

    def test_an_edge_takes_the_bar_where_the_level_changes_not_the_nearest(self):
        from overtone import structure_view
        bars = [TimingPoint(0.0, 120.0, 0.9, 0, 4, True)]           # bar lines every 2 s
        # The novelty peak at 30.8 s is nearest the bar at 30 s; the chorus
        # starts at 32 s, where the level rises 20 dB.
        rise = _structure_report([30.8], ["verse", "chorus"], [0, 1], [-20.0, 0.0],
                                 energy=self._lane((0.0, 0.1), (32.0, 1.0)))
        view = structure_view(rise, self._analysis(bars))
        json.dumps(view)
        chorus = view["sections"][1]
        self.assertEqual((chorus["start_s"], chorus["moved_ms"], chorus["bar"]), (32.0, 1200.0, 17))
        self.assertEqual((chorus["snap"], chorus["change_db"]), ("level", 20.0))
        self.assertEqual(view["sections"][0]["end_s"], 32.0)
        self.assertEqual((view["sections"][0]["snap"], view["phrase_margin_db"]), (None, 0.5))
        # A fall takes the bar where the level falls, by the same rule.
        fall = _structure_report([30.8], ["chorus", "verse"], [0, 1], [0.0, -20.0],
                                 energy=self._lane((0.0, 1.0), (32.0, 0.1)))
        verse = structure_view(fall, self._analysis(bars))["sections"][1]
        self.assertEqual((verse["start_s"], verse["snap"], verse["change_db"]), (32.0, "level", -20.0))

    def test_the_sections_levels_say_which_way_the_change_goes(self):
        from overtone import structure_view
        bars = [TimingPoint(0.0, 120.0, 0.9, 0, 4, True)]
        # A stop bar at 30-32 s: the level falls 20 dB at 30 s and rises 20 dB
        # at 32 s. Into a louder section, the phrase starts at the rise...
        stop = self._lane((0.0, 0.5), (30.0, 0.05), (32.0, 0.5))
        louder = _structure_report([30.2], ["verse", "chorus"], [0, 1], [-1.0, 0.0], energy=stop)
        chorus = structure_view(louder, self._analysis(bars))["sections"][1]
        self.assertEqual((chorus["start_s"], chorus["moved_ms"], chorus["snap"]), (32.0, 1800.0, "level"))
        # ...and into a quieter one at the fall, the nearest bar here.
        quieter = _structure_report([30.2], ["chorus", "verse"], [0, 1], [0.0, -1.0], energy=stop)
        verse = structure_view(quieter, self._analysis(bars))["sections"][1]
        self.assertEqual((verse["start_s"], verse["snap"], verse["change_db"]), (30.0, "nearest", -20.0))

    def test_the_nearest_bar_stays_unless_another_proven_one_changes_more(self):
        from overtone import STRUCTURE_PHRASE_MARGIN_DB, structure_view
        bars = [TimingPoint(0.0, 120.0, 0.9, 0, 4, True)]

        def start(step_db, points=bars):
            lane = self._lane((0.0, 1.0), (32.0, 10.0 ** (step_db / 20.0)))
            report = _structure_report([30.8], ["verse", "chorus"], [0, 1], [-1.0, 0.0], energy=lane)
            first = structure_view(report, self._analysis(points))["sections"][1]
            return first["start_s"], first["snap"]

        self.assertEqual(STRUCTURE_PHRASE_MARGIN_DB, 0.5)
        self.assertEqual(start(0.4), (30.0, "nearest"))             # under the margin
        self.assertEqual(start(0.6), (32.0, "level"))
        # A bar the accents did not prove is never taken, however loud.
        unproven = bars + [TimingPoint(32000.0, 120.0, 0.9, 1, 4, False)]
        self.assertEqual(start(20.0, unproven), (30.0, "nearest"))

    def test_every_label_names_the_rule_and_the_numbers_it_read(self):
        from overtone import structure_view
        report = _structure_report([8.0, 24.0, 40.0, 50.0, 60.0],
                                   ["intro", "verse", "chorus", "bridge", "chorus", "outro"],
                                   [0, 1, 2, 3, 2, 4], [-12.0, -6.0, 0.0, -3.0, 0.0, -9.0], 70.0)
        view = structure_view(report, self._analysis([], 70.0))
        why = [s["why"] for s in view["sections"]]
        self.assertEqual([w["rule"] for w in why], ["intro_first", "verse_one_family",
                                                    "chorus_loudest", "bridge_once",
                                                    "chorus_loudest", "outro_last"])
        self.assertEqual((why[0]["length_s"], why[0]["max_s"]), (8.0, 12.0))
        self.assertIsNone(why[2]["over_db"])      # only one repeated family to be louder than
        two = _structure_report([16.0, 32.0, 48.0], ["verse", "chorus", "verse", "chorus"],
                                [0, 1, 0, 1], [-6.0, 0.0, -6.0, 0.0])
        rules = [s["why"] for s in structure_view(two, self._analysis([]))["sections"]]
        self.assertEqual(rules[0], {"rule": "verse_quieter", "repeats": 2, "under_db": 6.0})
        self.assertEqual(rules[1], {"rule": "chorus_loudest", "repeats": 2, "over_db": 6.0})
        one = _structure_report([20.0, 40.0], ["verse"] * 3, [0, 0, 0], [0.0, -1.0, -0.5])
        view = structure_view(one, self._analysis([]))
        self.assertTrue(view["one_family"])
        self.assertEqual(view["sections"][0]["why"], {"rule": "verse_one_family", "repeats": 3})

    def test_preview_starts_at_the_loudest_chorus(self):
        from overtone import structure_view, suggest_preview_time
        report = _structure_report([8.0, 24.0, 40.0, 50.0, 60.0],
                                   ["intro", "verse", "chorus", "bridge", "chorus", "outro"],
                                   [0, 1, 2, 3, 2, 4], [-12.0, -6.0, -1.0, -3.0, 0.0, -9.0], 70.0)
        view = structure_view(report, self._analysis([], 70.0))
        json.dumps(view)
        self.assertEqual(view["preview"],
                         {"time_s": 50.0, "time_ms": 50000, "kind": "chorus",
                          "why": "chorus_loudest"})

    def test_preview_without_a_chorus_takes_the_loudest_part(self):
        from overtone import suggest_preview_time
        sections = [{"kind": "intro", "level_db": 0.0, "start_s": 0.0},
                    {"kind": "verse", "level_db": -3.0, "start_s": 10.0},
                    {"kind": "bridge", "level_db": -1.0, "start_s": 30.0},
                    {"kind": "outro", "level_db": -6.0, "start_s": 50.0}]
        self.assertEqual(suggest_preview_time(sections)["why"], "loudest_part")
        self.assertEqual(suggest_preview_time(sections)["time_s"], 30.0)
        only_intro = [{"kind": "intro", "level_db": 0.0, "start_s": 0.0}]
        self.assertEqual(suggest_preview_time(only_intro)["why"], "loudest_only")
        self.assertIsNone(suggest_preview_time([]))

    def test_the_energy_lane_is_pooled_by_its_peaks(self):
        from overtone import STRUCTURE_LANE_POINTS, structure_view
        energy = np.full(2000, 0.1)
        energy[1234] = 2.0                                          # one short hit
        report = _structure_report([], ["verse"], [0], [0.0], duration=1000.0, energy=energy)
        lane = structure_view(report, self._analysis([], 1000.0))["lane"]
        self.assertLessEqual(len(lane["values"]), STRUCTURE_LANE_POINTS)
        self.assertEqual(max(lane["values"]), 1.0)
        self.assertAlmostEqual(lane["hop"] * len(lane["values"]), 1000.0, delta=lane["hop"])
        self.assertEqual(structure_view(report, self._analysis([], 1000.0))["sections"][0]["why"],
                         {"rule": "verse_single"})

    def test_bookmarks_merge_sorted_and_keep_the_mappers(self):
        from overtone import set_editor_bookmarks
        beatmap = {"sections": [{"name": "Editor",
                                 "lines": ["Bookmarks: 3000,1000", "DistanceSpacing: 1.2"]}],
                   "editor": {}}
        result = set_editor_bookmarks(beatmap, [2000.4, 1000.0, -50.0])
        json.dumps(result)
        self.assertEqual(result, {"added": 1, "total": 3})
        # Commas alone, as osu! writes the line.
        self.assertEqual(beatmap["sections"][0]["lines"],
                         ["Bookmarks: 1000,2000,3000", "DistanceSpacing: 1.2"])
        self.assertEqual(beatmap["editor"]["Bookmarks"], "1000,2000,3000")

    def test_bookmarks_append_when_missing_and_refuse_junk(self):
        from overtone import set_editor_bookmarks
        bare = {"sections": [{"name": "Editor", "lines": ["DistanceSpacing: 1.2"]}],
                "editor": {}}
        self.assertEqual(set_editor_bookmarks(bare, [500.0])["added"], 1)
        self.assertIn("Bookmarks: 500", bare["sections"][0]["lines"])
        junk = {"sections": [{"name": "Editor", "lines": ["Bookmarks: 1000,soon"]}],
                "editor": {}}
        with self.assertRaises(ValueError):
            set_editor_bookmarks(junk, [2000.0])
        with self.assertRaises(ValueError):
            set_editor_bookmarks({"sections": []}, [2000.0])


class AssistedTimingTests(unittest.TestCase):
    """Proposal P1: two marked downbeats seed the grid, the attacks do the rest."""

    @staticmethod
    def _fit(times, weights, first, second, bars=1, meter=4):
        from overtone import assisted_grid
        fit = assisted_grid(times, weights, first, second, bars, meter)
        json.dumps(fit)
        return fit

    def test_two_sloppy_marks_give_the_whole_grid(self):
        times, weights = _eighths()          # 150 BPM from 1.0 s to 61 s
        for first, second, bars in ((9020.0, 10575.0, 1), (9010.0, 15380.0, 4)):
            with self.subTest(bars=bars):
                fit = self._fit(times, weights, first, second, bars)
                self.assertTrue(fit["ok"])
                self.assertAlmostEqual(fit["bpm"], 150.0, delta=0.01)
                self.assertAlmostEqual(fit["offset_ms"], 1000.0, delta=1.0)
                self.assertLess(fit["start_ms"], 1010.0)
                self.assertGreater(fit["end_ms"], 60500.0)
                self.assertFalse(fit["short"])
                # The marks moved onto the downbeats they meant.
                self.assertAlmostEqual(fit["first_shift_ms"], 9000.0 - first, delta=1.0)
                self.assertAlmostEqual(fit["second_shift_ms"],
                                       9000.0 + bars * 1600.0 - second, delta=1.0)

    def test_a_fast_bar_survives_sloppy_marks(self):
        # 300 BPM: one bar is 0.8 s, so marks 35 ms apart from true are 4 % of
        # the beat; they snap to the attacks before the beat is taken.
        times = np.arange(0.2, 45.0, 0.2)
        fit = self._fit(times, np.ones(times.size), 20215.0, 20980.0)
        self.assertTrue(fit["ok"])
        self.assertAlmostEqual(fit["bpm"], 300.0, delta=0.01)

    def test_growth_crosses_a_breakdown_but_stops_at_a_tempo_change(self):
        rng = np.random.default_rng(4)
        steady, weights = _eighths(stop=25.0)
        vocals = np.sort(rng.uniform(25.2, 35.0, 30))          # no grid for ten seconds
        after, after_w = _eighths(start=35.0, stop=61.0)
        times = np.r_[steady, vocals, after]
        fit = self._fit(times, np.r_[weights, np.full(30, 0.5), after_w], 9000.0, 10600.0)
        self.assertGreater(fit["end_ms"], 60000.0)
        # 150 -> 156 -> 150 on the same grid: skipped as a gap, the middle
        # section would vanish under the first line (secs-3 did, before).
        change = np.r_[np.arange(1.0, 25.0, 0.2), np.arange(25.0, 37.0, 30.0 / 156.0),
                       np.arange(37.0, 61.0, 0.2)]
        fit = self._fit(change, np.ones(change.size), 5000.0, 6600.0)
        self.assertAlmostEqual(fit["bpm"], 150.0, delta=0.01)
        self.assertAlmostEqual(fit["end_ms"], 25000.0, delta=400.0)

    def test_a_grid_that_held_few_bars_is_called_short(self):
        times, weights = _eighths(start=1.0, stop=13.0)       # 7.5 bars
        fit = self._fit(times, weights, 1000.0, 2600.0)
        self.assertTrue(fit["ok"])
        self.assertTrue(fit["short"])
        self.assertLess(fit["bars_held"], 16)

    def test_refusals_say_why(self):
        times, weights = _eighths()
        cases = {"bad_marks": (10600.0, 9000.0), "bpm_range": (9000.0, 9100.0)}
        for reason, (first, second) in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(self._fit(times, weights, first, second)["reason"], reason)
        sparse = np.array([1.0, 5.0, 9.0])
        self.assertEqual(self._fit(sparse, np.ones(3), 1000.0, 2600.0)["reason"], "too_few")
        self.assertEqual(self._fit(np.zeros(0), np.zeros(0), 1000.0, 2600.0)["reason"],
                         "no_attacks")
        for seed in range(1, 4):
            noise = np.sort(np.random.default_rng(seed).uniform(1.0, 61.0, 300))
            with self.subTest(noise=seed):
                self.assertFalse(self._fit(noise, np.ones(300), 9000.0, 10600.0)["ok"])

    def test_adding_the_line_replaces_only_what_it_covers(self):
        from overtone import apply_assisted_grid
        times, weights = _eighths()
        fit = self._fit(times, weights, 9000.0, 10600.0)
        fit["end_ms"] = 40000.0          # pretend the grid stopped at 40 s
        # 39,600 ms sits a beat before that end: most likely the change that
        # ended it (the end is known to a few beats), so it stays.
        points = [TimingPoint(500.0, 120.0, 0.9, 0), TimingPoint(20000.0, 151.0, 0.9, 0),
                  TimingPoint(39600.0, 160.0, 0.9, 0), TimingPoint(45000.0, 170.0, 0.9, 0)]
        merged = apply_assisted_grid(points, fit)
        self.assertEqual([p.offset_ms for p in merged],
                         [500.0, fit["offset_ms"], 39600.0, 45000.0])
        added = merged[1]
        self.assertTrue(added.manual and added.meter_known and added.meter == 4)
        with self.assertRaises(ValueError):
            apply_assisted_grid(points, {"ok": False})


class ClickScheduleTests(unittest.TestCase):
    """The one click schedule the WAV export and the app's live click share."""

    @staticmethod
    def _analysis(points, meter="4/4"):
        return Analysis("x.wav", 10.0, np.zeros(0), np.zeros(0), points, 128, 44100, 1.0,
                        meter=meter)

    def test_a_change_on_the_old_grid_clicks_once(self):
        from overtone import click_schedule
        # 120 BPM from 1 s, 150 BPM from 5 s: 5 s is the old grid's 9th beat.
        clicks = click_schedule(self._analysis([TimingPoint(1000.0, 120.0, 1.0, 0),
                                                TimingPoint(5000.0, 150.0, 1.0, 8)]))
        times = [round(t, 6) for t, _accent in clicks]
        self.assertEqual(times.count(5.0), 1)
        self.assertEqual(times[:9], [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0])
        self.assertAlmostEqual(times[-1], 9.8)             # the last line runs to the end
        self.assertEqual(len(times), len(set(times)))

    def test_accents_follow_each_lines_bar(self):
        from overtone import click_schedule
        clicks = click_schedule(self._analysis(
            [TimingPoint(0.0, 60.0, 1.0, 0, meter=3, meter_known=True)]))
        self.assertEqual([a for _t, a in clicks[:7]], [2, 1, 1] * 2 + [2])
        waltz = click_schedule(self._analysis([TimingPoint(0.0, 60.0, 1.0, 0)], meter="3/4"))
        self.assertEqual([a for _t, a in waltz[:4]], [2, 1, 1, 2])
        flat = click_schedule(self._analysis([TimingPoint(0.0, 60.0, 1.0, 0)]), accent=False)
        self.assertEqual({a for _t, a in flat}, {1})

    def test_subdivisions_fill_each_beat_and_stop_at_the_next_line(self):
        from overtone import click_schedule
        clicks = click_schedule(self._analysis([TimingPoint(1000.0, 120.0, 1.0, 0),
                                                TimingPoint(2000.0, 150.0, 1.0, 2)]),
                                subdivision=4)
        head = [(round(t, 4), a) for t, a in clicks[:9]]
        self.assertEqual(head, [(1.0, 2), (1.125, 0), (1.25, 0), (1.375, 0), (1.5, 1),
                                (1.625, 0), (1.75, 0), (1.875, 0), (2.0, 2)])
        with self.assertRaises(ValueError):
            click_schedule(self._analysis([TimingPoint(0.0, 60.0, 1.0, 0)]), subdivision=5)

    def test_the_exported_wav_holds_one_click_per_scheduled_beat(self):
        import soundfile as sf
        analysis = self._analysis([TimingPoint(1000.0, 120.0, 1.0, 0),
                                   TimingPoint(5000.0, 150.0, 1.0, 8)])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "click.wav"
            export_click_track(analysis, out)
            y, sr = sf.read(str(out))
        # The accent at the change used to be two tones summed: the loudest.
        at = int(5.0 * sr)
        first = int(1.0 * sr)
        self.assertAlmostEqual(np.max(np.abs(y[at:at + 400])),
                               np.max(np.abs(y[first:first + 400])), places=3)


class ModReportTests(unittest.TestCase):
    """Proposal P2: every finding about a difficulty as an editor timestamp."""

    MAP = ("osu file format v14\r\n\r\n[General]\r\nAudioFilename: a.mp3\r\n\r\n"
           "[TimingPoints]\r\n1000,400,4,1,0,100,1,0\r\n21000,400,4,1,0,100,1,0\r\n"
           "41012,400,4,1,0,100,1,0\r\n\r\n"
           "[HitObjects]\r\n"
           "256,192,600,5,0,0:0:0:0:\r\n"        # before the first red line, new combo
           "256,192,1000,1,0,0:0:0:0:\r\n"       # 2
           "256,192,1205,1,0,0:0:0:0:\r\n"       # 3: 5 ms off the 1/2 tick at 1200
           "256,192,1400,5,0,0:0:0:0:\r\n"       # new combo: 1
           "256,192,1500,1,0,0:0:0:0:\r\n")      # 2: on 1/4, between the 8ths

    def _report(self, analysis=None):
        from overtone import mod_report
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = read_osu_beatmap(_write_osu(tmp, self.MAP))
        times, weights = _eighths()
        report = mod_report(beatmap, times, weights, 61.0, analysis)
        json.dumps(report)
        return report

    def test_timestamps_read_as_the_editor_writes_them(self):
        from overtone import mod_timestamp, mod_editor_link
        self.assertEqual(mod_timestamp(83456.4), "01:23:456")
        self.assertEqual(mod_timestamp(3_723_004, [1, 2]), "62:03:004 (1,2)")
        self.assertEqual(mod_timestamp(-40), "00:00:000")
        self.assertEqual(mod_editor_link("01:23:456 (1,2)"), "osu://edit/01:23:456%20(1,2)")
        for bad in ("01:23:456 & calc", "1:2:3", "", "01:23:456 (1;2)"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                mod_editor_link(bad)

    def test_every_source_lands_in_time_order_with_combo_numbers(self):
        report = self._report()
        lines = report["text"].splitlines()
        self.assertEqual(lines[0], "00:00:600 (1) - object before the first red line")
        self.assertIn("00:01:205 (3) - unsnapped: +5.0 ms off the nearest 1/2 tick", lines)
        # The third red line is 12 ms late against the other two: one to check.
        self.assertTrue(any(line.startswith("00:41:012 - red line sits -12.") for line in lines))
        # 1500 is on the map's 1/4 but about 100 ms from the 8ths the music plays.
        self.assertTrue(any(line.startswith("00:01:500 (2) - 9") and
                            line.endswith("ms from the nearest attack Overtone detects")
                            for line in lines))
        self.assertEqual([i["time_ms"] for i in report["items"]],
                         sorted(i["time_ms"] for i in report["items"]))
        self.assertEqual(report["counts"]["snap"], 2)
        self.assertEqual(len(lines), sum(report["counts"].values()))

    def test_map_wide_findings_come_first_under_general(self):
        from overtone import mod_report
        times, weights = _eighths()
        # Two lines 12 ms apart: no majority, said once for the map.
        beatmap = {"timing": {"reds": [(1000.0, 150.0), (41012.0, 150.0)]}, "hitobjects": []}
        report = mod_report(beatmap, times, weights, 61.0)
        self.assertTrue(report["text"].startswith("General - the 2 red lines do not agree"))
        self.assertEqual(report["items"][0]["time_ms"], None)

    def test_missing_red_lines_come_from_the_analysis(self):
        analysis = Analysis("x.wav", 61.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(1000.0, 150.0, 1.0, 0), TimingPoint(50000.0, 160.0, 1.0, 0)],
                            128, 44100, 1.0)
        items = [i for i in self._report(analysis)["items"] if i["source"] == "suggestion"]
        self.assertEqual([(i["stamp"], i["values"]["bpm"]) for i in items],
                         [("00:50:000", "160.000")])
        self.assertEqual(self._report()["counts"]["suggestion"], 0)


class OtherGameExportTests(unittest.TestCase):
    """The same red lines as Quaver's and StepMania's timing."""

    @staticmethod
    def _analysis(points):
        pts = [TimingPoint(offset, bpm, 0.9, i) for i, (offset, bpm) in enumerate(points)]
        return Analysis("x.wav", 300.0, np.zeros(0), np.zeros(0), pts, 128, 44100, 1.0)

    ONE = [(1234.0, 150.0)]
    THREE = [(1234.0, 150.0), (31234.0, 87.5), (61234.0, 175.0)]

    def test_quaver_states_the_time_and_the_rate_as_they_are(self) -> None:
        from overtone import quaver_timing_text
        text = quaver_timing_text(self._analysis(self.THREE))
        self.assertIn("TimingPoints:", text)
        self.assertIn("- StartTime: 1234\n  Bpm: 150\n", text)
        self.assertIn("- StartTime: 31234\n  Bpm: 87.5\n", text)
        # a fractional offset only where it is asked for; whole ms by default
        self.assertIn("StartTime: 1234.500",
                      quaver_timing_text(self._analysis([(1234.5, 150.0)]), decimals=3))

    def test_stepmania_negates_the_offset_and_counts_in_beats(self) -> None:
        from overtone import stepmania_timing_text
        text = stepmania_timing_text(self._analysis(self.THREE))
        # beat 0 sits 1.234 s in, so the tag is its negative, in seconds
        self.assertIn("#OFFSET:-1.234000;", text)
        # 30 s of 150 BPM is 75 beats; 30 s of 87.5 is a further 43.75
        self.assertIn("0.000000=150.000000", text)
        self.assertIn("75.000000=87.500000", text)
        self.assertIn("118.750000=175.000000", text)
        self.assertTrue(text.rstrip().endswith(";"))

    def test_both_read_back_as_the_grid_they_were_written_from(self) -> None:
        from overtone import quaver_timing_text, stepmania_timing_text, verify_export
        analysis = self._analysis(self.THREE)
        for kind, text in (("quaver", quaver_timing_text(analysis)),
                           ("stepmania", stepmania_timing_text(analysis))):
            report = verify_export(analysis, text, kind)
            json.dumps(report)
            self.assertTrue(report["ok"], (kind, report))
            self.assertEqual(report["lines"], 3)
            # whole-millisecond offsets cost at most half of one
            self.assertLessEqual(report["worst_ms"], 0.5, kind)

    def test_the_check_catches_a_flipped_offset_and_a_beat_read_as_a_second(self) -> None:
        from overtone import stepmania_timing_text, verify_export
        analysis = self._analysis(self.THREE)
        good = stepmania_timing_text(analysis)
        flipped = good.replace("#OFFSET:-1.234000", "#OFFSET:1.234000")
        self.assertFalse(verify_export(analysis, flipped, "stepmania")["ok"])
        # the tempo change placed at second 30 instead of beat 75
        seconds = good.replace("75.000000=87.500000", "30.000000=87.500000")
        self.assertFalse(verify_export(analysis, seconds, "stepmania")["ok"])
        # and a line lost outright
        self.assertFalse(verify_export(analysis, good.replace(
            "\n,118.750000=175.000000", ""), "stepmania")["ok"])
        # text the reader refuses is a failed check, not an exception thrown
        broken = verify_export(analysis, good.replace("=87.500000", "=0"), "stepmania")
        self.assertFalse(broken["ok"])
        self.assertIn("BPM", broken["detail"])

    def test_stepmania_keeps_enough_decimals_for_a_long_chart(self) -> None:
        from overtone import stepmania_timing_text, verify_export
        # Three decimals of BPM walked a chart milliseconds off its own beats
        # over an hour of them; six keeps it under a microsecond.
        analysis = self._analysis([(137.0, 174.9993)])
        coarse = verify_export(analysis, stepmania_timing_text(analysis, decimals=3),
                               "stepmania", beats=10000)
        fine = verify_export(analysis, stepmania_timing_text(analysis), "stepmania", beats=10000)
        self.assertGreater(coarse["worst_ms"], fine["worst_ms"])
        self.assertLess(fine["worst_ms"], 0.001)

    def test_nothing_to_export(self) -> None:
        from overtone import quaver_timing_text, stepmania_timing_text, verify_export
        bare = self._analysis([])
        for writer in (quaver_timing_text, stepmania_timing_text):
            with self.assertRaises(ValueError):
                writer(bare)
        with self.assertRaises(ValueError):
            verify_export(self._analysis(self.ONE), "", "sm-or-something")
        self.assertFalse(verify_export(bare, "", "quaver")["ok"])


class ImportTimingTests(unittest.TestCase):
    """Another game's timing, read back as the red lines it states."""

    QUA = """AudioFile: audio.mp3
Mode: Keys4
BPMDoesNotAffectScrollVelocity: true
EditorLayers: []
TimingPoints:
- StartTime: 1234
  Bpm: 150
- StartTime: 31234
  Bpm: 87.5
  Signature: Quadruple
SliderVelocities:
- StartTime: 5000
  Multiplier: 1.5
HitObjects:
- StartTime: 1234
  Lane: 1
"""
    SSC = """#VERSION:0.83;
#TITLE:A Song;   // a comment
#OFFSET:-1.234000;
#BPMS:0.000000=150.000000
,75.000000=87.500000;
#NOTEDATA:;
#OFFSET:-9.999;
#BPMS:0.000=999.000;
"""

    def _write(self, tmp, name, text):
        path = Path(tmp) / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_a_quaver_file_gives_its_red_lines(self) -> None:
        from overtone import read_timing_file
        with tempfile.TemporaryDirectory() as tmp:
            read = read_timing_file(self._write(tmp, "a.qua", self.QUA))
        json.dumps(read)
        self.assertEqual(read["timing_format"], "quaver")
        # the scroll changes carry a StartTime of their own and are not timing
        self.assertEqual(read["timing"]["reds"], [[1234.0, 150.0], [31234.0, 87.5]])

    def test_a_stepmania_file_undoes_the_offset_and_the_beat_numbers(self) -> None:
        from overtone import read_timing_file
        with tempfile.TemporaryDirectory() as tmp:
            read = read_timing_file(self._write(tmp, "a.ssc", self.SSC))
        # beat 75 of 150 BPM is 30 s after a first line 1.234 s in
        self.assertEqual(read["timing"]["reds"], [[1234.0, 150.0], [31234.0, 87.5]])
        # the per-chart tags after #NOTEDATA belong to one difficulty, not the song
        self.assertEqual(read["timing_format"], "stepmania")

    def test_what_was_exported_comes_back(self) -> None:
        from overtone import (quaver_timing_text, read_timing_file, stepmania_timing_text)
        points = [TimingPoint(1234.0, 150.0, 0.9, 0), TimingPoint(31234.0, 87.5, 0.9, 75),
                  TimingPoint(61234.0, 175.0, 0.9, 120)]
        analysis = Analysis("x.wav", 300.0, np.zeros(0), np.zeros(0), points, 128, 44100, 1.0)
        with tempfile.TemporaryDirectory() as tmp:
            for name, text in (("out.qua", quaver_timing_text(analysis)),
                               ("out.sm", stepmania_timing_text(analysis))):
                read = read_timing_file(self._write(tmp, name, text))
                for (offset, bpm), point in zip(read["timing"]["reds"], points):
                    self.assertAlmostEqual(offset, point.offset_ms, delta=0.5, msg=name)
                    self.assertAlmostEqual(bpm, point.bpm, places=5, msg=name)

    def test_the_read_shape_is_what_the_grading_already_grades(self) -> None:
        from overtone import grade_reference_timing, read_timing_file
        # attacks on the map's own grid: it should grade as timed
        attacks = np.array([1.234 + k * 0.4 for k in range(200)])
        with tempfile.TemporaryDirectory() as tmp:
            read = read_timing_file(self._write(
                tmp, "a.qua", "TimingPoints:\n- StartTime: 1234\n  Bpm: 150\n"))
            report = grade_reference_timing(read, attacks, np.ones(attacks.size), 90.0)
        self.assertTrue(report["ok"])
        self.assertEqual(report["lines"][0]["verdict"], "ok")

    def test_what_it_refuses(self) -> None:
        from overtone import read_timing_file
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):           # not a format it reads
                read_timing_file(self._write(tmp, "a.osu", "osu file format v14"))
            with self.assertRaises(ValueError):           # not there
                read_timing_file(Path(tmp) / "gone.qua")
            with self.assertRaises(ValueError):           # nothing in it
                read_timing_file(self._write(tmp, "empty.qua", "AudioFile: a.mp3\n"))
            with self.assertRaises(ValueError):
                read_timing_file(self._write(tmp, "empty.sm", "#TITLE:A;\n"))
            # Quaver states each time outright, so a point with no Bpm costs
            # only itself and is skipped rather than guessed at
            partial = read_timing_file(self._write(
                tmp, "partial.qua",
                "TimingPoints:\n- StartTime: 500\n- StartTime: 1000\n  Bpm: 120\n"))
            self.assertEqual(partial["timing"]["reds"], [[1000.0, 120.0]])
            # StepMania accumulates, so a rate that cannot be played takes
            # every beat after it with it: refused, with the reason
            for body in ("#OFFSET:0;\n#BPMS:0=0,4=120;\n",
                         "#OFFSET:0;\n#BPMS:0=120,8=-150;\n",
                         "#OFFSET:0;\n#BPMS:0=120,eight=150;\n"):
                with self.assertRaises(ValueError) as refused:
                    read_timing_file(self._write(tmp, "bad.sm", body))
                self.assertTrue(str(refused.exception))


if __name__ == "__main__":
    unittest.main()
