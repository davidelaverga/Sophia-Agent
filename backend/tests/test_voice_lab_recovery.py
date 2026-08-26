from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.gateway.routers import builder_events, voice_lab_recovery
from app.gateway.routers import sessions as sessions_router
from app.gateway.routers import sophia as sophia_router
from app.gateway.voice_lab_capability import (
    VOICE_LAB_CAPABILITY_HEADER,
    VOICE_LAB_RECOVERY_INTERNAL_AUTH_HEADER,
    VoiceLabClaims,
)
from deerflow.sophia.session_store import (
    SessionMessageRecord,
    SessionRecord,
    SessionStore,
    _build_postgres_finalization_receipt,
)
from deerflow.sophia.storage import supabase_artifact_store

BUILD = "41a9b127af780bbe9d88acf34566a6aaf443e6b0"
CAPABILITY_SECRET = "capability-secret-at-least-thirty-two-bytes"
RECOVERY_SECRET = "recovery-internal-secret-at-least-thirty-two-bytes"
AUTH_TOMBSTONE_SECRET = "auth-tombstone-secret-at-least-thirty-two-bytes"


@pytest.fixture(autouse=True)
def _opaque_builder_zero(monkeypatch: pytest.MonkeyPatch):
    """Recovery unit tests isolate Builder's independently tested zero plane."""

    from app.gateway.routers import voice_lab_d02_settlement
    from deerflow.sophia import cleanup_fence

    cleanup_fence._reset_local_cleanup_fences_for_tests()
    voice_lab_d02_settlement.reset_d02_local_state_for_tests()

    monkeypatch.setattr(
        voice_lab_recovery,
        "_cleanup_builder_obligation_sources_zero",
        lambda _cleanup_obligation_id, *, purge_artifacts: True,
    )
    yield
    cleanup_fence._reset_local_cleanup_fences_for_tests()
    voice_lab_d02_settlement.reset_d02_local_state_for_tests()


def _payload(**overrides: object) -> dict[str, object]:
    now = int(time.time())
    payload: dict[str, object] = {
        "v": 1,
        "iss": "sophia-voice-lab",
        "aud": "sophia-voice-lab-recovery",
        "sub": "voice-lab-user-1",
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-001",
        "scenario_id": "vt00-realtime-001",
        "scenario_version": "v1",
        "synthetic": True,
        "environment": "production",
        "retention_hours": 24,
        "cleanup_obligation_id": "123e4567-e89b-42d3-a456-426614174000",
        "provider_expires_at": "2033-05-18T04:03:20.000Z",
        "allowed_ops": ["session:recover"],
        "expected_deployment": {
            "frontend": BUILD,
            "backend": BUILD,
            "voice": BUILD,
        },
        "iat": now,
        "nbf": now,
        "exp": now + 120,
        "jti": "recovery-jti-001",
        "nonce": "recovery-nonce-001",
    }
    payload.update(overrides)
    return payload


def _sign(payload: dict[str, object]) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).rstrip(b"=")
    signature = hmac.new(CAPABILITY_SECRET.encode(), encoded, hashlib.sha256).digest()
    return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def _claims(**overrides: object) -> VoiceLabClaims:
    payload = _payload(**overrides)
    return VoiceLabClaims(
        principal_id=str(payload["principal_id"]),
        test_run_id=str(payload["test_run_id"]),
        scenario_id=str(payload["scenario_id"]),
        scenario_version=str(payload["scenario_version"]),
        environment=str(payload["environment"]),
        retention_hours=int(payload["retention_hours"]),
        cleanup_obligation_id=str(payload["cleanup_obligation_id"]),
        provider_expires_at=str(payload["provider_expires_at"]),
        allowed_ops=tuple(payload["allowed_ops"]),
        expected_deployment=dict(payload["expected_deployment"]),
        issued_at=int(payload["iat"]),
        not_before=int(payload["nbf"]),
        expires_at=int(payload["exp"]),
        jti=str(payload["jti"]),
        nonce=str(payload["nonce"]),
        raw=payload,
    )


class _FakeRecoveryObjectStore:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.create_metadata: dict[str, dict[str, object]] = {}
        self.deleted: list[str] = []

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(
            "SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET",
            RECOVERY_SECRET,
        )
        monkeypatch.setenv(
            "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID",
            "v1",
        )
        monkeypatch.setenv(
            "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
            json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
        )
        monkeypatch.setattr(supabase_artifact_store, "is_configured", lambda: True)
        monkeypatch.setattr(
            supabase_artifact_store,
            "create_artifact_object_if_absent",
            self.create,
        )
        monkeypatch.setattr(
            supabase_artifact_store,
            "download_artifact_object_bounded",
            self.download,
        )
        monkeypatch.setattr(
            supabase_artifact_store,
            "delete_artifact_object_if_present",
            self.delete,
        )
        monkeypatch.setattr(
            supabase_artifact_store,
            "list_artifact_object_paths_bounded",
            self.list,
        )
        class _ZeroCursor:
            rowcount = 1

            def __init__(self) -> None:
                self._row: tuple[object, ...] | None = None

            def execute(self, sql: object, params: object = None, **_kwargs: object) -> None:
                statement = str(sql)
                if "RETURNING state, retention_expires_at" in statement:
                    deadline = params[1] if isinstance(params, tuple) else datetime.now(UTC)
                    provider_deadline = (
                        params[2] if isinstance(params, tuple) and len(params) > 2
                        else deadline
                    )
                    self._row = ("closed", deadline, provider_deadline)
                elif "count(*) FILTER" in statement:
                    self._row = (0, 0)
                elif "observed.observed_at >= obligation.retention_expires_at" in statement:
                    deadline = (
                        params[1]
                        if isinstance(params, tuple) and len(params) > 1
                        else datetime.now(UTC)
                    )
                    self._row = (max(datetime.now(UTC), deadline), True)
                elif "SELECT clock_timestamp() >= retention_expires_at" in statement:
                    self._row = (True,)
                elif "RETURNING obligation.live_cleanup_completed_at" in statement:
                    self._row = (datetime.now(UTC),)
                else:
                    self._row = None
                return None

            def fetchone(self) -> tuple[object, ...] | None:
                row, self._row = self._row, None
                return row

        @contextmanager
        def _barrier(_cleanup_obligation_id: str):
            yield _ZeroCursor()

        monkeypatch.setattr(
            voice_lab_recovery,
            "_cleanup_obligation_database_barrier",
            _barrier,
        )

    def create(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str | None = None,
        **_kwargs: object,
    ) -> str:
        if object_path in self.objects:
            return "exists"
        self.objects[object_path] = (
            bytes(content),
            content_type or "application/octet-stream",
        )
        self.create_metadata[object_path] = {
            "content_type": content_type or "application/octet-stream",
        }
        return "created"

    def download(
        self,
        object_path: str,
        *,
        max_bytes: int,
        **_kwargs: object,
    ) -> tuple[bytes, str] | None:
        stored = self.objects.get(object_path)
        if stored is None:
            return None
        if len(stored[0]) > max_bytes:
            raise RuntimeError("bounded object read exceeded")
        return stored

    def delete(self, object_path: str, **_kwargs: object) -> str:
        self.deleted.append(object_path)
        return "deleted" if self.objects.pop(object_path, None) is not None else "missing"

    def list(
        self,
        prefix: str,
        *,
        max_objects: int,
        max_depth: int,
        **_kwargs: object,
    ) -> list[str]:
        root = f"{prefix.rstrip('/')}/"
        paths = sorted(path for path in self.objects if path.startswith(root))
        for path in paths:
            parent_depth = path.removeprefix(root).count("/")
            if parent_depth > max_depth:
                raise supabase_artifact_store.ArtifactObjectListLimitError(
                    "internal object listing exceeded max_depth"
                )
        if len(paths) > max_objects:
            raise supabase_artifact_store.ArtifactObjectListLimitError(
                "internal object listing exceeded max_objects"
            )
        return paths

    def put_json(self, object_path: str, value: dict[str, object]) -> None:
        self.objects[object_path] = (
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode(),
            "application/json",
        )


