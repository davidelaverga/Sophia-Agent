"""Exact parsed-model origin at actual file-tool execution.

This execution-local witness is not a durable file effect, a one-use filesystem
permit, current generated-file content authority, or a cleanup receipt.
"""
import asyncio
import json
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from threading import Event

from .input_provenance import INPUT_RUN_KEY
from .model_dispatch import MAX_MODEL_BYTES
from .model_result_provenance import ModelResultReceipt, ModelResultService, _json
from .refs import keyed_ref
from .store import MemoryGovernanceUnavailable, configured_memory_store

FILE_TOOLS = frozenset({"write_file", "str_replace"})
_execution = ContextVar("mem00_model_tool_origin", default=None)


@dataclass(frozen=True, repr=False)
class ModelToolOrigin:
    guard: object = field(repr=False)
    receipt_json: str = field(repr=False)
    arguments_json: str = field(repr=False)
    tool_name: str
    tool_call_id: str = field(repr=False)
    revoked: Event = field(default_factory=Event, repr=False, compare=False)


def _effective(name, args):
    required = {"description", "path", "content"} if name == "write_file" else {"description", "path", "old_str", "new_str"}
    flag = "append" if name == "write_file" else "replace_all"
    if (name not in FILE_TOOLS or type(args) is not dict or not required <= set(args)
            or set(args) - required - {flag} or any(type(args[key]) is not str for key in required)
            or (flag in args and type(args[flag]) is not bool)):
        raise ValueError("model_tool_arguments_invalid")
    return {**args, flag: args.get(flag, False)}


def _canonical(guard, raw):
    if type(raw) is not str or len(raw.encode()) > MAX_MODEL_BYTES:
        raise ValueError("model_tool_origin_budget")
    receipt = ModelResultReceipt.model_validate_json(raw)
    if (receipt.owner_id, receipt.request.run_id, receipt.request.thread_id) != (
            guard.owner, guard.config.get(INPUT_RUN_KEY), guard.context_id):
        raise ValueError("model_tool_origin_scope")
    stored = ModelResultService(guard.owner, configured_memory_store()).lookup(receipt.request.attempt_id)
    if stored != receipt:
        raise ValueError("model_tool_origin_not_canonical")
    # Current guard checks precede execution; they may not silently discard any
    # source or memory which influenced the producing model result.
    if any(source not in guard.source_dependencies for source in receipt.admission.source_dependencies):
        raise ValueError("model_tool_source_union_missing")
    context = guard.admission.context
    current = {(str(item.memory_id), item.content_revision, item.governance_revision) for item in context.inclusions}
    produced = {(str(item.memory_id), item.content_revision, item.memory_governance_revision)
        for item in receipt.admission.authorized_manifest}
    if context.owner_ref != keyed_ref("owner", guard.owner) or not produced <= current:
        raise ValueError("model_tool_memory_union_missing")
    return receipt


def _observe_origin(guard, receipt=None, tool=None):
    from .observability import emit_memory_event, record_memory_observation_gap
    try:
        fields = {"owner_ref": keyed_ref("owner", guard.owner), "run_ref": keyed_ref("run", guard.config.get(INPUT_RUN_KEY)),
            "context_ref": keyed_ref("context", guard.context_id), "file_effect_observed": False, "model_reuse_permission": False}
        if receipt is not None:
            fields.update(result_event_ref=keyed_ref("model-result-event", receipt.event_id),
                model_admission_event_ref=keyed_ref("model-admission-event", receipt.admission.event_id),
                tool_call_ref=tool.tool_call_ref, tool_arguments_ref=tool.arguments_ref,
                source_count=len(receipt.admission.source_dependencies), inclusion_count=len(receipt.admission.authorized_manifest))
        outcome = "origin_bound" if receipt is not None else "origin_unavailable"
        emit_memory_event("memory.model.tool.origin", service="sophia-langgraph", outcome=outcome,
            safe_reason_code=outcome, fault_owner_id=guard.owner, **fields)
    except Exception:
        record_memory_observation_gap()  # Observation cannot retry or change a file effect.


