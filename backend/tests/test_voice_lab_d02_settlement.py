from __future__ import annotations

import base64
import hashlib
import hmac
import inspect
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.gateway.routers import sessions as sessions_router
from app.gateway.routers import voice_lab_d02_settlement as d02
from deerflow.sophia import cleanup_fence

CAPABILITY_SECRET = "d02-capability-secret-at-least-thirty-two-bytes"
IDENTITY_SECRET = "d02-identity-secret-at-least-thirty-two-bytes"
FINALIZE_KEY_ID = "d02-database-finalize-v1"
FINALIZE_SECRET = "d02-database-finalize-secret-at-least-thirty-two-bytes"
CLEANUP_ID = "123e4567-e89b-42d3-a456-426614174000"
TEST_RUN_ID = "223e4567-e89b-42d3-a456-426614174000"
TERMINATION_ID = "323e4567-e89b-42d3-a456-426614174000"
ADMISSION_ID = "423e4567-e89b-42d3-a456-426614174000"
PROVIDER_SESSION_ID = "provider-session-d02-1"
BUILD = "a" * 40


class _LocalStore:
    def __init__(self, record: SimpleNamespace) -> None:
        self.record = record

    def find_session_by_cleanup_obligation_id(
        self, cleanup_obligation_id: str
    ) -> SimpleNamespace | None:
        synthetic = self.record.metadata.get("synthetic_voice_lab")
        return (
            self.record
            if isinstance(synthetic, dict)
            and synthetic.get("cleanup_obligation_id") == cleanup_obligation_id
            else None
        )

    def update(
        self,
        user_id: str,
        session_id: str,
        **updates: object,
    ) -> SimpleNamespace | None:
        if user_id != self.record.user_id or session_id != self.record.session_id:
            return None
        for key, value in updates.items():
            setattr(self.record, key, value)
        return self.record


class _RpcCursor:
    def __init__(self, responses: list[object]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def __enter__(self) -> _RpcCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(
        self,
        statement: str,
        parameters: tuple[object, ...] = (),
    ) -> None:
        self.calls.append((statement, tuple(parameters)))

    def fetchone(self) -> tuple[object]:
        if not self.responses:
            raise AssertionError("unexpected RPC fetch")
        return (self.responses.pop(0),)


class _RpcConnection:
    def __init__(
        self,
        responses: list[object],
        *,
        lose_commit_response: bool = False,
    ) -> None:
        self.rpc_cursor = _RpcCursor(responses)
        self.lose_commit_response = lose_commit_response
        self.exit_exception_type: type[BaseException] | None = None

    def __enter__(self) -> _RpcConnection:
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: object,
    ) -> None:
        del exception, traceback
        self.exit_exception_type = exception_type
        if exception_type is None and self.lose_commit_response:
            raise RuntimeError("synthetic committed response loss")

    def cursor(self) -> _RpcCursor:
        return self.rpc_cursor


class _RpcConnect:
    def __init__(self, connections: list[_RpcConnection]) -> None:
        self.connections = list(connections)
        self.returned: list[_RpcConnection] = []

    def __call__(self, dsn: str, *, connect_timeout: int) -> _RpcConnection:
        assert dsn == "postgresql://gateway-rpc-test"
        assert connect_timeout == 5
        if not self.connections:
            raise AssertionError("unexpected database connection")
        connection = self.connections.pop(0)
        self.returned.append(connection)
        return connection


class _ReadinessCursor:
    def __init__(self, row: tuple[object, ...]) -> None:
        self.row = row
        self.statement = ""

    def __enter__(self) -> _ReadinessCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(self, statement: str, parameters: object = None) -> None:
        del parameters
        self.statement = statement

    def fetchone(self) -> tuple[object, ...]:
        return self.row


class _ReadinessConnection:
    def __init__(self, row: tuple[object, ...]) -> None:
        self.readiness_cursor = _ReadinessCursor(row)

    def __enter__(self) -> _ReadinessConnection:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def cursor(self) -> _ReadinessCursor:
        return self.readiness_cursor


class _SequencedReadinessCursor:
    def __init__(self, rows: list[tuple[object, ...] | None]) -> None:
        self.rows = list(rows)
        self.statements: list[str] = []

    def __enter__(self) -> _SequencedReadinessCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(self, statement: str, parameters: object = None) -> None:
        del parameters
        self.statements.append(statement)

    def fetchone(self) -> tuple[object, ...] | None:
        if not self.rows:
            raise AssertionError("unexpected readiness fetch")
        return self.rows.pop(0)


class _SequencedReadinessConnection:
    def __init__(self, rows: list[tuple[object, ...] | None]) -> None:
        self.readiness_cursor = _SequencedReadinessCursor(rows)

    def __enter__(self) -> _SequencedReadinessConnection:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def cursor(self) -> _SequencedReadinessCursor:
        return self.readiness_cursor


def _install_rpc_connections(
    monkeypatch: pytest.MonkeyPatch,
    connections: list[_RpcConnection],
) -> _RpcConnect:
    import psycopg

    factory = _RpcConnect(connections)
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL",
        "postgresql://gateway-rpc-test",
    )
    monkeypatch.setattr(psycopg, "connect", factory)
    return factory


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _canonical_hash(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode()).hexdigest()


def _millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _voice_receipt(
    private_key: Ed25519PrivateKey,
    *,
    epochs: tuple[int, ...] = (1,),
) -> dict[str, object]:
    public_der = private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    instance_sha = hashlib.sha256(public_der).hexdigest()
    core: dict[str, object] = {
        "schema": d02.D02_VOICE_TERMINAL_SCHEMA,
        "issuer": d02.D02_VOICE_TERMINAL_ISSUER,
        "audience": d02.D02_VOICE_TERMINAL_AUDIENCE,
        "authority_key_id": f"voice-runtime-{instance_sha[:16]}",
        "cleanup_obligation_id": CLEANUP_ID,
        "provider_admission_id": ADMISSION_ID,
        "provider_session_id": PROVIDER_SESSION_ID,
        "provider_connection_epochs": list(epochs),
        "voice_runtime_instance_id_sha256": instance_sha,
        "voice_provider_session_absent": True,
        "voice_relay_state_absent": True,
        "observed_at": "2033-05-18T04:00:00.000Z",
        "jti": "523e4567-e89b-42d3-a456-426614174000",
        "signature_algorithm": "ed25519-sha256-canonical-json-v1",
    }
    receipt_sha = _canonical_hash(core)
    return {
        **core,
        "receipt_sha256": receipt_sha,
        "signature": base64.urlsafe_b64encode(
            private_key.sign(bytes.fromhex(receipt_sha))
        )
        .rstrip(b"=")
        .decode(),
    }


