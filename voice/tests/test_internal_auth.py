from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import voice.server as voice_server
from voice.internal_auth import (
    VOICE_INTERNAL_AUTH_HEADER,
    VOICE_LAB_CAPABILITY_HEADER,
    capability_for_production_start,
    capability_for_retention_reap,
    require_voice_internal_auth,
    voice_security_readiness,
    voice_service_identity,
)
from voice.internal_auth import _verify_runtime_capability

BUILD = "41a9b127af780bbe9d88acf34566a6aaf443e6b0"
CAPABILITY_SECRET = "capability-secret-at-least-thirty-two-bytes"
INTERNAL_SECRET = "internal-service-secret-at-least-thirty-two-bytes"
PROVIDER_EXPIRES_AT = "2033-05-18T04:03:20.000Z"
CLEANUP_ADMISSION_ID = "9f4a1c98-7d72-4d87-ae38-6c1b238d4fd9"
CLEANUP_ADMISSION_EXPIRES_AT = "2033-05-18T04:01:20.000Z"
D02_OWNERSHIP = {
    "voice_lab_run_id_sha256": hashlib.sha256(b"voice-lab-run-d02").hexdigest(),
    "browser_worker_id_sha256": hashlib.sha256(b"browser-worker-d02").hexdigest(),
    "browser_lease_epoch": 7,
    "browser_context_id_sha256": hashlib.sha256(b"browser-context-d02").hexdigest(),
}


def _claims(**overrides: object) -> dict[str, object]:
    now = int(time.time())
    payload: dict[str, object] = {
        "v": 1,
        "iss": "sophia-gateway",
        "aud": "sophia-voice-runtime",
        "sub": "voice-lab-user-1",
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-001",
        "scenario_id": "vt00-realtime-001",
        "scenario_version": "v1",
        "synthetic": True,
        "environment": "production",
        "retention_hours": 24,
        "cleanup_obligation_id": "123e4567-e89b-42d3-a456-426614174000",
        "provider_expires_at": PROVIDER_EXPIRES_AT,
        "allowed_ops": ["voice:start"],
        "expected_deployment": {"frontend": BUILD, "backend": BUILD, "voice": BUILD},
        "iat": now,
        "nbf": now,
        "exp": now + 120,
        "jti": "jti-runtime-001",
        "nonce": "nonce-001",
    }
    payload.update(overrides)
    return payload


def _sign(payload: dict[str, object], secret: str = CAPABILITY_SECRET) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).rstrip(b"=")
    signature = hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).digest()
    return f"{encoded.decode('ascii')}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')}"


def _request(*, internal_secret: str | None = None, capability: str | None = None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if internal_secret:
        headers.append((VOICE_INTERNAL_AUTH_HEADER.lower().encode(), internal_secret.encode()))
    if capability:
        headers.append((VOICE_LAB_CAPABILITY_HEADER.lower().encode(), capability.encode()))
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/production/realtime/gemini/browser-sessions",
            "headers": headers,
            "scheme": "https",
            "server": ("sophia-voice.onrender.com", 443),
        }
    )


def _synthetic_context() -> dict[str, str | bool | int]:
    return {
        "synthetic": True,
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-001",
        "scenario_id": "vt00-realtime-001",
        "scenario_version": "v1",
        "environment": "production",
        "retention_hours": 24,
        "cleanup_obligation_id": "123e4567-e89b-42d3-a456-426614174000",
        "provider_expires_at": PROVIDER_EXPIRES_AT,
    }


def _cleanup_admission_fields(session_id: str) -> dict[str, str]:
    return {
        "session_id": session_id,
        "cleanup_admission_id": CLEANUP_ADMISSION_ID,
        "cleanup_admission_expires_at": CLEANUP_ADMISSION_EXPIRES_AT,
        "cleanup_resource_expires_at": PROVIDER_EXPIRES_AT,
    }


@pytest.fixture
def protected_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_REQUIRED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", "false")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENVIRONMENT", "production")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_CAPABILITY_SECRET", CAPABILITY_SECRET)
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "https://sophia-gateway.onrender.com")
    monkeypatch.setenv("RENDER_GIT_COMMIT", BUILD)