def prepare_model_tool_origin(guard, request):
    try:
        call = getattr(request, "tool_call", None)
        if call is None:
            return None  # Internal non-tool wrapper; a file body still requires its exact origin.
        if not guard.enabled or call.get("name") not in FILE_TOOLS:
            return None
        if (not guard.entered or type(call) is not dict or set(call) - {"name", "id", "args", "type"}
                or type(call.get("id")) is not str or not 1 <= len(call["id"]) <= 256
                or call.get("type", "tool_call") != "tool_call"):
            raise ValueError("model_tool_call_invalid")
        _effective(call["name"], call["args"])
        arguments = _json(call["args"])
        if len(arguments.encode()) > MAX_MODEL_BYTES:
            raise ValueError("model_tool_argument_budget")
        rows = guard._last_model_result_receipts
        if type(rows) is not tuple or not 1 <= len(rows) <= 8:
            raise ValueError("model_tool_origin_missing")
        matches = []
        for raw in rows:
            receipt = _canonical(guard, raw)
            for tool in receipt.request.tool_calls:
                if (tool.tool_call_ref, tool.tool_name, tool.arguments_ref) == (
                        keyed_ref("model-tool-call", call["id"]), call["name"], keyed_ref("model-tool-arguments", arguments)):
                    matches.append((receipt, tool))
        if len(matches) != 1:
            raise ValueError("model_tool_origin_ambiguous")
        receipt, tool = matches[0]
        origin = ModelToolOrigin(guard, receipt.model_dump_json(by_alias=True), arguments, call["name"], call["id"])
        _observe_origin(guard, receipt, tool)
        return origin
    except Exception:
        _observe_origin(guard)
        raise MemoryGovernanceUnavailable("memory_model_tool_origin_unavailable") from None


@contextmanager
def bind_model_tool_origin(origin):
    token = _execution.set(origin)
    try:
        yield
    finally:
        if origin is not None:
            origin.revoked.set()
        _execution.reset(token)


async def settle_file_handler(origin, handler, request):
    if origin is None:
        return await handler(request)
    task = asyncio.create_task(handler(request))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError:
            origin.revoked.set()
            cancelled = True
            if task.done():
                # Retrieve the terminal exception without restoring permission.
                if not task.cancelled():
                    task.exception()
                raise
        except BaseException:
            if cancelled:
                raise asyncio.CancelledError() from None
            raise
    if cancelled:
        raise asyncio.CancelledError()
    return result


def assert_file_tool_scope_active():
    from deerflow.agents.sophia_agent.middlewares.memory_context import active_governed_tool_guard
    guard = active_governed_tool_guard()
    if guard is None:
        return
    origin = _execution.get()
    if not isinstance(origin, ModelToolOrigin) or origin.guard is not guard or origin.revoked.is_set() or not guard.entered:
        raise MemoryGovernanceUnavailable("memory_model_tool_scope_unavailable")


def verify_file_tool_arguments(runtime, *, tool_name, arguments):
    """Check again after middleware/ToolNode injection, before file access.

    Standalone generic filesystem helpers are not governed model consumers. This
    does not qualify direct resumed execution or bypass its existing entry hold.
    """
    from deerflow.agents.sophia_agent.middlewares.memory_context import active_governed_tool_guard
    guard = active_governed_tool_guard()
    if guard is None:
        return None
    try:
        assert_file_tool_scope_active()
        origin = _execution.get()
        if (not isinstance(origin, ModelToolOrigin) or origin.guard is not guard or origin.tool_name != tool_name
                or getattr(runtime, "tool_call_id", None) != origin.tool_call_id):
            raise ValueError("model_tool_execution_unbound")
        cfg = (getattr(runtime, "config", None) or {}).get("configurable") or {}
        if (cfg.get("langgraph_auth_user_id"), cfg.get("thread_id"), cfg.get(INPUT_RUN_KEY)) != (
                guard.owner, guard.context_id, guard.config.get(INPUT_RUN_KEY)):
            raise ValueError("model_tool_runtime_changed")
        if _effective(tool_name, arguments) != _effective(tool_name, json.loads(origin.arguments_json)):
            raise ValueError("model_tool_execution_arguments_changed")
        guard.check()
        receipt = _canonical(guard, origin.receipt_json)
        assert_file_tool_scope_active()
        return receipt
    except Exception:
        raise MemoryGovernanceUnavailable("memory_model_tool_execution_unavailable") from None


