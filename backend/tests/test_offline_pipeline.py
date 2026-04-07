"""Tests for the Sophia offline pipeline orchestrator."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_pipeline():
    """Reset the processed-sessions set between tests."""
    from deerflow.sophia.offline_pipeline import reset_processed_sessions

    reset_processed_sessions()
    yield
    reset_processed_sessions()


def _make_thread_state(
    messages: list | None = None,
    platform: str = "voice",
    context_mode: str = "life",
    ritual: str | None = None,
) -> dict:
    """Build a minimal thread_state dict for tests."""
    if messages is None:
        messages = [
            _fake_msg("human", "I had a tough day."),
            _fake_msg("ai", "I hear you. Tell me more."),
        ]
    return {
        "messages": messages,
        "platform": platform,
        "context_mode": context_mode,
        "active_ritual": ritual,
    }


def _fake_msg(msg_type: str, content: str) -> MagicMock:
    """Create a minimal mock message object."""
    msg = MagicMock()
    msg.type = msg_type
    msg.content = content
    msg.tool_calls = []
    msg.response_metadata = {}
    msg.additional_kwargs = {}
    return msg


# ------------------------------------------------------------------
# Patches applied to every test that calls run_offline_pipeline
# ------------------------------------------------------------------

_PATCHES = {
    "trace": "deerflow.sophia.offline_pipeline.write_session_trace",
    "extraction": "deerflow.sophia.offline_pipeline.extract_session_memories",
    "reconcile": "deerflow.sophia.offline_pipeline.reconcile_review_metadata_with_mem0",
    "smart_opener": "deerflow.sophia.offline_pipeline.generate_smart_opener",
    "handoff": "deerflow.sophia.offline_pipeline.generate_handoff",
    "identity": "deerflow.sophia.offline_pipeline.maybe_update_identity",
}


@pytest.fixture()
def mock_steps():
    """Patch all downstream pipeline functions and return a dict of mocks."""
    mocks = {}
    patchers = []
    for name, target in _PATCHES.items():
        p = patch(target)
        mock_obj = p.start()
        patchers.append(p)
        mocks[name] = mock_obj

    # Set sensible defaults
    mocks["extraction"].return_value = [
        {"content": "User had a tough day", "category": "feeling", "importance": "potential"},
    ]
    mocks["reconcile"].return_value = 0
    mocks["smart_opener"].return_value = "How are you feeling today?"
    mocks["identity"].return_value = False

    yield mocks

    for p in patchers:
        p.stop()


# ==================================================================
# Happy path
# ==================================================================


class TestHappyPath:
    def test_all_steps_succeed(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        result = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_001",
            thread_id="thread_001",
            thread_state=_make_thread_state(),
        )

        assert result["status"] == "completed"
        assert result["session_id"] == "sess_001"
        steps = result["steps"]
        assert steps["trace"] == "ok"
        assert steps["extraction"] == "ok"
        assert steps["smart_opener"] == "ok"
        assert steps["notification"] == "ok"
        assert steps["handoff"] == "ok"
        assert steps["identity"] == "ok"
        assert steps["visual_check"] == "ok"

    def test_all_downstream_functions_called(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_002",
            thread_id="thread_002",
            thread_state=_make_thread_state(),
        )

        mock_steps["trace"].assert_called_once()
        mock_steps["extraction"].assert_called_once()
        mock_steps["reconcile"].assert_called_once_with("user_abc")
        mock_steps["smart_opener"].assert_called_once()
        mock_steps["handoff"].assert_called_once()
        mock_steps["identity"].assert_called_once()

    def test_smart_opener_text_passed_to_handoff(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        mock_steps["smart_opener"].return_value = "Ready for round two?"

        run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_003",
            thread_id="thread_003",
            thread_state=_make_thread_state(),
        )

        # Handoff should receive the smart opener text
        call_kwargs = mock_steps["handoff"].call_args
        assert call_kwargs.kwargs.get("smart_opener_text") == "Ready for round two?"

    def test_extracted_memories_passed_to_identity(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        memories = [{"content": "Important", "importance": "structural"}]
        mock_steps["extraction"].return_value = memories

        run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_004",
            thread_id="thread_004",
            thread_state=_make_thread_state(),
        )

        mock_steps["identity"].assert_called_once_with("user_abc", memories)

    def test_reconcile_runs_after_extraction(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_reconcile",
            thread_id="thread_reconcile",
            thread_state=_make_thread_state(),
        )

        assert mock_steps["extraction"].call_count == 1
        assert mock_steps["reconcile"].call_count == 1


# ==================================================================
# Idempotency
# ==================================================================


class TestIdempotency:
    def test_second_call_returns_already_processed(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        state = _make_thread_state()
        r1 = run_offline_pipeline("user_abc", "sess_dup", "thread_dup", state)
        r2 = run_offline_pipeline("user_abc", "sess_dup", "thread_dup", state)

        assert r1["status"] == "completed"
        assert r2["status"] == "already_processed"

        # Downstream functions called only once (first run)
        assert mock_steps["trace"].call_count == 1

    def test_different_session_ids_both_process(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        state = _make_thread_state()
        r1 = run_offline_pipeline("user_abc", "sess_a", "thread_a", state)
        r2 = run_offline_pipeline("user_abc", "sess_b", "thread_b", state)

        assert r1["status"] == "completed"
        assert r2["status"] == "completed"
        assert mock_steps["trace"].call_count == 2

    def test_reset_clears_idempotency(self, mock_steps):
        from deerflow.sophia.offline_pipeline import (
            reset_processed_sessions,
            run_offline_pipeline,
        )

        state = _make_thread_state()
        run_offline_pipeline("user_abc", "sess_reset", "thread_r", state)
        reset_processed_sessions()
        r2 = run_offline_pipeline("user_abc", "sess_reset", "thread_r", state)

        assert r2["status"] == "completed"
        assert mock_steps["trace"].call_count == 2


# ==================================================================
# Step failure isolation
# ==================================================================


class TestStepFailureIsolation:
    def test_extraction_failure_does_not_block_handoff(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        mock_steps["extraction"].side_effect = RuntimeError("Mem0 unavailable")

        result = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_fail_ext",
            thread_id="thread_fail_ext",
            thread_state=_make_thread_state(),
        )

        assert result["status"] == "completed"
        assert result["steps"]["extraction"] == "error"
        assert result["steps"]["handoff"] == "ok"
        assert result["steps"]["identity"] == "ok"

    def test_trace_failure_does_not_block_extraction(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        mock_steps["trace"].side_effect = OSError("disk full")

        result = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_fail_trace",
            thread_id="thread_fail_trace",
            thread_state=_make_thread_state(),
        )

        assert result["steps"]["trace"] == "error"
        assert result["steps"]["extraction"] == "ok"

    def test_handoff_failure_does_not_block_identity(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        mock_steps["handoff"].side_effect = ValueError("write error")

        result = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_fail_hand",
            thread_id="thread_fail_hand",
            thread_state=_make_thread_state(),
        )

        assert result["steps"]["handoff"] == "error"
        assert result["steps"]["identity"] == "ok"

    def test_all_steps_fail_still_completes(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        for m in mock_steps.values():
            m.side_effect = RuntimeError("boom")

        result = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_all_fail",
            thread_id="thread_all_fail",
            thread_state=_make_thread_state(),
        )

        assert result["status"] == "completed"
        assert result["steps"]["trace"] == "error"
        assert result["steps"]["extraction"] == "error"
        assert result["steps"]["smart_opener"] == "error"
        assert result["steps"]["handoff"] == "error"
        assert result["steps"]["identity"] == "error"
        # notification and visual_check are internal — they always succeed
        assert result["steps"]["notification"] == "ok"
        assert result["steps"]["visual_check"] == "ok"


# ==================================================================
# Invalid user_id
# ==================================================================


class TestInvalidUserId:
    def test_path_traversal_rejected(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        with pytest.raises(ValueError, match="Invalid user_id"):
            run_offline_pipeline(
                user_id="../etc/passwd",
                session_id="sess_bad",
                thread_id="thread_bad",
                thread_state=_make_thread_state(),
            )

    def test_empty_user_id_rejected(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        with pytest.raises(ValueError, match="Invalid user_id"):
            run_offline_pipeline(
                user_id="",
                session_id="sess_empty",
                thread_id="thread_empty",
                thread_state=_make_thread_state(),
            )


# ==================================================================
# Empty / missing thread_state
# ==================================================================


class TestEmptyThreadState:
    def test_none_thread_state_returns_error(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        result = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_none",
            thread_id="thread_none",
            thread_state=None,
        )

        assert result["status"] == "error"
        assert result["reason"] == "no_thread_state"
        # No downstream functions called
        mock_steps["trace"].assert_not_called()

    def test_empty_messages_handled_gracefully(self, mock_steps):
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        result = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_empty_msgs",
            thread_id="thread_empty_msgs",
            thread_state=_make_thread_state(messages=[]),
        )

        assert result["status"] == "completed"
        # All steps should still attempt to run
        mock_steps["trace"].assert_called_once()


# ==================================================================
# Metadata extraction helpers
# ==================================================================


class TestBuildSessionMetadata:
    def test_extracts_from_top_level(self):
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {"platform": "voice", "context_mode": "work", "active_ritual": "debrief"}
        meta = _build_session_metadata(state)

        assert meta["platform"] == "voice"
        assert meta["context_mode"] == "work"
        assert meta["ritual"] == "debrief"

    def test_extracts_from_configurable(self):
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {"configurable": {"platform": "ios_voice", "context_mode": "gaming", "ritual": "vent"}}
        meta = _build_session_metadata(state)

        assert meta["platform"] == "ios_voice"
        assert meta["context_mode"] == "gaming"
        assert meta["ritual"] == "vent"

    def test_defaults_when_missing(self):
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        meta = _build_session_metadata({})

        assert meta["platform"] == "text"
        assert meta["context_mode"] == "life"
        assert meta["ritual"] is None


class TestBuildSessionSummary:
    def test_builds_transcript_from_messages(self):
        from deerflow.sophia.offline_pipeline import _build_session_summary

        msgs = [
            _fake_msg("human", "Hello"),
            _fake_msg("ai", "Hi there"),
        ]
        summary = _build_session_summary(msgs)
        assert "User: Hello" in summary
        assert "Sophia: Hi there" in summary

    def test_empty_messages_returns_empty_string(self):
        from deerflow.sophia.offline_pipeline import _build_session_summary

        assert _build_session_summary([]) == ""

    def test_dict_messages_handled(self):
        from deerflow.sophia.offline_pipeline import _build_session_summary

        msgs = [
            {"role": "user", "content": "Test"},
            {"role": "assistant", "content": "Response"},
        ]
        summary = _build_session_summary(msgs)
        assert "User: Test" in summary
        assert "Sophia: Response" in summary


class TestSerializeMessages:
    def test_converts_langchain_messages(self):
        from deerflow.sophia.offline_pipeline import _serialize_messages

        msgs = [_fake_msg("human", "hi"), _fake_msg("ai", "hello")]
        result = _serialize_messages(msgs)

        assert len(result) == 2
        assert result[0] == {"role": "user", "content": "hi"}
        assert result[1] == {"role": "assistant", "content": "hello"}

    def test_passes_dicts_through(self):
        from deerflow.sophia.offline_pipeline import _serialize_messages

        msgs = [{"role": "user", "content": "hi"}]
        result = _serialize_messages(msgs)

        assert result == [{"role": "user", "content": "hi"}]

    def test_handles_multimodal_content(self):
        from deerflow.sophia.offline_pipeline import _serialize_messages

        msg = MagicMock()
        msg.type = "human"
        msg.content = [{"text": "hello "}, {"text": "world"}]
        result = _serialize_messages([msg])

        assert result[0]["content"] == "hello  world"


class TestExtractArtifacts:
    def test_collects_from_artifacts_list(self):
        from deerflow.sophia.offline_pipeline import _extract_artifacts

        state = {"artifacts": [{"tone_estimate": 2.0}, {"tone_estimate": 3.0}]}
        arts = _extract_artifacts(state)
        assert len(arts) == 2

    def test_collects_current_and_previous(self):
        from deerflow.sophia.offline_pipeline import _extract_artifacts

        state = {
            "current_artifact": {"tone_estimate": 3.0},
            "previous_artifact": {"tone_estimate": 2.0},
        }
        arts = _extract_artifacts(state)
        assert len(arts) == 2

    def test_empty_state_returns_empty(self):
        from deerflow.sophia.offline_pipeline import _extract_artifacts

        assert _extract_artifacts({}) == []

    def test_skips_none_artifacts(self):
        from deerflow.sophia.offline_pipeline import _extract_artifacts

        state = {"current_artifact": None, "previous_artifact": None}
        assert _extract_artifacts(state) == []


class TestFormatMemoriesForOpener:
    def test_formats_memories(self):
        from deerflow.sophia.offline_pipeline import _format_memories_for_opener

        mems = [
            {"content": "User is stressed", "category": "feeling"},
            {"content": "Lives in NYC", "category": "fact"},
        ]
        result = _format_memories_for_opener(mems)
        assert "- [feeling] User is stressed" in result
        assert "- [fact] Lives in NYC" in result

    def test_empty_returns_fallback(self):
        from deerflow.sophia.offline_pipeline import _format_memories_for_opener

        assert _format_memories_for_opener([]) == "None available."
