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
    "smart_opener": "deerflow.sophia.offline_pipeline.generate_smart_opener",
    "handoff": "deerflow.sophia.offline_pipeline.generate_handoff",
    "identity": "deerflow.sophia.offline_pipeline.maybe_update_identity",
    "recap": "deerflow.sophia.offline_pipeline._write_offline_recap",
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
    mocks["smart_opener"].return_value = "How are you feeling today?"
    mocks["identity"].return_value = False
    mocks["recap"].return_value = "ok"

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
        assert steps["recap"] == "ok"
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

    def test_session_start_unix_from_earliest_timestamped_message(self):
        """When first message lacks timestamp, scan all for earliest valid one."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {
            "messages": [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": "hello", "timestamp": 1715900000},
                {"role": "assistant", "content": "hi", "timestamp": 1715900100},
            ],
            "platform": "voice",
        }
        meta = _build_session_metadata(state)
        assert meta["session_start_unix"] == 1715900000

    def test_session_start_unix_picks_earliest_across_all_messages(self):
        """Multiple messages with timestamps — pick the earliest."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {
            "messages": [
                {"role": "user", "content": "hello", "timestamp": 1715900500},
                {"role": "assistant", "content": "hi", "timestamp": 1715900100},
                {"role": "user", "content": "bye", "timestamp": 1715900200},
            ],
        }
        meta = _build_session_metadata(state)
        assert meta["session_start_unix"] == 1715900100

    def test_session_start_unix_prefers_current_session_record(self):
        """Current session record must win over older messages in the thread."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        record = MagicMock()
        record.created_at = "1970-01-02T00:00:00+00:00"
        state = {
            "messages": [
                {"role": "user", "content": "old session", "session_id": "old-session", "timestamp": 1},
                {"role": "user", "content": "current session", "timestamp": 2},
            ],
        }

        with patch("deerflow.sophia.session_store.SessionStore.get", return_value=record) as mock_get:
            meta = _build_session_metadata(state, user_id="user1", session_id="current-session")

        assert meta["session_start_unix"] == 86400
        mock_get.assert_called_once_with("user1", "current-session")

    def test_session_start_unix_uses_only_current_session_messages_when_scoped(self):
        """Fallback to message timestamps only within the finalized session."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {
            "messages": [
                {"role": "user", "content": "old session", "session_id": "old-session", "timestamp": 1},
                {"role": "user", "content": "current one", "session_id": "current-session", "timestamp": 200},
                {"role": "assistant", "content": "current two", "session_id": "current-session", "timestamp": 250},
            ],
        }

        with patch("deerflow.sophia.session_store.SessionStore.get", return_value=None):
            meta = _build_session_metadata(state, user_id="user1", session_id="current-session")

        assert meta["session_start_unix"] == 200

    def test_session_start_unix_uses_untagged_messages_when_current_session_is_untagged(self):
        """Older tagged messages must not hide untagged current-session messages."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {
            "messages": [
                {"role": "user", "content": "old", "session_id": "old-session", "timestamp": 1},
                {"role": "user", "content": "current one", "timestamp": 200},
                {"role": "assistant", "content": "current two", "timestamp": 250},
            ],
        }

        with patch("deerflow.sophia.session_store.SessionStore.get", return_value=None):
            meta = _build_session_metadata(state, user_id="user1", session_id="current-session")

        assert meta["session_start_unix"] == 200

    def test_session_start_unix_prefers_exact_session_tags_over_untagged_messages(self):
        """When current-session tags exist, they win over untagged timestamps."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {
            "messages": [
                {"role": "user", "content": "untagged prior", "timestamp": 100},
                {"role": "user", "content": "current one", "session_id": "current-session", "timestamp": 300},
                {"role": "assistant", "content": "current two", "session_id": "current-session", "timestamp": 350},
            ],
        }

        with patch("deerflow.sophia.session_store.SessionStore.get", return_value=None):
            meta = _build_session_metadata(state, user_id="user1", session_id="current-session")

        assert meta["session_start_unix"] == 300

    def test_session_start_unix_falls_back_to_untagged_message_timestamps(self):
        """If SessionStore is stale and messages are untagged, use conversation time."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {
            "messages": [
                {"role": "user", "content": "hello", "timestamp": 1715900500},
                {"role": "assistant", "content": "hi", "timestamp": 1715900100},
            ],
        }

        with patch("deerflow.sophia.session_store.SessionStore.get", return_value=None):
            meta = _build_session_metadata(state, user_id="user1", session_id="current-session")

        assert meta["session_start_unix"] == 1715900100

    def test_session_start_unix_does_not_use_other_tagged_sessions(self):
        """If the thread is tagged for another session, avoid anchoring to it."""
        from deerflow.sophia.offline_pipeline import _build_session_metadata

        state = {
            "messages": [
                {"role": "user", "content": "old", "session_id": "old-session", "timestamp": 1},
                {"role": "assistant", "content": "old reply", "session_id": "old-session", "timestamp": 2},
            ],
        }

        with patch("deerflow.sophia.session_store.SessionStore.get", return_value=None):
            meta = _build_session_metadata(state, user_id="user1", session_id="current-session")

        assert meta["session_start_unix"] is None


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
        # _flatten_content requires the canonical block shape
        # ({"type": "text", "text": ...}). The earlier mock shape
        # ({"text": ...}) was silently shadowed by the duplicate
        # TestSerializeMessages class on main, so this test never
        # ran. Fixed here to match how Anthropic/LangChain emit
        # multimodal text blocks.
        msg.content = [
            {"type": "text", "text": "hello "},
            {"type": "text", "text": "world"},
        ]
        result = _serialize_messages([msg])

        # Note the double space: _flatten_content joins blocks
        # verbatim, so "hello " + "world" → "hello  world".
        # Trim/normalisation is intentionally NOT applied here
        # because Mem0 needs the original token boundaries.
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


# ==================================================================
# State fetch fallback
# ==================================================================


class TestStateFetchFallback:
    """Tests for _fetch_thread_state and the self-fetching pipeline guard."""

    def test_fetches_thread_state_when_none(self, mock_steps):
        """Pipeline fetches state from LangGraph when thread_state=None."""
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        fake_state = _make_thread_state()
        # Patch httpx.get to return a successful response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"values": fake_state}

        with patch("deerflow.sophia.offline_pipeline.httpx") as mock_httpx:
            mock_httpx.get.return_value = mock_response
            result = run_offline_pipeline("user_abc", "sess_fetch", "thread_fetch", thread_state=None)

        assert result["status"] == "completed"
        mock_httpx.get.assert_called_once()
        # Verify the URL contains the thread_id
        call_url = mock_httpx.get.call_args[0][0]
        assert "thread_fetch" in call_url

    def test_aborts_when_fetch_fails(self, mock_steps):
        """Pipeline aborts when both thread_state=None and fetch fails."""
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        with patch("deerflow.sophia.offline_pipeline.httpx") as mock_httpx:
            mock_httpx.get.side_effect = Exception("Connection refused")
            result = run_offline_pipeline("user_abc", "sess_fail", "thread_fail", thread_state=None)

        assert result["status"] == "error"
        assert result["reason"] == "no_thread_state"

    def test_aborts_when_fetch_returns_no_messages(self, mock_steps):
        """Pipeline aborts when fetched state has no messages."""
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"values": {"messages": []}}

        with patch("deerflow.sophia.offline_pipeline.httpx") as mock_httpx:
            mock_httpx.get.return_value = mock_response
            result = run_offline_pipeline("user_abc", "sess_empty", "thread_empty", thread_state=None)

        assert result["status"] == "error"
        assert result["reason"] == "no_thread_state"


# ==================================================================
# Fix 1: _serialize_messages normalization
# ==================================================================
#
# Regression guard for the production bug where 6 messages from a
# Telegram session produced 0 memories: dict-shaped messages with
# ``role="human"`` were passed through unchanged, then ``extraction.
# _format_transcript`` silently dropped them because it only accepts
# ``role == "user"``.


class TestSerializeMessagesDictRole:
    """Second TestSerializeMessages class — ruff F811 flagged the duplicate.

    Renamed (rather than merged) to keep these dict-shape regression tests
    clearly grouped near the contract comment block above. Two separate
    classes covering different aspects of ``_serialize_messages`` is fine
    — the only issue was the name collision.
    """

    def test_normalizes_human_role_in_dict_messages(self):
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([
            {"role": "human", "content": "I had a tough day."},
            {"role": "ai", "content": "I hear you."},
        ])
        assert out == [
            {"role": "user", "content": "I had a tough day."},
            {"role": "assistant", "content": "I hear you."},
        ]

    def test_falls_back_to_type_field_for_langchain_serialized_dicts(self):
        """LangGraph's ``GET /threads/{id}/state`` returns LangChain
        BaseMessage objects serialized as JSON dicts with ``type`` (NOT
        ``role``). Without this fallback, the dict branch leaves role
        blank, the extractor drops every message, and a Telegram session
        with real content produces 0 Mem0 memories. Regression guard."""
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([
            {
                "type": "human",
                "content": "I had a great conversation today.",
                "additional_kwargs": {},
                "response_metadata": {},
            },
            {
                "type": "ai",
                "content": "That sounds wonderful.",
                "additional_kwargs": {},
                "response_metadata": {},
            },
        ])
        assert out == [
            {"role": "user", "content": "I had a great conversation today."},
            {"role": "assistant", "content": "That sounds wonderful."},
        ]

    def test_role_takes_precedence_over_type_when_both_present(self):
        """If a message somehow has both keys, ``role`` wins. Defensive
        — keeps channel-adapter-built dicts deterministic even if a
        future LangChain version started emitting both."""
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([
            {"role": "human", "type": "ai", "content": "hi"},
        ])
        assert out == [{"role": "user", "content": "hi"}]

    def test_reads_content_from_data_payload_for_langchain_wire_shape(self):
        """LangChain JSON payloads can place content under ``data.content``.
        We should still preserve transcript text for extraction."""
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([
            {
                "type": "human",
                "data": {"content": "content from data payload"},
            },
        ])
        assert out == [{"role": "user", "content": "content from data payload"}]

    def test_flattens_list_content_in_dict_messages(self):
        """Telegram inbounds with attachments arrive as list-of-content-blocks.
        We extract the text blocks; image / pdf blocks are dropped at this layer
        (the extractor only looks at text)."""
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([
            {
                "role": "human",
                "content": [
                    {"type": "text", "text": "Look at this photo of my notebook"},
                    {"type": "image", "source": {"type": "base64", "data": "..."}},
                ],
            },
        ])
        assert out == [
            {"role": "user", "content": "Look at this photo of my notebook"},
        ]

    def test_passes_user_assistant_roles_through_unchanged(self):
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ])
        assert out == [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]

    def test_preserves_unknown_role_unchanged(self):
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([{"role": "tool", "content": "result"}])
        assert out == [{"role": "tool", "content": "result"}]

    def test_handles_langchain_basemessage_objects(self):
        """Regression: the BaseMessage path was working; we shouldn't break it."""
        from deerflow.sophia.offline_pipeline import _serialize_messages

        msg = MagicMock()
        msg.type = "human"
        msg.content = "from langchain"
        out = _serialize_messages([msg])
        assert out == [{"role": "user", "content": "from langchain"}]

    def test_empty_content_yields_empty_string(self):
        from deerflow.sophia.offline_pipeline import _serialize_messages

        out = _serialize_messages([{"role": "human", "content": None}])
        assert out == [{"role": "user", "content": ""}]


