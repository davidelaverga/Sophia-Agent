"""Tests for the Sophia trace logger — per-session trace file writing."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest


def _make_ai_message(tool_calls: list[dict] | None = None, **kwargs):
    """Create a lightweight fake AIMessage with optional tool_calls."""
    msg = SimpleNamespace(
        type="ai",
        content=kwargs.get("content", ""),
        tool_calls=tool_calls or [],
        response_metadata=kwargs.get("response_metadata", {}),
        additional_kwargs=kwargs.get("additional_kwargs", {}),
    )
    return msg


def _make_human_message(content: str = "hello"):
    return SimpleNamespace(type="human", content=content)


def _emit_artifact_call(
    tone_estimate: float = 2.5,
    voice_emotion_primary: str = "sympathetic",
    voice_emotion_secondary: str = "calm",
    voice_speed: str = "gentle",
    skill_loaded: str = "vulnerability_holding",
    active_tone_band: str = "grief_fear",
    **extra,
) -> dict:
    """Build a tool_call dict that mimics an emit_artifact invocation."""
    args = {
        "tone_estimate": tone_estimate,
        "voice_emotion_primary": voice_emotion_primary,
        "voice_emotion_secondary": voice_emotion_secondary,
        "voice_speed": voice_speed,
        "skill_loaded": skill_loaded,
        "active_tone_band": active_tone_band,
        **extra,
    }
    return {"name": "emit_artifact", "args": args}


class TestWriteSessionTrace:
    """Core happy-path and edge-case tests."""

    def test_happy_path_three_turns(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_human_message("hi"),
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=2.8)],
            ),
            _make_human_message("tell me more"),
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=3.2)],
            ),
            _make_human_message("thanks"),
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=3.5)],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace(
                "user1",
                "sess_abc",
                messages,
                session_metadata={"platform": "voice", "context_mode": "work"},
            )

        assert result.exists()
        data = json.loads(result.read_text(encoding="utf-8"))
        assert data["session_id"] == "sess_abc"
        assert data["user_id"] == "user1"
        assert len(data["turns"]) == 3

        # Turn 1: tone_before defaults to 2.5
        t1 = data["turns"][0]
        assert t1["turn_id"] == "sess_sess_abc_turn_1"
        assert t1["tone_before"] == 2.5
        assert t1["tone_after"] == 2.8
        assert t1["platform"] == "voice"
        assert t1["context_mode"] == "work"

        # Turn 2: tone_before = previous tone_after
        t2 = data["turns"][1]
        assert t2["tone_before"] == 2.8
        assert t2["tone_after"] == 3.2

        # Turn 3
        t3 = data["turns"][2]
        assert t3["tone_before"] == 3.2
        assert t3["tone_after"] == 3.5

    def test_golden_turn_detection(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=3.0)],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_gold", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        turn = data["turns"][0]
        # tone_before=2.5, tone_after=3.0, delta=0.5 → golden
        assert turn["tone_delta"] == 0.5
        assert turn["is_golden_turn"] is True

    def test_non_golden_turn(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=2.9)],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_nongold", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        turn = data["turns"][0]
        # tone_before=2.5, tone_after=2.9, delta=0.4 → not golden
        assert turn["tone_delta"] == pytest.approx(0.4, abs=1e-4)
        assert turn["is_golden_turn"] is False

    def test_no_emit_artifact_produces_empty_turns(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_human_message("hi"),
            _make_ai_message(content="Hello there!"),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_empty", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        assert data["turns"] == []
        assert result.exists()

    def test_path_traversal_raises(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            with pytest.raises(ValueError):
                write_session_trace("../etc", "sess_bad", [])

    def test_invalid_user_id_raises(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            with pytest.raises(ValueError):
                write_session_trace("user/../../root", "sess_bad", [])

    def test_idempotent_same_content(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=3.0)],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            # Patch datetime for deterministic timestamps
            with patch("deerflow.sophia.trace_logger.datetime") as mock_dt:
                from datetime import datetime, timezone

                fixed_now = datetime(2026, 3, 27, 12, 0, 0, tzinfo=timezone.utc)
                mock_dt.now.return_value = fixed_now
                mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)

                p1 = write_session_trace("user1", "sess_idem", messages)
                content1 = p1.read_text(encoding="utf-8")

                p2 = write_session_trace("user1", "sess_idem", messages)
                content2 = p2.read_text(encoding="utf-8")

        assert content1 == content2

    def test_session_metadata_in_records(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=2.6)],
            ),
        ]
        meta = {
            "platform": "ios_voice",
            "context_mode": "gaming",
            "ritual": "debrief",
            "memory_injected": ["mem_abc123"],
        }

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_meta", messages, meta)

        data = json.loads(result.read_text(encoding="utf-8"))
        turn = data["turns"][0]
        assert turn["platform"] == "ios_voice"
        assert turn["context_mode"] == "gaming"
        assert turn["ritual"] == "debrief"
        assert turn["memory_injected"] == ["mem_abc123"]

    def test_creates_parent_directories(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("newuser", "sess_dirs", [])

        assert result.exists()
        assert result.parent.name == "traces"
        assert result.parent.parent.name == "newuser"

    def test_artifact_fields_extracted(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[
                    _emit_artifact_call(
                        tone_estimate=1.2,
                        voice_emotion_primary="sympathetic",
                        voice_emotion_secondary="calm",
                        voice_speed="gentle",
                        skill_loaded="vulnerability_holding",
                        active_tone_band="grief_fear",
                    )
                ],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_fields", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        turn = data["turns"][0]
        assert turn["voice_emotion_primary"] == "sympathetic"
        assert turn["voice_emotion_secondary"] == "calm"
        assert turn["voice_speed"] == "gentle"
        assert turn["skill_loaded"] == "vulnerability_holding"
        assert turn["active_tone_band"] == "grief_fear"

    def test_multiple_tool_calls_in_single_message(self, tmp_path: Path):
        """An AIMessage with 2 emit_artifact calls produces 2 turns."""
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[
                    _emit_artifact_call(tone_estimate=2.8),
                    _emit_artifact_call(tone_estimate=3.3),
                ],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_multi", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        assert len(data["turns"]) == 2
        assert data["turns"][0]["tone_before"] == 2.5
        assert data["turns"][0]["tone_after"] == 2.8
        assert data["turns"][1]["tone_before"] == 2.8
        assert data["turns"][1]["tone_after"] == 3.3

    def test_non_emit_artifact_tool_calls_ignored(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[
                    {"name": "switch_to_builder", "args": {"task": "build something"}},
                    _emit_artifact_call(tone_estimate=3.0),
                ],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_mixed", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        assert len(data["turns"]) == 1

    def test_string_args_parsed_as_json(self, tmp_path: Path):
        """Tool call args may arrive as a JSON string."""
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[
                    {
                        "name": "emit_artifact",
                        "args": json.dumps({"tone_estimate": 3.1, "voice_speed": "engaged"}),
                    }
                ],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_strargs", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        assert len(data["turns"]) == 1
        assert data["turns"][0]["tone_after"] == 3.1
        assert data["turns"][0]["voice_speed"] == "engaged"

    def test_timestamp_from_response_metadata(self, tmp_path: Path):
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[_emit_artifact_call(tone_estimate=2.7)],
                response_metadata={"timestamp": "2026-03-27T10:00:00Z"},
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_ts", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        assert data["turns"][0]["timestamp"] == "2026-03-27T10:00:00Z"

    def test_missing_tone_estimate_uses_previous(self, tmp_path: Path):
        """If emit_artifact has no tone_estimate, use the previous tone."""
        from deerflow.sophia.trace_logger import write_session_trace

        messages = [
            _make_ai_message(
                tool_calls=[{"name": "emit_artifact", "args": {}}],
            ),
        ]

        with patch("deerflow.sophia.trace_logger.USERS_DIR", tmp_path):
            result = write_session_trace("user1", "sess_notone", messages)

        data = json.loads(result.read_text(encoding="utf-8"))
        turn = data["turns"][0]
        # No tone_estimate → falls back to previous (2.5 default)
        assert turn["tone_before"] == 2.5
        assert turn["tone_after"] == 2.5
        assert turn["tone_delta"] == 0.0
