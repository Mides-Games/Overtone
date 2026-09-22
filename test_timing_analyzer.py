"""Tests for Overtone (v3 engine).

Fast unit tests run without audio; end-to-end tests synthesize click and drum
tracks with known ground truth, so no fixture files are needed. The v2
segmentation and gap-filling helpers are still covered — they remain in the
fallback path used for rubato and non-percussive audio.
"""
import tempfile
import unittest
from pathlib import Path

import numpy as np

from timing_analyzer import (
    DEFAULT_LANGUAGE,
    Analysis,
    GridSection,
    TimingAnalyzerApp,
    TimingPoint,
    _choose_subdivision,
    _fill_missed_beats,
    _atomic_grid_candidates,
    _expand_fit,
    _global_tempo_guides,
    _is_red_line,
    _recentre_phase,
    _refine_grid,
    _retime_onsets,
    _robust_local_bpms,
    _segment_tempi,
    _tune_boundary,
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
    section_measures,
    _points_from_sections,
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


# ---------------------------------------------------------------------------
# v3 precision engine
# ---------------------------------------------------------------------------

def _drum_track(path: Path, sections, duration: float = 24.0, sr: int = 44100,
                hats: bool = True, seed: int = 7) -> list[tuple[float, float]]:
    """Kick/snare/hat pattern with a known grid. Returns [(start_s, bpm)]."""
    import soundfile as sf
    rng = np.random.default_rng(seed)

    def kick():
        n = int(0.18 * sr)
        t = np.arange(n) / sr
        sweep = 2 * np.pi * np.cumsum(120 * np.exp(-t / 0.03) + 45) / sr
        return (np.sin(sweep) * np.exp(-t / 0.055)
                + rng.standard_normal(n) * np.exp(-t / 0.0025) * 0.35).astype(np.float32)

    def snare():
        n = int(0.16 * sr)
        t = np.arange(n) / sr
        return ((rng.standard_normal(n) * np.exp(-t / 0.045)) * 0.7
                + np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.03) * 0.5).astype(np.float32) * 0.7

    def hat():
        n = int(0.05 * sr)
        t = np.arange(n) / sr
        return (rng.standard_normal(n) * np.exp(-t / 0.008)).astype(np.float32) * 0.28

    KICK, SNARE, HAT = kick(), snare(), hat()
    buffer = np.zeros(int(duration * sr) + sr, dtype=np.float32)

    def place(sample, at, gain=1.0):
        i = int(round(at))
        end = min(len(buffer), i + len(sample))
        if 0 <= i < end:
            buffer[i:end] += sample[:end - i] * gain

    truth, t, beat, si = [], sections[0][0], 0, 0
    truth.append((t, sections[0][1]))
    while t < duration:
        while si + 1 < len(sections) and t >= sections[si + 1][0] - 1e-9:
            si += 1
            truth.append((t, sections[si][1]))
            beat = 0
        step = 60.0 / sections[si][1]
        place(KICK if beat % 4 in (0, 2) else SNARE, t * sr, 1.0 if beat % 4 == 0 else 0.85)
        if hats:
            place(HAT, t * sr, 0.7)
            place(HAT, (t + step / 2) * sr, 0.5)
        t += step
        beat += 1
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), (buffer[:int(duration * sr)] / max(peak, 1e-9) * 0.9), sr)
    return truth


def _offset_error_ms(offset_ms: float, true_start_s: float, bpm: float) -> float:
    """Distance from a detected offset to the nearest true beat, in ms."""
    step = 60.0 / bpm
    d = (offset_ms / 1000.0 - true_start_s) / step
    return abs(d - round(d)) * step * 1000.0


