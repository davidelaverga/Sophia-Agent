"""Authenticated browser fan-out for Sophia builder canvas activity.

The builder already posts progress and terminal events to the gateway for
channel delivery.  This worker projects those internal payloads into a small,
privacy-safe SSE contract for the web canvas and retains a short replay
window for reconnecting tabs.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

DEFAULT_TERMINAL_TTL_SECONDS = 15 * 60
DEFAULT_HISTORY_SIZE = 64
DEFAULT_RETIRED_RUNS_SIZE = 128
_SUBSCRIBER_QUEUE_MAXSIZE = 128
_TERMINAL_STATUSES = {"completed", "failed", "timed_out", "cancelled"}
_PHASE_LABELS = {
    "starting": "Creating plan",
    "researching": "Researching",
    "drafting": "Creating artifact",
    "finalizing": "Creating artifact",
    "done": "Success",
}
_CHECK_COMMAND_PREFIXES = ("test", "pytest", "pnpm", "npm", "yarn", "uv", "ruff", "mypy", "tsc")
_MISSING_DELIVERABLE_ERROR = "Builder finished without a deliverable artifact."


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _public_terminal_status(status: str | None) -> str:
    return {
        "success": "completed",
        "completed": "completed",
        "error": "failed",
        "failed": "failed",
        "timeout": "timed_out",
        "timed_out": "timed_out",
        "cancelled": "cancelled",
        "interrupted": "cancelled",
    }.get(str(status or "").lower(), "failed")


def _short_text(value: Any, *, limit: int = 80) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    if not cleaned:
        return None
    return cleaned[: max(0, limit - 1)] + "…" if len(cleaned) > limit else cleaned


def _source_domain(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    parsed = urlparse(value.strip())
    host = parsed.netloc or parsed.path.split("/", 1)[0]
    host = host.lower().removeprefix("www.")
    if " " in host or "." not in host:
        return None
    return host or None


def _source_details(args: Any) -> dict[str, str]:
    if not isinstance(args, dict):
        return {}
    url = args.get("url") or args.get("source_url") or args.get("href")
    title = args.get("title") or args.get("source_title") or args.get("page_title")
    details: dict[str, str] = {}
    domain = _source_domain(url)
    source_title = _short_text(title, limit=72)
    if domain:
        details["source_domain"] = domain
    if source_title:
        details["source_title"] = source_title
        details["detail"] = source_title
    elif domain:
        details["detail"] = domain
    return details


def _is_check_command(args: Any) -> bool:
    if not isinstance(args, dict):
        return False
    command = args.get("command") or args.get("cmd")
    if not isinstance(command, str):
        return False
    cleaned = command.strip().lower()
    return any(cleaned.startswith(prefix) for prefix in _CHECK_COMMAND_PREFIXES)


def _activity(
    *,
    action: str,
    label: str,
    category: str,
    kind: str = "tool_activity",
    **extra: str,
) -> dict[str, str]:
    return {
        "kind": kind,
        "category": category,
        "action": action,
        "label": label,
        **{key: value for key, value in extra.items() if isinstance(value, str) and value},
    }


def _tool_activity(call: dict[str, Any], *, plan_seen: bool) -> dict[str, str]:
    tool_name = str(call.get("name") or "").lower()
    args = call.get("args")
    name = tool_name.lower()
    if any(token in name for token in ("search", "scrape", "tavily", "firecrawl")):
        return _activity(
            action="searching_web",
            category="research",
            label="Searching web",
        )
    if any(token in name for token in ("fetch", "browse", "jina")):
        return _activity(
            action="reading_source",
            category="research",
            label="Reading source",
            **_source_details(args),
        )
    if name in {"write_todos", "todo_write"}:
        return _activity(
            action="updating_plan" if plan_seen else "creating_plan",
            category="plan",
            label="Updating plan" if plan_seen else "Creating plan",
        )
    if any(token in name for token in ("write_file", "create_file")):
        return _activity(action="writing_file", category="draft", label="Writing file")
    if "read_file" in name:
        return _activity(action="reading_file", category="draft", label="Reading file")
    if any(token in name for token in ("str_replace", "edit_file")):
        return _activity(action="editing_file", category="draft", label="Editing file")
    if name in {"bash", "shell"}:
        if _is_check_command(args):
            return _activity(action="running_check", category="finalize", label="Running check")
        return _activity(action="creating_artifact", category="draft", label="Creating artifact")
    if "render" in name:
        return _activity(action="creating_artifact", category="render", label="Creating artifact")
    if any(token in name for token in ("emit_artifact", "emit_builder_artifact", "package")):
        return _activity(action="packaging_artifact", category="package", label="Packaging artifact")
    return _activity(action="creating_artifact", category="draft", label="Creating artifact")


def _phase_activity(data: Any) -> dict[str, str] | None:
    if not isinstance(data, dict) or data.get("name") != "phase":
        return None
    phase = str(data.get("phase") or "")
    if phase not in _PHASE_LABELS:
        return None
    action = {
        "starting": "creating_plan",
        "researching": "researching",
        "drafting": "creating_artifact",
        "finalizing": "creating_artifact",
        "done": "success",
    }[phase]
    category = {
        "starting": "plan",
        "researching": "research",
        "drafting": "draft",
        "finalizing": "package",
        "done": "finalize",
    }[phase]
    return {
        "kind": "phase",
        "phase": phase,
        "category": category,
        "action": action,
        "label": _PHASE_LABELS[phase],
    }


def _message_tool_calls(message: Any) -> list[Any]:
    if not isinstance(message, dict):
        return []
    calls = message.get("tool_calls")
    return calls if isinstance(calls, list) else []


def _call_tool_name(call: Any) -> str | None:
    tool_name = call.get("name") if isinstance(call, dict) else None
    return tool_name if isinstance(tool_name, str) and tool_name else None


def _agent_messages(data: Any) -> list[Any]:
    if not isinstance(data, dict):
        return []
    agent = data.get("agent")
    messages = agent.get("messages") if isinstance(agent, dict) else None
    return messages if isinstance(messages, list) else []


def _latest_tool_call(data: Any) -> dict[str, Any] | None:
    messages = _agent_messages(data)
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        for call in reversed(_message_tool_calls(message)):
            if isinstance(call, dict) and _call_tool_name(call):
                return call
    return None


def _project_activity(event_name: str, data: Any, *, plan_seen: bool) -> dict[str, str] | None:
    if event_name == "custom":
        return _phase_activity(data)
    if event_name == "updates":
        tool_call = _latest_tool_call(data)
        return _tool_activity(tool_call, plan_seen=plan_seen) if tool_call else None
    return None


def _required_str(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) and value else None


def _positive_sequence(payload: dict[str, Any]) -> int | None:
    sequence = payload.get("sequence")
    return sequence if isinstance(sequence, int) and sequence >= 1 else None


def _completion_has(completion: dict[str, Any] | None, key: str) -> bool:
    value = completion.get(key) if isinstance(completion, dict) else None
    return isinstance(value, str) and bool(value.strip())


def _timestamp(value: Any) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _completion_has_deliverable(completion: dict[str, Any]) -> bool:
    return _completion_has(completion, "artifact_path") or _completion_has(completion, "artifact_url")


def _normalize_completion_payload(payload: dict[str, Any]) -> dict[str, Any]:
    status = str(payload.get("status") or "").lower()
    if status in {"success", "completed"} and not _completion_has_deliverable(payload):
        logger.warning(
            "Builder canvas: terminal success coerced to failed reason=missing_deliverable parent_thread_id=%s task_id=%s run_id=%s",
            payload.get("thread_id"),
            payload.get("task_id"),
            payload.get("run_id"),
        )
        return {
            **payload,
            "status": "error",
            "error_message": payload.get("error_message") or _MISSING_DELIVERABLE_ERROR,
        }
    return payload


class BuilderCanvasWorker:
    """Per-parent-thread buffered event stream for browser canvas clients."""

    def __init__(
        self,
        *,
        history_size: int = DEFAULT_HISTORY_SIZE,
        terminal_ttl_seconds: int = DEFAULT_TERMINAL_TTL_SECONDS,
        retired_runs_size: int = DEFAULT_RETIRED_RUNS_SIZE,
    ) -> None:
        self._history_size = history_size
        self._terminal_ttl_seconds = terminal_ttl_seconds
        self._retired_runs_size = retired_runs_size
        self._subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._histories: dict[tuple[str, str, str], deque[dict[str, Any]]] = {}
        self._active: dict[str, tuple[str, str]] = {}
        self._run_order: dict[str, dict[tuple[str, str], int]] = defaultdict(dict)
        self._next_run_order = 0
        self._retired_runs: dict[str, deque[tuple[str, str]]] = defaultdict(deque)
        self._retired_run_keys: dict[str, set[tuple[str, str]]] = defaultdict(set)
        self._terminal_at: dict[tuple[str, str, str], float] = {}
        self._last_sequence: dict[tuple[str, str, str], int] = {}
        self._plan_seen: set[tuple[str, str, str]] = set()
        self._dropped_progress_runs: set[tuple[str, str, str]] = set()
        self._lock = asyncio.Lock()

    def _expire_locked(self) -> None:
        now = time.monotonic()
        expired = [
            key for key, ended_at in self._terminal_at.items()
            if now - ended_at > self._terminal_ttl_seconds
        ]
        for key in expired:
            self._purge_run_locked(*key)
            parent_thread_id, task_id, run_id = key
            if self._active.get(parent_thread_id) == (task_id, run_id):
                self._retire_run_locked(parent_thread_id, task_id, run_id)
                self._active.pop(parent_thread_id, None)

    def _purge_run_locked(self, parent_thread_id: str, task_id: str, run_id: str) -> None:
        key = (parent_thread_id, task_id, run_id)
        self._terminal_at.pop(key, None)
        self._histories.pop(key, None)
        self._last_sequence.pop(key, None)
        self._plan_seen.discard(key)
        self._dropped_progress_runs.discard(key)

    def _observe_run_locked(self, parent_thread_id: str, task_id: str, run_id: str) -> None:
        run_key = (task_id, run_id)
        orders = self._run_order[parent_thread_id]
        if run_key in orders:
            return
        self._next_run_order += 1
        orders[run_key] = self._next_run_order

    def _has_observed_run_locked(self, parent_thread_id: str, task_id: str, run_id: str) -> bool:
        return (task_id, run_id) in self._run_order.get(parent_thread_id, {})

    def _retire_run_locked(self, parent_thread_id: str, task_id: str, run_id: str) -> None:
        run_key = (task_id, run_id)
        retired = self._retired_run_keys[parent_thread_id]
        if run_key in retired:
            return
        retired.add(run_key)
        queue = self._retired_runs[parent_thread_id]
        queue.append(run_key)
        while len(queue) > self._retired_runs_size:
            expired = queue.popleft()
            retired.discard(expired)
            self._purge_run_locked(parent_thread_id, expired[0], expired[1])

    def _is_retired_run_locked(self, parent_thread_id: str, task_id: str, run_id: str) -> bool:
        return (task_id, run_id) in self._retired_run_keys.get(parent_thread_id, set())

    def _terminal_is_newer_than_active_locked(self, event: dict[str, Any], active: tuple[str, str]) -> bool:
        if not event.get("_explicit_occurred_at"):
            return False
        parent_thread_id = event["parent_thread_id"]
        active_history = self._histories.get((parent_thread_id, active[0], active[1]), ())
        active_times = [
            parsed
            for item in active_history
            if (parsed := _timestamp(item.get("occurred_at"))) is not None
        ]
        active_latest = max(
            active_times,
            default=None,
        )
        event_time = _timestamp(event.get("occurred_at"))
        if event_time is None or active_latest is None:
            return False
        return event_time >= active_latest

    def _is_replaced_run_locked(self, event: dict[str, Any], key: tuple[str, str, str]) -> bool:
        parent_thread_id, task_id, run_id = key
        active = self._active.get(parent_thread_id)
        if self._is_retired_run_locked(parent_thread_id, task_id, run_id):
            return True
        if active is None or active == (task_id, run_id):
            return False
        if key in self._dropped_progress_runs:
            return True
        run_orders = self._run_order.get(parent_thread_id, {})
        active_order = run_orders.get(active)
        event_order = run_orders.get((task_id, run_id))
        if active_order is not None and event_order is not None and event_order < active_order:
            return True
        if event["kind"] == "terminal":
            if active[0] == task_id and not event.get("_run_observed_before_publish"):
                return not self._terminal_is_newer_than_active_locked(event, active)
            return False
        return key in self._histories

    def _is_duplicate_terminal_locked(self, event: dict[str, Any], key: tuple[str, str, str]) -> bool:
        if event["kind"] != "terminal":
            return False
        return any(item["kind"] == "terminal" for item in self._histories.get(key, ()))

    def _is_duplicate_event_locked(self, event: dict[str, Any], key: tuple[str, str, str]) -> bool:
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            return False
        return any(item.get("event_id") == event_id for item in self._histories.get(key, ()))

    def _drop_reason_locked(self, event: dict[str, Any], key: tuple[str, str, str]) -> str | None:
        if self._is_replaced_run_locked(event, key):
            # Once another task/run is visible, delayed terminal deliveries
            # and previously seen runs cannot reclaim the active canvas seed.
            return "replaced_run"
        if key in self._terminal_at and event["kind"] != "terminal":
            return "run_already_terminal"
        if self._is_duplicate_terminal_locked(event, key):
            return "duplicate_terminal"
        if self._is_duplicate_event_locked(event, key):
            return "duplicate_event"
        return None

    def _accept_event_locked(self, event: dict[str, Any], key: tuple[str, str, str]) -> bool:
        return self._drop_reason_locked(event, key) is None

    def _log_event_decision(self, decision: str, event: dict[str, Any], *, reason: str | None = None) -> None:
        activity = event.get("activity")
        completion = event.get("completion") if isinstance(event.get("completion"), dict) else None
        logger.info(
            "Builder canvas: event %s kind=%s reason=%s parent_thread_id=%s task_id=%s run_id=%s "
            "sequence=%s event_name=%s activity_kind=%s activity_category=%s status=%s "
            "activity_action=%s has_artifact_url=%s has_artifact_path=%s",
            decision,
            event.get("kind"),
            reason,
            event.get("parent_thread_id"),
            event.get("task_id"),
            event.get("run_id"),
            event.get("sequence"),
            event.get("_source_event_name"),
            activity.get("kind") if isinstance(activity, dict) else None,
            activity.get("category") if isinstance(activity, dict) else None,
            event.get("status"),
            activity.get("action") if isinstance(activity, dict) else None,
            _completion_has(completion, "artifact_url"),
            _completion_has(completion, "artifact_path"),
        )

    def _record_event_locked(self, event: dict[str, Any], key: tuple[str, str, str], sequence: int) -> None:
        previous = self._last_sequence.get(key, 0)
        parent_thread_id, task_id, run_id = key
        self._last_sequence[key] = max(previous, sequence)
        previous_active = self._active.get(parent_thread_id)
        if previous_active is not None and previous_active != (task_id, run_id):
            self._retire_run_locked(parent_thread_id, previous_active[0], previous_active[1])
        self._active[parent_thread_id] = (task_id, run_id)
        history = self._histories.setdefault(key, deque(maxlen=self._history_size))
        history.append(event)
        sorted_history = sorted(history, key=lambda item: int(item.get("sequence") or 0))
        history.clear()
        history.extend(sorted_history)
        if event["kind"] == "terminal":
            self._terminal_at[key] = time.monotonic()
        activity = event.get("activity")
        if isinstance(activity, dict) and activity.get("action") in {"creating_plan", "updating_plan"}:
            self._plan_seen.add(key)

    def _event_sequence_locked(self, event: dict[str, Any], key: tuple[str, str, str]) -> int | None:
        previous = self._last_sequence.get(key, 0)
        if event["kind"] == "terminal" and event.get("_allocate_sequence"):
            sequence = previous + 1
            event["sequence"] = sequence
            event["event_id"] = f"{event['task_id']}:{event['run_id']}:{sequence}"
            return sequence
        sequence = int(event["sequence"])
        if event["kind"] != "terminal" and sequence <= previous - self._history_size:
            logger.info(
                "Builder canvas: stale sequence dropped key=%s sequence=%s prior=%s",
                key,
                sequence,
                previous,
            )
            return None
        return sequence

    def _completion_run_id_locked(self, parent_thread_id: str, task_id: str, run_id: Any) -> str | None:
        if isinstance(run_id, str) and run_id:
            return run_id
        active = self._active.get(parent_thread_id)
        if active is not None and active[0] == task_id:
            return active[1]
        return None

    async def _publish_event(self, event: dict[str, Any]) -> int:
        parent_thread_id = event["parent_thread_id"]
        key = (parent_thread_id, event["task_id"], event["run_id"])
        delivered = 0
        async with self._lock:
            self._expire_locked()
            observed_before_publish = self._has_observed_run_locked(
                parent_thread_id,
                event["task_id"],
                event["run_id"],
            )
            event = {**event, "_run_observed_before_publish": observed_before_publish}
            sequence = self._event_sequence_locked(event, key)
            if sequence is None:
                self._log_event_decision("dropped", event, reason="stale_sequence")
                return 0
            drop_reason = self._drop_reason_locked(event, key)
            if drop_reason is not None:
                self._log_event_decision("dropped", event, reason=drop_reason)
                return 0
            self._observe_run_locked(parent_thread_id, event["task_id"], event["run_id"])
            self._log_event_decision("accepted", event)
            event = dict(event)
            event.pop("_source_event_name", None)
            event.pop("_run_observed_before_publish", None)
            event.pop("_allocate_sequence", None)
            event.pop("_explicit_occurred_at", None)
            self._record_event_locked(event, key, sequence)
            queues = list(self._subscribers.get(parent_thread_id, []))
        for queue in queues:
            try:
                queue.put_nowait(event)
                delivered += 1
            except asyncio.QueueFull:
                logger.warning("Builder canvas: slow subscriber dropped event thread_id=%s", parent_thread_id)
        return delivered

    async def publish_progress(self, payload: dict[str, Any]) -> int:
        parent = _required_str(payload, "parent_thread_id")
        task_id = _required_str(payload, "task_id")
        run_id = _required_str(payload, "run_id")
        sequence = _positive_sequence(payload)
        if parent is None or task_id is None or run_id is None or sequence is None:
            logger.info(
                "Builder canvas: progress dropped reason=invalid_identity parent_thread_id=%s task_id=%s run_id=%s sequence=%s event_name=%s",
                parent,
                task_id,
                run_id,
                payload.get("sequence"),
                payload.get("event_name"),
            )
            return 0
        async with self._lock:
            self._expire_locked()
            plan_seen = (parent, task_id, run_id) in self._plan_seen
        activity = _project_activity(str(payload.get("event_name") or ""), payload.get("data"), plan_seen=plan_seen)
        if activity is None:
            async with self._lock:
                self._expire_locked()
                self._dropped_progress_runs.add((parent, task_id, run_id))
            logger.info(
                "Builder canvas: progress dropped reason=no_public_activity parent_thread_id=%s task_id=%s run_id=%s sequence=%s event_name=%s",
                parent,
                task_id,
                run_id,
                sequence,
                payload.get("event_name"),
            )
            return 0
        event = {
            "version": 1,
            "event_id": f"{task_id}:{run_id}:{sequence}",
            "sequence": sequence,
            "parent_thread_id": parent,
            "task_id": task_id,
            "run_id": run_id,
            "occurred_at": payload.get("occurred_at") or _now_iso(),
            "kind": "progress",
            "status": "running",
            "activity": activity,
            "_source_event_name": payload.get("event_name"),
        }
        return await self._publish_event(event)

    async def publish_completion(self, payload: dict[str, Any]) -> int:
        parent = payload.get("thread_id")
        task_id = payload.get("task_id")
        if not all(isinstance(value, str) and value for value in (parent, task_id)):
            logger.info(
                "Builder canvas: terminal dropped reason=invalid_identity parent_thread_id=%s task_id=%s run_id=%s status=%s has_artifact_url=%s has_artifact_path=%s",
                parent,
                task_id,
                payload.get("run_id"),
                payload.get("status"),
                _completion_has(payload, "artifact_url"),
                _completion_has(payload, "artifact_path"),
            )
            return 0
        async with self._lock:
            run_id = self._completion_run_id_locked(parent, task_id, payload.get("run_id"))
            if run_id is None:
                logger.info(
                    "Builder canvas: terminal dropped reason=missing_run_id parent_thread_id=%s task_id=%s status=%s has_artifact_url=%s has_artifact_path=%s",
                    parent,
                    task_id,
                    payload.get("status"),
                    _completion_has(payload, "artifact_url"),
                    _completion_has(payload, "artifact_path"),
                )
                return 0
        completion = _normalize_completion_payload({**payload, "run_id": run_id})
        status = _public_terminal_status(completion.get("status"))
        terminal_activity = {
            "completed": _activity(action="success", category="finalize", label="Success", kind="phase"),
            "failed": _activity(action="failed", category="finalize", label="Failed", kind="phase"),
            "timed_out": _activity(action="timed_out", category="finalize", label="Timed out", kind="phase"),
            "cancelled": _activity(action="cancelled", category="finalize", label="Cancelled", kind="phase"),
        }[status]
        completed_at = payload.get("completed_at")
        event = {
            "version": 1,
            "parent_thread_id": parent,
            "task_id": task_id,
            "run_id": run_id,
            "occurred_at": completed_at or _now_iso(),
            "kind": "terminal",
            "status": status,
            "activity": terminal_activity,
            "completion": completion,
            "_source_event_name": "builder_completion",
            "_allocate_sequence": True,
            "_explicit_occurred_at": isinstance(completed_at, str) and bool(completed_at.strip()),
        }
        return await self._publish_event(event)

    async def recent_events(self, parent_thread_id: str) -> list[dict[str, Any]]:
        async with self._lock:
            self._expire_locked()
            active = self._active.get(parent_thread_id)
            if active is None:
                return []
            return list(self._histories.get((parent_thread_id, *active), []))

    async def active_summary(self, parent_thread_id: str) -> dict[str, Any]:
        async with self._lock:
            self._expire_locked()
            active = self._active.get(parent_thread_id)
            event_count = 0
            if active is not None:
                event_count = len(self._histories.get((parent_thread_id, *active), ()))
            return {
                "active_task_id": active[0] if active else None,
                "active_run_id": active[1] if active else None,
                "retained_event_count": event_count,
                "subscriber_count": len(self._subscribers.get(parent_thread_id, ())),
            }

    async def latest_activity(self, parent_thread_id: str, task_id: str, run_id: str) -> dict[str, Any] | None:
        async with self._lock:
            self._expire_locked()
            events = self._histories.get((parent_thread_id, task_id, run_id), ())
            for event in reversed(events):
                if event.get("activity"):
                    return dict(event["activity"])
        return None

    async def replay_after(self, parent_thread_id: str, event_id: str | None) -> list[dict[str, Any]]:
        events = await self.recent_events(parent_thread_id)
        if not event_id:
            return events
        for index, event in enumerate(events):
            if event.get("event_id") == event_id:
                return events[index + 1:]
        return events

    @asynccontextmanager
    async def subscribe(self, parent_thread_id: str) -> AsyncIterator[asyncio.Queue]:
        queue: asyncio.Queue = asyncio.Queue(maxsize=_SUBSCRIBER_QUEUE_MAXSIZE)
        async with self._lock:
            self._subscribers[parent_thread_id].append(queue)
            subscriber_count = len(self._subscribers[parent_thread_id])
        logger.info(
            "Builder canvas: subscriber opened parent_thread_id=%s subscriber_count=%s",
            parent_thread_id,
            subscriber_count,
        )
        try:
            yield queue
        finally:
            async with self._lock:
                queues = self._subscribers.get(parent_thread_id, [])
                if queue in queues:
                    queues.remove(queue)
                subscriber_count = len(queues)
                if not queues:
                    self._subscribers.pop(parent_thread_id, None)
            logger.info(
                "Builder canvas: subscriber closed parent_thread_id=%s subscriber_count=%s",
                parent_thread_id,
                subscriber_count,
            )


_WORKER_ATTR = "_builder_canvas_worker"


def install_builder_canvas_worker(app) -> BuilderCanvasWorker:
    worker = BuilderCanvasWorker()
    setattr(app.state, _WORKER_ATTR, worker)
    return worker


def get_builder_canvas_worker(app) -> BuilderCanvasWorker:
    worker = getattr(app.state, _WORKER_ATTR, None)
    if worker is None:
        raise RuntimeError("BuilderCanvasWorker is not installed on app.state")
    return worker