def _mark_browser_terminal(
    store: _LocalStore,
    *,
    with_close_receipt: bool,
) -> None:
    synthetic = dict(store.record.metadata["synthetic_voice_lab"])
    close_receipts: list[dict[str, object]] = []
    if with_close_receipt:
        close_receipts.append(
            {
                "schema": "sophia_gemini_browser_provider_close_v1",
                "receipt_id": "723e4567-e89b-42d3-a456-426614174000",
                "session_id": PROVIDER_SESSION_ID,
                "provider_connection_epoch": 1,
                "websocket_close_observed": True,
                "websocket_close_code": 1006,
                "websocket_closed_at": "2033-05-18T04:00:00.000Z",
            }
        )
    synthetic.update(
        {
            "voice_provider_resource_state": "closed",
            "voice_provider_pending_connection_epoch": None,
            "voice_provider_closed_at": "2033-05-18T04:00:00.000Z",
            "voice_provider_browser_close_receipts": close_receipts,
            "voice_provider_activation_abort_receipts": [],
        }
    )
    metadata = dict(store.record.metadata)
    metadata["synthetic_voice_lab"] = synthetic
    store.record.metadata = metadata
    current = cleanup_fence._LOCAL_ADMISSIONS[ADMISSION_ID]
    cleanup_fence._LOCAL_ADMISSIONS[ADMISSION_ID] = (
        cleanup_fence.CleanupAdmission(
            admission_id=current.admission_id,
            cleanup_obligation_id=current.cleanup_obligation_id,
            resource_kind=current.resource_kind,
            resource_id=current.resource_id,
            lease_expires_at=current.lease_expires_at,
            resource_expires_at=current.resource_expires_at,
            status="browser_closed",
        )
    )
    cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID][
        "provider_settlement_sha256"
    ] = d02._canonical_browser_terminal_settlement(
        synthetic,
        PROVIDER_SESSION_ID,
    )[1]


def _freeze_body() -> d02.D02FreezeRequest:
    return d02.D02FreezeRequest.model_validate(
        {
            "schema": d02.D02_FREEZE_SCHEMA,
            "termination_request_id": TERMINATION_ID,
            "voice_lab_run_id_sha256": "1" * 64,
            "test_run_id": TEST_RUN_ID,
            "cleanup_obligation_id": CLEANUP_ID,
            "provider_session_id": PROVIDER_SESSION_ID,
            "provider_admission_id_sha256": hashlib.sha256(
                ADMISSION_ID.encode()
            ).hexdigest(),
            "provider_connection_epoch": 1,
            "frozen_provider_connection_epochs": [1],
            "browser_worker_id_sha256": "2" * 64,
            "browser_lease_epoch": 7,
            "browser_context_id_sha256": "3" * 64,
            "render_action_request_sha256": "4" * 64,
            "requested_at": "2033-05-18T03:59:00.000Z",
        }
    )


def _settlement_body() -> d02.D02SettlementRequest:
    frozen = _freeze_body().model_dump(mode="json")
    frozen.pop("requested_at")
    return d02.D02SettlementRequest.model_validate(
        {
            **frozen,
            "schema": d02.D02_SETTLEMENT_REQUEST_SCHEMA,
            "render_action_accepted_response_sha256": "5" * 64,
            "render_action_settled_snapshot_sha256": "6" * 64,
            "loss_event_seq": 11,
            "loss_observed_at": "2033-05-18T04:00:01.000Z",
        }
    )


def _continuity_body(
    *,
    phase: str,
    restart_request_id: str = "623e4567-e89b-42d3-a456-426614174000",
    prior_receipt_sha256: str | None = None,
    boot_sha256: str = "d" * 64,
    observed_at: str | None = None,
) -> d02.D02ContinuityObservationRequest:
    return d02.D02ContinuityObservationRequest.model_validate(
        {
            "schema": d02.D02_CONTINUITY_REQUEST_SCHEMA,
            "restart_request_id": restart_request_id,
            "cleanup_obligation_id": CLEANUP_ID,
            "phase": phase,
            "product_service_boot_id_sha256": boot_sha256,
            "render_action_request_sha256": "e" * 64,
            "prior_observation_receipt_sha256": prior_receipt_sha256,
            "observed_at": observed_at or _millis(datetime.now(UTC)),
        }
    )


def _capability(body: Any, operation: str, *, jti: str) -> str:
    request_sha = _canonical_hash(body)
    now = int(time.time())
    action_request_id = body.get("termination_request_id") or body.get(
        "restart_request_id"
    )
    claims = {
        "v": 1,
        "iss": d02.D02_CAPABILITY_ISSUER,
        "aud": d02.D02_CAPABILITY_AUDIENCE,
        "op": operation,
        "request_sha256": request_sha,
        "cleanup_obligation_id": CLEANUP_ID,
        "termination_request_id_sha256": hashlib.sha256(
            str(action_request_id).encode()
        ).hexdigest(),
        "iat": now,
        "nbf": now,
        "exp": now + 120,
        "jti": jti,
        "nonce": f"nonce-{jti}",
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(claims, separators=(",", ":")).encode()
    ).rstrip(b"=")
    signature = hmac.new(CAPABILITY_SECRET.encode(), encoded, hashlib.sha256).digest()
    return (
        encoded.decode()
        + "."
        + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    )


@pytest.mark.parametrize("unsafe_setting_index", range(4))
def test_gateway_database_readiness_rejects_unsafe_session_settings(
    monkeypatch: pytest.MonkeyPatch,
    unsafe_setting_index: int,
) -> None:
    import psycopg

    settings = [True, True, True, True]
    settings[unsafe_setting_index] = False
    row = (
        "sophia_voice_lab_gateway",
        "sophia_voice_lab_gateway",
        True,
        False,
        False,
        False,
        False,
        False,
        False,
        False,
        "supabase_pg17.directional_membership.v1",
        True,
        0,
        0,
        True,
        True,
        *settings,
    )
    connection = _ReadinessConnection(row)

    def connect(dsn: str, *, connect_timeout: int) -> _ReadinessConnection:
        assert dsn == "postgresql://gateway-readiness-test"
        assert connect_timeout == 5
        return connection

    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL",
        "postgresql://gateway-readiness-test",
    )
    monkeypatch.setattr(psycopg, "connect", connect)
    with pytest.raises(HTTPException) as rejected:
        d02.assert_d02_gateway_database_ready()
    assert rejected.value.detail["code"] == (
        "voice_lab_d02_gateway_database_session_unsafe"
    )
    assert "session_replication_role" in connection.readiness_cursor.statement
    assert "synchronous_commit" in connection.readiness_cursor.statement
    assert "pg_is_in_recovery" in connection.readiness_cursor.statement


