"""The session router's LangGraph calls must be signed.

Regression for 2026-09-19. When the receiving auth policy was installed, four
direct `httpx` callers in `app/gateway/routers/sessions.py` were still sending
unsigned requests. They were denied at the auth layer before any handler ran --
`POST /threads 401 0ms` -- which surfaced to users as "LangGraph thread creation
failed with HTTP 401" and made starting a new session impossible.

Nothing asserted these calls carried a credential, so nothing failed when they
did not. That is the gap these tests close: they assert the Authorization header
exists and is the service credential, for the paths an ordinary session uses.
"""

import httpx
import pytest

from app.gateway.routers import sessions
from deerflow.sophia.langgraph_service_auth import PREFIX, verify_service_authorization

OWNER = "CUyZxRFmDNONbR0eKqkJjTrJ2z8nkDKd"


@pytest.fixture
def signing_secret(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "x" * 64)
    monkeypatch.setenv("LANGGRAPH_URL", "http://langgraph.invalid")
    monkeypatch.delenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", raising=False)


def _capturing_transport(seen, *, json_body=None, status=200):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=json_body if json_body is not None else {})

    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_thread_creation_sends_a_verifiable_owner_credential(signing_secret, monkeypatch):
    seen: list[httpx.Request] = []
    real_client = httpx.AsyncClient

    def client_factory(**kwargs):
        kwargs["transport"] = _capturing_transport(seen, json_body={"thread_id": "t-1"})
        return real_client(**kwargs)

    monkeypatch.setattr(sessions.httpx, "AsyncClient", client_factory)

    thread_id = await sessions._create_langgraph_thread(OWNER)

    assert thread_id == "t-1"
    assert len(seen) == 1
    authorization = seen[0].headers.get("authorization")
    assert authorization, "the request went out UNSIGNED -- this is the 401"
    assert authorization.startswith(PREFIX)
    # Verified, not merely present: the gateway and the policy must agree.
    claims = verify_service_authorization(authorization, method="POST", path="/threads")
    assert claims["sub"] == OWNER
    assert claims["scope"] == "owner"


@pytest.mark.anyio
async def test_authoritative_delete_is_signed_too(signing_secret, monkeypatch):
    """The cleanup path runs after a failed start and must not 401 either."""
    seen: list[httpx.Request] = []
    real_client = httpx.AsyncClient

    def client_factory(**kwargs):
        kwargs["transport"] = _capturing_transport(seen, status=404)
        return real_client(**kwargs)

    monkeypatch.setattr(sessions.httpx, "AsyncClient", client_factory)

    await sessions._delete_langgraph_thread_authoritatively(OWNER, "11111111-1111-4111-8111-111111111111")

    assert seen, "no request was attempted"
    for request in seen:
        authorization = request.headers.get("authorization")
        assert authorization and authorization.startswith(PREFIX), f"unsigned {request.method} {request.url.path}"
        verify_service_authorization(authorization, method=request.method, path=request.url.path)


def test_the_signing_helper_refuses_to_mint_for_the_voice_lab_principal(signing_secret, monkeypatch):
    """The owner credential is for application owners, never the test principal.

    `_scope` refuses it outright, so a caller cannot reach LangGraph by passing
    the Voice Lab identity into the ordinary session path.
    """
    from deerflow.sophia.langgraph_service_auth import LangGraphServiceAuthError, mint_service_authorization

    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-test")
    with pytest.raises(LangGraphServiceAuthError):
        mint_service_authorization(owner_id="voice-lab-test", method="POST", path="/threads")