@pytest.fixture
def recovery_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", "true")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENVIRONMENT", "production")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_CAPABILITY_SECRET", CAPABILITY_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET", RECOVERY_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", "voice-internal-secret-at-least-thirty-two-bytes")
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "builder-events-secret-at-least-thirty-two-bytes")
    monkeypatch.setenv("RENDER_GIT_COMMIT", BUILD)


def _client(
    monkeypatch: pytest.MonkeyPatch,
    *,
    pending: bool = False,
    retention_pending: bool = False,
) -> tuple[TestClient, dict[str, Mock]]:
    stable_recovery_id = voice_lab_recovery._recovery_id(_claims())
    _intent_path, tombstone_path = (
        voice_lab_recovery._recovery_purge_object_paths_for_id(stable_recovery_id)
    )
    canonical = Mock(return_value=({"status": "completed"}, object()))
    provider = AsyncMock(return_value={"status": "completed"})
    builder = AsyncMock(
        return_value={
            "status": "pending" if pending else "completed",
            "discovery_complete": not pending,
            "authoritative_zero_tasks": not pending,
            "discovered_task_count": 0,
            "cleanup_complete": not pending,
            "receipt": {},
        }
    )
    auth = Mock(return_value={"status": "completed", "sessions_revoked": 1})
    retention = Mock(return_value=(
        {
            "status": "retention_pending",
            "canonical_evidence_retained": True,
            "retention_purge_pending": True,
            "retention_expires_at": "2026-08-24T00:00:00+00:00",
        }
        if retention_pending
        else {
            "status": "completed",
            "canonical_evidence_purged": True,
            "retention_expires_at": "2026-08-24T00:00:00+00:00",
            "purge_tombstone_receipt": {
                "storage": "supabase",
                "object_path": tombstone_path,
                "sha256": "b" * 64,
                "schema": "sophia_voice_lab_recovery_purge_tombstone_v1",
                "raw_identity_excluded": True,
                "retention_policy": "approved_redacted_purge_tombstone",
            },
        }
    ))
    persist = Mock(
        side_effect=lambda payload: (
            payload,
            {
                "storage": "supabase",
                "object_path": "safe/recovery.json",
                "sha256": "a" * 64,
            },
        )
    )
    monkeypatch.setattr(voice_lab_recovery, "_recover_canonical_session", canonical)
    monkeypatch.setattr(
        voice_lab_recovery,
        "_close_live_cleanup_admission",
        Mock(
            return_value={
                "status": "completed",
                "admission_closed": True,
                "cleanup_admissions_pending": 0,
            }
        ),
    )
    monkeypatch.setattr(voice_lab_recovery, "_recover_voice_provider", provider)
    monkeypatch.setattr(voice_lab_recovery, "_recover_builder", builder)
    monkeypatch.setattr(voice_lab_recovery, "_recover_auth_sessions_sync", auth)
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_canonical_evidence_retention",
        retention,
    )
    monkeypatch.setattr(voice_lab_recovery, "_persist_recovery_receipt", persist)
    app = FastAPI()
    app.include_router(voice_lab_recovery.router)
    return TestClient(app), {
        "canonical": canonical,
        "provider": provider,
        "builder": builder,
        "auth": auth,
        "retention": retention,
        "persist": persist,
    }


def _headers(payload: dict[str, object] | None = None) -> dict[str, str]:
    return {
        VOICE_LAB_RECOVERY_INTERNAL_AUTH_HEADER: RECOVERY_SECRET,
        VOICE_LAB_CAPABILITY_HEADER: _sign(payload or _payload()),
    }


def test_recovery_rejects_internal_auth_before_any_component(
    monkeypatch: pytest.MonkeyPatch,
    recovery_env: None,
) -> None:
    client, components = _client(monkeypatch)
    response = client.post(
        "/internal/voice-lab/runs/run-001/recover",
        headers={VOICE_LAB_CAPABILITY_HEADER: _sign(_payload())},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_lab_recovery_internal_auth_required"}
    for component in components.values():
        component.assert_not_called()


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"aud": "sophia-voice-gateway"}, "voice_lab_capability_wrong_audience"),
        ({"allowed_ops": ["session:finalize"]}, "voice_lab_capability_operation_denied"),
        ({"expected_deployment": {"frontend": BUILD, "backend": "a" * 40, "voice": BUILD}}, "voice_lab_capability_deployment_mismatch"),
        ({"test_run_id": "run-other"}, "voice_lab_recovery_run_mismatch"),
    ],
)
def test_recovery_rejects_wrong_binding_before_components(
    monkeypatch: pytest.MonkeyPatch,
    recovery_env: None,
    overrides: dict[str, object],
    code: str,
) -> None:
    client, components = _client(monkeypatch)
    response = client.post(
        "/internal/voice-lab/runs/run-001/recover",
        headers=_headers(_payload(**overrides)),
    )
    assert response.status_code in {403, 409}
    assert response.json()["detail"] == {"code": code}
    for component in components.values():
        component.assert_not_called()


def test_recovery_is_kill_safe_and_separates_accepted_from_complete(
    monkeypatch: pytest.MonkeyPatch,
    recovery_env: None,
) -> None:
    contract = json.loads(
        (Path(__file__).resolve().parents[2] / "testdata" / "voice_lab_recovery_v1.json").read_text()
    )
    complete_client, _ = _client(monkeypatch)
    complete = complete_client.post(
        "/internal/voice-lab/runs/run-001/recover",
        headers=_headers(),
    )
    assert complete.status_code == contract["responses"]["complete"]["status_code"]
    assert complete.json()["ok"] is contract["responses"]["complete"]["ok"]
    assert complete.json()["complete"] is contract["responses"]["complete"]["complete"]
    assert complete.json()["live_cleanup_complete"] is True
    assert complete.json()["cleanup_obligation_id"] == _payload()["cleanup_obligation_id"]
    assert set(contract["required_response_keys"]) <= set(complete.json())
    assert set(contract["required_builder_component_keys"]) <= set(
        complete.json()["components"]["builder"]
    )

    pending_client, _ = _client(monkeypatch, pending=True)
    pending = pending_client.post(
        "/internal/voice-lab/runs/run-001/recover",
        headers=_headers(),
    )
    assert pending.status_code == contract["responses"]["pending"]["status_code"]
    assert pending.json()["ok"] is contract["responses"]["pending"]["ok"]
    assert pending.json()["complete"] is contract["responses"]["pending"]["complete"]
    assert pending.json()["components"]["builder"]["discovery_complete"] is False

    retained_client, _ = _client(monkeypatch, retention_pending=True)
    retained = retained_client.post(
        "/internal/voice-lab/runs/run-001/recover",
        headers=_headers(),
    )
    assert retained.status_code == 200
    assert retained.json()["complete"] is True
    assert retained.json()["live_cleanup_complete"] is True
    assert retained.json()["live_resources_zero"] is True
    assert retained.json()["retention_maintenance_complete"] is False
    assert retained.json()["retention_purge_pending"] is True
    assert retained.json()["retention_purged"] is False
    assert retained.json()["retention_purge_due_at"] == "2026-08-24T00:00:00+00:00"


def test_recovery_identity_is_stable_per_run_and_attempt_is_capability_bound() -> None:
    first = _claims(jti="attempt-one", nonce="nonce-one")
    same_attempt = _claims(jti="attempt-one", nonce="nonce-one")
    later_attempt = _claims(jti="attempt-two", nonce="nonce-two")
    assert voice_lab_recovery._recovery_id(first) == voice_lab_recovery._recovery_id(later_attempt)
    assert voice_lab_recovery._attempt_id(first) == voice_lab_recovery._attempt_id(same_attempt)
    assert voice_lab_recovery._attempt_id(first) != voice_lab_recovery._attempt_id(later_attempt)


