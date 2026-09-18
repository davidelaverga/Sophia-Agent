"""Keep durable task records without relabeling their old text as admissible.

The enclosing verified checkpoint authenticates this private provenance record.
It is a historical carrier fence, not another task/memory store or permission.
Only independently bound identities may be retained. Cached task content stays
held until a separate task-source reconstruction can preserve its operation.
"""

import re
from copy import deepcopy
from types import SimpleNamespace

from .builder_source_binding import BuilderSourceBindingService
from .context_provenance import CHECKPOINT_PROOF_KEY, _json
from .refs import keyed_ref
from .retained_context import decode_context_manifest, encode_context_manifest
from .source_dependencies import encode_source_dependencies, source_dependencies
from .store import MemoryGovernanceUnavailable
from .task_inventory import _targets

TASK_RETENTION_KEY = "memory_task_retention"
FIELDS = {"schema", "owner_ref", "context_ref", "origin_state_ref", "tasks_ref", "memory_manifest", "source_dependencies",
    "scope", "model_reuse_permission"}
NOTICE = ("Previously created Builder tasks are preserved, but their retained descriptions and results are "
    "unavailable after memory-context recovery. Use list_async_tasks for a fresh identity/status-only "
    "observation. No task was cancelled or restarted.")
HELD_TOOLS = frozenset({"start_builder_task", "start_async_task", "update_async_task", "check_async_task", "cancel_async_task"})


def task_state_ref(tasks):
    return keyed_ref("retained-task-state", _json(tasks))


def validate_task_retention(*, owner_id, context_id, state):
    """Caller must first verify the enclosing whole-state checkpoint seal."""
    try:
        proof = state.get(TASK_RETENTION_KEY)
        if proof is None:
            return None
        if not isinstance(proof, dict) or set(proof) != FIELDS:
            raise ValueError("shape")
        if (proof["schema"], proof["owner_ref"], proof["context_ref"], proof["scope"]) != (
            "mem00.task-context-retention.v1", keyed_ref("owner", owner_id), keyed_ref("context", context_id), "historical_operation_only"
        ) or proof["model_reuse_permission"] is not False:
            raise ValueError("scope")
        if proof["tasks_ref"] != task_state_ref(state.get("async_tasks")):
            raise ValueError("task_state_changed")
        context = decode_context_manifest(proof["memory_manifest"])
        if context is None or context.owner_ref != keyed_ref("owner", owner_id):
            raise ValueError("manifest")
        source_dependencies(owner_id=owner_id, values=proof["source_dependencies"])
        if not isinstance(proof["origin_state_ref"], str) or not re.fullmatch(r"hmac-sha256:checkpoint-state:[a-f0-9]{64}", proof["origin_state_ref"]):
            raise ValueError("origin")
        if not _targets(SimpleNamespace(state=state), None):
            raise ValueError("no_tasks")
        return deepcopy(proof)
    except Exception:
        raise MemoryGovernanceUnavailable("memory_task_retention_unproven") from None


def retain_verified_tasks(*, owner_id, context_id, previous, history, store):
    """Called only after exact checkpoint/source-history verification.

    Preserve rich task rows byte-for-byte. Status/type/description/result are
    not read as current truth; only exact immutable child associations are read.
    """
    try:
        if not previous.get("async_tasks"):
            if previous.get(TASK_RETENTION_KEY) is not None:
                raise ValueError("missing_tasks")
            return None
        targets = _targets(SimpleNamespace(state=previous), None)
        service = BuilderSourceBindingService(owner_id=owner_id, store=store)
        for task in targets:
            service.resolve_child(parent_thread_id=context_id, child_thread_id=task["thread_id"], child_run_id=task["run_id"])
        existing = validate_task_retention(owner_id=owner_id, context_id=context_id, state=previous)
        if existing is not None:
            return existing
        if history.context is None:
            raise ValueError("unsealed_task_origin")
        return {"schema": "mem00.task-context-retention.v1", "owner_ref": keyed_ref("owner", owner_id),
            "context_ref": keyed_ref("context", context_id), "origin_state_ref": previous[CHECKPOINT_PROOF_KEY]["state_ref"],
            "tasks_ref": task_state_ref(previous["async_tasks"]), "memory_manifest": encode_context_manifest(history.context),
            "source_dependencies": encode_source_dependencies(owner_id=owner_id, values=history.sources),
            "scope": "historical_operation_only", "model_reuse_permission": False}
    except Exception:
        raise MemoryGovernanceUnavailable("memory_task_retention_unavailable") from None
