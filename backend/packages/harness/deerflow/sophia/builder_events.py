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
from datetime import UTC, datetime
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


def _resolve_runtime_thread_id(runtime: Any) -> str | None:
    """Find the running graph's thread_id on a ``langgraph.runtime.Runtime``.

    LangGraph populates ``runtime.context["thread_id"]`` from the thread
    association on ``runs.create(thread_id=…)``. Custom keys we pass via
    ``runs.create(config={"configurable": …})`` are NOT forwarded by
    langgraph-api 0.8.1 — confirmed in production 2026-05-06 when our
    diagnostic logged ``missing builder thread_id in runtime.config.configurable``
    despite ``ThreadDataMiddleware.before_agent`` having read the thread_id
    from ``runtime.context`` earlier in the same run.

    Mirror that middleware's resolution order: context first, then config.
    """
    if runtime is None:
        return None
    try:
        ctx = runtime.context if runtime.context is not None else {}
    except Exception:  # pragma: no cover - defensive
        ctx = {}
    if isinstance(ctx, dict):
        candidate = ctx.get("thread_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate

    try:
        cfg = (runtime.config or {}).get("configurable", {}) or {}
    except Exception:  # pragma: no cover - defensive
        cfg = {}
    candidate = cfg.get("thread_id")
    if isinstance(candidate, str) and candidate.strip():
        return candidate
    return None


# --- Native deepagents-dispatch path -----------------------------------------
#
# Post Phase-1 migration the builder runs as a native LangGraph subagent
# (no ``SubagentExecutor``) so the legacy ``emit_completion_event(result)``
# entry point has no caller. The two helpers below let
# ``BuilderArtifactMiddleware`` fire the same webhook from inside the builder
# graph itself, using the artifact dict it just captured + the run's runtime
# config. Same wire contract on the gateway side; same dedup; same
# phantom-success guard.

_TERMINAL_STATUSES_NATIVE = frozenset({"completed", "failed", "timed_out", "cancelled"})


def build_completion_payload_from_artifact(
    *,
    state: dict[str, Any],
    runtime: Any,
    artifact: dict[str, Any],
    status: str = "completed",
    error_message: str | None = None,
) -> dict[str, Any]:
    """Build a webhook payload from the builder's captured artifact dict.

    Called from inside the builder graph (``BuilderArtifactMiddleware``)
    instead of the deleted ``SubagentExecutor`` terminal-flip handler.
    Mirrors the wire shape of :func:`build_completion_payload` so the
    gateway worker, channel adapters, and frontend card are unchanged.

    Args:
        state: Builder-graph state at the moment of completion. Used for
            ``builder_task.task_type``, ``delegation_context.task`` (the
            task_brief), and — IMPORTANT — ``delegation_context.parent_thread_id``
            and ``delegation_context.parent_user_id``. langgraph-api 0.8.1
            forwards only a subset of ``runtime.config["configurable"]``
            keys to the running graph; custom keys arrive as ``None``.
            ``start_builder_task`` works around this by also embedding the
            parent fields in ``delegation_context`` (state), which always
            propagates. We read state first and fall back to config.
        runtime: ``langgraph.runtime.Runtime`` for the current builder run.
            Used for ``thread_id`` (builder thread) and the config
            fallback path described above.
        artifact: The captured ``emit_builder_artifact`` payload (or the
            ``_build_ceiling_fallback`` shape on force-emit).
        status: One of ``completed``/``failed``/``timed_out``/``cancelled``.
            Defaults to ``completed``; pass ``failed`` on the
            ceiling-fallback path so the Telegram card surfaces a retry.
        error_message: Free-form error string for non-completed paths.
    """
    cfg = {}
    if runtime is not None:
        try:
            cfg = (runtime.config or {}).get("configurable", {}) or {}
        except Exception:  # pragma: no cover - defensive
            cfg = {}

    delegation = state.get("delegation_context") if isinstance(state, dict) else None
    delegation_dict = delegation if isinstance(delegation, dict) else {}

    # Read the builder's own thread_id via the same context-first pattern
    # ``ThreadDataMiddleware`` uses — runtime.config.configurable is not
    # always populated by langgraph-api 0.8.1 (see _resolve_runtime_thread_id).
    builder_thread_id = _resolve_runtime_thread_id(runtime)
    # State-first, config-fallback. State always reaches the running graph;
    # configurable propagation is langgraph-api-version-dependent.
    parent_thread_id = delegation_dict.get("parent_thread_id") or cfg.get("parent_thread_id")
    user_id = (
        delegation_dict.get("parent_user_id")
        or cfg.get("parent_user_id")
        or cfg.get("user_id")
    )
    trace_id = (runtime.config or {}).get("metadata", {}).get("trace_id") if runtime is not None else None

    artifact_path = artifact.get("artifact_path") if isinstance(artifact, dict) else None
    artifact_filename: str | None = None
    if isinstance(artifact_path, str) and artifact_path:
        artifact_filename = artifact_path.rsplit("/", 1)[-1]

    artifact_url = _signed_artifact_url(builder_thread_id, artifact_filename)

    task_brief: str | None = None
    task = delegation_dict.get("task")
    if isinstance(task, str) and task.strip():
        task_brief = task.strip()

    builder_task = state.get("builder_task") if isinstance(state, dict) else None
    task_type = builder_task.get("task_type") if isinstance(builder_task, dict) else None
    if not task_type:
        task_type = delegation_dict.get("task_type")

    mapped_status = _map_status(status)

    if _is_phantom_success(
        status=mapped_status,
        artifact_path=artifact_path,
        artifact_url=artifact_url,
        confidence=artifact.get("confidence") if isinstance(artifact, dict) else None,
    ):
        logger.warning(
            "Builder-events: coercing phantom-success to error for task_id=%s "
            "confidence=%s artifact_path=%r — builder reported success but "
            "produced no deliverable.",
            builder_thread_id,
            artifact.get("confidence") if isinstance(artifact, dict) else None,
            artifact_path,
        )
        mapped_status = "error"
        if not error_message:
            error_message = (
                "Builder finished but couldn't produce a deliverable. "
                "Want me to try again?"
            )

    return {
        # ``thread_id`` in the webhook payload is the COMPANION thread (where
        # the Telegram chat lives) — this matches the legacy contract that
        # ``app/channels/telegram.py:_on_builder_completion`` keys off.
        "thread_id": parent_thread_id,
        # ``task_id`` is the builder's own thread (also the task_id stored in
        # companion ``state["async_tasks"]``).
        "task_id": builder_thread_id,
        "trace_id": trace_id,
        "agent_name": "sophia_builder",
        "status": mapped_status,
        "task_type": task_type,
        "task_brief": task_brief,
        "artifact_url": artifact_url,
        "artifact_title": artifact.get("artifact_title") if isinstance(artifact, dict) else None,
        "artifact_type": artifact.get("artifact_type") if isinstance(artifact, dict) else None,
        "artifact_filename": artifact_filename,
        "summary": artifact.get("companion_summary") if isinstance(artifact, dict) else None,
        "user_next_action": artifact.get("user_next_action") if isinstance(artifact, dict) else None,
        "error_message": error_message,
        "completed_at": _iso(datetime.now(UTC)),
        "source": "builder_artifact_middleware",
        "user_id": user_id if isinstance(user_id, str) and user_id else None,
    }


def fire_completion_webhook_from_artifact(
    *,
    state: dict[str, Any],
    runtime: Any,
    artifact: dict[str, Any],
    status: str = "completed",
    error_message: str | None = None,
) -> bool:
    """Build the payload and fire the webhook on a daemon thread, exactly once.

    Wraps :func:`build_completion_payload_from_artifact` with the same dedup
    + daemon-thread machinery as :func:`emit_completion_event`. Returns
    ``True`` when scheduled, ``False`` on dedup-hit, missing thread_id, or
    payload-build failure.
    """
    if status not in _TERMINAL_STATUSES_NATIVE:
        logger.info(
            "[Builder] fire_completion_webhook: skipping non-terminal status=%r",
            status,
        )
        return False

    # Read the builder's own thread_id (= task_id) via context-first
    # resolution. langgraph-api 0.8.1 populates ``runtime.context["thread_id"]``
    # from the run's thread association but does NOT forward custom keys
    # we pass via ``runs.create(config={"configurable": ...})`` — see
    # _resolve_runtime_thread_id for the production-confirmed details.
    task_id = _resolve_runtime_thread_id(runtime)
    if not task_id:
        logger.warning(
            "[Builder] fire_completion_webhook: missing builder thread_id "
            "in runtime.context AND runtime.config.configurable; cannot "
            "dispatch webhook. (runtime=%s)",
            "missing" if runtime is None else "present but no thread_id",
        )
        return False

    if not _try_mark_emitted(task_id):
        logger.info(
            "[Builder] fire_completion_webhook: already emitted for task_id=%s; skipping",
            task_id,
        )
        return False

    try:
        payload = build_completion_payload_from_artifact(
            state=state,
            runtime=runtime,
            artifact=artifact,
            status=status,
            error_message=error_message,
        )
    except Exception:
        _release_emit_claim(task_id)
        logger.warning(
            "Failed to build native-dispatch builder-events payload for task_id=%s",
            task_id,
            exc_info=True,
        )
        return False

    # Permanent breadcrumb so we can audit the webhook chain end-to-end:
    # any future "artifact didn't reach Telegram" report should start by
    # checking whether THIS log line appeared on the builder side and then
    # whether the gateway saw the matching POST.
    logger.info(
        "[Builder] fire_completion_webhook: dispatching task_id=%s "
        "parent_thread_id=%s status=%s artifact_path=%r artifact_url_present=%s",
        task_id,
        payload.get("thread_id"),
        payload.get("status"),
        payload.get("artifact_filename"),
        bool(payload.get("artifact_url")),
    )

    threading.Thread(
        target=_post_webhook,
        args=(payload,),
        name=f"builder-events-{task_id}",
        daemon=True,
    ).start()
    return True
