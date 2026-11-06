"""Engine tests: The precision grid and the analysis it drives: sections, refusals, signatures."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from overtone import (HOP, MIN_PULSE_GAP, _load_audio, _onset_envelope, _pulse_gap,
                      _pulse_log10p, _meter_from_grid, Analysis, GridSection,
                      TimingPoint, _choose_subdivision, _fill_missed_beats,
                      _atomic_grid_candidates, _expand_fit, _global_tempo_guides,
                      _recentre_phase, _retime_onsets, _robust_local_bpms,
                      _segment_tempi, _tune_boundary, analysis_summary, analyze_audio,
                      export_click_track, osu_timing_text, rebuild_with_subdivision,
                      section_measures, detect_bar, meter_segments, points_from_meter,
                      _points_from_sections, snap_timing_points)

from engine_support import (_accented_attacks, _accented_track, _click_track,
                            _drum_track, _offset_error_ms, setUpModule, tearDownModule)  # noqa: F401


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

    def test_export_snaps_only_rounding_noise(self):
        # 0.4 ms off the previous grid is rounding: joined exactly. 7 ms off is
        # where the music put the change (the engine's own changes sit within
        # 0.03 ms), and moving it would invent an error: left alone.
        near = [TimingPoint(353, 225, 1, 0), TimingPoint(13153.4, 222, 1, 48)]
        self.assertAlmostEqual(snap_timing_points(near)[1].offset_ms, 13153.0, places=6)
        far = [TimingPoint(353, 225, 1, 0), TimingPoint(13160, 222, 1, 48)]
        self.assertEqual(snap_timing_points(far)[1].offset_ms, 13160)

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

    def test_a_lock_above_300_is_kept_not_halved(self):
        # A branch here claimed to halve a double-time lock; it returned 1
        # either way. The chooser never halves, so ÷2 is the user's way back.
        onset = np.zeros(700)
        beats = np.arange(10, 650, 30)  # ~344.5 BPM, every beat struck
        onset[beats] = 1.0
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
        from overtone import _global_tempo_guides, _onset_envelope
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
        from overtone import Analysis
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


class NoPulseRefusalTests(unittest.TestCase):
    """White noise must not return a BPM (CLAUDE.md rule 2).

    The precision engine already gave up on noise; the beat-tracker fallback
    then invented 127.68 BPM for it. It now refuses, while audio whose pulse
    drifts keeps its answer.
    """

    def _noise(self, path: Path, colour: str = "white", seconds: float = 20.0) -> None:
        import soundfile as sf
        sr = 22050
        rng = np.random.default_rng(3)
        spectrum = np.fft.rfft(rng.standard_normal(int(seconds * sr)))
        tilt = {"white": 0.0, "pink": 0.5, "brown": 1.0}[colour]
        signal = np.fft.irfft(spectrum / (np.arange(spectrum.size) + 1.0) ** tilt, int(seconds * sr))
        sf.write(str(path), (0.3 * signal / np.max(np.abs(signal))).astype(np.float32), sr)

    def test_noise_of_any_colour_gets_no_bpm(self):
        with tempfile.TemporaryDirectory() as tmp:
            for colour in ("white", "pink", "brown"):
                path = Path(tmp) / f"{colour}.wav"
                self._noise(path, colour)
                for engine in ("auto", "legacy"):
                    with self.subTest(colour=colour, engine=engine):
                        with self.assertRaises(ValueError):
                            analyze_audio(path, engine=engine)

    def test_scattered_clicks_get_no_bpm_from_the_fallback(self):
        # One of 12 random-click renders out of 240 that the tracker still
        # answered at MIN_PULSE_GAP 0.05 (188.6 BPM, gap 0.0558): 34 decaying
        # noise bursts at random times in 28 s, over a faint noise floor.
        import soundfile as sf
        rng = np.random.default_rng(1006)
        sr = 22050
        seconds = float(rng.uniform(20, 45))
        n = int(seconds * rng.uniform(0.6, 1.6))
        y = (rng.standard_normal(int(seconds * sr)) * rng.uniform(0, 0.01)).astype(np.float32)
        for t in rng.uniform(0.2, seconds - 0.5, n):
            i, gain = int(t * sr), rng.uniform(0.2, 0.9)
            burst = rng.standard_normal(300) * np.exp(-np.arange(300) / 60.0)
            y[i:i + 300] += (gain * burst[: y.size - i]).astype(np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scatter.wav"
            sf.write(str(path), y, sr)
            with self.assertRaises(ValueError):
                analyze_audio(path)

    def test_a_pulse_through_the_fallback_still_gets_its_bpm(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "drums.wav"
            _drum_track(path, [(0.5, 140.0)], duration=20.0)
            analysis = analyze_audio(path, engine="legacy")
        # not refused; the tracker's octave preference (120-300) may double it
        octave_error = min(abs(analysis.global_bpm - 140.0), abs(analysis.global_bpm - 280.0))
        self.assertLess(octave_error, 140.0 * 0.03)

    def test_the_gap_separates_noise_from_a_beat(self):
        with tempfile.TemporaryDirectory() as tmp:
            noise, drums = Path(tmp) / "noise.wav", Path(tmp) / "drums.wav"
            self._noise(noise)
            _drum_track(drums, [(0.5, 128.0)], duration=20.0)
            gaps = {}
            for name, path in (("noise", noise), ("drums", drums)):
                y, sr = _load_audio(str(path), lambda _message: None)  # the engine's own path
                gaps[name] = _pulse_gap(_onset_envelope(y, sr, HOP), sr, HOP)
        self.assertLess(gaps["noise"], MIN_PULSE_GAP)
        self.assertGreater(gaps["drums"], 3 * MIN_PULSE_GAP)
        self.assertEqual(_pulse_gap(np.zeros(4000), 22050, HOP), 0.0)  # silence


class FirstRedLinePhaseTests(unittest.TestCase):
    """The first red line lands on the beat when the song starts on the atom grid.

    Section 0 used to apply a beat class counted from the anchor seed's phase
    while its own phase came from a second seed a whole atom away, so on 5 of 8
    plain constant-tempo renders the only red line sat on the off-beat (250 ms
    late at 120 BPM). The 24-case corpus never starts on those offsets.
    """

    def test_start_on_the_eighth_note_grid(self):
        with tempfile.TemporaryDirectory() as tmp:
            for start, bpm in ((0.5, 120.0), (1.0, 120.0), (0.25, 120.0), (0.6, 150.0), (0.4, 150.0)):
                path = Path(tmp) / f"s{start}_{bpm}.wav"
                _drum_track(path, [(start, bpm)], duration=24.0)
                first = snap_timing_points(analyze_audio(path).points)[0]
                with self.subTest(start=start, bpm=bpm):
                    self.assertLess(_offset_error_ms(first.offset_ms, start, bpm), 5.0)


class MeterPathTempoChangeTests(unittest.TestCase):
    """The measure grid must not swallow a real tempo change.

    It measures the bar on one section and applied it to the whole track; with
    an audible downbeat, 128 -> 150 BPM came out as a single 128 BPM red line.
    """

    def test_tempo_change_with_a_clear_downbeat_keeps_both_red_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "change.wav"
            _accented_track(path, [(128.0, 24, 4), (150.0, 24, 4)])
            points = snap_timing_points(analyze_audio(path).points)
        self.assertEqual([round(p.bpm) for p in points], [128, 150])
        change = 0.5 + 24 * 4 * 60.0 / 128.0
        self.assertLess(abs(points[1].offset_ms / 1000.0 - change), 0.005)

    def test_sections_that_do_not_tile_one_bar_leave_the_meter_path(self):
        times, weights = _accented_attacks([(128.0, 24, 4), (150.0, 24, 4)])
        change = 0.5 + 24 * 4 * 60.0 / 128.0
        sections = [GridSection(0.5, change, 60.0 / 128.0, 0.5, 96, 0.1, 1.0),
                    GridSection(change, float(times[-1]), 60.0 / 150.0, change, 96, 0.1, 1.0)]
        self.assertIsNone(points_from_meter(sections, times, weights, 12))

    def test_a_signature_change_over_one_bar_still_tiles(self):
        # 6/4 at 300 then 3/4 at 150: one 1.2 s bar, two notations
        times, weights = _accented_attacks([(300.0, 12, 6), (150.0, 12, 3), (300.0, 12, 6)])
        first_end = 0.5 + 12 * 1.2
        sections = [GridSection(0.5, first_end, 0.2, 0.5, 72, 0.1, 1.0),
                    GridSection(first_end, float(times[-1]), 0.4, first_end, 36, 0.1, 1.0)]
        points = points_from_meter(sections, times, weights, 12)
        self.assertIsNotNone(points)
        self.assertEqual([p.meter for p in points], [6, 3, 6])


class PulseFactorKeepsChangesTests(unittest.TestCase):
    """÷2 / ÷4 must not delete a real tempo change.

    The duplicate filter compared BPMs that already carried the pulse factor
    against a threshold that did not: at ÷4 a 3.5 BPM change became 0.875 BPM
    and fell under the 1.5 BPM minimum.
    """

    def test_a_small_change_survives_halving_and_quartering(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "change.wav"
            _drum_track(path, [(0.5, 200.0), (16.0, 203.5)], duration=32.0)
            analysis = analyze_audio(path)
        self.assertEqual(len(analysis.points), 2)
        for factor in (0.5, 0.25):
            with self.subTest(factor=factor):
                rebuilt = rebuild_with_subdivision(analysis, factor)
                self.assertEqual([round(p.bpm, 2) for p in rebuilt.points],
                                 [round(200.0 * factor, 2), round(203.5 * factor, 2)])


class ChangeRedLineOnItsBeatTests(unittest.TestCase):
    """A section's red line sits on the beat at its start, even when the final
    refit leaves that beat a hair before the start.

    Red lines after the first were placed with ceil(x - 1e-9): a beat 0.03 ms
    before the settled start counted as "before", so the next beat was taken
    and the red line landed a whole beat (with a proven bar, a whole bar) late.
    """

    def _sections(self):
        p1, p2 = 60.0 / 132.0, 60.0 / 138.0
        change = 0.5 + 70 * p1
        # the new grid's beat sits 0.03 ms before the settled start
        return [GridSection(0.5, change, p1, 0.5, 140, 0.2, 1.0),
                GridSection(change, change + 30.0, p2, change - 3e-5, 130, 0.2, 1.0)], change

    def test_beat_branch(self):
        sections, change = self._sections()
        points = _points_from_sections(sections, 0.5, 12, 0, 1)
        self.assertLess(abs(points[1].offset_ms - (change * 1000.0 - 0.03)), 1e-6)

    def test_known_bar_branch(self):
        sections, change = self._sections()
        points = _points_from_sections(sections, 0.5, 12, 0, 4,
                                       measures=[("4/4", 0, 4), ("4/4", 0, 4)])
        self.assertLess(abs(points[1].offset_ms - (change * 1000.0 - 0.03)), 1e-6)


class SparseNoiseRefusalTests(unittest.TestCase):
    """Scattered transients with no pulse must not get a grid.

    About one random attack per second for 30 s (speech, ambient, an FX clip)
    passed the 0.40 share gate often enough that 4 of these 12 renders came
    out with a BPM between 29.7 and 48.3. A sparse pulse that really is there
    must keep its answer, off-grid attacks and all.
    """

    @staticmethod
    def _scatter(path: Path, trial: int, sr: int = 22050) -> None:
        import soundfile as sf
        rng = np.random.default_rng(trial)
        n, seconds = int(rng.integers(24, 45)), 30.0
        y = np.zeros(int(seconds * sr), dtype=np.float32)
        for t in np.sort(rng.uniform(0.2, seconds - 0.5, n)):
            i = int(t * sr)
            y[i:i + 300] += (rng.standard_normal(300) * np.exp(-np.arange(300) / 60)).astype(np.float32) * 0.6
        sf.write(str(path), y, sr)

    def test_random_clicks_get_no_bpm(self):
        with tempfile.TemporaryDirectory() as tmp:
            for trial in range(12):
                path = Path(tmp) / f"scatter{trial}.wav"
                self._scatter(path, trial)
                with self.subTest(trial=trial), self.assertRaises(ValueError):
                    analyze_audio(path)

    def test_a_sparse_pulse_keeps_its_bpm(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as tmp:
            for bpm in (60.0, 90.0):
                path = Path(tmp) / f"sparse{bpm:.0f}.wav"
                _click_track(path, bpm, duration=30.0)
                y, sr = sf.read(str(path), dtype="float32")
                rng = np.random.default_rng(1)  # a third as many attacks again, off the grid
                for t in rng.uniform(0.3, 29.5, int(bpm / 6)):
                    i = int(t * sr)
                    y[i:i + 300] += (rng.standard_normal(300) * np.exp(-np.arange(300) / 60)).astype(np.float32) * 0.4
                sf.write(str(path), y, sr)
                # The pulse as found, before the fold to osu!'s octave.
                analysis = analyze_audio(path, prefer_map_bpm=False)
                with self.subTest(bpm=bpm):
                    self.assertEqual(analysis.engine, "precision")
                    self.assertAlmostEqual(analysis.global_bpm, bpm, places=2)

    def test_the_pulse_is_read_at_the_mapped_octave(self):
        # MAP_OCTAVE_RANGE: a slow pulse is read doubled, a fast one halved,
        # one in range is left alone, and forcing a factor skips the fold.
        with tempfile.TemporaryDirectory() as tmp:
            for bpm, expected in ((60.0, 120.0), (90.0, 180.0), (174.0, 174.0), (300.0, 150.0)):
                path = Path(tmp) / f"click{bpm:.0f}.wav"
                _click_track(path, bpm, duration=30.0)
                with self.subTest(bpm=bpm):
                    self.assertAlmostEqual(analyze_audio(path).global_bpm, expected, places=1)
            forced = analyze_audio(Path(tmp) / "click90.wav", force_subdivision=1.0)
            self.assertAlmostEqual(forced.global_bpm, 90.0, places=1)

    def test_a_drifting_tempo_gets_red_lines_that_follow_it(self):
        # DRIFT_*: a pulse that slows from 150 to 146 BPM over three minutes
        # leaves a fixed grid by far more than 15 ms; followed, it stays
        # several times closer to the clicks. A steady pulse keeps one line.
        import soundfile as sf
        sr = 44100
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "drift.wav"
            duration = 180.0
            y = np.zeros(int(sr * duration), dtype=np.float32)
            t = np.arange(int(0.04 * sr)) / sr
            kick = (np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.006)).astype(np.float32)
            clicks, tt = [], 0.25
            while tt < duration - 0.2:
                y[int(tt * sr):int(tt * sr) + kick.size] += kick
                clicks.append(tt)
                tt += 60.0 / (150.0 - 4.0 * tt / duration)
            sf.write(str(path), y, sr)
            followed = analyze_audio(path, follow_drift=True)
            fixed = analyze_audio(path, osu_conventions=False)
            self.assertGreater(len(followed.points), len(fixed.points))
            from overtone import _beats_of
            clicks = np.asarray(clicks)

            def apart(analysis):
                beats = _beats_of([(p.offset_ms, p.bpm) for p in analysis.points], duration)
                i = np.clip(np.searchsorted(beats, clicks), 1, beats.size - 1)
                return np.minimum(np.abs(beats[i - 1] - clicks), np.abs(beats[i] - clicks)) * 1000

            # A ramp keeps moving inside every window, so the followed grid is
            # not exact; it must still be several times closer than the fixed one.
            self.assertLess(np.median(apart(followed)), np.median(apart(fixed)) / 4)
            self.assertLess(np.percentile(apart(followed), 90), np.percentile(apart(fixed), 90) / 2)
            steady = Path(tmp) / "steady.wav"
            _click_track(steady, 150.0, duration=60.0)
            self.assertEqual(len(analyze_audio(steady, follow_drift=True).points), 1)
            # On by default (DRIFT_FOLLOW), and off when asked.
            self.assertEqual(len(analyze_audio(path).points), len(followed.points))
            # Beat This! follows a ramp too, so its vote is off here as well.
            self.assertEqual(len(analyze_audio(path, follow_drift=False, beat_vote=False).points),
                             len(fixed.points))

    def test_the_chance_of_the_inliers(self):
        rng = np.random.default_rng(0)
        scattered = np.sort(rng.uniform(0.0, 30.0, 30))
        regular = np.arange(30) * 0.8 + 0.1
        self.assertGreater(_pulse_log10p(scattered, 0.8, 0.1), -2.0)
        self.assertLess(_pulse_log10p(regular, 0.8, 0.1), -15.0)
        self.assertEqual(_pulse_log10p(np.array([]), 0.8, 0.1), 0.0)


class OneWindowSignatureTests(unittest.TestCase):
    """A signature region exactly one window long is a region, wherever the song starts.

    Its length in seconds was compared with MIN_METER_BARS bars, which it
    equals: an ulp coin flip on accumulated float edges. At a 1.2 s bar, 85 of
    200 such runs were kept and 115 dropped.
    """

    def test_a_four_bar_interlude_in_three(self):
        bar = 1.2
        found = []
        for step in range(37):
            phase = 0.25 + step * 0.0271
            times, weights = [], []
            for n in range(68):
                beats = 3 if 32 <= n < 36 else 4
                for k in range(beats):
                    times.append(phase + n * bar + k * bar / beats)
                    weights.append(1.0 if k == 0 else 0.6)
            regions = meter_segments(np.array(times), np.array(weights, dtype=np.float32),
                                     bar, phase)
            found.append([beats for _a, _b, beats, _s in regions])
        self.assertEqual(found, [[4, 3, 4]] * 37)


class LongMixTests(unittest.TestCase):
    """Section growth must reach the end of a long track.

    It stopped after 64 passes: a 15-minute mix changing tempo every 9 s came
    out as 64 sections ending at 576.5 s, and the last 323 s had none.
    """

    def test_growth_covers_a_fifteen_minute_mix(self):
        from overtone import _grow_sections
        times, t = [], 0.5
        while t < 900.0:
            bpm = 120.0 if int((t - 0.5) // 9.0) % 2 == 0 else 127.0
            times.append(t)
            t += 60.0 / bpm
        times = np.array(times)
        sections = _grow_sections(times, np.full(times.size, 0.8, dtype=np.float32),
                                  0.5, 0.5, 1.5, 12)
        self.assertGreater(len(sections), 64)
        self.assertGreater(sections[-1].end_s, times[-1] - 1.0)


class HalfBarDownbeatTests(unittest.TestCase):
    """A bar is only claimed when its downbeat beats the class half a bar away.

    The onset envelope favours broadband hits: a snare can out-weigh the kick
    on 1, and read at double tempo the "bar" of four is two beats of kick and
    snare. The old rule compared the strongest class with the mean only, so it
    claimed the backbeat as the 1 -- 3 of 60 tempo-change renders put a red
    line one beat late, and on 88 ranked maps 16 of 21 claimed bars missed the
    map's downbeat.
    """

    @staticmethod
    def _grid(class_weights, bars: int = 64, period: float = 0.25):
        k = np.arange(bars * len(class_weights))
        rng = np.random.default_rng(0)
        weights = np.array(class_weights)[k % len(class_weights)] * rng.uniform(0.97, 1.03, k.size)
        return 0.5 + k * period, weights.astype(np.float32), period, 0.5

    def test_a_backbeat_is_not_a_downbeat(self):
        # Kick-beats 1.05, snare-beats 1.25, off-beats 0.85: 1.25 over the mean,
        # enough for the old rule, but only 1.19 over the class half a bar away.
        times, weights, period, phase = self._grid([1.05, 0.85, 1.25, 0.85])
        self.assertEqual(_meter_from_grid(times, weights, period, phase), ("4/4", 0, 1))

    def test_a_real_accent_still_proves_the_bar(self):
        times, weights, period, phase = self._grid([1.5, 1.0, 1.0, 1.0])
        self.assertEqual(_meter_from_grid(times, weights, period, phase), ("4/4", 0, 4))
        times, weights, period, phase = self._grid([1.0, 1.0, 1.5, 1.0])
        self.assertEqual(_meter_from_grid(times, weights, period, phase), ("4/4", 2, 4))
        # An odd bar has no half-bar class; 3/4 keeps the rule it had.
        times, weights, period, phase = self._grid([1.5, 1.0, 1.0])
        self.assertEqual(_meter_from_grid(times, weights, period, phase), ("3/4", 0, 3))


class NoiseBeforeTheMusicTests(unittest.TestCase):
    """The first red line starts where the grid starts, not at the first noise.

    With no bar claimed, the first line went to the grid beat nearest the
    first attack -- on very-noisy-132 a noise onset at 27 ms, so the line sat
    at -34.65 ms, a beat before music that starts at 420 ms.
    """

    def test_a_burst_before_the_drums(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "burst.wav"
            _drum_track(path, [(0.42, 132.0)], duration=30.0)
            y, sr = sf.read(str(path), dtype="float32")
            rng = np.random.default_rng(2)
            i = int(0.027 * sr)   # 0.135 of a beat off the grid
            y[i:i + 600] += (rng.standard_normal(600) * np.exp(-np.arange(600) / 120)).astype(np.float32) * 0.6
            sf.write(str(path), y, sr)
            analysis = analyze_audio(path)
        self.assertEqual(analysis.engine, "precision")
        first = snap_timing_points(analysis.points)[0]
        self.assertLess(abs(first.offset_ms - 420.0), 2.0, first.offset_ms)


class StrayLeadInTests(unittest.TestCase):
    """A lone click before the music must not throw the grid away.

    Section growth gave up when its first seed window held fewer than six
    attacks, so a click at 0.3 s before drums at 8 s left no section: the
    precision engine returned nothing and the fallback tracker answered with
    the wrong BPM and a red line on the click.
    """

    def test_a_click_before_the_drums(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "leadin.wav"
            _drum_track(path, [(8.0, 150.0)], duration=40.0)
            y, sr = sf.read(str(path), dtype="float32")
            i = int(0.3 * sr)  # a sharp click, not a smooth bump: it must read as an attack
            y[i:i + 400] += (np.hanning(400) * 0.8 * np.sign(np.sin(np.arange(400)))).astype(np.float32)
            sf.write(str(path), y, sr)
            analysis = analyze_audio(path)
        self.assertEqual(analysis.engine, "precision")
        first = snap_timing_points(analysis.points)[0]
        self.assertAlmostEqual(first.bpm, 150.0, places=2)
        self.assertLess(_offset_error_ms(first.offset_ms, 8.0, 150.0), 2.0)


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
        # Fastest first, as the docstring says (it used to say slowest).
        periods = [c[0] for c in candidates]
        self.assertEqual(periods, sorted(periods))

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


class SignatureRegionTests(unittest.TestCase):
    """Tempora's measure model, automated.

    Tempora's physical quantity is measures per second; BPM is a presentation
    of it through the time signature (`MpsToBpm(mps) = mps * 60 * beats`). A
    song can therefore change signature without changing tempo, and v3 — which
    grows sections on measures per second — could only report one BPM for it.
    """

    @staticmethod
    def _track(bar: float, phase: float, regions, bars: int):
        """Attacks on a constant bar, subdivided differently per region."""
        def beats_at(index: int) -> int:
            current = regions[0][1]
            for start, beats in regions:
                if index >= start:
                    current = beats
            return current

        times, weights = [], []
        for index in range(bars):
            beats = beats_at(index)
            beat = bar / beats
            start = phase + index * bar
            for b in range(beats):
                times.append(start + b * beat)
                weights.append(1.0 if b == 0 else 0.3)
        return np.asarray(times), np.asarray(weights, dtype=float)

    def test_detect_bar_finds_the_measure_not_a_hypermeasure(self):
        # Four bars of anything also show some accent contrast; the bar is the
        # strongest reading, not the longest. Getting this wrong gave a
        # 4800 ms measure where the truth is 1200.
        bar, phase = 1.2, 0.168
        times, weights = self._track(bar, phase, [(0, 6)], 60)
        found = detect_bar(times, weights, bar / 6, phase)
        self.assertIsNotNone(found)
        self.assertAlmostEqual(found[0], bar, places=6)
        self.assertAlmostEqual(found[1], phase, places=6)

    def test_detect_bar_refuses_without_accents(self):
        # Every attack equally loud: there is no downbeat, so claiming a bar
        # would move every red line on no evidence.
        times = np.arange(200) * 0.2
        weights = np.ones(200)
        self.assertIsNone(detect_bar(times, weights, 0.2, 0.0))

    def test_meter_segments_splits_on_the_subdivision(self):
        bar, phase = 1.2, 0.168
        regions = [(0, 6), (20, 3), (40, 6)]
        times, weights = self._track(bar, phase, regions, 60)
        segments = meter_segments(times, weights, bar, phase)
        self.assertEqual([beats for _s, _e, beats, _sc in segments], [6, 3, 6])
        for (start, _end, _beats, _score), (index, _b) in zip(segments, regions):
            self.assertAlmostEqual(start, phase + index * bar, places=3)

    def test_meter_segments_is_silent_on_one_signature(self):
        # Nothing to split: the ordinary per-section placement must stand.
        bar, phase = 1.2, 0.0
        times, weights = self._track(bar, phase, [(0, 4)], 60)
        self.assertEqual(meter_segments(times, weights, bar, phase), [])

    def test_bpm_follows_temporas_formula(self):
        # BPM = measures-per-second * 60 * beats-in-bar. A 1.2 s bar written
        # in 6 is 300 BPM, in 3 is 150, in 4 is 200 -- the same tempo.
        bar, phase = 1.2, 0.168
        regions = [(0, 6), (20, 3), (40, 4)]
        times, weights = self._track(bar, phase, regions, 60)
        sections = [GridSection(phase, phase + 60 * bar, bar / 6, phase,
                                len(times), 0.1, 1.0)]
        points = points_from_meter(sections, times, weights, 4)
        self.assertIsNotNone(points)
        self.assertEqual([round(p.bpm, 6) for p in points], [300.0, 150.0, 200.0])
        self.assertEqual([p.meter for p in points], [6, 3, 4])
        self.assertTrue(all(p.meter_known for p in points))

    def test_every_red_line_lands_on_a_bar_line(self):
        bar, phase = 1.2, 0.168
        regions = [(0, 6), (20, 3), (40, 6)]
        times, weights = self._track(bar, phase, regions, 60)
        sections = [GridSection(phase, phase + 60 * bar, bar / 6, phase,
                                len(times), 0.1, 1.0)]
        points = points_from_meter(sections, times, weights, 4)
        for point in points:
            bars = (point.offset_ms / 1000.0 - phase) / bar
            self.assertAlmostEqual(bars, round(bars), places=3,
                                   msg=f"{point.offset_ms} is not on a bar line")

    def test_a_forced_octave_falls_back_to_the_ordinary_path(self):
        # points_from_meter derives BPM from the bar, so a user-forced pulse
        # octave has no meaning in it; it must decline rather than ignore the
        # user's choice.
        bar, phase = 1.2, 0.168
        times, weights = self._track(bar, phase, [(0, 6), (20, 3)], 60)
        sections = [GridSection(phase, phase + 60 * bar, bar / 6, phase,
                                len(times), 0.1, 1.0)]
        self.assertIsNone(points_from_meter(sections, times, weights, 4, factor=2.0))


class CoherenceMapTests(unittest.TestCase):
    """Where the pulse is, over the whole track."""

    @staticmethod
    def _beats(bpm, seconds, start=0.0):
        step = 60.0 / bpm
        return np.arange(start, start + seconds, step)

    def test_the_grid_is_shared_and_stepped_by_the_window(self) -> None:
        from overtone import MAP_PERIOD_RANGE, map_frequencies
        wide, narrow = map_frequencies(12.0), map_frequencies(6.0)
        self.assertAlmostEqual(float(wide[0]), 1.0 / MAP_PERIOD_RANGE[1], places=9)
        self.assertLessEqual(float(wide[-1]), 1.0 / MAP_PERIOD_RANGE[0] + 1e-9)
        # a shorter window resolves less, so it is swept more coarsely
        self.assertAlmostEqual(float(np.diff(wide).mean()), 0.2 / 12.0, places=9)
        self.assertAlmostEqual(float(np.diff(narrow).mean()), 0.2 / 6.0, places=9)

    def test_a_steady_pulse_is_bright_at_its_own_rate(self) -> None:
        from overtone import coherence_map, map_ridge
        times = self._beats(150.0, 60.0)
        centres, freqs, columns = coherence_map(times, np.ones(times.size))
        self.assertGreater(columns.shape[0], 10)
        self.assertEqual(columns.shape[1], freqs.size)
        _at, period, r = map_ridge(centres, freqs, columns)
        self.assertGreater(float(np.median(r)), 0.95)
        # the ridge takes the strongest peak, which for a plain pulse train is
        # a multiple of it: every one of them explains the same hits
        ratios = (60.0 / period) / 150.0
        self.assertTrue(np.allclose(ratios, np.round(ratios), atol=0.02), ratios)

    def test_a_change_of_tempo_moves_the_ridge_by_its_own_ratio(self) -> None:
        from overtone import coherence_map, map_ridge
        times = np.concatenate([self._beats(128.0, 40.0), self._beats(142.0, 40.0, 40.0)])
        centres, freqs, columns = coherence_map(times, np.ones(times.size))
        at, period, _r = map_ridge(centres, freqs, columns)
        early = (60.0 / period)[at < 25.0]
        late = (60.0 / period)[at > 55.0]
        self.assertGreater(early.size, 0)
        self.assertGreater(late.size, 0)
        self.assertAlmostEqual(float(late.mean() / early.mean()), 142.0 / 128.0, delta=0.03)

    def test_a_window_with_too_little_in_it_gets_no_column(self) -> None:
        from overtone import MAP_MIN_ATTACKS, coherence_map
        sparse = np.array([0.0, 5.0, 10.0, 20.0, 30.0])      # under the bar
        centres, _freqs, columns = coherence_map(sparse, np.ones(sparse.size))
        self.assertEqual((centres.size, columns.shape[0]), (0, 0))
        self.assertGreaterEqual(MAP_MIN_ATTACKS, 8)

    def test_nothing_to_sweep(self) -> None:
        from overtone import BAND_COUNT, coherence_map, map_ridge  # noqa: F401
        centres, freqs, columns = coherence_map(np.zeros(0), np.zeros(0))
        self.assertEqual((centres.size, columns.shape[0]), (0, 0))
        self.assertGreater(freqs.size, 0)                    # the grid is fixed
        at, period, r = map_ridge(centres, freqs, columns)
        self.assertEqual((at.size, period.size, r.size), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
