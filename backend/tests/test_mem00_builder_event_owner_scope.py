"""Authenticated completion events retain owner scope in runtime requests."""
import asyncio
from types import SimpleNamespace
from uuid import uuid4

import httpx
from fastapi import FastAPI

from app.gateway.routers import builder_events as routes
from app.gateway.workers.builder_events import install_builder_events_worker
from deerflow.sophia.builder_event_auth import encode_builder_event_body, signed_builder_event_headers
from deerflow.sophia.langgraph_client_auth import _owner, langgraph_owner_scope
from deerflow.sophia.langgraph_service_auth import verify_service_authorization


def test_signed_webhook_scopes_runtime_hydration_and_persistence(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-event-scope-" * 4)
    monkeypatch.setenv("RENDER_SERVICE_ID", "synthetic-gateway")
    observed, clients = [], []
    def handler(request):
        claims = verify_service_authorization(request.headers["Authorization"], method=request.method, path=request.url.path)
        observed.append((claims["sub"], request.method, request.url.path))
        return httpx.Response(200, json={"values": {"async_tasks": {}}})
    def factory(*, url=None, **kwargs):
        assert kwargs.get("api_key") is None
        http = httpx.AsyncClient(base_url="https://runtime.invalid", transport=httpx.MockTransport(handler))
        clients.append(http)
        async def get_state(thread):
            return (await http.get(f"/threads/{thread}/state")).json()
        async def update_state(thread, values):
            return (await http.post(f"/threads/{thread}/state", json={"values": values})).json()
        return SimpleNamespace(http=SimpleNamespace(client=http), threads=SimpleNamespace(get_state=get_state, update_state=update_state))
    monkeypatch.setattr("langgraph_sdk.get_client", factory)
    monkeypatch.setattr(routes, "_upsert_builder_terminal_artifact", lambda payload: None)
    app = FastAPI()
    install_builder_events_worker(app)
    app.include_router(routes.internal_router)
    owners = {str(uuid4()): "synthetic-owner-a", str(uuid4()): "synthetic-owner-b"}
    async def run():
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                async def send(thread, owner):
                    body = encode_builder_event_body({"thread_id": thread, "task_id": str(uuid4()), "status": "error", "user_id": owner})
                    headers = {**signed_builder_event_headers(body), "Content-Type": "application/json"}
                    response = await client.post("/internal/builder-events", content=body, headers=headers)
                    assert response.status_code == 202, response.text
                await asyncio.gather(*(send(t,o) for t,o in owners.items()))
                # A signed event without an owner cannot borrow ambient identity.
                with langgraph_owner_scope("must-not-borrow"):
                    await send(str(uuid4()), None)
                    assert _owner.get() == "must-not-borrow"
                bad = await client.post("/internal/builder-events", json={"thread_id": str(uuid4()), "task_id": str(uuid4()), "status": "error", "user_id": "forged"})
                assert bad.status_code in (401,403)
                assert _owner.get() is None
        finally:
            for client in clients:
                await client.aclose()
    asyncio.run(run())
    assert len(observed) == 6
    for owner, method, path in observed:
        assert owner == owners[path.split("/")[2]]
    assert sum(method == "POST" for _,method,_ in observed) == 2