def _assert_capability_code(
    token: str | None,
    code: str,
    *,
    context: dict[str, str | bool | int] | None = None,
) -> None:
    with pytest.raises(HTTPException) as exc_info:
        capability_for_production_start(
            _request(capability=token),
            user_id="voice-lab-user-1",
            synthetic_context=context if context is not None else _synthetic_context(),
        )
    assert exc_info.value.detail == {"code": code}
    assert CAPABILITY_SECRET not in str(exc_info.value.detail)


def test_internal_auth_accepts_only_constant_time_exact_secret(protected_env: None) -> None:
    require_voice_internal_auth(_request(internal_secret=INTERNAL_SECRET))
    for supplied in (None, "wrong-secret-that-is-at-least-thirty-two-bytes"):
        with pytest.raises(HTTPException) as exc_info:
            require_voice_internal_auth(_request(internal_secret=supplied))
        assert exc_info.value.status_code == 401
        assert exc_info.value.detail == {"code": "voice_internal_auth_required"}


def test_internal_auth_fails_closed_when_production_secret_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", raising=False)
    with pytest.raises(HTTPException) as exc_info:
        require_voice_internal_auth(_request())
    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == {"code": "voice_internal_auth_configuration_missing"}


def test_voice_lab_readiness_uses_signed_retention_instead_of_fixed_environment_policy(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    readiness = voice_security_readiness()
    assert readiness["voice_lab_enabled"] is True
    assert readiness["voice_lab_kill_switch_engaged"] is False
    assert readiness["voice_lab_mutation_ready"] is True

    monkeypatch.delenv("SOPHIA_VOICE_LAB_BUILDER_RETENTION_SECONDS", raising=False)
    assert voice_security_readiness()["voice_lab_enabled"] is True


@pytest.mark.parametrize("kill_switch", [None, "true", "invalid"])
def test_voice_lab_readiness_reports_missing_or_nonfalse_kill_switch_engaged(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
    kill_switch: str | None,
) -> None:
    if kill_switch is None:
        monkeypatch.delenv("SOPHIA_VOICE_LAB_KILL_SWITCH", raising=False)
    else:
        monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", kill_switch)

    readiness = voice_security_readiness()

    assert readiness["voice_lab_enabled"] is True
    assert readiness["voice_lab_kill_switch_engaged"] is True
    assert readiness["voice_lab_mutation_ready"] is False


def test_runtime_accepts_exact_synthetic_capability(protected_env: None) -> None:
    claims = capability_for_production_start(
        _request(capability=_sign(_claims())),
        user_id="voice-lab-user-1",
        synthetic_context=_synthetic_context(),
    )
    assert claims is not None
    assert claims.test_run_id == "run-001"


def test_runtime_preserves_exact_v_d02_browser_ownership_quartet(
    protected_env: None,
) -> None:
    payload = _claims(scenario_id="V-D02", **D02_OWNERSHIP)
    context = {**_synthetic_context(), "scenario_id": "V-D02", **D02_OWNERSHIP}
    claims = capability_for_production_start(
        _request(capability=_sign(payload)),
        user_id="voice-lab-user-1",
        synthetic_context=context,
    )
    assert claims is not None
    assert claims.synthetic_context() == context

    malformed = [
        _claims(scenario_id="V-D02"),
        _claims(
            scenario_id="V-D02",
            **{**D02_OWNERSHIP, "browser_context_id_sha256": None},
        ),
        _claims(
            scenario_id="V-D02",
            **{**D02_OWNERSHIP, "browser_lease_epoch": 0},
        ),
        _claims(**D02_OWNERSHIP),
    ]
    for candidate in malformed:
        with pytest.raises(HTTPException) as exc_info:
            _verify_runtime_capability(
                _sign(candidate),
                principal_id="voice-lab-user-1",
                environment="production",
                required_operation="voice:start",
            )
        assert exc_info.value.detail == {"code": "voice_lab_capability_malformed"}


def test_runtime_consumes_shared_cross_language_hmac_golden_vector(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    vector = json.loads(
        (Path(__file__).resolve().parents[2] / "testdata" / "voice_lab_capability_v1.json").read_text()
    )
    monkeypatch.setattr("voice.internal_auth.time.time", lambda: vector["now_seconds"])
    claims = _verify_runtime_capability(
        vector["token"],
        principal_id="voice-lab-user-1",
        environment="production",
        required_operation="session:create",
    )
    assert claims.test_run_id == "golden-run-001"
    expected = {
        "invalid_signature": "voice_lab_capability_invalid_signature",
        "noncanonical_base64": "voice_lab_capability_invalid_signature",
        "non_object_payload": "voice_lab_capability_malformed",
        "three_parts": "voice_lab_capability_malformed",
    }
    for name, code in expected.items():
        with pytest.raises(HTTPException) as exc_info:
            _verify_runtime_capability(
                vector["malformed"][name],
                principal_id="voice-lab-user-1",
                environment="production",
                required_operation="session:create",
            )
        assert exc_info.value.detail == {"code": code}
    for case in vector["strict_malformed_claims"]:
        payload = {**vector["payload"], **case["overrides"]}
        with pytest.raises(HTTPException) as exc_info:
            _verify_runtime_capability(
                _sign(payload, vector["secret"]),
                principal_id="voice-lab-user-1",
                environment="production",
                required_operation="session:create",
            )
        assert exc_info.value.detail == {"code": case["expected_code"]}


@pytest.mark.parametrize(
    ("token", "code"),
    [
        (None, "voice_lab_capability_missing"),
        ("malformed", "voice_lab_capability_malformed"),
        (_sign(_claims(), "another-secret-that-is-at-least-thirty-two-bytes"), "voice_lab_capability_invalid_signature"),
        (
            _sign(
                _claims(
                    iat=int(time.time()) - 120,
                    nbf=int(time.time()) - 120,
                    exp=int(time.time()) - 1,
                )
            ),
            "voice_lab_capability_expired_or_not_yet_valid",
        ),
        (_sign(_claims(aud="sophia-voice-gateway")), "voice_lab_capability_wrong_audience"),
        (_sign(_claims(sub="ordinary-user", principal_id="ordinary-user")), "voice_lab_capability_wrong_principal"),
        (_sign(_claims(environment="staging")), "voice_lab_capability_wrong_environment"),
        (_sign(_claims(allowed_ops=["evidence:read"])), "voice_lab_capability_operation_denied"),
        (
            _sign(_claims(expected_deployment={"frontend": BUILD, "backend": BUILD, "voice": "a" * 40})),
            "voice_lab_capability_deployment_mismatch",
        ),
    ],
)
def test_runtime_rejects_negative_capability_matrix(
    token: str | None,
    code: str,
    protected_env: None,
) -> None:
    _assert_capability_code(token, code)


def test_runtime_rejects_synthetic_context_mismatch(protected_env: None) -> None:
    context = _synthetic_context()
    context["test_run_id"] = "run-spoofed"
    _assert_capability_code(
        _sign(_claims()),
        "voice_lab_synthetic_context_mismatch",
        context=context,
    )


def test_retention_reap_is_the_only_operation_allowed_across_voice_deploys(
    protected_env: None,
) -> None:
    old_voice_sha = "a" * 40
    token = _sign(
        _claims(
            allowed_ops=["session:recover", "session:retention-reap"],
            expected_deployment={
                "frontend": BUILD,
                "backend": BUILD,
                "voice": old_voice_sha,
            },
            provider_session_id="provider-session-old-deploy",
        )
    )

    claims = _verify_runtime_capability(
        token,
        principal_id="voice-lab-user-1",
        environment="production",
        required_operation="session:retention-reap",
    )
    assert claims.expected_deployment["voice"] == old_voice_sha
    assert claims.provider_session_id == "provider-session-old-deploy"

    with pytest.raises(HTTPException) as exc_info:
        _verify_runtime_capability(
            token,
            principal_id="voice-lab-user-1",
            environment="production",
            required_operation="session:recover",
        )
    assert exc_info.value.detail == {"code": "voice_lab_capability_deployment_mismatch"}


def test_retention_reap_requires_exact_provider_session_binding(
    protected_env: None,
) -> None:
    token = _sign(
        _claims(
            allowed_ops=["session:retention-reap"],
            provider_session_id="provider-session-exact",
        )
    )

    with pytest.raises(HTTPException) as exc_info:
        capability_for_retention_reap(
            _request(capability=token),
            provider_session_id="provider-session-near-miss",
            synthetic_context=None,
        )
    assert exc_info.value.detail == {
        "code": "voice_lab_provider_session_binding_mismatch"
    }


def test_runtime_rejects_untrusted_synthetic_body_for_ordinary_user(protected_env: None) -> None:
    with pytest.raises(HTTPException) as exc_info:
        capability_for_production_start(
            _request(),
            user_id="ordinary-user",
            synthetic_context=_synthetic_context(),
        )
    assert exc_info.value.detail == {"code": "voice_lab_synthetic_context_without_capability"}


def test_direct_production_route_rejects_missing_internal_auth_before_provider(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    provider = AsyncMock(side_effect=AssertionError("provider allocation must not run"))
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "start_browser_session", provider)
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions",
        json={"user_id": "ordinary-user"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_internal_auth_required"}
    provider.assert_not_awaited()


def test_direct_dogfood_route_rejects_missing_internal_auth_before_provider(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    provider = AsyncMock(side_effect=AssertionError("provider allocation must not run"))
    monkeypatch.setattr(voice_server.gemini_browser_dogfood_sessions, "start_browser_session", provider)
    app = FastAPI()
    app.include_router(voice_server.dogfood_router)
    response = TestClient(app).post(
        "/dogfood/realtime/gemini/browser-sessions",
        json={"user_id": "ordinary-user"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_internal_auth_required"}
    provider.assert_not_awaited()


def test_all_browser_provider_event_relays_reject_direct_external_calls(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    production_provider = AsyncMock(
        side_effect=AssertionError("production provider relay must not run")
    )
    dogfood_provider = AsyncMock(
        side_effect=AssertionError("dogfood provider relay must not run")
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "ingest_browser_provider_event",
        production_provider,
    )
    monkeypatch.setattr(
        voice_server.gemini_browser_dogfood_sessions,
        "ingest_browser_provider_event",
        dogfood_provider,
    )
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    app.include_router(voice_server.dogfood_router)
    client = TestClient(app)

    for path in (
        "/production/realtime/gemini/browser-sessions/session-1/provider-events",
        "/dogfood/realtime/gemini/browser-sessions/session-1/provider-events",
        "/dogfood/realtime/sessions/session-1/provider-events",
    ):
        response = client.post(path, json={"event": {"type": "provider.fixture"}})
        assert response.status_code == 401
        assert response.json()["detail"] == {"code": "voice_internal_auth_required"}
    production_provider.assert_not_awaited()
    dogfood_provider.assert_not_awaited()


def test_health_and_version_remain_public_without_internal_auth() -> None:
    app = voice_server.create_fastapi_app(SimpleNamespace())
    client = TestClient(app)

    health = client.get("/health")
    version = client.get("/version")

    assert health.status_code == 200
    assert health.json() == {"status": "ok", "service": "sophia-voice"}
    assert version.status_code == 200
    assert version.json()["service"] == "sophia-voice"


def test_direct_call_resource_rejects_missing_internal_auth_before_session_allocation(
    protected_env: None,
) -> None:
    launcher = SimpleNamespace(
        start_session=AsyncMock(side_effect=AssertionError("session allocation must not run")),
    )
    app = voice_server.create_fastapi_app(launcher)
    response = TestClient(app).post(
        "/calls/sophia-test/sessions",
        json={"call_type": "default", "platform": "voice"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_internal_auth_required"}
    launcher.start_session.assert_not_awaited()


def test_direct_production_route_rejects_missing_capability_for_test_principal_before_provider(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    provider = AsyncMock(side_effect=AssertionError("provider allocation must not run"))
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "start_browser_session", provider)
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions",
        headers={VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET},
        json={"user_id": "voice-lab-user-1", "synthetic_test": _synthetic_context()},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_lab_capability_missing"}
    provider.assert_not_awaited()


def test_synthetic_start_is_validated_and_memory_isolated_before_provider(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    browser_session = SimpleNamespace(
        as_public_payload=lambda: {
            "session_id": "gemini-prod-synthetic",
            "ephemeral_token": {"value": "redacted-test-token"},
        }
    )
    provider = AsyncMock(return_value=browser_session)
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "start_browser_session", provider)
    monkeypatch.setattr(voice_server, "get_settings", lambda: object())
    monkeypatch.setattr(voice_server, "validate_live_voice_server_runtime", lambda _settings: None)
    context = {
        "diagnostics": {"dynamic_retrieve_configured": False},
        "synthetic_test": _synthetic_context(),
    }
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(_claims()),
        },
        json={
            "user_id": "voice-lab-user-1",
            **_cleanup_admission_fields("gemini-prod-synthetic"),
            "realtime_context": context,
            "synthetic_test": _synthetic_context(),
        },
    )
    assert response.status_code == 201
    assert response.json()["synthetic_test"]["test_run_id"] == "run-001"
    upstream_context = provider.await_args.kwargs["realtime_context"]
    assert "dynamic_memory_retrieval" not in upstream_context
    assert upstream_context["diagnostics"]["memory_retrieval_disabled"] is True


def test_governed_trace_fault_is_authorized_and_applied_before_provider(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    context = {
        **_synthetic_context(),
        "scenario_id": "V-L01",
        "scenario_version": "vt00.scenarios.v1",
    }
    browser_session = SimpleNamespace(
        as_public_payload=lambda: {
            "session_id": "gemini-prod-trace-fault",
            "ephemeral_token": {"value": "redacted-test-token"},
        }
    )
    provider = AsyncMock(return_value=browser_session)
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "start_browser_session", provider)
    monkeypatch.setattr(voice_server, "get_settings", lambda: object())
    monkeypatch.setattr(voice_server, "validate_live_voice_server_runtime", lambda _settings: None)
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(
                    scenario_id="V-L01",
                    scenario_version="vt00.scenarios.v1",
                    allowed_ops=["voice:start", "trace:fault"],
                )
            ),
        },
        json={
            "user_id": "voice-lab-user-1",
            **_cleanup_admission_fields("gemini-prod-trace-fault"),
            "realtime_context": {"diagnostics": {}, "synthetic_test": context},
            "synthetic_test": context,
            "synthetic_trace_mode": "langsmith_unavailable",
        },
    )
    assert response.status_code == 201
    receipt = response.json()["trace_fault"]
    assert receipt == provider.await_args.kwargs["trace_fault_receipt"]
    assert receipt["schema"] == "sophia_voice_lab_trace_fault_v1"
    assert receipt["phase"] == "applied"
    assert receipt["test_run_id"] == "run-001"
    assert receipt["scenario_id"] == "V-L01"
    assert receipt["trace_unavailable"] is True
    assert receipt["canonical_behavior_unchanged"] is True
    assert receipt["restored_at"] is None


@pytest.mark.parametrize(
    ("allowed_ops", "mode", "expected_code"),
    [
        (["voice:start"], "langsmith_unavailable", "voice_lab_capability_operation_denied"),
        (["voice:start", "trace:fault"], None, "voice_lab_trace_fault_mode_required"),
    ],
)
def test_governed_trace_fault_rejects_before_provider_without_exact_authority(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
    allowed_ops: list[str],
    mode: str | None,
    expected_code: str,
) -> None:
    provider = AsyncMock(side_effect=AssertionError("provider allocation must not run"))
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "start_browser_session", provider)
    context = {
        **_synthetic_context(),
        "scenario_id": "V-L01",
        "scenario_version": "vt00.scenarios.v1",
    }
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    body: dict[str, object] = {
        "user_id": "voice-lab-user-1",
        **_cleanup_admission_fields("gemini-prod-trace-fault-rejected"),
        "realtime_context": {"diagnostics": {}, "synthetic_test": context},
        "synthetic_test": context,
    }
    if mode is not None:
        body["synthetic_trace_mode"] = mode
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(
                    scenario_id="V-L01",
                    scenario_version="vt00.scenarios.v1",
                    allowed_ops=allowed_ops,
                )
            ),
        },
        json=body,
    )
    assert response.status_code in {403, 409}
    assert response.json()["detail"] == {"code": expected_code}
    provider.assert_not_awaited()


