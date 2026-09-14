from __future__ import annotations

import asyncio
import copy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.gateway import voice_lab_process_termination as process
from app.gateway.routers import voice_lab_recovery
from deerflow.sophia import cleanup_fence
from deerflow.sophia.cleanup_fence import close_cleanup_provider_session as atomic_close
from test_voice_lab_recovery import _claims, _headers, recovery_env  # noqa: F401 - shared auth fixture


def receipt_for(claims, **updates):
    core = {
        "schema": "sophia_voice_lab_browser_process_termination_v1",
        **{key: "a" * 64 for key in process._HASH_FIELDS - {"receipt_sha256"}},
        "test_run_id_sha256": process._text_digest(claims.test_run_id),
        "cleanup_obligation_id_sha256": process._text_digest(claims.cleanup_obligation_id),
        "provider_session_id_sha256": process._text_digest("provider-test"),
        "provider_connection_epoch": 2,
        "browser_lease_epoch": 7,
        "process_acquired_seq": 1,
        "runtime_acquired_seq": 2,
        "process_closed_seq": 5,
        "process_closed_at": "2026-01-01T00:01:00.000Z",
        **{key: True for key in process._BOOL_FIELDS},
    }
    core.update(updates)
    return {**core, "receipt_sha256": process._digest(core)}


