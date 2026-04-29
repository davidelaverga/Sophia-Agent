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
from collections import OrderedDict
from datetime import datetime
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:  # pragma: no cover - type-only import
    from deerflow.subagents.executor import SubagentResult

logger = logging.getLogger(__name__)


_DEFAULT_GATEWAY_URL = "http://localhost:8001"
_WEBHOOK_PATH = "/internal/builder-events"
_WEBHOOK_TIMEOUT_SECONDS = 2.0


# Process-local LRU cache of task_ids that have already had their completion
# webhook posted. Prevents duplicates from heartbeat persists, lock-protected
# writebacks, and the outer-exception handler all firing for the same task.
#
# Bounded with an LRU eviction policy so a long-running LangGraph process
# doesn't accumulate every historical task_id forever. The cap is generous
# enough that no real session collides with itself: at peak Sophia rates
# (~1 task per minute), 10k entries cover a week of continuous work.
_EMITTED_CACHE_MAX = 10_000
_emitted_task_ids: "OrderedDict[str, None]" = OrderedDict()
_emitted_lock = threading.Lock()


def _try_mark_emitted(task_id: str) -> bool:
    """Atomically claim the right to emit for ``task_id``.

    Returns ``True`` when the caller wins the race (and is responsible for
    firing the webhook), ``False`` when another caller already claimed it.
    On ``True`` returns, the caller MUST eventually fire the webhook *or*
    call :func:`_release_emit_claim` to allow a future retry — otherwise
    a payload-build failure would permanently silence the task.
    """
    with _emitted_lock:
        if task_id in _emitted_task_ids:
            # Touch for LRU recency so a hot task_id stays warm.
            _emitted_task_ids.move_to_end(task_id)
            return False
        _emitted_task_ids[task_id] = None
        if len(_emitted_task_ids) > _EMITTED_CACHE_MAX:
            # Evict the oldest entry (FIFO end of the OrderedDict).
            _emitted_task_ids.popitem(last=False)
        return True


def _release_emit_claim(task_id: str) -> None:
    """Roll back a successful :func:`_try_mark_emitted` claim.

    Called when payload construction fails after the claim is recorded so
    that a subsequent terminal write for the same task_id (e.g. a retry
    after the malformed-state condition is fixed) can still go through.
    """
    with _emitted_lock:
        _emitted_task_ids.pop(task_id, None)


# Agent names whose terminal events we surface as builder-completion cards.
# Extend this set when PR 2 retrofits the deepagents async path.
_OBSERVED_AGENT_NAMES = frozenset({"sophia_builder"})


def _gateway_url() -> str:
    return os.environ.get("SOPHIA_GATEWAY_URL", _DEFAULT_GATEWAY_URL).rstrip("/")


_misconfigured_logged = False
_misconfigured_logged_lock = threading.Lock()


def _warn_if_misconfigured(payload: dict[str, Any]) -> None:
    """Log a one-shot warning when the gateway URL points at localhost in
    a deployed environment.

    The Render LangGraph and Gateway services run as separate processes —
    the LangGraph container can't reach the gateway via ``localhost:8001``.
    Operators must set ``SOPHIA_GATEWAY_URL`` on the LangGraph service to
    the Gateway's internal/public URL. We can't detect "is this Render?"
    perfectly from inside the container, but we can detect "the gateway URL
    is localhost AND we're not running locally" via a few common heuristics
    and surface a loud warning so misconfiguration is obvious in the first
    failure log.
    """
    global _misconfigured_logged
    if _misconfigured_logged:
        return

    explicit = os.environ.get("SOPHIA_GATEWAY_URL", "").strip()
    if explicit:
        # Operator set the URL explicitly — assume they know what they did.
        return

    looks_deployed = any(
        os.environ.get(var)
        for var in ("RENDER", "RENDER_EXTERNAL_URL", "FLY_APP_NAME", "K_SERVICE")
    )
    if not looks_deployed:
        return

    with _misconfigured_logged_lock:
        if _misconfigured_logged:
            return
        _misconfigured_logged = True
    logger.warning(
        "Builder-events: SOPHIA_GATEWAY_URL not set in a deployed "
        "environment; falling back to %s which will NOT reach the "
        "Gateway service. Completion cards will be DROPPED until "
        "SOPHIA_GATEWAY_URL is configured. (task_id=%s, thread_id=%s)",
        _DEFAULT_GATEWAY_URL,
        payload.get("task_id"),
        payload.get("thread_id"),
    )


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


# PR-A: phantom-success detection thresholds.
#
# The builder's hard-ceiling fallback (builder_artifact.py:_HARD_CEILING) emits
# a confidence=0.5 result when it can promote a real file from outputs/, and a
# confidence=0.2 "force-stopped" result when it can't. A success event with
# very low confidence AND no artifact_path almost always means the model gave
# up under tool_choice pressure without producing anything — surfacing that as
# a "ready" card with a broken Open button is worse than telling the user the
# truth and offering retry.
_PHANTOM_SUCCESS_CONFIDENCE_THRESHOLD = 0.3