def test_governed_trace_fault_restoration_receipt_is_server_authored(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    context = {
        **_synthetic_context(),
        "scenario_id": "V-L01",
        "scenario_version": "vt00.scenarios.v1",
    }
    applied = {
        "schema": "sophia_voice_lab_trace_fault_v1",
        "fault": "langsmith_unavailable",
        "phase": "applied",
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-001",
        "scenario_id": "V-L01",
        "scenario_version": "vt00.scenarios.v1",
        "environment": "production",
        "expected_deployment": {"frontend": BUILD, "backend": BUILD, "voice": BUILD},
        "trace_unavailable": True,
        "canonical_behavior_unchanged": True,
        "applied_at": "2026-08-23T12:00:00+00:00",
        "restored_at": None,
    }
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "synthetic_context_for_session",
        lambda _session_id: context,
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "trace_fault_for_session",
        lambda _session_id: applied,
    )
    close = AsyncMock(return_value=True)
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "close_session", close)
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).request(
        "DELETE",
        "/production/realtime/gemini/browser-sessions/gemini-prod-trace-fault",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(
                    scenario_id="V-L01",
                    scenario_version="vt00.scenarios.v1",
                    allowed_ops=["session:finalize"],
                )
            ),
        },
        json={"session_id": "gemini-prod-trace-fault"},
    )
    assert response.status_code == 202
    restored = response.json()["trace_fault"]
    assert restored["phase"] == "restored"
    assert restored["applied_at"] == applied["applied_at"]
    assert restored["restored_at"] is not None
    close.assert_awaited_once()


