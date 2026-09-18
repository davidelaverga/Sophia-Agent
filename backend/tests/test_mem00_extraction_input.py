"""Capture the actual SDK request; never call an external model or Mem0."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from mem00_owner_fixture import declare_memory_owners
from mem00_dispatch_fixture import dispatch_authority

from deerflow.sophia import extraction
from deerflow.sophia.memory_governance.extraction_input import capture_context, extraction_input_ref


@pytest.fixture
def boundary(monkeypatch, declare_memory_owners):
    declare_memory_owners({"owner": "governed"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "i" * 32)
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "owner")
    monkeypatch.setenv("SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE", "true")
    template = "{session_id}|{session_date}|{context_mode}|{artifacts}|{ritual_type}|{tone_start}|{tone_end}|{existing_memories}|{transcript}"
    monkeypatch.setattr(extraction, "_load_template", lambda: template)
    client = Mock()
    client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(text="[]")], stop_reason="end_turn")
    monkeypatch.setattr(extraction.anthropic, "Anthropic", lambda **kwargs: client)
    monkeypatch.setattr(extraction, "add_memories", Mock(side_effect=AssertionError("provider write")))
    context = capture_context(context_mode="life", session_date="2026-01-01")
    messages = [{"role": "user", "content": "SYNTHETIC-INPUT"}]
    ref = extraction_input_ref(owner_id="owner", session_id="session", messages=messages, context=context, model=extraction._PIPELINE_MODEL)
    return client, messages, {"session_date": context.session_date, "context_mode": context.context_mode, "extractor_input_ref": ref}, dispatch_authority("owner", "session", ref)


def test_actual_sdk_payload_uses_frozen_date_and_existing_model_contract(boundary):
    client, messages, metadata, authority = boundary
    assert extraction.extract_session_memories("owner", "session", messages, metadata, candidate_only=True, dispatch_authority=authority) == []
    request = client.messages.create.call_args.kwargs
    assert request == {"model": extraction._PIPELINE_MODEL, "max_tokens": 4096,
        "messages": [{"role": "user", "content": "session|2026-01-01|life|None|None|unknown|unknown|None|User: SYNTHETIC-INPUT"}]}
    assert metadata["extractor_input_ref"] not in str(request)


@pytest.mark.parametrize("fault", ["session_date", "context_mode", "artifacts", "existing_memories", "ritual_type", "tone_start", "tone_end", "session_id", "template", "model", "missing_proof", "transcript"])
def test_any_changed_actual_input_is_denied_before_sdk(boundary, monkeypatch, fault):
    client, messages, metadata, authority = boundary
    session_id = "session"
    if fault in {"session_date", "context_mode", "artifacts", "existing_memories", "ritual_type", "tone_start", "tone_end"}:
        metadata[fault] = "SYNTHETIC-CHANGED"
    elif fault == "session_id": session_id = "other-session"
    elif fault == "template": monkeypatch.setattr(extraction, "_load_template", lambda: "SYNTHETIC-CHANGED-TEMPLATE")
    elif fault == "model": monkeypatch.setattr(extraction, "_PIPELINE_MODEL", "synthetic-wrong-model")
    elif fault == "missing_proof": metadata.pop("extractor_input_ref")
    elif fault == "transcript": messages[0]["content"] = "SYNTHETIC-CHANGED"
    with pytest.raises(extraction.MemoryWriteError, match="extractor_input_unproven"):
        extraction.extract_session_memories("owner", session_id, messages, metadata, candidate_only=True, dispatch_authority=authority)
    client.messages.create.assert_not_called()
