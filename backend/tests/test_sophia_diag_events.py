"""Content-free launch-timeline diagnostics (``sophia_diag`` lines).

Each instrumented hop emits exactly one event, carries only join identifiers,
codes and numbers, and never changes the outcome it observes. Inputs use
sentinel strings so any leak of owner identity or content is detectable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from sophia_diag_fixture import BACKEND, CONTENT, DIAG_LOGGER, OWNER, SECRET_DETAIL, _assert_content_free, _events, _mock_store, _one, _uuid7
from sophia_diag_fixture import diag_logs as _diag_logs

from deerflow.sophia import diag

diag_logs = _diag_logs


def test_validator_rejects_denied_keys_free_text_and_unknown_keys(diag_logs):
    before = diag.diag_stats()["dropped_fields"]
    diag.diag_event(
        "builder.launch",
        phase="begin",
        thread_id=str(uuid4()).upper(),
        user_id=OWNER,
        session_id=str(uuid4()),
        content=CONTENT,
        query=CONTENT,
        outcome=CONTENT,
        reason="Has Spaces",
        route="voice\n",
        error_type="Mem0ContractError",
        tool_call_id="toolu_01AbCdEf",
        owner=OWNER,
        site="https://example.com/?q=1",
        by_site={"memory": {"n": 1}},
        exports={"disabled": {"n": 2, "ms": 3}},
        total_ms=12.345,
        check_ms=float("nan"),
        handoff_event_id=object(),
    )
    level, event = _one(diag_logs, "builder.launch")
    assert level == logging.INFO
    assert event["phase"] == "begin"
    assert event["thread_id"] == event["thread_id"].lower()
    assert event["error_type"] == "Mem0ContractError"
    assert event["tool_call_id"] == "toolu_01AbCdEf"
    assert event["exports"] == {"disabled": {"n": 2, "ms": 3}}
    assert event["total_ms"] == 12.3
    for dropped in ("user_id", "session_id", "content", "query", "outcome", "reason", "route", "owner", "site", "by_site", "check_ms", "handoff_event_id"):
        assert dropped not in event
    assert event["dropped_fields"] == 12
    assert diag.diag_stats()["dropped_fields"] - before == 12
    _assert_content_free(diag_logs, "https://example.com")


def test_diag_event_never_raises_and_skips_disabled_levels(diag_logs, monkeypatch):
    diag.diag_event("not a valid name!", outcome="ok")
    assert _events(diag_logs)[-1][1]["ev"] == "invalid_event"
    monkeypatch.setattr(diag.json, "dumps", lambda *a, **k: (_ for _ in ()).throw(RuntimeError(SECRET_DETAIL)))
    failed = diag.diag_stats()["failed"]
    diag.diag_event("builder.launch", phase="end")
    assert diag.diag_stats()["failed"] == failed + 1
    monkeypatch.undo()
    diag_logs.set_level(logging.INFO, logger=DIAG_LOGGER)
    diag.diag_event("memory_guard.check", _level=logging.DEBUG, op="check")
    assert _events(diag_logs, "memory_guard.check") == []
    _assert_content_free(diag_logs)


def test_safe_ref_never_raises_without_a_secret(monkeypatch):
    monkeypatch.delenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", raising=False)
    assert diag.safe_ref("owner", OWNER) is None
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    assert diag.safe_ref("owner", OWNER).startswith("hmac-sha256:owner:")


def test_run_timing_uses_factory_start_and_uuid7_creation():
    run_id = _uuid7()
    diag.mark_run_start(run_id)
    timing = diag.run_timing(run_id)
    assert 0 <= timing["since_run_start_ms"] < 5_000
    assert 0 <= timing["since_run_created_ms"] < 5_000
    assert diag.run_timing(str(uuid4())).keys() <= {"since_run_start_ms"}
    assert diag.run_timing("not-a-run") == {}


# ---------------------------------------------------------------------------
# Governance store and Mem0 adapter accumulation
# ---------------------------------------------------------------------------




def test_store_counters_aggregate_across_to_thread():
    store = _mock_store()

    async def main():
        run, token = diag.install_run_diag()
        try:
            await asyncio.to_thread(store.get_contract)
            await asyncio.gather(asyncio.to_thread(store.get_user_governance, OWNER), asyncio.to_thread(store.get_user_governance, OWNER))
            with pytest.raises(Exception):
                await asyncio.to_thread(store._request, "GET", "sophia_memory_unknown_table")
        finally:
            diag.reset_run_diag(token)
        # Outside the accumulator nothing is counted.
        await asyncio.to_thread(store.get_contract)
        return run.snapshot()

    snapshot = asyncio.run(main())
    assert snapshot["store_requests"] == 4
    assert snapshot["store_errors"] == 1
    assert snapshot["store_by_resource"]["sophia_memory_contract"]["n"] == 1
    assert snapshot["store_by_resource"]["sophia_memory_user_governance"]["n"] == 2
    assert snapshot["store_by_resource"]["sophia_memory_unknown_table"]["n"] == 1
    assert OWNER not in json.dumps(snapshot) and SECRET_DETAIL not in json.dumps(snapshot)


def test_mem0_adapter_reports_client_construction_and_search(monkeypatch):
    import sys

    from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ProjectionAdapter

    class FakeClient:
        def __init__(self, **kwargs):
            time.sleep(0.002)

        def search(self, **kwargs):
            return {"results": [{"id": "p1", "score": 0.5}]}

    monkeypatch.setitem(sys.modules, "mem0", SimpleNamespace(MemoryClient=FakeClient))
    monkeypatch.setenv("MEM0_API_KEY", "synthetic-key")
    monkeypatch.delenv("MEM0_BASE_URL", raising=False)
    run, token = diag.install_run_diag()
    try:
        adapter = Mem0ProjectionAdapter()
        hits = adapter.search_ids(query=CONTENT, provider_subject="subject", metadata_filter={}, limit=1)
        assert adapter.diag_last_client_ms >= 1
        adapter.search_ids(query=CONTENT, provider_subject="subject", metadata_filter={}, limit=1)
        assert adapter.diag_last_client_ms == 0
    finally:
        diag.reset_run_diag(token)
    assert [hit.provider_memory_id for hit in hits] == ["p1"]
    snapshot = run.snapshot()
    assert snapshot["mem0_client_new"] == 1 and snapshot["mem0_search_count"] == 2
    assert CONTENT not in json.dumps(snapshot)


# ---------------------------------------------------------------------------
# Retained admission timing segments
# ---------------------------------------------------------------------------


def test_retained_admission_records_extra_latency_segments_and_export_status(monkeypatch):
    from unittest.mock import Mock

    from deerflow.sophia.memory_governance.models import AuthorizedMemory
    from deerflow.sophia.memory_governance.refs import keyed_ref
    from deerflow.sophia.memory_governance.retained_admission import readmit_retained_context
    from deerflow.sophia.memory_governance.retained_context import MemoryInclusion, RetainedMemoryContext
    from deerflow.sophia.memory_governance.service import MemoryProviderContract

    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "false")
    memory = UUID(int=1)
    context = RetainedMemoryContext(keyed_ref("owner", OWNER), 3, (MemoryInclusion(memory, 2, 4),))
    store = Mock()
    store.get_contract.return_value = SimpleNamespace(schema_version="mem00.v1", mode="enforced", contract_epoch=1)
    store.get_user_governance.return_value = SimpleNamespace(user_id=OWNER, user_revocation_epoch=3, user_catalog_generation=6, provider_subject="ns")
    store.hydrate_inclusions.return_value = (AuthorizedMemory(memory_id=memory, content_revision=2, memory_governance_revision=4, canonical_content=CONTENT, category="fact", scope="global", score=None),)
    store.record_prompt_admission.return_value = UUID(int=9)
    adapter = Mock()
    adapter.search_ids.return_value = ()
    adapter.diag_last_client_ms = 7
    run, token = diag.install_run_diag()
    try:
        result = readmit_retained_context(
            store=store,
            adapter=adapter,
            provider=MemoryProviderContract("mem0", "production", "project"),
            service_name="test",
            owner_id=OWNER,
            context=context,
            scope="text",
            caller="runtime_context_boundary",
            query=CONTENT,
            latency_segments={"flags_ms": 3, "bogus": "x", "flag": 2, "bool_ms": True},
        )
    finally:
        diag.reset_run_diag(token)
    assert result.transition.action == "continue"
    segments = store.record_prompt_admission.call_args.args[0]["latency_segments"]
    assert set(segments) == {"flags_ms", "observe_ms", "clock_ms", "mem0_client_ms", "mem0_search_ms", "hydrate_ms", "contract_ms", "total_ms"}
    assert segments["flags_ms"] == 3 and segments["mem0_client_ms"] == 7
    assert all(isinstance(value, int) and not isinstance(value, bool) for value in segments.values())
    assert run.snapshot()["exports"] == {"disabled": {"n": 1, "ms": run.snapshot()["exports"]["disabled"]["ms"]}}


def _rpc_body(sql: str) -> str:
    match = re.search(
        r"CREATE OR REPLACE FUNCTION public\.sophia_memory_record_prompt_admission\((?P<body>.*?)\$function\$;",
        sql,
        re.S,
    )
    assert match, "record_prompt_admission RPC definition not found"
    return match.group("body")


def test_prompt_admission_rpc_stores_latency_segments_jsonb_without_key_checks():
    """Extra latency keys are safe: every deployed RPC version coalesces the JSONB as-is."""
    migrations = BACKEND / "migrations"
    definitions = [path for path in sorted(migrations.glob("*.sql")) if "sophia_memory_record_prompt_admission(" in path.read_text()]
    assert [path.name for path in definitions if "FUNCTION public.sophia_memory_record_prompt_admission" in path.read_text()]
    for path in definitions:
        text = path.read_text()
        if "FUNCTION public.sophia_memory_record_prompt_admission" not in text:
            continue
        body = _rpc_body(text)
        uses = re.findall(r"[^\n]*p_latency_segments[^\n]*", body)
        assert any("p_latency_segments JSONB" in line for line in uses)
        assert all("p_latency_segments JSONB" in line or "coalesce(p_latency_segments, '{}'::jsonb)" in line for line in uses), (path.name, uses)
        assert "jsonb_object_keys(p_latency_segments" not in body
        assert re.search(r"p_latency_segments\s*(\?|->|#>|@>)", body) is None
    for path in sorted(migrations.glob("*.sql")):
        assert re.search(r"latency_segments[^\n;]*CHECK", path.read_text(), re.I) is None


def test_store_passes_latency_segments_to_rpc_unchanged():
    requests = []
    store = _mock_store(requests)
    segments = {"flags_ms": 1, "observe_ms": 2, "mem0_client_ms": 3, "total_ms": 9}
    store.record_prompt_admission(
        {
            "retrieval_request_id": str(uuid4()),
            "user_id": OWNER,
            "caller": "c",
            "scope": "s",
            "query_ref": "q",
            "provider": "mem0",
            "environment": "e",
            "provider_project": "p",
            "provider_namespace": "n",
            "provider_status": "ok",
            "provider_hit_count": 0,
            "catalog_generation_checked": 1,
            "revocation_epoch_checked": 0,
            "authorized_manifest": [],
            "denial_counts": {},
            "outcome": "zero_memory",
            "safe_reason_code": None,
            "latency_segments": segments,
        }
    )
    assert json.loads(requests[0].content)["p_latency_segments"] == segments


# ---------------------------------------------------------------------------
# MemoryRunGuard per-run summary
# ---------------------------------------------------------------------------