def test_ordinary_production_start_uses_internal_auth_without_lab_capability(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    browser_session = SimpleNamespace(
        as_public_payload=lambda: {
            "session_id": "gemini-prod-ordinary",
            "ephemeral_token": {"value": "redacted-test-token"},
        }
    )
    provider = AsyncMock(return_value=browser_session)
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "start_browser_session", provider)
    monkeypatch.setattr(voice_server, "get_settings", lambda: object())
    monkeypatch.setattr(voice_server, "validate_live_voice_server_runtime", lambda _settings: None)
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions",
        headers={VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET},
        json={"user_id": "ordinary-user", "realtime_context": {"diagnostics": {}}},
    )
    assert response.status_code == 201
    assert "synthetic_test" not in response.json()
    provider.assert_awaited_once()


def test_synthetic_start_rejects_dynamic_memory_config_before_provider(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    provider = AsyncMock(side_effect=AssertionError("provider allocation must not run"))
    monkeypatch.setattr(voice_server.gemini_production_browser_sessions, "start_browser_session", provider)
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(_claims()),
        },
        json={
            "user_id": "voice-lab-user-1",
            **_cleanup_admission_fields("gemini-prod-memory-rejected"),
            "realtime_context": {
                "synthetic_test": _synthetic_context(),
                "dynamic_memory_retrieval": {"token": "must-never-be-used"},
            },
            "synthetic_test": _synthetic_context(),
        },
    )
    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "voice_lab_memory_retrieval_forbidden"}
    provider.assert_not_awaited()