@pytest.mark.parametrize(
    "membership_slice",
    [
        ("stale.v0", True, 0, 0, True, True),
        ("supabase_pg17.directional_membership.v1", False, 0, 0, True, True),
        ("supabase_pg17.directional_membership.v1", True, -1, 0, True, True),
        ("supabase_pg17.directional_membership.v1", True, 0.5, 0, True, True),
        ("supabase_pg17.directional_membership.v1", True, 2, 0, True, True),
        ("supabase_pg17.directional_membership.v1", True, 0, 1, True, True),
        ("supabase_pg17.directional_membership.v1", True, 0, 0, False, True),
    ],
)
def test_gateway_database_readiness_rejects_membership_contract_drift(
    monkeypatch: pytest.MonkeyPatch,
    membership_slice: tuple[object, ...],
) -> None:
    import psycopg

    row = (
        "sophia_voice_lab_gateway",
        "sophia_voice_lab_gateway",
        True,
        False,
        False,
        False,
        False,
        False,
        False,
        False,
        *membership_slice,
        True,
        True,
        True,
        True,
    )
    connection = _ReadinessConnection(row)

    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL",
        "postgresql://gateway-readiness-test",
    )
    monkeypatch.setattr(
        psycopg,
        "connect",
        lambda _dsn, *, connect_timeout: connection,
    )
    with pytest.raises(HTTPException) as rejected:
        d02.assert_d02_gateway_database_ready()
    assert rejected.value.detail["code"] == (
        "voice_lab_d02_gateway_database_role_invalid"
    )
    statement = connection.readiness_cursor.statement
    assert "member_role.rolname = 'postgres'" in statement
    assert "grantor_role.rolname = 'supabase_admin'" in statement
    assert "membership.admin_option = true" in statement
    assert "membership.inherit_option = false" in statement
    assert "membership.set_option = false" in statement
    assert "WITH RECURSIVE inherited_roles" in statement


@pytest.mark.parametrize("canonical_inbound_count", [0, 1])
def test_gateway_database_readiness_rejects_public_authority_in_hostile_schema(
    monkeypatch: pytest.MonkeyPatch,
    canonical_inbound_count: int,
) -> None:
    import psycopg

    safe_role_and_session = (
        "sophia_voice_lab_gateway",
        "sophia_voice_lab_gateway",
        True,
        False,
        False,
        False,
        False,
        False,
        False,
        False,
        "supabase_pg17.directional_membership.v1",
        True,
        canonical_inbound_count,
        0,
        True,
        True,
        True,
        True,
        True,
        True,
    )
    # The second row models a hostile application schema whose USAGE plus
    # relation/routine authority is inherited through a grant to PUBLIC.
    connection = _SequencedReadinessConnection(
        [safe_role_and_session, ("voice_lab_hostile",)]
    )

    def connect(
        dsn: str, *, connect_timeout: int
    ) -> _SequencedReadinessConnection:
        assert dsn == "postgresql://gateway-readiness-test"
        assert connect_timeout == 5
        return connection

    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL",
        "postgresql://gateway-readiness-test",
    )
    monkeypatch.setattr(psycopg, "connect", connect)
    with pytest.raises(HTTPException) as rejected:
        d02.assert_d02_gateway_database_ready()

    assert rejected.value.detail["code"] == (
        "voice_lab_d02_gateway_database_acl_invalid"
    )
    cross_schema_sql = connection.readiness_cursor.statements[1]
    assert "has_schema_privilege" in cross_schema_sql
    assert "has_table_privilege" in cross_schema_sql
    assert "has_any_column_privilege" in cross_schema_sql
    assert "has_sequence_privilege" in cross_schema_sql
    assert "has_function_privilege" in cross_schema_sql
    assert "pg_catalog.pg_extension" in cross_schema_sql


def test_gateway_database_readiness_excludes_extension_owned_public_functions() -> None:
    runtime_source = inspect.getsource(d02.assert_d02_gateway_database_ready)
    public_function_authority = runtime_source.split(
        "actual_function_authority =", 1
    )[0].rsplit("cursor.execute(", 1)[-1]

    assert "pg_catalog.pg_depend dependency" in public_function_authority
    assert "dependency.objid = procedure.oid" in public_function_authority
    assert "dependency.deptype = 'e'" in public_function_authority


@pytest.fixture
def d02_local(monkeypatch: pytest.MonkeyPatch) -> tuple[_LocalStore, Ed25519PrivateKey]:
    cleanup_fence._reset_local_cleanup_fences_for_tests()
    d02.reset_d02_local_state_for_tests()
    monkeypatch.delenv("SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL", raising=False)
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.delenv("RENDER_SERVICE_ID", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET", CAPABILITY_SECRET)
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_IDENTITY_HMAC_SECRET", IDENTITY_SECRET
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID", FINALIZE_KEY_ID
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET", FINALIZE_SECRET
    )

    gateway_private = Ed25519PrivateKey.generate()
    gateway_private_der = gateway_private.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    gateway_public_der = gateway_private.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    gateway_public = base64.b64encode(gateway_public_der).decode()
    gateway_kid = "gateway-d02-v1"
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PRIVATE_KEY_PKCS8_BASE64",
        base64.b64encode(gateway_private_der).decode(),
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64",
        gateway_public,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID", gateway_kid
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON",
        json.dumps({gateway_kid: gateway_public}),
    )

    voice_private = Ed25519PrivateKey.generate()
    voice_public_der = voice_private.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    voice_public = base64.b64encode(voice_public_der).decode()
    voice_instance = hashlib.sha256(voice_public_der).hexdigest()
    metadata = {
        "expected_deployment": {
            "frontend": BUILD,
            "backend": BUILD,
            "voice": BUILD,
        },
        "synthetic_voice_lab": {
            "synthetic": True,
            "principal_id": "voice-lab-user-1",
            "test_run_id": TEST_RUN_ID,
            "scenario_id": "V-D02",
            "scenario_version": "vt00.scenarios.v1",
            "environment": "production",
            "cleanup_obligation_id": CLEANUP_ID,
            "voice_runtime_session_id": PROVIDER_SESSION_ID,
            "voice_lab_run_id_sha256": "1" * 64,
            "browser_worker_id_sha256": "2" * 64,
            "browser_lease_epoch": 7,
            "browser_context_id_sha256": "3" * 64,
            "voice_runtime_owner_deployment_sha": BUILD,
            "voice_runtime_instance_id_sha256": voice_instance,
            "voice_runtime_instance_public_key_spki_base64": voice_public,
            "voice_provider_resource_state": "active",
            "voice_provider_connection_epoch": 1,
            "voice_provider_pending_connection_epoch": None,
        },
    }
    record = SimpleNamespace(
        session_id="session-d02-1",
        thread_id="thread-d02-1",
        user_id="voice-lab-user-1",
        run_id=TEST_RUN_ID,
        status="open",
        message_revision=3,
        metadata=metadata,
    )
    store = _LocalStore(record)
    monkeypatch.setattr(sessions_router, "_store", store)

    now = datetime.now(UTC)
    cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID] = {
        "state": "open",
        "lifecycle_phase": "session_provisional",
        "retention_expires_at": now + timedelta(hours=24),
        "provider_expires_at": now + timedelta(minutes=30),
        "created_at": now,
        "updated_at": now,
        "closed_at": None,
        "live_cleanup_completed_at": None,
        "provider_settlement_sha256": None,
    }
    cleanup_fence._LOCAL_ADMISSIONS[ADMISSION_ID] = cleanup_fence.CleanupAdmission(
        admission_id=ADMISSION_ID,
        cleanup_obligation_id=CLEANUP_ID,
        resource_kind="provider",
        resource_id=PROVIDER_SESSION_ID,
        lease_expires_at=now + timedelta(minutes=2),
        resource_expires_at=now + timedelta(minutes=30),
        status="browser_active",
    )
    return store, voice_private


