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
    mocks["reconcile"].return_value = 0
    mocks["smart_opener"].return_value = "How are you feeling today?"
    mocks["identity"].return_value = False
    mocks["recap"].return_value = "ok"

    yield mocks

    for p in patchers:
        p.stop()


# ==================================================================
# Happy path
# ==================================================================


def test_dedicated_voice_lab_session_is_rejected_before_every_offline_consumer(
    monkeypatch,
    mock_steps,
):
    from deerflow.sophia import offline_pipeline as module

    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")
    record = MagicMock(
        run_id="run-001",
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "principal_id": "voice-lab-user-1",
                "test_run_id": "run-001",
            },
            "memory_retrieval_disabled": True,
            "offline_pipeline_disabled": True,
            "memory_learning_disabled": True,
            "ordinary_analytics_disabled": True,
            "ordinary_projects_disabled": True,
            "shared_spaces_disabled": True,
        },
    )
    store = MagicMock()
    store.get.return_value = record
    monkeypatch.setattr(module, "SessionStore", lambda: store)

    result = module.run_offline_pipeline(
        "voice-lab-user-1",
        "synthetic-session",
        "synthetic-thread",
        _make_thread_state(),
    )

    assert result["status"] == "synthetic_excluded"
    assert result["reason"] == "voice_lab_ordinary_consumers_excluded"
    assert result["test_run_id"] == "run-001"
    assert set(result["steps"].values()) == {"excluded"}
    for downstream in mock_steps.values():
        downstream.assert_not_called()


def test_dedicated_principal_missing_canonical_record_fails_closed(
    monkeypatch,
    mock_steps,
):
    from deerflow.sophia import offline_pipeline as module

    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")
    store = MagicMock()
    store.get.return_value = None
    monkeypatch.setattr(module, "SessionStore", lambda: store)

    result = module.run_offline_pipeline(
        "voice-lab-user-1",
        "missing-session",
        "synthetic-thread",
        _make_thread_state(),
    )

    assert result == {
        "status": "synthetic_excluded",
        "reason": "canonical_session_missing",
        "session_id": "missing-session",
    }
    for downstream in mock_steps.values():
        downstream.assert_not_called()


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
# Incremental durable transcript extraction
# ==================================================================


