"""Real Gateway capability -> httpx signer -> installed LangGraph auth/runtime.

Disposable storage and ASGI transport are explicit seams. No supplied receiving
AuthContext, provider calls, production database, or model execution.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def test_authenticated_synthetic_session_start_reaches_installed_policy(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    source = r'''
import asyncio, json, socket
from dataclasses import replace
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
import httpx
import pytest
from fastapi import FastAPI
from langgraph_api.auth.custom import get_custom_auth_middleware
from langgraph_api.auth.middleware import ConditionalAuthenticationMiddleware, on_error
from langgraph_api.api import threads as routes
from langgraph_api.route import ApiRoute
from starlette.applications import Starlette
from app.gateway.routers import sessions
from deerflow.sophia import cleanup_fence as fence
from deerflow.sophia.session_store import SessionStore
from test_sessions_gateway import _session_create_capability, _enable_voice_lab, _cleanup_id, VOICE_LAB_PROVIDER_EXPIRES_AT

def forbidden_network(*args, **kwargs):
    raise AssertionError("NETWORK_NOT_ALLOWED")
socket.socket.connect = forbidden_network
mp = pytest.MonkeyPatch()
_enable_voice_lab(mp)
mp.setenv("SOPHIA_AUTH_BYPASS", "false")
mp.setattr(fence, "_connect", lambda: None)  # disposable canonical fence store
fence._reset_local_cleanup_fences_for_tests()
conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": [], "crons": []})
@asynccontextmanager
async def connect(**kwargs):
    yield conn
routes.connect = connect  # disposable installed runtime storage
receiver = ConditionalAuthenticationMiddleware(Starlette(routes=[
    ApiRoute("/threads", routes.create_thread, methods=["POST"]),
    ApiRoute("/threads/{thread_id}", routes.get_thread, methods=["GET"]),
    ApiRoute("/threads/{thread_id}", routes.delete_thread, methods=["DELETE"]),
    ApiRoute("/threads/{thread_id}", routes.patch_thread, methods=["PATCH"]),
]), backend=get_custom_auth_middleware(), on_error=on_error)
real_client = httpx.AsyncClient
requests = []
wire_requests = []
lose_create_response = False
class IsolatedTransport(httpx.ASGITransport):
    async def handle_async_request(self, request):
        # A real HTTP server gives each request its own task/context. The
        # installed with_user intentionally leaves that request's context set.
        return await asyncio.create_task(super().handle_async_request(request))
class ObservedTransport(IsolatedTransport):
    async def handle_async_request(self, request):
        requests.append((request.method, request.url.path, bool(request.headers.get("authorization"))))
        wire_requests.append(request)
        response = await super().handle_async_request(request)
        if lose_create_response and request.method == "POST" and request.url.path == "/threads":
            raise httpx.ReadTimeout("disposable lost allocation response", request=request)
        return response
def client_factory(**kwargs):
    kwargs["transport"] = ObservedTransport(app=receiver)
    return real_client(**kwargs)
mp.setattr(sessions.httpx, "AsyncClient", client_factory)
sessions._store = SessionStore(Path.cwd() / "sessions")
anchor = datetime.now(UTC).replace(microsecond=0)
class SessionClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return anchor
mp.setattr(sessions, "datetime", SessionClock)
gateway = FastAPI()
gateway.include_router(sessions.router)  # real require_authenticated_user, no overrides

async def main():
    global lose_create_response
    from langgraph_api.asyncio import set_event_loop
    set_event_loop(asyncio.get_running_loop())
    fence.assert_cleanup_obligation_open(_cleanup_id("run-create-001"),
        anchor + timedelta(hours=24), VOICE_LAB_PROVIDER_EXPIRES_AT)
    async with real_client(transport=httpx.ASGITransport(app=gateway), base_url="http://gateway.test") as client:
        denied = await client.post("/api/v1/sessions/start", json={"user_id":"voice-lab-user-1", "session_type":"voice"})
        assert denied.status_code == 401 and not requests
        response = await client.post("/api/v1/sessions/start",
            headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability()},
            json={"user_id":"voice-lab-user-1", "session_type":"voice"})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["synthetic_test"] is True
        assert len(conn.store["threads"]) == 1 and not conn.store["runs"]
        assert requests == [("POST", "/threads", True)]
        assert conn.store["threads"][0]["metadata"]["cleanup_admission_id"]
        assert fence.cleanup_admissions(_cleanup_id("run-create-001")) == ()
        record = sessions._store.get("voice-lab-user-1", result["session_id"])
        assert record.metadata["memory_retrieval_disabled"] is True
        assert record.metadata["memory_learning_disabled"] is True
        # A released reservation cannot be reused, even with an authentic token.
        first = wire_requests[0]
        async with real_client(transport=IsolatedTransport(app=receiver), base_url="http://graph.test") as graph:
            replay = await graph.post("/threads", content=first.content, headers=first.headers)
            assert replay.status_code == 401
            assert (await graph.post("/threads", json={})).status_code == 401
            # Wrong method/path cannot turn a create credential into model or state access.
            for path in ("/threads/" + result["thread_id"], "/threads/" + result["thread_id"] + "/state", "/threads/" + result["thread_id"] + "/runs"):
                assert (await graph.get(path, headers=first.headers)).status_code == 401

        async def start(run_id):
            cleanup_id = _cleanup_id(run_id)
            fence.assert_cleanup_obligation_open(cleanup_id, anchor + timedelta(hours=24), VOICE_LAB_PROVIDER_EXPIRES_AT)
            return await client.post("/api/v1/sessions/start",
                headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability(test_run_id=run_id, cleanup_obligation_id=cleanup_id)},
                json={"user_id":"voice-lab-user-1", "session_type":"voice"})

        # A failure after graph creation uses signed discard and read-zero before release.
        original_create = sessions._store.create
        def failed_store(*args, **kwargs):
            raise RuntimeError("disposable persistence failure")
        sessions._store.create = failed_store
        try:
            failure = await start("persistence-failure")
            raise AssertionError("persistence failure was swallowed: " + failure.text)
        except RuntimeError as exc:
            assert str(exc) == "disposable persistence failure"
        finally:
            sessions._store.create = original_create
        assert fence.cleanup_admissions(_cleanup_id("persistence-failure")) == ()
        assert len(conn.store["threads"]) == 1

        # Actual receiver allocated; response disappeared. No optimistic release.
        lose_create_response = True
        timed_out = await start("lost-response")
        lose_create_response = False
        assert timed_out.status_code == 503
        admissions = fence.cleanup_admissions(_cleanup_id("lost-response"))
        assert len(admissions) == 1 and len(conn.store["threads"]) == 2
        admission = admissions[0]
        # The retained create token is authentic and still reserved. Changing
        # its target or metadata must fail at the installed policy, not merely
        # because a test omitted the reservation or supplied a fake AuthContext.
        lost_request = next(req for req in reversed(wire_requests) if req.method == "POST")
        allocated_body = json.loads(lost_request.content)
        async with real_client(transport=IsolatedTransport(app=receiver), base_url="http://graph.test") as graph:
            for change in ("thread", "principal", "graph", "obligation"):
                body = json.loads(lost_request.content)
                if change == "thread":
                    body["thread_id"] = result["thread_id"]
                elif change == "principal":
                    body["metadata"]["principal_id"] = "other-owner"
                elif change == "graph":
                    body["metadata"]["graph_id"] = "sophia_builder"
                else:
                    body["metadata"]["cleanup_obligation_id"] = _cleanup_id("other-run")
                rejected = await graph.post("/threads", json=body, headers={"Authorization":lost_request.headers["authorization"]})
                assert rejected.status_code == 403, (change, rejected.text)
            assert len(conn.store["threads"]) == 2 and not conn.store["runs"]
        # Explicit disposable database-clock seam; expiry is eligibility, not zero proof.
        fence._LOCAL_ADMISSIONS[admission.admission_id] = replace(admission, lease_expires_at=anchor - timedelta(seconds=1))
        admission = fence.cleanup_admissions(_cleanup_id("lost-response"))[0]
        from app.gateway.routers.voice_lab_recovery import _cleanup_obligation_id_hmac
        from deerflow.sophia.langgraph_voice_lab_auth import VoiceLabThreadAuth
        from deerflow.sophia.langgraph_service_auth import mint_service_authorization
        digest = _cleanup_obligation_id_hmac(admission.cleanup_obligation_id)
        expected = {"synthetic_cleanup_fence":True, "cleanup_obligation_id_hmac":digest, "resource_kind":"session_thread"}
        assert not await sessions._delete_langgraph_thread_authoritatively("other-owner", admission.resource_id, admission=admission)
        args = dict(cleanup_obligation_id_hmac=digest, retention_expires_at=admission.resource_expires_at, admission=admission)
        assert await sessions._fence_langgraph_thread_cleanup_admission(admission.resource_id, **args)
        assert await sessions._fence_langgraph_thread_cleanup_admission(admission.resource_id, **args)
        fenced = next(row for row in conn.store["threads"] if str(row["thread_id"]) == admission.resource_id)
        assert fenced["metadata"] == expected
        assert not conn.store["runs"]
        # Even an authenticated ordinary owner cannot read this synthetic container.
        path = "/threads/" + admission.resource_id
        async with real_client(transport=IsolatedTransport(app=receiver), base_url="http://graph.test") as graph:
            other = await graph.get(path, headers={"Authorization":mint_service_authorization(owner_id="other-owner", method="GET", path=path)})
            assert other.status_code == 404
            # Ordinary owner metadata cannot volunteer a thread into recovery.
            forged = await graph.patch(path, json={"metadata":expected},
                headers={"Authorization":mint_service_authorization(owner_id="other-owner", method="PATCH", path=path)})
            assert forged.status_code == 403
            # Fence authority cannot create an ordinary companion container.
            auth = VoiceLabThreadAuth(admission, purpose="fence", metadata=expected, fence_hmac=digest)
            malformed = await graph.post("/threads", json={"thread_id":admission.resource_id, "metadata":{"graph_id":"sophia_companion"}}, auth=auth)
            assert malformed.status_code == 403
        fence.release_cleanup_admission(admission)
        assert not await sessions._fence_langgraph_thread_cleanup_admission(admission.resource_id, **args)
        print(json.dumps({"authenticated_session_start":True,"installed_receiving_policy":True,
            "failed_persistence_discard":True,"uncertain_allocation_fenced":True,"repeated_fence":True,"model_runs":0}))
asyncio.run(main())
'''
    env = {**os.environ, "PYTHONPATH": str(backend) + os.pathsep + str(backend / "tests"),
           "DATABASE_URI": ":memory:", "REDIS_URI": "redis://127.0.0.1:1",
           "LANGGRAPH_AUTH_TYPE": "noop", "LANGGRAPH_RUNTIME_EDITION": "inmem",
           "LANGGRAPH_AUTH": json.dumps({"path": str(backend / "packages/harness/deerflow/sophia/langgraph_auth.py") + ":auth", "disable_studio_auth": True}),
           "SOPHIA_BUILDER_EVENTS_HMAC_SECRET": "synthetic-service-signing-key-" * 3,
           "SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET": "synthetic-recovery-key-" * 3,
           "SOPHIA_MEMORY_REFERENCE_HMAC_SECRET": "synthetic-reference-key-" * 3}
    result = subprocess.run([sys.executable, "-c", source], cwd=tmp_path, env=env,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, (result.stdout + result.stderr)[-7000:]
    assert json.loads(result.stdout.splitlines()[-1])["authenticated_session_start"] is True