def test_cleanup_admission_accepts_only_exact_post_retention_tombstone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia import cleanup_fence

    monkeypatch.setattr(
        cleanup_fence,
        "close_existing_cleanup_obligation",
        Mock(
            side_effect=cleanup_fence.CleanupFenceError(
                "cleanup deadline authority is unavailable"
            )
        ),
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_load_recovery_purge_tombstone",
        Mock(return_value=({"strict": "tombstone"}, {"storage": "supabase"})),
    )

    assert voice_lab_recovery._close_live_cleanup_admission(_claims(), None) == {
        "status": "already_terminal",
        "admission_closed": True,
        "cleanup_admissions_pending": 0,
        "cleanup_fence_tombstone_verified": True,
    }


def test_cleanup_admission_keeps_other_fence_errors_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia import cleanup_fence

    monkeypatch.setattr(
        cleanup_fence,
        "close_existing_cleanup_obligation",
        Mock(side_effect=cleanup_fence.CleanupFenceError("database unavailable")),
    )
    tombstone = Mock(return_value=({"strict": "tombstone"}, {}))
    monkeypatch.setattr(
        voice_lab_recovery,
        "_load_recovery_purge_tombstone",
        tombstone,
    )

    result = voice_lab_recovery._close_live_cleanup_admission(_claims(), None)

    assert result == {
        "status": "pending",
        "code": "cleanup_admission_fence_unavailable",
        "error_type": "CleanupFenceError",
    }
    tombstone.assert_not_called()


def test_retired_cleanup_fence_replays_authoritative_global_zero(
    monkeypatch: pytest.MonkeyPatch,
    recovery_env: None,
) -> None:
    client, components = _client(monkeypatch)
    monkeypatch.setattr(
        voice_lab_recovery,
        "_close_live_cleanup_admission",
        Mock(
            return_value={
                "status": "already_terminal",
                "admission_closed": True,
                "cleanup_admissions_pending": 0,
                "cleanup_fence_tombstone_verified": True,
            }
        ),
    )

    response = client.post(
        "/internal/voice-lab/runs/run-001/recover",
        headers=_headers(),
    )

    assert response.status_code == 200
    assert response.json()["complete"] is True
    assert response.json()["live_resources_zero"] is True
    assert response.json()["components"]["builder"] == {
        "status": "completed",
        "cleanup_complete": True,
        "discovery_complete": True,
        "authoritative_zero_tasks": True,
        "discovered_task_count": 0,
        "cleanup_fence_tombstone_verified": True,
    }
    for name in ("canonical", "provider", "builder", "auth"):
        components[name].assert_not_called()


@pytest.mark.anyio
async def test_provider_terminal_readback_is_a_noop_after_admission_consumption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.gateway.routers import voice as voice_router
    from deerflow.sophia import cleanup_fence

    provider_session_id = "provider-session-terminal"
    closed_at = "2033-05-18T04:00:00.000Z"
    close_receipt = voice_router.GeminiBrowserProviderCloseReceipt.model_validate(
        {
            "schema": "sophia_gemini_browser_provider_close_v1",
            "receipt_id": "10000000-0000-4000-8000-000000000001",
            "session_id": provider_session_id,
            "provider_connection_epoch": 1,
            "websocket_close_observed": True,
            "websocket_close_code": 1000,
            "websocket_closed_at": closed_at,
        }
    )
    canonical_close, canonical_abort, _settlement = (
        voice_router._canonical_browser_provider_settlement(
            provider_session_id,
            [close_receipt],
            [],
        )
    )
    noncanonical_record = SessionRecord(
        session_id="synthetic-session-noncanonical",
        thread_id="synthetic-thread-noncanonical",
        user_id="voice-lab-user-1",
        run_id="run-001",
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "voice_runtime_session_id": provider_session_id,
                "voice_provider_resource_state": "closed",
                "voice_provider_pending_connection_epoch": None,
                "voice_provider_closed_at": closed_at,
                "voice_provider_browser_close_receipts": [
                    {
                        **canonical_close[0],
                        "provider_connection_epoch": True,
                    }
                ],
                "voice_provider_activation_abort_receipts": canonical_abort,
            }
        },
    )
    assert (
        voice_lab_recovery._provider_terminal_settlement_sha256(
            noncanonical_record,
            voice_module=voice_router,
        )
        is None
    )
    record = SessionRecord(
        session_id="synthetic-session",
        thread_id="synthetic-thread",
        user_id="voice-lab-user-1",
        run_id="run-001",
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "voice_runtime_session_id": provider_session_id,
                "voice_provider_resource_state": "closed",
                "voice_provider_pending_connection_epoch": None,
                "voice_provider_closed_at": closed_at,
                "voice_provider_browser_close_receipts": canonical_close,
                "voice_provider_activation_abort_receipts": canonical_abort,
            }
        },
    )
    monkeypatch.setattr(voice_router, "_active_voice_sessions", {})
    disconnect = AsyncMock(side_effect=AssertionError("terminal replay must not disconnect"))
    monkeypatch.setattr(
        voice_router,
        "_disconnect_gemini_production_session",
        disconnect,
    )
    monkeypatch.setattr(cleanup_fence, "cleanup_admissions", lambda _cleanup_id: ())
    monkeypatch.setattr(
        cleanup_fence,
        "verify_cleanup_provider_settlement_replay",
        lambda _cleanup_id, _sha256: True,
    )

    result = await voice_lab_recovery._recover_voice_provider(
        _claims(),
        record,
        retention_reaper=True,
    )

    assert result["status"] == "already_terminal"
    assert result["provider_settlement_verified"] is True
    disconnect.assert_not_awaited()


def _canonical_evidence_record(
    *,
    created_at: datetime,
    retention_expires_at: datetime,
) -> SessionRecord:
    finalized_at = retention_expires_at - timedelta(hours=24)
    finalized_text = finalized_at.astimezone(UTC).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    retention_text = retention_expires_at.astimezone(UTC).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    provider_text = (created_at + timedelta(minutes=30)).astimezone(UTC).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    return SessionRecord(
        session_id="synthetic-session",
        thread_id="synthetic-thread",
        user_id="voice-lab-user-1",
        status="ended",
        ended_at=finalized_text,
        run_id="run-001",
        created_at=created_at.isoformat(),
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "principal_id": "voice-lab-user-1",
                "test_run_id": "run-001",
                "scenario_id": "vt00-realtime-001",
                "scenario_version": "v1",
                "environment": "production",
                "retention_hours": 24,
                "cleanup_obligation_id": "123e4567-e89b-42d3-a456-426614174000",
                "provider_expires_at": provider_text,
                "retention_anchor": "finalized_at",
                "finalized_at": finalized_text,
                "retention_expires_at": retention_text,
            },
            "expected_deployment": {
                "frontend": BUILD,
                "backend": BUILD,
                "voice": BUILD,
            },
            "memory_retrieval_disabled": True,
            "inactivity_finalization_disabled": True,
            "offline_pipeline_disabled": True,
            "memory_learning_disabled": True,
            "ordinary_analytics_disabled": True,
            "ordinary_projects_disabled": True,
            "shared_spaces_disabled": True,
        },
    )


def _claims_for_record(record: SessionRecord) -> VoiceLabClaims:
    return _claims(
        provider_expires_at=record.metadata["synthetic_voice_lab"][
            "provider_expires_at"
        ]
    )


def _message_metadata(record: SessionRecord) -> dict[str, object]:
    synthetic = record.metadata["synthetic_voice_lab"]
    return {
        "synthetic": True,
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-001",
        "scenario_id": "vt00-realtime-001",
        "scenario_version": "v1",
        "environment": "production",
        "retention_hours": 24,
        "cleanup_obligation_id": "123e4567-e89b-42d3-a456-426614174000",
        "provider_expires_at": synthetic["provider_expires_at"],
        "retention_anchor": "finalized_at",
        "finalized_at": synthetic["finalized_at"],
        "expected_deployment": record.metadata["expected_deployment"],
        "retention_expires_at": synthetic["retention_expires_at"],
        "memory_retrieval_excluded": True,
        "offline_pipeline_excluded": True,
        "memory_learning_excluded": True,
        "ordinary_analytics_excluded": True,
        "ordinary_projects_excluded": True,
        "shared_spaces_excluded": True,
        "redaction_level": "none",
    }


