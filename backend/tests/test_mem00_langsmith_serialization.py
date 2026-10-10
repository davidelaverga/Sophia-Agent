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


def _rejected_ingest(status: int, body: str) -> Exception:
    """Shape a failure the way langsmith.Client.request_with_retries raises it."""

    import requests
    from langsmith import utils as ls_utils

    response = requests.Response()
    response.status_code = status
    response._content = body.encode()
    response.url = "https://eu.api.smith.langchain.com/runs?token=synthetic"
    try:
        try:
            response.raise_for_status()
        except requests.HTTPError as original:
            raise requests.HTTPError(str(original), body) from original
    except requests.HTTPError as wrapped:
        try:
            raise ls_utils.LangSmithError(f"Failed to POST /runs in LangSmith API. {wrapped!r}")
        except ls_utils.LangSmithError as error:
            return error
    raise AssertionError("unreachable")


_FAILURE_ENVELOPE = {
    "schema": "sophia.memory.event.v1",
    "event_name": "memory.retrieval.denied",
    "occurred_at": "2026-09-06T09:20:43.411927+00:00",
    "outcome": "denied",
    "owner_ref": "hmac-sha256:owner:synthetic",
}


def test_export_failure_reports_status_and_class_but_no_message(monkeypatch, caplog):
    import logging

    from deerflow.sophia.memory_governance import observability

    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com/api?token=synthetic")
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", "synthetic-workspace-uuid")
    observability.reset_counters_for_test()
    caplog.set_level(logging.WARNING)

    class RejectingClient:
        def create_run(self, **_payload):
            raise _rejected_ingest(403, '{"error":"Forbidden","detail":"SYNTHETIC PRIVATE BODY"}')

    class SlowClient:
        def create_run(self, **_payload):
            import requests

            raise requests.ReadTimeout("SYNTHETIC PRIVATE TIMEOUT DETAIL")

    assert _export_langsmith(_FAILURE_ENVELOPE, client=RejectingClient()) == "unavailable"
    assert _export_langsmith(_FAILURE_ENVELOPE, client=SlowClient()) == "unavailable"

    assert "error_class=LangSmithError http_status=403 error_code=None" in caplog.text
    assert "error_class=ReadTimeout http_status=None error_code=None" in caplog.text
    assert "endpoint_host=eu.api.smith.langchain.com workspace_header_present=True" in caplog.text
    assert "event_name=memory.retrieval.denied" in caplog.text
    assert "elapsed_ms=" in caplog.text
    for fragment in ("SYNTHETIC PRIVATE", "Forbidden", "token=synthetic", "synthetic-workspace-uuid", "/runs", "hmac-sha256"):
        assert fragment not in caplog.text
    snapshot = observability.runtime_metric_snapshot()
    assert snapshot["export_failures_by_http_status"] == {"403": 1, "none": 1}


def test_export_failure_logging_is_rate_limited(monkeypatch, caplog):
    import logging

    from deerflow.sophia.memory_governance import observability

    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")
    observability.reset_counters_for_test()
    caplog.set_level(logging.WARNING)

    class RejectingClient:
        def create_run(self, **_payload):
            raise _rejected_ingest(403, '{"error":"Forbidden"}')

    for _ in range(60):
        assert _export_langsmith(_FAILURE_ENVELOPE, client=RejectingClient()) == "unavailable"

    lines = [record.getMessage() for record in caplog.records if "memory_langsmith_export" in record.getMessage()]
    assert [line.rsplit("failure_count=", 1)[1] for line in lines] == ["1", "2", "3", "4", "5", "50"]
    assert observability.runtime_metric_snapshot()["export_failures_by_http_status"] == {"403": 60}
