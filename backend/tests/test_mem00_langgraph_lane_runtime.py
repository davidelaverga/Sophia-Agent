"""The two service lanes, exercised through the INSTALLED disposable runtime.

`test_mem00_langgraph_service_lanes.py` checks the primitives directly. That is
not the same as checking what the runtime does when the policy is installed:
the filters only mean anything if `langgraph_runtime_inmem` actually applies
them to `Threads.put/get/search/delete`, and the run constraints only mean
anything if the framework hands `create_run` the value it will act on.

Everything here runs in a subprocess with the real policy installed through
`LANGGRAPH_AUTH`, `DATABASE_URI=:memory:`, and `socket.connect` replaced so a
network call is an assertion failure rather than a hang.

Still not installed in production: `langgraph.json` has no `auth` entry and
`test_render_config` asserts that. This is the evidence for the coordinated
install decision, not the install.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

PRINCIPAL = "voice-lab-test"


def _run(source: str, tmp_path) -> dict:
    policy = Path(__file__).resolve().parents[1] / "packages/harness/deerflow/sophia/langgraph_auth.py"
    env = {**os.environ, "DATABASE_URI": ":memory:", "REDIS_URI": "redis://127.0.0.1:1",
           "LANGGRAPH_AUTH_TYPE": "noop",
           "LANGGRAPH_AUTH": json.dumps({"path": str(policy) + ":auth", "disable_studio_auth": True}),
           "SOPHIA_MEMORY_REFERENCE_HMAC_SECRET": "synthetic-framework-key-" * 3,
           "SOPHIA_VOICE_LAB_TEST_PRINCIPAL": PRINCIPAL}
    result = subprocess.run([sys.executable, "-c", source], cwd=tmp_path, env=env,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    return json.loads(result.stdout.splitlines()[-1])


PREAMBLE = r'''
import asyncio, hashlib, json, socket
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4
def forbidden_network(*args, **kwargs):
    raise AssertionError("NETWORK_NOT_ALLOWED")
socket.socket.connect = forbidden_network
from langgraph_sdk import Auth
from langgraph_api.auth.custom import normalize_user
from langgraph_runtime_inmem.ops import Threads
from starlette.exceptions import HTTPException

PRINCIPAL = "voice-lab-test"

def ctx(identity, *permissions):
    return Auth.types.BaseAuthContext(user=normalize_user({"identity": identity}), permissions=list(permissions))

async def collect(iterator):
    return [row async for row in iterator]

def synthetic(principal=PRINCIPAL, run_id="voice-lab-run-1"):
    """The exact shape the product writes; see tests/test_vt00_builder_isolation."""
    anchor = datetime.now(UTC).replace(microsecond=0)
    return {
        "synthetic": True,
        "test_run_id": run_id,
        "principal_id": principal,
        "scenario_id": "builder-presentation",
        "scenario_version": "1.0",
        "environment": "production",
        "cleanup_obligation_id": str(UUID(hex=hashlib.sha256(run_id.encode()).hexdigest()[:32], version=4)),
        "provider_expires_at": (anchor + timedelta(minutes=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "retention_hours": 1,
        "retention_anchor": "builder_task_created_at_provisional",
        "retention_anchor_at": anchor.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "retention_expires_at": (anchor + timedelta(hours=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "deployment_identity": {"frontend_deployment_id": "f-1", "voice_deployment_id": "v-1"},
    }

async def denied(call):
    """Both shapes: the runtime raises Starlette's, a handler raises the SDK's."""
    try:
        await call()
    except (HTTPException, Auth.exceptions.HTTPException) as exc:
        return exc.status_code
    return None


def reachable_store_where_nobody_is_declared():
    """Production's shape for MEM00: the store answers, nobody is enrolled.

    `create_run` resolves durable ownership on every request. Without a store
    it raises the broad unavailable error and denies, which is correct but is
    an artifact of a test environment rather than the behaviour under test.
    """
    from deerflow.sophia.memory_governance import owner_authority
    from deerflow.sophia.memory_governance.store import MemoryOwnerUndeclared

    def undeclared(owner):  # noqa: ARG001 - mirrors the real store signature
        raise MemoryOwnerUndeclared("memory_owner_undeclared")

    owner_authority.configured_memory_store = lambda: SimpleNamespace(
        get_owner_authority=undeclared,
        get_contract=lambda: SimpleNamespace(contract_epoch=1, schema_version="mem00.v1", mode="enforced"))


def authorize(admission, thread_id):
    """Do what `start_builder_task` does before it asks for the thread.

    It reserves a `builder` admission for the exact thread id against an open
    cleanup obligation. Shape alone is not authorization, so the policy checks
    that this reservation exists; a test that skips it is testing the
    unauthorized case, which is exactly what one of the cases below wants.
    """
    from deerflow.sophia.cleanup_fence import reserve_cleanup_admission

    return reserve_cleanup_admission(
        admission["cleanup_obligation_id"],
        admission["retention_expires_at"],
        provider_expires_at=admission["provider_expires_at"],
        resource_kind="builder",
        resource_id=str(thread_id),
    )
'''


def test_maintenance_eligibility_is_not_a_client_suppliable_boolean(tmp_path):
    """The headline restriction.

    A caller who writes `synthetic: true` on their own thread must not thereby
    join the lane that reads and deletes. Three ways of trying it, and the
    legitimate path for contrast.
    """
    receipt = _run(PREAMBLE + r'''
from deerflow.sophia.langgraph_auth import MAINTENANCE_KEY, MAINTENANCE_PERMISSION, USER_PERMISSION

async def main():
    conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": [], "crons": [], "checkpoints": [], "writes": [], "blobs": []})
    user = ctx("ordinary-user", USER_PERMISSION)
    maintenance = ctx("sophia-service-maintenance", MAINTENANCE_PERMISSION)

    # 1. The bare boolean. Denied: a declaration that cannot be backed is not
    #    downgraded to an ordinary thread.
    bare = await denied(lambda: Threads.put(conn, uuid4(), metadata={"synthetic": True}, if_exists="raise", ctx=user))

    # 2. A COMPLETE synthetic admission naming somebody else's principal.
    foreign = await denied(lambda: Threads.put(conn, uuid4(), metadata=synthetic(principal="not-the-configured-one"), if_exists="raise", ctx=user))

    # 3. Supplying the server-issued label directly.
    forged = await denied(lambda: Threads.put(conn, uuid4(), metadata={MAINTENANCE_KEY: True}, if_exists="raise", ctx=user))

    # 4. Complete, correctly shaped, naming the configured principal -- and
    #    never reserved through the cleanup fence. Denied: normalization is not
    #    authorization.
    unauthorized = await denied(lambda: Threads.put(conn, uuid4(), metadata=synthetic(run_id="never-reserved"), if_exists="raise", ctx=user))

    # 5. An ordinary thread, and a legitimately reserved synthetic one.
    ordinary_id, synthetic_id = uuid4(), uuid4()
    await collect(await Threads.put(conn, ordinary_id, metadata={}, if_exists="raise", ctx=user))
    admission = synthetic()
    authorize(admission, synthetic_id)
    created = await collect(await Threads.put(conn, synthetic_id, metadata=admission, if_exists="raise", ctx=user))
    labelled = created[0]["metadata"].get(MAINTENANCE_KEY) is True

    rows, _ = await Threads.search(conn, metadata={}, values={}, status=None, limit=50, offset=0, ctx=maintenance)
    visible = sorted(str(row["thread_id"]) for row in await collect(rows))
    ordinary_read = await denied(lambda: Threads.get(conn, ordinary_id, ctx=maintenance))
    ordinary_delete = await denied(lambda: Threads.delete(conn, ordinary_id, ctx=maintenance))

    print(json.dumps({
        "bare_boolean_denied": bare, "foreign_principal_denied": foreign, "forged_label_denied": forged,
        "unauthorized_but_well_formed_denied": unauthorized,
        "legitimate_thread_labelled": labelled,
        "maintenance_sees_only_the_legitimate_one": visible == [str(synthetic_id)],
        "ordinary_read_denied": ordinary_read, "ordinary_delete_denied": ordinary_delete,
        "network_calls": 0}))
asyncio.run(main())
''', tmp_path)
    assert receipt["bare_boolean_denied"] == 403
    assert receipt["foreign_principal_denied"] == 403
    assert receipt["forged_label_denied"] == 403
    assert receipt["unauthorized_but_well_formed_denied"] == 403, (
        "a complete, correctly shaped declaration with no reservation behind it")
    assert receipt["legitimate_thread_labelled"] is True
    assert receipt["maintenance_sees_only_the_legitimate_one"] is True
    assert receipt["ordinary_read_denied"] == 404
    assert receipt["ordinary_delete_denied"] == 404


def test_legitimate_cleanup_reaches_and_removes_the_synthetic_thread(tmp_path):
    """The lane has to actually work, not only be narrow."""
    receipt = _run(PREAMBLE + r'''
from deerflow.sophia.langgraph_auth import MAINTENANCE_PERMISSION, USER_PERMISSION

async def main():
    conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": [], "crons": [], "checkpoints": [], "writes": [], "blobs": []})
    user = ctx("ordinary-user", USER_PERMISSION)
    maintenance = ctx("sophia-service-maintenance", MAINTENANCE_PERMISSION)
    tid = uuid4()
    admission = synthetic()
    authorize(admission, tid)
    await collect(await Threads.put(conn, tid, metadata=admission, if_exists="raise", ctx=user))

    # What the reaper does: search by the product marker, read identity, delete.
    rows, _ = await Threads.search(conn, metadata={"synthetic": True}, values={}, status=None, limit=50, offset=0, ctx=maintenance)
    found = await collect(rows)
    read = await collect(await Threads.get(conn, tid, ctx=maintenance))
    await Threads.delete(conn, tid, ctx=maintenance)
    gone = await denied(lambda: Threads.get(conn, tid, ctx=maintenance))
    print(json.dumps({"discovered": len(found), "identity_readable": read[0]["metadata"]["test_run_id"],
                      "deleted": gone, "remaining": len(conn.store["threads"]), "network_calls": 0}))
asyncio.run(main())
''', tmp_path)
    assert receipt["discovered"] == 1
    assert receipt["identity_readable"] == "voice-lab-run-1"
    assert receipt["deleted"] == 404
    assert receipt["remaining"] == 0


def test_the_dispatch_lane_is_constrained_to_its_graph_and_request_surface(tmp_path):
    """The thread marker says WHERE; this says WHAT.

    Without it, a dispatch credential could start the companion graph on a
    deck-quality thread, with tools, memory and the model boundary behind it.
    Driven through `Runs.put`, so the constraint is the one the installed
    runtime applies rather than one a handler applies when called directly.
    """
    receipt = _run(PREAMBLE + r'''
from langgraph_runtime_inmem.ops import Runs
from deerflow.sophia.langgraph_auth import (
    DECK_QUALITY_ASSISTANT_ID, DECK_QUALITY_GRAPH_ID, DECK_QUALITY_PERMISSION, USER_PERMISSION)

COMPANION = UUID("6ba7b821-9dad-11d1-80b4-00c04fd430c8")

async def main():
    conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": [], "crons": [], "checkpoints": [], "writes": [], "blobs": []})
    from uuid import uuid5
    other = uuid5(COMPANION, "sophia_companion")
    for assistant_id in (DECK_QUALITY_ASSISTANT_ID, other):
        conn.store["assistants"].append({"assistant_id": assistant_id, "graph_id": "g",
                                         "config": {}, "context": {}, "metadata": {}, "name": "a", "version": 1})
    quality = ctx("sophia-service-deck-quality", DECK_QUALITY_PERMISSION)
    thread_id = uuid4()
    created = await collect(await Threads.put(conn, thread_id, metadata={}, if_exists="raise", ctx=quality))
    thread_labelled = created[0]["metadata"]

    async def start(assistant, **kwargs):
        rows = await Runs.put(conn, assistant, kwargs, thread_id=thread_id, metadata={},
                              prevent_insert_if_inflight=False, multitask_strategy="enqueue",
                              if_not_exists="create", ctx=quality)
        return await collect(rows)

    # The assertion is the AUTHORIZATION outcome, not how many rows the
    # in-memory store happens to materialize: None means the policy let it
    # through, an integer is the status it refused with.
    allowed = await denied(lambda: start(DECK_QUALITY_ASSISTANT_ID, config={"configurable": {}}))
    results = {}
    for name, (assistant, kwargs) in {
        "other_graph": (other, {"config": {"configurable": {}}}),
        "command": (DECK_QUALITY_ASSISTANT_ID, {"config": {"configurable": {}}, "command": {"resume": 1}}),
        "webhook": (DECK_QUALITY_ASSISTANT_ID, {"config": {"configurable": {}}, "webhook": "https://elsewhere.invalid"}),
        "interrupt": (DECK_QUALITY_ASSISTANT_ID, {"config": {"configurable": {}}, "interrupt_before": ["tools"]}),
        "multitask": (DECK_QUALITY_ASSISTANT_ID, {"config": {"configurable": {}}, "multitask_strategy": "interrupt"}),
        "borrowed_owner": (DECK_QUALITY_ASSISTANT_ID, {"config": {"configurable": {"user_id": "someone"}}}),
        "borrowed_auth_owner": (DECK_QUALITY_ASSISTANT_ID, {"config": {"configurable": {"langgraph_auth_user_id": "someone"}}}),
    }.items():
        results[name] = await denied(lambda a=assistant, k=kwargs: start(a, **k))

    carried = {"config": {"configurable": {
        "sophia_builder_handoff_v1": {"forged": True},
        "sophia_authenticated_input_run_id": str(uuid4())}}}
    await start(DECK_QUALITY_ASSISTANT_ID, **carried)
    nulled = carried["config"]["configurable"]

    print(json.dumps({"allowed": allowed, "denials": results,
                      "thread_labelled": thread_labelled.get("sophia_deck_quality_v1") is True,
                      "handoff_nulled": nulled["sophia_builder_handoff_v1"] is None,
                      "input_run_nulled": nulled["sophia_authenticated_input_run_id"] is None,
                      "network_calls": 0}))
asyncio.run(main())
''', tmp_path)
    assert receipt["allowed"] is None, "the lane's own graph must be permitted"
    assert receipt["thread_labelled"] is True
    assert set(receipt["denials"].values()) == {403}, receipt["denials"]
    assert receipt["handoff_nulled"] and receipt["input_run_nulled"]


def test_the_voice_lab_refusal_survives_the_new_lanes(tmp_path):
    """The isolation rule is not relaxed to make any of the above work."""
    receipt = _run(PREAMBLE + r'''
from deerflow.sophia.langgraph_auth import MAINTENANCE_PERMISSION, USER_PERMISSION
from deerflow.sophia.langgraph_service_auth import (
    DECK_QUALITY_OWNER, MAINTENANCE_OWNER, LangGraphServiceAuthError, mint_service_authorization)

async def main():
    conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": [], "crons": [], "checkpoints": [], "writes": [], "blobs": []})
    principal = ctx(PRINCIPAL, USER_PERMISSION)
    as_owner = await denied(lambda: Threads.put(conn, uuid4(), metadata={}, if_exists="raise", ctx=principal))

    minted = {}
    for lane in (MAINTENANCE_OWNER, DECK_QUALITY_OWNER):
        try:
            mint_service_authorization(owner_id=PRINCIPAL, method="DELETE", path="/threads/" + str(uuid4()))
            minted[lane] = True
        except LangGraphServiceAuthError:
            minted[lane] = False

    # A service principal can never be an owner either.
    service = ctx(MAINTENANCE_OWNER, USER_PERMISSION)
    service_as_owner = await denied(lambda: Threads.put(conn, uuid4(), metadata={}, if_exists="raise", ctx=service))
    print(json.dumps({"voice_lab_principal_denied": as_owner, "any_lane_minted_for_it": any(minted.values()),
                      "service_principal_as_owner_denied": service_as_owner,
                      "threads": len(conn.store["threads"]), "network_calls": 0}))
asyncio.run(main())
''', tmp_path)
    assert receipt["voice_lab_principal_denied"] == 403
    assert receipt["any_lane_minted_for_it"] is False
    assert receipt["service_principal_as_owner_denied"] == 403
    assert receipt["threads"] == 0


def test_the_voice_owners_synthetic_builder_path_runs_under_the_installed_policy(tmp_path):
    """The real tool-to-runtime operation, as the Voice Lab principal.

    `start_builder_task` runs in-process under the parent companion run's
    AuthContext, and during a Voice Lab test that parent is the test principal.
    The blanket refusal of that principal therefore stopped Voice Lab's own
    Builder from being created at all -- measured earlier as a flat 403.

    Resolved here by narrowing the refusal rather than dropping it: the
    principal is admitted only for a thread whose cleanup-fence reservation the
    product already made, and only to run the Builder on it. Every ordinary
    surface stays refused, which the second half asserts.
    """
    receipt = _run(PREAMBLE + r"""