def test_existing_synthetic_session_rejects_cross_run_relay_before_provider_mutation(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    provider = AsyncMock(side_effect=AssertionError("cross-run relay must not execute"))
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "synthetic_context_for_session",
        lambda _session_id: _synthetic_context(),
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "ingest_browser_provider_event",
        provider,
    )
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions/gemini-prod-synthetic/provider-events",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(test_run_id="run-other", allowed_ops=["session:create"])
            ),
        },
        json={"event": {"setupComplete": {}}},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "voice_lab_synthetic_context_mismatch"}
    provider.assert_not_awaited()


def test_kill_switch_blocks_connected_synthetic_relay_but_allows_disconnect(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", "true")
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "synthetic_context_for_session",
        lambda _session_id: _synthetic_context(),
    )
    provider = AsyncMock(side_effect=AssertionError("kill-switched relay must not execute"))
    close = AsyncMock(return_value=True)
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "ingest_browser_provider_event",
        provider,
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "close_session",
        close,
    )
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    client = TestClient(app)
    relay = client.post(
        "/production/realtime/gemini/browser-sessions/gemini-prod-synthetic/provider-events",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(allowed_ops=["session:create"])
            ),
        },
        json={"event": {"setupComplete": {}}},
    )
    assert relay.status_code == 403
    assert relay.json()["detail"] == {"code": "voice_lab_kill_switch_active"}
    provider.assert_not_awaited()

    disconnected = client.request(
        "DELETE",
        "/production/realtime/gemini/browser-sessions/gemini-prod-synthetic",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(allowed_ops=["session:finalize"])
            ),
        },
        json={"session_id": "gemini-prod-synthetic"},
    )
    assert disconnected.status_code == 202
    close.assert_awaited_once()


