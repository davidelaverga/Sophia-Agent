import asyncio

import httpx
import pytest

from deerflow.sophia.langgraph_client_auth import OwnerScopedAuth, langgraph_owner_scope
from deerflow.sophia.langgraph_service_auth import LangGraphServiceAuthError, verify_service_authorization


def test_shared_client_signs_each_task_owner_without_leakage(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-signing-key-" * 3)
    observed = []
    def handler(request):
        claims = verify_service_authorization(request.headers["Authorization"], method=request.method, path=request.url.path)
        observed.append((claims["sub"], claims["path"]))
        return httpx.Response(200, json={})
    async def run():
        async with httpx.AsyncClient(base_url="https://runtime.invalid", auth=OwnerScopedAuth(), transport=httpx.MockTransport(handler)) as client:
            async def work(owner):
                with langgraph_owner_scope(owner):
                    await asyncio.sleep(0)
                    await client.post("/threads")
                    await client.post("/threads/search")
            await asyncio.gather(work("owner-a"), work("owner-b"))
            with pytest.raises(LangGraphServiceAuthError):
                await client.post("/threads")
    asyncio.run(run())
    assert sorted(observed) == [("owner-a", "/threads"), ("owner-a", "/threads/search"), ("owner-b", "/threads"), ("owner-b", "/threads/search")]


def test_scope_resets_after_exception(monkeypatch):
    from deerflow.sophia.langgraph_client_auth import _owner
    with langgraph_owner_scope("outer"):
        with pytest.raises(RuntimeError):
            with langgraph_owner_scope("inner"):
                raise RuntimeError("synthetic")
        assert _owner.get() == "outer"
    assert _owner.get() is None


def test_sdk_factory_uses_installed_client_and_no_incidental_api_key(monkeypatch):
    from deerflow.sophia.langgraph_client_auth import get_client
    monkeypatch.setenv("RENDER_SERVICE_ID", "synthetic-runtime")
    monkeypatch.setenv("LANGSMITH_API_KEY", "MUST_NOT_FORWARD")
    client = get_client(url="https://runtime.invalid")
    assert isinstance(client.http.client.auth, OwnerScopedAuth)
    assert "x-api-key" not in client.http.client.headers
    asyncio.run(client.aclose())
