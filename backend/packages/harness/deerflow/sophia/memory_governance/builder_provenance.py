"""Exact Builder handoff provenance, never a replacement for current consent.

Only an active admitted parent tool boundary may issue the transport proof.
The authenticated run hook binds it to a new server run; the Builder then
re-admits its inclusion manifest before sandbox, briefing or model consumers.
"""

import hmac
import json
import logging
from time import perf_counter
from uuid import UUID, uuid4

from langchain_core.messages import HumanMessage, convert_to_messages

from deerflow.sophia.diag import code_or_none, diag_event, elapsed_ms

from .context_provenance import _state_ref, seal_context
from .refs import keyed_ref
from .retained_context import decode_context_manifest, encode_context_manifest

HANDOFF_KEY = "sophia_builder_handoff_v1"
HANDOFF_RUN_KEY = "sophia_builder_handoff_run_v1"


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _normalize(value, *, assign_id=False):
    if not isinstance(value, dict) or set(value) != {"messages"}:
        raise ValueError("builder_input_invalid")
    messages = convert_to_messages(value.get("messages", []))
    if len(messages) != 1 or not isinstance(messages[0], HumanMessage):
        raise ValueError("builder_input_invalid")
    message = messages[0].model_copy(deep=True)
    if assign_id:
        message.id = str(uuid4())
    if not message.id:
        raise ValueError("builder_input_invalid")
    normalized = {**value, "messages": [message.model_dump(mode="json")]}
    _state_ref(normalized)  # Reject unsupported objects and oversized payloads.
    return normalized


def issue_builder_handoff(*, guard, owner_id, parent_thread_id, child_thread_id, source_messages, tool_call_id=None):
    # Only the active parent tool guard may request the independent source lane.
    if guard is None or not guard.enabled or guard.owner != owner_id or guard.context_id != parent_thread_id:
        raise ValueError("builder_parent_admission_required")
    from .builder_source_binding import BuilderSourceBindingService
    from .source_dependencies import encode_source_dependencies
    from .store import configured_memory_store
    started = perf_counter()
    normalized, receipt, admission = BuilderSourceBindingService(owner_id=owner_id, store=configured_memory_store()).register_independent_text(
        guard=guard, child_thread_id=child_thread_id, messages=source_messages)
    register_ms = elapsed_ms(started)
    parent = seal_context(owner_id=owner_id, context_id=parent_thread_id,
        messages=convert_to_messages(normalized["messages"]), blocks=[], admission=admission)
    checked = perf_counter()
    guard.check()
    check_ms = elapsed_ms(checked)
    body = {"schema": "mem00.builder-handoff.c2-source-only.v1", "owner_ref": parent["owner_ref"],
        "parent_ref": parent["context_ref"], "child_ref": keyed_ref("context", str(UUID(child_thread_id))),
        "manifest": encode_context_manifest(admission.context), "payload_ref": _state_ref(normalized),
        "payload_keys": sorted(normalized), "admission_ref": keyed_ref("prompt-admission", receipt.request.prior_admission_id),
        "source_dependencies": encode_source_dependencies(owner_id=owner_id, values=receipt.request.source_dependencies),
        "binding_receipt": receipt.model_dump(mode="json", by_alias=True)}
    diag_event("builder.handoff.issued", parent_thread_id=parent_thread_id, child_thread_id=child_thread_id,
        tool_call_id=tool_call_id, handoff_event_id=receipt.event_id, register_ms=register_ms, check_ms=check_ms,
        total_ms=elapsed_ms(started))
    return normalized, {**body, "seal": keyed_ref("builder-handoff-seal", _json(body))}


