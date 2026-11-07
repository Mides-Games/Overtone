"""Engine tests: The fallback trackers, Beat This!, red lines from beats, phrases and the octave."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from overtone import (HOP, Analysis, GridSection, TimingPoint, analyze_audio,
                      osu_timing_text, rebuild_with_subdivision, snap_timing_points,
                      suggest_section_pulse)

from engine_support import (_click_ramp, _click_track, _drum_track, _from_nearest_ms,
                            setUpModule, tearDownModule)  # noqa: F401


class LegacyPulseFactorTests(unittest.TestCase):
    """The fallback tracker must honour ÷2 and ÷4, and read x1 as the precision engine does.

    It took the factor as an absolute subdivision of its tracked beats: 0.5 and
    0.25 fell back to auto without a word -- a 100 BPM kit read at 199.5 stayed
    at 199.5 when the user asked for half -- and 1 switched its octave choice off.
    """

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls._tmp.name) / "kit100.wav"
        _drum_track(cls.path, [(0.5, 100.0)], duration=20.0)
        cls.auto = analyze_audio(cls.path, engine="legacy", osu_conventions=False)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_half_is_applied_from_the_first_beat(self):
        self.assertAlmostEqual(self.auto.global_bpm, 200.0, delta=2.0)   # read at double time
        half = analyze_audio(self.path, engine="legacy", force_subdivision=0.5, osu_conventions=False)
        self.assertAlmostEqual(half.global_bpm, 100.0, delta=1.0)
        self.assertEqual(half.subdivision, 0.5)
        self.assertLess(abs(snap_timing_points(half.points)[0].offset_ms - 500.0), 20.0)

    def test_one_means_as_detected(self):
        same = analyze_audio(self.path, engine="legacy", force_subdivision=1, osu_conventions=False)
        self.assertEqual(same.global_bpm, self.auto.global_bpm)
        self.assertEqual([(p.offset_ms, p.bpm) for p in same.points],
                         [(p.offset_ms, p.bpm) for p in self.auto.points])

    def test_doubling_a_bare_click_doubles_it(self):
        # Nothing sounds between the clicks, so the inserted beats have no
        # attack of their own; they were dragged to the previous click's tail
        # and x2 on a 120 BPM click read 186 BPM.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "click120.wav"
            _click_track(path, 120.0, duration=20.0)
            doubled = analyze_audio(path, engine="legacy", force_subdivision=2, osu_conventions=False)
            rebuilt = rebuild_with_subdivision(analyze_audio(path, engine="legacy", osu_conventions=False), 2.0)
        self.assertAlmostEqual(doubled.global_bpm, 240.0, delta=2.0)
        self.assertAlmostEqual(rebuilt.global_bpm, 240.0, delta=2.0)

    def test_halving_a_legacy_result_needs_no_reanalysis(self):
        half = rebuild_with_subdivision(self.auto, 0.5)
        self.assertAlmostEqual(half.global_bpm, 100.0, delta=1.0)

    def test_global_bpm_is_the_measured_median(self):
        # It was averaged with a tempogram bin, a few tenths of a BPM coarse:
        # odd-222.22 read 222.88 against a median of 222.15, and pressing the
        # same pulse again (a rebuild, which never averaged) moved it.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "click150.wav"
            _click_track(path, 150.0, duration=20.0)
            analysis = analyze_audio(path, engine="legacy", osu_conventions=False)
        self.assertEqual(analysis.subdivision, 1.0)
        self.assertEqual(analysis.global_bpm, float(np.median(analysis.local_bpms)))
        again = rebuild_with_subdivision(analysis, analysis.subdivision)
        self.assertEqual(again.global_bpm, analysis.global_bpm)


class FallbackLagTests(unittest.TestCase):
    """The fallback tracker's beats land on their attacks, not after them.

    The tracker ends each beat on a peak of the onset envelope, and those
    peaks come after the sound starts: forced on Corpus A, its beats landed a
    median 7.4-8.9 ms after their hits (13 and 17 ms under noise), and on
    the four Corpus B songs that reach it the sound starts 21-24 ms before
    its beats. The lag is read on the song's waveform and taken off every
    beat and red line; the tempo the tracker read stays as it was.
    """

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls._tmp.name) / "ramp.wav"
        cls.clicks = _click_ramp(cls.path, 100.0, 140.0, 24.0)
        cls.analysis = analyze_audio(cls.path, osu_conventions=False)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_a_ramp_through_the_fallback_lands_on_its_clicks(self):
        analysis = self.analysis
        self.assertEqual((analysis.engine, analysis.subdivision), ("legacy", 1.0))
        # A bare click's envelope peaks about 6 ms after the click starts.
        self.assertTrue(-0.009 < analysis.beat_shift_s < -0.003, analysis.beat_shift_s)
        errors = _from_nearest_ms(analysis.beats, self.clicks)
        self.assertGreater(errors.size, 0.9 * analysis.beats.size)
        self.assertLess(abs(float(np.median(errors))), 1.0)             # +6.1 ms before
        first = _from_nearest_ms([snap_timing_points(analysis.points)[0].offset_ms / 1000.0],
                                 self.clicks)
        self.assertEqual(first.size, 1)
        self.assertLess(abs(float(first[0])), 2.0)

    def test_only_the_positions_move(self):
        from unittest import mock
        import overtone
        with mock.patch.object(overtone, "_tracker_lag", return_value=0.0):
            unmoved = analyze_audio(self.path, osu_conventions=False)
        moved, shift = self.analysis, self.analysis.beat_shift_s
        self.assertNotEqual(shift, 0.0)
        self.assertEqual(unmoved.beat_shift_s, 0.0)
        np.testing.assert_array_equal(moved.local_bpms, unmoved.local_bpms)
        np.testing.assert_array_equal(moved.base_frames, unmoved.base_frames)
        self.assertEqual((moved.global_bpm, moved.meter, moved.subdivision),
                         (unmoved.global_bpm, unmoved.meter, unmoved.subdivision))
        self.assertEqual([(p.bpm, p.confidence, p.beat_index, p.meter) for p in moved.points],
                         [(p.bpm, p.confidence, p.beat_index, p.meter) for p in unmoved.points])
        np.testing.assert_allclose(moved.beats - unmoved.beats, shift, atol=1e-12)
        np.testing.assert_allclose([p.offset_ms for p in moved.points],
                                   [p.offset_ms + shift * 1000.0 for p in unmoved.points],
                                   atol=1e-9)

    def test_a_rebuild_moves_its_beats_by_the_songs_lag(self):
        # A rebuild has no audio to read the lag on; the song's own is kept.
        analysis = self.analysis
        same = rebuild_with_subdivision(analysis, analysis.subdivision)
        np.testing.assert_array_equal(same.beats, analysis.beats)
        self.assertEqual([(p.offset_ms, p.bpm) for p in same.points],
                         [(p.offset_ms, p.bpm) for p in analysis.points])
        half = rebuild_with_subdivision(analysis, analysis.subdivision / 2)
        self.assertEqual(half.beat_shift_s, analysis.beat_shift_s)
        errors = _from_nearest_ms(half.beats, self.clicks)
        self.assertGreater(errors.size, 0.9 * half.beats.size)
        self.assertLess(abs(float(np.median(errors))), 1.0)

    def test_the_pulse_suggestion_reads_the_envelope_where_the_tracker_put_the_beats(self):
        # Moved 20 ms earlier, a beat's +-2 frame window no longer holds the
        # envelope peak it was tracked on, and the suggestion would vanish.
        from overtone import suggest_section_pulse
        rate = 44100 / HOP
        beats = 0.5 + np.arange(40) * 0.6                   # 100 BPM, off-beats between
        onset = np.zeros(int(26 * rate), dtype=np.float32)
        onset[np.rint(beats * rate).astype(int)] = 1.0
        onset[np.rint((beats + 0.3) * rate).astype(int)] = 0.8

        def analysis(shift: float) -> Analysis:
            return Analysis("x.wav", 25.0, beats + shift, np.full(40, 100.0),
                            [TimingPoint(500.0 + shift * 1000.0, 100.0, 1.0, 0)], HOP, 44100,
                            1.0, 100.0, 1.0, "4/4", onset, beats * rate, beat_shift_s=shift)

        where = suggest_section_pulse(analysis(0.0))
        self.assertEqual([(index, factor) for index, factor, _ratio in where], [(0, 2)])
        self.assertEqual(suggest_section_pulse(analysis(-0.020)), where)

    def test_no_lag_is_read_without_attacks_under_the_beats(self):
        from overtone import _tracker_lag
        sr = 44100
        y = np.zeros(sr * 12, dtype=np.float32)
        n = int(0.03 * sr)
        t = np.arange(n) / sr
        click = (np.sin(2 * np.pi * 1800 * t) * np.exp(-t / 0.004)).astype(np.float32)
        hits = 0.5 + np.arange(20) * 0.5
        for hit in hits:
            i = int(round(hit * sr))
            y[i:i + n] += click
        self.assertAlmostEqual(_tracker_lag(y, sr, hits + 0.007), -0.007, delta=0.0005)
        # In silence, too few on an attack, or under half of them: nothing to read.
        self.assertEqual(_tracker_lag(y, sr, hits + 0.25), 0.0)
        self.assertEqual(_tracker_lag(y, sr, hits[:6] + 0.007), 0.0)
        self.assertEqual(_tracker_lag(y, sr, np.r_[hits[:9] + 0.007, hits[9:] + 0.25]), 0.0)
        self.assertEqual(_tracker_lag(np.zeros(0, dtype=np.float32), sr, hits), 0.0)


class MapLeadTests(unittest.TestCase):
    """with_map_lead: osu!'s red-line convention, applied only at export."""

    def test_detected_lines_move_and_hand_placed_ones_stay(self):
        from dataclasses import replace as dc_replace
        from overtone import MAP_LEAD_MS, TimingPoint, with_map_lead, osu_timing_text
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "click.wav"
            _click_track(path, 120.0, duration=12.0)
            analysis = analyze_audio(path)
        base = dc_replace(analysis, points=[TimingPoint(1000.0, 120.0, 0.9, 0),
                                            TimingPoint(9000.0, 150.0, 0.9, 1, manual=True)])
        moved = with_map_lead(base)
        self.assertEqual([p.offset_ms for p in moved.points], [1000.0 - MAP_LEAD_MS, 9000.0])
        self.assertEqual([p.bpm for p in moved.points], [120.0, 150.0])
        self.assertEqual([p.offset_ms for p in base.points], [1000.0, 9000.0])   # untouched
        self.assertIs(with_map_lead(base, 0.0), base)
        rows = osu_timing_text(moved).splitlines()
        self.assertTrue(rows[1].startswith(f"{int(round(1000 - MAP_LEAD_MS))},"))