def _is_phantom_success(
    *,
    status: str,
    artifact_path: str | None,
    artifact_url: str | None,
    confidence: Any,
) -> bool:
    """Decide whether a 'success' event is actually a phantom (no deliverable).

    A success event is phantom when ALL of:
    - status maps to 'success' (i.e., subagent reported COMPLETED)
    - artifact_url is missing (signed-URL mint failed because the file
      doesn't exist on Supabase) AND artifact_path is missing/empty
    - confidence is below the phantom threshold

    The confidence check matters because a deliberately-text-only artifact
    (no path, but high confidence) is legitimate — only the low-confidence
    no-path combo signals "model gave up".
    """
    if status != "success":
        return False
    has_path = isinstance(artifact_path, str) and artifact_path.strip()
    has_url = isinstance(artifact_url, str) and artifact_url.strip()
    if has_path or has_url:
        return False
    try:
        confidence_value = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        confidence_value = None
    if confidence_value is None:
        # Missing confidence + missing path/url is itself suspicious; treat
        # as phantom so the user gets the failure card with retry.
        return True
    return confidence_value < _PHANTOM_SUCCESS_CONFIDENCE_THRESHOLD


def build_completion_payload(
    result: SubagentResult,
    *,
    agent_name: str | None = None,
) -> dict[str, Any]:
    """Build the webhook payload from a terminal SubagentResult.

    Single source of truth for the wire contract — both PR 1 (sync builder)
    and PR 2 (async deepagents) emit the same shape so the gateway worker
    and frontend card don't need to branch.

    PR-A: detects "phantom success" (status=success but no artifact_path,
    no artifact_url, and confidence below the threshold) and coerces it to
    status=error with a retry-friendly error_message. Without this, the
    frontend would render a success card with a broken Open button when
    the builder gave up without producing a deliverable.
    """
    # Local import to avoid circular: subagents.executor → sophia.builder_events
    from deerflow.subagents.executor import _extract_builder_result_from_task_result

    builder_result = _extract_builder_result_from_task_result(result) or {}
    artifact_path = builder_result.get("artifact_path")
    artifact_title = builder_result.get("artifact_title")
    artifact_type = builder_result.get("artifact_type")
    confidence = builder_result.get("confidence")

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

    mapped_status = _map_status(status_value)
    error_message: str | None = getattr(result, "error", None)

    if _is_phantom_success(
        status=mapped_status,
        artifact_path=artifact_path,
        artifact_url=artifact_url,
        confidence=confidence,
    ):
        logger.warning(
            "Builder-events: coercing phantom-success to error for "
            "task_id=%s confidence=%s artifact_path=%r — builder reported "
            "success but produced no deliverable.",
            getattr(result, "task_id", None),
            confidence,
            artifact_path,
        )
        mapped_status = "error"
        if not error_message:
            error_message = (
                "Builder finished but couldn’t produce a deliverable. "
                "Want me to try again?"
            )

    # The originating user is recorded on the SubagentResult as ``owner_id``
    # (set by ``execute_async``). Carry it on the event so the gateway-side
    # companion-wakeup worker can route the synthetic turn to the correct
    # user without having to round-trip ``client.threads.get_state``.
    owner_id = getattr(result, "owner_id", None)

    return {
        "thread_id": getattr(result, "thread_id", None),
        "task_id": getattr(result, "task_id", None),
        "trace_id": getattr(result, "trace_id", None),
        "agent_name": agent_name,
        "status": mapped_status,
        "task_type": task_type,
        "task_brief": _extract_task_brief(result),
        "artifact_url": artifact_url,
        "artifact_title": artifact_title,
        "artifact_type": artifact_type,
        "artifact_filename": artifact_filename,
        "summary": builder_result.get("companion_summary"),
        "user_next_action": builder_result.get("user_next_action"),
        "error_message": error_message,
        "completed_at": _iso(getattr(result, "completed_at", None)),
        "source": "subagent_executor",
        "user_id": owner_id if isinstance(owner_id, str) and owner_id else None,
    }


def _post_webhook(payload: dict[str, Any]) -> None:
    """Fire the POST. Called on a daemon thread so the executor never blocks."""
    if not payload.get("thread_id"):
        # No parent thread → nothing for the gateway to route to.
        return
    _warn_if_misconfigured(payload)
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

    # Claim the dedup slot atomically. If another terminal write already
    # fired for this task_id, return early.
    if not _try_mark_emitted(task_id):
        return False

    try:
        payload = build_completion_payload(result, agent_name=agent_name)
    except Exception:
        # Payload build failed (malformed result state, etc.). Roll back
        # the dedup claim so a subsequent retry for the same task_id can
        # still deliver — otherwise a transient bug here would permanently
        # silence the user-visible completion card.
        _release_emit_claim(task_id)
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
    """Clear the emitted-task-ids dedup set + misconfigured-warning latch.

    Test-only.
    """
    global _misconfigured_logged
    with _emitted_lock:
        _emitted_task_ids.clear()
    with _misconfigured_logged_lock:
        _misconfigured_logged = False