class TestIncrementalExtraction:
    def test_extracts_only_messages_after_processed_until_sequence(self, tmp_path, monkeypatch, mock_steps):
        from deerflow.sophia import offline_pipeline as module
        from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord, SessionStore

        store = SessionStore(tmp_path / "users")
        store.create(
            SessionRecord(
                session_id="sess_range",
                thread_id="thread_range",
                user_id="user_abc",
                status="ended",
                memory_processed_until_sequence=20,
            )
        )
        store.replace_messages(
            "user_abc",
            "sess_range",
            [
                SessionMessageRecord(
                    message_id=f"m-{sequence}",
                    session_id="sess_range",
                    thread_id="thread_range",
                    role="user" if sequence % 2 else "assistant",
                    content=f"message {sequence}",
                    sequence=sequence,
                )
                for sequence in range(1, 23)
            ],
        )
        monkeypatch.setattr(module, "SessionStore", lambda: store)

        result = module.run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_range",
            thread_id="thread_range",
            thread_state=_make_thread_state(),
        )

        assert result["status"] == "completed"
        extracted_messages = mock_steps["extraction"].call_args.args[2]
        metadata = mock_steps["extraction"].call_args.args[3]
        assert [message["content"] for message in extracted_messages] == ["message 21", "message 22"]
        assert metadata["sequence_start"] == 21
        assert metadata["sequence_end"] == 22
        assert metadata["source_message_ids"] == ["m-21", "m-22"]
        assert metadata["thread_id"] == "thread_range"
        assert metadata["extraction_run_id"].startswith("extract-")

        record = store.get("user_abc", "sess_range")
        assert record is not None
        assert record.memory_processed_until_sequence == 22
        assert record.memory_extraction_status == "completed"
        assert record.memory_extraction_range_start == 21
        assert record.memory_extraction_range_end == 22

    def test_no_new_messages_skips_extraction(self, tmp_path, monkeypatch, mock_steps):
        from deerflow.sophia import offline_pipeline as module
        from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord, SessionStore

        store = SessionStore(tmp_path / "users")
        store.create(
            SessionRecord(
                session_id="sess_done",
                thread_id="thread_done",
                user_id="user_abc",
                status="ended",
                memory_processed_until_sequence=2,
            )
        )
        store.replace_messages(
            "user_abc",
            "sess_done",
            [
                SessionMessageRecord(
                    message_id="m-1",
                    session_id="sess_done",
                    thread_id="thread_done",
                    role="user",
                    content="already handled",
                    sequence=1,
                ),
                SessionMessageRecord(
                    message_id="m-2",
                    session_id="sess_done",
                    thread_id="thread_done",
                    role="assistant",
                    content="already handled too",
                    sequence=2,
                ),
            ],
        )
        monkeypatch.setattr(module, "SessionStore", lambda: store)

        result = module.run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_done",
            thread_id="thread_done",
            thread_state=_make_thread_state(),
        )

        assert result["status"] == "no_new_messages"
        assert result["steps"]["extraction"] == "no_new_messages"
        mock_steps["extraction"].assert_not_called()

    def test_failed_extraction_does_not_advance_checkpoint(self, tmp_path, monkeypatch, mock_steps):
        from deerflow.sophia import offline_pipeline as module
        from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord, SessionStore

        store = SessionStore(tmp_path / "users")
        store.create(
            SessionRecord(
                session_id="sess_fail_checkpoint",
                thread_id="thread_fail_checkpoint",
                user_id="user_abc",
                status="ended",
                memory_processed_until_sequence=20,
            )
        )
        store.replace_messages(
            "user_abc",
            "sess_fail_checkpoint",
            [
                SessionMessageRecord(
                    message_id="m-21",
                    session_id="sess_fail_checkpoint",
                    thread_id="thread_fail_checkpoint",
                    role="user",
                    content="new segment only",
                    sequence=21,
                )
            ],
        )
        monkeypatch.setattr(module, "SessionStore", lambda: store)
        mock_steps["extraction"].side_effect = RuntimeError("mem0 unavailable")

        result = module.run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_fail_checkpoint",
            thread_id="thread_fail_checkpoint",
            thread_state=_make_thread_state(),
        )

        assert result["status"] == "completed"
        assert result["steps"]["extraction"] == "error"
        record = store.get("user_abc", "sess_fail_checkpoint")
        assert record is not None
        assert record.memory_processed_until_sequence == 20
        assert record.memory_extraction_status == "error"
        assert record.memory_extraction_range_start == 21
        assert record.memory_extraction_range_end == 21

    def test_resumed_range_explicit_remember_preference_creates_one_candidate(
        self,
        tmp_path,
        monkeypatch,
    ):
        from deerflow.sophia import offline_pipeline as module
        from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord, SessionStore

        store = SessionStore(tmp_path / "users")
        store.create(
            SessionRecord(
                session_id="sess_resumed_explicit",
                thread_id="thread_resumed_explicit",
                user_id="user_abc",
                status="ended",
                memory_processed_until_sequence=6,
                recap_processed_until_sequence=6,
            )
        )
        transcript = [
            ("m-1", "user", "old range preference is sparkling water", 1),
            ("m-2", "assistant", "Noted earlier.", 2),
            ("m-3", "user", "old range filler", 3),
            ("m-4", "assistant", "old range reply", 4),
            ("m-5", "user", "working project phrase is amber bridge", 5),
            ("m-6", "assistant", "The phrase is amber bridge.", 6),
            (
                "m-7",
                "user",
                "I want to continue this same conversation. What was the working project phrase?",
                7,
            ),
            ("m-8", "assistant", "The working project phrase is amber bridge.", 8),
            (
                "m-9",
                "user",
                "Please remember that my preferred evening tea is chamomile tea because it helps me wind down.",
                9,
            ),
            ("m-10", "assistant", "Got it - chamomile tea for your evening tea preference.", 10),
        ]
        store.replace_messages(
            "user_abc",
            "sess_resumed_explicit",
            [
                SessionMessageRecord(
                    message_id=message_id,
                    session_id="sess_resumed_explicit",
                    thread_id="thread_resumed_explicit",
                    role=role,
                    content=content,
                    sequence=sequence,
                )
                for message_id, role, content, sequence in transcript
            ],
        )
        monkeypatch.setattr(module, "SessionStore", lambda: store)

        response = MagicMock()
        content_block = MagicMock()
        content_block.text = "[]"
        response.content = [content_block]

        with patch("deerflow.sophia.extraction.anthropic") as mock_anthropic_mod, \
            patch("deerflow.sophia.extraction.add_memories") as mock_add_memories, \
            patch.object(module, "write_session_trace"), \
            patch.object(module, "reconcile_review_metadata_with_mem0", return_value=0), \
            patch.object(module, "generate_smart_opener", return_value="How are you feeling today?"), \
            patch.object(module, "generate_handoff"), \
            patch.object(module, "_write_offline_recap", return_value="ok"), \
            patch.object(module, "maybe_update_identity", return_value=False):
            mock_client = MagicMock()
            mock_anthropic_mod.Anthropic.return_value = mock_client
            mock_client.messages.create.return_value = response
            mock_add_memories.return_value = [{"id": "mem_tea"}]

            result = module.run_offline_pipeline(
                user_id="user_abc",
                session_id="sess_resumed_explicit",
                thread_id="thread_resumed_explicit",
                thread_state=_make_thread_state(),
            )
            second = module.run_offline_pipeline(
                user_id="user_abc",
                session_id="sess_resumed_explicit",
                thread_id="thread_resumed_explicit",
                thread_state=_make_thread_state(),
            )

        assert result["status"] == "completed"
        assert result["extraction_range"] == {
            "last_processed_sequence": 6,
            "current_max_sequence": 10,
            "sequence_start": 7,
            "sequence_end": 10,
        }
        prompt = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
        assert "I want to continue this same conversation" in prompt
        assert "preferred evening tea is chamomile tea" in prompt
        assert "old range preference is sparkling water" not in prompt
        mock_add_memories.assert_called_once()
        add_kwargs = mock_add_memories.call_args.kwargs
        assert add_kwargs["messages"][0]["content"] == (
            "User's preferred evening tea is chamomile tea because it helps them wind down."
        )
        metadata = add_kwargs["metadata"]
        assert metadata["sequence_start"] == 9
        assert metadata["sequence_end"] == 10
        assert metadata["source_message_ids"] == ["m-9", "m-10"]

        record = store.get("user_abc", "sess_resumed_explicit")
        assert record is not None
        assert record.memory_processed_until_sequence == 10
        assert record.recap_processed_until_sequence == 10
        assert record.memory_extraction_status == "completed"
        diagnostics = record.metadata["last_memory_extraction_diagnostics"]
        assert diagnostics["candidate_count"] == 1
        assert diagnostics["explicit_remember_count"] == 1
        assert diagnostics["explicit_remember_candidate_count"] == 1
        assert diagnostics["no_candidate_reason"] is None
        assert second["status"] == "no_new_messages"
        assert mock_add_memories.call_count == 1

    def test_zero_candidate_success_records_no_candidate_diagnostic(
        self,
        tmp_path,
        monkeypatch,
        mock_steps,
    ):
        from deerflow.sophia import offline_pipeline as module
        from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord, SessionStore

        store = SessionStore(tmp_path / "users")
        store.create(
            SessionRecord(
                session_id="sess_no_candidate",
                thread_id="thread_no_candidate",
                user_id="user_abc",
                status="ended",
                memory_processed_until_sequence=0,
            )
        )
        store.replace_messages(
            "user_abc",
            "sess_no_candidate",
            [
                SessionMessageRecord(
                    message_id="m-1",
                    session_id="sess_no_candidate",
                    thread_id="thread_no_candidate",
                    role="user",
                    content="Just checking in.",
                    sequence=1,
                ),
                SessionMessageRecord(
                    message_id="m-2",
                    session_id="sess_no_candidate",
                    thread_id="thread_no_candidate",
                    role="assistant",
                    content="I am here.",
                    sequence=2,
                ),
            ],
        )
        monkeypatch.setattr(module, "SessionStore", lambda: store)
        mock_steps["extraction"].return_value = []

        result = module.run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_no_candidate",
            thread_id="thread_no_candidate",
            thread_state=_make_thread_state(),
        )

        assert result["steps"]["extraction"] == "ok"
        record = store.get("user_abc", "sess_no_candidate")
        assert record is not None
        assert record.memory_processed_until_sequence == 2
        diagnostics = record.metadata["last_memory_extraction_diagnostics"]
        assert diagnostics["candidate_count"] == 0
        assert diagnostics["explicit_remember_count"] == 0
        assert diagnostics["no_candidate_reason"] == "no_candidate"

    def test_explicit_remember_rejection_records_safe_reason(
        self,
        tmp_path,
        monkeypatch,
        mock_steps,
    ):
        from deerflow.sophia import offline_pipeline as module
        from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord, SessionStore

        store = SessionStore(tmp_path / "users")
        store.create(
            SessionRecord(
                session_id="sess_reject_secret",
                thread_id="thread_reject_secret",
                user_id="user_abc",
                status="ended",
                memory_processed_until_sequence=0,
            )
        )
        store.replace_messages(
            "user_abc",
            "sess_reject_secret",
            [
                SessionMessageRecord(
                    message_id="m-1",
                    session_id="sess_reject_secret",
                    thread_id="thread_reject_secret",
                    role="user",
                    content="Please remember this temporary security token is red rabbit seven.",
                    sequence=1,
                ),
                SessionMessageRecord(
                    message_id="m-2",
                    session_id="sess_reject_secret",
                    thread_id="thread_reject_secret",
                    role="assistant",
                    content="I cannot store that.",
                    sequence=2,
                ),
            ],
        )
        monkeypatch.setattr(module, "SessionStore", lambda: store)
        mock_steps["extraction"].return_value = []

        result = module.run_offline_pipeline(
            user_id="user_abc",
            session_id="sess_reject_secret",
            thread_id="thread_reject_secret",
            thread_state=_make_thread_state(),
        )

        assert result["steps"]["extraction"] == "ok"
        record = store.get("user_abc", "sess_reject_secret")
        assert record is not None
        diagnostics = record.metadata["last_memory_extraction_diagnostics"]
        assert diagnostics["explicit_remember_count"] == 1
        assert diagnostics["explicit_remember_rejection_reasons"] == {"credential_like": 1}
        assert diagnostics["no_candidate_reason"] == "policy_filtered"
        assert "red rabbit" not in str(diagnostics)


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