class BeatThisTests(unittest.TestCase):
    """Beat This! as an extra voter: the model, its beats and the vote."""

    @classmethod
    def setUpClass(cls):
        import overtone
        cls.ta = overtone
        cls.tmp = tempfile.TemporaryDirectory()
        cls.click = Path(cls.tmp.name) / "click120.wav"
        _click_track(cls.click, 120.0, duration=30.0)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_model_is_the_one_recorded(self):
        # A checkout without Git LFS holds a pointer, not the model.
        import hashlib, json
        folder = self.ta.ROOT / "assets" / "models"
        record = json.loads((folder / "beat_this.json").read_text(encoding="utf-8"))
        data = (folder / record["model"]).read_bytes()
        self.assertEqual(len(data), record["bytes"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), record["sha256"])
        self.assertTrue((folder / "LICENSE-beat-this.txt").read_text(encoding="utf-8")
                        .startswith("MIT License"))

    def test_it_hears_a_click_track_on_its_beats(self):
        import soundfile as sf
        y, sr = sf.read(str(self.click), dtype="float32")
        beats = self.ta._beat_this_beats(y, sr)
        self.assertIsNotNone(beats)
        gaps = np.diff(beats)
        # its beats come on a 50 fps grid: 0.5 s apart within a frame
        self.assertGreater(np.mean(np.abs(gaps - 0.5) <= 0.021), 0.9)

    def test_a_grid_the_engine_already_fits_keeps_its_lines(self):
        voted = analyze_audio(self.click)
        alone = analyze_audio(self.click, beat_vote=False)
        self.assertEqual([(p.offset_ms, p.bpm) for p in voted.points],
                         [(p.offset_ms, p.bpm) for p in alone.points])

    def test_without_the_model_the_vote_is_skipped(self):
        saved = list(self.ta._BEAT_THIS_SESSION)
        self.ta._BEAT_THIS_SESSION[:] = [None]
        try:
            self.assertIsNone(self.ta._beat_this_beats(np.zeros(44100, np.float32), 44100))
            alone = analyze_audio(self.click, beat_vote=False)
            self.assertEqual(self.ta._beat_this_vote(alone, np.zeros(10), 44100), alone)
        finally:
            self.ta._BEAT_THIS_SESSION[:] = saved

    def test_the_fit_score_prefers_the_grid_on_the_attacks(self):
        times = np.arange(0.5, 30.0, 0.5)
        weights = np.ones_like(times)
        on = self.ta._grid_fit_score(times, times, weights, 15.0)
        off = self.ta._grid_fit_score(times + 0.05, times, weights, 15.0)
        self.assertAlmostEqual(on, 1.0)
        self.assertLess(off, 0.1)


