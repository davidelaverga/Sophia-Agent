"""Builder completion event publisher.

Bridges the LangGraph process (where ``SubagentExecutor`` runs the builder
in a background thread) to the Gateway process (which fans events out to
the webapp via SSE and to channel adapters like Telegram).

Why a webhook and not shared state: the LangGraph and Gateway processes
are deployed separately (different containers in production). The
webhook keeps the contract explicit and testable — a single POST per
terminal task transition. Failures are logged and never block the
companion's own completion path.

The webhook fires *exactly once* per task_id even if the underlying
result object is touched multiple times during cleanup. Dedup is process-
local; if the LangGraph process restarts mid-run, the gateway worker can
recover the last event from its 5-minute TTL cache (see
``app/gateway/workers/builder_events.py``).
"""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:  # pragma: no cover - type-only import
    from deerflow.subagents.executor import SubagentResult

logger = logging.getLogger(__name__)


_DEFAULT_GATEWAY_URL = "http://localhost:8001"
_WEBHOOK_PATH = "/internal/builder-events"
_WEBHOOK_TIMEOUT_SECONDS = 2.0


# Process-local set of task_ids that have already had their completion
# webhook posted. Prevents duplicates from heartbeat persists, lock-protected
# writebacks, and the outer-exception handler all firing for the same task.
_emitted_task_ids: set[str] = set()
_emitted_lock = threading.Lock()


# Agent names whose terminal events we surface as builder-completion cards.
# Extend this set when PR 2 retrofits the deepagents async path.
_OBSERVED_AGENT_NAMES = frozenset({"sophia_builder"})


def _gateway_url() -> str:
    return os.environ.get("SOPHIA_GATEWAY_URL", _DEFAULT_GATEWAY_URL).rstrip("/")


def should_emit_for_agent(agent_name: str | None) -> bool:
    """Decide whether terminal events from this agent should fan out as cards."""
    return isinstance(agent_name, str) and agent_name in _OBSERVED_AGENT_NAMES


def _map_status(status_value: str) -> str:
    """Normalize ``SubagentStatus.value`` strings to the card's enum."""
    if status_value == "completed":
        return "success"
    if status_value == "failed":
        return "error"
    if status_value == "timed_out":
        return "timeout"
    if status_value == "cancelled":
        return "cancelled"
    return status_value


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _signed_artifact_url(thread_id: str | None, artifact_path: str | None) -> str | None:
    """Mint a signed Supabase URL for the artifact, or None on any failure."""
    if not thread_id or not artifact_path:
        return None
    try:
        from deerflow.sophia.storage.supabase_artifact_store import create_signed_url

        return create_signed_url(thread_id=thread_id, filename=artifact_path)
    except Exception:  # pragma: no cover - defensive: never let this raise
        logger.debug("Failed to mint signed artifact URL", exc_info=True)
        return None


def _extract_task_brief(result: SubagentResult) -> str | None:
    """Pull the original user task brief from the result's final state.

    ``delegation_context.task`` is populated by ``switch_to_builder`` when it
    queues the handoff and survives across summarization (it lives in
    durable state, not just messages). The retry button on the failure card
    needs this so the parent companion can re-issue the same task.
    """
    final_state = getattr(result, "final_state", None)
    if isinstance(final_state, dict):
        delegation = final_state.get("delegation_context")
        if isinstance(delegation, dict):
            task = delegation.get("task")
            if isinstance(task, str) and task.strip():
                return task.strip()
    description = getattr(result, "description", None)
    if isinstance(description, str) and description.strip():
        return description.strip()
    return None


