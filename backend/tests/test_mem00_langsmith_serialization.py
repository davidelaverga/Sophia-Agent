"""Hosted P01 evidence must survive the installed SDK's outbound serializer."""

import json

import pytest
from langsmith import Client

from deerflow.sophia.memory_governance.observability import _export_langsmith, build_memory_langsmith_run_payload


@pytest.fixture
def outbound(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.delenv("LANGSMITH_RUNS_ENDPOINTS", raising=False)
    calls = []

    def capture(self, method, path, *, request_kwargs, **kwargs):
        assert method == "POST" and path.endswith("/runs")
        calls.append(json.loads(request_kwargs["data"]))

    monkeypatch.setattr(Client, "request_with_retries", capture)
    client = Client(api_url="https://trace.invalid", api_key="synthetic-only", auto_batch_tracing=False)
    envelope = {
        "schema": "sophia.memory.event.v1",
        "event_name": "memory.retrieval.denied",
        "occurred_at": "2026-09-06T09:20:43.411927+00:00",
        "outcome": "denied",
        "owner_ref": "hmac-sha256:owner:synthetic",
        "session_ref": "hmac-sha256:session:synthetic",
        "query_ref": "hmac-sha256:query:synthetic",
        "safe_reason_code": "no_authorized_memories",
        "authorized_count": 0,
    }
    assert _export_langsmith(envelope, client=client) == "exported"
    assert len(calls) == 1
    return calls[0], envelope


def test_governance_join_references_use_sdk_metadata_location(outbound):
    payload, envelope = outbound
    assert "metadata" not in payload
    assert payload["extra"]["metadata"].items() >= envelope.items()
    assert payload["inputs"] == {}
    assert payload["outputs"] == {"outcome": "denied", "safe_reason_code": "no_authorized_memories"}


def test_structural_event_is_a_completed_point_span(outbound):
    payload, envelope = outbound
    assert payload["start_time"] == envelope["occurred_at"]
    assert payload["end_time"] == envelope["occurred_at"]


def test_denied_plaintext_never_reaches_sdk_transport(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")

    class RejectTransport:
        def create_run(self, **kwargs):
            pytest.fail("plaintext reached tracing transport")

    for field in ("query", "canonical_content", "transcript", "provider_memory_id", "api_key"):
        assert _export_langsmith({"event_name": "memory.test", "nested": {field: "synthetic-plaintext"}}, client=RejectTransport()) == "unavailable"


@pytest.mark.parametrize("occurred_at", [None, "not-a-timestamp", "2026-09-06T09:20:43", 123])
def test_missing_or_ambiguous_event_timestamp_is_not_certified(occurred_at):
    with pytest.raises(ValueError, match="memory_event_timestamp_invalid"):
        build_memory_langsmith_run_payload({"event_name": "memory.test", "occurred_at": occurred_at})