class LocalTempoTests(unittest.TestCase):
    """The local-tempo tracker that replaces the v2 tracker's red lines."""

    def test_a_song_that_doubles_gets_both_tempi(self):
        # Beats at 130 BPM, then a double-time part at 260: two red lines.
        from overtone import _beats_to_lines
        beats = np.concatenate([0.5 + np.arange(40) * 60 / 130,
                                0.5 + 40 * 60 / 130 + np.arange(80) * 60 / 260])
        lines = _beats_to_lines(beats, 8.0)
        self.assertEqual([round(b) for _, b in lines], [130, 260])

    def test_the_path_takes_a_double_time_part(self):
        # Window tempi: 130 strongest, then 260 strongest for a while.
        from overtone import _tempo_path
        slow = [(130.0, 0.9), (260.0, 0.5)]
        fast = [(130.0, 0.5), (260.0, 0.9)]
        path = _tempo_path([slow] * 5 + [fast] * 5 + [slow] * 5)
        self.assertEqual([round(b) for b in path], [130] * 5 + [260] * 5 + [130] * 5)

    def test_an_octave_jump_steps_instead_of_ramping(self):
        # Windows at 225 then 112.5: no tempo in between unless LOCAL_STEP_JUMPS is off.
        from overtone import _tempo_curve
        centres = np.array([4.0, 8.0])
        x = np.linspace(4.0, 7.99, 50)
        with mock.patch("overtone.LOCAL_STEP_JUMPS", False):
            ramp = _tempo_curve(x, centres, [225.0, 112.5])
        self.assertTrue(np.any((ramp > 120.0) & (ramp < 220.0)))
        with mock.patch("overtone.LOCAL_STEP_JUMPS", True):
            step = _tempo_curve(x, centres, [225.0, 112.5])
            small = _tempo_curve(x, centres, [225.0, 220.0])
        self.assertTrue(np.all((step == 225.0) | (step == 112.5)))
        self.assertTrue(np.all(step[x < 6.0] == 225.0) and np.all(step[x >= 6.0] == 112.5))
        # A change under LOCAL_STEP_RATIO is still a ramp: a song that speeds up keeps its curve.
        self.assertTrue(np.any((small > 220.5) & (small < 224.5)))

    def test_the_half_of_a_fast_song_is_read_at_its_tempo(self):
        from overtone import _octave_up
        path = [225.0] * 4 + [112.4] * 8 + [226.0] * 2 + [150.0] * 4
        with mock.patch("overtone.LOCAL_OCTAVE_UP", False):
            self.assertEqual(_octave_up(path), path)
        with mock.patch("overtone.LOCAL_OCTAVE_UP", True):
            up = _octave_up(path)
        self.assertTrue(all(abs(b - 225.5) < 1.0 for b in up[:14]))
        # 150 has no tempo at twice it in the song: left as it is.
        self.assertEqual(up[14:], [150.0] * 4)

    def test_octave_up_leaves_a_real_double_time_part_and_a_stray_window(self):
        from overtone import _octave_up
        with mock.patch("overtone.LOCAL_OCTAVE_UP", True):
            # 130 and 260: 260 is past what osu! maps at, so 130 stays (a double-time part).
            self.assertEqual(_octave_up([130.0] * 5 + [260.0] * 5), [130.0] * 5 + [260.0] * 5)
            # One window of 24 at 224 is not enough to lift the song.
            path = [112.0] * 23 + [224.0]
            self.assertEqual(_octave_up(path)[:23], [112.0] * 23)

    @staticmethod
    def _local(bpm: float):
        """A local-tempo analysis at ``bpm``: one red line, beats on it."""
        beats = np.arange(0.5, 60.0, 60.0 / bpm)
        return Analysis("song.mp3", 60.0, beats, np.full(beats.size, bpm),
                        [TimingPoint(500.0, bpm, 0.9, 0)], 512, 44100, 1.0,
                        global_bpm=bpm, engine="legacy", local_tempo=True)

    def test_the_local_octave_fold_does_nothing_switched_off(self):
        from overtone import _fold_local_to_map_octave
        local = self._local(67.5)
        with mock.patch("overtone.LOCAL_OCTAVE_FOLD", False):
            self.assertIs(_fold_local_to_map_octave(local), local)
            fast = self._local(269.88)
            self.assertIs(_fold_local_to_map_octave(fast, 134.855, None, lambda: 135.0), fast)

    def test_a_local_tempo_below_the_map_octave_is_doubled(self):
        from overtone import _fold_local_to_map_octave
        with mock.patch("overtone.LOCAL_OCTAVE_FOLD", True):
            folded = _fold_local_to_map_octave(self._local(67.5))
            # Folding alone never halves: the reference is not consulted.
            fast = _fold_local_to_map_octave(self._local(269.88), reference=134.855)
        self.assertAlmostEqual(folded.global_bpm, 135.0)
        self.assertAlmostEqual(folded.points[0].bpm, 135.0)
        self.assertAlmostEqual(fast.global_bpm, 269.88)

    def test_halving_reads_a_doubled_local_tempo_at_the_reference_on_its_beats(self):
        # Ado - unravel: the tracker read 134.9 (mapped at 135), its local
        # tempo 269.9. The beats kept are the ones on the reference's.
        from overtone import _fold_local_to_map_octave
        local = self._local(269.88)
        reference_beats = local.beats[1::2]          # the tracker's beats: the odd ones
        with mock.patch("overtone.LOCAL_OCTAVE_FOLD", True), \
                mock.patch("overtone.LOCAL_OCTAVE_HALVE", True), \
                mock.patch("overtone.LOCAL_OCTAVE_JUDGE", False):
            folded = _fold_local_to_map_octave(local, 134.855, reference_beats)
            other_phase = _fold_local_to_map_octave(local, 134.855, local.beats[0::2])
            not_double = _fold_local_to_map_octave(self._local(250.0), 150.0)
            out_of_range = _fold_local_to_map_octave(self._local(250.0), 300.0)
        self.assertAlmostEqual(folded.global_bpm, 134.94)
        np.testing.assert_allclose(folded.beats, local.beats[1::2])
        self.assertAlmostEqual(folded.points[0].offset_ms, local.beats[1] * 1000.0)
        np.testing.assert_allclose(other_phase.beats, local.beats[0::2])
        self.assertAlmostEqual(not_double.global_bpm, 250.0)
        self.assertAlmostEqual(out_of_range.global_bpm, 250.0)

    def test_the_judge_lets_a_halving_through_only_when_beat_this_hears_the_slower_pulse(self):
        from overtone import _fold_local_to_map_octave
        local = self._local(250.0)
        flags = (mock.patch("overtone.LOCAL_OCTAVE_FOLD", True),
                 mock.patch("overtone.LOCAL_OCTAVE_HALVE", True),
                 mock.patch("overtone.LOCAL_OCTAVE_JUDGE", True))
        for flag in flags:
            flag.start()
            self.addCleanup(flag.stop)
        slow = _fold_local_to_map_octave(local, 125.0, None, lambda: 126.0)
        fast = _fold_local_to_map_octave(local, 125.0, None, lambda: 248.0)   # a fast band
        silent = _fold_local_to_map_octave(local, 125.0, None, lambda: None)
        no_judge = _fold_local_to_map_octave(local, 125.0)
        self.assertAlmostEqual(slow.global_bpm, 125.0)
        for kept in (fast, silent, no_judge):
            self.assertAlmostEqual(kept.global_bpm, 250.0)

    def test_lines_a_few_tenths_off_a_whole_bpm_snap_and_merge(self):
        # Attacks on a 174 BPM grid, read as two lines at 174.3 and 173.8.
        from overtone import _snap_whole_lines
        times = 0.5 + np.arange(200) * 60 / 174
        weights = np.ones_like(times)
        lines = [(500.0, 174.3), (500.0 + 100 * 60000 / 174, 173.8)]
        self.assertEqual(_snap_whole_lines(lines, times, weights, 70.0),
                         [(mock.ANY, 174.0)])

    def test_a_fractional_bpm_the_attacks_keep_is_kept(self):
        from overtone import _snap_whole_lines
        times = 0.5 + np.arange(400) * 60 / 128.37
        weights = np.ones_like(times)
        lines = _snap_whole_lines([(500.0, 128.37)], times, weights, 190.0)
        self.assertEqual(lines, [(500.0, 128.37)])

    def test_the_lines_follow_the_beats(self):
        from overtone import _beats_to_lines
        rng = np.random.default_rng(3)
        beats = np.cumsum(np.full(200, 60 / 174)) + rng.normal(0, 0.0005, 200)
        lines = _beats_to_lines(beats, 8.0)
        self.assertEqual(len(lines), 1)
        self.assertAlmostEqual(lines[0][1], 174.0, delta=0.05)


