"""Exercise installed LangGraph authorization/filter application in isolation."""

import json
import os
import subprocess
import sys
from pathlib import Path


def test_installed_thread_operations_enforce_owner_filters(tmp_path):
    source = r'''
import asyncio, json, socket
from types import SimpleNamespace
from uuid import uuid4
def forbidden_network(*args, **kwargs):
    raise AssertionError("NETWORK_NOT_ALLOWED")
socket.socket.connect = forbidden_network
from langgraph_sdk import Auth
from langgraph_api.auth.custom import normalize_user
from langgraph_runtime_inmem.ops import Threads
from starlette.exceptions import HTTPException

async def collect(iterator):
    return [row async for row in iterator]
async def main():
    conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": []})
    a = Auth.types.BaseAuthContext(user=normalize_user({"identity":"owner-a"}), permissions=["sophia:user"])
    b = Auth.types.BaseAuthContext(user=normalize_user({"identity":"owner-b"}), permissions=["sophia:user"])
    tid = uuid4()
    created = await collect(await Threads.put(conn, tid, metadata={}, if_exists="raise", ctx=a))
    assert len(created) == 1
    assert "sophia_authenticated_owner_v1" in created[0]["metadata"]
    assert len(await collect(await Threads.get(conn, tid, ctx=a))) == 1
    replay = await collect(await Threads.put(conn, tid, metadata={}, if_exists="do_nothing", ctx=a))
    assert len(replay) == 1 and replay[0]["thread_id"] == tid
    try:
        await Threads.get(conn, tid, ctx=b)
        raise AssertionError("wrong owner read succeeded")
    except HTTPException as exc:
        assert exc.status_code == 404
    for context, count in ((a, 1), (b, 0)):
        rows, _ = await Threads.search(conn, metadata={}, values={}, status=None, limit=10, offset=0, ctx=context)
        assert len(await collect(rows)) == count
    try:
        await Threads.put(conn, tid, metadata={}, if_exists="do_nothing", ctx=b)
        raise AssertionError("existing checkpoint claimed")
    except HTTPException as exc:
        assert exc.status_code == 409
    assert len(conn.store["threads"]) == 1
    print(json.dumps({"schema":"mem00.framework-owner-test.v1","owner_create_read":True,"wrong_owner_read_search_zero":True,"existing_claim_denied":True,"network_calls":0}))
asyncio.run(main())
'''
    policy = Path(__file__).resolve().parents[1] / "packages/harness/deerflow/sophia/langgraph_auth.py"
    env = {**os.environ, "DATABASE_URI": ":memory:", "REDIS_URI": "redis://127.0.0.1:1",
           "LANGGRAPH_AUTH_TYPE": "noop", "LANGGRAPH_AUTH": json.dumps({"path": str(policy) + ":auth", "disable_studio_auth": True}),
           "SOPHIA_MEMORY_REFERENCE_HMAC_SECRET": "synthetic-framework-key-" * 3,
           "SOPHIA_VOICE_LAB_TEST_PRINCIPAL": "voice-lab-test"}
    result = subprocess.run([sys.executable, "-c", source], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    receipt = json.loads(result.stdout.splitlines()[-1])
    assert receipt["wrong_owner_read_search_zero"] and receipt["network_calls"] == 0


def test_installed_run_get_handler_keeps_exact_owner_thread_run_and_status(tmp_path):
    # Uses installed ApiRoute/get_run/Threads.get/Runs.get and SDK ASGI transport.
    # Parent authentication, app assembly and seeded in-memory persistence are
    # explicit seams, NOT worker execution, a native browser or hosted proof.
    source = r'''
import asyncio, json, socket, sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4
def forbidden_network(*args, **kwargs):
    raise AssertionError("NETWORK_NOT_ALLOWED")
socket.socket.connect = forbidden_network
from langgraph_api.auth.custom import normalize_user
from langgraph_api.auth.middleware import ConditionalAuthenticationMiddleware
from langgraph_api.api import runs as routes
from langgraph_api.route import ApiRoute
from langgraph_api.utils import AuthContext, set_auth_ctx
from langgraph_runtime_inmem.ops import Threads
from starlette.applications import Starlette
from deerflow.sophia.langgraph_client_auth import get_client

conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": []})
@asynccontextmanager
async def connect():
    yield conn
routes.connect = connect
class ParentAuthOnly:
    async def authenticate(self, request):
        raise AssertionError("PARENT_AUTH_REQUIRED")
app = ConditionalAuthenticationMiddleware(Starlette(routes=[
    ApiRoute("/threads/{thread_id}/runs/{run_id}", routes.get_run, methods=["GET"])
]), backend=ParentAuthOnly())
sys.modules["langgraph_api.server"] = SimpleNamespace(app=app)
async def main():
    from langgraph_api.asyncio import set_event_loop
    set_event_loop(asyncio.get_running_loop())
    tid, other_tid, run_id = uuid4(), uuid4(), uuid4()
    set_auth_ctx(normalize_user({"identity":"owner-a"}), ["sophia:user"])
    for thread in (tid, other_tid):
        assert len([row async for row in await Threads.put(conn, thread, metadata={}, if_exists="raise")]) == 1
    row = dict(run_id=run_id, thread_id=tid, assistant_id=uuid4(), status="pending", metadata={}, kwargs={},
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc), multitask_strategy="reject")
    conn.store["runs"].append(row)
    client = get_client(url=None)
    statuses = ["pending", "running", "error", "timeout", "interrupted", "success"]
    try:
        for status in statuses:
            row["status"] = status
            result = await client.runs.get(str(tid), str(run_id))
            assert result["thread_id"] == str(tid) and result["run_id"] == str(run_id) and result["status"] == status
        for identity, target_thread, target_run in [("owner-b", tid, run_id), ("owner-a", other_tid, run_id), ("owner-a", tid, uuid4())]:
            set_auth_ctx(normalize_user({"identity":identity}), ["sophia:user"])
            try:
                await client.runs.get(str(target_thread), str(target_run))
                raise AssertionError("WRONG_SCOPE_RUN_READ_SUCCEEDED")
            except Exception as exc:
                assert getattr(getattr(exc, "response", None), "status_code", None) == 404
        assert len(conn.store["runs"]) == 1 and row["status"] == "success"
    finally:
        await client.aclose()
        AuthContext.set(None)
        conn.store.clear()
    print(json.dumps({"installed_run_get":True,"statuses":len(statuses),"wrong_scope_denials":3,"network_calls":0,"worker_lifecycle_qualified":False}))
asyncio.run(main())
'''
    policy = Path(__file__).resolve().parents[1] / "packages/harness/deerflow/sophia/langgraph_auth.py"
    env = {**os.environ, "DATABASE_URI": ":memory:", "REDIS_URI": "redis://127.0.0.1:1",
        "LANGGRAPH_AUTH_TYPE": "noop", "LANGGRAPH_AUTH": json.dumps({"path": str(policy) + ":auth", "disable_studio_auth": True}),
        "SOPHIA_MEMORY_REFERENCE_HMAC_SECRET": "synthetic-framework-key-" * 3,
        "SOPHIA_VOICE_LAB_TEST_PRINCIPAL": "voice-lab-test", "LANGGRAPH_RUNTIME_EDITION": "inmem"}
    result = subprocess.run([sys.executable, "-c", source], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    receipt = json.loads(result.stdout.splitlines()[-1])
    assert receipt == dict(installed_run_get=True, statuses=6, wrong_scope_denials=3, network_calls=0, worker_lifecycle_qualified=False)


def test_installed_loopback_retains_owner_and_replaces_run_proofs(tmp_path):
    source = r'''
import asyncio, json, socket, sys, os
from types import SimpleNamespace
from uuid import UUID, uuid4
def forbidden_network(*args, **kwargs):
    raise AssertionError("NETWORK_NOT_ALLOWED")
socket.socket.connect = forbidden_network
from langgraph_api.auth.custom import normalize_user
from langgraph_api.auth.middleware import ConditionalAuthenticationMiddleware
from langgraph_api.models.run import create_valid_run
from langgraph_api.route import ApiRoute
from langgraph_api.utils import AuthContext, get_auth_ctx, set_auth_ctx
from langgraph_runtime_inmem.ops import Threads
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from deerflow.sophia.langgraph_auth import COMPANION_ASSISTANT_ID, OWNER_KEY
from deerflow.sophia.langgraph_client_auth import get_client
HANDOFF_KEY, HANDOFF_RUN_KEY = "sophia_builder_handoff_v1", "sophia_builder_handoff_run_v1"
COMPLETION_REQUEST_KEY, COMPLETION_RUN_KEY = "sophia_builder_completion_request_v1", "sophia_builder_completion_run_v1"
from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY, verified_current_input
from langchain_core.messages import HumanMessage
sys.path.insert(0, os.environ["MEM00_RECORDED_INPUT_TEST_DIR"])
from mem00_recorded_input_fixture import RecordedInputFixture
from deerflow.sophia.memory_governance import store as governance_store
from deerflow.sophia.memory_governance import owner_authority
# Explicit synthetic authority seam; installed runtime/auth merging stays real.
owner_authority.resolve_owner_authority = lambda owner: SimpleNamespace(user_id=owner, authority_state="governed")
source_store = RecordedInputFixture()
governance_store.configured_memory_store = lambda: source_store

conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": [{"assistant_id": COMPANION_ASSISTANT_ID,
    "graph_id":"sophia_companion", "config":{}, "context":{}, "metadata":{"created_by":"system"}}]})
observed = []
async def endpoint(request):
    observed.append(get_auth_ctx().user.identity)
    payload = await request.json()
    run = await create_valid_run(conn, request.path_params["tid"], payload, {})
    return JSONResponse({"run_id": str(run["run_id"]), "thread_id": str(run["thread_id"])})
class MustNotReauthenticate:
    async def authenticate(self, request):
        raise AssertionError("LOOPBACK_MUST_PRESERVE_PARENT_AUTH")
app = ConditionalAuthenticationMiddleware(Starlette(routes=[ApiRoute("/threads/{tid}/runs", endpoint, methods=["POST"])]), backend=MustNotReauthenticate())
# Only substitute the app assembly: SDK transport, ApiRoute, create_valid_run,
# auth callback, installed runtime writes and config merging remain real.
sys.modules["langgraph_api.server"] = SimpleNamespace(app=app)

async def main():
    set_auth_ctx(normalize_user({"identity":"owner-a"}), ["sophia:user"])
    from langgraph_api.asyncio import set_event_loop
    set_event_loop(asyncio.get_running_loop())
    tid = uuid4()
    rows = [row async for row in await Threads.put(conn, tid, metadata={}, if_exists="raise")]
    # A previous admitted run's config is retained by the framework. Fake old
    # proof bytes need not be valid: NONE of them may survive into the next run.
    rows[0]["config"] = {"configurable": {HANDOFF_KEY:{"old":True}, HANDOFF_RUN_KEY:{"old":True}, INPUT_PROOF_KEY:{"old":True}, INPUT_RUN_KEY:"old",
        COMPLETION_REQUEST_KEY:{"old":True}, COMPLETION_RUN_KEY:{"old":True}}}
    client = get_client(url=None)
    try:
        source_session, action = source_store.record("owner-a", str(tid), "CURRENT_SYNTHETIC_INPUT")
        result = await client.runs.create(str(tid), str(COMPANION_ASSISTANT_ID), input={"messages":[{"role":"user","content":"CURRENT_SYNTHETIC_INPUT"}]},
            config={"configurable":{"memory_source_action":action,"memory_source_session_id":source_session}})
        run = conn.store["runs"][-1]
        cfg = run["kwargs"]["config"]["configurable"]
        assert cfg["langgraph_auth_user_id"] == cfg["user_id"] == "owner-a"
        assert cfg.get(HANDOFF_KEY) is None, "OLD_TRANSPORT_PROOF_SURVIVED"
        assert cfg.get(HANDOFF_RUN_KEY) is None, "OLD_HANDOFF_PROOF_SURVIVED"
        assert cfg.get(COMPLETION_REQUEST_KEY) is None, "OLD_COMPLETION_REQUEST_SURVIVED"
        assert cfg.get(COMPLETION_RUN_KEY) is None, "OLD_COMPLETION_PROOF_SURVIVED"
        assert cfg[INPUT_RUN_KEY] == result["run_id"]
        assert cfg["memory_source_action"] is None and cfg["memory_source_session_id"] is None
        messages = [HumanMessage(**item) for item in run["kwargs"]["input"]["messages"]]
        assert verified_current_input(proof=cfg[INPUT_PROOF_KEY], owner_id="owner-a", thread_id=tid, run_id=UUID(result["run_id"]), messages=messages)
        set_auth_ctx(normalize_user({"identity":"owner-b"}), ["sophia:user"])
        try:
            await client.runs.create(str(tid), str(COMPANION_ASSISTANT_ID), input={"messages":[{"role":"user","content":"other"}]})
            raise AssertionError("WRONG_OWNER_RUN_SUCCEEDED")
        except Exception as exc:
            assert getattr(getattr(exc, "response", None), "status_code", None) == 403
        assert len(conn.store["runs"]) == 1
        assert observed == ["owner-a", "owner-b"]
        assert "x-api-key" not in client.http.client.headers
    finally:
        await client.aclose()
        AuthContext.set(None)
    print(json.dumps({"loopback_owner_preserved":True,"wrong_owner_zero_runs":True,"fresh_proof_only":True,"network_calls":0}))
asyncio.run(main())
'''
    policy = Path(__file__).resolve().parents[1] / "packages/harness/deerflow/sophia/langgraph_auth.py"
    env = {**os.environ, "DATABASE_URI": ":memory:", "REDIS_URI": "redis://127.0.0.1:1",
           "LANGGRAPH_AUTH_TYPE": "noop", "LANGGRAPH_AUTH": json.dumps({"path": str(policy) + ":auth", "disable_studio_auth": True}),
           "SOPHIA_MEMORY_REFERENCE_HMAC_SECRET": "synthetic-framework-key-" * 3,
           "SOPHIA_MEMORY_COHORT_PRINCIPALS": "owner-a,owner-b", "SOPHIA_VOICE_LAB_TEST_PRINCIPAL": "voice-lab-test",
           "LANGSMITH_API_KEY": "MUST_NOT_FORWARD", "LANGGRAPH_RUNTIME_EDITION": "inmem",
           "MEM00_RECORDED_INPUT_TEST_DIR": str(Path(__file__).resolve().parent)}
    for name in ("CANDIDATE_LEDGER_WRITE", "CANDIDATE_LEDGER_READ", "CANONICAL_POOL_READ", "PROVIDER_PROJECTION", "GOVERNED_RUNTIME_READ"):
        env["SOPHIA_MEMORY_" + name] = "true"
    result = subprocess.run([sys.executable, "-c", source], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    receipt = json.loads(result.stdout.splitlines()[-1])
    assert receipt["fresh_proof_only"] and receipt["wrong_owner_zero_runs"] and receipt["network_calls"] == 0