def build_completion_payload(
    result: SubagentResult,
    *,
    agent_name: str | None = None,
) -> dict[str, Any]:
    """Build the webhook payload from a terminal SubagentResult.

    Single source of truth for the wire contract — both PR 1 (sync builder)
    and PR 2 (async deepagents) emit the same shape so the gateway worker
    and frontend card don't need to branch.
    """
    # Local import to avoid circular: subagents.executor → sophia.builder_events
    from deerflow.subagents.executor import _extract_builder_result_from_task_result

    builder_result = _extract_builder_result_from_task_result(result) or {}
    artifact_path = builder_result.get("artifact_path")
    artifact_title = builder_result.get("artifact_title")
    artifact_type = builder_result.get("artifact_type")

    artifact_filename = None
    if isinstance(artifact_path, str) and artifact_path:
        # ``artifact_path`` from the builder is the virtual path (e.g.
        # ``/mnt/user-data/outputs/foo.md``). Supabase keys the artifact by
        # filename only — match the existing upload logic in
        # ``BuilderArtifactMiddleware``.
        artifact_filename = artifact_path.rsplit("/", 1)[-1]

    artifact_url = _signed_artifact_url(getattr(result, "thread_id", None), artifact_filename)

    status_value = getattr(getattr(result, "status", None), "value", None)
    if status_value is None:
        status_value = str(getattr(result, "status", ""))

    task_type = None
    final_state = getattr(result, "final_state", None)
    if isinstance(final_state, dict):
        builder_task = final_state.get("builder_task")
        if isinstance(builder_task, dict):
            task_type = builder_task.get("task_type")

    return {
        "thread_id": getattr(result, "thread_id", None),
        "task_id": getattr(result, "task_id", None),
        "trace_id": getattr(result, "trace_id", None),
        "agent_name": agent_name,
        "status": _map_status(status_value),
        "task_type": task_type,
        "task_brief": _extract_task_brief(result),
        "artifact_url": artifact_url,
        "artifact_title": artifact_title,
        "artifact_type": artifact_type,
        "artifact_filename": artifact_filename,
        "summary": builder_result.get("companion_summary"),
        "user_next_action": builder_result.get("user_next_action"),
        "error_message": getattr(result, "error", None),
        "completed_at": _iso(getattr(result, "completed_at", None)),
        "source": "subagent_executor",
    }


def _post_webhook(payload: dict[str, Any]) -> None:
    """Fire the POST. Called on a daemon thread so the executor never blocks."""
    if not payload.get("thread_id"):
        # No parent thread → nothing for the gateway to route to.
        return
    url = f"{_gateway_url()}{_WEBHOOK_PATH}"
    try:
        with httpx.Client(timeout=_WEBHOOK_TIMEOUT_SECONDS) as client:
            response = client.post(url, json=payload)
            if response.status_code >= 500:
                logger.warning(
                    "Builder-events webhook returned %s for task_id=%s",
                    response.status_code,
                    payload.get("task_id"),
                )
            elif response.status_code >= 400:
                # 4xx is a contract bug we want to know about.
                logger.warning(
                    "Builder-events webhook rejected (status=%s) for task_id=%s body=%s",
                    response.status_code,
                    payload.get("task_id"),
                    response.text[:200],
                )
    except Exception:
        logger.warning(
            "Builder-events webhook delivery failed for task_id=%s",
            payload.get("task_id"),
            exc_info=True,
        )


def emit_completion_event(
    result: SubagentResult,
    *,
    agent_name: str | None,
) -> bool:
    """Publish a terminal event for the given result, exactly once per task_id.

    Returns ``True`` when the event was scheduled for delivery, ``False``
    otherwise (already fired, agent not observed, no terminal status, etc.).
    The actual HTTP POST runs on a daemon thread so callers — typically the
    subagent executor's terminal-flip path — never block.
    """
    # Local import to dodge the executor → sophia → executor import cycle.
    from deerflow.subagents.executor import SubagentStatus

    status = getattr(result, "status", None)
    if status not in {
        SubagentStatus.COMPLETED,
        SubagentStatus.FAILED,
        SubagentStatus.TIMED_OUT,
        SubagentStatus.CANCELLED,
    }:
        return False

    if not should_emit_for_agent(agent_name):
        return False

    task_id = getattr(result, "task_id", None)
    if not task_id:
        return False

    with _emitted_lock:
        if task_id in _emitted_task_ids:
            return False
        _emitted_task_ids.add(task_id)

    try:
        payload = build_completion_payload(result, agent_name=agent_name)
    except Exception:
        logger.warning(
            "Failed to build builder-events payload for task_id=%s",
            task_id,
            exc_info=True,
        )
        return False

    threading.Thread(
        target=_post_webhook,
        args=(payload,),
        name=f"builder-events-{task_id}",
        daemon=True,
    ).start()
    return True


def reset_for_tests() -> None:
    """Clear the emitted-task-ids dedup set. Test-only."""
    with _emitted_lock:
        _emitted_task_ids.clear()
