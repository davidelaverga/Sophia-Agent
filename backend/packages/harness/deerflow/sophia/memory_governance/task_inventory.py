"""Read-only owner-bound native task observations, never memory/result text.

Listing does not approve a child checkpoint, prove artifact delivery or update
the durable task. One unknown binding/status makes the inventory unavailable;
cached status is never a fallback or a filter input.
"""

import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

MAX_TRACKED_TASKS = 128
NATIVE_STATUSES = frozenset({"pending", "running", "interrupted", "success", "error", "timeout"})
FILTERS = frozenset({"running", "success", "error", "cancelled", "all"})


def _targets(runtime, status_filter):
    if status_filter is not None and status_filter not in FILTERS:
        raise ValueError("task_filter_invalid")
    state = getattr(runtime, "state", None)
    if not isinstance(state, dict):
        raise ValueError("task_state_invalid")
    tasks = state.get("async_tasks")
    if tasks is None:
        tasks = {}
    if not isinstance(tasks, dict) or len(tasks) > MAX_TRACKED_TASKS:
        raise ValueError("task_inventory_unbounded")
    result = []
    for key, task in tasks.items():
        if not isinstance(task, dict) or task.get("agent_name") != "sophia_builder":
            raise ValueError("task_identity_unproven")
        identifiers = tuple(task.get(field) for field in ("task_id", "thread_id", "run_id"))
        if any(not isinstance(value, str) or str(UUID(value)) != value for value in identifiers):
            raise ValueError("task_identity_unproven")
        if key != identifiers[0] or identifiers[0] != identifiers[1]:
            raise ValueError("task_identity_ambiguous")
        # Copy only structural identities. No cached result/status/timestamp
        # or arbitrary task field crosses into the observation producer.
        result.append({"task_id": identifiers[0], "thread_id": identifiers[1], "run_id": identifiers[2], "agent_name": "sophia_builder"})
    return result


def observed_native_run_status(*, thread_id, run_id, run):
    """Validate the installed SDK response, not just the requested URL scope."""
    status = run.get("status") if isinstance(run, dict) else None
    if not isinstance(status, str) or status not in NATIVE_STATUSES:
        raise ValueError("task_status_unavailable")
    if not isinstance(thread_id, str) or not thread_id or not isinstance(run_id, str) or not run_id:
        raise ValueError("task_status_scope_unproven")
    if (run.get("thread_id"), run.get("run_id")) != (thread_id, run_id):
        raise ValueError("task_status_scope_changed")
    return status


def _row(task, run):
    status = observed_native_run_status(thread_id=task["thread_id"], run_id=task["run_id"], run=run)
    return {**task, "native_status": status, "observed_at": datetime.now(UTC).isoformat(),
        "result_availability": "not_read", "artifact_delivery": "not_verified"}


def _render(rows, status_filter):
    matched = [row for row in rows if status_filter in (None, "all") or row["native_status"] == status_filter]
    return json.dumps({"schema": "mem00.builder-task-inventory.v1", "availability": "available", "scope": "current_thread",
        "status_filter": status_filter or "all", "tracked_count": len(rows), "matched_count": len(matched),
        "enumeration_complete": True, "status_observations_complete": True, "snapshot_atomic": False,
        "memory_details_included": False, "lifecycle_mutated": False, "tasks": matched}, separators=(",", ":"))


def _unavailable():
    return json.dumps({"schema": "mem00.builder-task-inventory.v1", "availability": "unavailable", "scope": "current_thread",
        "enumeration_complete": False, "status_observations_complete": False, "snapshot_atomic": False,
        "memory_details_included": False, "lifecycle_mutated": False, "tasks": []}, separators=(",", ":"))


def list_governed_tasks(*, guard, runtime, clients, status_filter):
    try:
        guard.check()
        targets = _targets(runtime, status_filter)
        rows, executions = [], []
        for task in targets:
            execution = guard.resolve_child_association(child_context_id=task["thread_id"], child_run_id=task["run_id"])
            executions.append(execution)
            selected = {**task, "original_run_id": task["run_id"], "run_id": execution.child_run_id}
            run = clients.get_sync("sophia_builder").runs.get(thread_id=task["thread_id"], run_id=execution.child_run_id)
            rows.append(_row(selected, run))
            guard.check()
        for task, execution in zip(targets, executions, strict=True):
            if guard.resolve_child_association(child_context_id=task["thread_id"], child_run_id=task["run_id"]) != execution:
                raise ValueError("task_execution_changed")
        guard.check()
        if _targets(runtime, status_filter) != targets:
            raise ValueError("task_inventory_changed")
        return _render(rows, status_filter)
    except Exception:
        return _unavailable()


async def alist_governed_tasks(*, guard, runtime, clients, status_filter):
    try:
        await asyncio.to_thread(guard.check)
        targets = _targets(runtime, status_filter)
        rows, executions = [], []
        for task in targets:
            execution = await asyncio.to_thread(guard.resolve_child_association, child_context_id=task["thread_id"], child_run_id=task["run_id"])
            executions.append(execution)
            selected = {**task, "original_run_id": task["run_id"], "run_id": execution.child_run_id}
            run = await clients.get_async("sophia_builder").runs.get(thread_id=task["thread_id"], run_id=execution.child_run_id)
            rows.append(_row(selected, run))
            await asyncio.to_thread(guard.check)
        for task, execution in zip(targets, executions, strict=True):
            if await asyncio.to_thread(guard.resolve_child_association, child_context_id=task["thread_id"], child_run_id=task["run_id"]) != execution:
                raise ValueError("task_execution_changed")
        await asyncio.to_thread(guard.check)
        if _targets(runtime, status_filter) != targets:
            raise ValueError("task_inventory_changed")
        return _render(rows, status_filter)
    except Exception:
        return _unavailable()