def _install_finalization_receipt(
    object_store: _FakeRecoveryObjectStore,
    record: SessionRecord,
    store: SessionStore,
    *,
    claims: VoiceLabClaims | None = None,
    legacy_object: bool = True,
) -> str:
    bound_claims = claims or _claims(
        provider_expires_at=record.metadata["synthetic_voice_lab"][
            "provider_expires_at"
        ]
    )
    messages = store.list_messages(bound_claims.principal_id, record.session_id)
    transcript = sophia_router._synthetic_transcript_evidence(
        record,
        messages,
        bound_claims,
    )
    synthetic = record.metadata["synthetic_voice_lab"]
    record.message_revision = max(1, int(record.message_revision))
    record.message_count = len(messages)
    record.transcript_available = bool(messages)
    finalization_receipt = _build_postgres_finalization_receipt(
        user_id=bound_claims.principal_id,
        session_id=record.session_id,
        thread_id=record.thread_id,
        expected_synthetic_binding=bound_claims.synthetic_context(),
        expected_deployment=dict(bound_claims.expected_deployment),
        finalized_at=str(synthetic["finalized_at"]),
        retention_hours=bound_claims.retention_hours,
        retention_expires_at=str(synthetic["retention_expires_at"]),
        provider_expires_at=bound_claims.provider_expires_at,
        message_revision=int(record.message_revision),
        message_count=len(messages),
        canonical_transcript_sha256=str(transcript["sha256"]),
        finalization_started_at=str(synthetic["finalized_at"]),
        turn_count=len(messages),
        capability_jti_sha256=hashlib.sha256(
            b"original-finalization-capability"
        ).hexdigest(),
    )
    synthetic["finalization_receipt"] = finalization_receipt
    from deerflow.sophia.cleanup_fence import (
        _seed_local_cleanup_obligation_for_tests,
    )

    _seed_local_cleanup_obligation_for_tests(
        bound_claims.cleanup_obligation_id,
        str(synthetic["retention_expires_at"]),
        bound_claims.provider_expires_at,
        state="closed",
        lifecycle_phase="finalized",
    )
    updated = store.update(
        bound_claims.principal_id,
        record.session_id,
        metadata=record.metadata,
        message_revision=record.message_revision,
        message_count=record.message_count,
        transcript_available=record.transcript_available,
    )
    assert updated is not None
    payload = {
        "schema": "sophia_voice_lab_finalization_v1",
        "status": "synthetic_isolated",
        "synthetic": True,
        "principal_id": bound_claims.principal_id,
        "test_run_id": bound_claims.test_run_id,
        "cleanup_obligation_id": bound_claims.cleanup_obligation_id,
        "scenario_id": bound_claims.scenario_id,
        "scenario_version": bound_claims.scenario_version,
        "environment": bound_claims.environment,
        "session_id": record.session_id,
        "thread_id": record.thread_id,
        "ended_at": transcript["finalized_at"],
        "expected_deployment": dict(bound_claims.expected_deployment),
        "finalized_at": transcript["finalized_at"],
        "retention_hours": transcript["retention_hours"],
        "retention_anchor": transcript["retention_anchor"],
        "retention_expires_at": transcript["retention_expires_at"],
        "provider_expires_at": transcript["provider_expires_at"],
        "canonical_transcript": transcript,
        "exclusions": dict(sophia_router._SYNTHETIC_FINALIZATION_EXCLUSIONS),
    }
    object_path = (
        ".builder/voice_lab_evidence/finalizations/v2/"
        f"{bound_claims.cleanup_obligation_id}.json"
    )
    if legacy_object:
        object_store.put_json(object_path, payload)
    return object_path


@pytest.mark.parametrize("expired", [False, True])
def test_recovery_retains_canonical_evidence_until_expiry_then_purges_exact_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    expired: bool,
) -> None:
    now = datetime.now(UTC)
    created_at = now - timedelta(hours=2) if expired else now
    retention = now - timedelta(hours=1) if expired else now + timedelta(hours=1)
    record = _canonical_evidence_record(
        created_at=created_at,
        retention_expires_at=retention,
    )
    store = SessionStore(tmp_path / "sessions")
    store.create(record)
    store.replace_messages_revisioned(
        "voice-lab-user-1",
        "synthetic-session",
        [
            SessionMessageRecord(
                message_id="message-1",
                session_id="synthetic-session",
                thread_id="synthetic-thread",
                role="user",
                content="synthetic fixture transcript",
                sequence=1,
                created_at=str(record.metadata["synthetic_voice_lab"]["finalized_at"]),
                metadata=_message_metadata(record),
            )
        ],
        expected_revision=0,
    )
    current = store.get("voice-lab-user-1", "synthetic-session")
    assert current is not None
    monkeypatch.setattr(sessions_router, "_store", store)
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    _install_finalization_receipt(
        object_store,
        current,
        store,
        legacy_object=False,
    )

    result = voice_lab_recovery._recover_canonical_evidence_retention(
        _claims_for_record(current),
        current,
    )

    assert "message_revision" in result, result
    assert result["message_revision"] == 1
    assert result["message_count"] == 1
    assert len(str(result["transcript_sha256"])) == 64
    if expired:
        assert result["status"] == "completed"
        assert result["canonical_evidence_purged"] is True
        assert result["recovery_receipts_purged"] is True
        assert result["all_prior_attempts_purged"] is True
        assert store.get("voice-lab-user-1", "synthetic-session") is None
        assert store.list_messages("voice-lab-user-1", "synthetic-session") == []
    else:
        assert result["status"] == "retention_pending"
        assert result["retention_purge_pending"] is True
        assert result["canonical_evidence_retained"] is True
        assert store.get("voice-lab-user-1", "synthetic-session") is not None