# ==================================================================
# Fix 2: _write_offline_recap envelope
# ==================================================================


class TestWriteOfflineRecap:
    def test_writes_minimal_envelope_when_file_missing(self, tmp_path, monkeypatch):
        from deerflow.sophia import offline_pipeline as module

        monkeypatch.setattr(module, "USERS_DIR", tmp_path)
        result = module._write_offline_recap(
            user_id="user-1",
            session_id="sess-1",
            thread_id="thread-1",
            session_metadata={"context_mode": "work"},
            turn_count=6,
        )
        assert result == "ok"

        recap_path = tmp_path / "user-1" / "recaps" / "sess-1.json"
        assert recap_path.exists()

        import json

        payload = json.loads(recap_path.read_text())
        assert payload["session_id"] == "sess-1"
        assert payload["thread_id"] == "thread-1"
        assert payload["context_mode"] == "work"
        assert payload["turn_count"] == 6
        assert payload["status"] == "processing"
        # Empty dict (NOT None) so the frontend mapper accepts the envelope
        # and the hydration step gets a chance to merge Mem0 candidates.
        assert payload["recap_artifacts"] == {}
        assert payload["ended_at"]  # ISO string set

    def test_skips_when_recap_already_exists(self, tmp_path, monkeypatch):
        """Web flow's richer recap takes priority — never overwrite."""
        from deerflow.sophia import offline_pipeline as module

        monkeypatch.setattr(module, "USERS_DIR", tmp_path)

        recap_path = tmp_path / "user-1" / "recaps" / "sess-1.json"
        recap_path.parent.mkdir(parents=True, exist_ok=True)
        recap_path.write_text('{"status": "ready", "recap_artifacts": {"takeaway": "from web"}}')

        result = module._write_offline_recap(
            user_id="user-1",
            session_id="sess-1",
            thread_id="thread-1",
            session_metadata={},
            turn_count=0,
        )
        assert result == "skipped_exists"
        # Web-side payload preserved.
        assert "from web" in recap_path.read_text()

    def test_pulls_started_at_from_session_store(self, tmp_path, monkeypatch):
        from deerflow.sophia import offline_pipeline as module

        monkeypatch.setattr(module, "USERS_DIR", tmp_path)

        fake_record = MagicMock()
        fake_record.created_at = "2026-05-08T15:00:00+00:00"
        fake_store = MagicMock()
        fake_store.get = MagicMock(return_value=fake_record)
        fake_session_store_cls = MagicMock(return_value=fake_store)
        with patch(
            "deerflow.sophia.session_store.SessionStore", fake_session_store_cls
        ):
            module._write_offline_recap(
                user_id="user-1",
                session_id="sess-1",
                thread_id="thread-1",
                session_metadata={},
                turn_count=0,
            )

        import json

        payload = json.loads((tmp_path / "user-1" / "recaps" / "sess-1.json").read_text())
        assert payload["started_at"] == "2026-05-08T15:00:00+00:00"

    def test_handles_session_store_failure_gracefully(self, tmp_path, monkeypatch):
        """SessionStore lookup error must NOT crash the pipeline; just leave
        ``started_at`` null."""
        from deerflow.sophia import offline_pipeline as module

        monkeypatch.setattr(module, "USERS_DIR", tmp_path)

        with patch(
            "deerflow.sophia.session_store.SessionStore",
            side_effect=RuntimeError("disk gone"),
        ):
            result = module._write_offline_recap(
                user_id="user-1",
                session_id="sess-1",
                thread_id="thread-1",
                session_metadata={},
                turn_count=0,
            )
        assert result == "ok"

        import json

        payload = json.loads((tmp_path / "user-1" / "recaps" / "sess-1.json").read_text())
        assert payload["started_at"] is None


