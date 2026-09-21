"""Narrow transport authority must fail before any external effect."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest

from deerflow.sophia import cleanup_fence as fence
from deerflow.sophia import langgraph_voice_lab_auth as authority
from deerflow.sophia.langgraph_service_auth import LangGraphServiceAuthError


@pytest.fixture
def admission(monkeypatch):
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-test")
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "disposable-service-key-" * 3)
    monkeypatch.setattr(fence, "_connect", lambda: None)
    fence._reset_local_cleanup_fences_for_tests()
    now = datetime.now(UTC)
    value = fence.reserve_cleanup_admission(str(uuid4()), now + timedelta(hours=24),
        provider_expires_at=now + timedelta(minutes=30), resource_kind="session", resource_id=str(uuid4()))
    yield value
    fence._reset_local_cleanup_fences_for_tests()


def signed(auth, method, path):
    return next(auth.auth_flow(httpx.Request(method, "https://graph.invalid" + path))).headers["authorization"]


@pytest.mark.parametrize("method,path", [
    ("GET", "/threads/search"), ("POST", "/threads/search"),
    ("POST", "/assistants/search"), ("GET", "/store/items"),
    ("GET", "/threads/{thread}/state"), ("PATCH", "/threads/{thread}"),
    ("POST", "/threads/{thread}/runs"), ("POST", "/threads/{thread}/copy"),
])
def test_create_grant_cannot_become_an_owner_or_model_grant(admission, method, path):
    auth = authority.VoiceLabThreadAuth(admission, purpose="session_create", metadata={})
    with pytest.raises(LangGraphServiceAuthError):
        signed(auth, method, path.format(thread=admission.resource_id))


def test_builder_reservation_is_not_session_authority(admission):
    builder = replace(admission, resource_kind="builder")
    fence._LOCAL_ADMISSIONS[admission.admission_id] = builder
    with pytest.raises(LangGraphServiceAuthError):
        signed(authority.VoiceLabThreadAuth(builder, purpose="session_create"), "POST", "/threads")


def test_signature_expiry_current_admission_and_exact_route_are_required(admission, monkeypatch):
    token = signed(authority.VoiceLabThreadAuth(admission, purpose="session_create"), "POST", "/threads")
    original = authority.verify_authorization(token, method="POST", path="/threads")
    for method, path in [("GET", "/threads"), ("POST", "/threads/" + admission.resource_id)]:
        with pytest.raises(LangGraphServiceAuthError):
            authority.verify_authorization(token, method=method, path=path)
    with pytest.raises(LangGraphServiceAuthError):
        authority.verify_authorization(token[:-2] + "xx", method="POST", path="/threads")
    with monkeypatch.context() as mp:
        mp.setattr(authority.time, "time", lambda: original["exp"])
        with pytest.raises(LangGraphServiceAuthError):
            authority.verify_authorization(token, method="POST", path="/threads")
    fence.release_cleanup_admission(admission)
    with pytest.raises(LangGraphServiceAuthError):
        authority.verify_authorization(token, method="POST", path="/threads")


def test_fence_needs_expired_exact_admission_and_cannot_address_other_threads(admission):
    auth = authority.VoiceLabThreadAuth(admission, purpose="fence", fence_hmac="a" * 64)
    with pytest.raises(LangGraphServiceAuthError):
        signed(auth, "POST", "/threads")
    fence._LOCAL_ADMISSIONS[admission.admission_id] = replace(admission, lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
    token = signed(auth, "POST", "/threads")
    assert authority.verify_authorization(token, method="POST", path="/threads")["purpose"] == "fence"
    with pytest.raises(LangGraphServiceAuthError):
        signed(auth, "DELETE", "/threads/" + str(uuid4()))
    for suffix in ("/state", "/runs", "/history", "/copy"):
        with pytest.raises(LangGraphServiceAuthError):
            signed(auth, "POST", "/threads/" + admission.resource_id + suffix)
