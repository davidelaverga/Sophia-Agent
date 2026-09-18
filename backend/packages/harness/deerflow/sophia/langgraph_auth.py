"""Owner-scoped LangGraph policy, staged until internal callers are migrated.

Authentication reuses the existing user-token bridge. Thread metadata is an
access-control index, never a memory authority. Existing unlabelled checkpoints
are not claimed or imported by this policy. Health/custom HTTP routes retain
their existing independent protection. Do not enable the JSON auth entry until
service callers and checkpoint continuation have passed compatibility tests.
"""

from __future__ import annotations

import os
from uuid import UUID, uuid5

import httpx
from langgraph_sdk import Auth
from starlette.exceptions import HTTPException

from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.sophia.memory_governance.refs import keyed_ref

auth = Auth()
OWNER_KEY = "sophia_authenticated_owner_v1"
USER_PERMISSION = "sophia:user"
READINESS_PERMISSION = "sophia:readiness"
MAINTENANCE_PERMISSION = "sophia:maintenance"
DECK_QUALITY_PERMISSION = "sophia:deck-quality"
# The synthetic marker the product itself writes onto Voice Lab Builder threads.
# It is the maintenance lane's entire visible universe: the filter below means
# that lane can never see, read or delete a thread the product did not mark.
SYNTHETIC_KEY = "synthetic"
# The dispatcher's own marker, written by this policy on create -- never taken
# from the client -- so the lane's filter cannot be widened from outside.
DECK_QUALITY_KEY = "sophia_deck_quality"
_SERVICE_SCOPE_PERMISSIONS = {
    "readiness": [READINESS_PERMISSION],
    "maintenance": [MAINTENANCE_PERMISSION],
    "deck_quality": [DECK_QUALITY_PERMISSION],
}
COMPANION_ASSISTANT_ID = uuid5(UUID("6ba7b821-9dad-11d1-80b4-00c04fd430c8"), "sophia_companion")
BUILDER_ASSISTANT_ID = uuid5(UUID("6ba7b821-9dad-11d1-80b4-00c04fd430c8"), "sophia_builder")


def _deny(status: int = 403):
    raise Auth.exceptions.HTTPException(status_code=status, detail="sophia_auth_unavailable" if status == 503 else "sophia_access_denied")


