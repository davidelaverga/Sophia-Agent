"""Actual installed SDK requests from artifact/canvas association readers."""

import asyncio
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.gateway.routers import artifacts, builder_canvas
from deerflow.sophia.langgraph_client_auth import langgraph_owner_scope
from deerflow.sophia.langgraph_service_auth import verify_service_authorization


def test_association_readers_use_current_owner_at_sdk_transport(monkeypatch):
    import langgraph_sdk

    monkeypatch.setenv("RENDER_SERVICE_ID", "synthetic-gateway")
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-owner-transport-" * 3)
    monkeypatch.setenv("LANGSMITH_API_KEY", "MUST_NOT_FORWARD")
    for module in (artifacts, builder_canvas):
        monkeypatch.setattr(module, "_langgraph_url", lambda: "https://runtime.invalid")
    observed, clients = [], []
    original = langgraph_sdk.get_client
    def factory(**kwargs):
        client = original(**kwargs)
        clients.append(client)
        return client
    monkeypatch.setattr(langgraph_sdk, "get_client", factory)
    async def transport(self, request):
        assert request.headers.get("x-api-key") is None
        claims = verify_service_authorization(request.headers["Authorization"], method=request.method, path=request.url.path)
        observed.append((claims["sub"], request.url.path))
        return httpx.Response(200, request=request, json={"values": {"async_tasks": {}}})
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", transport)
    threads = {"synthetic-owner-a": str(uuid4()), "synthetic-owner-b": str(uuid4())}
    async def run():
        try:
            async def read(owner, thread):
                with langgraph_owner_scope(owner):
                    assert await artifacts._associated_builder_task_thread_ids(thread) == ()
                    assert await builder_canvas._parent_builder_tasks(thread) == []
            await asyncio.gather(*(read(owner, thread) for owner, thread in threads.items()))
            count = len(observed)
            with pytest.raises(HTTPException) as denied:
                await builder_canvas._parent_builder_tasks(str(uuid4()))
            assert denied.value.status_code == 503
            assert await artifacts._associated_builder_task_thread_ids(str(uuid4())) == ()
            assert len(observed) == count
        finally:
            for client in clients:
                await client.aclose()
    asyncio.run(run())
    assert sorted(observed) == sorted((owner, f"/threads/{thread}/state") for owner, thread in threads.items() for _ in range(2))
