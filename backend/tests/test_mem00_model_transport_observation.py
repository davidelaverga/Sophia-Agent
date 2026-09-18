"""Physical transport outcomes are distinct from SQL permits and model results."""
import asyncio
import json

import httpx
import pytest
from test_mem00_model_dispatch import PermitStore, attempt, recorded_model_context, request

from deerflow.sophia.memory_governance import observability
from deerflow.sophia.memory_governance.model_dispatch import FinalModelDispatchAuthority
from deerflow.sophia.memory_governance.model_transport import FinalModelAsyncTransport, FinalModelTransport
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable


@pytest.mark.parametrize("after_entry", [False, True])
def test_async_cancellation_has_honest_transport_scope(monkeypatch, after_entry):
    import threading

    from deerflow.sophia.memory_governance import model_observation

    context = recorded_model_context(monkeypatch)
    events = []
    monkeypatch.setattr(model_observation, "emit_memory_event", lambda name, **values: events.append(values))
    store, entered = PermitStore(), []
    release, started = threading.Event(), threading.Event()
    original = store.authorize_model_dispatch
    def delayed(**kwargs):
        started.set()
        assert release.wait(3)
        return original(**kwargs)
    if not after_entry:
        store.authorize_model_dispatch = delayed
    wire = request()
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store)
    async def exercise():
        network_started = asyncio.Event()
        async def network(req):
            entered.append(req)
            network_started.set()
            await asyncio.Event().wait()
        async with FinalModelAsyncTransport(delegate=httpx.MockTransport(network), authority_factory=lambda _: authority) as transport:
            task = asyncio.create_task(transport.handle_async_request(wire))
            try:
                if after_entry:
                    await asyncio.wait_for(network_started.wait(), 3)
                else:
                    assert await asyncio.to_thread(started.wait, 3)
                task.cancel()
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
    asyncio.run(exercise())
    assert len(events) == 1
    assert events[0]["outcome"] == ("cancelled_after_transport" if after_entry else "cancelled_before_transport")
    assert events[0]["transport_entered"] is bool(entered) is after_entry
    assert events[0]["authorization_receipt_validated"] is True
    assert events[0]["provider_effect"] == "unknown" and events[0]["http_status"] is None


@pytest.mark.parametrize("denied", [False, True])
def test_observer_failure_neither_retries_nor_changes_product_outcome(monkeypatch, denied, caplog):
    from deerflow.sophia.memory_governance import model_observation

    context = recorded_model_context(monkeypatch)
    def unavailable(*args, **kwargs):
        raise RuntimeError("SYNTHETIC PRIVATE OBSERVABILITY ERROR")
    monkeypatch.setattr(model_observation, "emit_memory_event", unavailable)
    gaps_before = observability.runtime_metric_snapshot().get("evidence_gap_count", 0)
    store, sent = PermitStore(), []
    if denied:
        store.failure = RuntimeError("SYNTHETIC PRIVATE SQL ERROR")
    wire = request()
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store)
    expected = httpx.Response(200)
    with FinalModelTransport(delegate=httpx.MockTransport(lambda req: sent.append(req) or expected), authority_factory=lambda _: authority) as transport:
        if denied:
            with pytest.raises(MemoryGovernanceUnavailable):
                transport.handle_request(wire)
        else:
            assert transport.handle_request(wire) is expected
    assert len(store.calls) == 1 and len(sent) == (0 if denied else 1)
    assert "unavailable contentExcluded=true" in caplog.text
    assert "SYNTHETIC PRIVATE" not in caplog.text
    assert observability.runtime_metric_snapshot().get("evidence_gap_count", 0) == gaps_before + 1
    assert observability.langsmith_export_status() == "unavailable"


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("outcome", ["headers", "503", "network_error", "sql_denied"])
def test_final_transport_emits_joined_content_free_outcome(monkeypatch, asynchronous, outcome):
    context = recorded_model_context(monkeypatch)
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")
    monkeypatch.setenv("SOPHIA_MEMORY_FAULT_INJECTION", "false")
    exported = []
    class Client:
        def __init__(self, **kwargs):
            pass
        def create_run(self, **payload):
            exported.append(payload)
        def close(self, **kwargs):
            pass
    monkeypatch.setattr("langsmith.Client", Client)
    store, sent = PermitStore(), []
    if outcome == "sql_denied":
        store.failure = RuntimeError("SYNTHETIC PRIVATE DATABASE ERROR")
    wire = request()
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store)
    def network(req):
        sent.append(req)
        if outcome == "network_error":
            raise httpx.ConnectError("SYNTHETIC PRIVATE NETWORK ERROR", request=req)
        return httpx.Response(503 if outcome == "503" else 200)
    def sync():
        with FinalModelTransport(delegate=httpx.MockTransport(network), authority_factory=lambda _: authority) as transport:
            return transport.handle_request(wire)
    async def asynchronous_call():
        async with FinalModelAsyncTransport(delegate=httpx.MockTransport(network), authority_factory=lambda _: authority) as transport:
            return await transport.handle_async_request(wire)
    invoke = (lambda: asyncio.run(asynchronous_call())) if asynchronous else sync
    if outcome in {"sql_denied", "network_error"}:
        with pytest.raises(MemoryGovernanceUnavailable if outcome == "sql_denied" else httpx.ConnectError):
            invoke()
    else:
        assert invoke().status_code == (503 if outcome == "503" else 200)
    events = [item for item in exported if item["extra"]["metadata"]["event_name"] == "memory.model.transport"]
    assert len(events) == 1, "actual final transport has no outcome evidence"
    event = events[0]["extra"]["metadata"]
    assert event["observation_scope"] == "sdk_http_transport"
    assert event["transport_entered"] is bool(sent)
    assert event["provider_effect"] == "unknown"
    assert event["response_body_observed"] is False and event["model_result_observed"] is False
    assert event["attempt_ref"] == keyed_ref("model-attempt", authority.attempt.attempt_id)
    assert event["run_ref"] == keyed_ref("run", authority.attempt.run_id)
    assert event["context_ref"] == keyed_ref("context", authority.attempt.thread_id)
    assert event["prior_admission_ref"] == keyed_ref("prompt-admission", authority.attempt.prior_admission_id)
    assert event["payload_ref"] == authority.attempt.payload_ref
    assert event["session_refs"] == [keyed_ref("session", context["source"].session_id)]
    assert event["outcome"] == ("admission_denied" if outcome == "sql_denied" else "transport_effect_unknown" if outcome == "network_error" else "response_headers_received")
    assert event["http_status"] == (503 if outcome == "503" else 200 if outcome == "headers" else None)
    assert event["latency_ms"] >= 0
    serialized = json.dumps(events)
    for raw in ("SYNTHETIC USER", "SYNTHETIC PRIVATE", "synthetic-key", authority.attempt.run_id, context["thread"], context["source"].session_id):
        assert raw not in serialized
    assert observability.runtime_metric_snapshot()["events_by_name"]["memory.model.transport"] >= 1