class FallbackRebuildTests(unittest.TestCase):
    """A ×2 / ÷2 rebuild of a fallback result at its own pulse gives it back.

    The analysis and the rebuild finished the tracker's beats in two copies of
    the same steps, and held a beat with no peak under it differently: on the
    tracker's own doubling the analysis let the refinement drag it to its
    window's edge, the rebuild held it. ÷2 then ×2 changed 11 of 32 fallback
    analyses; Calm Down Juliet came back with 10 red lines for 3.
    """

    @classmethod
    def setUpClass(cls):
        import soundfile as sf
        cls._tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls._tmp.name) / "kit90-drop.wav"
        _drum_track(cls.path, [(0.5, 90.0)], duration=16.0)
        # Three silent seconds: the beats the doubled grid puts there have no
        # peak under them.
        y, sr = sf.read(str(cls.path), dtype="float32")
        y[6 * sr:9 * sr] = 0.0
        sf.write(str(cls.path), y, sr)
        cls.analysis = analyze_audio(cls.path, engine="legacy", osu_conventions=False)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def assertSameResult(self, got: Analysis, want: Analysis) -> None:
        np.testing.assert_array_equal(got.beats, want.beats)
        np.testing.assert_array_equal(got.local_bpms, want.local_bpms)
        self.assertEqual(got.points, want.points)
        self.assertEqual(
            (got.subdivision, got.global_bpm, got.stability, got.meter, got.beat_shift_s),
            (want.subdivision, want.global_bpm, want.stability, want.meter, want.beat_shift_s))

    def test_the_trackers_own_doubling_comes_back(self):
        from dataclasses import replace
        analysis = self.analysis
        self.assertEqual((analysis.engine, analysis.subdivision), ("legacy", 2))  # 90 BPM doubled
        self.assertSameResult(rebuild_with_subdivision(analysis, analysis.subdivision), analysis)
        # The silent seconds do leave beats with no peak under them: holding
        # them, as rebuilds did at every pulse above 1, gives another result.
        held = rebuild_with_subdivision(replace(analysis, auto_subdivision=0.0), 2.0)
        self.assertFalse(np.array_equal(held.beats, analysis.beats))

    def test_x2_then_half_and_half_then_x2_come_back(self):
        for away in (4.0, 1.0):
            with self.subTest(away=away):
                there = rebuild_with_subdivision(self.analysis, away)
                self.assertSameResult(rebuild_with_subdivision(there, 2.0), self.analysis)

    def test_x2_after_an_analysis_forced_to_half_is_auto(self):
        # Analysed at ÷2, then ×2: back on the pulse the tracker chose itself,
        # so the result is Auto's. Each analysis reads its lag on its own
        # beats; it is left out here so that the two compare exactly.
        from unittest import mock
        import overtone
        with mock.patch.object(overtone, "_tracker_lag", return_value=0.0):
            auto = analyze_audio(self.path, engine="legacy", osu_conventions=False)
            half = analyze_audio(self.path, engine="legacy", force_subdivision=0.5, osu_conventions=False)
        self.assertEqual(half.subdivision, 1.0)
        self.assertSameResult(rebuild_with_subdivision(half, 2.0), auto)

    def test_with_re_anchoring_off_a_rebuild_leaves_the_beats_as_tracked(self):
        # Re-anchoring off leaves every beat where the tracker's split put it
        # (and reads no lag); a rebuild re-anchored them all regardless, so at
        # its own pulse every beat moved.
        off = analyze_audio(self.path, engine="legacy", refine_beats=False, osu_conventions=False)
        self.assertSameResult(rebuild_with_subdivision(off, off.subdivision), off)
        doubled = analyze_audio(self.path, engine="legacy", refine_beats=False,
                                force_subdivision=2, osu_conventions=False)
        self.assertSameResult(rebuild_with_subdivision(off, doubled.subdivision), doubled)


