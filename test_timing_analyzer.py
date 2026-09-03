"""Tests for osu! Timing Analyzer v2.

Fast unit tests run without audio; end-to-end tests synthesize click tracks
so no fixture files are needed.
"""
import tempfile
import unittest
from pathlib import Path

import numpy as np

from timing_analyzer import (
    DEFAULT_LANGUAGE,
    TimingAnalyzerApp,
    TimingPoint,
    _choose_subdivision,
    _fill_missed_beats,
    _global_tempo_guides,
    _robust_local_bpms,
    _segment_tempi,
    add_timing_point,
    analysis_summary,
    analyze_audio,
    delete_timing_point,
    export_click_track,
    inject_osu_timing_points,
    nudge_timing_point,
    osu_timing_text,
    rebuild_with_subdivision,
    rescale_section,
    snap_timing_points,
    suggest_section_pulse,
    update_timing_point,
)


def _click_track(path: Path, bpm: float, duration: float = 12.0,
                 change_at: float | None = None, second_bpm: float = 140.0,
                 sr: int = 44100) -> None:
    import soundfile as sf
    y = np.zeros(int(sr * duration), dtype=np.float32)
    n = int(0.04 * sr)
    t = np.arange(n) / sr
    kick = (np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.006)).astype(np.float32)
    tt = 0.25
    while tt < duration - 0.2:
        idx = int(tt * sr)
        y[idx:idx + n] += kick
        current = bpm if change_at is None or tt < change_at else second_bpm
        tt += 60.0 / current
    sf.write(str(path), y, sr)


class SegmentationTests(unittest.TestCase):
    def test_small_variation_is_ignored(self):
        beats = np.arange(30) * (60 / 225)
        bpms = np.full(30, 225.2)
        bpms[:10] = 225.0
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 1)

    def test_sustained_change_is_emitted(self):
        beats = np.arange(30) * 0.5
        bpms = np.r_[np.full(12, 120.0), np.full(18, 140.0)]
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 2)
        # One outlier-tolerant window ([120, 140×4]) already confirms the new
        # tempo, so the change is reported a beat before the step completes.
        self.assertEqual(points[1].offset_ms, 5500.0)
        self.assertIn("428.571428571429", osu_timing_text(type("A", (), {"points": points})()))

    def test_backtrack_lands_on_midpoint_crossing(self):
        beats = np.arange(40) * 0.5
        bpms = np.r_[np.full(10, 120.0), [130.0], np.full(29, 140.0)]
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 2)
        self.assertEqual(points[1].offset_ms, 5000.0)

    def test_single_spike_does_not_veto_real_change(self):
        beats = np.arange(30) * 0.5
        bpms = np.r_[np.full(12, 120.0), [140.0, 140.0, 200.0], np.full(15, 140.0)]
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 2)
        # The spike sits inside the confirming window; tolerance still
        # confirms at the true boundary instead of slipping 3 beats late.
        self.assertEqual(points[1].offset_ms, 6000.0)

    def test_single_spike_does_not_create_section(self):
        beats = np.arange(30) * 0.5
        bpms = np.full(30, 120.0)
        bpms[15] = 200.0  # lone outlier, no sustained change
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 1)

    def test_double_time_requires_in_between_attacks(self):
        onset = np.zeros(1000)
        onset[np.arange(100, 900, 100)] = 1.0
        onset[np.arange(150, 900, 100)] = 0.9
        self.assertEqual(_choose_subdivision(onset, np.arange(100, 900, 100), True), 2)

    def test_absent_subdivisions_do_not_double(self):
        onset = np.zeros(1000)
        onset[np.arange(100, 900, 100)] = 1.0
        self.assertEqual(_choose_subdivision(onset, np.arange(100, 900, 100), True), 1)

    def test_export_snaps_change_to_previous_grid(self):
        points = [TimingPoint(353, 225, 1, 0), TimingPoint(13160, 222, 1, 48)]
        snapped = snap_timing_points(points)
        self.assertAlmostEqual(snapped[1].offset_ms, 13153.0, places=6)

    def test_out_of_range_base_doubles_with_moderate_evidence(self):
        # Half-time lock scenario: tracker sits on ~112.5 BPM while the song
        # is really ~225 BPM. Off-beat attacks are weaker (0.55) than beats
        # (1.0) — the old stricter gate stayed at half, collapsing 225/222.2
        # sections into one "constant" map.
        onset = np.zeros(2000)
        beats = np.arange(100, 1900, 92)  # ~112.4 BPM at 172.27 frames/sec
        onset[beats] = 1.0
        midpoints = ((beats[:-1] + beats[1:]) / 2).astype(int)
        onset[midpoints] = 0.55
        self.assertEqual(_choose_subdivision(onset, beats, True), 2)

    def test_in_range_base_does_not_double_on_weak_evidence(self):
        onset = np.zeros(2000)
        beats = np.arange(100, 1900, 77)  # ~223 BPM, already in map range
        onset[beats] = 1.0
        midpoints = ((beats[:-1] + beats[1:]) / 2).astype(int)
        onset[midpoints] = 0.15
        self.assertEqual(_choose_subdivision(onset, beats, True), 1)