def test_d02_internal_route_rejects_browser_without_capability(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    del d02_local
    app = FastAPI()
    app.include_router(d02.router)
    client = TestClient(app)

    response = client.post(
        "/internal/voice-lab/d02/browser-worker-termination-freezes",
        json=_freeze_body().model_dump(mode="json"),
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "voice_lab_d02_capability_required"


@pytest.mark.anyio
async def test_d02_freeze_terminal_relay_settlement_and_replay_are_atomic(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    store, voice_private = d02_local
    freeze = _freeze_body()
    freeze_dict = freeze.model_dump(mode="json")
    freeze_sha = _canonical_hash(freeze_dict)

    async with d02.gateway_d02_relay_lease(
        cleanup_obligation_id=CLEANUP_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        provider_connection_epoch=1,
        scenario_id="V-D02",
        relay_kind="event_stream",
    ) as relay:
        await relay.assert_live()
        first = d02._freeze_local(
            freeze,
            request_sha256=freeze_sha,
            capability_jti_sha256="7" * 64,
        )
        assert first["frozen"] is True
        assert first["idempotent_replay"] is False
        assert cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID]["state"] == "closed"
        with pytest.raises(HTTPException) as producer_frozen:
            d02.assert_d02_producer_open(CLEANUP_ID)
        assert producer_frozen.value.detail["code"] == (
            "voice_lab_d02_termination_frozen"
        )

        replay = d02._freeze_local(
            freeze,
            request_sha256=freeze_sha,
            capability_jti_sha256="8" * 64,
        )
        assert replay["idempotent_replay"] is True

        receipt = _voice_receipt(voice_private)
        assert d02.persist_d02_voice_terminal_receipt(
            cleanup_obligation_id=CLEANUP_ID,
            admission_id=ADMISSION_ID,
            provider_session_id=PROVIDER_SESSION_ID,
            receipt=receipt,
        )

        settlement = _settlement_body()
        settlement_sha = _canonical_hash(settlement.model_dump(mode="json"))
        _mark_browser_terminal(store, with_close_receipt=False)
        with pytest.raises(HTTPException) as browser_pending:
            d02._settle_local(
                settlement,
                request_sha256=settlement_sha,
                capability_jti_sha256="9" * 64,
            )
        assert browser_pending.value.status_code == 409
        assert browser_pending.value.detail["code"] == (
            "voice_lab_d02_browser_terminal_receipts_required"
        )

        _mark_browser_terminal(store, with_close_receipt=True)
        with pytest.raises(HTTPException) as relay_pending:
            d02._settle_local(
                settlement,
                request_sha256=settlement_sha,
                capability_jti_sha256="a" * 64,
            )
        assert relay_pending.value.status_code == 409
        assert relay_pending.value.detail["code"] == "voice_lab_d02_terminal_zero_pending"

    terminal_admission = cleanup_fence._LOCAL_ADMISSIONS.pop(ADMISSION_ID)
    obligation = cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID]
    with pytest.raises(cleanup_fence.CleanupFenceError):
        cleanup_fence.mark_cleanup_live_zero(
            CLEANUP_ID,
            obligation["retention_expires_at"],
            obligation["provider_expires_at"],
        )
    cleanup_fence._LOCAL_ADMISSIONS[ADMISSION_ID] = terminal_admission

    settlement = _settlement_body()
    settlement_sha = _canonical_hash(settlement.model_dump(mode="json"))
    gateway_receipt = d02._settle_local(
        settlement,
        request_sha256=settlement_sha,
        capability_jti_sha256="b" * 64,
    )
    assert gateway_receipt["all_frozen_provider_epochs_terminal"] is True
    assert gateway_receipt["gateway_browser_relay_absent"] is True
    assert gateway_receipt["provider_admission_absent"] is True
    assert CLEANUP_ID not in cleanup_fence._LOCAL_D02_PENDING_CLEANUPS
    assert ADMISSION_ID not in cleanup_fence._LOCAL_ADMISSIONS
    synthetic = store.record.metadata["synthetic_voice_lab"]
    assert synthetic["voice_provider_resource_state"] == "closed"
    assert synthetic["voice_provider_pending_connection_epoch"] is None
    assert cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID][
        "provider_settlement_sha256"
    ] == gateway_receipt["provider_settlement_sha256"]
    assert cleanup_fence.mark_cleanup_live_zero(
        CLEANUP_ID,
        obligation["retention_expires_at"],
        obligation["provider_expires_at"],
    ) == cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID][
        "live_cleanup_completed_at"
    ]

    # A response-loss replay uses a fresh operation capability but returns the
    # exact immutable signed receipt, even after its issuance window.
    replayed = d02._settle_local(
        settlement,
        request_sha256=settlement_sha,
        capability_jti_sha256="c" * 64,
    )
    assert replayed == gateway_receipt