def test_retention_reap_authenticates_missing_session_after_voice_restart(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    provider_session_id = "provider-session-lost-after-restart"
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "false")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", "true")
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "session_exists",
        lambda _session_id: False,
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "synthetic_context_for_session",
        lambda _session_id: None,
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "trace_fault_for_session",
        lambda _session_id: None,
    )
    cleanup_request = AsyncMock(return_value=False)
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "request_browser_cleanup",
        cleanup_request,
    )
    token = _sign(
        _claims(
            allowed_ops=["session:retention-reap"],
            expected_deployment={
                "frontend": BUILD,
                "backend": BUILD,
                "voice": "a" * 40,
            },
            provider_session_id=provider_session_id,
        )
    )
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)

    response = TestClient(app).request(
        "DELETE",
        f"/production/realtime/gemini/browser-sessions/{provider_session_id}",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: token,
        },
        json={"session_id": provider_session_id},
    )

    assert response.status_code == 404
    assert "not found" in response.json()["detail"]
    cleanup_request.assert_awaited_once_with(provider_session_id)


def test_ordinary_missing_session_remains_an_ordinary_not_found(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "session_exists",
        lambda _session_id: False,
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "synthetic_context_for_session",
        lambda _session_id: None,
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "trace_fault_for_session",
        lambda _session_id: None,
    )
    close = AsyncMock(return_value=False)
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "close_session",
        close,
    )
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)

    response = TestClient(app).request(
        "DELETE",
        "/production/realtime/gemini/browser-sessions/ordinary-missing",
        headers={VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET},
        json={"session_id": "ordinary-missing"},
    )

    assert response.status_code == 404
    close.assert_awaited_once()


