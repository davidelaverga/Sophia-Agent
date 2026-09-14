from uuid import uuid4

import pytest

from deerflow.sophia.langgraph_service_auth import READINESS_OWNER, LangGraphServiceAuthError, mint_service_authorization, verify_service_authorization


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-service-key-" * 3)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-test")


@pytest.mark.parametrize("method,path", [("POST", "/threads"), ("POST", "/threads/search"), ("GET", "/threads/" + str(uuid4())),
    ("POST", "/threads/" + str(uuid4()) + "/runs/stream"), ("POST", "/threads/" + str(uuid4()) + "/state"), ("POST", "/assistants/search")])
def test_exact_route_and_owner(method, path):
    value = mint_service_authorization(owner_id="owner-a", method=method, path=path, now=100)
    claims = verify_service_authorization(value, method=method, path=path, now=101)
    assert claims["sub"] == "owner-a"
    assert "synthetic-service-key" not in value


@pytest.mark.parametrize("changed", [{"method": "DELETE"}, {"path": "/threads/search"}, {"now": 99}, {"now": 130}, {"now": 10000}])
def test_wrong_route_or_expired_token_denied(changed):
    value = mint_service_authorization(owner_id="owner-a", method="POST", path="/threads", now=100)
    args = {"method": "POST", "path": "/threads", "now": 101, **changed}
    with pytest.raises(LangGraphServiceAuthError):
        verify_service_authorization(value, **args)


@pytest.mark.parametrize("owner,path", [("voice-lab-test", "/threads"), (READINESS_OWNER, "/threads"), ("../owner", "/threads"),
    ("owner-a", "/store/items"), ("owner-a", "/assistants"), ("owner-a", "/crons"), ("owner-a", "/threads/../assistants"),
    ("owner-a", "https://other.invalid/threads"), ("owner-a", "/threads?owner=other")])
def test_forbidden_scope_cannot_be_minted(owner, path):
    with pytest.raises(LangGraphServiceAuthError):
        mint_service_authorization(owner_id=owner, method="POST", path=path, now=100)


def test_readiness_cannot_be_reused_for_threads():
    value = mint_service_authorization(owner_id=READINESS_OWNER, method="POST", path="/assistants/search", now=100)
    assert verify_service_authorization(value, method="POST", path="/assistants/search", now=101)["scope"] == "readiness"
    with pytest.raises(LangGraphServiceAuthError):
        verify_service_authorization(value, method="POST", path="/threads", now=101)


def test_tamper_and_cross_key_denied(monkeypatch):
    value = mint_service_authorization(owner_id="owner-a", method="POST", path="/threads", now=100)
    with pytest.raises(LangGraphServiceAuthError):
        verify_service_authorization(value + "x", method="POST", path="/threads", now=101)
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "different-synthetic-key-" * 3)
    with pytest.raises(LangGraphServiceAuthError):
        verify_service_authorization(value, method="POST", path="/threads", now=101)


def test_missing_key_does_not_mint(monkeypatch):
    monkeypatch.delenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET")
    with pytest.raises(LangGraphServiceAuthError):
        mint_service_authorization(owner_id="owner-a", method="POST", path="/threads", now=100)