class DensityHintTests(unittest.TestCase):
    """F-11: half- and double-time inside one reported section."""

    @staticmethod
    def _analysis(attacks, weights=None, start=0.0, end=80.0, period=0.5, phase=0.0):
        section = GridSection(start, end, period, phase, len(attacks), 0.5, 0.95)
        analysis = Analysis("x.wav", end, np.zeros(0), np.zeros(0), [], 128, 44100, 1.0)
        analysis.sections = [section]
        analysis.attack_times = np.asarray(attacks, dtype=float)
        analysis.attack_weights = (np.ones(len(attacks)) if weights is None
                                   else np.asarray(weights, dtype=float))
        return analysis

    @staticmethod
    def _beats(n, step, start=0.0):
        return [start + i * step for i in range(n)]

    def test_a_half_time_tail_is_hinted_where_it_starts(self) -> None:
        from overtone import density_hints
        # 80 s at 120 BPM: eighths throughout, then only quarters from 40 s.
        fast = self._beats(160, 0.25)
        slow = self._beats(80, 0.5, start=40.0)
        hints = density_hints(self._analysis(fast[:160] + slow, end=80.0))
        json.dumps(hints)
        self.assertEqual(len(hints), 1)
        hint = hints[0]
        self.assertEqual((hint["section"], hint["thin_side"], hint["factor"]), (0, "tail", 0.5))
        self.assertAlmostEqual(hint["boundary_s"], 40.0, delta=4.0)
        self.assertGreater(hint["coverage_out"] - hint["coverage_in"], 0.2)
        self.assertGreaterEqual(hint["parity_in"], 0.85)

    def test_a_double_time_head_reports_where_the_thinning_ends(self) -> None:
        from overtone import density_hints
        # the mirror image: the head is the thin one, so the change is its end
        slow = self._beats(80, 0.5)
        fast = self._beats(160, 0.25, start=40.0)
        hint = density_hints(self._analysis(slow + fast, end=80.0))[0]
        self.assertEqual(hint["thin_side"], "head")
        self.assertAlmostEqual(hint["boundary_s"], 40.0, delta=4.0)

    def test_a_sparse_stretch_is_not_a_pulse_change(self) -> None:
        from overtone import density_hints
        # Half the slots of the tail dropped at random: coverage falls as it
        # would for a real change, parity does not. This is the discriminator.
        rng = np.random.default_rng(7)
        fast = self._beats(160, 0.25)
        tail = [t for t in self._beats(160, 0.25, start=40.0) if rng.random() < 0.5]
        hints = density_hints(self._analysis(fast + tail, end=80.0))
        self.assertEqual(hints, [])

    def test_a_section_thin_all_through_says_nothing(self) -> None:
        from overtone import density_hints
        # Quarters against a grid subdivided into eighths: every window is
        # "thin", which means the subdivision is too fine, not that it changes.
        self.assertEqual(density_hints(self._analysis(self._beats(160, 0.5), end=80.0)), [])

    def test_a_section_too_short_to_hold_a_change_is_skipped(self) -> None:
        from overtone import density_hints
        # Five windows of eight beats are needed; at 120 BPM that is 20 s.
        short = self._analysis(self._beats(40, 0.25), end=10.0)
        self.assertEqual(density_hints(short), [])

    def test_nothing_to_read(self) -> None:
        from overtone import density_hints
        bare = Analysis("x.wav", 60.0, np.zeros(0), np.zeros(0), [], 128, 44100, 1.0)
        self.assertEqual(density_hints(bare), [])
        self.assertEqual(density_hints(self._analysis([])), [])
        with self.assertRaises(ValueError):
            density_hints(self._analysis(self._beats(160, 0.25)), window_beats=0)

    def test_the_window_statistic_separates_thinned_from_scattered(self) -> None:
        from overtone import density_window
        every_other = np.array([i * 0.5 for i in range(16)])
        coverage, parity, n = density_window(every_other, np.ones(16), 0.25, 0.0)
        self.assertEqual(n, 16)
        self.assertAlmostEqual(coverage, 16 / 31, places=3)   # half the slots
        self.assertAlmostEqual(parity, 1.0, places=6)         # all on one residue
        scattered = np.array([0.0, 0.25, 0.75, 1.0, 1.5, 1.75, 2.25, 2.5])
        _cov, par, _n = density_window(scattered, np.ones(8), 0.25, 0.0)
        self.assertLess(par, 0.85)
        # Under four inliers there is nothing to say.
        self.assertEqual(density_window(np.array([0.0, 0.25]), np.ones(2), 0.25, 0.0),
                         (0.0, 0.0, 2))
        self.assertEqual(density_window(np.zeros(0), np.zeros(0), 0.25, 0.0), (0.0, 0.0, 0))

    def test_a_quiet_ghost_note_cannot_carry_the_parity(self) -> None:
        from overtone import density_window
        # On-beat hits loud, a faint one between each: weighted, the parity
        # still reads the half-time; counted, it would not.
        times = np.array([i * 0.25 for i in range(16)])
        weights = np.array([1.0 if i % 2 == 0 else 0.02 for i in range(16)])
        _cov, weighted, _n = density_window(times, weights, 0.25, 0.0)
        _cov, flat, _n = density_window(times, np.ones(16), 0.25, 0.0)
        self.assertGreater(weighted, 0.9)
        self.assertAlmostEqual(flat, 0.5, places=2)


class LinesOnDownbeatsTests(unittest.TestCase):
    """LINES_ON_DOWNBEATS: a tempo change moves onto beat 1 of a bar."""

    def _analysis(self, change_ms):
        import overtone
        # 120 BPM, 4/4, accented downbeats from 0 ms; 140 BPM from 8000 ms
        # (beat 1 of bar 5), the attacks carrying the true grid.
        times, weights = [], []
        t, k = 0.0, 0
        while t < 8000.0:
            times.append(t); weights.append(3.0 if k % 4 == 0 else 1.0); t += 500.0; k += 1
        t, k = 8000.0, 0
        while t < 20000.0:
            times.append(t); weights.append(3.0 if k % 4 == 0 else 1.0); t += 60000.0 / 140; k += 1
        # The tracker put the change one beat late, on beat 2 of the new tempo.
        points = [TimingPoint(0.0, 120.0, 1.0, 0), TimingPoint(change_ms, 140.0, 1.0, 16)]
        return overtone.Analysis(source="x", duration=20.0, beats=np.zeros(0), local_bpms=np.zeros(0),
                                 points=points, hop_length=512, sample_rate=44100, subdivision=1.0,
                                 attack_times=np.asarray(times) / 1000.0,
                                 attack_weights=np.asarray(weights), engine="precision")

    def test_a_late_change_moves_back_to_the_bar_line(self):
        import overtone
        late = 8000.0 + 60000.0 / 140
        with mock.patch.object(overtone, "LINES_ON_DOWNBEATS", True):
            out = overtone._lines_on_downbeats(self._analysis(late))
        self.assertAlmostEqual(out.points[1].offset_ms, 8000.0, delta=1.0)
        self.assertAlmostEqual(out.points[1].bpm, 140.0)

    def test_off_leaves_the_lines_alone(self):
        import overtone
        a = self._analysis(8000.0 + 60000.0 / 140)
        self.assertIs(overtone._lines_on_downbeats(a), a)


