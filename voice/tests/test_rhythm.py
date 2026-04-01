"""Tests for RhythmTracker (Layer 3)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from voice.rhythm import RhythmData, RhythmTracker, _running_avg


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_tracker(tmp_path: Path, **overrides) -> RhythmTracker:
    defaults = dict(
        users_dir=tmp_path,
        min_sessions=5,
        base_min_ms=800,
        base_max_ms=2400,
    )
    defaults.update(overrides)
    return RhythmTracker(**defaults)


def _write_rhythm(tmp_path: Path, user_id: str, data: dict) -> None:
    """Write a rhythm JSON file for a user."""
    path = tmp_path / user_id / "rhythm.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


# ---------------------------------------------------------------------------
# Load tests
# ---------------------------------------------------------------------------

class TestLoad:
    def test_new_user_returns_none(self, tmp_path: Path):
        tracker = _make_tracker(tmp_path)
        result = tracker.load("new_user")
        assert result is None

    def test_existing_user_loads_data(self, tmp_path: Path):
        _write_rhythm(tmp_path, "user1", {
            "session_count": 10,
            "avg_pause_ms": 1400.0,
            "avg_words_per_turn": 8.5,
            "multi_clause_frequency": 0.3,
            "cancel_merge_frequency": 0.05,
            "last_updated": "2026-03-30T12:00:00Z",
        })
        tracker = _make_tracker(tmp_path)
        data = tracker.load("user1")
        assert data is not None
        assert data.session_count == 10
        assert data.avg_pause_ms == 1400.0

    def test_corrupt_json_returns_none(self, tmp_path: Path):
        path = tmp_path / "corrupt" / "rhythm.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("not valid json{{{", encoding="utf-8")
        tracker = _make_tracker(tmp_path)
        result = tracker.load("corrupt")
        assert result is None


# ---------------------------------------------------------------------------
# Session recording + persistence
# ---------------------------------------------------------------------------

class TestEndSession:
    def test_first_session_creates_file(self, tmp_path: Path):
        tracker = _make_tracker(tmp_path)
        tracker.load("new_user")
        tracker.record_turn(5, [1000.0, 1500.0])
        tracker.record_turn(12, [800.0])
        tracker.end_session()

        path = tmp_path / "new_user" / "rhythm.json"
        assert path.exists()
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["session_count"] == 1
        assert data["avg_pause_ms"] == pytest.approx(1100.0)  # (1000+1500+800)/3
        assert data["avg_words_per_turn"] == pytest.approx(8.5)  # (5+12)/2

    def test_second_session_updates_running_average(self, tmp_path: Path):
        _write_rhythm(tmp_path, "user1", {
            "session_count": 1,
            "avg_pause_ms": 1000.0,
            "avg_words_per_turn": 6.0,
            "multi_clause_frequency": 0.0,
            "cancel_merge_frequency": 0.0,
            "last_updated": "",
        })
        tracker = _make_tracker(tmp_path)
        tracker.load("user1")
        tracker.record_turn(10, [1400.0])
        tracker.end_session()

        data = json.loads(
            (tmp_path / "user1" / "rhythm.json").read_text(encoding="utf-8")
        )
        assert data["session_count"] == 2
        # Running avg: (1000*1 + 1400) / 2 = 1200
        assert data["avg_pause_ms"] == pytest.approx(1200.0)

    def test_cancel_merge_frequency_tracked(self, tmp_path: Path):
        tracker = _make_tracker(tmp_path)
        tracker.load("user2")
        tracker.record_turn(5, [1000.0], was_cancel_merge=True)
        tracker.record_turn(8, [1200.0], was_cancel_merge=False)
        tracker.end_session()

        data = json.loads(
            (tmp_path / "user2" / "rhythm.json").read_text(encoding="utf-8")
        )
        assert data["cancel_merge_frequency"] == pytest.approx(0.5)  # 1/2 turns

    def test_multi_clause_frequency_tracked(self, tmp_path: Path):
        tracker = _make_tracker(tmp_path)
        tracker.load("user3")
        tracker.record_turn(15, [1000.0])   # multi-clause (>10 words)
        tracker.record_turn(3, [800.0])     # simple
        tracker.record_turn(12, [1100.0])   # multi-clause
        tracker.end_session()

        data = json.loads(
            (tmp_path / "user3" / "rhythm.json").read_text(encoding="utf-8")
        )
        # 2/3 turns were multi-clause
        assert data["multi_clause_frequency"] == pytest.approx(2.0 / 3.0)

    def test_accumulators_reset_after_end_session(self, tmp_path: Path):
        tracker = _make_tracker(tmp_path)
        tracker.load("userX")
        tracker.record_turn(5, [1000.0])
        tracker.end_session()

        # Second session should start fresh
        tracker.record_turn(10, [2000.0])
        tracker.end_session()

        data = json.loads(
            (tmp_path / "userX" / "rhythm.json").read_text(encoding="utf-8")
        )
        assert data["session_count"] == 2


# ---------------------------------------------------------------------------
# Silence offset computation
# ---------------------------------------------------------------------------

class TestComputeSilenceOffset:
    def test_new_user_returns_zero(self, tmp_path: Path):
        tracker = _make_tracker(tmp_path)
        tracker.load("new_user")
        assert tracker.compute_silence_offset() == 0

    def test_insufficient_sessions_returns_zero(self, tmp_path: Path):
        _write_rhythm(tmp_path, "user1", {
            "session_count": 4,
            "avg_pause_ms": 2000.0,
            "avg_words_per_turn": 10.0,
            "multi_clause_frequency": 0.0,
            "cancel_merge_frequency": 0.0,
            "last_updated": "",
        })
        tracker = _make_tracker(tmp_path, min_sessions=5)
        tracker.load("user1")
        assert tracker.compute_silence_offset() == 0

    def test_exactly_min_sessions_activates(self, tmp_path: Path):
        _write_rhythm(tmp_path, "user1", {
            "session_count": 5,
            "avg_pause_ms": 1600.0,  # 400ms above population avg
            "avg_words_per_turn": 10.0,
            "multi_clause_frequency": 0.0,
            "cancel_merge_frequency": 0.0,
            "last_updated": "",
        })
        tracker = _make_tracker(tmp_path, min_sessions=5)
        tracker.load("user1")
        offset = tracker.compute_silence_offset()
        # diff = 1600 - 1200 = 400, * 0.5 = +200
        assert offset == 200

    def test_slow_speaker_positive_offset(self, tmp_path: Path):
        _write_rhythm(tmp_path, "slow", {
            "session_count": 10,
            "avg_pause_ms": 1800.0,
            "avg_words_per_turn": 15.0,
            "multi_clause_frequency": 0.5,
            "cancel_merge_frequency": 0.1,
            "last_updated": "",
        })
        tracker = _make_tracker(tmp_path)
        tracker.load("slow")
        offset = tracker.compute_silence_offset()
        # diff = 1800 - 1200 = 600, * 0.5 = +300
        assert offset == 300

    def test_fast_speaker_negative_offset(self, tmp_path: Path):
        _write_rhythm(tmp_path, "fast", {
            "session_count": 10,
            "avg_pause_ms": 800.0,
            "avg_words_per_turn": 4.0,
            "multi_clause_frequency": 0.0,
            "cancel_merge_frequency": 0.0,
            "last_updated": "",
        })
        tracker = _make_tracker(tmp_path)
        tracker.load("fast")
        offset = tracker.compute_silence_offset()
        # diff = 800 - 1200 = -400, * 0.5 = -200
        assert offset == -200

    def test_offset_clamped_at_max(self, tmp_path: Path):
        _write_rhythm(tmp_path, "very_slow", {
            "session_count": 20,
            "avg_pause_ms": 3000.0,  # way above population
            "avg_words_per_turn": 20.0,
            "multi_clause_frequency": 0.8,
            "cancel_merge_frequency": 0.2,
            "last_updated": "",
        })
        tracker = _make_tracker(tmp_path, base_max_ms=2400)
        tracker.load("very_slow")
        offset = tracker.compute_silence_offset()
        # diff = 3000 - 1200 = 1800, * 0.5 = +900 → clamped at +400
        assert offset == 400

    def test_offset_clamped_at_min(self, tmp_path: Path):
        _write_rhythm(tmp_path, "very_fast", {
            "session_count": 20,
            "avg_pause_ms": 400.0,  # way below population
            "avg_words_per_turn": 3.0,
            "multi_clause_frequency": 0.0,
            "cancel_merge_frequency": 0.0,
            "last_updated": "",
        })
        tracker = _make_tracker(tmp_path, base_min_ms=800)
        tracker.load("very_fast")
        offset = tracker.compute_silence_offset()
        # diff = 400 - 1200 = -800, * 0.5 = -400 → clamped at -200
        assert offset == -200


# ---------------------------------------------------------------------------
# RhythmData serialization
# ---------------------------------------------------------------------------

class TestRhythmData:
    def test_round_trip(self):
        data = RhythmData(
            session_count=5,
            avg_pause_ms=1300.0,
            avg_words_per_turn=9.0,
            multi_clause_frequency=0.4,
            cancel_merge_frequency=0.1,
            last_updated="2026-03-31T00:00:00Z",
        )
        d = data.to_dict()
        restored = RhythmData.from_dict(d)
        assert restored.session_count == 5
        assert restored.avg_pause_ms == 1300.0
        assert restored.last_updated == "2026-03-31T00:00:00Z"

    def test_from_dict_missing_fields(self):
        data = RhythmData.from_dict({})
        assert data.session_count == 0
        assert data.avg_pause_ms == 0.0


# ---------------------------------------------------------------------------
# Running average helper
# ---------------------------------------------------------------------------

class TestRunningAvg:
    def test_first_sample(self):
        assert _running_avg(0.0, 100.0, 0) == 100.0

    def test_two_samples(self):
        assert _running_avg(100.0, 200.0, 1) == pytest.approx(150.0)

    def test_three_samples(self):
        avg_after_2 = 150.0
        assert _running_avg(avg_after_2, 300.0, 2) == pytest.approx(200.0)