# ==================================================================
# H.2 — Extraction retryability + force_reprocess + in-flight guard
# ==================================================================


class TestExtractionRetryability:
    """The H.2 contract: extraction parse error leaves session NOT processed.

    Before H.2, ``_processed_sessions.add(session_id)`` ran BEFORE extraction —
    so a failed-or-empty extraction permanently locked the session against
    retry, even when a later trigger (e.g. explicit end_session click on the
    same thread, after many more messages) had genuine data to extract.
    """

    def test_extraction_parse_error_leaves_session_unprocessed(self, mock_steps):
        """ExtractionParseError → second call MUST re-run the pipeline."""
        from deerflow.sophia.extraction import ExtractionParseError
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        # First call: extraction raises ExtractionParseError
        mock_steps["extraction"].side_effect = ExtractionParseError("malformed JSON")
        r1 = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_retry_parse",
            thread_id="thread_retry_parse",
            thread_state=_make_thread_state(),
        )
        assert r1["status"] == "completed"
        assert r1["steps"]["extraction"] == "parse_error"
        assert r1["extraction_retryable"] is True

        # Second call: extraction now succeeds → must NOT be rejected as "already_processed"
        mock_steps["extraction"].side_effect = None
        mock_steps["extraction"].return_value = [
            {"content": "User said something memorable", "category": "fact", "importance": "structural"},
        ]
        r2 = run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_retry_parse",
            thread_id="thread_retry_parse",
            thread_state=_make_thread_state(),
        )
        assert r2["status"] == "completed", "Session should be retryable after parse error"
        assert r2["steps"]["extraction"] == "ok"
        assert r2["extraction_retryable"] is False
        assert mock_steps["extraction"].call_count == 2

    def test_extraction_generic_exception_leaves_session_unprocessed(self, mock_steps):
        """Non-parse extraction exception (e.g. Mem0 unavailable) also leaves session retryable."""
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        mock_steps["extraction"].side_effect = RuntimeError("Mem0 down")
        r1 = run_offline_pipeline("user_abc", "sess_retry_runtime", "t1", _make_thread_state())
        assert r1["extraction_retryable"] is True

        mock_steps["extraction"].side_effect = None
        mock_steps["extraction"].return_value = [
            {"content": "ok", "category": "fact", "importance": "structural"},
        ]
        r2 = run_offline_pipeline("user_abc", "sess_retry_runtime", "t1", _make_thread_state())
        assert r2["status"] == "completed", "Generic extraction errors should also be retryable"
        assert r2["extraction_retryable"] is False

    def test_extraction_empty_marks_session_processed(self, mock_steps):
        """LLM legitimately returns [] → mark session processed (don't keep retrying)."""
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        mock_steps["extraction"].return_value = []   # legitimate "no memories"
        r1 = run_offline_pipeline("user_abc", "sess_empty", "t_empty", _make_thread_state())
        assert r1["status"] == "completed"
        assert r1["steps"]["extraction"] == "ok"
        assert r1["extraction_retryable"] is False

        r2 = run_offline_pipeline("user_abc", "sess_empty", "t_empty", _make_thread_state())
        assert r2["status"] == "already_processed", (
            "Empty-but-valid extraction should mark session processed — "
            "the LLM said no candidates, no point retrying"
        )