class ConstantGridTests(unittest.TestCase):
    """CONSTANT_GRID: a song one steady grid explains is read as one red line."""

    def _analysis(self, bpms):
        import overtone
        points = [TimingPoint(n * 4000.0, b, 1.0, 0) for n, b in enumerate(bpms)]
        return overtone.Analysis(source="x", duration=280.0, beats=np.zeros(0), local_bpms=np.zeros(0),
                                 points=points, hop_length=512, sample_rate=44100, subdivision=1.0,
                                 engine="legacy")

    def _beats(self, half_parts):
        # A 212 BPM grid from 1290 ms on Beat This!'s 20 ms frames, every
        # other beat only inside ``half_parts``.
        step = 60000.0 / 212
        out, n = [], 0
        while 1290.0 + n * step < 279000.0:
            t = 1290.0 + n * step
            if not any(a <= t < b for a, b in half_parts) or n % 2 == 0:
                out.append(round(t / 20.0) * 20.0 / 1000.0)
            n += 1
        return np.asarray(out)

    def test_half_time_parts_still_read_as_one_grid(self):
        import overtone
        # Beat This! as it heard the song: every beat only from 20 to 60 s and
        # 200 to 220 s, every other beat elsewhere, so the median gap is 560 ms.
        halves = [(0.0, 20000.0), (60000.0, 200000.0), (220000.0, 280000.0)]
        beats = self._beats(halves)
        bpms = [213.3, 211.73, 213.23, 211.4, 213.95, 210.9, 212.54, 208.16]
        out = overtone._constant_grid(self._analysis(bpms), lambda: beats)
        self.assertEqual(len(out.points), 1)
        self.assertAlmostEqual(out.points[0].bpm, 212.0, delta=0.05)

    def _one_line(self, bpm, played):
        import overtone
        step = 60000.0 / played
        times = np.arange(500.0, 200000.0, step) / 1000.0
        weights = np.where(np.arange(times.size) % 4 == 0, 3.0, 1.0)
        return overtone.Analysis(source="x", duration=200.0, beats=np.zeros(0), local_bpms=np.zeros(0),
                                 points=[TimingPoint(500.0, bpm, 1.0, 0)], hop_length=512,
                                 sample_rate=44100, subdivision=1.0, attack_times=times,
                                 attack_weights=weights, engine="legacy")

    def test_the_one_line_reads_at_the_whole_bpm_its_attacks_play(self):
        import overtone
        out = overtone._snap_constant_line(self._one_line(220.05, 220.0))
        self.assertEqual(out.points[0].bpm, 220.0)
        self.assertAlmostEqual(out.points[0].offset_ms, 500.0, delta=1.0)

    def test_a_line_its_attacks_play_off_the_whole_bpm_stays(self):
        import overtone
        a = self._one_line(220.4, 220.4)
        self.assertIs(overtone._snap_constant_line(a), a)

    def test_a_real_tempo_change_is_left_alone(self):
        import overtone
        a = 60000.0 / 150
        first = [n * a for n in range(300)]
        b = 60000.0 / 180
        second = [first[-1] + n * b for n in range(1, 400)]
        beats = np.asarray(first + second) / 1000.0
        analysis = self._analysis([150.0, 150.4, 180.2, 179.8])
        self.assertIs(overtone._constant_grid(analysis, lambda: beats), analysis)


