"""A failed extractor must never be published as durable successful empty."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from mem00_dispatch_fixture import dispatch_authority
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name

from deerflow.sophia import extraction


@pytest.fixture(autouse=True)
def extraction_boundary(monkeypatch, declare_memory_owners):  # noqa: F811 - pytest fixture request
    declare_memory_owners({'synthetic-owner': 'governed'})
    monkeypatch.setenv('SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE', 'true')
    monkeypatch.setenv('SOPHIA_MEMORY_COHORT_PRINCIPALS', 'synthetic-owner')
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "r" * 32)
    client = Mock()
    monkeypatch.setattr(extraction.anthropic, "Anthropic", lambda **kwargs: client)
    monkeypatch.setattr(extraction, "_load_template", lambda: "Extract JSON: {transcript}")
    import sys
    # Capture the complete original work items before execution-time faults.
    prepared = {explicit: _prepare_input(explicit) for explicit in (False, True)}
    monkeypatch.setattr(sys.modules[__name__], '_prepare_input', lambda explicit: prepared[explicit])
    writes = Mock(side_effect=AssertionError("candidate extraction cannot write Mem0"))
    monkeypatch.setattr(extraction, "add_memories", writes)
    return client, writes


def _prepare_input(explicit):
    from deerflow.sophia.memory_governance.extraction_input import capture_context, extraction_input_ref
    messages = [{"role": "user", "content": "Please remember that my favorite tea is chamomile." if explicit else "I prefer quiet puzzle games."}]
    context = capture_context(context_mode='life', session_date='2026-09-14')
    input_ref = extraction_input_ref(owner_id='synthetic-owner', session_id='synthetic-session', messages=messages,
        context=context, model=extraction._PIPELINE_MODEL)
    return messages, {'session_date': context.session_date, 'context_mode': context.context_mode, 'extractor_input_ref': input_ref}, dispatch_authority('synthetic-owner', 'synthetic-session', input_ref)


def _extract(*, explicit=False):
    messages, metadata, authority = _prepare_input(explicit)
    return extraction.extract_session_memories(
        "synthetic-owner", "synthetic-session",
        messages, metadata, candidate_only=True, dispatch_authority=authority,
    )


@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.parametrize("failure", ["api", "template", "malformed", "non_list", "truncated", "invalid_entry", "partial_batch"])
def test_candidate_only_failure_is_not_empty_or_deterministic_partial(extraction_boundary, monkeypatch, caplog, explicit, failure):
    client, writes = extraction_boundary
    response = SimpleNamespace(content=[SimpleNamespace(text="[]")], stop_reason="end_turn")
    client.messages.create.return_value = response
    if failure == "api":
        client.messages.create.side_effect = RuntimeError("synthetic-provider-body-must-not-leak")
    elif failure == "template":
        monkeypatch.setattr(extraction, "_load_template", Mock(side_effect=FileNotFoundError("synthetic-template")))
    elif failure == "truncated":
        response.stop_reason = "max_tokens"
    else:
        response.content[0].text = {
            "malformed": "synthetic-response-must-not-leak {",
            "non_list": '{"content": "wrong envelope"}',
            "invalid_entry": '[{"content": 123}]',
            "partial_batch": '[{"content": "valid candidate"}, null]',
        }[failure]
    with pytest.raises(extraction.MemoryWriteError):
        _extract(explicit=explicit)
    writes.assert_not_called()
    assert "synthetic-provider-body-must-not-leak" not in caplog.text
    assert "synthetic-response-must-not-leak" not in caplog.text
    assert not any(record.exc_info for record in caplog.records)


@pytest.mark.parametrize("response_text", ["[]", "```json\n[]\n```"])
def test_complete_valid_empty_remains_empty(extraction_boundary, response_text):
    client, writes = extraction_boundary
    client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(text=response_text)], stop_reason="end_turn")
    assert _extract() == []
    writes.assert_not_called()


@pytest.mark.parametrize("response_text", ['[{"content":"durable preference","confidence":0.8,"importance":0.7}]', "[]"])
def test_valid_batch_can_merge_explicit_candidates(extraction_boundary, response_text):
    client, writes = extraction_boundary
    client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(text=response_text)], stop_reason="end_turn")
    assert _extract(explicit=True)
    writes.assert_not_called()


def test_single_complete_json_fence_ignores_non_candidate_commentary(extraction_boundary):
    client, writes = extraction_boundary
    client.messages.create.return_value = SimpleNamespace(
        content=[SimpleNamespace(text='```json\n[{"content":"quiet puzzle preference"}]\n```\nExplanation: one durable observation.\nNever treat this commentary as a candidate.')],
        stop_reason="end_turn",
    )
    result = _extract()
    assert result == [{"content": "quiet puzzle preference"}]
    writes.assert_not_called()


@pytest.mark.parametrize("text", [
    '```json\n[{"content":"unfinished fence"}]',
    '```json\n[]\n```\n```json\n[{"content":"ambiguous second batch"}]\n```',
    '```yaml\n[]\n```',
    '```json\n[{"content":"truncated batch"}\n```\nExplanation.',
])
def test_ambiguous_or_incomplete_fence_never_completes(extraction_boundary, text):
    client, writes = extraction_boundary
    client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(text=text)], stop_reason="end_turn")
    with pytest.raises(extraction.MemoryWriteError):
        _extract()
    writes.assert_not_called()
