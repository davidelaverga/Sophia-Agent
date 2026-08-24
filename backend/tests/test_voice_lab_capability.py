from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.gateway import auth as gateway_auth
from app.gateway.app import _gateway_protected_plane_readiness
from app.gateway.auth import (
    require_authenticated_user,
    require_authorized_user_scope,
    voice_lab_governed_route_operations,
)
from app.gateway.routers import sessions as sessions_router
from app.gateway.routers import voice as voice_router
from app.gateway.voice_lab_capability import (
    VOICE_INTERNAL_AUTH_HEADER,
    VOICE_LAB_CAPABILITY_HEADER,
    VOICE_LAB_PROVIDER_CLEANUP_HEADER,
    capability_for_gateway_action,
    capability_for_voice_connect,
    mint_provider_cleanup_token,
    verify_capability,
    verify_provider_cleanup_token,
    voice_internal_auth_headers,
)

BUILD = "41a9b127af780bbe9d88acf34566a6aaf443e6b0"
SECRET = "capability-secret-at-least-thirty-two-bytes"
INTERNAL_SECRET = "internal-service-secret-at-least-thirty-two-bytes"
AUTH_TOMBSTONE_SECRET = "auth-tombstone-secret-at-least-thirty-two-bytes"
D02_FINALIZE_KEY_ID = "d02-db-finalize-v1"
D02_FINALIZE_SECRET = "d02-database-finalize-secret-at-least-thirty-two-bytes"
D02_REQUIRED_ENV = (
    "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL",
    "SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET",
    "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID",
    "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET",
    "SOPHIA_VOICE_LAB_D02_SETTLEMENT_IDENTITY_HMAC_SECRET",
    "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PRIVATE_KEY_PKCS8_BASE64",
    "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64",
    "SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID",
    "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON",
)


def _clear_d02_readiness_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in D02_REQUIRED_ENV:
        monkeypatch.delenv(name, raising=False)


def _set_disabled_d02_readiness_bundle(
    monkeypatch: pytest.MonkeyPatch,
    *,
    finalize_secret: str = D02_FINALIZE_SECRET,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "false")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL",
        "postgresql://gateway-d02-redacted",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET",
        "d02-capability-secret-at-least-thirty-two-bytes",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID",
        D02_FINALIZE_KEY_ID,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET",
        finalize_secret,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_IDENTITY_HMAC_SECRET",
        "d02-identity-secret-at-least-thirty-two-bytes",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PRIVATE_KEY_PKCS8_BASE64",
        "test-private-key",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64",
        "test-public-key",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID",
        "gateway-d02-test-v1",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON",
        '{"gateway-d02-test-v1":"test-public-key"}',
    )
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )


def _claims(**overrides: object) -> dict[str, object]:
    now = int(time.time())
    payload: dict[str, object] = {
        "v": 1,
        "iss": "sophia-frontend",
        "aud": "sophia-voice-gateway",
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
        "allowed_ops": ["voice:start"],
        "expected_deployment": {"frontend": BUILD, "backend": BUILD, "voice": BUILD},
        "iat": now,
        "nbf": now,
        "exp": now + 120,
        "jti": "jti-001",
        "nonce": "nonce-001",
    }
    payload.update(overrides)
    return payload


def _sign(payload: dict[str, object], secret: str = SECRET) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).rstrip(b"=")
    signature = hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).digest()
    return f"{encoded.decode('ascii')}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')}"


def _canonical_synthetic_stub():
    return type(
        "CanonicalSyntheticStub",
        (),
        {
            "metadata": {
                "synthetic_voice_lab": {
                    "retention_expires_at": "2033-05-19T04:03:20.000Z",
                }
            }
        },
    )()


def _request(token: str | None = None):
    headers = []
    if token:
        headers.append((VOICE_LAB_CAPABILITY_HEADER.lower().encode(), token.encode()))
    return voice_router.Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/sophia/voice-lab-user-1/voice/connect",
            "headers": headers,
            "scheme": "https",
            "server": ("sophia-gateway.onrender.com", 443),
        }
    )


def _auth_request(
    token: str | None,
    *,
    method: str = "POST",
    route_path: str = "/api/sophia/{user_id}/voice/connect",
    concrete_path: str = "/api/sophia/voice-lab-user-1/voice/connect",
    user_id: str | None = "voice-lab-user-1",
    bearer: str | None = None,
    provider_cleanup_token: str | None = None,
):
    headers: list[tuple[bytes, bytes]] = []
    if token is not None:
        headers.append((VOICE_LAB_CAPABILITY_HEADER.lower().encode(), token.encode()))
    if bearer is not None:
        headers.append((b"authorization", f"Bearer {bearer}".encode()))
    if provider_cleanup_token is not None:
        headers.append(
            (
                VOICE_LAB_PROVIDER_CLEANUP_HEADER.lower().encode(),
                provider_cleanup_token.encode(),
            )
        )
    path_params = {"user_id": user_id} if user_id is not None else {}
    return voice_router.Request(
        {
            "type": "http",
            "method": method,
            "path": concrete_path,
            "path_params": path_params,
            "route": SimpleNamespace(path=route_path),
            "headers": headers,
            "scheme": "https",
            "server": ("sophia-gateway.onrender.com", 443),
        }
    )


@pytest.fixture
def voice_lab_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from deerflow.sophia import cleanup_fence

    cleanup_fence._LOCAL_OBLIGATIONS.clear()
    cleanup_fence._LOCAL_ADMISSIONS.clear()
    monkeypatch.delenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL", raising=False)
    monkeypatch.delenv("BETTER_AUTH_DATABASE_URL", raising=False)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", "false")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENVIRONMENT", "production")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_CAPABILITY_SECRET", SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )
    monkeypatch.setenv("RENDER_GIT_COMMIT", BUILD)
    monkeypatch.setattr(
        voice_router,
        "get_voice_lab_retention_reaper_or_none",
        lambda _app: type(
            "ReadyRetentionReaper",
            (),
            {
                "running": True,
                "readiness": lambda self: {"status": "ready", "running": True},
            },
        )(),
    )


def _verify(token: str | None):
    return verify_capability(
        token,
        secret=SECRET,
        audience="sophia-voice-gateway",
        issuer="sophia-frontend",
        principal_id="voice-lab-user-1",
        environment="production",
        required_operation="voice:start",
        expected_build_key="backend",
        expected_build=BUILD,
    )


def _assert_code(
    token: str | None,
    code: str,
    *,
    now_seconds: int | None = None,
) -> None:
    with pytest.raises(HTTPException) as exc_info:
        verify_capability(
            token,
            secret=SECRET,
            audience="sophia-voice-gateway",
            issuer="sophia-frontend",
            principal_id="voice-lab-user-1",
            environment="production",
            required_operation="voice:start",
            expected_build_key="backend",
            expected_build=BUILD,
            now_seconds=now_seconds,
        )
    assert exc_info.value.detail == {"code": code}
    assert SECRET not in str(exc_info.value.detail)


def _expired_capability(now: int) -> str:
    return _sign(_claims(iat=now - 120, nbf=now - 120, exp=now - 1))


def _overlong_capability(now: int) -> str:
    return _sign(_claims(iat=now, nbf=now, exp=now + 301))


def test_gateway_accepts_exact_short_lived_capability(voice_lab_env: None) -> None:
    verified = _verify(_sign(_claims()))
    assert verified.principal_id == "voice-lab-user-1"
    assert verified.synthetic_context()["test_run_id"] == "run-001"


def test_gateway_readiness_uses_signed_retention_instead_of_fixed_environment_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
    )

    from app.gateway.routers import voice_lab_d02_settlement as d02

    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENVIRONMENT", "production")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_CAPABILITY_SECRET", SECRET)
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET",
        "recovery-secret-that-is-at-least-thirty-two-bytes",
    )
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS",
        json.dumps({"v1": AUTH_TOMBSTONE_SECRET}),
    )
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL", "postgresql://redacted")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL", "postgresql://redacted"
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET",
        "d02-capability-secret-that-is-at-least-thirty-two-bytes",
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID",
        D02_FINALIZE_KEY_ID,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET",
        D02_FINALIZE_SECRET,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_IDENTITY_HMAC_SECRET",
        "d02-identity-secret-that-is-at-least-thirty-two-bytes",
    )
    private_key = Ed25519PrivateKey.generate()
    private_key_base64 = base64.b64encode(
        private_key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    ).decode()
    public_key_base64 = base64.b64encode(
        private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    ).decode()
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PRIVATE_KEY_PKCS8_BASE64",
        private_key_base64,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64",
        public_key_base64,
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID", "gateway-d02-test-v1"
    )
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON",
        json.dumps({"gateway-d02-test-v1": public_key_base64}),
    )
    monkeypatch.setattr(d02, "assert_d02_gateway_database_ready", lambda: None)
    monkeypatch.setenv("SOPHIA_SESSION_STORE", "supabase")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
    readiness = _gateway_protected_plane_readiness()
    assert readiness["voice_lab_enabled"] is True
    assert readiness["voice_lab_kill_switch_engaged"] is True

    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", "false")
    readiness = _gateway_protected_plane_readiness()
    assert readiness["voice_lab_enabled"] is True
    assert readiness["voice_lab_kill_switch_engaged"] is False

    monkeypatch.delenv("SOPHIA_VOICE_LAB_BUILDER_RETENTION_SECONDS", raising=False)
    assert _gateway_protected_plane_readiness()["voice_lab_enabled"] is True


def test_gateway_readiness_ignores_only_disabled_local_example_placeholders(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("RENDER", "RENDER_SERVICE_ID", "ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "false")
    example_values = {
        line.split("=", 1)[0]: line.split("=", 1)[1]
        for line in (Path(__file__).parents[1] / ".env.example").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    }
    for name in D02_REQUIRED_ENV:
        monkeypatch.setenv(name, example_values[name])

    readiness = _gateway_protected_plane_readiness()

    assert readiness["voice_lab_enabled"] is False


def test_gateway_readiness_rejects_nondefault_finalize_key_without_bundle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("RENDER", "RENDER_SERVICE_ID", "ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)
    _clear_d02_readiness_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "false")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID",
        "d02-db-finalize-v2",
    )

    with pytest.raises(ValueError, match="gateway_voice_lab_d02_configuration_missing"):
        _gateway_protected_plane_readiness()


def test_gateway_readiness_requires_disabled_production_d02_bundle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_d02_readiness_env(monkeypatch)
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("RENDER_SERVICE_ID", raising=False)
    monkeypatch.setenv("RENDER_GIT_COMMIT", BUILD)
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "false")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID",
        D02_FINALIZE_KEY_ID,
    )

    with pytest.raises(ValueError, match="gateway_voice_lab_d02_configuration_missing"):
        _gateway_protected_plane_readiness()