def test_expiry_purge_deletes_and_verifies_every_gateway_transcript_copy_idempotently(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    record = _canonical_evidence_record(
        created_at=now - timedelta(hours=2),
        retention_expires_at=now - timedelta(hours=1),
    )
    store = SessionStore(tmp_path / "sessions")
    store.create(record)
    store.replace_messages_revisioned(
        "voice-lab-user-1",
        "synthetic-session",
        [
            SessionMessageRecord(
                message_id="message-1",
                session_id="synthetic-session",
                thread_id="synthetic-thread",
                role="assistant",
                content="synthetic output to purge",
                sequence=1,
                created_at=str(record.metadata["synthetic_voice_lab"]["finalized_at"]),
                metadata=_message_metadata(record),
            )
        ],
        expected_revision=0,
    )
    current = store.get("voice-lab-user-1", "synthetic-session")
    assert current is not None
    monkeypatch.setattr(sessions_router, "_store", store)
    monkeypatch.setattr(sophia_router, "USERS_DIR", tmp_path / "gateway-users")
    local_path = sophia_router._synthetic_finalization_path(
        "voice-lab-user-1",
        _claims().cleanup_obligation_id,
    )
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_text('{"canonical_transcript":{"messages":["sensitive"]}}')

    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    expected_object = (
        ".builder/voice_lab_evidence/finalizations/v2/"
        f"{_claims().cleanup_obligation_id}.json"
    )
    assert _install_finalization_receipt(object_store, current, store) == expected_object
    receipt_prefix = voice_lab_recovery._recovery_receipt_prefix(_claims())
    raw_canaries = [
        "voice-lab-user-1",
        "run-001",
        "production",
        BUILD,
        RECOVERY_SECRET,
        "sensitive transcript",
    ]
    for index in range(3):
        object_store.objects[
            f"{receipt_prefix}/recovery-{index}/attempts/attempt-{index}.json"
        ] = (
            json.dumps({"attempt": index, "canary": raw_canaries[index]}).encode(),
            "application/json",
        )

    bound_claims = _claims_for_record(current)
    first = voice_lab_recovery._recover_canonical_evidence_retention(
        bound_claims,
        current,
    )
    second = voice_lab_recovery._recover_canonical_evidence_retention(
        bound_claims,
        None,
    )

    assert first["status"] == second["status"] == "completed"
    assert first["canonical_evidence_purged"] is True
    assert second["canonical_evidence_purged"] is True
    assert first["recovery_receipts_deleted"] == 3
    assert second["recovery_receipts_deleted"] == 3
    assert first["all_prior_attempts_purged"] is True
    assert not any(path.startswith(f"{receipt_prefix}/") for path in object_store.objects)
    assert expected_object in object_store.deleted
    assert not local_path.exists()
    assert store.get("voice-lab-user-1", "synthetic-session") is None
    assert store.list_messages("voice-lab-user-1", "synthetic-session") == []

    _intent_path, tombstone_path = voice_lab_recovery._recovery_purge_object_paths(
        _claims()
    )
    assert set(object_store.objects) == {tombstone_path}
    tombstone_raw, tombstone_content_type = object_store.objects[tombstone_path]
    assert tombstone_content_type == "application/json"
    assert object_store.create_metadata[tombstone_path] == {
        "content_type": "application/json"
    }
    tombstone = json.loads(tombstone_raw)
    expected_hmac = hmac.new(
        RECOVERY_SECRET.encode(),
        voice_lab_recovery._recovery_id(_claims()).encode(),
        hashlib.sha256,
    ).hexdigest()
    assert tombstone["recovery_id_hmac"] == expected_hmac
    assert tombstone["recovery_id_hmac"] != hashlib.sha256(
        voice_lab_recovery._recovery_id(_claims()).encode()
    ).hexdigest()
    assert tombstone["recovery_id_hmac"] in tombstone_path
    assert tombstone["recovery_receipts_deleted"] == 3
    assert tombstone["recovery_receipts_remaining"] == 0
    assert tombstone["all_prior_attempts_purged"] is True
    assert tombstone["object_metadata_content_free"] is True
    assert tombstone["retention_policy"] == "approved_redacted_purge_tombstone"
    assert len(tombstone_raw) <= 4 * 1024
    retained = f"{tombstone_path}\n{tombstone_raw.decode()}"
    for canary in raw_canaries:
        assert canary not in retained
        assert canary not in json.dumps(
            object_store.create_metadata,
            sort_keys=True,
        )


def test_late_receipt_between_initial_list_and_intent_is_fenced_and_purged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    claims = _claims()
    prefix = voice_lab_recovery._recovery_receipt_prefix(claims)
    initial_path = f"{prefix}/recovery-a/attempts/attempt-a.json"
    late_path = f"{prefix}/recovery-b/attempts/attempt-b.json"
    object_store.objects[initial_path] = (b'{"attempt":"initial"}', "application/json")

    prepared = voice_lab_recovery._prepare_recovery_receipt_purge(claims)
    assert prepared == {"already_purged": False, "target_count": 1}

    # Model a writer that created its raw object after the initial list and
    # crashed before its post-intent self-delete. Completion must advance a
    # content-free exact fence, rather than leaving an immutable count mismatch.
    object_store.objects[late_path] = (b'{"attempt":"late"}', "application/json")
    tombstone, receipt = voice_lab_recovery._complete_recovery_receipt_purge(
        claims
    )

    assert tombstone["recovery_receipts_deleted"] == 2
    assert tombstone["recovery_receipts_remaining"] == 0
    assert tombstone["all_prior_attempts_purged"] is True
    assert initial_path in object_store.deleted
    assert late_path in object_store.deleted
    assert not any(path.startswith(f"{prefix}/") for path in object_store.objects)
    assert receipt["retention_policy"] == "approved_redacted_purge_tombstone"
    stable_id = voice_lab_recovery._recovery_id(claims)
    intent_path, tombstone_path = (
        voice_lab_recovery._recovery_purge_object_paths_for_id(stable_id)
    )
    fence_path = voice_lab_recovery._recovery_purge_fence_path(stable_id)
    assert intent_path not in object_store.objects
    assert fence_path not in object_store.objects
    assert set(object_store.objects) == {tombstone_path}


def test_persistence_barrier_rejects_new_raw_receipt_after_purge_intent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    claims = _claims()
    prepared = voice_lab_recovery._prepare_recovery_receipt_purge(claims)
    assert prepared == {"already_purged": False, "target_count": 0}
    stable_id = voice_lab_recovery._recovery_id(claims)
    payload = {
        "schema": "sophia_voice_lab_recovery_v1",
        "environment": claims.environment,
        "test_run_id": claims.test_run_id,
        "recovery_id": stable_id,
        "attempt_id": "a" * 64,
    }

    with pytest.raises(HTTPException) as exc_info:
        voice_lab_recovery._persist_recovery_receipt(payload)

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == {
        "code": "voice_lab_recovery_retention_purge_started"
    }
    prefix = voice_lab_recovery._recovery_receipt_prefix(claims)
    assert not any(path.startswith(f"{prefix}/") for path in object_store.objects)


def test_production_recovery_fence_fails_closed_without_auth_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_LAB_DURABLE_EVIDENCE_REQUIRED", "true")
    monkeypatch.delenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL", raising=False)
    monkeypatch.delenv("BETTER_AUTH_DATABASE_URL", raising=False)

    with pytest.raises(RuntimeError, match="fence database is unavailable"):
        with voice_lab_recovery._recovery_receipt_fence_lock("a" * 64):
            raise AssertionError("unreachable")


@pytest.mark.parametrize("limit_case", ["object_count", "nested_depth"])
def test_recovery_receipt_prefix_limits_fail_closed_before_evidence_deletion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    limit_case: str,
) -> None:
    now = datetime.now(UTC)
    record = _canonical_evidence_record(
        created_at=now - timedelta(hours=2),
        retention_expires_at=now - timedelta(hours=1),
    )
    store = SessionStore(tmp_path / "sessions")
    store.create(record)
    current = store.get("voice-lab-user-1", "synthetic-session")
    assert current is not None
    monkeypatch.setattr(sessions_router, "_store", store)
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    _install_finalization_receipt(object_store, current, store)
    prefix = voice_lab_recovery._recovery_receipt_prefix(_claims())
    if limit_case == "object_count":
        for index in range(257):
            object_store.objects[f"{prefix}/r/attempts/{index}.json"] = (
                b"{}",
                "application/json",
            )
    else:
        object_store.objects[f"{prefix}/a/b/c/d/e/receipt.json"] = (
            b"{}",
            "application/json",
        )

    result = voice_lab_recovery._recover_canonical_evidence_retention(
        _claims_for_record(current),
        current,
    )

    assert result == {
        "status": "pending",
        "code": "canonical_evidence_purge_unavailable",
    }
    assert store.get("voice-lab-user-1", "synthetic-session") is not None
    _intent_path, tombstone_path = voice_lab_recovery._recovery_purge_object_paths(
        _claims()
    )
    assert tombstone_path not in object_store.objects