class TestForceReprocess:
    """The H.3 contract: explicit end_session can override idempotency."""

    def test_force_reprocess_bypasses_already_processed(self, mock_steps):
        """force_reprocess=True re-runs the pipeline even on a completed session."""
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        # First call completes successfully
        r1 = run_offline_pipeline("user_abc", "sess_force", "t_force", _make_thread_state())
        assert r1["status"] == "completed"
        assert mock_steps["trace"].call_count == 1

        # Without force, second call short-circuits
        r2 = run_offline_pipeline("user_abc", "sess_force", "t_force", _make_thread_state())
        assert r2["status"] == "already_processed"
        assert mock_steps["trace"].call_count == 1   # not incremented

        # With force, second call re-runs every step
        r3 = run_offline_pipeline(
            "user_abc", "sess_force", "t_force", _make_thread_state(),
            force_reprocess=True,
        )
        assert r3["status"] == "completed"
        assert mock_steps["trace"].call_count == 2   # ran again


class TestInFlightProtection:
    """Two-stage idempotency: concurrent calls on the same session_id serialize.

    When run_offline_pipeline is invoked twice for the same session_id while
    the first call is still in progress (extraction is the longest step in
    practice), the second call must NOT double-process. It returns the
    `in_flight` status so the caller can ignore the duplicate.
    """

    def test_in_flight_protects_concurrent_runs(self, mock_steps):
        """While extraction is running on session X, a second call returns 'in_flight'."""
        import threading

        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        # Use an Event to pause extraction inside the first call so we can
        # fire a second call mid-flight.
        first_started = threading.Event()
        let_first_finish = threading.Event()
        second_result = {}

        def slow_extraction(*args, **kwargs):
            first_started.set()
            let_first_finish.wait(timeout=5.0)
            return [{"content": "x", "category": "fact", "importance": "structural"}]

        mock_steps["extraction"].side_effect = slow_extraction

        def run_first():
            run_offline_pipeline("user_abc", "sess_inflight", "t_inflight", _make_thread_state())

        first_thread = threading.Thread(target=run_first)
        first_thread.start()
        assert first_started.wait(timeout=5.0), "First call should have entered extraction"

        # Second call while first is still in extraction
        second_result["r"] = run_offline_pipeline(
            "user_abc", "sess_inflight", "t_inflight", _make_thread_state(),
        )

        # Release the first call and let it complete
        let_first_finish.set()
        first_thread.join(timeout=5.0)

        assert second_result["r"]["status"] == "in_flight", (
            "Concurrent call on same session_id should return 'in_flight', "
            "not 'already_processed' (first hasn't promoted yet)"
        )

    def test_in_flight_releases_after_completion(self, mock_steps):
        """After a run completes, _in_flight_sessions should not retain the session_id.

        This is the post-condition that justifies the try/finally pattern in
        run_offline_pipeline. Without `finally`, an exception during steps
        would leave the session stuck in in_flight permanently.
        """
        from deerflow.sophia.offline_pipeline import (
            _in_flight_sessions,
            run_offline_pipeline,
        )

        run_offline_pipeline("user_abc", "sess_release_ok", "t1", _make_thread_state())
        assert "sess_release_ok" not in _in_flight_sessions

        # Even on a step failure path (extraction raises), in-flight should release
        mock_steps["extraction"].side_effect = RuntimeError("boom")
        run_offline_pipeline("user_abc", "sess_release_err", "t2", _make_thread_state())
        assert "sess_release_err" not in _in_flight_sessions
