import unittest

import numpy as np

from timing_analyzer import TimingPoint, _choose_subdivision, _segment_tempi, osu_timing_text, snap_timing_points


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
        self.assertEqual(points[1].offset_ms, 6000.0)
        self.assertIn("428.571428571429", osu_timing_text(type("A", (), {"points": points})()))

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