def test_recovery_purge_tombstone_is_immutable_against_intent_count_conflict(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    record = _canonical_evidence_record(
        created_at=now - timedelta(hours=2),
        retention_expires_at=now - timedelta(hours=1),
    )
    store = SessionStore(tmp_path / "sessions")
    store.create(record)
    current = store.get("voice-lab-user-1", "synthetic-session")
    assert current is not None
    monkeypatch.setattr(sessions_router, "_store", store)
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    _install_finalization_receipt(object_store, current, store)
    stable_id = voice_lab_recovery._recovery_id(_claims())
    recovery_hmac = voice_lab_recovery._recovery_id_hmac(stable_id)
    intent_path, tombstone_path = voice_lab_recovery._recovery_purge_object_paths(
        _claims()
    )
    object_store.put_json(
        intent_path,
        {
            "schema": "sophia_voice_lab_recovery_purge_intent_v1",
            "recovery_id_hmac": recovery_hmac,
            "planned_at": now.isoformat(),
            "recovery_receipts_target_count": 2,
            "raw_identity_excluded": True,
            "retention_policy": "ephemeral_redacted_purge_intent",
        },
    )
    object_store.put_json(
        tombstone_path,
        {
            "schema": "sophia_voice_lab_recovery_purge_tombstone_v1",
            "recovery_id_hmac": recovery_hmac,
            "purged_at": now.isoformat(),
            "recovery_receipts_deleted": 1,
            "recovery_receipts_remaining": 0,
            "all_prior_attempts_purged": True,
            "raw_identity_excluded": True,
            "deployment_excluded": True,
            "content_excluded": True,
            "component_details_excluded": True,
            "object_metadata_content_free": True,
            "retention_policy": "approved_redacted_purge_tombstone",
        },
    )

    result = voice_lab_recovery._recover_canonical_evidence_retention(
        _claims_for_record(current),
        current,
    )

    assert result == {
        "status": "pending",
        "code": "canonical_evidence_purge_unavailable",
    }
    assert store.get("voice-lab-user-1", "synthetic-session") is not None
    assert intent_path in object_store.objects
    assert tombstone_path in object_store.objects


def test_oversized_recovery_purge_tombstone_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    _intent_path, tombstone_path = voice_lab_recovery._recovery_purge_object_paths(
        _claims()
    )
    object_store.objects[tombstone_path] = (
        b"{" + b" " * (4 * 1024) + b"}",
        "application/json",
    )

    result = voice_lab_recovery._recover_canonical_evidence_retention(
        _claims(),
        None,
    )

    assert result == {
        "status": "pending",
        "code": "canonical_evidence_recovery_receipt_purge_unavailable",
    }


def test_missing_prepared_handle_without_complete_tombstone_is_not_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    cleanup_id = _claims().cleanup_obligation_id

    result = voice_lab_recovery._finish_retention_cleanup_intent(
        cleanup_id,
        expected_path=(
            voice_lab_recovery._retention_cleanup_handle_path_for_id(cleanup_id)
        ),
    )

    assert result == {"status": "missing_unverified"}


def test_prepared_handle_uses_locked_database_clock_when_gateway_clock_lags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_DATABASE_URL",
        "postgresql://database-clock-authority",
    )
    observed = datetime.now(UTC)
    observed = observed.replace(microsecond=(observed.microsecond // 1000) * 1000)
    cleanup_id = _claims().cleanup_obligation_id
    retention = (
        observed + timedelta(hours=1)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    provider = observed.isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )

    object_path = voice_lab_recovery._ensure_retention_cleanup_handle_for_id(
        cleanup_id,
        retention_expires_at=retention,
        provider_expires_at=provider,
        cleanup_mode="builder_global",
    )

    stored = object_store.objects[object_path]
    payload = json.loads(stored[0])
    assert payload["prepared_at"] == retention
    assert payload["retention_expires_at"] == retention


def test_opaque_expired_admission_closes_before_external_reconciliation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    cleanup_id = _claims().cleanup_obligation_id
    admission = cleanup_fence.CleanupAdmission(
        admission_id="33333333-3333-4333-8333-333333333333",
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="provider-reservation",
        lease_expires_at=observed - timedelta(minutes=1),
        resource_expires_at=observed + timedelta(minutes=20),
        expired=True,
    )
    work = SimpleNamespace(
        cleanup_obligation_id=cleanup_id,
        state="open",
        lifecycle_phase="session_provisional",
        retention_expires_at=observed + timedelta(hours=1),
        provider_expires_at=observed + timedelta(minutes=30),
        retention_due=False,
        provider_due=False,
        admissions=(admission,),
    )
    events: list[str] = []

    def refresh(*_args, **_kwargs):
        events.append("locked_refresh")
        return SimpleNamespace(**{**vars(work), "state": "closed"})

    def reconcile(_work):
        events.append("reconciled")
        return True

    monkeypatch.setattr(
        cleanup_fence,
        "refresh_cleanup_fence_work_for_reconciliation",
        refresh,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_reconcile_database_cleanup_admissions",
        reconcile,
    )

    result = voice_lab_recovery._finish_database_cleanup_fence_work(work)

    assert result == {
        "status": "pending",
        "code": "cleanup_database_work_live_sources_pending",
        "raw_identity_excluded": True,
    }
    assert events == ["locked_refresh", "reconciled"]


def test_auth_provisional_expiry_cleans_live_auth_and_marks_before_retention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    observed = observed.replace(microsecond=(observed.microsecond // 1000) * 1000)
    cleanup_id = _claims().cleanup_obligation_id
    retention = observed + timedelta(minutes=30)
    provider = retention
    principal_id = "voice-lab-user-1"
    test_run_id = "auth-only-expired-admission"
    issued_at = 2_000_000_000
    jti_hash = hashlib.sha256(b"expired-admission-jti").hexdigest()
    nonce_hash = hashlib.sha256(b"expired-admission-nonce").hexdigest()
    session_token = "expired-admission-session-token"
    token_hash = hashlib.sha256(session_token.encode()).hexdigest()
    marker_payload = {
        "v": 1,
        "principal_id": principal_id,
        "test_run_id": test_run_id,
        "tombstone_kid": "v1",
        "cleanup_obligation_id": cleanup_id,
        "issued_at": issued_at,
        "jti_sha256": jti_hash,
        "nonce_sha256": nonce_hash,
    }
    marker_value = "sophia-voice-lab-session-v1." + base64.urlsafe_b64encode(
        json.dumps(marker_payload, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    grant_fingerprint = hashlib.sha256(b"expired-admission-grant").hexdigest()
    grant_row = (
        grant_fingerprint,
        principal_id,
        test_run_id,
        "v1",
        cleanup_id,
        issued_at,
        observed - timedelta(seconds=1),
        provider,
        1,
        jti_hash,
        nonce_hash,
        token_hash,
        "active",
        None,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_DATABASE_URL",
        "postgresql://expired-admission-test",
    )
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )
    tombstone_row = (
        voice_lab_recovery._auth_tombstone_identity("cleanup", cleanup_id, kid="v1"),
        voice_lab_recovery._auth_tombstone_identity("principal", principal_id, kid="v1"),
        voice_lab_recovery._auth_tombstone_identity("run", test_run_id, kid="v1"),
        "v1",
        provider,
        "0" * 64,
        "0" * 64,
        "0" * 64,
        "revoked",
        observed,
    )
    stale_admission = cleanup_fence.CleanupAdmission(
        admission_id="44444444-4444-4444-8444-444444444444",
        cleanup_obligation_id=cleanup_id,
        resource_kind="session",
        resource_id="thread-never-inserted",
        lease_expires_at=observed - timedelta(seconds=1),
        resource_expires_at=retention,
        expired=True,
    )
    initial = SimpleNamespace(
        cleanup_obligation_id=cleanup_id,
        state="open",
        lifecycle_phase="auth_provisional",
        retention_expires_at=retention,
        provider_expires_at=provider,
        retention_due=False,
        provider_due=False,
        admissions=(stale_admission,),
    )
    refreshed = SimpleNamespace(
        **{
            **vars(initial),
            "state": "closed",
            "admissions": (),
        }
    )
    events: list[str] = []
    auth_state = {
        "status": "active",
        "sessions": [(session_token, marker_value)],
        "tombstone_deleted": False,
    }

    class AuthCursor:
        rowcount = 0

        def __init__(self) -> None:
            self.rows: list[tuple[object, ...]] = []
            self.fetchone_row: tuple[object, ...] | None = None

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, sql: str, _params: object = None) -> None:
            self.rowcount = 0
            self.rows = []
            self.fetchone_row = None
            if (
                'SELECT "principal_id"' in sql
                and 'public."sophia_voice_lab_auth_grants"' in sql
            ):
                self.rows = (
                    [(principal_id,)] if auth_state["status"] == "active" else []
                )
            elif "731941" in sql:
                events.append("principal_lock")
            elif "731944" in sql:
                events.append("cleanup_lock")
            elif "FROM public.sophia_voice_lab_cleanup_obligations" in sql:
                self.fetchone_row = (
                    "closed",
                    "auth_provisional",
                    retention,
                    provider,
                    False,
                )
            elif "SELECT grant_fingerprint" in sql and "FOR UPDATE" in sql:
                self.rows = (
                    [grant_row] if auth_state["status"] == "active" else []
                )
            elif 'FROM public."session"' in sql and "FOR UPDATE" in sql:
                self.rows = list(auth_state["sessions"])
            elif sql.lstrip().startswith(
                "UPDATE public.sophia_voice_lab_auth_grants"
            ):
                events.append("auth_tombstoned")
                auth_state["status"] = "revoked"
                self.rowcount = 1
            elif sql.lstrip().startswith('DELETE FROM public."session"'):
                events.append("auth_session_deleted")
                auth_state["sessions"] = []
                self.rowcount = 1
            elif sql.lstrip().startswith(
                "DELETE FROM public.sophia_voice_lab_auth_grants"
            ):
                auth_state["tombstone_deleted"] = True
                self.rowcount = 1
            elif "SELECT cleanup_obligation_id, principal_id" in sql:
                self.rows = (
                    [tombstone_row] if auth_state["status"] == "revoked" else []
                )
            elif 'SELECT 1 FROM public."session"' in sql:
                self.fetchone_row = None
            else:  # pragma: no cover - catches unqualified/new authority reads.
                raise AssertionError(sql)

        def fetchall(self):
            return list(self.rows)

        def fetchone(self):
            return self.fetchone_row

    class AuthConnection:
        def __init__(self, cursor: AuthCursor) -> None:
            self._cursor = cursor

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def cursor(self):
            return self._cursor

    auth_cursor = AuthCursor()
    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        SimpleNamespace(
            connect=lambda *_args, **_kwargs: AuthConnection(auth_cursor)
        ),
    )
    cleanup_auth = voice_lab_recovery._cleanup_auth_obligation_sources_by_id
    auth_errors: list[str] = []

    def cleanup_auth_exact(*args, **kwargs):
        try:
            return cleanup_auth(*args, **kwargs)
        except Exception as exc:  # pragma: no cover - assertion diagnostic.
            auth_errors.append(repr(exc))
            raise

    monkeypatch.setattr(
        voice_lab_recovery,
        "_cleanup_auth_obligation_sources_by_id",
        cleanup_auth_exact,
    )

    monkeypatch.setattr(
        cleanup_fence,
        "refresh_cleanup_fence_work_for_reconciliation",
        lambda *_args: events.append("refreshed") or refreshed,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_reconcile_database_cleanup_admissions",
        lambda work: events.append("admissions_zero")
        or work is refreshed,
    )

    monkeypatch.setattr(
        voice_lab_recovery,
        "_cleanup_obligation_product_sources_zero",
        lambda _cleanup_id: True,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_cleanup_builder_obligation_sources_zero",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        cleanup_fence,
        "close_cleanup_obligation_with_cursor",
        lambda *_args: cleanup_fence.CleanupFenceStatus(
            state="closed",
            active_admissions=0,
            expired_admissions=0,
            retention_expires_at=retention,
            provider_expires_at=provider,
        ),
    )
    monkeypatch.setattr(
        cleanup_fence,
        "mark_cleanup_live_zero_with_cursor",
        lambda *_args: events.append("live_zero_marked") or observed,
    )

    result = voice_lab_recovery._finish_database_cleanup_fence_work(initial)

    assert result["status"] == "completed", (
        result,
        events,
        auth_state,
        auth_errors,
    )
    assert result["retention_purge_pending"] is True
    assert result["live_cleanup_completed"] is True
    assert auth_state == {
        "status": "revoked",
        "sessions": [],
        "tombstone_deleted": False,
    }
    assert events == [
        "refreshed",
        "admissions_zero",
        "principal_lock",
        "cleanup_lock",
        "auth_tombstoned",
        "auth_session_deleted",
        "cleanup_lock",
        "live_zero_marked",
    ]


def test_builder_outage_retains_content_free_authority_past_control_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    cleanup_id = _claims().cleanup_obligation_id
    object_path = voice_lab_recovery._retention_cleanup_handle_path_for_id(
        cleanup_id
    )
    object_store.objects[object_path] = (b"{}", "application/json")
    observed_at = datetime.now(UTC)
    monkeypatch.setattr(
        voice_lab_recovery,
        "_open_retention_cleanup_handle",
        lambda _path, _raw: (
                {
                    "control_expires_at": (
                        observed_at - timedelta(milliseconds=1)
                    ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                        "retention_expires_at": (
                            observed_at - timedelta(hours=1)
                        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                        "provider_expires_at": (
                            observed_at - timedelta(hours=2)
                        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                },
            {},
        ),
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_cleanup_builder_obligation_sources_zero",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("LangGraph unavailable")
        ),
    )

    result = voice_lab_recovery._finish_retention_cleanup_intent(
        cleanup_id,
        expected_path=object_path,
        now=observed_at,
    )

    assert result == {
        "status": "pending",
        "control_window_overdue": True,
        "raw_identity_excluded": True,
    }
    assert object_path in object_store.objects
    assert object_path not in object_store.deleted


def test_database_barrier_outage_retains_last_cleanup_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    object_store = _FakeRecoveryObjectStore()
    object_store.install(monkeypatch)
    cleanup_id = _claims().cleanup_obligation_id
    object_path = voice_lab_recovery._retention_cleanup_handle_path_for_id(
        cleanup_id
    )
    object_store.objects[object_path] = (b"{}", "application/json")
    observed_at = datetime.now(UTC)
    monkeypatch.setattr(
        voice_lab_recovery,
        "_open_retention_cleanup_handle",
        lambda _path, _raw: (
            {
                "control_expires_at": (
                    observed_at - timedelta(milliseconds=1)
                ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            },
            {},
        ),
    )

    @contextmanager
    def unavailable_barrier(_cleanup_id: str):
        raise RuntimeError("database barrier unavailable")
        yield  # pragma: no cover

    monkeypatch.setattr(
        voice_lab_recovery,
        "_cleanup_obligation_database_barrier",
        unavailable_barrier,
    )

    with pytest.raises(RuntimeError, match="database barrier unavailable"):
        voice_lab_recovery._finish_retention_cleanup_intent(
            cleanup_id,
            expected_path=object_path,
            now=observed_at,
        )
    assert object_path in object_store.objects
    assert object_path not in object_store.deleted


@pytest.mark.anyio
async def test_builder_component_requires_authoritative_discovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    receipt = SimpleNamespace(
        cleanup_complete=True,
        discovery_complete=False,
        authoritative_zero_tasks=False,
        discovered_task_count=0,
        model_dump=lambda **_kwargs: {
            "cleanup_complete": True,
            "discovery_complete": False,
            "authoritative_zero_tasks": False,
            "discovered_task_count": 0,
            "unresolved": [],
        },
    )
    monkeypatch.setattr(
        builder_events,
        "cleanup_synthetic_builder_run",
        AsyncMock(return_value=receipt),
    )
    component = await voice_lab_recovery._recover_builder(_claims())
    assert component["status"] == "pending"
    assert component["code"] == "builder_cleanup_not_authoritative"
    assert component["discovery_complete"] is False


def _session_marker(*, run_id: str, token: str, issued_at: int = 2_000_000_000) -> tuple[str, tuple[object, ...]]:
    jti_hash = hashlib.sha256(f"{run_id}-jti".encode()).hexdigest()
    nonce_hash = hashlib.sha256(f"{run_id}-nonce".encode()).hexdigest()
    cleanup_obligation_id = (
        "223e4567-e89b-42d3-a456-426614174000"
        if run_id == "run-B"
        else "123e4567-e89b-42d3-a456-426614174000"
    )
    marker = {
        "v": 1,
        "principal_id": "voice-lab-user-1",
        "test_run_id": run_id,
        "tombstone_kid": "v1",
        "cleanup_obligation_id": cleanup_obligation_id,
        "issued_at": issued_at,
        "jti_sha256": jti_hash,
        "nonce_sha256": nonce_hash,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(marker, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    ledger = (
        hashlib.sha256(f"{run_id}-grant".encode()).hexdigest(),
        run_id,
        "v1",
        cleanup_obligation_id,
        issued_at,
        jti_hash,
        nonce_hash,
        hashlib.sha256(token.encode()).hexdigest(),
        "active",
    )
    return f"sophia-voice-lab-session-v1.{encoded}", ledger


class _FakeCursor:
    def __init__(self, sessions: list[tuple[str, str]], grants: list[tuple[object, ...]]) -> None:
        self.sessions = sessions
        self.grants = grants
        self._rows: list[tuple[object, ...]] = []
        self.rowcount = 0
        self.mutations = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[object, ...] = ()) -> None:
        self.rowcount = 0
        if 'SELECT "token", "userAgent"' in sql:
            self._rows = list(self.sessions)
        elif 'SELECT "grant_fingerprint"' in sql:
            self._rows = list(self.grants)
        elif sql.startswith('UPDATE public."sophia_voice_lab_auth_grants"'):
            self.mutations += 1
        elif sql.startswith('DELETE FROM public."session"'):
            self.mutations += 1
        elif sql.startswith('DELETE FROM public."sophia_voice_lab_auth_grants"'):
            self.mutations += 1
        else:
            self._rows = []

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor


@pytest.mark.parametrize("live_cleanup", [False, True])
def test_opaque_auth_only_cleanup_tombstones_and_deletes_by_cleanup_id(
    monkeypatch: pytest.MonkeyPatch,
    live_cleanup: bool,
) -> None:
    cleanup_id = _claims().cleanup_obligation_id
    observed = datetime.now(UTC)
    observed = observed.replace(microsecond=(observed.microsecond // 1000) * 1000)
    provider_deadline = (
        observed + timedelta(minutes=30)
        if live_cleanup
        else observed - timedelta(hours=2)
    )
    retention_deadline = (
        provider_deadline
        if live_cleanup
        else observed - timedelta(hours=1)
    )
    principal_id = "voice-lab-user-1"
    test_run_id = "auth-only-run"
    issued_at = 2_000_000_000
    jti_hash = hashlib.sha256(b"opaque-auth-jti").hexdigest()
    nonce_hash = hashlib.sha256(b"opaque-auth-nonce").hexdigest()
    session_token = "opaque-auth-session-token"
    token_hash = hashlib.sha256(session_token.encode()).hexdigest()
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )
    marker_payload = {
        "v": 1,
        "principal_id": principal_id,
        "test_run_id": test_run_id,
        "tombstone_kid": "v1",
        "cleanup_obligation_id": cleanup_id,
        "issued_at": issued_at,
        "jti_sha256": jti_hash,
        "nonce_sha256": nonce_hash,
    }
    marker_value = "sophia-voice-lab-session-v1." + base64.urlsafe_b64encode(
        json.dumps(marker_payload, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    grant_row = (
        hashlib.sha256(b"opaque-auth-grant").hexdigest(),
        principal_id,
        test_run_id,
        "v1",
        cleanup_id,
        issued_at,
        (
            observed - timedelta(seconds=1)
            if live_cleanup
            else provider_deadline - timedelta(minutes=1)
        ),
        provider_deadline,
        1,
        jti_hash,
        nonce_hash,
        token_hash,
        "active",
        None,
    )
    tombstone_row = (
        voice_lab_recovery._auth_tombstone_identity("cleanup", cleanup_id, kid="v1"),
        voice_lab_recovery._auth_tombstone_identity("principal", principal_id, kid="v1"),
        voice_lab_recovery._auth_tombstone_identity("run", test_run_id, kid="v1"),
        "v1",
        provider_deadline,
        "0" * 64,
        "0" * 64,
        "0" * 64,
        "revoked",
        observed,
    )
    session_rows = [(session_token, marker_value)] if live_cleanup else []
    events: list[str] = []

    class LocatorCursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, sql: str, _params: object = None) -> None:
            assert 'public."sophia_voice_lab_auth_grants"' in sql

        def fetchall(self):
            return [(principal_id,)]

    class CleanupCursor:
        rowcount = 0

        def __init__(self) -> None:
            self.rows: list[tuple[object, ...]] = []
            self.fetchone_row: tuple[object, ...] | None = None
            self.tombstoned = False
            self.tombstone_deleted = False

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, sql: str, params: object = None) -> None:
            self.rowcount = 0
            self.rows = []
            self.fetchone_row = None
            if "731941" in sql:
                events.append("principal_lock")
            elif "731944" in sql:
                events.append("cleanup_lock")
            elif "FROM public.sophia_voice_lab_cleanup_obligations" in sql:
                self.fetchone_row = (
                    "closed",
                    "auth_provisional",
                    retention_deadline,
                    provider_deadline,
                    not live_cleanup,
                )
            elif "SELECT grant_fingerprint" in sql and "FOR UPDATE" in sql:
                self.rows = [grant_row]
            elif "SELECT cleanup_obligation_id, principal_id" in sql:
                self.rows = [tombstone_row] if self.tombstoned else []
            elif 'FROM public."session"' in sql and "FOR UPDATE" in sql:
                self.rows = list(session_rows)
            elif sql.lstrip().startswith(
                "UPDATE public.sophia_voice_lab_auth_grants"
            ):
                events.append("grant_tombstoned")
                self.tombstoned = True
                self.rowcount = 1
            elif sql.lstrip().startswith('DELETE FROM public."session"'):
                events.append("session_deleted")
                session_rows.clear()
                self.rowcount = 1
            elif sql.lstrip().startswith(
                "DELETE FROM public.sophia_voice_lab_auth_grants"
            ):
                events.append("grant_deleted")
                self.tombstone_deleted = True
                self.rowcount = 1
            elif "SELECT 1 FROM public.sophia_voice_lab_auth_grants" in sql:
                self.fetchone_row = None
            elif 'SELECT 1 FROM public."session"' in sql:
                self.fetchone_row = None
            else:  # pragma: no cover - catches any unqualified/new query.
                raise AssertionError(sql)

        def fetchall(self):
            return list(self.rows)

        def fetchone(self):
            return self.fetchone_row

    class Connection:
        def __init__(self, cursor: object) -> None:
            self._cursor = cursor

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def cursor(self):
            return self._cursor

    cleanup_cursor = CleanupCursor()
    connections = [Connection(LocatorCursor()), Connection(cleanup_cursor)]
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_DATABASE_URL",
        "postgresql://opaque-auth-test",
    )
    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        SimpleNamespace(connect=lambda *_args, **_kwargs: connections.pop(0)),
    )

    assert voice_lab_recovery._cleanup_auth_obligation_sources_by_id(
        cleanup_id,
        retention_expires_at=retention_deadline.isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z"),
        provider_expires_at=provider_deadline.isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z"),
        live_cleanup=live_cleanup,
    )
    expected_events = [
        "principal_lock",
        "cleanup_lock",
        "grant_tombstoned",
    ]
    if live_cleanup:
        expected_events.append("session_deleted")
    else:
        expected_events.append("grant_deleted")
    assert events == expected_events
    assert cleanup_cursor.tombstoned is True
    assert cleanup_cursor.tombstone_deleted is (not live_cleanup)


def test_delayed_run_a_recovery_cannot_revoke_active_run_b(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    marker_b, ledger_b = _session_marker(run_id="run-B", token="token-B")
    cursor = _FakeCursor([("token-B", marker_b)], [ledger_b])
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL", "postgres://safe-test")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_CAPABILITY_SECRET", CAPABILITY_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )
    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        SimpleNamespace(connect=lambda *_args, **_kwargs: _FakeConnection(cursor)),
    )

    result = voice_lab_recovery._recover_auth_sessions_sync(
        _claims(test_run_id="run-A")
    )

    assert result == {"status": "failed", "code": "auth_active_run_conflict"}
    assert cursor.sessions == [("token-B", marker_b)]
    assert cursor.grants == [ledger_b]
    assert cursor.mutations == 0


def test_allocation_free_recovery_preserves_ordinary_auth_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ordinary_session = ("ordinary-token", "Mozilla/5.0 ordinary-session")
    cursor = _FakeCursor([ordinary_session], [])
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL", "postgres://safe-test")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_CAPABILITY_SECRET", CAPABILITY_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )
    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        SimpleNamespace(connect=lambda *_args, **_kwargs: _FakeConnection(cursor)),
    )

    result = voice_lab_recovery._recover_auth_sessions_sync(_claims())

    assert result == {
        "status": "already_terminal",
        "sessions_revoked": 0,
        "grants_tombstoned": 0,
        "ordinary_sessions_preserved": 1,
    }
    assert cursor.sessions == [ordinary_session]
    assert cursor.grants == []
    assert cursor.mutations == 1  # bounded deletion of expired revoked Lab grants