def test_installed_trace_serializer_outage_and_new_attempt_recovery(monkeypatch, caplog):
    from langsmith import Client

    context = recorded_model_context(monkeypatch)
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "true")
    monkeypatch.setenv("SOPHIA_MEMORY_FAULT_INJECTION", "false")
    monkeypatch.delenv("LANGSMITH_RUNS_ENDPOINTS", raising=False)
    posted = []
    unavailable = True
    def capture(self, method, path, *, request_kwargs, **kwargs):
        assert method == "POST" and path.endswith("/runs")
        posted.append(json.loads(request_kwargs["data"]))
        if unavailable:
            raise RuntimeError("SYNTHETIC PRIVATE LANGSMITH ERROR")
    monkeypatch.setattr(Client, "request_with_retries", capture)
    clients = []
    def trace_factory(**kwargs):
        client = Client(**{**kwargs, "api_url": "https://trace.invalid", "api_key": "synthetic-only"})
        clients.append(client)
        return client
    monkeypatch.setattr("langsmith.Client", trace_factory)
    before = observability.runtime_metric_snapshot()
    store, sent = PermitStore(), []
    wire = request()
    try:
        with FinalModelTransport(delegate=httpx.MockTransport(lambda req: sent.append(req) or httpx.Response(200)),
                authority_factory=lambda req: FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, req), store=store)) as transport:
            assert transport.handle_request(wire).status_code == 200
            failed = observability.runtime_metric_snapshot()
            assert failed["evidence_gap_count"] == before["evidence_gap_count"] + 1
            assert failed["last_export_status"] == "unavailable" and len(store.calls) == len(sent) == 1
            unavailable = False
            assert transport.handle_request(wire).status_code == 200
            recovered = observability.runtime_metric_snapshot()
            assert recovered["evidence_gap_count"] == failed["evidence_gap_count"]
            assert recovered["last_export_status"] == "exported" and len(store.calls) == len(sent) == 2
        assert len(posted) == 2
        metadata = [payload["extra"]["metadata"] for payload in posted]
        assert metadata[0]["attempt_ref"] != metadata[1]["attempt_ref"]
        assert all(payload["inputs"] == {} and payload["extra"]["metadata"]["schema"] == "sophia.memory.event.v1" for payload in posted)
        assert "SYNTHETIC PRIVATE LANGSMITH ERROR" not in caplog.text
        assert "SYNTHETIC USER" not in json.dumps(posted)
        assert recovered["release_certified"] is False and recovered["coverage"] == "partial"
        assert len(clients) == 2
        assert all(client._manual_cleanup and client._atexit_handler is None for client in clients)
    finally:
        for client in clients:
            client.close()