def _owner(ctx) -> str:
    if USER_PERMISSION not in ctx.permissions:
        _deny()
    try:
        owner = validate_user_id(ctx.user.identity)
        if owner != ctx.user.identity:
            _deny()
        if owner == (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip():
            _deny()
        # A service principal is not an account and can never be an owner, even
        # if a real identity ever collided with one of those reserved names.
        from deerflow.sophia.langgraph_service_auth import SERVICE_OWNERS
        if owner in SERVICE_OWNERS:
            _deny()
        return owner
    except Auth.exceptions.HTTPException:
        raise
    except Exception:
        _deny()


def _filter(ctx) -> dict[str, str]:
    try:
        # Domain-separated, unguessable label prevents pre-auth public metadata
        # from being mistaken for a server-issued ownership label.
        return {OWNER_KEY: keyed_ref("langgraph-access-owner", _owner(ctx))}
    except Auth.exceptions.HTTPException:
        raise
    except Exception:
        _deny(503)


def _reject_owner_metadata(value):
    metadata = value.get("metadata")
    if metadata is not None and (not isinstance(metadata, dict) or OWNER_KEY in metadata):
        _deny()
    # DECK_QUALITY_KEY is a server-issued lane label like OWNER_KEY, so a client
    # may not supply it either -- otherwise a user could mark their own thread
    # and place it inside the dispatcher lane's filter. SYNTHETIC_KEY is NOT
    # rejected here: it is product-authored Voice Lab admission metadata that
    # legitimately arrives on the create path, and it is the maintenance lane's
    # confinement rather than its grant.
    if isinstance(metadata, dict) and DECK_QUALITY_KEY in metadata:
        _deny()


@auth.authenticate
async def authenticate(authorization: str | None, method: str = "", path: str = ""):
    try:
        return await _authenticate(authorization, method, path)
    except Auth.exceptions.HTTPException as error:
        if error.status_code >= 500:
            # Installed CustomAuthBackend translates SDK401/403 only. SDK503
            # otherwise becomes500 and logs its chained bridge exception.
            # Keep absence/unavailability distinct from access denial without
            # exposing provider/auth bodies or authorizing any request.
            raise HTTPException(status_code=503, detail="sophia_auth_unavailable",
                headers={"Cache-Control": "no-store"}) from None
        raise


async def _authenticate(authorization: str | None, method: str = "", path: str = ""):
    if not isinstance(authorization, str):
        _deny(401)
    from deerflow.sophia.langgraph_service_auth import PREFIX, verify_service_authorization
    if authorization.startswith(PREFIX):
        try:
            claims = verify_service_authorization(authorization, method=method, path=path)
        except Exception:
            _deny(401)
        permissions = _SERVICE_SCOPE_PERMISSIONS.get(claims["scope"])
        if permissions is None:
            permissions = [USER_PERMISSION, "sophia:service"]
        return {"identity": claims["sub"], "permissions": list(permissions)}
    scheme, separator, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not separator or not token or token != token.strip():
        _deny(401)
    # Do not honor the development bypass or accept user_id as authentication.
    try:
        payload = await resolve_bearer_subject(token)
        owner = validate_user_id(payload["id"])
        if owner != payload["id"]:
            _deny(401)
    except Auth.exceptions.HTTPException:
        raise
    except Exception:
        _deny(503)
    if owner == (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip():
        _deny()
    return {"identity": owner, "permissions": [USER_PERMISSION]}


async def resolve_bearer_subject(token: str) -> dict:
    # LangGraph already has SOPHIA_GATEWAY_URL for Builder events. Resolve via
    # the Gateway's existing auth bridge rather than guessing localhost:8000.
    gateway = (os.getenv("SOPHIA_GATEWAY_URL") or "").strip().rstrip("/")
    if not gateway:
        _deny(503)
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            response = await client.get(gateway + "/api/sophia-auth/subject", headers={"Authorization": "Bearer " + token})
        if response.status_code in {401, 403}:
            _deny(401)
        if response.status_code != 200:
            _deny(503)
        payload = response.json()
        if not isinstance(payload, dict) or set(payload) != {"id"}:
            _deny(503)
        return payload
    except Auth.exceptions.HTTPException:
        raise
    except Exception:
        _deny(503)


@auth.on
async def deny_unspecified(ctx, value):
    # Store, crons, assistant mutation and new resource actions are denied.
    return False


@auth.on.threads.create
async def create_thread(ctx, value):
    _reject_owner_metadata(value)
    if MAINTENANCE_PERMISSION in ctx.permissions:
        # Retention maintenance deletes; it never creates.
        _deny()
    if DECK_QUALITY_PERMISSION in ctx.permissions:
        # Same idempotency rule as the owner lane below: the dispatcher relies
        # on a deterministic thread id plus do_nothing, and the filter is
        # applied to the existing row, so a response-loss replay cannot claim
        # another lane's thread.
        if value.get("if_exists", "raise") not in {"raise", "do_nothing"}:
            _deny()
        quality_filter = {DECK_QUALITY_KEY: True}
        value.setdefault("metadata", {}).update(quality_filter)
        return quality_filter
    owner_filter = _filter(ctx)
    # The installed runtime applies this filter to the EXISTING row before
    # honoring do_nothing. Same-owner response-loss retries remain idempotent;
    # a different owner cannot claim or read the existing checkpoint.
    if value.get("if_exists", "raise") not in {"raise", "do_nothing"}:
        _deny()
    value.setdefault("metadata", {}).update(owner_filter)
    return owner_filter


def _service_thread_filter(ctx):
    """The non-owner lanes' visible universe, or None if this is not one.

    Returned as a metadata filter rather than as an exemption, so the runtime
    applies the same mechanism it applies to an owner. Maintenance sees only
    threads the product marked synthetic; nothing else on the server exists for
    it. Deck quality reaches only its own deterministic quality threads, which
    it addresses by id, so it gets no search surface here at all.
    """
    if MAINTENANCE_PERMISSION in ctx.permissions:
        return {SYNTHETIC_KEY: True}
    if DECK_QUALITY_PERMISSION in ctx.permissions:
        return {DECK_QUALITY_KEY: True}
    return None


@auth.on.threads
async def owned_thread(ctx, value):
    _reject_owner_metadata(value)
    service = _service_thread_filter(ctx)
    if service is not None:
        return service
    return _filter(ctx)


@auth.on.threads.create_run
async def create_run(ctx, value):
    _reject_owner_metadata(value)
    if MAINTENANCE_PERMISSION in ctx.permissions:
        # The retention lane may cancel a run. It may never start one, so no
        # memory, source or model path can ever be entered through it.
        _deny()
    if DECK_QUALITY_PERMISSION in ctx.permissions:
        return {DECK_QUALITY_KEY: True}
    owner = _owner(ctx)
    kwargs = value.get("kwargs")
    if not isinstance(kwargs, dict):
        _deny()
    config = kwargs.setdefault("config", {})
    if not isinstance(config, dict):
        _deny()
    configurable = config.setdefault("configurable", {})
    if not isinstance(configurable, dict):
        _deny()
    if configurable.get("user_id", owner) != owner:
        _deny()
    # These fields were inserted by the installed server from the auth context;
    # its public write schemas reject client-supplied reserved auth fields.
    if configurable.get("langgraph_auth_user_id") != owner:
        _deny()
    configurable["user_id"] = owner
    context = kwargs.get("context")
    if context is None:
        context = kwargs["context"] = {}
    if not isinstance(context, dict) or context.get("user_id", owner) not in (None, owner):
        _deny()
    context["user_id"] = owner
    if value.get("thread_id") is not None:
        try:
            thread_id = str(UUID(str(value["thread_id"])))
        except (ValueError, TypeError):
            _deny()
        for source in (configurable, context):
            if source.get("thread_id") is not None and str(source["thread_id"]) != thread_id:
                _deny()
            source["thread_id"] = thread_id
    # A client must never supply or replay a run-source proof. Every request
    # overwrites this field; only the authenticated create-run hook can mint it.
    from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
    from deerflow.sophia.memory_governance.owner_authority import resolve_owner_authority
    from deerflow.sophia.memory_governance.source_input_provenance import SOURCE_ACTION_KEY, SOURCE_SESSION_KEY
    from deerflow.sophia.memory_governance.store import MemoryOwnerUndeclared

    source_action, source_session = configurable.get(SOURCE_ACTION_KEY), configurable.get(SOURCE_SESSION_KEY)
    handoff_key, handoff_run_key = "sophia_builder_handoff_v1", "sophia_builder_handoff_run_v1"
    handoff = configurable.get(handoff_key)
    if context.get(handoff_key) is not None:
        _deny()
    disabled_requests = ("sophia_builder_completion_request_v1",
        "sophia_builder_resume_request_v1", "memory_source_attachment_keys")
    # C2 does not activate old signed personal-memory transitions. Null out
    # every reserved carrier in both surfaces to override thread-config merge.
    disabled = any(source.get(key) is not None for source in (configurable, context) for key in disabled_requests)
    proof_keys = ("sophia_builder_handoff_run_v1", "sophia_builder_completion_run_v1",
        "sophia_builder_resume_run_v1", "sophia_source_attachments_run_v1")
    for source in (configurable, context):
        for key in (handoff_key, *disabled_requests, *proof_keys, INPUT_PROOF_KEY, INPUT_RUN_KEY, SOURCE_ACTION_KEY, SOURCE_SESSION_KEY):
            source[key] = None
    if disabled:
        _deny()
    try:
        try:
            authority_state = resolve_owner_authority(owner).authority_state
        except MemoryOwnerUndeclared:
            # A definite "this account was never declared" is not an outage, and
            # this hook runs on EVERY authenticated run creation. Letting it fall
            # into the blanket handler below denied the front door to every user
            # outside the pilot -- before any guard or middleware was built, so
            # none of the no-memory work downstream could ever be reached.
            #
            # An undeclared owner takes neither branch that follows: no recorded
            # input provenance is minted and no Builder handoff is accepted, the
            # same as a declared legacy owner. A store or transport failure still
            # reaches `except Exception: _deny()` and fails closed.
            authority_state = "unknown"
        if authority_state == "governed":
            from deerflow.agents.sophia_agent.middlewares.memory_context import active_governed_tool_owner
            from deerflow.sophia.memory_governance.input_provenance import issue_recorded_authenticated_input
            from deerflow.sophia.memory_governance.store import configured_memory_store
            if kwargs.get("command") is not None:
                _deny()
            if handoff is not None:
                if (str(value.get("assistant_id")) != str(BUILDER_ASSISTANT_ID)
                        or source_action is not None or source_session is not None
                        or active_governed_tool_owner() not in (None, owner)):
                    _deny()
                from deerflow.sophia.memory_governance.builder_provenance import bind_builder_run
                wire_input, proof = bind_builder_run(owner_id=owner, child_thread_id=value.get("thread_id"),
                    run_id=value.get("run_id"), wire_input=kwargs.get("input"), proof=handoff)
                kwargs["input"] = wire_input
                configurable[handoff_run_key] = proof
                # Select tools from the independent source, never the parent
                # model's task-type/target hints. Entry rechecks source consent
                # before admitting this deterministic machinery into state.
                from deerflow.sophia.memory_governance.builder_source_binding import independent_builder_runtime_seed
                seed = independent_builder_runtime_seed(binding=proof["binding"], wire_input=wire_input)
                configurable["task_type"] = seed["delegation_context"]["task_type"]
                from pathlib import PurePosixPath
                configurable["artifact_target_ext"] = PurePosixPath(seed["builder_artifact_target_path"]).suffix
                configurable["parent_thread_id"] = seed["delegation_context"]["parent_thread_id"]
                configurable["build_id"] = seed["builder_build_id"]
                configurable["operation_id"] = seed["builder_operation_id"]
            else:
                if active_governed_tool_owner() is not None or str(value.get("assistant_id")) != str(COMPANION_ASSISTANT_ID):
                    _deny()
                wire_input, proof = issue_recorded_authenticated_input(owner_id=owner, session_id=source_session,
                    thread_id=value.get("thread_id"), run_id=value.get("run_id"),
                    wire_input=kwargs.get("input"), source_action=source_action, store=configured_memory_store())
                kwargs["input"] = wire_input
                configurable[INPUT_PROOF_KEY] = proof
        elif handoff is not None:
            _deny()
        configurable[INPUT_RUN_KEY] = str(UUID(str(value["run_id"])))
    except Auth.exceptions.HTTPException:
        raise
    except Exception:
        _deny()
    owner_filter = _filter(ctx)
    value.setdefault("metadata", {}).update(owner_filter)
    return owner_filter


@auth.on.assistants.read
@auth.on.assistants.search
async def system_assistants(ctx, value):
    if READINESS_PERMISSION not in ctx.permissions:
        _owner(ctx)
    # Only configured system assistants are discoverable. No custom assistant
    # config (which could override owner, tools or governance) is admitted.
    return {"created_by": "system"}