class PhraseLinesTests(unittest.TestCase):
    """PHRASE_LINES: jitter merges into phrases, changes land on phrase points."""

    def _analysis(self, points, segments, duration=40.0, quiet=None):
        import overtone
        times, weights = [], []
        for start, stop, bpm in segments:
            t, k = start, 0
            while t < stop:
                if quiet is None or not (quiet[0] <= t < quiet[1]):
                    times.append(t); weights.append(3.0 if k % 4 == 0 else 1.0)
                t += 60000.0 / bpm; k += 1
        return overtone.Analysis(source="x", duration=duration, beats=np.zeros(0), local_bpms=np.zeros(0),
                                 points=points, hop_length=512, sample_rate=44100, subdivision=1.0,
                                 attack_times=np.asarray(times) / 1000.0,
                                 attack_weights=np.asarray(weights), engine="legacy")

    def test_jitter_on_a_steady_song_merges_into_one_line(self):
        import overtone
        step = 60000.0 / 220
        bpms = [224.7, 215.3, 220.4, 217.6, 222.8, 219.1, 221.7, 218.5]
        points = [TimingPoint(n * 8 * step, b, 1.0, 0) for n, b in enumerate(bpms)]
        out = overtone._phrase_lines(self._analysis(points, [(0.0, 39900.0, 220.0)]))
        self.assertEqual(len(out.points), 1)
        self.assertAlmostEqual(out.points[0].bpm, 220.0, delta=0.5)

    def test_a_real_change_stays_and_lands_on_the_bar_line(self):
        import overtone
        late = 16000.0 + 60000.0 / 140
        points = [TimingPoint(0.0, 120.0, 1.0, 0), TimingPoint(late, 140.0, 1.0, 0)]
        out = overtone._phrase_lines(self._analysis(points, [(0.0, 16000.0, 120.0), (16000.0, 39900.0, 140.0)]))
        self.assertEqual(len(out.points), 2)
        self.assertAlmostEqual(out.points[1].offset_ms, 16000.0, delta=1.0)

    def test_a_line_a_few_bpm_off_is_read_at_the_song_tempo(self):
        import overtone
        step = 60000.0 / 220
        points = [TimingPoint(0.0, 217.0, 1.0, 0), TimingPoint(64 * step, 222.0, 1.0, 0)]
        out = overtone._phrase_lines(self._analysis(points, [(0.0, 39900.0, 220.0)]))
        self.assertEqual([round(p.bpm, 2) for p in out.points], [220.0])

    def test_a_section_at_half_or_double_is_read_at_the_song_octave(self):
        import overtone
        step = 60000.0 / 180
        for wrong in (90.0, 360.0):
            points = [TimingPoint(0.0, 180.0, 1.0, 0), TimingPoint(48 * step, wrong, 1.0, 0),
                      TimingPoint(96 * step, 180.0, 1.0, 0)]
            out = overtone._phrase_lines(self._analysis(points, [(0.0, 39900.0, 180.0)]))
            self.assertEqual([round(p.bpm, 2) for p in out.points], [180.0], wrong)

    def test_a_section_read_at_double_is_halved_against_the_song(self):
        import overtone
        # 120 BPM with eighths for 20 s, then quarters only, which the tracker read at 240.
        segs = [(0.0, 20000.0, 240.0), (20000.0, 39900.0, 120.0)]
        points = [TimingPoint(0.0, 120.0, 1.0, 0), TimingPoint(20000.0, 240.0, 1.0, 0)]
        out = overtone._phrase_lines(self._analysis(points, segs))
        self.assertEqual([round(p.bpm, 2) for p in out.points], [120.0])

    def test_a_part_at_the_song_tempo_is_not_halved(self):
        import overtone
        # A 217 intro on quarters only, then the song at 226 with its eighths: the
        # intro's missing half beats are its arrangement, not a double read.
        segs = [(0.0, 12000.0, 217.0), (12000.0, 39900.0, 452.0)]
        points = [TimingPoint(0.0, 217.0, 1.0, 0), TimingPoint(12000.0, 226.0, 1.0, 0)]
        out = overtone._phrase_lines(self._analysis(points, segs))
        self.assertGreater(out.points[0].bpm, 200.0)

    def test_a_signature_change_is_left_alone(self):
        import overtone
        points = [TimingPoint(0.0, 120.0, 1.0, 0, meter=4), TimingPoint(16000.0, 121.0, 1.0, 0, meter=3)]
        a =self._analysis(points, [(0.0, 39900.0, 120.0)])
        self.assertIs(overtone._phrase_lines(a), a)

    def test_a_line_a_few_ms_off_moves_onto_its_attacks(self):
        import overtone
        points = [TimingPoint(7.0, 120.0, 1.0, 0), TimingPoint(20007.0, 150.0, 1.0, 0)]
        out = overtone._phrase_lines(self._analysis(points, [(0.0, 20000.0, 120.0), (20000.0, 39900.0, 150.0)]))
        self.assertAlmostEqual(out.points[0].offset_ms % 500.0, 0.0, delta=1.0)
        self.assertAlmostEqual(out.points[1].offset_ms, 20000.0, delta=1.0)

    def test_a_band_that_pushes_the_tempo_gets_a_new_line(self):
        import overtone
        # One 200 BPM line; from 20.1 s the band pushes to 202 and stays there.
        a = self._analysis([TimingPoint(0.0, 200.0, 1.0, 0), TimingPoint(30000.0, 200.0, 1.0, 0)],
                           [(0.0, 20100.0, 200.0), (20100.0, 39900.0, 202.0)])
        out = overtone._phrase_lines(a)
        self.assertGreaterEqual(len(out.points), 2)
        self.assertAlmostEqual(out.points[-1].bpm, 202.0, delta=0.3)

    def test_a_live_band_gets_one_line_a_bar_that_runs_on(self):
        import overtone
        # 4/4 bars whose length wanders as a drummer's does; the tracker gave one line.
        bars = [2400.0, 2412.0, 2392.0, 2420.0, 2404.0, 2388.0, 2416.0, 2400.0] * 2
        times, weights, t = [], [], 0.0
        for length in bars:
            for k in range(4):
                times.append(t + k * length / 4); weights.append(3.0 if k == 0 else 1.0)
            t += length
        a = overtone.Analysis(source="x", duration=t / 1000.0 + 1.0, beats=np.zeros(0), local_bpms=np.zeros(0),
                              points=[TimingPoint(0.0, 100.0, 1.0, 0), TimingPoint(t - 2400.0, 100.0, 1.0, 0)],
                              hop_length=512, sample_rate=44100, subdivision=1.0,
                              attack_times=np.asarray(times) / 1000.0, attack_weights=np.asarray(weights),
                              engine="legacy")
        out = overtone._phrase_lines(a)
        self.assertGreater(len(out.points), 4)
        # every line ends exactly where the next starts: one tick per change
        for p, q in zip(out.points, out.points[1:]):
            beats = (q.offset_ms - p.offset_ms) * p.bpm / 60000.0
            self.assertAlmostEqual(beats, round(beats), delta=0.01)

    def test_short_lines_at_one_tempo_merge(self):
        import overtone
        step = 60000.0 / 200
        bpms = [200.3, 196.9, 202.7, 196.9, 201.5]
        points = [TimingPoint(n * 2 * step, b, 1.0, 0) for n, b in enumerate(bpms)]
        points.append(TimingPoint(10 * step, 200.0, 1.0, 0))
        out = overtone._phrase_lines(self._analysis(points, [(0.0, 39900.0, 200.0)]))
        self.assertEqual([round(p.bpm, 2) for p in out.points], [200.0])

    def test_off_leaves_the_lines_alone(self):
        import overtone
        points = [TimingPoint(0.0, 120.0, 1.0, 0), TimingPoint(16500.0, 140.0, 1.0, 0)]
        a = self._analysis(points, [(0.0, 16000.0, 120.0), (16000.0, 39900.0, 140.0)])
        with mock.patch.object(overtone, "PHRASE_LINES", False):
            self.assertIs(overtone._phrase_lines(a), a)


class BeatThisTrackerTests(unittest.TestCase):
    """BEAT_THIS_TRACKER: the fallback tracker's beats from Beat This!, snapped."""

    def _clicks(self, bpm=120.0, seconds=20.0, sr=44100):
        rng = np.random.default_rng(3)
        y = (rng.standard_normal(int(seconds * sr)) * 0.002).astype(np.float32)
        hit = (rng.standard_normal(2000) * np.exp(-np.arange(2000) / 200.0)).astype(np.float32)
        t = 0.5
        while t < seconds - 0.1:
            i = int(t * sr)
            y[i:i + hit.size] += hit
            t += 60.0 / bpm
        return y, sr

    def test_on_its_beats_replace_the_trackers(self):
        import overtone
        y, sr = self._clicks()
        beats = np.arange(0.5, 19.9, 0.5) + 0.004  # a frame grid's few ms off
        with mock.patch.object(overtone, "BEAT_THIS_TRACKER", True),                 mock.patch.object(overtone, "_track_beats_hybrid", side_effect=AssertionError("tracker ran")):
            a = overtone._legacy_analysis("x.wav", y, sr, 1.5, 12, True, 0.75, lambda _m: None, 0.0, True,
                                          heard=lambda: beats)
        self.assertAlmostEqual(float(a.global_bpm), 120.0, delta=1.0)

    def test_off_or_without_the_network_the_tracker_runs(self):
        import overtone
        self.assertIsNone(overtone._beat_this_frames(None, 22050, 512, 1000))
        self.assertIsNone(overtone._beat_this_frames(lambda: None, 22050, 512, 1000))
        self.assertIsNone(overtone._beat_this_frames(lambda: np.array([1.0, 2.0]), 22050, 512, 1000))
        frames = overtone._beat_this_frames(lambda: np.arange(0.5, 10.0, 0.5), 22050, 512, 1000)
        self.assertEqual(frames.size, 19)