def test_synthetic_continuation_retains_exact_product_provenance(
    monkeypatch: pytest.MonkeyPatch,
    protected_env: None,
) -> None:
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "synthetic_context_for_session",
        lambda _session_id: _synthetic_context(),
    )
    continuation = SimpleNamespace(
        as_public_payload=lambda: {
            "session_id": "gemini-prod-synthetic",
            "provider_connection_epoch": 2,
        }
    )
    monkeypatch.setattr(
        voice_server.gemini_production_browser_sessions,
        "continue_browser_session",
        AsyncMock(return_value=continuation),
    )
    monkeypatch.setattr(voice_server, "get_settings", lambda: object())
    monkeypatch.setattr(voice_server, "validate_live_voice_server_runtime", lambda _settings: None)
    app = FastAPI()
    app.include_router(voice_server.production_realtime_router)
    response = TestClient(app).post(
        "/production/realtime/gemini/browser-sessions/gemini-prod-synthetic/continuation-bootstrap",
        headers={
            VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(allowed_ops=["session:create"])
            ),
        },
        json={"expected_epoch": 1, "handle_present": True, "secret_generation": 1},
    )
    assert response.status_code == 200
    assert response.json()["synthetic_test"] == _synthetic_context()


def test_version_identity_is_public_and_readiness_routes_remain_public(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RENDER_GIT_COMMIT", BUILD)
    monkeypatch.setenv("RENDER_DEPLOY_ID", "dep-test")
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_REQUIRED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    identity = voice_service_identity()
    assert identity["build_id"] == BUILD
    assert identity["deployment_id"] == "dep-test"
    assert identity["memory_contract_schema"] == "mem00.v1"
    assert identity["memory_supported_contract_epoch"] == 1

    app = voice_server.create_fastapi_app(SimpleNamespace())
    routes = {getattr(route, "path", None) for route in app.routes}
    assert "/version" in routes
    assert "/health" in routes
    assert "/ready" in routes
    response = TestClient(app).get("/version")
    assert response.status_code == 200
    assert response.json()["build_id"] == BUILD
    assert response.json()["memory_contract_schema"] == "mem00.v1"
    assert response.json()["memory_supported_contract_epoch"] == 1