@pytest.mark.parametrize(
    "finalize_secret",
    [D02_FINALIZE_SECRET, " " * 32],
)
def test_gateway_readiness_attests_disabled_provisioned_d02_verbatim_secret(
    monkeypatch: pytest.MonkeyPatch,
    finalize_secret: str,
) -> None:
    from app.gateway.routers import voice_lab_d02_settlement as d02

    for name in ("RENDER", "RENDER_SERVICE_ID", "ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)
    _clear_d02_readiness_env(monkeypatch)
    _set_disabled_d02_readiness_bundle(
        monkeypatch,
        finalize_secret=finalize_secret,
    )
    calls: list[str] = []
    monkeypatch.setattr(d02, "_receipt_private_key", lambda: (object(), "key"))
    monkeypatch.setattr(d02, "_receipt_public_keyring", lambda: {"key": object()})
    monkeypatch.setattr(
        d02,
        "assert_d02_gateway_database_ready",
        lambda: calls.append(os.environ["SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET"]),
    )

    readiness = _gateway_protected_plane_readiness()

    assert readiness["voice_lab_enabled"] is False
    assert calls == [finalize_secret]


def test_gateway_readiness_rejects_reused_database_finalize_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("RENDER", "RENDER_SERVICE_ID", "ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)
    _clear_d02_readiness_env(monkeypatch)
    reused = "d02-capability-secret-at-least-thirty-two-bytes"
    _set_disabled_d02_readiness_bundle(
        monkeypatch,
        finalize_secret=reused,
    )

    with pytest.raises(ValueError, match="gateway_voice_lab_secrets_not_distinct"):
        _gateway_protected_plane_readiness()


def test_gateway_consumes_shared_cross_language_hmac_golden_vector() -> None:
    vector = json.loads((Path(__file__).resolve().parents[2] / "testdata" / "voice_lab_capability_v1.json").read_text())
    verified = verify_capability(
        vector["token"],
        secret=vector["secret"],
        audience="sophia-voice-runtime",
        issuer="sophia-gateway",
        principal_id="voice-lab-user-1",
        environment="production",
        required_operation="session:create",
        expected_build_key="backend",
        expected_build=BUILD,
        now_seconds=vector["now_seconds"],
    )
    assert verified.test_run_id == "golden-run-001"
    malformed = vector["malformed"]
    expected = {
        "invalid_signature": "voice_lab_capability_invalid_signature",
        "noncanonical_base64": "voice_lab_capability_invalid_signature",
        "non_object_payload": "voice_lab_capability_malformed",
        "three_parts": "voice_lab_capability_malformed",
    }
    for name, code in expected.items():
        with pytest.raises(HTTPException) as exc_info:
            verify_capability(
                malformed[name],
                secret=vector["secret"],
                audience="sophia-voice-runtime",
                issuer="sophia-gateway",
                principal_id="voice-lab-user-1",
                environment="production",
                required_operation="session:create",
                expected_build_key="backend",
                expected_build=BUILD,
                now_seconds=vector["now_seconds"],
            )
        assert exc_info.value.detail == {"code": code}
    for case in vector["strict_malformed_claims"]:
        payload = {**vector["payload"], **case["overrides"]}
        with pytest.raises(HTTPException) as exc_info:
            verify_capability(
                _sign(payload, vector["secret"]),
                secret=vector["secret"],
                audience="sophia-voice-runtime",
                issuer="sophia-gateway",
                principal_id="voice-lab-user-1",
                environment="production",
                required_operation="session:create",
                expected_build_key="backend",
                expected_build=BUILD,
                now_seconds=vector["now_seconds"],
            )
        assert exc_info.value.detail == {"code": case["expected_code"]}


@pytest.mark.parametrize(
    ("token_factory", "code"),
    [
        (lambda _now: None, "voice_lab_capability_missing"),
        (lambda _now: "malformed", "voice_lab_capability_malformed"),
        (
            lambda now: _sign(
                _claims(iat=now, nbf=now, exp=now + 120),
                "another-secret-that-is-at-least-thirty-two-bytes",
            ),
            "voice_lab_capability_invalid_signature",
        ),
        (_expired_capability, "voice_lab_capability_expired_or_not_yet_valid"),
        (
            lambda now: _sign(_claims(iat=now, nbf=now, exp=now + 120, aud="wrong-service")),
            "voice_lab_capability_wrong_audience",
        ),
        (
            lambda now: _sign(
                _claims(
                    iat=now,
                    nbf=now,
                    exp=now + 120,
                    sub="ordinary-user",
                    principal_id="ordinary-user",
                )
            ),
            "voice_lab_capability_wrong_principal",
        ),
        (
            lambda now: _sign(_claims(iat=now, nbf=now, exp=now + 120, environment="staging")),
            "voice_lab_capability_wrong_environment",
        ),
        (
            lambda now: _sign(
                _claims(
                    iat=now,
                    nbf=now,
                    exp=now + 120,
                    allowed_ops=["evidence:read"],
                )
            ),
            "voice_lab_capability_operation_denied",
        ),
        (
            lambda now: _sign(_claims(iat=now, nbf=now, exp=now + 120, nonce="")),
            "voice_lab_capability_malformed",
        ),
        (
            lambda now: _sign(
                _claims(
                    iat=now,
                    nbf=now,
                    exp=now + 120,
                    expected_deployment={
                        "frontend": BUILD,
                        "backend": "a" * 40,
                        "voice": BUILD,
                    },
                )
            ),
            "voice_lab_capability_deployment_mismatch",
        ),
        (_overlong_capability, "voice_lab_capability_invalid_lifetime"),
    ],
)
def test_gateway_rejects_negative_capability_matrix(
    token_factory: Callable[[int], str | None],
    code: str,
    voice_lab_env: None,
) -> None:
    frozen_now = 2_000_000_000
    _assert_code(
        token_factory(frozen_now),
        code,
        now_seconds=frozen_now,
    )


def test_gateway_requires_capability_for_exact_dedicated_principal(voice_lab_env: None) -> None:
    with pytest.raises(HTTPException) as exc_info:
        capability_for_voice_connect(_request(), "voice-lab-user-1")
    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == {"code": "voice_lab_capability_missing"}


def test_gateway_leaves_ordinary_authenticated_users_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", raising=False)
    assert capability_for_voice_connect(_request(), "ordinary-user") is None


def _seed_open_cleanup_obligation() -> None:
    from deerflow.sophia.cleanup_fence import assert_cleanup_obligation_open

    assert_cleanup_obligation_open(
        "123e4567-e89b-42d3-a456-426614174000",
        "2033-05-19T04:03:20.000Z",
        "2033-05-18T04:03:20.000Z",
    )


def test_provider_admission_lease_never_exceeds_absolute_deadline(
    voice_lab_env: None,
) -> None:
    from deerflow.sophia.cleanup_fence import reserve_cleanup_admission

    now = datetime.now(UTC)
    provider_deadline = now + timedelta(seconds=30)
    retention_deadline = now + timedelta(hours=1)
    admission = reserve_cleanup_admission(
        "123e4567-e89b-42d3-a456-426614174000",
        retention_deadline,
        provider_expires_at=provider_deadline,
        resource_kind="provider",
        resource_id="provider-short-deadline",
        resource_expires_at=provider_deadline,
    )

    assert admission.lease_expires_at <= provider_deadline
    assert admission.resource_expires_at == provider_deadline


def _provider_cleanup_authority(
    *,
    now_seconds: int | None = None,
    provider_session_id: str = "gemini-provider-session-1",
    cleanup_provider_admission_id: str = "123e4567-e89b-42d3-a456-426614174001",
):
    now = int(time.time()) if now_seconds is None else now_seconds
    provider_deadline = datetime.fromtimestamp(now, UTC) + timedelta(minutes=10)
    retention_deadline = provider_deadline + timedelta(hours=24)
    provider_expires_at = provider_deadline.isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    retention_expires_at = retention_deadline.isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    claims = _verify(_sign(_claims(provider_expires_at=provider_expires_at)))
    return mint_provider_cleanup_token(
        claims,
        provider_session_id,
        cleanup_provider_admission_id,
        retention_expires_at,
        now_seconds=now,
    )


def _provider_cleanup_payload(token: str) -> dict[str, object]:
    encoded_payload = token.split(".", 1)[0]
    return json.loads(
        base64.urlsafe_b64decode(
            encoded_payload + "=" * (-len(encoded_payload) % 4)
        )
    )


def test_provider_cleanup_token_survives_context_expiry_for_exact_settlement(
    voice_lab_env: None,
) -> None:
    now = int(time.time())
    authority = _provider_cleanup_authority(now_seconds=now)
    claims = verify_provider_cleanup_token(
        authority.token,
        secret=SECRET,
        principal_id="voice-lab-user-1",
        environment="production",
        now_seconds=now + 600,
    )

    assert claims.provider_session_id == "gemini-provider-session-1"
    assert (
        claims.cleanup_provider_admission_id
        == "123e4567-e89b-42d3-a456-426614174001"
    )
    assert claims.cleanup_expires_at == authority.cleanup_expires_at
    assert claims.raw["allowed_ops"] == ["provider:settle"]
    assert claims.expires_at == int(
        datetime.fromisoformat(
            authority.cleanup_expires_at.replace("Z", "+00:00")
        ).timestamp()
    )


@pytest.mark.anyio
async def test_provider_cleanup_header_authenticates_only_exact_disconnect_route(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    legacy_auth = AsyncMock(side_effect=AssertionError("legacy /me must not run"))
    monkeypatch.setattr(gateway_auth, "_get_authenticated_user", legacy_auth)
    authority = _provider_cleanup_authority()
    request = _auth_request(
        None,
        route_path="/api/sophia/{user_id}/voice/gemini/disconnect",
        concrete_path=(
            "/api/sophia/voice-lab-user-1/voice/gemini/disconnect"
        ),
        provider_cleanup_token=authority.token,
    )

    assert await require_authorized_user_scope(request) == "voice-lab-user-1"
    cleanup_claims = request.state.voice_lab_provider_cleanup_claims
    assert cleanup_claims.provider_session_id == "gemini-provider-session-1"
    assert cleanup_claims.cleanup_expires_at == authority.cleanup_expires_at
    legacy_auth.assert_not_awaited()


@pytest.mark.anyio
async def test_provider_cleanup_header_is_denied_on_create_or_relay_route(
    voice_lab_env: None,
) -> None:
    authority = _provider_cleanup_authority()
    request = _auth_request(
        None,
        route_path="/api/sophia/{user_id}/voice/gemini/relay",
        concrete_path="/api/sophia/voice-lab-user-1/voice/gemini/relay",
        provider_cleanup_token=authority.token,
    )

    with pytest.raises(HTTPException) as exc_info:
        await require_authorized_user_scope(request)
    assert exc_info.value.detail == {
        "code": "voice_lab_provider_cleanup_route_denied"
    }


@pytest.mark.parametrize(
    ("mutation", "expected_code", "expected_status"),
    [
        (
            lambda payload: payload.update({"allowed_ops": ["session:create"]}),
            "voice_lab_provider_cleanup_operation_denied",
            403,
        ),
        (
            lambda payload: payload.update(
                {"cleanup_provider_admission_id": "wrong-admission"}
            ),
            "voice_lab_provider_cleanup_malformed",
            401,
        ),
    ],
)
def test_provider_cleanup_token_rejects_wrong_op_or_admission(
    mutation: Callable[[dict[str, object]], None],
    expected_code: str,
    expected_status: int,
    voice_lab_env: None,
) -> None:
    now = int(time.time())
    payload = _provider_cleanup_payload(
        _provider_cleanup_authority(now_seconds=now).token
    )
    mutation(payload)
    token = _sign(payload)

    with pytest.raises(HTTPException) as exc_info:
        verify_provider_cleanup_token(
            token,
            secret=SECRET,
            principal_id="voice-lab-user-1",
            environment="production",
            now_seconds=now,
        )
    assert exc_info.value.status_code == expected_status
    assert exc_info.value.detail == {"code": expected_code}


@pytest.mark.anyio
async def test_provider_cleanup_token_survives_rolling_gateway_build_change(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    authority = _provider_cleanup_authority()
    monkeypatch.setenv("RENDER_GIT_COMMIT", "d" * 40)
    request = _auth_request(
        None,
        route_path="/api/sophia/{user_id}/voice/gemini/disconnect",
        concrete_path=(
            "/api/sophia/voice-lab-user-1/voice/gemini/disconnect"
        ),
        provider_cleanup_token=authority.token,
    )

    assert await require_authorized_user_scope(request) == "voice-lab-user-1"
    assert (
        request.state.voice_lab_provider_cleanup_claims.expected_deployment[
            "backend"
        ]
        == BUILD
    )


def test_provider_cleanup_token_rejects_expiry_and_wrong_header(
    voice_lab_env: None,
) -> None:
    now = int(time.time())
    authority = _provider_cleanup_authority(now_seconds=now)
    cleanup_exp = int(
        datetime.fromisoformat(
            authority.cleanup_expires_at.replace("Z", "+00:00")
        ).timestamp()
    )
    with pytest.raises(HTTPException) as exc_info:
        verify_provider_cleanup_token(
            authority.token,
            secret=SECRET,
            principal_id="voice-lab-user-1",
            environment="production",
            now_seconds=cleanup_exp,
        )
    assert exc_info.value.detail == {
        "code": "voice_lab_provider_cleanup_expired_or_not_yet_valid"
    }

    wrong_header_request = _auth_request(
        authority.token,
        route_path="/api/sophia/{user_id}/voice/gemini/disconnect",
        concrete_path=(
            "/api/sophia/voice-lab-user-1/voice/gemini/disconnect"
        ),
    )
    with pytest.raises(HTTPException) as wrong_header:
        capability_for_gateway_action(
            wrong_header_request,
            "voice-lab-user-1",
            required_operation="session:finalize",
        )
    assert wrong_header.value.status_code == 401


def _seed_provider_settlement(
    monkeypatch: pytest.MonkeyPatch,
    *,
    provider_state: str = "credential_minted",
    activated_epoch: int | None = None,
    pending_epoch: int | None = 1,
    activation_receipt: dict[str, object] | None = None,
    scenario_id: str = "vt00-realtime-001",
    scenario_version: str = "v1",
) -> tuple[object, object, dict[str, object]]:
    from deerflow.sophia import cleanup_fence

    cleanup_id = "123e4567-e89b-42d3-a456-426614174000"
    provider_id = "provider-session-1"
    admission = cleanup_fence.reserve_cleanup_admission(
        cleanup_id,
        "2033-05-19T04:03:20.000Z",
        provider_expires_at="2033-05-18T04:03:20.000Z",
        resource_kind="provider",
        resource_id=provider_id,
        resource_expires_at="2033-05-18T04:03:20.000Z",
    )
    admission = cleanup_fence.verify_cleanup_admission_start(
        admission_id=admission.admission_id,
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id=provider_id,
    )
    admission = cleanup_fence.mark_cleanup_admission_credential_minted(admission)
    if provider_state == "active":
        admission = cleanup_fence.mark_cleanup_admission_browser_active(admission)
    synthetic: dict[str, object] = {
        "synthetic": True,
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-001",
        "environment": "production",
        "scenario_id": scenario_id,
        "scenario_version": scenario_version,
        "retention_anchor": "session_created_at_provisional",
        "retention_hours": 24,
        "retention_expires_at": "2033-05-19T04:03:20.000Z",
        "cleanup_obligation_id": cleanup_id,
        "provider_expires_at": "2033-05-18T04:03:20.000Z",
        "voice_runtime_session_id": provider_id,
        "cleanup_provider_admission_id": admission.admission_id,
        "voice_provider_resource_state": provider_state,
        "voice_provider_resource_expires_at": "2033-05-18T04:03:20.000Z",
        "voice_provider_pending_connection_epoch": pending_epoch,
    }
    if activated_epoch is not None:
        synthetic["voice_provider_connection_epoch"] = activated_epoch
    if activation_receipt is not None:
        synthetic["voice_provider_activation_receipt"] = activation_receipt
    metadata = {
        "synthetic_voice_lab": synthetic,
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
    }
    record = SimpleNamespace(
        session_id="canonical-session-1",
        thread_id="thread-1",
        user_id="voice-lab-user-1",
        run_id="run-001",
        status="open",
        ended_at=None,
        created_at="2033-05-18T04:03:20.000Z",
        metadata=metadata,
    )
    state: dict[str, object] = {"record": record}

    def find_by_cleanup(_cleanup_id: str) -> object | None:
        return state["record"]

    def get_record(user_id: str, session_id: str) -> object | None:
        current = state["record"]
        if (
            current is not None
            and getattr(current, "user_id", None) == user_id
            and getattr(current, "session_id", None) == session_id
        ):
            return current
        return None

    def update_record(
        user_id: str, session_id: str, **updates: object
    ) -> object | None:
        current = get_record(user_id, session_id)
        if current is None:
            return None
        for key, value in updates.items():
            setattr(current, key, value)
        return current

    monkeypatch.setattr(
        sessions_router._store,
        "find_session_by_cleanup_obligation_id",
        find_by_cleanup,
    )
    monkeypatch.setattr(sessions_router._store, "get", get_record)
    monkeypatch.setattr(sessions_router._store, "update", update_record)
    return admission, record, state


def _provider_close_receipt(epoch: int = 1) -> voice_router.GeminiBrowserProviderCloseReceipt:
    return voice_router.GeminiBrowserProviderCloseReceipt.model_validate(
        {
            "schema": "sophia_gemini_browser_provider_close_v1",
            "receipt_id": f"00000000-0000-4000-8000-{epoch:012d}",
            "session_id": "provider-session-1",
            "provider_connection_epoch": epoch,
            "websocket_close_observed": True,
            "websocket_close_code": 1000,
            "websocket_closed_at": "2033-05-18T04:00:00.000Z",
        }
    )


def _provider_abort_receipt(
    epoch: int = 1,
) -> voice_router.GeminiBrowserProviderActivationAbortReceipt:
    return voice_router.GeminiBrowserProviderActivationAbortReceipt.model_validate(
        {
            "schema": "sophia_gemini_browser_provider_activation_abort_v1",
            "receipt_id": f"10000000-0000-4000-8000-{epoch:012d}",
            "session_id": "provider-session-1",
            "previous_activated_epoch": epoch - 1,
            "candidate_epoch": epoch,
            "websocket_created": False,
            "aborted_at": "2033-05-18T04:00:00.000Z",
        }
    )


def test_provider_settlement_aborts_never_created_initial_candidate_and_replays(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from deerflow.sophia import cleanup_fence

    admission, record, state = _seed_provider_settlement(monkeypatch)
    claims = _verify(_sign(_claims()))
    assert claims is not None
    abort = _provider_abort_receipt()

    close_receipts, abort_receipts = voice_router._record_synthetic_browser_provider_close(
        claims,
        "provider-session-1",
        [],
        [abort],
    )

    assert close_receipts == []
    assert abort_receipts == [abort.model_dump(mode="json")]
    synthetic = record.metadata["synthetic_voice_lab"]
    assert synthetic["voice_provider_resource_state"] == "closed"
    assert synthetic["voice_provider_activation_abort_receipts"] == abort_receipts
    assert cleanup_fence._LOCAL_OBLIGATIONS[claims.cleanup_obligation_id]["state"] == "closed"
    assert cleanup_fence._LOCAL_ADMISSIONS[admission.admission_id].status == "activation_aborted"

    state["record"] = None
    cleanup_fence._LOCAL_ADMISSIONS.pop(admission.admission_id)
    assert voice_router._record_synthetic_browser_provider_close(
        claims,
        "provider-session-1",
        [],
        [abort],
    ) == ([], abort_receipts)

    conflicting_abort = voice_router.GeminiBrowserProviderActivationAbortReceipt.model_validate(
        {
            **_provider_abort_receipt(1).model_dump(mode="json"),
            "receipt_id": "20000000-0000-4000-8000-000000000001",
        }
    )
    with pytest.raises(HTTPException) as exc_info:
        voice_router._record_synthetic_browser_provider_close(
            claims,
            "provider-session-1",
            [],
            [conflicting_abort],
        )
    assert exc_info.value.status_code == 409


def test_provider_settlement_accepts_socket_close_before_activation_ack(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from deerflow.sophia import cleanup_fence

    admission, record, _state = _seed_provider_settlement(monkeypatch)
    claims = _verify(_sign(_claims()))
    assert claims is not None
    close = _provider_close_receipt()

    close_receipts, abort_receipts = voice_router._record_synthetic_browser_provider_close(
        claims,
        "provider-session-1",
        [close],
        [],
    )

    assert close_receipts == [close.model_dump(mode="json")]
    assert abort_receipts == []
    assert record.metadata["synthetic_voice_lab"]["voice_provider_resource_state"] == "closed"
    assert cleanup_fence._LOCAL_ADMISSIONS[admission.admission_id].status == "browser_closed"


@pytest.mark.anyio
async def test_provider_cleanup_token_settles_after_final_retention_extension_and_roll(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    admission, record, _state = _seed_provider_settlement(monkeypatch)
    claims = _verify(_sign(_claims()))
    assert claims is not None
    original_retention = str(
        record.metadata["synthetic_voice_lab"]["retention_expires_at"]
    )
    authority = mint_provider_cleanup_token(
        claims,
        "provider-session-1",
        admission.admission_id,
        original_retention,
    )

    # Normal UI finalization happens before voice teardown and legitimately
    # moves the retention anchor later. The already-minted cleanup token is a
    # safe lower bound and must remain usable across a Gateway roll.
    finalized_at = "2033-05-18T05:00:00.000Z"
    current_retention = "2033-05-19T05:00:00.000Z"
    synthetic = record.metadata["synthetic_voice_lab"]
    from deerflow.sophia.cleanup_fence import local_cleanup_finalization_guard

    with local_cleanup_finalization_guard(
        claims.cleanup_obligation_id,
        original_retention,
        claims.provider_expires_at,
        current_retention,
    ):
        synthetic.update(
            {
                "retention_anchor": "finalized_at",
                "finalized_at": finalized_at,
                "retention_expires_at": current_retention,
            }
        )
        record.status = "ended"
        record.ended_at = finalized_at
    monkeypatch.setenv("RENDER_GIT_COMMIT", "d" * 40)

    request = _auth_request(
        None,
        route_path="/api/sophia/{user_id}/voice/gemini/disconnect",
        concrete_path=(
            "/api/sophia/voice-lab-user-1/voice/gemini/disconnect"
        ),
        provider_cleanup_token=authority.token,
    )
    assert await require_authorized_user_scope(request) == "voice-lab-user-1"
    disconnect = AsyncMock(
        return_value=voice_router.GeminiProductionDisconnectResult(
            disconnected=True
        )
    )
    monkeypatch.setattr(
        voice_router,
        "_disconnect_gemini_production_session",
        disconnect,
    )

    result = await voice_router.gemini_production_disconnect(
        "voice-lab-user-1",
        voice_router.GeminiBrowserDogfoodDisconnectRequest(
            session_id="provider-session-1",
            browser_provider_close_receipts=[_provider_close_receipt()],
        ),
        request,
    )

    assert result["ok"] is True
    assert result["browser_provider_close_receipts"] == [
        _provider_close_receipt().model_dump(mode="json")
    ]
    runtime_token = disconnect.await_args.kwargs["capability"]
    runtime_payload = _provider_cleanup_payload(runtime_token)
    assert runtime_payload["allowed_ops"] == ["session:retention-reap"]
    assert runtime_payload["provider_session_id"] == "provider-session-1"
    assert runtime_payload["expected_deployment"]["backend"] == BUILD


@pytest.mark.anyio
async def test_v_l01_cleanup_waits_for_owning_callback_and_replays_durable_receipt(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from app.gateway.routers import voice_lab_recovery as recovery_router

    admission, record, _state = _seed_provider_settlement(
        monkeypatch,
        scenario_id="V-L01",
        scenario_version="vt00.scenarios.v1",
    )
    claims = _verify(
        _sign(
            _claims(
                scenario_id="V-L01",
                scenario_version="vt00.scenarios.v1",
            )
        )
    )
    assert claims is not None
    authority = mint_provider_cleanup_token(
        claims,
        "provider-session-1",
        admission.admission_id,
        str(record.metadata["synthetic_voice_lab"]["retention_expires_at"]),
    )
    close_receipt = _provider_close_receipt()

    async def invoke(
        disconnect_result: voice_router.GeminiProductionDisconnectResult,
    ) -> dict[str, object]:
        request = _auth_request(
            None,
            route_path="/api/sophia/{user_id}/voice/gemini/disconnect",
            concrete_path=(
                "/api/sophia/voice-lab-user-1/voice/gemini/disconnect"
            ),
            provider_cleanup_token=authority.token,
        )
        assert await require_authorized_user_scope(request) == "voice-lab-user-1"
        monkeypatch.setattr(
            voice_router,
            "_disconnect_gemini_production_session",
            AsyncMock(return_value=disconnect_result),
        )
        return await voice_router.gemini_production_disconnect(
            "voice-lab-user-1",
            voice_router.GeminiBrowserDogfoodDisconnectRequest(
                session_id="provider-session-1",
                browser_provider_close_receipts=[close_receipt],
            ),
            request,
        )

    with pytest.raises(HTTPException) as pending:
        await invoke(
            voice_router.GeminiProductionDisconnectResult(disconnected=False)
        )
    assert pending.value.status_code == 503
    assert pending.value.detail == {"code": "voice_lab_provider_disconnect_unconfirmed"}

    restored = {
        "schema": "sophia_voice_lab_trace_fault_v1",
        "fault": "langsmith_unavailable",
        "phase": "restored",
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-001",
        "scenario_id": "V-L01",
        "scenario_version": "vt00.scenarios.v1",
        "environment": "production",
        "expected_deployment": {
            "frontend": BUILD,
            "backend": BUILD,
            "voice": BUILD,
        },
        "trace_unavailable": True,
        "canonical_behavior_unchanged": True,
        "applied_at": "2033-05-18T03:59:00.000Z",
        "restored_at": "2033-05-18T04:00:01.000Z",
    }
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    callback_request = recovery_router.Request(
        {
            "type": "http",
            "method": "POST",
            "path": (
                "/internal/voice-lab/cleanup-admissions/"
                f"{admission.admission_id}/complete"
            ),
            "headers": [
                (
                    VOICE_INTERNAL_AUTH_HEADER.lower().encode(),
                    INTERNAL_SECRET.encode(),
                )
            ],
        }
    )
    completed = recovery_router.complete_cleanup_admission_callback(
        admission.admission_id,
        recovery_router.CleanupAdmissionCompleteCallback(
            cleanup_obligation_id=claims.cleanup_obligation_id,
            resource_kind="provider",
            resource_id="provider-session-1",
            basis="server_relay_zero",
            trace_fault=restored,
        ),
        callback_request,
    )
    assert completed["completed"] is True
    assert completed["trace_fault"] == restored
    assert record.metadata["synthetic_voice_lab"][
        "voice_provider_trace_fault_restore_receipt"
    ] == {
        "schema": "sophia_voice_lab_provider_trace_fault_terminal_v1",
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "cleanup_provider_admission_id": admission.admission_id,
        "provider_session_id": "provider-session-1",
        "trace_fault": restored,
    }

    replay = await invoke(
        # A non-owning rolled Voice replica can only say the relay is absent;
        # Gateway succeeds because the owning callback is already durable.
        voice_router.GeminiProductionDisconnectResult(disconnected=True)
    )
    assert replay["closed"] is True
    assert replay["trace_fault"] == restored

    callback_replay = recovery_router.complete_cleanup_admission_callback(
        admission.admission_id,
        recovery_router.CleanupAdmissionCompleteCallback(
            cleanup_obligation_id=claims.cleanup_obligation_id,
            resource_kind="provider",
            resource_id="provider-session-1",
            basis="server_relay_zero",
            trace_fault=restored,
        ),
        callback_request,
    )
    assert callback_replay == {
        "completed": True,
        "already_terminal": True,
        "trace_fault": restored,
    }


def test_expired_reserved_provider_callback_is_db_clock_typed_and_consumable(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from app.gateway.routers import voice_lab_recovery as recovery_router
    from deerflow.sophia import cleanup_fence

    cleanup_id = "123e4567-e89b-42d3-a456-426614174000"
    provider_deadline = datetime.now(UTC) + timedelta(minutes=30)
    admission = cleanup_fence.reserve_cleanup_admission(
        cleanup_id,
        datetime.now(UTC) + timedelta(hours=1),
        provider_expires_at=provider_deadline,
        resource_kind="provider",
        resource_id="provider-reserved-expired",
        resource_expires_at=provider_deadline,
    )
    expired = cleanup_fence.CleanupAdmission(
        admission_id=admission.admission_id,
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="provider-reserved-expired",
        lease_expires_at=datetime.now(UTC) - timedelta(seconds=1),
        resource_expires_at=admission.resource_expires_at,
        status="reserved",
    )
    cleanup_fence._LOCAL_ADMISSIONS[admission.admission_id] = expired
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    monkeypatch.setattr(
        sessions_router._store,
        "find_session_by_cleanup_obligation_id",
        lambda _cleanup_id: None,
    )
    request = recovery_router.Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/internal/voice-lab/cleanup-admissions/test",
            "headers": [
                (
                    VOICE_INTERNAL_AUTH_HEADER.lower().encode(),
                    INTERNAL_SECRET.encode(),
                )
            ],
        }
    )
    callback_binding = {
        "cleanup_obligation_id": cleanup_id,
        "resource_kind": "provider",
        "resource_id": "provider-reserved-expired",
    }

    authorization = recovery_router.authorize_cleanup_admission_callback(
        admission.admission_id,
        recovery_router.CleanupAdmissionAuthorizeCallback(
            **callback_binding,
            phase="heartbeat",
        ),
        request,
    )
    assert authorization == {
        "authorized": False,
        "status": "reserved",
        "code": "cleanup_admission_closed",
        "expired": True,
        "resource_expires_at": recovery_router._canonical_utc_millis(
            expired.resource_expires_at
        ),
    }

    completion = recovery_router.complete_cleanup_admission_callback(
        admission.admission_id,
        recovery_router.CleanupAdmissionCompleteCallback(
            **callback_binding,
            basis="server_relay_zero",
        ),
        request,
    )
    assert completion["completed"] is True
    assert cleanup_fence.cleanup_admissions(cleanup_id) == ()


@pytest.mark.anyio
async def test_recovery_consumes_only_never_dispatched_expired_provider_reservation(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from app.gateway.routers import voice_lab_recovery as recovery_router
    from deerflow.sophia import cleanup_fence

    cleanup_id = "123e4567-e89b-42d3-a456-426614174000"
    admission = cleanup_fence.reserve_cleanup_admission(
        cleanup_id,
        "2033-05-19T04:03:20.000Z",
        provider_expires_at="2033-05-18T04:03:20.000Z",
        resource_kind="provider",
        resource_id="provider-never-dispatched",
        resource_expires_at="2033-05-18T04:03:20.000Z",
    )
    cleanup_fence._LOCAL_ADMISSIONS[admission.admission_id] = (
        cleanup_fence.CleanupAdmission(
            admission_id=admission.admission_id,
            cleanup_obligation_id=cleanup_id,
            resource_kind="provider",
            resource_id="provider-never-dispatched",
            lease_expires_at=datetime.now(UTC) - timedelta(seconds=1),
            resource_expires_at=admission.resource_expires_at,
            status="reserved",
        )
    )
    monkeypatch.setattr(
        voice_router,
        "_disconnect_gemini_production_session",
        AsyncMock(side_effect=AssertionError("never-dispatched provider must not exist")),
    )
    claims = _verify(_sign(_claims()))
    assert claims is not None

    result = await recovery_router._reconcile_overdue_cleanup_admissions(
        claims,
        None,
    )

    assert result == {
        "status": "completed",
        "cleanup_admissions_reconciled": 1,
    }
    assert cleanup_fence.cleanup_admissions(cleanup_id) == ()


def test_cleanup_fence_allows_only_one_provider_admission_per_obligation(
    voice_lab_env: None,
) -> None:
    from deerflow.sophia import cleanup_fence

    cleanup_id = "123e4567-e89b-42d3-a456-426614174000"
    provider_deadline = datetime.now(UTC) + timedelta(minutes=30)
    retention_deadline = datetime.now(UTC) + timedelta(hours=1)
    first = cleanup_fence.reserve_cleanup_admission(
        cleanup_id,
        retention_deadline,
        provider_expires_at=provider_deadline,
        resource_kind="provider",
        resource_id="provider-session-a",
        resource_expires_at=provider_deadline,
    )

    with pytest.raises(
        cleanup_fence.CleanupFenceError,
        match="provider cleanup admission already exists",
    ):
        cleanup_fence.reserve_cleanup_admission(
            cleanup_id,
            retention_deadline,
            provider_expires_at=provider_deadline,
            resource_kind="provider",
            resource_id="provider-session-b",
            resource_expires_at=provider_deadline,
        )

    assert cleanup_fence.cleanup_admissions(cleanup_id) == (first,)


def test_atomic_provider_bind_rolls_prior_terminal_receipt_into_bounded_history(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from app.gateway.routers import voice_lab_recovery as recovery_router
    from deerflow.sophia import cleanup_fence

    cleanup_id = "123e4567-e89b-42d3-a456-426614174000"
    claims = _verify(
        _sign(
            _claims(
                scenario_id="V-L01",
                scenario_version="vt00.scenarios.v1",
            )
        )
    )
    assert claims is not None
    prior_terminal = {
        "schema": "sophia_voice_lab_provider_trace_fault_terminal_v1",
        "cleanup_obligation_id": cleanup_id,
        "cleanup_provider_admission_id": "00000000-0000-4000-8000-000000000001",
        "provider_session_id": "provider-attempt-a",
        "trace_fault": {
            "schema": "sophia_voice_lab_trace_fault_v1",
            "fault": "langsmith_unavailable",
            "phase": "restored",
        },
    }
    metadata = {
        "synthetic_voice_lab": {
            "synthetic": True,
            "principal_id": claims.principal_id,
            "test_run_id": claims.test_run_id,
            "scenario_id": claims.scenario_id,
            "scenario_version": claims.scenario_version,
            "environment": claims.environment,
            "retention_anchor": "session_created_at_provisional",
            "retention_hours": claims.retention_hours,
            "retention_expires_at": "2033-05-19T04:03:20.000Z",
            "cleanup_obligation_id": cleanup_id,
            "provider_expires_at": claims.provider_expires_at,
            "voice_provider_trace_fault_restore_receipt": prior_terminal,
        },
        "expected_deployment": dict(claims.expected_deployment),
        "memory_retrieval_disabled": True,
        "inactivity_finalization_disabled": True,
        "offline_pipeline_disabled": True,
        "memory_learning_disabled": True,
        "ordinary_analytics_disabled": True,
        "ordinary_projects_disabled": True,
        "shared_spaces_disabled": True,
    }
    record = SimpleNamespace(
        session_id="canonical-session-retry",
        thread_id="thread-retry",
        user_id=claims.principal_id,
        run_id=claims.test_run_id,
        status="open",
        ended_at=None,
        created_at="2033-05-18T04:03:20.000Z",
        metadata=metadata,
    )

    def get_record(user_id: str, session_id: str) -> object | None:
        return (
            record
            if user_id == record.user_id and session_id == record.session_id
            else None
        )

    def update_record(
        user_id: str,
        session_id: str,
        **updates: object,
    ) -> object | None:
        if get_record(user_id, session_id) is None:
            return None
        for key, value in updates.items():
            setattr(record, key, value)
        return record

    monkeypatch.setattr(sessions_router._store, "get", get_record)
    monkeypatch.setattr(sessions_router._store, "update", update_record)
    admission = cleanup_fence.reserve_cleanup_admission(
        cleanup_id,
        "2033-05-19T04:03:20.000Z",
        provider_expires_at=claims.provider_expires_at,
        resource_kind="provider",
        resource_id="provider-attempt-b",
        resource_expires_at=claims.provider_expires_at,
    )
    admission = cleanup_fence.verify_cleanup_admission_start(
        admission_id=admission.admission_id,
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="provider-attempt-b",
    )

    assert voice_router._bind_synthetic_provider_session(
        claims.principal_id,
        record.session_id,
        "provider-attempt-b",
        claims,
        admission,
        1,
        admission.resource_expires_at,
    )

    current = cleanup_fence.cleanup_admissions(cleanup_id)
    assert len(current) == 1
    assert current[0].status == "credential_minted"
    synthetic = record.metadata["synthetic_voice_lab"]
    assert synthetic["voice_runtime_session_id"] == "provider-attempt-b"
    assert synthetic["cleanup_provider_admission_id"] == admission.admission_id
    assert synthetic["voice_provider_trace_fault_restore_receipt"] is None
    assert synthetic["voice_provider_trace_fault_restore_receipt_history"] == [
        prior_terminal
    ]
    assert recovery_router._session_has_provider_trace_fault(
        record,
        prior_terminal["trace_fault"],
        cleanup_obligation_id=cleanup_id,
        admission_id=str(prior_terminal["cleanup_provider_admission_id"]),
        resource_id=str(prior_terminal["provider_session_id"]),
    )
    synthetic["voice_provider_trace_fault_restore_receipt_history"].append(
        prior_terminal
    )
    assert not recovery_router._session_has_provider_trace_fault(
        record,
        prior_terminal["trace_fault"],
        cleanup_obligation_id=cleanup_id,
        admission_id=str(prior_terminal["cleanup_provider_admission_id"]),
        resource_id=str(prior_terminal["provider_session_id"]),
    )


def test_bound_unpublished_provider_closes_atomically_before_terminal_callback(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from app.gateway.routers import voice_lab_recovery as recovery_router
    from deerflow.sophia import cleanup_fence

    cleanup_id = "123e4567-e89b-42d3-a456-426614174000"
    claims = _verify(
        _sign(
            _claims(
                scenario_id="V-L01",
                scenario_version="vt00.scenarios.v1",
            )
        )
    )
    assert claims is not None
    metadata = {
        "synthetic_voice_lab": {
            "synthetic": True,
            "principal_id": claims.principal_id,
            "test_run_id": claims.test_run_id,
            "scenario_id": claims.scenario_id,
            "scenario_version": claims.scenario_version,
            "environment": claims.environment,
            "retention_anchor": "session_created_at_provisional",
            "retention_hours": claims.retention_hours,
            "retention_expires_at": "2033-05-19T04:03:20.000Z",
            "cleanup_obligation_id": cleanup_id,
            "provider_expires_at": claims.provider_expires_at,
        },
        "expected_deployment": dict(claims.expected_deployment),
        "memory_retrieval_disabled": True,
        "inactivity_finalization_disabled": True,
        "offline_pipeline_disabled": True,
        "memory_learning_disabled": True,
        "ordinary_analytics_disabled": True,
        "ordinary_projects_disabled": True,
        "shared_spaces_disabled": True,
    }
    record = SimpleNamespace(
        session_id="canonical-session-unpublished",
        thread_id="thread-unpublished",
        user_id=claims.principal_id,
        run_id=claims.test_run_id,
        status="open",
        ended_at=None,
        created_at="2033-05-18T04:03:20.000Z",
        metadata=metadata,
    )

    def get_record(user_id: str, session_id: str) -> object | None:
        return (
            record
            if user_id == record.user_id and session_id == record.session_id
            else None
        )

    def find_record(value: str) -> object | None:
        return record if value == cleanup_id else None

    def update_record(
        user_id: str,
        session_id: str,
        **updates: object,
    ) -> object | None:
        if get_record(user_id, session_id) is None:
            return None
        for key, value in updates.items():
            setattr(record, key, value)
        return record

    monkeypatch.setattr(sessions_router._store, "get", get_record)
    monkeypatch.setattr(
        sessions_router._store,
        "find_session_by_cleanup_obligation_id",
        find_record,
    )
    monkeypatch.setattr(sessions_router._store, "update", update_record)
    admission = cleanup_fence.reserve_cleanup_admission(
        cleanup_id,
        "2033-05-19T04:03:20.000Z",
        provider_expires_at=claims.provider_expires_at,
        resource_kind="provider",
        resource_id="provider-unpublished",
        resource_expires_at=claims.provider_expires_at,
    )
    admission = cleanup_fence.verify_cleanup_admission_start(
        admission_id=admission.admission_id,
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="provider-unpublished",
    )
    assert voice_router._bind_synthetic_provider_session(
        claims.principal_id,
        record.session_id,
        "provider-unpublished",
        claims,
        admission,
        1,
        admission.resource_expires_at,
    )

    # Cleanup wins immediately after the atomic bind but before the browser can
    # receive the credential. The compensation must repair the canonical row,
    # not merely flip the admission status.
    cleanup_fence.close_cleanup_obligation(
        cleanup_id,
        "2033-05-19T04:03:20.000Z",
        claims.provider_expires_at,
    )
    assert voice_router._abort_unpublished_synthetic_provider_session(
        claims.principal_id,
        record.session_id,
        "provider-unpublished",
        claims,
        admission,
        1,
    )
    synthetic = record.metadata["synthetic_voice_lab"]
    assert synthetic["voice_provider_resource_state"] == "closed"
    assert synthetic["voice_provider_pending_connection_epoch"] is None
    current = cleanup_fence.cleanup_admissions(cleanup_id)
    assert len(current) == 1
    assert current[0].status == "activation_aborted"

    restored = {
        "schema": "sophia_voice_lab_trace_fault_v1",
        "fault": "langsmith_unavailable",
        "phase": "restored",
        "principal_id": claims.principal_id,
        "test_run_id": claims.test_run_id,
        "scenario_id": claims.scenario_id,
        "scenario_version": claims.scenario_version,
        "environment": claims.environment,
        "expected_deployment": dict(claims.expected_deployment),
        "trace_unavailable": True,
        "canonical_behavior_unchanged": True,
        "applied_at": "2033-05-18T03:59:00.000Z",
        "restored_at": "2033-05-18T04:00:01.000Z",
    }
    request = recovery_router.Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/internal/voice-lab/cleanup-admissions/test/complete",
            "headers": [
                (
                    VOICE_INTERNAL_AUTH_HEADER.lower().encode(),
                    INTERNAL_SECRET.encode(),
                )
            ],
        }
    )
    completion = recovery_router.complete_cleanup_admission_callback(
        admission.admission_id,
        recovery_router.CleanupAdmissionCompleteCallback(
            cleanup_obligation_id=cleanup_id,
            resource_kind="provider",
            resource_id="provider-unpublished",
            basis="server_relay_zero",
            trace_fault=restored,
        ),
        request,
    )
    assert completion["completed"] is True
    assert cleanup_fence.cleanup_admissions(cleanup_id) == ()
    assert record.metadata["synthetic_voice_lab"][
        "voice_provider_trace_fault_restore_receipt"
    ] == {
        "schema": "sophia_voice_lab_provider_trace_fault_terminal_v1",
        "cleanup_obligation_id": cleanup_id,
        "cleanup_provider_admission_id": admission.admission_id,
        "provider_session_id": "provider-unpublished",
        "trace_fault": restored,
    }


def test_provider_cleanup_token_cannot_extend_canonical_retention(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    admission, _record, _state = _seed_provider_settlement(monkeypatch)
    claims = _verify(_sign(_claims()))
    assert claims is not None
    authority = mint_provider_cleanup_token(
        claims,
        "provider-session-1",
        admission.admission_id,
        "2033-05-20T04:03:20.000Z",
    )
    cleanup_claims = verify_provider_cleanup_token(
        authority.token,
        secret=SECRET,
        principal_id="voice-lab-user-1",
        environment="production",
    )
    request = _auth_request(None)
    request.state.voice_lab_provider_cleanup_claims = cleanup_claims

    with pytest.raises(HTTPException) as exc_info:
        voice_router._provider_cleanup_claims_for_disconnect(
            request,
            user_id="voice-lab-user-1",
            provider_session_id="provider-session-1",
        )
    assert exc_info.value.detail == {
        "code": "voice_lab_provider_cleanup_binding_mismatch"
    }


def test_provider_settlement_rejects_candidate_staged_after_outer_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    from deerflow.sophia import cleanup_fence

    admission, record, _state = _seed_provider_settlement(monkeypatch)
    claims = _verify(_sign(_claims()))
    assert claims is not None
    original_cleanup_admissions = cleanup_fence.cleanup_admissions

    def race_cleanup_admissions(cleanup_id: str):
        result = original_cleanup_admissions(cleanup_id)
        raced_metadata = dict(record.metadata)
        raced_synthetic = dict(raced_metadata["synthetic_voice_lab"])
        raced_synthetic["voice_provider_pending_connection_epoch"] = 2
        raced_metadata["synthetic_voice_lab"] = raced_synthetic
        record.metadata = raced_metadata
        return result

    monkeypatch.setattr(
        cleanup_fence,
        "cleanup_admissions",
        race_cleanup_admissions,
    )

    with pytest.raises(HTTPException) as exc_info:
        voice_router._record_synthetic_browser_provider_close(
            claims,
            "provider-session-1",
            [],
            [_provider_abort_receipt()],
        )

    assert exc_info.value.status_code == 503
    assert cleanup_fence._LOCAL_OBLIGATIONS[claims.cleanup_obligation_id]["state"] == "open"
    assert cleanup_fence._LOCAL_ADMISSIONS[admission.admission_id].status == "credential_minted"
    assert record.metadata["synthetic_voice_lab"]["voice_provider_pending_connection_epoch"] == 2


@pytest.mark.parametrize(
    ("authorization_header", "expected_code"),
    [
        (
            VOICE_LAB_CAPABILITY_HEADER,
            "voice_lab_ordinary_product_route_forbidden",
        ),
        (
            VOICE_LAB_PROVIDER_CLEANUP_HEADER,
            "voice_lab_provider_cleanup_route_denied",
        ),
    ],
)
def test_gateway_middleware_denies_synthetic_authority_on_ungoverned_route(
    authorization_header: str,
    expected_code: str,
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.gateway.app import create_app

    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    legacy_auth = AsyncMock(side_effect=AssertionError("legacy /me must not run"))
    monkeypatch.setattr(gateway_auth, "_get_authenticated_user", legacy_auth)

    with patch(
        "app.gateway.app._live_deck_quality_readiness",
        side_effect=AssertionError("ungoverned route handler must not run"),
    ) as health_read:
        response = TestClient(create_app()).get(
            "/health",
            headers={authorization_header: "opaque-authority"},
        )

    assert response.status_code == 403
    assert response.json()["detail"] == {"code": expected_code}
    health_read.assert_not_called()
    legacy_auth.assert_not_awaited()


@pytest.mark.anyio
async def test_gateway_authenticates_fresh_governed_request_from_capability_only(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    _seed_open_cleanup_obligation()
    legacy_auth = AsyncMock(side_effect=AssertionError("legacy /me must not run"))
    monkeypatch.setattr(gateway_auth, "_get_authenticated_user", legacy_auth)
    request = _auth_request(_sign(_claims()))

    assert await require_authorized_user_scope(request) == "voice-lab-user-1"
    assert request.state.authenticated_user_id == "voice-lab-user-1"
    assert request.state.voice_lab_capability_claims.test_run_id == "run-001"
    legacy_auth.assert_not_awaited()


@pytest.mark.anyio
async def test_gateway_capability_auth_maps_exact_route_to_required_operation(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    _seed_open_cleanup_obligation()
    request = _auth_request(
        _sign(_claims(allowed_ops=["session:create"])),
        route_path="/api/v1/sessions/start",
        concrete_path="/api/v1/sessions/start",
        user_id=None,
    )

    assert await require_authenticated_user(request) == "voice-lab-user-1"
    operations = voice_lab_governed_route_operations()
    assert operations[("POST", "/api/v1/sessions/start")] == "session:create"
    assert operations[("POST", "/api/sophia/{user_id}/voice/gemini/activate")] == "session:create"


@pytest.mark.anyio
async def test_gateway_capability_auth_rejects_wrong_operation_without_legacy_fallback(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    legacy_auth = AsyncMock(side_effect=AssertionError("legacy /me must not run"))
    monkeypatch.setattr(gateway_auth, "_get_authenticated_user", legacy_auth)
    request = _auth_request(
        _sign(_claims(allowed_ops=["voice:start"])),
        route_path="/api/sophia/{user_id}/voice/gemini/relay",
        concrete_path="/api/sophia/voice-lab-user-1/voice/gemini/relay",
    )

    with pytest.raises(HTTPException) as exc_info:
        await require_authorized_user_scope(request)
    assert exc_info.value.detail == {"code": "voice_lab_capability_operation_denied"}
    legacy_auth.assert_not_awaited()


@pytest.mark.anyio
async def test_gateway_capability_auth_rejects_missing_capability_without_legacy_fallback(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    legacy_auth = AsyncMock(side_effect=AssertionError("legacy /me must not run"))
    monkeypatch.setattr(gateway_auth, "_get_authenticated_user", legacy_auth)

    with pytest.raises(HTTPException) as exc_info:
        await require_authorized_user_scope(_auth_request(None))
    assert exc_info.value.detail == {"code": "voice_lab_capability_missing"}
    legacy_auth.assert_not_awaited()


@pytest.mark.anyio
async def test_gateway_capability_auth_rejects_deployment_drift_before_handler(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    token = _sign(
        _claims(
            expected_deployment={
                "frontend": BUILD,
                "backend": "a" * 40,
                "voice": BUILD,
            }
        )
    )
    with pytest.raises(HTTPException) as exc_info:
        await require_authorized_user_scope(_auth_request(token))
    assert exc_info.value.detail == {"code": "voice_lab_capability_deployment_mismatch"}


@pytest.mark.anyio
async def test_gateway_capability_auth_rejects_closed_obligation_before_handler(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.cleanup_fence import close_cleanup_obligation

    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    _seed_open_cleanup_obligation()
    close_cleanup_obligation(
        "123e4567-e89b-42d3-a456-426614174000",
        "2033-05-19T04:03:20.000Z",
        "2033-05-18T04:03:20.000Z",
    )

    with pytest.raises(HTTPException) as exc_info:
        await require_authorized_user_scope(_auth_request(_sign(_claims())))
    assert exc_info.value.detail == {"code": "voice_lab_cleanup_obligation_closed"}


@pytest.mark.anyio
async def test_gateway_capability_auth_allows_kill_safe_finalization_after_close(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.cleanup_fence import close_cleanup_obligation

    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    _seed_open_cleanup_obligation()
    close_cleanup_obligation(
        "123e4567-e89b-42d3-a456-426614174000",
        "2033-05-19T04:03:20.000Z",
        "2033-05-18T04:03:20.000Z",
    )
    request = _auth_request(
        _sign(_claims(allowed_ops=["session:finalize"])),
        method="GET",
        route_path="/api/sophia/{user_id}/voice/gemini/events",
        concrete_path="/api/sophia/voice-lab-user-1/voice/gemini/events",
    )

    assert await require_authorized_user_scope(request) == "voice-lab-user-1"


@pytest.mark.anyio
async def test_gateway_ordinary_bearer_auth_remains_unchanged(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    legacy_auth = AsyncMock(return_value={"id": "ordinary-user"})
    monkeypatch.setattr(gateway_auth, "_get_authenticated_user", legacy_auth)
    request = _auth_request(
        None,
        concrete_path="/api/sophia/ordinary-user/voice/connect",
        user_id="ordinary-user",
        bearer="ordinary-token",
    )

    assert await require_authorized_user_scope(request) == "ordinary-user"
    legacy_auth.assert_awaited_once_with("ordinary-token")


def test_gateway_kill_switch_blocks_start_but_allows_signed_finalization(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", "true")
    with pytest.raises(HTTPException) as start_error:
        capability_for_voice_connect(_request(_sign(_claims())), "voice-lab-user-1")
    assert start_error.value.detail == {"code": "voice_lab_kill_switch_active"}

    claims = capability_for_gateway_action(
        _request(_sign(_claims(allowed_ops=["session:finalize"]))),
        "voice-lab-user-1",
        required_operation="session:finalize",
    )
    assert claims is not None
    assert claims.test_run_id == "run-001"


def test_gateway_requires_enabled_lab_for_finalization(
    voice_lab_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "false")
    with pytest.raises(HTTPException) as exc_info:
        capability_for_gateway_action(
            _request(_sign(_claims(allowed_ops=["session:finalize"]))),
            "voice-lab-user-1",
            required_operation="session:finalize",
        )
    assert exc_info.value.detail == {"code": "voice_lab_disabled"}


def test_internal_voice_auth_fails_closed_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", raising=False)
    with pytest.raises(HTTPException) as exc_info:
        voice_internal_auth_headers()
    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == {"code": "voice_internal_auth_configuration_missing"}


def test_internal_voice_auth_header_is_added_without_exposing_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    headers = voice_internal_auth_headers({"Accept": "application/json"})
    assert headers[VOICE_INTERNAL_AUTH_HEADER] == INTERNAL_SECRET
    assert headers["Accept"] == "application/json"


@pytest.mark.anyio
async def test_ordinary_runtime_proxy_adds_internal_auth_without_lab_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    request = voice_router.httpx.Request("POST", "http://voice.test/production/realtime/gemini/browser-sessions")
    response = voice_router.httpx.Response(201, request=request, json={"session_id": "ordinary-session"})
    client = AsyncMock()
    client.request = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(voice_router.httpx, "AsyncClient", lambda **_kwargs: client)

    payload = await voice_router._proxy_voice_runtime_json(
        "POST",
        "/production/realtime/gemini/browser-sessions",
        json_body={"user_id": "ordinary-user"},
    )

    assert payload == {"session_id": "ordinary-session"}
    headers = client.request.await_args.kwargs["headers"]
    assert headers == {VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET}
    assert VOICE_LAB_CAPABILITY_HEADER not in headers


@pytest.mark.anyio
async def test_ordinary_dogfood_proxy_adds_internal_auth_without_lab_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    request = voice_router.httpx.Request(
        "POST",
        "http://voice.test/dogfood/realtime/gemini/browser-sessions",
    )
    response = voice_router.httpx.Response(
        201,
        request=request,
        json={"session_id": "ordinary-dogfood-session"},
    )
    client = AsyncMock()
    client.request = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(voice_router.httpx, "AsyncClient", lambda **_kwargs: client)

    payload = await voice_router._proxy_voice_dogfood_json(
        "POST",
        "/dogfood/realtime/gemini/browser-sessions",
        json_body={"user_id": "ordinary-user"},
    )

    assert payload == {"session_id": "ordinary-dogfood-session"}
    headers = client.request.await_args.kwargs["headers"]
    assert headers == {VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET}
    assert VOICE_LAB_CAPABILITY_HEADER not in headers


def test_ordinary_sse_upstreams_add_internal_auth_without_lab_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)

    url, headers = voice_router._voice_event_upstream_request(
        "http://voice.test/production/realtime/gemini/sessions/ordinary/events",
        17,
    )

    assert url.endswith("?last_event_id=17")
    assert headers == {
        "Accept": "text/event-stream",
        "Last-Event-ID": "17",
        VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET,
    }
    assert VOICE_LAB_CAPABILITY_HEADER not in headers


@pytest.mark.anyio
async def test_ordinary_legacy_gateway_lifecycle_adds_internal_auth_without_lab(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    dispatch_request = voice_router.httpx.Request(
        "POST",
        "http://voice.test/calls/call-ordinary/sessions",
    )
    warmup_request = voice_router.httpx.Request(
        "POST",
        "http://voice.test/calls/call-ordinary/sessions/session-ordinary/warmup",
    )
    disconnect_request = voice_router.httpx.Request(
        "DELETE",
        "http://voice.test/calls/call-ordinary/sessions/session-ordinary",
    )
    client = AsyncMock()
    client.post = AsyncMock(
        side_effect=[
            voice_router.httpx.Response(
                201,
                request=dispatch_request,
                json={"session_id": "session-ordinary"},
            ),
            voice_router.httpx.Response(202, request=warmup_request),
        ]
    )
    client.delete = AsyncMock(return_value=voice_router.httpx.Response(204, request=disconnect_request))
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(voice_router.httpx, "AsyncClient", lambda **_kwargs: client)

    session_id = await voice_router._dispatch_voice_agent(
        call_id="call-ordinary",
        call_type="default",
        platform="voice",
        context_mode="life",
        ritual=None,
    )
    await voice_router.voice_warmup(
        "ordinary-user",
        voice_router.VoiceWarmupRequest(
            call_id="call-ordinary",
            session_id="session-ordinary",
        ),
    )
    await voice_router._disconnect_voice_session(
        "call-ordinary",
        "session-ordinary",
    )

    assert session_id == "session-ordinary"
    assert len(client.post.await_args_list) == 2
    for call in client.post.await_args_list:
        assert call.kwargs["headers"] == {VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET}
        assert VOICE_LAB_CAPABILITY_HEADER not in call.kwargs["headers"]
    assert client.delete.await_args.kwargs["headers"] == {VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET}


@pytest.mark.anyio
async def test_ordinary_production_disconnect_adds_internal_auth_without_lab(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", INTERNAL_SECRET)
    request = voice_router.httpx.Request(
        "DELETE",
        "http://voice.test/production/realtime/gemini/browser-sessions/ordinary",
    )
    response = voice_router.httpx.Response(202, request=request)
    client = AsyncMock()
    client.request = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(voice_router.httpx, "AsyncClient", lambda **_kwargs: client)

    result = await voice_router._disconnect_gemini_production_session("ordinary")

    assert result.disconnected is True
    assert result.trace_fault is None
    headers = client.request.await_args.kwargs["headers"]
    assert headers == {VOICE_INTERNAL_AUTH_HEADER: INTERNAL_SECRET}
    assert VOICE_LAB_CAPABILITY_HEADER not in headers


def _runtime_payload(session_id: str) -> dict[str, object]:
    return {
        "runtime": "gemini_live",
        "voice_runtime": "gemini_live",
        "production_route": True,
        "session_id": session_id,
        "browser_audio": "gemini_live_websocket_production_candidate",
        "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
        "websocket_url": "wss://gemini.example/live",
        "websocket_auth": "ephemeral_access_token",
        "ephemeral_token": {
            "value": "redacted-test-token",
            "expireTime": "2033-05-18T04:03:20.000Z",
        },
        "provider_connection_epoch": 1,
        "setup": {"model": "models/gemini-live"},
    }


def _simulate_voice_allocation_start(upstream: dict[str, object]) -> None:
    """Mirror Voice's durable pre-allocation callback in runtime-proxy tests."""

    from deerflow.sophia.cleanup_fence import verify_cleanup_admission_start

    synthetic = upstream.get("synthetic_test")
    assert isinstance(synthetic, dict)
    cleanup_obligation_id = synthetic.get("cleanup_obligation_id")
    cleanup_admission_id = upstream.get("cleanup_admission_id")
    provider_session_id = upstream.get("session_id")
    assert isinstance(cleanup_obligation_id, str)
    assert isinstance(cleanup_admission_id, str)
    assert isinstance(provider_session_id, str)
    verify_cleanup_admission_start(
        admission_id=cleanup_admission_id,
        cleanup_obligation_id=cleanup_obligation_id,
        resource_kind="provider",
        resource_id=provider_session_id,
    )


def test_route_rejects_missing_capability_before_provider_work(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    app = FastAPI()
    app.include_router(voice_router.router)
    provider = AsyncMock(side_effect=AssertionError("provider path must not run"))
    monkeypatch.setattr(voice_router, "_start_gemini_production_voice_session", provider)

    response = TestClient(app).post(
        "/api/sophia/voice-lab-user-1/voice/connect",
        json={"platform": "voice"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_lab_capability_missing"}
    provider.assert_not_awaited()


def test_route_rejects_wrong_audience_before_context_or_provider_work(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    app = FastAPI()
    app.include_router(voice_router.router)
    provider = AsyncMock(side_effect=AssertionError("provider path must not run"))
    context = AsyncMock(side_effect=AssertionError("context path must not run"))
    monkeypatch.setattr(voice_router, "_start_gemini_production_voice_session", provider)
    monkeypatch.setattr(voice_router, "_build_gemini_realtime_context_payload", context)

    response = TestClient(app).post(
        "/api/sophia/voice-lab-user-1/voice/connect",
        json={"platform": "voice"},
        headers={VOICE_LAB_CAPABILITY_HEADER: _sign(_claims(aud="wrong-service"))},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "voice_lab_capability_wrong_audience"}
    provider.assert_not_awaited()
    context.assert_not_awaited()


def test_synthetic_route_disables_memory_and_forwards_runtime_capability(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    _seed_open_cleanup_obligation()
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
    monkeypatch.setattr(
        voice_router,
        "build_sophia_realtime_context",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("memory retrieval must not run")),
    )
    monkeypatch.setattr(
        voice_router,
        "create_realtime_memory_retrieval_grant",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("memory grant must not be minted")),
    )

    async def runtime_proxy(*_args: object, **kwargs: object) -> dict[str, object]:
        upstream = kwargs["json_body"]
        assert isinstance(upstream, dict)
        _simulate_voice_allocation_start(upstream)
        payload = _runtime_payload(str(upstream["session_id"]))
        payload["langsmith_trace_unavailable_reason"] = "synthetic_isolation_policy"
        return payload

    proxy = AsyncMock(side_effect=runtime_proxy)
    monkeypatch.setattr(voice_router, "_proxy_voice_runtime_json", proxy)
    monkeypatch.setattr(
        voice_router,
        "_canonical_voice_lab_session_for_connect",
        lambda *_args, **_kwargs: _canonical_synthetic_stub(),
    )
    monkeypatch.setattr(
        voice_router,
        "_bind_synthetic_provider_session",
        lambda *_args, **_kwargs: True,
    )
    voice_router._active_voice_sessions.clear()

    app = FastAPI()
    app.include_router(voice_router.router)
    response = TestClient(app).post(
        "/api/sophia/voice-lab-user-1/voice/connect",
        json={
            "platform": "voice",
            "thread_id": "thread-synthetic",
            "session_id": "canonical-synthetic",
        },
        headers={VOICE_LAB_CAPABILITY_HEADER: _sign(_claims())},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["synthetic_test"]["test_run_id"] == "run-001"
    assert response.json()["langsmith_trace_unavailable_reason"] == "synthetic_isolation_policy"
    cleanup_claims = verify_provider_cleanup_token(
        response.json()["provider_cleanup_token"],
        secret=SECRET,
        principal_id="voice-lab-user-1",
        environment="production",
    )
    assert cleanup_claims.provider_session_id == response.json()["session_id"]
    assert cleanup_claims.cleanup_expires_at == response.json()[
        "provider_cleanup_expires_at"
    ]
    call = proxy.await_args
    upstream_body = call.kwargs["json_body"]
    runtime_token = call.kwargs["capability"]
    assert "dynamic_memory_retrieval" not in upstream_body["realtime_context"]
    assert upstream_body["realtime_context"]["diagnostics"]["memory_retrieval_disabled"] is True
    assert upstream_body["synthetic_test"]["scenario_id"] == "vt00-realtime-001"
    runtime_claims = verify_capability(
        runtime_token,
        secret=SECRET,
        audience="sophia-voice-runtime",
        issuer="sophia-gateway",
        principal_id="voice-lab-user-1",
        environment="production",
        required_operation="voice:start",
        expected_build_key="voice",
        expected_build=BUILD,
    )
    assert runtime_claims.test_run_id == "run-001"


def test_synthetic_connect_fails_before_provider_when_retention_plane_is_degraded(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    provider = AsyncMock(side_effect=AssertionError("provider must not be allocated"))
    monkeypatch.setattr(voice_router, "_start_gemini_production_voice_session", provider)
    monkeypatch.setattr(
        voice_router,
        "get_voice_lab_retention_reaper_or_none",
        lambda _app: type(
            "DegradedRetentionReaper",
            (),
            {
                "readiness": lambda self: {
                    "status": "degraded",
                    "running": True,
                },
            },
        )(),
    )
    app = FastAPI()
    app.include_router(voice_router.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "voice-lab-user-1"

    response = TestClient(app).post(
        "/api/sophia/voice-lab-user-1/voice/connect",
        headers={VOICE_LAB_CAPABILITY_HEADER: _sign(_claims())},
        json={"platform": "voice", "session_id": "canonical-retention-degraded"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "voice_lab_retention_plane_not_ready"}
    provider.assert_not_awaited()


def test_v_l01_requires_fault_authority_before_canonical_or_provider_work(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    voice_router._active_voice_sessions.clear()
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
    provider = AsyncMock(side_effect=AssertionError("provider path must not run"))
    canonical = AsyncMock(side_effect=AssertionError("canonical allocation must not run"))
    monkeypatch.setattr(voice_router, "_start_gemini_production_voice_session", provider)
    monkeypatch.setattr(voice_router, "_canonical_voice_lab_session_for_connect", canonical)
    app = FastAPI()
    app.include_router(voice_router.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "voice-lab-user-1"

    response = TestClient(app).post(
        "/api/sophia/voice-lab-user-1/voice/connect",
        headers={
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(
                    scenario_id="V-L01",
                    scenario_version="vt00.scenarios.v1",
                    allowed_ops=["voice:start"],
                )
            )
        },
        json={"platform": "voice", "session_id": "canonical-v-l01"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "voice_lab_capability_operation_denied"}
    provider.assert_not_awaited()
    canonical.assert_not_awaited()


def test_v_l01_forwards_governed_trace_fault_and_runtime_authority(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    voice_router._active_voice_sessions.clear()
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")

    async def runtime_proxy(*_args: object, **kwargs: object) -> dict[str, object]:
        upstream = kwargs["json_body"]
        assert isinstance(upstream, dict)
        _simulate_voice_allocation_start(upstream)
        payload = _runtime_payload(str(upstream["session_id"]))
        payload["langsmith_trace_unavailable_reason"] = "governed_synthetic_fault"
        payload["trace_fault"] = {
            "schema": "sophia_voice_lab_trace_fault_v1",
            "fault": "langsmith_unavailable",
            "phase": "applied",
        }
        return payload

    proxy = AsyncMock(side_effect=runtime_proxy)
    monkeypatch.setattr(voice_router, "_proxy_voice_runtime_json", proxy)
    monkeypatch.setattr(
        voice_router,
        "_canonical_voice_lab_session_for_connect",
        lambda *_args, **_kwargs: _canonical_synthetic_stub(),
    )
    monkeypatch.setattr(
        voice_router,
        "_bind_synthetic_provider_session",
        lambda *_args, **_kwargs: True,
    )
    app = FastAPI()
    app.include_router(voice_router.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "voice-lab-user-1"

    response = TestClient(app).post(
        "/api/sophia/voice-lab-user-1/voice/connect",
        headers={
            VOICE_LAB_CAPABILITY_HEADER: _sign(
                _claims(
                    scenario_id="V-L01",
                    scenario_version="vt00.scenarios.v1",
                    allowed_ops=["voice:start", "trace:fault"],
                )
            )
        },
        json={"platform": "voice", "session_id": "canonical-v-l01"},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["langsmith_trace_unavailable_reason"] == "governed_synthetic_fault"
    call = proxy.await_args
    assert call.kwargs["json_body"]["synthetic_trace_mode"] == "langsmith_unavailable"
    runtime_token = call.kwargs["capability"]
    runtime_claims = verify_capability(
        runtime_token,
        secret=SECRET,
        audience="sophia-voice-runtime",
        issuer="sophia-gateway",
        principal_id="voice-lab-user-1",
        environment="production",
        required_operation="trace:fault",
        expected_build_key="voice",
        expected_build=BUILD,
    )
    assert runtime_claims.scenario_id == "V-L01"
    voice_router._active_voice_sessions.clear()


def test_synthetic_connect_rejects_cross_run_canonical_session_before_provider(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
    provider = AsyncMock(side_effect=AssertionError("provider must not be allocated"))
    monkeypatch.setattr(voice_router, "_start_gemini_production_voice_session", provider)
    monkeypatch.setattr(
        voice_router,
        "_canonical_voice_lab_session_for_connect",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            HTTPException(
                status_code=409,
                detail={"code": "voice_lab_session_binding_mismatch"},
            )
        ),
    )
    app = FastAPI()
    app.include_router(voice_router.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "voice-lab-user-1"

    response = TestClient(app).post(
        "/api/sophia/voice-lab-user-1/voice/connect",
        headers={VOICE_LAB_CAPABILITY_HEADER: _sign(_claims(test_run_id="run-A"))},
        json={"platform": "voice", "session_id": "canonical-run-B"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "voice_lab_session_binding_mismatch"}
    provider.assert_not_awaited()


def test_synthetic_continuation_route_resolves_canonical_store_before_mint(
    monkeypatch: pytest.MonkeyPatch,
    voice_lab_env: None,
) -> None:
    """Regression for a missing route-local SessionStore import."""

    session_id = "gemini-prod-continuation"
    raw_claims = _claims(allowed_ops=["voice:start", "session:create"])
    token = _sign(raw_claims)
    verified = _verify(token)
    assert verified is not None
    voice_router._active_voice_sessions.clear()
    voice_router._active_voice_sessions["voice-lab-user-1"] = voice_router.ActiveVoiceSession(
        call_id=session_id,
        session_id=session_id,
        runtime="gemini_live",
        voice_lab_binding=voice_router._voice_lab_active_binding(verified),
    )
    canonical_record = SimpleNamespace(
        session_id="canonical-continuation-session",
        thread_id="thread-continuation",
        user_id="voice-lab-user-1",
        run_id="run-001",
        status="open",
        ended_at=None,
        created_at="2033-05-18T04:03:20.000Z",
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "principal_id": "voice-lab-user-1",
                "test_run_id": "run-001",
                "scenario_id": "vt00-realtime-001",
                "scenario_version": "v1",
                "environment": "production",
                "retention_hours": 24,
                "retention_anchor": "session_created_at_provisional",
                "retention_expires_at": "2033-05-19T04:03:20.000Z",
                "cleanup_obligation_id": raw_claims["cleanup_obligation_id"],
                "provider_expires_at": raw_claims["provider_expires_at"],
                "voice_runtime_session_id": session_id,
                "cleanup_provider_admission_id": (
                    "123e4567-e89b-42d3-a456-426614174001"
                ),
            },
            "expected_deployment": raw_claims["expected_deployment"],
            "memory_retrieval_disabled": True,
            "inactivity_finalization_disabled": True,
            "offline_pipeline_disabled": True,
            "memory_learning_disabled": True,
            "ordinary_analytics_disabled": True,
            "ordinary_projects_disabled": True,
            "shared_spaces_disabled": True,
        }
    )
    canonical_store = SimpleNamespace(find_session_by_cleanup_obligation_id=lambda cleanup_id: (canonical_record if cleanup_id == raw_claims["cleanup_obligation_id"] else None))
    monkeypatch.setattr(sessions_router, "_store", canonical_store)

    async def runtime_proxy(*_args: object, **_kwargs: object) -> dict[str, object]:
        return {
            **_runtime_payload(session_id),
            "provider_connection_epoch": 2,
        }

    proxy = AsyncMock(side_effect=runtime_proxy)
    monkeypatch.setattr(voice_router, "_proxy_voice_runtime_json", proxy)
    monkeypatch.setattr(
        voice_router,
        "_stage_synthetic_provider_connection_epoch",
        lambda *_args, **_kwargs: True,
    )

    app = FastAPI()
    app.include_router(voice_router.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "voice-lab-user-1"
    response = TestClient(app).post(
        f"/api/sophia/voice-lab-user-1/voice/gemini/continuation-bootstrap?session_id={session_id}",
        headers={VOICE_LAB_CAPABILITY_HEADER: token},
        json={"expected_epoch": 1, "handle_present": True, "secret_generation": 0},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["provider_connection_epoch"] == 2
    assert isinstance(response.json()["provider_cleanup_token"], str)
    assert response.json()["provider_cleanup_expires_at"].endswith("Z")
    proxy.assert_awaited_once()
    assert proxy.await_args.kwargs["capability"]