class DbnTrackerTests(unittest.TestCase):
    """DBN_TRACKER (phase 27.6): beats decoded from Beat This!'s activation."""

    @staticmethod
    def _activation(beats, seconds, fps=50, noise=0.15):
        rng = np.random.default_rng(7)
        t = np.arange(int(seconds * fps)) / fps
        a = sum(np.exp(-0.5 * ((t - b) / 0.012) ** 2) for b in beats)
        return np.clip(0.9 * a + rng.uniform(0, noise, t.size), 0, 1)

    def _check(self, beats, seconds):
        import overtone
        found = overtone._dbn_beats(self._activation(beats, seconds), 50.0)
        self.assertLessEqual(abs(found.size - beats.size), 1)
        err = np.array([np.min(np.abs(beats - f)) for f in found])
        self.assertLess(float(np.median(err)), 0.006)
        return found

    def test_follows_a_steady_tempo(self):
        self._check(np.arange(0.3, 60, 0.5), 60)

    def test_reads_below_madmoms_floor_without_doubling(self):
        found = self._check(np.arange(0.5, 60, 60 / 50), 60)
        self.assertAlmostEqual(float(np.median(60 / np.diff(found))), 50.0, delta=1.0)

    def test_follows_a_tempo_change(self):
        beats = np.concatenate([np.arange(0.2, 30, 0.5), 30 + np.arange(0, 30, 60 / 130)])
        found = self._check(beats, 60)
        d = 60 / np.diff(found)
        self.assertAlmostEqual(float(np.median(d[:40])), 120.0, delta=1.5)
        self.assertAlmostEqual(float(np.median(d[-40:])), 130.0, delta=1.5)

    def test_frames_need_an_activation(self):
        import overtone
        self.assertIsNone(overtone._dbn_frames(None, 22050, 512, 1000))
        self.assertIsNone(overtone._dbn_frames(lambda: None, 22050, 512, 1000))
        self.assertIsNone(overtone._beat_this_activation(np.zeros(0, np.float32), 44100, session=object()))

    def test_on_its_beats_replace_the_trackers(self):
        import overtone
        y, sr = BeatThisTrackerTests()._clicks()
        act = self._activation(np.arange(0.5, 19.9, 0.5), 20)
        with mock.patch.object(overtone, "DBN_TRACKER", True), \
                mock.patch.object(overtone, "_track_beats_hybrid", side_effect=AssertionError("tracker ran")):
            a = overtone._legacy_analysis("x.wav", y, sr, 1.5, 12, True, 0.75, lambda _m: None, 0.0, True,
                                          activation=lambda: act)
        self.assertAlmostEqual(float(a.global_bpm), 120.0, delta=1.0)


class OctaveCapTests(unittest.TestCase):
    """OCTAVE_CAP: a red line above 260 BPM is read at half, on its strong beats."""

    def _analysis(self, points, beat_ms, strong_offset=0.0, duration=40.0):
        import overtone
        times, weights, t, k = [], [], 0.0, 0
        while t < duration * 1000.0:
            times.append(t); weights.append(3.0 if (t - strong_offset) % (2 * beat_ms) < 1.0 else 1.0)
            t += beat_ms; k += 1
        return overtone.Analysis(source="x", duration=duration, beats=np.zeros(0), local_bpms=np.zeros(0),
                                 points=points, hop_length=512, sample_rate=44100, subdivision=1.0,
                                 attack_times=np.asarray(times) / 1000.0, attack_weights=np.asarray(weights),
                                 engine="legacy")

    def test_a_line_above_the_cap_is_halved_on_its_strong_beats(self):
        import overtone
        beat = 60000.0 / 280
        out = overtone._cap_octaves(self._analysis([TimingPoint(0.0, 280.0, 1.0, 0)], beat, strong_offset=beat))
        self.assertEqual([round(p.bpm, 2) for p in out.points], [140.0])
        self.assertAlmostEqual(out.points[0].offset_ms, beat, delta=0.01)

    def test_a_run_of_capped_lines_keeps_one_grid(self):
        import overtone
        beat = 60000.0 / 280
        points = [TimingPoint(0.0, 280.0, 1.0, 0), TimingPoint(21 * beat, 280.0, 1.0, 0)]
        out = overtone._cap_octaves(self._analysis(points, beat))
        a, b = out.points
        self.assertAlmostEqual(((b.offset_ms - a.offset_ms) / (2 * beat)) % 1.0, 0.0, delta=0.01)

    def test_lines_under_the_cap_and_the_switch_off_leave_it_alone(self):
        import overtone
        a = self._analysis([TimingPoint(0.0, 250.0, 1.0, 0)], 240.0)
        self.assertIs(overtone._cap_octaves(a), a)
        b = self._analysis([TimingPoint(0.0, 280.0, 1.0, 0)], 60000.0 / 280)
        with mock.patch.object(overtone, "OCTAVE_CAP", False):
            self.assertIs(overtone._cap_octaves(b), b)


class TidyBpmTests(unittest.TestCase):
    """A BPM is written with two decimals, as a ranked mapper writes it (2026-10-31)."""

    def test_two_decimals_and_one_with_the_old_rule(self):
        import overtone
        self.assertEqual(overtone._tidy_bpm(233.433, 400.0), 233.43)
        self.assertEqual(overtone._tidy_bpm(94.0449, 64.0), 94.04)
        with mock.patch.object(overtone, "TIDY_BPM_DECIMALS", 1):
            self.assertEqual(overtone._tidy_bpm(233.433, 4.0), 233.4)


if __name__ == "__main__":
    unittest.main()


class TempoJudgeTests(unittest.TestCase):
    """TEMPO_JUDGE (phase 27.8): the octave by a model of mapped tempi."""

    @staticmethod
    def _clicks(bpm, seconds=40, sr=22050):
        rng = np.random.default_rng(3)
        y = np.zeros(int(seconds * sr))
        for b in np.arange(0, seconds, 60.0 / bpm):
            at = int(b * sr)
            y[at:at + 200] += rng.standard_normal(min(200, y.size - at))
        return y, sr

    def test_moves_a_click_track_to_the_mapped_octave(self):
        from overtone import tempo_judge as tj
        x = tj.mix_features(*self._clicks(120.0))
        self.assertEqual(tj.factor(tj.model(), x, 60.0, 10.0), 2.0)
        self.assertEqual(tj.factor(tj.model(), x, 120.0, 10.0), 1.0)
        self.assertEqual(tj.factor(tj.model(), x, 240.0, 10.0), 0.5)

    def test_no_margin_reached_keeps_the_reading(self):
        from overtone import tempo_judge as tj
        x = tj.mix_features(*self._clicks(120.0))
        self.assertEqual(tj.factor(tj.model(), x, 60.0, 1e12), 1.0)

    def test_off_and_manual_lines_are_left_alone(self):
        import overtone
        analysis = mock.Mock(points=[mock.Mock(manual=True, bpm=60.0)], global_bpm=60.0)
        self.assertIs(overtone._tempo_judge(analysis, lambda: self.fail("read the audio")), analysis)
        with mock.patch.object(overtone, "TEMPO_JUDGE", True):
            self.assertIs(overtone._tempo_judge(analysis, lambda: self.fail("read the audio")), analysis)
