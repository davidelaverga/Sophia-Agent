import asyncio

import httpx
import pytest
from langgraph_sdk import Auth

from deerflow.sophia import langgraph_auth as policy


@pytest.mark.parametrize("status,payload,expected", [(200, {"id": "owner-a"}, None), (200, {"id": "owner-a", "extra": "private"}, 503),
    (200, [], 503), (401, {}, 401), (403, {}, 401), (302, {}, 503), (404, {}, 503), (500, {}, 503)])
def test_langgraph_subject_resolution_exact_contract(monkeypatch, status, payload, expected):
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "https://gateway.example.invalid")
    real_client = httpx.AsyncClient
    observed = []
    def handler(request):
        observed.append((str(request.url), request.headers.get("authorization")))
        return httpx.Response(status, json=payload)
    monkeypatch.setattr(policy.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    if expected:
        with pytest.raises(Auth.exceptions.HTTPException) as exc:
            asyncio.run(policy.resolve_bearer_subject("synthetic-token"))
        assert exc.value.status_code == expected
    else:
        assert asyncio.run(policy.resolve_bearer_subject("synthetic-token")) == payload
    assert observed == [("https://gateway.example.invalid/api/sophia-auth/subject", "Bearer synthetic-token")]


def test_no_gateway_config_is_closed(monkeypatch):
    monkeypatch.delenv("SOPHIA_GATEWAY_URL", raising=False)
    with pytest.raises(Auth.exceptions.HTTPException) as exc:
        asyncio.run(policy.resolve_bearer_subject("synthetic-token"))
    assert exc.value.status_code == 503


def test_gateway_outage_is_closed_without_exception_payload(monkeypatch):
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "https://gateway.example.invalid")
    real_client = httpx.AsyncClient
    def handler(request):
        raise httpx.ConnectError("PRIVATE_EXCEPTION_DATA")
    monkeypatch.setattr(policy.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(Auth.exceptions.HTTPException) as exc:
        asyncio.run(policy.resolve_bearer_subject("synthetic-token"))
    assert exc.value.status_code == 503
    assert "PRIVATE" not in str(exc.value)


def test_readiness_token_does_not_authorize_thread_access(monkeypatch):
    from types import SimpleNamespace

    from deerflow.sophia.langgraph_service_auth import READINESS_OWNER, mint_service_authorization
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-signing-key-" * 3)
    token = mint_service_authorization(owner_id=READINESS_OWNER, method="POST", path="/assistants/search")
    user = asyncio.run(policy.authenticate(token, "POST", "/assistants/search"))
    ctx = SimpleNamespace(user=SimpleNamespace(identity=user["identity"]), permissions=user["permissions"])
    assert asyncio.run(policy.system_assistants(ctx, {})) == {"created_by": "system"}
    with pytest.raises(Auth.exceptions.HTTPException):
        asyncio.run(policy.owned_thread(ctx, {}))