class RobustnessTests(unittest.TestCase):
    def test_invalid_parameters_rejected_before_io(self):
        with self.assertRaises(ValueError):
            analyze_audio("whatever.wav", min_delta=-1.0)
        with self.assertRaises(ValueError):
            analyze_audio("whatever.wav", persistence=1)
        with self.assertRaises(ValueError):
            analyze_audio("whatever.wav", min_confidence=1.5)

    def test_undecodable_file_raises_runtime_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):
                analyze_audio(str(Path(tmp) / "missing.wav"))

    def test_single_bad_interval_does_not_drag_local_bpm(self):
        beats = np.arange(20) * 0.5
        beats[10:] += 0.25  # one doubled gap (missed beat)
        local = _robust_local_bpms(beats)
        self.assertAlmostEqual(float(np.median(local)), 120.0, delta=6.0)

    def test_gap_fill_interpolates_isolated_miss(self):
        frames = np.array([0.0, 40.0, 80.0, 160.0, 200.0, 240.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), 7)
        self.assertAlmostEqual(float(filled[3]), 120.0, delta=1.0)

    def test_gap_fill_leaves_long_silence_alone(self):
        # A whole sparse neighbourhood: the local median grows with the gap.
        frames = np.array([0.0, 40.0, 2000.0, 4000.0, 6000.0, 8000.0, 8040.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), len(frames))

    def test_gap_fill_rejects_non_integer_hole(self):
        # One 25× hole: not representable within max_fill → left alone.
        frames = np.array([0.0, 40.0, 80.0, 120.0, 160.0, 200.0, 1200.0, 1240.0, 1280.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), len(frames))

    def test_gap_fill_ignores_tempo_jump(self):
        # Abrupt 120 → 240 BPM: shorter intervals must never trigger fills.
        frames = np.array([0.0, 500.0, 1000.0, 1250.0, 1500.0, 1750.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), len(frames))

    def test_english_is_default_language(self):
        self.assertEqual(DEFAULT_LANGUAGE, "English")
        self.assertEqual(list(TimingAnalyzerApp.TEXT.keys())[0], "English")
        for table in TimingAnalyzerApp.TEXT.values():
            self.assertIn("analyze", table)
        self.assertIn("English", TimingAnalyzerApp.TEXT)
        self.assertIn("Español", TimingAnalyzerApp.TEXT)

    def test_variable_preset_is_default(self):
        variable = TimingAnalyzerApp.PRESETS["variable"]
        steady = TimingAnalyzerApp.PRESETS["steady"]
        self.assertEqual(TimingAnalyzerApp.CFG_VERSION, 2)
        # Variable preset: sensitive enough for songs that change often.
        self.assertLessEqual(int(variable["persistence"]), 12)
        self.assertLessEqual(float(variable["confidence"]), 75)
        # Steady preset: strictly more conservative on every axis.
        self.assertGreater(float(steady["delta"]), float(variable["delta"]))
        self.assertGreater(int(steady["persistence"]), int(variable["persistence"]))
        self.assertGreater(float(steady["confidence"]), float(variable["confidence"]))


