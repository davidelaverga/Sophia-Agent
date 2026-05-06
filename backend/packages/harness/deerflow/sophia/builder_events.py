"""Builder completion event publisher.

Bridges the LangGraph process (where the builder runs as a deepagents
async-subagent) to the Gateway process (which fans events out to the
webapp via SSE and to channel adapters like Telegram).

Why a webhook and not shared state: the LangGraph and Gateway processes
are deployed separately (different containers in production). The
webhook keeps the contract explicit and testable — a single POST per
terminal task transition. Failures are logged and never block the
builder's own completion path.

The webhook fires *exactly once* per task_id even if
``BuilderArtifactMiddleware.after_model`` is exercised multiple times
during cleanup. Dedup is process-local; if the LangGraph process
restarts mid-run, the gateway worker can recover the last event from
its 5-minute TTL cache (see ``app/gateway/workers/builder_events.py``).

The single live entry point is :func:`fire_completion_webhook_from_artifact`,
which builds the wire payload from the captured ``emit_builder_artifact``
dict via :func:`build_completion_payload_from_artifact`. The legacy
``SubagentResult``-based path (``emit_completion_event`` + the original
``build_completion_payload``) was removed when ``SubagentExecutor`` exited
the builder hot path in the Phase-1 async migration; the helpers below
deliberately do NOT take a ``SubagentResult`` parameter.
"""

from __future__ import annotations

import logging
import os
import threading
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any

import httpx

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


def _map_status(status_value: str) -> str:
    """Normalize internal status strings to the card's enum surface."""
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

    Resolution order (first non-empty hit wins):

    1. ``runtime.execution_info.thread_id`` — the canonical source per
       ``langgraph >= 1.0``. ``langgraph/pregel/_algo.py`` populates the
       ``ExecutionInfo`` dataclass on every task with the run's bound
       thread identity, regardless of dispatch path. This is the
       future-proof source — in particular it remains populated under
       LangGraph Platform / distributed deployments where the OSS code
       path that fills ``runtime.context`` is bypassed (see Codex bot
       review on PR #113).
    2. ``runtime.context["thread_id"]`` — auto-populated by
       ``langgraph-api`` on ASGI in-process dispatch (our current path).
       This is what made ``ThreadDataMiddleware`` work before we noticed
       the gap; kept as a fallback so existing test stubs (which set
       ``runtime.context``) keep working.
    3. ``runtime.config["configurable"]["thread_id"]`` — last-resort
       fallback for callers that pass ``thread_id`` via
       ``runs.create(config=...)``. ``langgraph-api 0.8.1`` does not
       forward our custom configurable keys reliably (confirmed in
       production 2026-05-06), so this rarely fires.
    """
    if runtime is None:
        return None

    # 1. execution_info — canonical per langgraph >= 1.0
    info = getattr(runtime, "execution_info", None)
    if info is not None:
        candidate = getattr(info, "thread_id", None)
        if isinstance(candidate, str) and candidate.strip():
            return candidate

    # 2. context — proven-working in our current ASGI in-process path.
    # ``getattr`` rather than direct attribute access because production
    # ``langgraph.runtime.Runtime`` doesn't always expose every attribute
    # we depend on (see line-575 AttributeError on ``.config`` in production
    # 2026-05-06).
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        candidate = ctx.get("thread_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate

    # 3. config.configurable — legacy fallback
    raw_config = getattr(runtime, "config", None)
    cfg = (raw_config or {}).get("configurable") or {} if isinstance(raw_config, dict) else {}
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
    # Pull the runtime config dict ONCE, defensively. ``langgraph.runtime.Runtime``
    # in production (langgraph >= 1.0) does NOT expose ``.config`` directly —
    # that attribute lives on ``ToolRuntime`` / ``RunnableConfig`` paths.
    # Production traceback (2026-05-06):
    #   File ".../sophia/builder_events.py", line 575, in build_completion_payload_from_artifact
    #   AttributeError: 'Runtime' object has no attribute 'config'
    # Use ``getattr`` with default so we never assume the attribute exists.
    runtime_config: dict[str, Any] = {}
    if runtime is not None:
        try:
            raw = getattr(runtime, "config", None)
            if isinstance(raw, dict):
                runtime_config = raw
        except Exception:  # pragma: no cover - defensive
            runtime_config = {}
    cfg: dict[str, Any] = runtime_config.get("configurable") or {}

    delegation = state.get("delegation_context") if isinstance(state, dict) else None
    delegation_dict = delegation if isinstance(delegation, dict) else {}

    # Read the builder's own thread_id via the canonical execution_info-first
    # pattern (see ``_resolve_runtime_thread_id``).
    builder_thread_id = _resolve_runtime_thread_id(runtime)
    # State-first, config-fallback. State always reaches the running graph;
    # configurable propagation is langgraph-api-version-dependent.
    parent_thread_id = delegation_dict.get("parent_thread_id") or cfg.get("parent_thread_id")
    user_id = (
        delegation_dict.get("parent_user_id")
        or cfg.get("parent_user_id")
        or cfg.get("user_id")
    )
    metadata = runtime_config.get("metadata") or {}
    trace_id = metadata.get("trace_id") if isinstance(metadata, dict) else None

    artifact_path = artifact.get("artifact_path") if isinstance(artifact, dict) else None
    artifact_filename: str | None = None
    if isinstance(artifact_path, str) and artifact_path:
        artifact_filename = artifact_path.rsplit("/", 1)[-1]

    # Sign against the SAME thread_id ``BuilderArtifactMiddleware`` uploads
    # to: parent_thread_id (the conversation thread). The channel adapter's
    # download path keys off the webhook payload's ``thread_id`` field
    # (which is also parent_thread_id below), so this keeps the storage
    # path, the signed URL, and the bytes-download lookup all aligned.
    artifact_url = _signed_artifact_url(
        parent_thread_id or builder_thread_id,
        artifact_filename,
    )

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
            "in runtime.execution_info AND runtime.context AND "
            "runtime.config.configurable; cannot dispatch webhook. "
            "(runtime=%s)",
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