from langgraph_runtime_inmem.ops import Runs
from deerflow.sophia.langgraph_auth import BUILDER_ASSISTANT_ID, COMPANION_ASSISTANT_ID, MAINTENANCE_KEY, USER_PERMISSION

async def main():
    conn = SimpleNamespace(store={"threads": [], "runs": [], "assistants": [], "crons": [], "checkpoints": [], "writes": [], "blobs": []})
    for assistant_id in (BUILDER_ASSISTANT_ID, COMPANION_ASSISTANT_ID):
        conn.store["assistants"].append({"assistant_id": assistant_id, "graph_id": "g",
                                         "config": {}, "context": {}, "metadata": {}, "name": "a", "version": 1})
    reachable_store_where_nobody_is_declared()
    principal = ctx(PRINCIPAL, USER_PERMISSION)
    ordinary = ctx("ordinary-user", USER_PERMISSION)

    # --- the path the tool actually takes -------------------------------
    thread_id = uuid4()
    admission = synthetic()
    authorize(admission, thread_id)
    created = await collect(await Threads.put(conn, thread_id, metadata=admission, if_exists="raise", ctx=principal))
    read = await collect(await Threads.get(conn, thread_id, ctx=principal))
    # The installed server inserts these two from the auth context; the ops
    # layer does not, so the test supplies what the real request would carry.
    def run_kwargs(identity):
        return {"config": {"configurable": {"user_id": identity, "langgraph_auth_user_id": identity}},
                "input": {"messages": []}}

    builder_run = await denied(lambda: Runs.put(conn, BUILDER_ASSISTANT_ID, run_kwargs(PRINCIPAL),
        thread_id=thread_id, run_id=uuid4(), metadata={}, prevent_insert_if_inflight=False,
        multitask_strategy="enqueue", if_not_exists="create", ctx=principal))

    # --- and everything ordinary that stays refused ----------------------
    plain_thread = await denied(lambda: Threads.put(conn, uuid4(), metadata={}, if_exists="raise", ctx=principal))
    unreserved = await denied(lambda: Threads.put(conn, uuid4(), metadata=synthetic(run_id="never-reserved"), if_exists="raise", ctx=principal))
    companion_run = await denied(lambda: Runs.put(conn, COMPANION_ASSISTANT_ID, run_kwargs(PRINCIPAL),
        thread_id=thread_id, run_id=uuid4(), metadata={}, prevent_insert_if_inflight=False,
        multitask_strategy="enqueue", if_not_exists="create", ctx=principal))
    others_thread = await denied(lambda: Threads.get(conn, thread_id, ctx=ordinary))

    print(json.dumps({
        "created": len(created) == 1,
        "labelled": created[0]["metadata"].get(MAINTENANCE_KEY) is True,
        "readable_by_its_owner": len(read) == 1,
        "builder_run_admitted": builder_run,
        "plain_thread_denied": plain_thread,
        "unreserved_synthetic_denied": unreserved,
        "companion_run_denied": companion_run,
        "ordinary_owner_cannot_read_it": others_thread,
        "network_calls": 0}))
asyncio.run(main())
""", tmp_path)
    # The Voice owner's path works, end to end, as the principal.
    assert receipt["created"] is True
    assert receipt["labelled"] is True
    assert receipt["readable_by_its_owner"] is True
    assert receipt["builder_run_admitted"] is None, "authorized, not refused"
    # And the refusal is narrowed, not dropped.
    assert receipt["plain_thread_denied"] == 403
    assert receipt["unreserved_synthetic_denied"] == 403
    assert receipt["companion_run_denied"] == 403
    assert receipt["ordinary_owner_cannot_read_it"] == 404