def test_d02_voice_terminal_receipt_accepts_exact_browser_first_terminal_replay(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    store, voice_private = d02_local
    freeze = _freeze_body()
    d02._freeze_local(
        freeze,
        request_sha256=_canonical_hash(freeze.model_dump(mode="json")),
        capability_jti_sha256="f" * 64,
    )
    _mark_browser_terminal(store, with_close_receipt=True)
    receipt = _voice_receipt(voice_private)

    assert d02.persist_d02_voice_terminal_receipt(
        cleanup_obligation_id=CLEANUP_ID,
        admission_id=ADMISSION_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        receipt=receipt,
    )
    assert d02.persist_d02_voice_terminal_receipt(
        cleanup_obligation_id=CLEANUP_ID,
        admission_id=ADMISSION_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        receipt=receipt,
    )
    assert d02._LOCAL_FREEZES[
        (CLEANUP_ID, hashlib.sha256(TERMINATION_ID.encode()).hexdigest())
    ][
        "voice_terminal_receipt"
    ] == receipt


def test_d02_voice_terminal_receipt_replay_rejects_boolean_epoch_alias(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    _, voice_private = d02_local
    freeze = _freeze_body()
    d02._freeze_local(
        freeze,
        request_sha256=_canonical_hash(freeze.model_dump(mode="json")),
        capability_jti_sha256="e" * 64,
    )
    receipt = _voice_receipt(voice_private)
    assert d02.persist_d02_voice_terminal_receipt(
        cleanup_obligation_id=CLEANUP_ID,
        admission_id=ADMISSION_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        receipt=receipt,
    )

    drifted = dict(receipt)
    drifted["provider_connection_epochs"] = [True]
    with pytest.raises(HTTPException) as replay_conflict:
        d02.persist_d02_voice_terminal_receipt(
            cleanup_obligation_id=CLEANUP_ID,
            admission_id=ADMISSION_ID,
            provider_session_id=PROVIDER_SESSION_ID,
            receipt=drifted,
        )
    assert replay_conflict.value.status_code == 409
    assert replay_conflict.value.detail["code"] == (
        "voice_lab_d02_voice_terminal_receipt_invalid"
    )


def test_d02_rejects_tampered_voice_signature_and_unicode_identifiers(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    _, voice_private = d02_local
    freeze = _freeze_body()
    d02._freeze_local(
        freeze,
        request_sha256=_canonical_hash(freeze.model_dump(mode="json")),
        capability_jti_sha256="c" * 64,
    )
    tampered = _voice_receipt(voice_private)
    tampered["signature"] = "A" * 86
    with pytest.raises(HTTPException) as invalid_signature:
        d02.persist_d02_voice_terminal_receipt(
            cleanup_obligation_id=CLEANUP_ID,
            admission_id=ADMISSION_ID,
            provider_session_id=PROVIDER_SESSION_ID,
            receipt=tampered,
        )
    assert invalid_signature.value.status_code == 409
    assert invalid_signature.value.detail["code"] == (
        "voice_lab_d02_voice_terminal_receipt_invalid"
    )

    payload = _freeze_body().model_dump(mode="json")
    payload["provider_session_id"] = "provider-é"
    with pytest.raises(ValueError):
        d02.D02FreezeRequest.model_validate(payload)


@pytest.mark.parametrize(
    "mutation",
    (
        "boolean_epoch",
        "false_close_observation",
        "wrong_provider_session",
        "overlapping_abort",
    ),
)
def test_d02_settlement_rejects_noncanonical_browser_terminal_receipts(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    mutation: str,
) -> None:
    store, voice_private = d02_local
    freeze = _freeze_body()
    d02._freeze_local(
        freeze,
        request_sha256=_canonical_hash(freeze.model_dump(mode="json")),
        capability_jti_sha256="d" * 64,
    )
    assert d02.persist_d02_voice_terminal_receipt(
        cleanup_obligation_id=CLEANUP_ID,
        admission_id=ADMISSION_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        receipt=_voice_receipt(voice_private),
    )
    _mark_browser_terminal(store, with_close_receipt=True)

    metadata = dict(store.record.metadata)
    synthetic = dict(metadata["synthetic_voice_lab"])
    close_receipts = [
        dict(item) for item in synthetic["voice_provider_browser_close_receipts"]
    ]
    abort_receipts: list[dict[str, object]] = []
    if mutation == "boolean_epoch":
        close_receipts[0]["provider_connection_epoch"] = True
    elif mutation == "false_close_observation":
        close_receipts[0]["websocket_close_observed"] = False
    elif mutation == "wrong_provider_session":
        close_receipts[0]["session_id"] = "provider-session-wrong"
    else:
        abort_receipts.append(
            {
                "schema": "sophia_gemini_browser_provider_activation_abort_v1",
                "receipt_id": "823e4567-e89b-42d3-a456-426614174000",
                "session_id": PROVIDER_SESSION_ID,
                "previous_activated_epoch": 0,
                "candidate_epoch": 1,
                "websocket_created": False,
                "aborted_at": "2033-05-18T04:00:00.000Z",
            }
        )
    synthetic["voice_provider_browser_close_receipts"] = close_receipts
    synthetic["voice_provider_activation_abort_receipts"] = abort_receipts
    metadata["synthetic_voice_lab"] = synthetic
    store.record.metadata = metadata

    # Even a forged matching obligation digest cannot turn malformed durable
    # metadata into browser-owned terminal authority.
    cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID][
        "provider_settlement_sha256"
    ] = _canonical_hash(
        {
            "browser_provider_close_receipts": close_receipts,
            "browser_provider_activation_abort_receipts": abort_receipts,
        }
    )
    settlement = _settlement_body()
    with pytest.raises(HTTPException) as rejected:
        d02._settle_local(
            settlement,
            request_sha256=_canonical_hash(settlement.model_dump(mode="json")),
            capability_jti_sha256="e" * 64,
        )
    assert rejected.value.status_code == 409
    assert rejected.value.detail["code"] == (
        "voice_lab_d02_browser_terminal_receipts_invalid"
    )


def test_d02_gateway_keyring_requires_current_unique_ed25519_entry(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del d02_local
    assert set(d02._receipt_public_keyring()) == {"gateway-d02-v1"}
    current = d02._required_secret(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64"
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON",
        json.dumps({"gateway-d02-v1": current, "duplicate": current}),
    )
    with pytest.raises(HTTPException) as duplicate:
        d02._receipt_public_keyring()
    assert duplicate.value.status_code == 503


def test_d02_capability_is_request_bound_and_fresh_jti_replayable(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    del d02_local
    app = FastAPI()
    app.include_router(d02.router)
    client = TestClient(app)
    body = _freeze_body().model_dump(mode="json")

    response = client.post(
        "/internal/voice-lab/d02/browser-worker-termination-freezes",
        json=body,
        headers={
            d02.D02_CAPABILITY_HEADER: _capability(body, "freeze", jti="first-jti")
        },
    )
    assert response.status_code == 202

    replay = client.post(
        "/internal/voice-lab/d02/browser-worker-termination-freezes",
        json=body,
        headers={
            d02.D02_CAPABILITY_HEADER: _capability(body, "freeze", jti="second-jti")
        },
    )
    assert replay.status_code == 202
    assert replay.json()["idempotent_replay"] is True

    mutated = dict(body)
    mutated["browser_lease_epoch"] = 8
    rejected = client.post(
        "/internal/voice-lab/d02/browser-worker-termination-freezes",
        json=mutated,
        headers={
            d02.D02_CAPABILITY_HEADER: _capability(body, "freeze", jti="third-jti")
        },
    )
    assert rejected.status_code == 403
    assert rejected.json()["detail"]["code"] == (
        "voice_lab_d02_capability_binding_mismatch"
    )


def test_d02_product_continuity_observations_are_atomic_and_chained(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    store, _ = d02_local
    before = _continuity_body(phase="before_api_restart")
    before_sha = _canonical_hash(before.model_dump(mode="json"))
    before_receipt = d02._observe_continuity_local(
        before,
        request_sha256=before_sha,
        capability_jti_sha256="d" * 64,
    )
    assert before_receipt["phase"] == "before_api_restart"
    assert before_receipt["cleanup_obligation_state"] == "open"
    assert before_receipt["d02_freeze_absent"] is True

    replay = d02._observe_continuity_local(
        before,
        request_sha256=before_sha,
        capability_jti_sha256="e" * 64,
    )
    assert replay == before_receipt

    after = _continuity_body(
        phase="after_api_restart",
        prior_receipt_sha256=str(before_receipt["receipt_sha256"]),
        boot_sha256="f" * 64,
    )
    after_receipt = d02._observe_continuity_local(
        after,
        request_sha256=_canonical_hash(after.model_dump(mode="json")),
        capability_jti_sha256="f" * 64,
    )
    assert after_receipt["phase"] == "after_api_restart"
    assert (
        after_receipt["continuity_projection"]
        == before_receipt["continuity_projection"]
    )
    assert after_receipt["product_service_boot_id_sha256"] == "f" * 64

    next_restart = "723e4567-e89b-42d3-a456-426614174000"
    next_before = _continuity_body(
        phase="before_api_restart",
        restart_request_id=next_restart,
    )
    with pytest.raises(HTTPException) as second_restart:
        d02._observe_continuity_local(
            next_before,
            request_sha256=_canonical_hash(next_before.model_dump(mode="json")),
            capability_jti_sha256="1" * 64,
        )
    assert second_restart.value.status_code == 409
    assert second_restart.value.detail["code"] == (
        "voice_lab_d02_continuity_restart_conflict"
    )


def test_d02_product_continuity_rejects_changed_locked_projection(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
) -> None:
    store, _ = d02_local
    before = _continuity_body(phase="before_api_restart")
    before_receipt = d02._observe_continuity_local(
        before,
        request_sha256=_canonical_hash(before.model_dump(mode="json")),
        capability_jti_sha256="1" * 64,
    )
    store.record.message_revision += 1
    changed_after = _continuity_body(
        phase="after_api_restart",
        prior_receipt_sha256=str(before_receipt["receipt_sha256"]),
        boot_sha256="2" * 64,
    )
    with pytest.raises(HTTPException) as changed:
        d02._observe_continuity_local(
            changed_after,
            request_sha256=_canonical_hash(
                changed_after.model_dump(mode="json")
            ),
            capability_jti_sha256="2" * 64,
        )
    assert changed.value.status_code == 409
    assert changed.value.detail["code"] == "voice_lab_d02_continuity_changed"


def test_d02_product_continuity_requires_fresh_first_write_but_replays_late(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial = datetime(2033, 5, 18, 4, 0, tzinfo=UTC)
    current = initial
    monkeypatch.setattr(d02, "_utc_now", lambda: current)

    stale = _continuity_body(
        phase="before_api_restart",
        observed_at=_millis(initial - timedelta(minutes=6)),
    )
    with pytest.raises(HTTPException) as absent_stale:
        d02._observe_continuity_local(
            stale,
            request_sha256=_canonical_hash(stale.model_dump(mode="json")),
            capability_jti_sha256="3" * 64,
        )
    assert absent_stale.value.status_code == 409
    assert absent_stale.value.detail["code"] == (
        "voice_lab_d02_continuity_observation_stale"
    )

    before = _continuity_body(
        phase="before_api_restart",
        observed_at=_millis(initial),
    )
    before_sha = _canonical_hash(before.model_dump(mode="json"))
    before_receipt = d02._observe_continuity_local(
        before,
        request_sha256=before_sha,
        capability_jti_sha256="4" * 64,
    )
    current = initial + timedelta(minutes=10)
    assert d02._observe_continuity_local(
        before,
        request_sha256=before_sha,
        capability_jti_sha256="5" * 64,
    ) == before_receipt

    after = _continuity_body(
        phase="after_api_restart",
        prior_receipt_sha256=str(before_receipt["receipt_sha256"]),
        boot_sha256="6" * 64,
        observed_at=_millis(current),
    )
    after_sha = _canonical_hash(after.model_dump(mode="json"))
    after_receipt = d02._observe_continuity_local(
        after,
        request_sha256=after_sha,
        capability_jti_sha256="6" * 64,
    )
    current += timedelta(minutes=10)
    assert d02._observe_continuity_local(
        after,
        request_sha256=after_sha,
        capability_jti_sha256="7" * 64,
    ) == after_receipt


def test_d02_database_finalize_proof_matches_sql_ascii_vector_verbatim_secret(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del d02_local
    secret = " edge-space-secret-at-least-thirty-two-bytes "
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID",
        "db-finalize-v1",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET",
        secret,
    )
    parts = ("cleanup", "relay", "owner", "30", "operation")
    value = {"z": [], "alpha": 1, "nested": {"ok": True}}

    key_id, proof = d02._database_finalize_proof(
        domain="relay_refresh_v1",
        parts=parts,
        value=value,
    )

    assert key_id == "db-finalize-v1"
    assert proof == "f66745637dffbaba7ecc148a00793c2876777d077a25f9f7da679e27b24ce126"
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET",
        secret.strip(),
    )
    assert d02._database_finalize_proof(
        domain="relay_refresh_v1",
        parts=parts,
        value=value,
    )[1] != proof

    with pytest.raises(HTTPException) as non_ascii:
        d02._database_finalize_proof(
            domain="relay_refresh_v1",
            parts=parts,
            value={"not_sql_canonical": "é"},
        )
    assert non_ascii.value.status_code == 503


def test_d02_database_freeze_uses_one_rpc_transaction_and_exact_proof(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, _ = d02_local
    body = _freeze_body()
    request_sha256 = _canonical_hash(body.model_dump(mode="json"))
    capability_jti_sha256 = "7" * 64
    connection = _RpcConnection(
        [
            {
                "status": "candidate",
                "user_id": store.record.user_id,
                "run_id": store.record.run_id,
                "metadata": store.record.metadata,
                "obligation_state": "open",
                "lifecycle_phase": "session_provisional",
                "live_cleanup_completed_at": None,
                "admission_id": ADMISSION_ID,
                "admission_status": "browser_active",
                "admission_resource_id": PROVIDER_SESSION_ID,
            },
            {"status": "created"},
        ]
    )
    _install_rpc_connections(monkeypatch, [connection])

    result = d02._freeze_database(
        body,
        request_sha256=request_sha256,
        capability_jti_sha256=capability_jti_sha256,
    )

    assert result == {
        "frozen": True,
        "idempotent_replay": False,
        "freeze_request_sha256": request_sha256,
    }
    assert connection.exit_exception_type is None
    assert len(connection.rpc_cursor.calls) == 2
    authorize_sql, _ = connection.rpc_cursor.calls[0]
    finalize_sql, finalize_parameters = connection.rpc_cursor.calls[1]
    assert "sophia_voice_lab_d02_freeze_authorize" in authorize_sql
    assert "%s::text" in authorize_sql
    assert "sophia_voice_lab_d02_freeze_finalize" in finalize_sql
    assert "%s::uuid" in finalize_sql
    expected_key_id, expected_proof = d02._database_finalize_proof(
        domain="freeze_finalize_v1",
        parts=(
            CLEANUP_ID,
            hashlib.sha256(TERMINATION_ID.encode()).hexdigest(),
            PROVIDER_SESSION_ID,
            ADMISSION_ID,
            request_sha256,
            capability_jti_sha256,
        ),
        value=d02._freeze_projection(body),
    )
    assert finalize_parameters[-2:] == (expected_key_id, expected_proof)


def test_d02_database_settlement_validates_signs_and_finalizes_in_one_transaction(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, voice_private = d02_local
    _mark_browser_terminal(store, with_close_receipt=True)
    body = _settlement_body()
    request_sha256 = _canonical_hash(body.model_dump(mode="json"))
    capability_jti_sha256 = "8" * 64
    voice_receipt = _voice_receipt(voice_private)
    settlement_sha256 = cleanup_fence._LOCAL_OBLIGATIONS[CLEANUP_ID][
        "provider_settlement_sha256"
    ]
    connection = _RpcConnection(
        [
            {
                "status": "candidate",
                "freeze_binding": d02._freeze_projection(_freeze_body()),
                "provider_session_id": PROVIDER_SESSION_ID,
                "provider_admission_id": ADMISSION_ID,
                "voice_terminal_receipt": voice_receipt,
                "freeze_request_sha256": "9" * 64,
                "user_id": store.record.user_id,
                "run_id": store.record.run_id,
                "metadata": store.record.metadata,
                "obligation_state": "closed",
                "provider_settlement_sha256": settlement_sha256,
                "admission_status": "browser_closed",
                "admission_id": ADMISSION_ID,
                "database_now": "2033-05-18T04:00:02.345Z",
                "relay_zero": True,
            },
            {"status": "created"},
        ]
    )
    _install_rpc_connections(monkeypatch, [connection])

    receipt = d02._settle_database(
        body,
        request_sha256=request_sha256,
        capability_jti_sha256=capability_jti_sha256,
    )

    assert receipt["database_observed_at"] == "2033-05-18T04:00:02.345Z"
    assert receipt["provider_settlement_sha256"] == settlement_sha256
    assert connection.exit_exception_type is None
    assert len(connection.rpc_cursor.calls) == 2
    assert "sophia_voice_lab_d02_settlement_authorize" in (
        connection.rpc_cursor.calls[0][0]
    )
    finalize_sql, finalize_parameters = connection.rpc_cursor.calls[1]
    assert "sophia_voice_lab_d02_settlement_finalize" in finalize_sql
    assert "%s::jsonb" in finalize_sql
    assert json.loads(str(finalize_parameters[9])) == receipt


def test_d02_database_settlement_invalid_replay_rolls_back_prepared_capability(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del d02_local
    body = _settlement_body()
    request_sha256 = _canonical_hash(body.model_dump(mode="json"))
    connection = _RpcConnection(
        [
            {
                "status": "existing",
                "settlement_request_sha256": request_sha256,
                "receipt": {
                    "authority_key_id": "gateway-d02-v1",
                    "signature": "AA",
                },
            }
        ]
    )
    _install_rpc_connections(monkeypatch, [connection])

    with pytest.raises(HTTPException) as invalid:
        d02._settle_database(
            body,
            request_sha256=request_sha256,
            capability_jti_sha256="a" * 64,
        )

    assert invalid.value.detail["code"] == "voice_lab_d02_stored_receipt_invalid"
    assert connection.exit_exception_type is HTTPException
    assert len(connection.rpc_cursor.calls) == 1


def test_d02_database_voice_terminal_replay_uses_pinned_key_before_comparison(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, voice_private = d02_local
    receipt = _voice_receipt(voice_private)
    connection = _RpcConnection(
        [
            {
                "status": "existing",
                "freeze_binding": d02._freeze_projection(_freeze_body()),
                "voice_terminal_receipt": receipt,
                "metadata": store.record.metadata,
                "obligation_state": "closed",
                "provider_settlement_sha256": None,
                "admission_status": None,
            }
        ]
    )
    _install_rpc_connections(monkeypatch, [connection])

    assert d02.persist_d02_voice_terminal_receipt(
        cleanup_obligation_id=CLEANUP_ID,
        admission_id=ADMISSION_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        receipt=receipt,
    )
    assert len(connection.rpc_cursor.calls) == 1
    assert "voice_terminal_authorize" in connection.rpc_cursor.calls[0][0]


def test_d02_database_voice_terminal_finalizes_with_verified_core_digest(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, voice_private = d02_local
    receipt = _voice_receipt(voice_private)
    connection = _RpcConnection(
        [
            {
                "status": "candidate",
                "freeze_binding": d02._freeze_projection(_freeze_body()),
                "voice_terminal_receipt": None,
                "metadata": store.record.metadata,
                "obligation_state": "closed",
                "provider_settlement_sha256": None,
                "admission_status": "browser_active",
            },
            {"status": "created"},
        ]
    )
    _install_rpc_connections(monkeypatch, [connection])

    assert d02.persist_d02_voice_terminal_receipt(
        cleanup_obligation_id=CLEANUP_ID,
        admission_id=ADMISSION_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        receipt=receipt,
    )

    finalize_sql, finalize_parameters = connection.rpc_cursor.calls[1]
    assert "voice_terminal_finalize" in finalize_sql
    assert finalize_parameters[3] == receipt["receipt_sha256"]
    assert finalize_parameters[3] != _canonical_hash(receipt)


def test_d02_database_continuity_replays_before_current_freshness_check(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del d02_local
    body = _continuity_body(
        phase="before_api_restart",
        observed_at="2000-01-01T00:00:00.000Z",
    )
    request_sha256 = _canonical_hash(body.model_dump(mode="json"))
    stored = d02._sign_receipt(
        {"authority_key_id": "gateway-d02-v1", "marker": "late-replay"}
    )
    connection = _RpcConnection(
        [
            {
                "status": "existing",
                "request_sha256": request_sha256,
                "receipt": stored,
            }
        ]
    )
    _install_rpc_connections(monkeypatch, [connection])

    assert d02._observe_continuity_database(
        body,
        request_sha256=request_sha256,
        capability_jti_sha256="b" * 64,
    ) == stored
    statement, parameters = connection.rpc_cursor.calls[0]
    assert "continuity_authorize" in statement
    assert "%s::timestamptz" in statement
    assert parameters[-1] == "2000-01-01T00:00:00.000Z"


def test_d02_relay_response_loss_replays_exact_uuid_parameters_and_proof(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del d02_local
    relay_uuid = "823e4567-e89b-42d3-a456-426614174000"
    monkeypatch.setattr(d02.uuid, "uuid4", lambda: d02.uuid.UUID(relay_uuid))
    first = _RpcConnection([True], lose_commit_response=True)
    second = _RpcConnection([True])
    factory = _install_rpc_connections(monkeypatch, [first, second])

    assert d02._relay_begin_sync(
        cleanup_obligation_id=CLEANUP_ID,
        provider_session_id=PROVIDER_SESSION_ID,
        provider_connection_epoch=1,
        relay_kind="event_stream",
    ) == relay_uuid

    assert len(factory.returned) == 2
    first_call = factory.returned[0].rpc_cursor.calls[0]
    second_call = factory.returned[1].rpc_cursor.calls[0]
    assert first_call == second_call
    assert "sophia_voice_lab_d02_relay_begin" in first_call[0]


def test_d02_relay_refresh_paths_serialize_with_distinct_one_time_operations(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del d02_local
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL",
        "postgresql://gateway-rpc-test",
    )
    operation_ids = iter(("c" * 64, "d" * 64))
    monkeypatch.setattr(d02, "_relay_operation_id_sha256", lambda: next(operation_ids))
    active = 0
    maximum_active = 0
    state_lock = threading.Lock()
    calls: list[tuple[object, ...]] = []

    def invoke(
        dsn: str,
        statement: str,
        parameters: tuple[object, ...],
    ) -> bool:
        nonlocal active, maximum_active
        del dsn, statement
        with state_lock:
            active += 1
            maximum_active = max(maximum_active, active)
            calls.append(parameters)
        time.sleep(0.02)
        with state_lock:
            active -= 1
        return True

    monkeypatch.setattr(d02, "_relay_rpc_boolean_exact_replay", invoke)
    operation_lock = threading.Lock()
    relay_id = "923e4567-e89b-42d3-a456-426614174000"
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                d02._relay_refresh_sync,
                relay_id,
                CLEANUP_ID,
                operation_lock,
            )
            for _ in range(2)
        ]
        assert [future.result() for future in futures] == [True, True]

    assert maximum_active == 1
    assert {parameters[4] for parameters in calls} == {"c" * 64, "d" * 64}


def test_d02_local_relay_end_never_holds_router_lock_while_waiting_on_cleanup(
    d02_local: tuple[_LocalStore, Ed25519PrivateKey],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del d02_local
    relay_id = "a23e4567-e89b-42d3-a456-426614174000"
    with d02._LOCAL_LOCK:
        d02._LOCAL_RELAY_LEASES[relay_id] = {
            "cleanup_obligation_id": CLEANUP_ID,
            "owner_instance_id_sha256": (
                d02._GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256
            ),
        }
    cleanup_fence._register_local_d02_relay(relay_id, CLEANUP_ID)

    unregister_entered = threading.Event()
    original_unregister = cleanup_fence._unregister_local_d02_relay

    def observed_unregister(value: str) -> None:
        unregister_entered.set()
        original_unregister(value)

    monkeypatch.setattr(
        cleanup_fence,
        "_unregister_local_d02_relay",
        observed_unregister,
    )
    operation_lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with cleanup_fence._LOCAL_LOCK:
            future = pool.submit(
                d02._relay_end_sync,
                relay_id,
                CLEANUP_ID,
                operation_lock,
            )
            assert unregister_entered.wait(timeout=1)
            router_lock_acquired = d02._LOCAL_LOCK.acquire(timeout=0.5)
            if router_lock_acquired:
                d02._LOCAL_LOCK.release()
            assert router_lock_acquired
        future.result(timeout=1)

    assert relay_id not in d02._LOCAL_RELAY_LEASES
    assert not cleanup_fence._local_d02_relay_present(CLEANUP_ID)


def test_d02_runtime_database_paths_contain_no_direct_governed_table_sql() -> None:
    runtime_functions = (
        d02._freeze_database,
        d02.d02_freeze_for_provider_admission,
        d02.assert_d02_producer_open,
        d02.d02_cleanup_sources_zero,
        d02.persist_d02_voice_terminal_receipt,
        d02._settle_database,
        d02._relay_begin_sync,
        d02._relay_refresh_sync,
        d02._relay_end_sync,
        d02._observe_continuity_database,
    )
    runtime_source = "\n".join(inspect.getsource(function) for function in runtime_functions)
    for table in (
        "public.sophia_sessions",
        "public.sophia_voice_lab_cleanup_obligations",
        "public.sophia_voice_lab_cleanup_admissions",
        "public.sophia_voice_lab_d02_gateway_capability_uses",
        "public.sophia_voice_lab_d02_gateway_finalize_authority",
        "public.sophia_voice_lab_d02_gateway_settlements",
        "public.sophia_voice_lab_d02_gateway_relay_leases",
        "public.sophia_voice_lab_d02_product_continuity_observations",
    ):
        assert table not in runtime_source