class EndToEndTests(unittest.TestCase):
    def test_steady_click_reports_correct_global_bpm(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            analysis = analyze_audio(path)
        self.assertGreaterEqual(len(analysis.points), 1)
        self.assertAlmostEqual(analysis.global_bpm, 128.0, delta=128.0 * 0.03)
        self.assertAlmostEqual(analysis.points[0].bpm, 128.0, delta=128.0 * 0.03)
        self.assertGreaterEqual(analysis.stability, 0.7)
        self.assertLess(abs(analysis.points[0].offset_ms - 250), 60)
        text = osu_timing_text(analysis)
        self.assertIn("// Generated", text)
        self.assertIn("Source:", analysis_summary(analysis))

    def test_tempo_change_produces_two_sections(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "variable.wav"
            _click_track(path, bpm=120.0, duration=16.0, change_at=8.0, second_bpm=140.0)
            analysis = analyze_audio(path)
        self.assertGreaterEqual(len(analysis.points), 2)
        bpms = sorted(p.bpm for p in analysis.points)
        self.assertAlmostEqual(bpms[0], 120.0, delta=120.0 * 0.04)
        self.assertAlmostEqual(bpms[-1], 140.0, delta=140.0 * 0.04)

    def test_tempo_guides_contain_true_tempo(self):
        import soundfile as sf
        from timing_analyzer import _global_tempo_guides, _onset_envelope
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            y, sr = sf.read(str(path), dtype="float32", always_2d=False)
            onset = _onset_envelope(np.asarray(y, dtype=np.float32), sr, 256)
            guides = _global_tempo_guides(onset, sr, 256)
        self.assertTrue(any(abs(bpm - 128.0) <= max(4.0, 128.0 * 0.03) for bpm, _w in guides),
                        f"guides missing 128 BPM: {guides}")

    def test_no_refine_path_still_reports_tempo(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            analysis = analyze_audio(path, refine_beats=False)
        self.assertGreaterEqual(len(analysis.points), 1)
        self.assertAlmostEqual(analysis.global_bpm, 128.0, delta=128.0 * 0.05)

    def test_click_track_export_is_audible_and_aligned(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            analysis = analyze_audio(path)
            out = Path(tmp) / "click.wav"
            export_click_track(analysis, out)
            data, _sr = sf.read(str(out))
            self.assertGreater(float(np.max(np.abs(data))), 0.1)

    def test_rebuild_with_subdivision_doubles_bpm_without_retracking(self):
        # Synthetic grid: strong attacks every 80 frames (~129 BPM) plus
        # weaker off-beat attacks halfway between — so a ×2 grid is musical.
        from timing_analyzer import Analysis
        sr, hop = 44100, 256
        onset = np.zeros(2000, dtype=np.float32)
        onset[np.arange(50, 1950, 80)] = 1.0
        onset[np.arange(90, 1950, 80)] = 0.8
        base = np.arange(50, 1950, 80)
        beats = base.astype(float) * hop / sr
        local = np.full(len(beats), 129.2)
        analysis = Analysis("synthetic", float(beats[-1] + 1), beats, local,
                            [TimingPoint(float(beats[0] * 1000), 129.2, 1.0, 0)],
                            hop, sr, 1, 129.2, 1.0, "4/4", onset, base)
        doubled = rebuild_with_subdivision(analysis, 2)
        self.assertEqual(doubled.subdivision, 2)
        self.assertAlmostEqual(doubled.global_bpm, analysis.global_bpm * 2,
                               delta=analysis.global_bpm * 2 * 0.05)
        with self.assertRaises(ValueError):
            rebuild_with_subdivision(analysis, 3)


def _two_points():
    beats = np.arange(0.0, 20.0, 0.5)
    return beats, [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(5000.0, 140.0, 0.8, 10)]


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


def _section_analysis(mid_amp: float, bpm: float = 112.4):
    from timing_analyzer import Analysis
    sr, hop = 44100, 256
    step = int(round(60.0 / bpm * sr / hop))
    onset = np.zeros(3000, dtype=np.float32)
    grid = np.arange(50, 2900, step)
    onset[grid] = 1.0
    onset[((grid[:-1] + grid[1:]) / 2).astype(int)] = mid_amp
    beats = grid.astype(float) * hop / sr
    local = np.full(len(beats), bpm)
    return Analysis("synthetic", float(beats[-1] + 2), beats, local,
                    [TimingPoint(float(beats[0] * 1000), bpm, 0.9, 0)],
                    hop, sr, 1, bpm, 1.0, "4/4", onset, grid)


class SectionPulseTests(unittest.TestCase):
    def test_slow_section_with_offbeats_is_suggested(self):
        suggestions = suggest_section_pulse(_section_analysis(0.7))
        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0][:2], (0, 2))

    def test_slow_section_without_offbeats_is_not_suggested(self):
        self.assertEqual(suggest_section_pulse(_section_analysis(0.0)), [])

    def test_in_range_section_is_never_suggested(self):
        self.assertEqual(suggest_section_pulse(_section_analysis(0.9, bpm=224.0)), [])


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


if __name__ == "__main__":
    unittest.main()