async def dispatch_independent_builder(*, guard, owner_id, parent_thread_id, source_messages, tool_call_id):
    """Allocate once per parent run/tool call; recover ambiguity by exact read.

    A historical binding alone does not prove a native run exists. Conversely,
    an empty native read cannot prove that a delayed create had no effect.
    Existing/uncertain child allocation is never followed by another create.
    """
    from uuid import uuid5

    from deerflow.sophia.langgraph_client_auth import get_client

    from .builder_source_binding import BuilderRunBinding, BuilderSourceBindingService
    from .input_provenance import INPUT_RUN_KEY
    from .store import configured_memory_store

    if not isinstance(tool_call_id, str) or not tool_call_id.strip() or len(tool_call_id) > 256:
        raise ValueError("builder_tool_call_invalid")
    child = str(uuid5(UUID(str(guard.config[INPUT_RUN_KEY])), "mem00-c2-builder:" + tool_call_id))
    wire, proof = issue_builder_handoff(guard=guard, owner_id=owner_id, parent_thread_id=parent_thread_id,
        child_thread_id=child, source_messages=source_messages, tool_call_id=tool_call_id)
    client = get_client(url=None)
    store = configured_memory_store()
    service = BuilderSourceBindingService(owner_id=owner_id, store=store)

    async def observe():
        started = perf_counter()
        native_status = None
        try:
            binding = BuilderRunBinding.model_validate(store.get_builder_source_run_for_handoff(
                p_user_id=owner_id, p_handoff_event_id=proof["binding_receipt"]["event_id"]))
            service.resolve_child(parent_thread_id=parent_thread_id, child_thread_id=child, child_run_id=binding.child_run_id)
            native = await client.runs.get(child, binding.child_run_id)
            native_status = native.get("status")
            if (native.get("thread_id") != child or native.get("run_id") != binding.child_run_id
                    or native.get("status") not in {"pending", "running", "success", "error", "timeout", "interrupted"}):
                raise ValueError("native_run_unproven")
            guard.check()
            diag_event("builder.child.observed", parent_thread_id=parent_thread_id, child_thread_id=child,
                child_run_id=binding.child_run_id, binding_event_id=binding.binding_event_id, confirmed=True,
                native_status=code_or_none(native_status), observe_ms=elapsed_ms(started))
            return {"thread_id": child, "run_id": binding.child_run_id, "status": native["status"], "confirmed": True}
        except Exception as exc:
            diag_event("builder.child.observed", _level=logging.WARNING, parent_thread_id=parent_thread_id, child_thread_id=child,
                confirmed=False, native_status=code_or_none(native_status), error_type=type(exc).__name__, observe_ms=elapsed_ms(started))
            return {"thread_id": child, "run_id": None, "status": "unconfirmed", "confirmed": False}

    guard.check()
    started = perf_counter()
    try:
        allocated = await client.threads.create(thread_id=child, if_exists="raise")
        if allocated.get("thread_id") != child:
            diag_event("builder.child.thread_created", _level=logging.WARNING, child_thread_id=child,
                outcome="thread_mismatch", ms=elapsed_ms(started))
            return {"thread_id": child, "run_id": None, "status": "unconfirmed", "confirmed": False}
    except Exception as exc:
        # Includes duplicate/retried allocation: only recover, never re-run.
        diag_event("builder.child.thread_created", _level=logging.WARNING, child_thread_id=child,
            outcome="create_failed_recovering", error_type=type(exc).__name__, ms=elapsed_ms(started))
        return await observe()
    diag_event("builder.child.thread_created", child_thread_id=child, outcome="created", ms=elapsed_ms(started))
    started = perf_counter()
    try:
        guard.check()
        created = await client.runs.create(thread_id=child, assistant_id="sophia_builder", input=wire,
            config={"configurable": {"user_id": owner_id, "thread_id": child, HANDOFF_KEY: proof}},
            stream_resumable=True)
        diag_event("builder.child.run_create", child_thread_id=child, outcome="created",
            child_run_id=created.get("run_id") if isinstance(created, dict) else None, ms=elapsed_ms(started))
    except Exception as exc:
        # A failed response does not establish an ineffective request.
        diag_event("builder.child.run_create", _level=logging.WARNING, child_thread_id=child,
            outcome="failed_observing", error_type=type(exc).__name__, ms=elapsed_ms(started))
    return await observe()