@pytest.fixture
def bound(monkeypatch):
    claims = _claims(provider_expires_at="2026-01-01T00:30:00.000Z")
    created = datetime(2026, 1, 1, tzinfo=UTC)
    synthetic = {
        "synthetic": True, "principal_id": claims.principal_id,
        "test_run_id": claims.test_run_id, "environment": claims.environment,
        "scenario_id": claims.scenario_id, "scenario_version": claims.scenario_version,
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "provider_expires_at": claims.provider_expires_at,
        "retention_hours": 24, "retention_anchor": "session_created_at_provisional",
        "retention_expires_at": (created + timedelta(hours=24)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "voice_runtime_session_id": "provider-test",
        "voice_provider_resource_state": "active",
        "voice_provider_connection_epoch": 2,
        "voice_provider_pending_connection_epoch": None,
        "voice_provider_resource_expires_at": claims.provider_expires_at,
        "voice_provider_activated_at": "2026-01-01T00:00:01.000Z",
        "voice_provider_activation_receipt": {"exact": "activation"},
        "cleanup_provider_admission_id": "provider-admission",
    }
    record = SimpleNamespace(user_id=claims.principal_id, run_id=claims.test_run_id,
        session_id="session-test", created_at=created.isoformat(), status="active",
        metadata={"synthetic_voice_lab": synthetic, "expected_deployment": claims.expected_deployment,
            **{key: True for key in ("memory_retrieval_disabled", "inactivity_finalization_disabled",
                "offline_pipeline_disabled", "memory_learning_disabled", "ordinary_analytics_disabled",
                "ordinary_projects_disabled", "shared_spaces_disabled")}})
    admission = SimpleNamespace(resource_kind="provider", resource_id="provider-test",
        admission_id="provider-admission", status="browser_active")
    monkeypatch.setattr(cleanup_fence, "cleanup_admissions", lambda _: [admission])
    commit = Mock()
    monkeypatch.setattr(cleanup_fence, "close_cleanup_provider_session", commit)
    return claims, record, admission, commit


def test_process_receipt_commits_only_browser_terminal_basis(bound):
    claims, record, _, commit = bound
    receipt = receipt_for(claims)
    digest = process.accept_browser_process_termination(claims, record, receipt)
    kwargs = commit.call_args.kwargs
    assert kwargs["terminal_status"] == "browser_closed"
    assert kwargs["expected_activated_epoch"] == 2
    assert kwargs["expected_pending_epoch"] is None
    assert kwargs["expected_activation_receipt"] == {"exact": "activation"}
    assert kwargs["provider_expires_at"] == claims.provider_expires_at
    metadata = kwargs["metadata"]["synthetic_voice_lab"]
    assert metadata["voice_provider_browser_close_receipts"] == [receipt]
    assert metadata["voice_provider_activation_abort_receipts"] == []
    assert process.browser_process_receipt(metadata) == receipt
    assert process.stored_browser_process_settlement(metadata) == digest
    projected = SimpleNamespace(metadata=kwargs["metadata"])
    assert voice_lab_recovery._provider_terminal_settlement_sha256(projected, voice_module=None) == digest
    # No provider-owner consumption, canonical end or live-resource-zero claim.
    assert "live_cleanup_completed_at" not in metadata
    assert record.status == "active"


@pytest.mark.parametrize("fault", ["epoch", "provider", "test", "cleanup", "pending",
    "future", "before-activation", "admission", "d02", "ordinary"])
def test_process_receipt_rejects_binding_drift_without_commit(bound, fault):
    claims, record, admission, commit = bound
    receipt = receipt_for(claims)
    synthetic = record.metadata["synthetic_voice_lab"]
    if fault in {"epoch", "provider", "test", "cleanup"}:
        field = {"epoch": "provider_connection_epoch", "provider": "provider_session_id_sha256",
            "test": "test_run_id_sha256", "cleanup": "cleanup_obligation_id_sha256"}[fault]
        receipt = receipt_for(claims, **{field: 3 if fault == "epoch" else "b" * 64})
    if fault == "pending": synthetic["voice_provider_pending_connection_epoch"] = 3
    if fault == "future": receipt = receipt_for(claims, process_closed_at="2099-01-01T00:00:00.000Z")
    if fault == "before-activation": receipt = receipt_for(claims, process_closed_at="2025-01-01T00:00:00.000Z")
    if fault == "admission": admission.status = "consumed"
    if fault == "d02": claims = _claims(scenario_id="V-D02")
    if fault == "ordinary": record.metadata = {}
    from fastapi import HTTPException
    with pytest.raises((ValueError, HTTPException)):
        process.accept_browser_process_termination(claims, record, receipt)
    commit.assert_not_called()


def test_exact_replay_requires_durable_settlement(bound, monkeypatch):
    claims, record, _, commit = bound
    receipt = receipt_for(claims)
    digest = process.accept_browser_process_termination(claims, record, receipt)
    record.metadata = copy.deepcopy(commit.call_args.kwargs["metadata"])
    commit.reset_mock()
    monkeypatch.setattr(cleanup_fence, "verify_cleanup_provider_settlement_replay", lambda *_: False)
    with pytest.raises(ValueError):
        process.accept_browser_process_termination(claims, record, receipt)
    monkeypatch.setattr(cleanup_fence, "verify_cleanup_provider_settlement_replay", lambda *_: True)
    assert process.accept_browser_process_termination(claims, record, receipt) == digest
    commit.assert_not_called()


def test_mixed_terminal_receipt_union_cannot_fall_back_to_websocket_proof(bound):
    claims, record, _, commit = bound
    process.accept_browser_process_termination(claims, record, receipt_for(claims))
    record.metadata = copy.deepcopy(commit.call_args.kwargs["metadata"])
    record.metadata["synthetic_voice_lab"]["voice_provider_browser_close_receipts"].append({"schema": "not-a-process-receipt"})
    assert process.browser_process_receipt(record.metadata["synthetic_voice_lab"]) == {}
    assert voice_lab_recovery._provider_terminal_settlement_sha256(record, voice_module=None) is None


def test_canonical_zero_waits_for_independent_provider_owner_consumption(bound, monkeypatch):
    claims, record, admission, commit = bound
    process.accept_browser_process_termination(claims, record, receipt_for(claims))
    record.metadata = copy.deepcopy(commit.call_args.kwargs["metadata"])
    admission.status = "browser_closed"
    monkeypatch.setattr(cleanup_fence, "verify_cleanup_provider_settlement_replay", lambda *_: True)
    result = voice_lab_recovery._provider_terminal_readback(claims, record, voice_module=None)
    assert result["status"] == "pending"
    assert result.get("provider_disconnected") is not True
    monkeypatch.setattr(cleanup_fence, "cleanup_admissions", lambda _: [])
    result = voice_lab_recovery._provider_terminal_readback(claims, record, voice_module=None)
    assert result["status"] == "already_terminal"
    assert result["provider_admissions_remaining"] == 0
    monkeypatch.setattr(cleanup_fence, "verify_cleanup_provider_settlement_replay", lambda *_: False)
    assert voice_lab_recovery._provider_terminal_readback(claims, record, voice_module=None)["status"] == "pending"


def test_reconciliation_does_not_self_consume_process_death_admission(bound, monkeypatch):
    from app.gateway.routers import voice
    claims, record, admission, commit = bound
    process.accept_browser_process_termination(claims, record, receipt_for(claims))
    record.metadata = copy.deepcopy(commit.call_args.kwargs["metadata"])
    admission.status = "browser_closed"
    admission.expired = True
    consume = Mock(side_effect=AssertionError("only the independent owner can consume"))
    disconnect = AsyncMock()
    monkeypatch.setattr(cleanup_fence, "complete_cleanup_admission", consume)
    monkeypatch.setattr(voice, "_disconnect_gemini_production_session", disconnect)
    monkeypatch.setattr(voice_lab_recovery, "sign_retention_reaper_runtime_capability", lambda *_args, **_kwargs: "test-only-capability")
    result = asyncio.run(voice_lab_recovery._reconcile_overdue_cleanup_admissions(claims, record))
    assert result["status"] == "pending"
    assert result["code"] == "cleanup_admission_provider_owner_ack_pending"
    disconnect.assert_awaited_once()
    consume.assert_not_called()


@pytest.mark.parametrize("state,persist_ok", [("open", True), ("closed", False), ("closed", True)])
def test_atomic_fence_requires_prior_close_and_rolls_back_failed_persistence(bound, monkeypatch, state, persist_ok):
    claims, record, _, commit = bound
    process.accept_browser_process_termination(claims, record, receipt_for(claims))
    kwargs = dict(commit.call_args.kwargs)
    monkeypatch.setattr(cleanup_fence, "_connect", lambda: None)
    cleanup_fence._reset_local_cleanup_fences_for_tests()
    cleanup_fence._seed_local_cleanup_obligation_for_tests(claims.cleanup_obligation_id,
        kwargs["retention_expires_at"], claims.provider_expires_at, state=state)
    admission = cleanup_fence.CleanupAdmission(admission_id="provider-admission",
        cleanup_obligation_id=claims.cleanup_obligation_id, resource_kind="provider", resource_id="provider-test",
        lease_expires_at=datetime(2026, 1, 1, tzinfo=UTC),
        resource_expires_at=datetime(2026, 1, 1, 0, 30, tzinfo=UTC), status="browser_active")
    cleanup_fence._LOCAL_ADMISSIONS[admission.admission_id] = admission
    persist = Mock(return_value=persist_ok)
    kwargs["local_persist"] = persist
    try:
        if state == "open" or not persist_ok:
            with pytest.raises(cleanup_fence.CleanupFenceError):
                atomic_close(admission, **kwargs)
            assert cleanup_fence._LOCAL_ADMISSIONS[admission.admission_id].status == "browser_active"
            assert cleanup_fence._LOCAL_OBLIGATIONS[claims.cleanup_obligation_id].get("provider_settlement_sha256") is None
            if state == "open": persist.assert_not_called()
        else:
            closed = atomic_close(admission, **kwargs)
            assert closed.status == "browser_closed"
            assert persist.call_args.args[1]["voice_provider_browser_close_receipts"] == [receipt_for(claims)]
            assert cleanup_fence._LOCAL_OBLIGATIONS[claims.cleanup_obligation_id]["live_cleanup_completed_at"] is None
    finally:
        cleanup_fence._reset_local_cleanup_fences_for_tests()


@pytest.mark.parametrize("updates", [{"unknown": True}, {"process_closed_seq": True},
    {"process_closed_seq": 1}, {"browser_registry_absent": False},
    {"process_closed_at": "2026-01-01T00:01:00Z"}, {"run_id_sha256": "invalid"}])
def test_strict_parser_rejects_even_rehashed_invalid_receipts(updates):
    with pytest.raises((ValueError, TypeError)):
        process.parse_browser_process_termination(receipt_for(_claims(), **updates))


@pytest.mark.parametrize("fault,expected", [("missing-internal", 401), ("missing-capability", 401),
    ("malformed", 400), ("oversized", 413), ("valid", 202)])
def test_private_route_auth_bounds_and_no_provider_zero(monkeypatch, recovery_env, fault, expected):
    import json
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.gateway.voice_lab_capability import VOICE_LAB_CAPABILITY_HEADER, VOICE_LAB_RECOVERY_INTERNAL_AUTH_HEADER

    lookup = Mock(return_value=({"status": "found"}, object()))
    commit = Mock(return_value="c" * 64)
    monkeypatch.setattr(voice_lab_recovery, "_lookup_canonical_session", lookup)
    monkeypatch.setattr(process, "accept_browser_process_termination", commit)
    app = FastAPI()
    app.include_router(voice_lab_recovery.router)
    receipt = receipt_for(_claims())
    headers = _headers()
    body = json.dumps(receipt)
    if fault == "missing-internal": headers.pop(VOICE_LAB_RECOVERY_INTERNAL_AUTH_HEADER)
    if fault == "missing-capability": headers.pop(VOICE_LAB_CAPABILITY_HEADER)
    if fault == "malformed": body = "{}"
    if fault == "oversized": body = " " * 8193
    response = TestClient(app).post("/internal/voice-lab/runs/run-001/browser-process-closed", content=body, headers=headers)
    assert response.status_code == expected, response.text
    if fault != "valid":
        lookup.assert_not_called()
        commit.assert_not_called()
    else:
        assert response.json() == {"accepted": True, "receipt_sha256": receipt["receipt_sha256"],
            "provider_settlement_sha256": "c" * 64, "provider_cleanup_proven": False}
        assert response.headers["cache-control"] == "no-store"


def test_private_route_rejects_d02_before_body_or_lookup(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setattr(voice_lab_recovery, "capability_for_voice_lab_recovery", lambda *_: _claims(scenario_id="V-D02"))
    lookup = Mock()
    monkeypatch.setattr(voice_lab_recovery, "_lookup_canonical_session", lookup)
    app = FastAPI()
    app.include_router(voice_lab_recovery.router)
    response = TestClient(app).post("/internal/voice-lab/runs/run-001/browser-process-closed", content="bad")
    assert response.status_code == 403
    lookup.assert_not_called()


def test_complete_gateway_stack_reaches_dual_authenticated_process_handler(monkeypatch, recovery_env):
    from fastapi.testclient import TestClient
    from app.gateway.app import create_app
    lookup = Mock(return_value=({"status": "found"}, object()))
    commit = Mock(return_value="c" * 64)
    monkeypatch.setattr(voice_lab_recovery, "_lookup_canonical_session", lookup)
    monkeypatch.setattr(process, "accept_browser_process_termination", commit)
    response = TestClient(create_app()).post("/internal/voice-lab/runs/run-001/browser-process-closed",
        json=receipt_for(_claims()), headers=_headers())
    assert response.status_code == 202, response.text
    assert response.json()["provider_cleanup_proven"] is False
    commit.assert_called_once()