def file_operation_producer(runtime, *, owner_id, run_id, thread_id, tool_name, path, arguments):
    """Stable producing identity for retry exclusion, not durable content authority.

    Provider call IDs are only unique inside a producing result. The existing
    file ledger stores an opaque operation reference; it does not independently
    validate this model/file join. Resumed runtime must therefore remain held.
    """
    from deerflow.agents.sophia_agent.middlewares.memory_context import active_governed_tool_guard
    if active_governed_tool_guard() is None:
        return None  # Separately scoped lower-layer helpers keep their historical keys.
    try:
        assert_file_tool_scope_active()
        origin = _execution.get()
        original = json.loads(origin.arguments_json)
        receipt = verify_file_tool_arguments(runtime, tool_name=tool_name,
            arguments={"description": original["description"], "path": path, **arguments})
        if receipt is None or (receipt.owner_id, receipt.request.run_id, receipt.request.thread_id) != (owner_id, run_id, thread_id):
            raise ValueError("model_file_operation_scope_changed")
        return {"schema": "mem00.file-operation-producer.v1", "result_event_id": receipt.event_id,
            "attempt_id": receipt.request.attempt_id, "admission_event_id": receipt.admission.event_id,
            "tool_call_ref": keyed_ref("model-tool-call", origin.tool_call_id),
            "arguments_ref": keyed_ref("model-tool-arguments", origin.arguments_json)}
    except Exception:
        raise MemoryGovernanceUnavailable("memory_file_operation_producer_unavailable") from None


def admit_file_origin(origin):
    """Fresh availability for the exact durable content union; not a replay grant."""
    from uuid import UUID

    from deerflow.agents.sophia_agent.middlewares.memory_context import active_governed_tool_guard

    from .retained_context import MemoryInclusion, RetainedMemoryContext
    from .source_dependencies import merge_source_dependencies, recheck_source_dependencies
    try:
        guard = active_governed_tool_guard()
        assert_file_tool_scope_active()
        if guard is None or origin.owner_id != guard.owner:
            raise ValueError("file_origin_guard_missing")
        with guard.dependency_update_lock():
            execution = _execution.get()
            produced = _canonical(guard, execution.receipt_json)
            if (origin.request.producer.result_event_id, origin.request.producer.attempt_id, origin.request.producer.admission_event_id,
                    origin.request.producer.tool_call_ref, origin.request.producer.arguments_ref) != (
                    produced.event_id, produced.request.attempt_id, produced.admission.event_id,
                    keyed_ref("model-tool-call", execution.tool_call_id), keyed_ref("model-tool-arguments", execution.arguments_json)):
                raise ValueError("file_origin_producer_changed")
            merged_sources = merge_source_dependencies(owner_id=guard.owner, groups=[guard.source_dependencies, origin.source_dependencies])
            recheck_source_dependencies(owner_id=guard.owner, values=merged_sources, store=configured_memory_store())
            guard.check()
            context = guard.admission.context
            included = {item.memory_id: item for item in context.inclusions}
            content_inclusions = tuple(MemoryInclusion(UUID(str(item.memory_id)), item.content_revision, item.memory_governance_revision)
                for item in origin.authorized_manifest)
            for item in content_inclusions:
                if item.memory_id in included and included[item.memory_id] != item:
                    raise ValueError("file_origin_memory_conflict")
                included[item.memory_id] = item
            guard.admission = guard._readmit(RetainedMemoryContext(context.owner_ref, context.revocation_epoch, tuple(included.values())))
            guard.source_dependencies = merged_sources
            fresh = guard._readmit(RetainedMemoryContext(context.owner_ref, origin.revocation_epoch, content_inclusions))
            assert_file_tool_scope_active()
            if not isinstance(fresh.prompt_admission_id, UUID):
                raise ValueError("file_origin_availability_missing")
            return str(fresh.prompt_admission_id)
    except Exception:
        raise MemoryGovernanceUnavailable("memory_file_origin_admission_unavailable") from None