def _verify_transport(*, owner_id, child_thread_id, wire_input, proof):
    fields = {"schema", "owner_ref", "parent_ref", "child_ref", "manifest", "payload_ref", "payload_keys", "admission_ref", "source_dependencies", "binding_receipt", "seal"}
    if not isinstance(proof, dict) or set(proof) != fields or proof["schema"] != "mem00.builder-handoff.c2-source-only.v1":
        raise ValueError("builder_handoff_unproven")
    body = {key: value for key, value in proof.items() if key != "seal"}
    if not isinstance(proof["seal"], str) or not hmac.compare_digest(proof["seal"], keyed_ref("builder-handoff-seal", _json(body))):
        raise ValueError("builder_handoff_unproven")
    manifest = decode_context_manifest(proof["manifest"])
    if manifest is None or manifest.inclusions or manifest.owner_ref != keyed_ref("owner", owner_id) or proof["owner_ref"] != manifest.owner_ref:
        raise ValueError("builder_handoff_unproven")
    if proof["child_ref"] != keyed_ref("context", str(UUID(str(child_thread_id)))):
        raise ValueError("builder_handoff_unproven")
    from .source_dependencies import source_dependencies
    dependencies = source_dependencies(owner_id=owner_id, values=proof["source_dependencies"])
    from .source_input_provenance import SourceInputWitness
    if len(dependencies) != 1 or not isinstance(dependencies[0], SourceInputWitness):
        raise ValueError("builder_handoff_unproven")
    from .builder_source_binding import BuilderHandoffReceipt
    receipt = BuilderHandoffReceipt.model_validate(proof["binding_receipt"])
    request = receipt.request
    initial = [{"memory_id": str(item.memory_id), "content_revision": item.content_revision, "memory_governance_revision": item.governance_revision}
        for item in manifest.inclusions]
    if (receipt.owner_id != owner_id or receipt.child_thread_id != str(UUID(str(child_thread_id)))
            or proof["parent_ref"] != keyed_ref("context", request.parent_thread_id)
            or proof["admission_ref"] != keyed_ref("prompt-admission", request.prior_admission_id)
            or request.revocation_epoch != manifest.revocation_epoch or request.payload_ref != proof["payload_ref"]
            or [item.model_dump(mode="json", by_alias=True) for item in request.source_dependencies] != proof["source_dependencies"]
            or [item.model_dump(mode="json") for item in request.initial_memory_manifest] != initial):
        raise ValueError("builder_handoff_binding_unproven")
    normalized = _normalize(wire_input)
    if proof["payload_keys"] != sorted(normalized) or proof["payload_ref"] != _state_ref(normalized):
        raise ValueError("builder_handoff_unproven")
    return normalized, manifest


def bind_builder_run(*, owner_id, child_thread_id, run_id, wire_input, proof):
    normalized, _ = _verify_transport(owner_id=owner_id, child_thread_id=child_thread_id, wire_input=wire_input, proof=proof)
    from .builder_source_binding import BuilderHandoffReceipt, BuilderSourceBindingService
    from .store import configured_memory_store
    binding = BuilderSourceBindingService(owner_id=owner_id, store=configured_memory_store()).bind(
        handoff=BuilderHandoffReceipt.model_validate(proof["binding_receipt"]), child_run_id=run_id)
    body = {"schema": "mem00.builder-handoff-run.c2-source-only.v1", "run_ref": keyed_ref("run", str(UUID(str(run_id)))), "handoff": proof,
        "binding": binding.model_dump(mode="json", by_alias=True)}
    return normalized, {**body, "seal": keyed_ref("builder-handoff-run-seal", _json(body))}


def verify_builder_run(*, owner_id, child_thread_id, run_id, state, proof):
    try:
        if not isinstance(proof, dict) or set(proof) != {"schema", "run_ref", "handoff", "binding", "seal"} or proof["schema"] != "mem00.builder-handoff-run.c2-source-only.v1":
            return None
        body = {key: value for key, value in proof.items() if key != "seal"}
        if not hmac.compare_digest(proof["seal"], keyed_ref("builder-handoff-run-seal", _json(body))):
            return None
        if proof["run_ref"] != keyed_ref("run", str(UUID(str(run_id)))):
            return None
        keys = proof["handoff"]["payload_keys"]
        if any(value not in (None, [], {}, False, "") for key, value in state.items() if key not in keys):
            return None
        # Reducer-initialized empty channels may be present, but no additional
        # retained message, derivative, checkpoint seal or input field is allowed.
        initial = {key: state[key] for key in keys}
        _, manifest = _verify_transport(owner_id=owner_id, child_thread_id=child_thread_id, wire_input=initial, proof=proof["handoff"])
        from .builder_source_binding import BuilderRunBinding, BuilderSourceBindingService
        from .store import configured_memory_store
        binding = BuilderRunBinding.model_validate(proof["binding"])
        if (binding.child_run_id != str(UUID(str(run_id))) or binding.child_thread_id != str(UUID(str(child_thread_id)))
                or binding.handoff_event_id != proof["handoff"]["binding_receipt"]["event_id"]
                or binding.payload_ref != proof["handoff"]["payload_ref"]
                or [item.model_dump(mode="json", by_alias=True) for item in binding.source_dependencies] != proof["handoff"]["source_dependencies"]):
            return None
        BuilderSourceBindingService(owner_id=owner_id, store=configured_memory_store()).verify_historical_binding(binding)
        return manifest
    except Exception:
        return None


def verified_builder_sources(*, owner_id, child_thread_id, run_id, state, proof):
    from .source_dependencies import source_dependencies
    from .store import MemoryGovernanceUnavailable

    if verify_builder_run(owner_id=owner_id, child_thread_id=child_thread_id, run_id=run_id, state=state, proof=proof) is None:
        raise MemoryGovernanceUnavailable("memory_builder_sources_unproven")
    return source_dependencies(owner_id=owner_id, values=proof["handoff"]["source_dependencies"])
