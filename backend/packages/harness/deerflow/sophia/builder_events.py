"""Builder completion event publisher.

Bridges the LangGraph process (where the builder runs as a deepagents
async-subagent) to the Gateway process (which fans events out to the
webapp via SSE and to channel adapters like Telegram).

Why a webhook and not shared state: the LangGraph and Gateway processes
are deployed separately (different containers in production). The
webhook keeps the contract explicit and testable — a single POST per
terminal task transition. Failures are logged and never block the
builder's own completion path.

The webhook fires *exactly once* per task_id/run_id even if
``BuilderArtifactMiddleware.after_model`` is exercised multiple times
during cleanup. Legacy callers without a run_id still dedup by task_id.
Dedup is process-local; if the LangGraph process
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
import time
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any

import httpx

from deerflow.sophia.builder_failure_diagnostics import (
    build_builder_failure_diagnostics,
    merge_builder_failure_diagnostics,
)

logger = logging.getLogger(__name__)


_DEFAULT_GATEWAY_URL = "http://localhost:8001"
_WEBHOOK_PATH = "/internal/builder-events"
_WEBHOOK_TIMEOUT_SECONDS = 2.0
# Bounded retry on transient failure (transport error / 5xx). A single
# fire-and-forget POST dropped completion events when the gateway hiccuped —
# prod 2026-06-26 (a deck's ceiling-fallback success webhook was lost). Mirrors
# the gateway-side terminal-edit retry backoff. 4xx is a contract bug and is
# NOT retried. Runs on a daemon thread so the sleeps never block the executor.
_WEBHOOK_RETRY_BACKOFFS_SECONDS = (2.0, 5.0, 15.0)
_INTERNAL_STORAGE_OBJECT_SEGMENTS = frozenset(
    {
        "ledger",
        "uploads",
        ".builder",
        "assets",
        "deck_build",
        "slides",
        "sources",
        "source_artifact",
        "visuals",
    }
)


# Process-local LRU cache of task_id/run_id pairs that have already had
# their completion webhook posted. Prevents duplicates from heartbeat
# persists, lock-protected writebacks, and the outer-exception handler all
# firing for the same run.
#
# Bounded with an LRU eviction policy so a long-running LangGraph process
# doesn't accumulate every historical task_id/run_id forever. The cap is generous
# enough that no real session collides with itself: at peak Sophia rates
# (~1 task per minute), 10k entries cover a week of continuous work.
_EMITTED_CACHE_MAX = 10_000
_EmitDedupeKey = tuple[str, str | None]
_emitted_task_ids: OrderedDict[_EmitDedupeKey, None] = OrderedDict()
_emitted_lock = threading.Lock()


def _emit_dedupe_key(task_id: str, run_id: str | None) -> _EmitDedupeKey:
    """Return the terminal dedupe key, preserving legacy no-run behavior."""
    return (task_id, run_id or None)


def _try_mark_emitted(task_id: str, run_id: str | None = None) -> bool:
    """Atomically claim the right to emit for ``task_id``/``run_id``.

    Returns ``True`` when the caller wins the race (and is responsible for
    firing the webhook), ``False`` when another caller already claimed it.
    On ``True`` returns, the caller MUST eventually fire the webhook *or*
    call :func:`_release_emit_claim` to allow a future retry — otherwise
    a payload-build failure would permanently silence the task.
    """
    key = _emit_dedupe_key(task_id, run_id)
    with _emitted_lock:
        if key in _emitted_task_ids:
            # Touch for LRU recency so a hot task/run stays warm.
            _emitted_task_ids.move_to_end(key)
            return False
        _emitted_task_ids[key] = None
        if len(_emitted_task_ids) > _EMITTED_CACHE_MAX:
            # Evict the oldest entry (FIFO end of the OrderedDict).
            _emitted_task_ids.popitem(last=False)
        return True


def _release_emit_claim(task_id: str, run_id: str | None = None) -> None:
    """Roll back a successful :func:`_try_mark_emitted` claim.

    Called when payload construction fails after the claim is recorded so
    that a subsequent terminal write for the same task_id/run_id (e.g. a
    retry after the malformed-state condition is fixed) can still go through.
    """
    key = _emit_dedupe_key(task_id, run_id)
    with _emitted_lock:
        _emitted_task_ids.pop(key, None)


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

    looks_deployed = any(os.environ.get(var) for var in ("RENDER", "RENDER_EXTERNAL_URL", "FLY_APP_NAME", "K_SERVICE"))
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


def _storage_object_path_for_signing(artifact_path: str | None, storage_object_path: str | None) -> str | None:
    return storage_object_path or (artifact_path if str(artifact_path or "").startswith("artifacts/") else None)


def _artifact_storage_object_scope(object_path: str) -> tuple[str | None, str | None, str]:
    parts = object_path.split("/")
    if parts[0] == "artifacts":
        if len(parts) < 5:
            raise ValueError("Artifact storage path must belong to the artifact thread")
        return parts[1].strip() or None, parts[2].strip() or None, "/".join(parts[4:])
    return None, parts[0].strip() or None, "/".join(parts[1:])


def _storage_object_addresses_internal_keyspace(relative_object_path: str) -> bool:
    segments = [segment for segment in relative_object_path.split("/") if segment]
    if any(segment in _INTERNAL_STORAGE_OBJECT_SEGMENTS for segment in segments):
        return True
    name = segments[-1].lower() if segments else ""
    return name.endswith((".source.md", ".source.html", ".plan.json", ".manifest.json", ".preview.pdf")) or (name.startswith("_") and name.endswith(".py")) or (name.startswith("test_") and name.endswith((".py", ".sh")))


def _validated_storage_object_path_for_signing(
    *,
    thread_id: str | None,
    artifact_path: str | None,
    storage_object_path: str | None,
    user_id: str | None,
) -> str | None:
    object_path = _storage_object_path_for_signing(artifact_path, storage_object_path)
    if not object_path:
        return None
    if not thread_id:
        logger.debug("Skipping exact-object signing without a thread scope")
        return None
    try:
        from deerflow.sophia.storage import supabase_artifact_store

        normalized = supabase_artifact_store.normalize_object_path(object_path)
        object_user_id, object_thread_id, relative = _artifact_storage_object_scope(normalized)
        if object_thread_id != str(thread_id).strip():
            raise ValueError("Artifact storage path must belong to the artifact thread")
        if user_id and object_user_id is not None:
            expected_user_id = supabase_artifact_store.safe_object_path_segment(user_id, default="user")
            if object_user_id != expected_user_id:
                raise ValueError("Artifact storage path must belong to the artifact user")
        if _storage_object_addresses_internal_keyspace(relative):
            raise ValueError("Artifact references an internal keyspace")
        return normalized
    except Exception:
        logger.debug("Refusing to sign unvalidated artifact storage path", exc_info=True)
        return None


def _call_create_signed_url(
    *,
    thread_id: str | None,
    artifact_path: str | None,
    object_path: str | None,
) -> str | None:
    try:
        from deerflow.sophia.storage.supabase_artifact_store import create_signed_url

        return create_signed_url(
            thread_id=thread_id or "",
            filename=artifact_path or "",
            object_path=object_path,
        )
    except Exception:  # pragma: no cover - defensive: never let this raise
        logger.debug("Failed to mint signed artifact URL", exc_info=True)
        return None


def _signed_artifact_url(
    thread_id: str | None,
    artifact_path: str | None,
    *,
    storage_object_path: str | None = None,
    authenticated_user_id: str | None = None,
) -> str | None:
    """Mint a signed Supabase URL for the artifact, or None on any failure."""
    raw_object_path = _storage_object_path_for_signing(artifact_path, storage_object_path)
    if not raw_object_path and _artifact_path_addresses_internal_keyspace(artifact_path):
        return None
    object_path = _validated_storage_object_path_for_signing(
        thread_id=thread_id,
        artifact_path=artifact_path,
        storage_object_path=storage_object_path,
        user_id=authenticated_user_id,
    )
    if raw_object_path and not object_path:
        return None
    if not object_path and (not thread_id or not artifact_path):
        return None
    return _call_create_signed_url(
        thread_id=thread_id,
        artifact_path=artifact_path,
        object_path=object_path,
    )


_ARTIFACT_PATH_PREFIXES = (
    ("/mnt/user-data/outputs/", lambda value: value[1:]),
    ("mnt/user-data/outputs/", lambda value: value),
    ("/user-data/outputs/", lambda value: f"mnt{value}"),
    ("user-data/outputs/", lambda value: f"mnt/{value}"),
    ("/outputs/", lambda value: f"mnt/user-data{value}"),
    ("outputs/", lambda value: f"mnt/user-data/{value}"),
)


def _canonical_artifact_path(path: Any) -> str | None:
    if not isinstance(path, str):
        return None
    cleaned = path.strip().replace("\\", "/")
    if cleaned.startswith("file://"):
        cleaned = cleaned[len("file://") :]
    if not cleaned:
        return None
    for prefix, canonicalize in _ARTIFACT_PATH_PREFIXES:
        if cleaned.startswith(prefix):
            return canonicalize(cleaned)
    user_data_index = cleaned.find("/user-data/outputs/")
    if user_data_index >= 0:
        return f"mnt{cleaned[user_data_index:]}"
    return cleaned.lstrip("/")


def _relative_output_artifact_path(path: str | None) -> str | None:
    prefix = "mnt/user-data/outputs/"
    if not path or not path.startswith(prefix):
        return None
    relative = path[len(prefix) :].strip("/")
    return relative or None


def _artifact_path_addresses_internal_keyspace(path: str | None) -> bool:
    canonical = _canonical_artifact_path(path)
    if canonical is None:
        return False
    relative = _relative_output_artifact_path(canonical) or canonical
    return _storage_object_addresses_internal_keyspace(relative)


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
    - confidence is at or below the phantom threshold

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
    return confidence_value <= _PHANTOM_SUCCESS_CONFIDENCE_THRESHOLD


def _post_webhook(payload: dict[str, Any]) -> None:
    """Fire the POST with bounded retry. On a daemon thread so it never blocks.

    Retries transient failures (transport error / 5xx) with the
    ``_WEBHOOK_RETRY_BACKOFFS_SECONDS`` backoff; a 2xx stops immediately and a
    4xx (contract bug) is not retried. Without this, a single gateway hiccup
    silently dropped a terminal completion event — prod 2026-06-26, where a
    deck's ceiling-fallback ``status=success`` webhook failed to deliver.
    """
    if not payload.get("thread_id"):
        # No parent thread → nothing for the gateway to route to.
        return
    _warn_if_misconfigured(payload)
    url = f"{_gateway_url()}{_WEBHOOK_PATH}"
    task_id = payload.get("task_id")
    max_attempts = len(_WEBHOOK_RETRY_BACKOFFS_SECONDS) + 1
    for attempt in range(1, max_attempts + 1):
        try:
            with httpx.Client(timeout=_WEBHOOK_TIMEOUT_SECONDS) as client:
                response = client.post(url, json=payload)
            if response.status_code < 400:
                if attempt > 1:
                    logger.info(
                        "Builder-events webhook delivered for task_id=%s on attempt=%d",
                        task_id,
                        attempt,
                    )
                return
            if response.status_code < 500:
                # 4xx is a contract bug we want to know about — not retryable.
                logger.warning(
                    "Builder-events webhook rejected (status=%s) for task_id=%s body=%s",
                    response.status_code,
                    task_id,
                    response.text[:200],
                )
                return
            logger.warning(
                "Builder-events webhook returned %s for task_id=%s (attempt=%d/%d)",
                response.status_code,
                task_id,
                attempt,
                max_attempts,
            )
        except Exception:
            logger.warning(
                "Builder-events webhook delivery failed for task_id=%s (attempt=%d/%d)",
                task_id,
                attempt,
                max_attempts,
                exc_info=True,
            )
        if attempt <= len(_WEBHOOK_RETRY_BACKOFFS_SECONDS):
            time.sleep(_WEBHOOK_RETRY_BACKOFFS_SECONDS[attempt - 1])
    logger.error(
        "Builder-events webhook exhausted %d attempts for task_id=%s; event dropped",
        max_attempts,
        task_id,
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


def _resolve_runtime_run_id(runtime: Any) -> str | None:
    """Find the running graph's run_id on a ``langgraph.runtime.Runtime``.

    Phase 4I post-review (codex P1): symmetric counterpart to
    ``_resolve_runtime_thread_id`` for the LangGraph ``run_id``.
    ``runtime.execution_info.run_id`` is populated by
    ``pregel/_algo.py`` on every task and is the canonical source.

    Returns ``None`` if no run_id can be found — callers MUST treat
    this as "skip the run_id check" (back-compat with the in-flight
    payload path before this helper landed).
    """
    if runtime is None:
        return None
    info = getattr(runtime, "execution_info", None)
    if info is not None:
        candidate = getattr(info, "run_id", None)
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    # No reliable fallback — run_id isn't in context or
    # config.configurable in practice. The execution_info source is
    # populated unconditionally in langgraph >= 1.0 so the fallback
    # only matters for legacy test stubs (which can set
    # ``runtime.context["run_id"]`` if they need to).
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        candidate = ctx.get("run_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _runtime_config_dict(runtime: Any) -> dict[str, Any]:
    if runtime is None:
        return {}
    try:
        raw = getattr(runtime, "config", None)
    except Exception:  # pragma: no cover - defensive
        return {}
    return raw if isinstance(raw, dict) else {}


def _runtime_configurable(runtime_config: dict[str, Any]) -> dict[str, Any]:
    cfg = runtime_config.get("configurable")
    return cfg if isinstance(cfg, dict) else {}


def _state_dict(value: dict[str, Any] | Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _delegation_dict(state: dict[str, Any]) -> dict[str, Any]:
    delegation = state.get("delegation_context")
    return delegation if isinstance(delegation, dict) else {}


def _trace_id(runtime_config: dict[str, Any]) -> Any:
    metadata = runtime_config.get("metadata")
    return metadata.get("trace_id") if isinstance(metadata, dict) else None


def _parent_thread_id(delegation: dict[str, Any], cfg: dict[str, Any]) -> Any:
    return delegation.get("parent_thread_id") or cfg.get("parent_thread_id")


def _parent_user_id(delegation: dict[str, Any], cfg: dict[str, Any]) -> str | None:
    user_id = delegation.get("parent_user_id") or cfg.get("parent_user_id") or cfg.get("user_id")
    return user_id if isinstance(user_id, str) and user_id else None


def _task_brief(delegation: dict[str, Any]) -> str | None:
    task = delegation.get("task")
    return task.strip() if isinstance(task, str) and task.strip() else None


def _task_type(state: dict[str, Any], delegation: dict[str, Any]) -> Any:
    builder_task = state.get("builder_task")
    if isinstance(builder_task, dict) and builder_task.get("task_type"):
        return builder_task.get("task_type")
    return delegation.get("task_type")


def _artifact_filename(artifact_path: str | None) -> str | None:
    if isinstance(artifact_path, str) and artifact_path:
        return artifact_path.rsplit("/", 1)[-1]
    return None


def _artifact_signed_url(
    *,
    parent_thread_id: Any,
    builder_thread_id: str | None,
    artifact_storage_path: str | None,
    artifact_filename: str | None,
    storage_object_path: str | None,
    authenticated_user_id: str | None,
) -> str | None:
    # Sign against the SAME thread_id ``BuilderArtifactMiddleware`` uploads
    # to: parent_thread_id (the conversation thread). The channel adapter's
    # download path keys off the webhook payload's ``thread_id`` field
    # (which is also parent_thread_id below), so this keeps the storage
    # path, the signed URL, and the bytes-download lookup all aligned.
    return _signed_artifact_url(
        parent_thread_id or builder_thread_id,
        artifact_storage_path or artifact_filename,
        storage_object_path=storage_object_path,
        authenticated_user_id=authenticated_user_id,
    )


def _artifact_signed_url_with_result(
    *,
    parent_thread_id: Any,
    builder_thread_id: str | None,
    artifact_storage_path: str | None,
    artifact_filename: str | None,
    storage_object_path: str | None,
    authenticated_user_id: str | None,
) -> tuple[str | None, str]:
    signing_thread_id = parent_thread_id or builder_thread_id
    signing_path = artifact_storage_path or artifact_filename
    if _skip_artifact_signing(signing_thread_id, signing_path, storage_object_path):
        return None, "skipped"
    url = _artifact_signed_url(
        parent_thread_id=parent_thread_id,
        builder_thread_id=builder_thread_id,
        artifact_storage_path=artifact_storage_path,
        artifact_filename=artifact_filename,
        storage_object_path=storage_object_path,
        authenticated_user_id=authenticated_user_id,
    )
    if url:
        return url, "signed_url_created"
    try:
        from deerflow.sophia.storage import supabase_artifact_store

        if not supabase_artifact_store.is_configured():
            return None, "not_configured"
    except Exception:  # pragma: no cover - defensive only
        logger.debug("Failed to inspect Supabase signing config", exc_info=True)
    return None, "signed_url_failed"


def _skip_artifact_signing(
    signing_thread_id: Any,
    signing_path: str | None,
    storage_object_path: str | None,
) -> bool:
    return not storage_object_path and (not signing_thread_id or not signing_path or _artifact_path_addresses_internal_keyspace(signing_path))


def _coerce_phantom_success(
    *,
    mapped_status: str,
    artifact_path: str | None,
    artifact_url: str | None,
    artifact: dict[str, Any],
    builder_thread_id: str | None,
    error_message: str | None,
) -> tuple[str, str | None]:
    if not _is_phantom_success(
        status=mapped_status,
        artifact_path=artifact_path,
        artifact_url=artifact_url,
        confidence=artifact.get("confidence"),
    ):
        return mapped_status, error_message
    logger.warning(
        "Builder-events: coercing phantom-success to error for task_id=%s confidence=%s artifact_path=%r — builder reported success but produced no deliverable.",
        builder_thread_id,
        artifact.get("confidence"),
        artifact_path,
    )
    return "error", error_message or ("Builder finished but couldn't produce a deliverable. Want me to try again?")


def _has_deliverable(artifact_path: str | None, artifact_url: str | None) -> bool:
    return bool((isinstance(artifact_path, str) and artifact_path.strip()) or (isinstance(artifact_url, str) and artifact_url.strip()))


def _combined_supabase_result(current: Any, signed_url_result: str) -> str:
    current_result = current if isinstance(current, str) and current else None
    if current_result == "failed_best_effort":
        return current_result
    if signed_url_result in {"signed_url_failed", "signed_url_created"}:
        return signed_url_result
    return current_result or signed_url_result


def _completion_failure_diagnostics(
    *,
    state: dict[str, Any],
    runtime: Any,
    artifact: dict[str, Any],
    mapped_status: str,
    artifact_path: str | None,
    artifact_url: str | None,
    signed_url_result: str,
) -> dict[str, Any] | None:
    current = artifact.get("builder_failure_diagnostics")
    current_diag = current if isinstance(current, dict) else None
    signed_url_created = signed_url_result == "signed_url_created"
    supabase_result = _combined_supabase_result(
        current_diag.get("supabase_mirror_result") if isinstance(current_diag, dict) else None,
        signed_url_result,
    )
    if current_diag:
        return merge_builder_failure_diagnostics(
            current_diag,
            signed_url_created=signed_url_created,
            supabase_mirror_result=supabase_result,
            completion_webhook_attempted=True,
            completion_webhook_result="scheduled",
        )
    if mapped_status == "error" and not _has_deliverable(artifact_path, artifact_url):
        return build_builder_failure_diagnostics(
            state=state,
            runtime=runtime,
            artifact_args=artifact,
            failure_stage="completion_reconciliation",
            failure_reason="Builder finished without a deliverable artifact.",
            failure_code="builder_completed_without_deliverable",
            emit_attempted=False,
            emit_tool_call_seen=None,
            signed_url_created=signed_url_created,
            supabase_mirror_result=supabase_result,
            completion_webhook_attempted=True,
            completion_webhook_result="scheduled",
            canvas_reconciliation_action="coerced_success_to_failed_no_deliverable",
        )
    if artifact_path and signed_url_result in {"signed_url_failed", "not_configured"}:
        return build_builder_failure_diagnostics(
            state=state,
            runtime=runtime,
            artifact_args=artifact,
            failure_stage="storage_mirror",
            failure_reason=("Supabase signing did not create a URL, but the local artifact path remains available."),
            failure_code=None,
            emit_attempted=True,
            emit_tool_call_seen=True,
            include_outputs_summary=False,
            signed_url_created=signed_url_created,
            supabase_mirror_result=supabase_result,
            completion_webhook_attempted=True,
            completion_webhook_result="scheduled",
        )
    return None


def _artifact_completion_fields(
    artifact: dict[str, Any],
    artifact_path: str | None,
    artifact_url: str | None,
    artifact_filename: str | None,
) -> dict[str, Any]:
    return {
        "artifact_path": artifact_path,
        "artifact_url": artifact_url,
        "artifact_title": artifact.get("artifact_title"),
        "artifact_type": artifact.get("artifact_type"),
        "artifact_filename": artifact_filename,
        "artifact_files": artifact.get("artifact_files"),
        "artifact_id": artifact.get("artifact_id"),
        "storage_provider": artifact.get("storage_provider"),
        "storage_bucket": artifact.get("storage_bucket"),
        "storage_object_path": artifact.get("storage_object_path"),
        "storage_status": artifact.get("storage_status"),
        "manifest_path": artifact.get("manifest_path"),
        "manifest_revision": artifact.get("manifest_revision"),
        "logical_artifact_id": artifact.get("logical_artifact_id"),
        "current_artifact_version_id": artifact.get("current_artifact_version_id"),
        "foundation_status": artifact.get("foundation_status"),
        "requested_artifact_ext": artifact.get("requested_artifact_ext"),
        "artifact_ext": artifact.get("artifact_ext"),
        "artifact_is_fallback": artifact.get("artifact_is_fallback"),
        "fallback_reason": artifact.get("fallback_reason"),
        # Correction wave 2026-06-12: emit-time format-conflict guard — the
        # delivered format honored the user's explicit current-turn ask over
        # a misderived dispatch target. Every occurrence is a dispatch-
        # resolution failure signal worth monitoring.
        "format_conflict_resolved": artifact.get("format_conflict_resolved"),
        "format_conflict_original_target_ext": artifact.get("format_conflict_original_target_ext"),
        "image_generation_status": artifact.get("image_generation_status"),
        "image_generation_reason": artifact.get("image_generation_reason"),
        "primary_image_batch_status": artifact.get("primary_image_batch_status"),
        "primary_image_batch_error_class": artifact.get("primary_image_batch_error_class"),
        "image_generation_startup_error_class": artifact.get("image_generation_startup_error_class"),
        "image_generation_exit_code": artifact.get("image_generation_exit_code"),
        "image_generation_raw_error_excerpt": artifact.get("image_generation_raw_error_excerpt"),
        "image_generation_startup_attempt_count": artifact.get("image_generation_startup_attempt_count"),
        "serial_repair_count": artifact.get("serial_repair_count"),
        "manifest_authoring_failure_count": artifact.get("manifest_authoring_failure_count"),
        "presentation_route": artifact.get("presentation_route"),
        "deck_route": artifact.get("deck_route"),
        "deck_compile_mode": artifact.get("deck_compile_mode"),
        "native_required": artifact.get("native_required"),
        "legacy_screenshot_debug": artifact.get("legacy_screenshot_debug"),
        "native_editability_score": artifact.get("native_editability_score"),
        "native_text_shape_count": artifact.get("native_text_shape_count"),
        "picture_shape_count": artifact.get("picture_shape_count"),
        "full_slide_picture_count": artifact.get("full_slide_picture_count"),
        "native_mechanical_report": artifact.get("native_mechanical_report"),
        "mechanical_gate_results": artifact.get("mechanical_gate_results"),
        "html_source_validation": artifact.get("html_source_validation"),
        "source_retention_report": artifact.get("source_retention_report"),
        "native_contrast_report": artifact.get("native_contrast_report"),
        "creative_plan_path": artifact.get("creative_plan_path"),
        "deck_quality_status": artifact.get("deck_quality_status"),
        "failure_code": artifact.get("failure_code"),
        "deck_failure_code": artifact.get("deck_failure_code") or artifact.get("failure_code"),
        "root_failure_code": artifact.get("root_failure_code"),
        "root_failure_summary": artifact.get("root_failure_summary"),
        "expected_generated_visual_count": artifact.get("expected_generated_visual_count"),
        "successful_generated_visual_count": artifact.get("successful_generated_visual_count"),
        "referenced_visual_count": artifact.get("referenced_visual_count"),
        "missing_expected_visual_count": artifact.get("missing_expected_visual_count"),
        "visual_quality_gap_count": artifact.get("visual_quality_gap_count"),
        # VQ-3: harness-stamped enrichment outcome — attempted/succeeded/
        # skip_reason. A build with image generation enabled never ends
        # ambiguous.
        "image_generation_outcome": artifact.get("image_generation_outcome"),
        # VQ-10: loop honesty — how hard we tried and what stayed unmet.
        "iterations_used": artifact.get("iterations_used"),
        "unmet_conditions": artifact.get("unmet_conditions"),
        # Spec D D-5: assumptions the builder stated for brief fields not
        # present in the parent conversation — the companion names them.
        "brief_assumptions": artifact.get("brief_assumptions"),
        "source_artifact_path": artifact.get("source_artifact_path"),
        "revision_of_artifact_path": artifact.get("revision_of_artifact_path"),
        "summary": artifact.get("companion_summary"),
        "user_next_action": artifact.get("user_next_action"),
        # Canvas preview sibling (e.g. <deck>.preview.pdf rendered from a
        # .pptx via LibreOffice) — lets the webapp render binary formats it
        # has no native renderer for through the existing PDF canvas.
        "artifact_preview_filename": artifact.get("artifact_preview_filename"),
        "quality_warning": artifact.get("quality_warning"),
        "visuals_missing": artifact.get("visuals_missing"),
        "budget_stop_reason": artifact.get("budget_stop_reason"),
        "terminal_status": artifact.get("terminal_status") or artifact.get("status"),
        "terminal_reason": artifact.get("terminal_reason"),
        "report_contract_status": artifact.get("report_contract_status"),
        "report_contract_version": artifact.get("report_contract_version"),
        "expected_section_count": artifact.get("expected_section_count"),
        "found_section_count": artifact.get("found_section_count"),
        "expected_body_section_count": artifact.get("expected_body_section_count"),
        "found_body_section_count": artifact.get("found_body_section_count"),
        "missing_section_ids": artifact.get("missing_section_ids"),
        "expected_visual_count": artifact.get("expected_visual_count"),
        "found_visual_count": artifact.get("found_visual_count"),
        "missing_visual_ids": artifact.get("missing_visual_ids"),
        "minimum_word_count": artifact.get("minimum_word_count"),
        "source_word_count": artifact.get("source_word_count"),
        "cover_present": artifact.get("cover_present"),
        "toc_present": artifact.get("toc_present"),
        "conclusion_present": artifact.get("conclusion_present"),
        "references_present": artifact.get("references_present"),
        "report_contract_problems": artifact.get("report_contract_problems"),
        "first_prepare_turn": artifact.get("first_prepare_turn"),
        "prepare_call_count": artifact.get("prepare_call_count"),
        "prepare_emitted_call_count": artifact.get("prepare_emitted_call_count"),
        "prepare_execution_count": artifact.get("prepare_execution_count"),
        "prepare_normalized_call_count": artifact.get("prepare_normalized_call_count"),
        "prepare_schema_failure_count": artifact.get("prepare_schema_failure_count"),
        "prepare_parallel_call_count": artifact.get("prepare_parallel_call_count"),
        "prepare_service_call_count": artifact.get("prepare_service_call_count"),
        "prepare_service_result_count": artifact.get("prepare_service_result_count"),
        "prepare_result_count": artifact.get("prepare_result_count"),
        "prepare_retry_executed": artifact.get("prepare_retry_executed"),
        "prepare_policy_result_count": artifact.get("prepare_policy_result_count"),
        "prepare_repair_count": artifact.get("prepare_repair_count"),
        "dangling_prepare_call_count": artifact.get("dangling_prepare_call_count"),
        "creative_plan_accepted": artifact.get("creative_plan_accepted"),
        "deck_authoring_contract": artifact.get("deck_authoring_contract"),
        "authoring_contract": artifact.get("authoring_contract") or artifact.get("deck_authoring_contract"),
        "build_event_store_status": artifact.get("build_event_store_status"),
        "builder_trace_run_id": artifact.get("builder_trace_run_id"),
        "builder_trace_root_run_id": artifact.get("builder_trace_root_run_id"),
        "deck_authoring_elapsed_ms": artifact.get("deck_authoring_elapsed_ms"),
        "deck_repair_elapsed_ms": artifact.get("deck_repair_elapsed_ms"),
        "deck_service_elapsed_ms": artifact.get("deck_service_elapsed_ms"),
        "terminal_cleanup_elapsed_ms": artifact.get("terminal_cleanup_elapsed_ms"),
        "presentation_preflight_status": artifact.get("presentation_preflight_status"),
        "presentation_preflight_elapsed_ms": artifact.get("presentation_preflight_elapsed_ms"),
        "deck_authoring_started_at_ms": artifact.get("deck_authoring_started_at_ms"),
        "deck_authoring_budget_ms": artifact.get("deck_authoring_budget_ms"),
        "deck_authoring_remaining_ms": artifact.get("deck_authoring_remaining_ms"),
        "deck_authoring_prompt_bytes": artifact.get("deck_authoring_prompt_bytes"),
        "deck_authoring_prompt_estimated_tokens": artifact.get("deck_authoring_prompt_estimated_tokens"),
        "deck_authoring_tool_schema_bytes": artifact.get("deck_authoring_tool_schema_bytes"),
        "deck_authoring_context_bytes": artifact.get("deck_authoring_context_bytes"),
        "deck_authoring_output_bytes": artifact.get("deck_authoring_output_bytes"),
        "authoring_tool_call_started": artifact.get("authoring_tool_call_started"),
        "prepare_force_reason": artifact.get("prepare_force_reason"),
        "last_prepare_failure_code": artifact.get("last_prepare_failure_code"),
        "last_prepare_failure_summary": artifact.get("last_prepare_failure_summary"),
    }


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
    state_dict = _state_dict(state)
    artifact_dict = _state_dict(artifact)
    runtime_config = _runtime_config_dict(runtime)
    cfg = _runtime_configurable(runtime_config)
    delegation = _delegation_dict(state_dict)

    # Read the builder's own thread_id via the canonical execution_info-first
    # pattern (see ``_resolve_runtime_thread_id``).
    builder_thread_id = _resolve_runtime_thread_id(runtime)
    # Phase 4I post-review (codex P1): read the run_id too so the
    # webhook payload carries it. ``_on_builder_completion`` on the
    # gateway side uses it to validate against the registry entry's
    # stored run_id — without this plumbing, a delayed terminal from
    # an interrupted previous run (``update_async_task`` flow) would
    # still close the NEW run's placeholder because the registry
    # mark_done/mark_stopped checks would short-circuit on
    # ``run_id=None``.
    builder_run_id = _resolve_runtime_run_id(runtime)
    # State-first, config-fallback. State always reaches the running graph;
    # configurable propagation is langgraph-api-version-dependent.
    parent_thread_id = _parent_thread_id(delegation, cfg)
    user_id = _parent_user_id(delegation, cfg)
    trace_id = _trace_id(runtime_config)

    artifact_path = _canonical_artifact_path(artifact_dict.get("artifact_path"))
    artifact_storage_path = _relative_output_artifact_path(artifact_path)
    artifact_filename = _artifact_filename(artifact_path)
    storage_object_path = artifact_dict.get("storage_object_path")
    if not isinstance(storage_object_path, str) or not storage_object_path.strip():
        storage_object_path = None
    artifact_url, signed_url_result = _artifact_signed_url_with_result(
        parent_thread_id=parent_thread_id,
        builder_thread_id=builder_thread_id,
        artifact_storage_path=artifact_storage_path,
        artifact_filename=artifact_filename,
        storage_object_path=storage_object_path,
        authenticated_user_id=user_id,
    )

    task_brief = _task_brief(delegation)
    task_type = _task_type(state_dict, delegation)

    mapped_status = _map_status(status)
    mapped_status, error_message = _coerce_phantom_success(
        mapped_status=mapped_status,
        artifact_path=artifact_path,
        artifact_url=artifact_url,
        artifact=artifact_dict,
        builder_thread_id=builder_thread_id,
        error_message=error_message,
    )
    failure_diagnostics = _completion_failure_diagnostics(
        state=state_dict,
        runtime=runtime,
        artifact=artifact_dict,
        mapped_status=mapped_status,
        artifact_path=artifact_path,
        artifact_url=artifact_url,
        signed_url_result=signed_url_result,
    )

    payload = {
        # ``thread_id`` in the webhook payload is the COMPANION thread (where
        # the Telegram chat lives) — this matches the legacy contract that
        # ``app/channels/telegram.py:_on_builder_completion`` keys off.
        "thread_id": parent_thread_id,
        # ``task_id`` is the builder's own thread (also the task_id stored in
        # companion ``state["async_tasks"]``).
        "task_id": builder_thread_id,
        # ``run_id`` is the LangGraph run identifier for the run that
        # is terminating now. Phase 4I post-review (codex P1): used
        # by the gateway-side ``BuilderProgressRegistry`` to drop
        # stale-run terminals (interrupted runs from
        # ``update_async_task``) so they don't close the new run's
        # placeholder. ``None`` only on pre-4I in-flight payloads;
        # registry treats None as "skip the check" (back-compat).
        "run_id": builder_run_id,
        "trace_id": trace_id,
        "agent_name": "sophia_builder",
        "status": mapped_status,
        "task_type": task_type,
        "task_brief": task_brief,
        **_artifact_completion_fields(
            artifact_dict,
            artifact_path,
            artifact_url,
            artifact_filename,
        ),
        "error_message": error_message,
        "completed_at": _iso(datetime.now(UTC)),
        "source": "builder_artifact_middleware",
        "user_id": user_id,
    }
    if failure_diagnostics:
        payload["builder_failure_diagnostics"] = failure_diagnostics
    return payload


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
            "[Builder] fire_completion_webhook: missing builder thread_id in runtime.execution_info AND runtime.context AND runtime.config.configurable; cannot dispatch webhook. (runtime=%s)",
            "missing" if runtime is None else "present but no thread_id",
        )
        return False

    builder_run_id = _resolve_runtime_run_id(runtime)

    if not _try_mark_emitted(task_id, builder_run_id):
        logger.info(
            "[Builder] fire_completion_webhook: already emitted for task_id=%s run_id=%s; skipping",
            task_id,
            builder_run_id,
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
        _release_emit_claim(task_id, builder_run_id)
        logger.warning(
            "Failed to build native-dispatch builder-events payload for task_id=%s run_id=%s",
            task_id,
            builder_run_id,
            exc_info=True,
        )
        return False

    # Permanent breadcrumb so we can audit the webhook chain end-to-end:
    # any future "artifact didn't reach Telegram" report should start by
    # checking whether THIS log line appeared on the builder side and then
    # whether the gateway saw the matching POST.
    logger.info(
        "[Builder] fire_completion_webhook: dispatching task_id=%s run_id=%s parent_thread_id=%s status=%s artifact_path=%r artifact_filename=%r artifact_url_present=%s image_generation_status=%s image_generation_reason=%s",
        task_id,
        payload.get("run_id"),
        payload.get("thread_id"),
        payload.get("status"),
        payload.get("artifact_path"),
        payload.get("artifact_filename"),
        bool(payload.get("artifact_url")),
        payload.get("image_generation_status"),
        payload.get("image_generation_reason"),
    )

    threading.Thread(
        target=_post_webhook,
        args=(payload,),
        name=f"builder-events-{task_id}",
        daemon=True,
    ).start()
    return True