class PrecisionEngineTests(unittest.TestCase):
    def test_odd_tempo_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "odd.wav"
            truth = _drum_track(path, [(0.6173, 174.37)], duration=26.0)
            analysis = analyze_audio(path)
        self.assertEqual(analysis.engine, "precision")
        self.assertEqual(len(analysis.points), 1)
        self.assertAlmostEqual(analysis.points[0].bpm, 174.37, delta=0.02)
        self.assertLess(_offset_error_ms(analysis.points[0].offset_ms, truth[0][0], 174.37), 3.0)

    def test_two_sections_are_both_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "two.wav"
            truth = _drum_track(path, [(0.41, 150.0), (16.0, 162.0)], duration=34.0)
            analysis = analyze_audio(path)
        points = snap_timing_points(analysis.points)
        self.assertEqual(len(points), 2)
        self.assertAlmostEqual(points[0].bpm, 150.0, delta=0.02)
        self.assertAlmostEqual(points[1].bpm, 162.0, delta=0.02)
        for point, (start, bpm) in zip(points, truth):
            self.assertLess(_offset_error_ms(point.offset_ms, start, bpm), 4.0)
        # The second red line must land on the beat where the tempo changed.
        self.assertLess(abs(points[1].offset_ms / 1000.0 - truth[1][0]), 0.5)

    def test_forced_octave_is_exact_and_reversible(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "oct.wav"
            _drum_track(path, [(0.5, 160.0)], duration=24.0)
            base = analyze_audio(path)
            halved = analyze_audio(path, force_subdivision=0.5)
        self.assertAlmostEqual(halved.points[0].bpm, base.points[0].bpm / 2, delta=0.01)
        back = rebuild_with_subdivision(halved, 1.0)
        self.assertAlmostEqual(back.points[0].bpm, base.points[0].bpm, delta=0.01)
        with self.assertRaises(ValueError):
            analyze_audio(path, force_subdivision=3)

    def test_legacy_engine_still_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.wav"
            _drum_track(path, [(0.5, 150.0)], duration=24.0)
            analysis = analyze_audio(path, engine="legacy")
        self.assertEqual(analysis.engine, "legacy")
        self.assertAlmostEqual(analysis.global_bpm, 150.0, delta=150.0 * 0.03)
        with self.assertRaises(ValueError):
            analyze_audio(path, engine="nonsense")

    def test_precision_engine_refuses_ungriddable_audio(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pad.wav"
            sr = 44100
            t = np.arange(sr * 8) / sr
            drone = (np.sin(2 * np.pi * 220 * t) * 0.4).astype(np.float32)
            sf.write(str(path), drone, sr)
            with self.assertRaises(ValueError):
                analyze_audio(path, engine="precision")


class GridMathTests(unittest.TestCase):
    def test_coherence_phase_has_the_right_sign(self):
        # Regression: the phase used to come back negated, putting the seed
        # grid in anti-phase and forcing least squares to start half a beat off.
        period, phase = 0.25, 0.1234
        times = phase + np.arange(120) * period
        weights = np.ones_like(times)
        candidates = _atomic_grid_candidates(times, weights)
        self.assertTrue(candidates)
        best = min(candidates, key=lambda c: abs(c[0] - period))
        self.assertAlmostEqual(best[0], period, places=3)
        self.assertAlmostEqual(best[1] % period, phase % period, places=2)

    def test_least_squares_beats_interval_differencing(self):
        rng = np.random.default_rng(3)
        period, phase = 60.0 / 174.31, 0.4137
        k = np.arange(400)
        times = phase + k * period + rng.normal(0, 0.004, k.size)   # 4 ms jitter
        weights = np.ones_like(times)
        # Seeded 1 % off, as a coherence scan on a short window would be: the
        # expanding fit has to walk that in without slipping a beat index.
        fitted, fitted_phase = _expand_fit(times, weights, period * 1.01, phase + 0.01,
                                           float(times[0]), float(times[-1]))
        self.assertAlmostEqual(60.0 / fitted, 174.31, delta=0.01)
        # The beat-index origin may shift; only the phase modulo one beat means
        # anything, and it must land within a couple of milliseconds.
        drift = ((fitted_phase - phase + period / 2) % period) - period / 2
        self.assertLess(abs(drift), 0.002)
        # For contrast, the v2 approach — differencing consecutive beats — is
        # two orders of magnitude noisier on the very same data.
        naive = float(np.median(60.0 / np.diff(times)))
        self.assertGreater(abs(naive - 174.31), abs(60.0 / fitted - 174.31))

    def test_recentre_phase_picks_the_dense_cluster(self):
        period = 0.5
        beats = np.arange(60) * period
        ghosts = beats[:-1] + 0.04                    # weak, consistently late
        times = np.sort(np.concatenate([beats, ghosts]))
        weights = np.where(np.isin(times, beats), 1.0, 0.45)
        biased = 0.018                                 # what plain LS would settle on
        fixed = _recentre_phase(times, weights, period, biased)
        self.assertLess(abs(((fixed + period / 2) % period) - period / 2), 0.004)

    def test_boundary_lands_where_the_grids_cross(self):
        change = 20.0
        left = GridSection(0.0, change, 0.5, 0.0, 40, 0.5, 1.0)
        right = GridSection(change, 40.0, 0.46, change, 40, 0.5, 1.0)
        times = np.concatenate([np.arange(0, change, 0.5),
                                change + np.arange(0, 20.0, 0.46)])
        weights = np.ones_like(times)
        split = _tune_boundary(times, weights, left, right)
        self.assertAlmostEqual(split, change, delta=0.5)

    def test_attack_retiming_removes_detector_latency(self):
        sr = 44100
        y = np.zeros(sr * 3, dtype=np.float32)
        hits = np.array([0.5, 1.0, 1.5, 2.0])
        n = int(0.12 * sr)
        decay = np.exp(-np.arange(n) / (0.02 * sr)).astype(np.float32)
        tone = (np.sin(2 * np.pi * 90 * np.arange(n) / sr) * decay).astype(np.float32)
        for hit in hits:
            i = int(hit * sr)
            y[i:i + n] += tone
        late = hits + 0.008                            # a flux peak lags the attack
        fixed = _retime_onsets(y, sr, late)
        self.assertTrue(np.all(np.abs(fixed - hits) < 0.003),
                        f"retimed {np.round((fixed - hits) * 1000, 2)} ms off")


class ExportHardeningTests(unittest.TestCase):
    def _analysis(self, points, meter="4/4"):
        from types import SimpleNamespace
        return SimpleNamespace(source="song.mp3", points=points, meter=meter)

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


class MeasureGridTests(unittest.TestCase):
    """Per-section bars: audit F-03, and Tempora's measure model automated.

    v3 read the meter once, from the first section, wrote that number into
    every red line, and anchored every line after the first to a plain beat.
    A song that moves to 3/4 came out wrong everywhere after the change, and
    osu!'s bar lines drifted out of step with the music.
    """

    @staticmethod
    def _accented(period, phase, count, bar, start_class=0):
        """Attacks on a grid, accented once per `bar` beats."""
        times = np.array([phase + k * period for k in range(count)])
        weights = np.array(
            [1.0 if (k % bar) == start_class else 0.3 for k in range(count)],
            dtype=float,
        )
        return times, weights

    def test_section_measures_reads_each_section_separately(self):
        # 4/4 for 16 bars, then 3/4 for 16 bars, on the same tempo.
        period = 0.5
        a_times, a_weights = self._accented(period, 0.0, 64, 4)
        b_start = 64 * period
        b_times, b_weights = self._accented(period, b_start, 48, 3)
        times = np.r_[a_times, b_times]
        weights = np.r_[a_weights, b_weights]
        sections = [
            GridSection(0.0, b_start, period, 0.0, 64, 0.1, 1.0),
            GridSection(b_start, b_start + 48 * period, period, b_start, 48, 0.1, 1.0),
        ]
        measures = section_measures(sections, times, weights)
        self.assertEqual(measures[0][2], 4, f"first section: {measures[0]}")
        self.assertEqual(measures[1][2], 3, f"second section: {measures[1]}")

    def test_a_proven_bar_anchors_the_red_line_to_a_downbeat(self):
        # The second section's downbeat sits two beats after its start, so a
        # beat-anchored line would land on the wrong beat of the bar.
        period = 0.5
        sections = [
            GridSection(0.0, 10.0, period, 0.0, 20, 0.1, 1.0),
            GridSection(10.0, 20.0, period, 9.0, 20, 0.1, 1.0),
        ]
        measures = [("4/4", 0, 4), ("4/4", 1, 4)]
        points = _points_from_sections(sections, 0.0, 4, 0, 4, 1.0, measures)
        self.assertEqual(len(points), 2)
        second = points[1]
        # phase 9.0, downbeat class 1 -> downbeats at 9.5, 11.5, 13.5 ...
        # The first at or after the section start (10.0) is 11.5.
        self.assertAlmostEqual(second.offset_ms, 11500.0, places=6)
        self.assertTrue(second.meter_known)
        self.assertEqual(second.meter, 4)

    def test_no_evidence_keeps_the_old_beat_anchoring(self):
        # A section whose accents prove nothing must behave exactly as before:
        # anchored to the next beat, not pushed forward to an invented bar.
        period = 0.5
        sections = [
            GridSection(0.0, 10.0, period, 0.0, 20, 0.1, 1.0),
            GridSection(10.0, 20.0, period, 9.0, 20, 0.1, 1.0),
        ]
        measures = [("4/4", 0, 1), ("4/4", 0, 1)]
        points = _points_from_sections(sections, 0.0, 4, 0, 1, 1.0, measures)
        # phase 9.0, beats at 9.0, 9.5, 10.0 -> the first at/after 10.0 is 10.0
        self.assertAlmostEqual(points[1].offset_ms, 10000.0, places=6)
        self.assertFalse(points[1].meter_known)

    def test_each_point_writes_its_own_meter(self):
        analysis = Analysis("s", 30.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(0.0, 120.0, 1.0, 0, 4, True),
                             TimingPoint(8000.0, 120.0, 1.0, 1, 3, True)],
                            512, 44100, 1, 120.0, 1.0, "4/4")
        rows = [r for r in osu_timing_text(analysis).splitlines() if not r.startswith("//")]
        self.assertEqual(rows[0].split(",")[2], "4")
        self.assertEqual(rows[1].split(",")[2], "3", "the 3/4 section must say 3")

    def test_an_unknown_meter_falls_back_to_the_analysis(self):
        # A hand-added point knows no bar; writing a hard-coded 4 over a
        # detected 3/4 would invent information the engine did not have.
        analysis = Analysis("s", 30.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(0.0, 120.0, 1.0, 0)],
                            512, 44100, 1, 120.0, 1.0, "3/4")
        rows = [r for r in osu_timing_text(analysis).splitlines() if not r.startswith("//")]
        self.assertEqual(rows[0].split(",")[2], "3")

    def test_click_track_accents_on_the_detected_meter(self):
        """Audit F-03: the metronome accented every 4th beat on a waltz."""
        import soundfile as sf
        bpm, bar = 120.0, 3
        analysis = Analysis("s", 8.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(0.0, bpm, 1.0, 0, bar, True)],
                            512, 44100, 1, bpm, 1.0, "3/4")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "click.wav"
            export_click_track(analysis, path)
            y, sr = sf.read(str(path))
        beat = 60.0 / bpm
        # Peak amplitude in a short window at each beat. The accent tone is
        # louder, so accented beats must be the maxima.
        levels = []
        for k in range(12):
            start = int(k * beat * sr)
            levels.append(float(np.max(np.abs(y[start:start + int(0.03 * sr)]))))
        # The unaccented tone is rendered at 0.7 of the accent's gain, so a
        # 0.6 threshold would call every beat an accent. 0.85 separates them.
        accents = [k for k, level in enumerate(levels) if level > 0.85 * max(levels)]
        self.assertTrue(accents, f"no accents found in {levels}")
        self.assertTrue(
            all(k % bar == 0 for k in accents),
            f"accents at {accents} should all be multiples of {bar}",
        )


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

    def test_backup_keeps_the_pristine_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            inject_osu_timing_points(target, self._analysis())
            inject_osu_timing_points(target, self._analysis())
            spare = Path(str(target) + ".bak").read_text(encoding="utf-8")
        self.assertEqual(spare, self.LEGACY_OSU)

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

    def test_config_tolerates_garbage(self):
        import timing_analyzer
        with tempfile.TemporaryDirectory() as tmp:
            original = timing_analyzer.CONFIG_PATH
            timing_analyzer.CONFIG_PATH = Path(tmp) / "cfg.json"
            try:
                timing_analyzer.CONFIG_PATH.write_text("[1, 2, 3]", encoding="utf-8")
                self.assertEqual(timing_analyzer.load_config(), {})
                timing_analyzer.CONFIG_PATH.write_text("{not json", encoding="utf-8")
                self.assertEqual(timing_analyzer.load_config(), {})
                timing_analyzer.save_config({"language": "English"})
                self.assertEqual(timing_analyzer.load_config(), {"language": "English"})
                # An unserialisable value must not raise, and must not corrupt
                # the file that is already there.
                timing_analyzer.save_config({"bad": object()})
                self.assertEqual(timing_analyzer.load_config(), {"language": "English"})
            finally:
                timing_analyzer.CONFIG_PATH = original

    def test_local_bpm_helper_handles_degenerate_input(self):
        self.assertEqual(len(_robust_local_bpms(np.zeros(0))), 0)
        self.assertEqual(len(_robust_local_bpms(np.array([1.0]))), 1)


if __name__ == "__main__":
    unittest.main()
