"""Gateway endpoints for the builder completion notifier.

Internal webhook endpoints plus legacy router definitions:

- ``POST /internal/builder-events`` — accepts the baseline webhook from the
  LangGraph process (``deerflow.sophia.builder_events``) when a sophia_builder task
  reaches a terminal state. Hands the payload to the per-app
  ``BuilderEventsWorker``, which fans it out to webapp SSE subscribers
  and the channel ``MessageBus``.

- ``POST /internal/deck-quality-producer-failures`` — accepts only the
  authenticated, content-free fallback emitted when both DQ-1 producer object
  writes fail. It records through an independent service-role DB channel and
  never fans out to delivery consumers.

- The ``public_router`` legacy completion SSE definitions remain available
  to focused backward-compatibility tests, but the gateway app no longer
  mounts them. Browsers consume authenticated builder-canvas SSE routes.

The retired ``/internal/deck-quality-publications`` route remains mounted only
as an explicit ``410 Gone`` tombstone for rolling compatibility. DQ-1 v2 uses
immutable producer bundles discovered by the gateway reconciler instead.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from app.gateway.artifact_registry import (
    ArtifactRegistry,
    LocalArtifactRegistry,
    SyntheticArtifactPurgeReceipt,
    builder_completion_upsert_request,
)
from app.gateway.auth import require_authenticated_user
from app.gateway.voice_lab_capability import (
    assert_voice_lab_session_record,
    capability_for_gateway_action,
)
from app.gateway.workers.builder_canvas import get_builder_canvas_worker
from app.gateway.workers.builder_events import get_builder_events_worker
from app.gateway.workers.companion_wakeup import get_companion_wakeup_or_none
from deerflow.config.app_config import get_app_config
from deerflow.sophia.builder_event_auth import (
    BUILDER_EVENT_PROBE_ACK_HEADER,
    MAX_BUILDER_EVENT_BODY_BYTES,
    BuilderEventAuthenticationError,
    authenticate_builder_event,
    builder_event_canary_scope_proof,
    builder_event_probe_ack,
    encode_builder_event_body,
)
from deerflow.sophia.deck_quality.producer_failure_signal import (
    MAX_PRODUCER_FAILURE_SIGNAL_BODY_BYTES,
    ProducerFailureSignal,
    ProducerFailureSignalReceipt,
    is_producer_failure_hmac_probe,
)
from deerflow.sophia.session_store import SessionRecord, SessionStore
from deerflow.sophia.synthetic_builder import (
    SyntheticBuilderContextError,
    declares_synthetic_builder_run,
    normalize_synthetic_builder_context,
    synthetic_builder_projection,
)

logger = logging.getLogger(__name__)

_SUCCESSFUL_BUILDER_STATUSES = {"success", "completed"}
_SOPHIA_COMPANION_GRAPH_ID = "sophia_companion"
_SYNTHETIC_BUILDER_FIELDS = (
    "synthetic_test",
    "test_run_id",
    "test_principal_id",
    "scenario_id",
    "scenario_version",
    "environment",
    "cleanup_obligation_id",
    "provider_expires_at",
    "retention_hours",
    "retention_anchor",
    "retention_anchor_at",
    "retention_expires_at",
    "deployment_identity",
    "isolation_status",
    "memory_retrieval_excluded",
    "memory_learning_excluded",
    "ordinary_artifact_publication_excluded",
    "ordinary_analytics_excluded",
    "deck_quality_publication_excluded",
    "langsmith_export_excluded",
    "langsmith_trace_status",
    "langsmith_trace_unavailable_reason",
    "synthetic_builder_join",
)
_TERMINAL_TASK_OPTIONAL_FIELDS = (
    "artifact_path",
    "artifact_ext",
    "artifact_title",
    "artifact_files",
    "requested_artifact_ext",
    "artifact_id",
    "storage_provider",
    "storage_bucket",
    "storage_object_path",
    "storage_status",
    "artifact_sha256",
    "manifest_path",
    "manifest_revision",
    "deck_build_id",
    "logical_artifact_id",
    "current_artifact_version_id",
    "foundation_status",
    "artifact_is_fallback",
    "fallback_reason",
    "format_conflict_resolved",
    "format_conflict_original_target_ext",
    "image_generation_status",
    "image_generation_reason",
    "image_generation_outcome",
    "primary_image_batch_status",
    "primary_image_batch_error_class",
    "image_generation_startup_error_class",
    "image_generation_exit_code",
    "image_generation_raw_error_excerpt",
    "image_generation_startup_attempt_count",
    "serial_repair_count",
    "manifest_authoring_failure_count",
    "presentation_route",
    "deck_route",
    "deck_compile_mode",
    "native_required",
    "legacy_screenshot_debug",
    "native_editability_score",
    "native_text_shape_count",
    "picture_shape_count",
    "full_slide_picture_count",
    "native_mechanical_report",
    "mechanical_gate_results",
    "html_source_validation",
    "source_quality_report",
    "source_retention_report",
    "native_contrast_report",
    "creative_plan_path",
    "deck_quality_status",
    "failure_code",
    "deck_failure_code",
    "root_failure_code",
    "root_failure_summary",
    "expected_generated_visual_count",
    "successful_generated_visual_count",
    "referenced_visual_count",
    "missing_expected_visual_count",
    "visual_quality_gap_count",
    "iterations_used",
    "unmet_conditions",
    "brief_assumptions",
    "artifact_preview_filename",
    "quality_warning",
    "visuals_missing",
    "budget_stop_reason",
    "terminal_status",
    "terminal_reason",
    "report_contract_status",
    "report_contract_version",
    "expected_section_count",
    "found_section_count",
    "expected_body_section_count",
    "found_body_section_count",
    "missing_section_ids",
    "expected_visual_count",
    "found_visual_count",
    "missing_visual_ids",
    "minimum_word_count",
    "source_word_count",
    "cover_present",
    "toc_present",
    "conclusion_present",
    "references_present",
    "report_contract_problems",
    "first_prepare_turn",
    "prepare_call_count",
    "prepare_emitted_call_count",
    "prepare_execution_count",
    "prepare_normalized_call_count",
    "prepare_schema_failure_count",
    "prepare_parallel_call_count",
    "prepare_service_call_count",
    "prepare_service_result_count",
    "prepare_result_count",
    "prepare_retry_executed",
    "prepare_policy_result_count",
    "prepare_repair_count",
    "dangling_prepare_call_count",
    "creative_plan_accepted",
    "deck_authoring_contract",
    "authoring_contract",
    "build_event_store_status",
    "builder_trace_run_id",
    "builder_trace_root_run_id",
    "deck_authoring_elapsed_ms",
    "deck_repair_elapsed_ms",
    "deck_service_elapsed_ms",
    "terminal_cleanup_elapsed_ms",
    "presentation_preflight_status",
    "presentation_preflight_elapsed_ms",
    "deck_authoring_started_at_ms",
    "deck_authoring_budget_ms",
    "deck_authoring_remaining_ms",
    "deck_authoring_prompt_bytes",
    "deck_authoring_prompt_estimated_tokens",
    "deck_authoring_tool_schema_bytes",
    "deck_authoring_context_bytes",
    "deck_authoring_output_bytes",
    "authoring_tool_call_started",
    "prepare_force_reason",
    "last_prepare_failure_code",
    "last_prepare_failure_summary",
    "error_message",
    "builder_failure_diagnostics",
    "trace_id",
    *_SYNTHETIC_BUILDER_FIELDS,
)
_artifact_registry = ArtifactRegistry()
_session_store = SessionStore()
_PRODUCER_FAILURE_SIGNAL_STORE_ATTR = "_dq1_producer_failure_signal_store"
_PRODUCER_FAILURE_SIGNAL_READINESS_ATTR = (
    "_dq1_producer_failure_signal_readiness"
)
_PRODUCER_FAILURE_SIGNAL_RPC_TIMEOUT_SECONDS = 2.0


def install_producer_failure_signal_store(
    app: Any,
    store: Any | None,
) -> None:
    setattr(app.state, _PRODUCER_FAILURE_SIGNAL_STORE_ATTR, store)


def get_producer_failure_signal_store_or_none(app: Any) -> Any | None:
    return getattr(app.state, _PRODUCER_FAILURE_SIGNAL_STORE_ATTR, None)


def set_producer_failure_signal_readiness(
    app: Any,
    component: dict[str, object],
) -> None:
    setattr(
        app.state,
        _PRODUCER_FAILURE_SIGNAL_READINESS_ATTR,
        dict(component),
    )


def get_producer_failure_signal_readiness(
    app: Any,
) -> dict[str, object] | None:
    component = getattr(
        app.state,
        _PRODUCER_FAILURE_SIGNAL_READINESS_ATTR,
        None,
    )
    return dict(component) if isinstance(component, dict) else None


def _degrade_producer_failure_signal_transport(
    app: Any,
    *,
    reason: str,
    error_type: str | None = None,
) -> None:
    component = get_producer_failure_signal_readiness(app) or {}
    transport: dict[str, object] = {
        "status": "degraded",
        "reason": reason,
    }
    if error_type is not None:
        transport["error_type"] = error_type
    component["transport"] = transport
    component["status"] = "degraded"
    if component.get("reason") not in {
        "producer_failure_signal_unresolved",
        "producer_failure_signal_conflict",
    }:
        component["reason"] = reason
    set_producer_failure_signal_readiness(app, component)


def _parse_producer_failure_signal(
    body: bytes,
) -> ProducerFailureSignal | None:
    try:
        decoded = json.loads(body)
        if not isinstance(decoded, dict):
            return None
        signal = ProducerFailureSignal.model_validate(decoded)
        if encode_builder_event_body(signal.model_dump(mode="json")) != body:
            return None
        return signal
    except (
        BuilderEventAuthenticationError,
        json.JSONDecodeError,
        TypeError,
        ValidationError,
        ValueError,
    ):
        return None


def _is_exact_canary_failure_signal(signal: ProducerFailureSignal) -> bool:
    if is_producer_failure_hmac_probe(signal):
        return False
    try:
        deck_quality = get_app_config().deck_quality
    except Exception:
        return False
    return bool(
        deck_quality.enabled
        and deck_quality.mode == "shadow"
        and deck_quality.scope == "canary"
        and signal.campaign_id == "DQ-1"
        and signal.user_id in deck_quality.canary_user_ids
    )


def _authenticated_body_claims_exact_canary(body: bytes) -> bool:
    try:
        decoded = json.loads(body)
        if not isinstance(decoded, dict):
            return False
        user_id = decoded.get("user_id")
        campaign_id = decoded.get("campaign_id")
        deck_quality = get_app_config().deck_quality
    except Exception:
        return False
    return bool(
        isinstance(user_id, str)
        and campaign_id == "DQ-1"
        and deck_quality.enabled
        and deck_quality.mode == "shadow"
        and deck_quality.scope == "canary"
        and user_id in deck_quality.canary_user_ids
    )


async def _bounded_failure_signal_body(request: Request) -> bytes:
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            if int(declared_length) > MAX_PRODUCER_FAILURE_SIGNAL_BODY_BYTES:
                raise ValueError
        except (TypeError, ValueError, OverflowError):
            raise OverflowError from None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_PRODUCER_FAILURE_SIGNAL_BODY_BYTES:
            raise OverflowError
        chunks.append(chunk)
    return b"".join(chunks)


async def require_builder_event_service_auth(request: Request) -> None:
    """Authenticate the exact request body before any Builder mutation."""

    content_type = request.headers.get("content-type", "").split(";", 1)[0]
    if content_type.strip().casefold() != "application/json":
        raise HTTPException(status_code=415, detail="Builder event content type is invalid")
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            if int(declared_length) > MAX_BUILDER_EVENT_BODY_BYTES:
                raise HTTPException(status_code=413, detail="Builder event body is too large")
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(status_code=413, detail="Builder event body is too large") from None
    body = await request.body()
    if not body or len(body) > MAX_BUILDER_EVENT_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Builder event body is invalid")
    try:
        authenticate_builder_event(body, request.headers)
    except BuilderEventAuthenticationError as exc:
        if exc.code == "builder_event_auth_unavailable":
            raise HTTPException(
                status_code=503,
                detail="Builder event authentication is unavailable",
            ) from None
        raise HTTPException(status_code=401, detail="Builder event authentication failed") from None


def _langgraph_url() -> str:
    return (os.getenv("SOPHIA_LANGGRAPH_BASE_URL") or os.getenv("LANGGRAPH_URL") or os.getenv("SOPHIA_BACKEND_BASE_URL") or "http://127.0.0.1:2024").strip().rstrip("/")


def _durable_builder_result(payload: dict[str, Any]) -> dict[str, Any]:
    result_keys = (
        "task_id",
        "run_id",
        "trace_id",
        "agent_name",
        "status",
        "task_type",
        "task_brief",
        "artifact_path",
        "artifact_title",
        "artifact_type",
        "artifact_filename",
        "artifact_files",
        "artifact_id",
        "storage_provider",
        "storage_bucket",
        "storage_object_path",
        "storage_status",
        "manifest_path",
        "manifest_revision",
        "deck_build_id",
        "logical_artifact_id",
        "current_artifact_version_id",
        "foundation_status",
        "requested_artifact_ext",
        "artifact_ext",
        "artifact_is_fallback",
        "fallback_reason",
        "format_conflict_resolved",
        "format_conflict_original_target_ext",
        "image_generation_status",
        "image_generation_reason",
        "image_generation_outcome",
        "primary_image_batch_status",
        "primary_image_batch_error_class",
        "image_generation_startup_error_class",
        "image_generation_exit_code",
        "image_generation_raw_error_excerpt",
        "image_generation_startup_attempt_count",
        "serial_repair_count",
        "manifest_authoring_failure_count",
        "presentation_route",
        "deck_route",
        "deck_compile_mode",
        "native_required",
        "legacy_screenshot_debug",
        "native_editability_score",
        "native_text_shape_count",
        "picture_shape_count",
        "full_slide_picture_count",
        "native_mechanical_report",
        "mechanical_gate_results",
        "html_source_validation",
        "source_quality_report",
        "source_retention_report",
        "native_contrast_report",
        "creative_plan_path",
        "deck_quality_status",
        "failure_code",
        "deck_failure_code",
        "root_failure_code",
        "root_failure_summary",
        "expected_generated_visual_count",
        "successful_generated_visual_count",
        "referenced_visual_count",
        "missing_expected_visual_count",
        "visual_quality_gap_count",
        "iterations_used",
        "unmet_conditions",
        "brief_assumptions",
        "artifact_preview_filename",
        "quality_warning",
        "visuals_missing",
        "budget_stop_reason",
        "terminal_status",
        "terminal_reason",
        "report_contract_status",
        "report_contract_version",
        "expected_section_count",
        "found_section_count",
        "expected_body_section_count",
        "found_body_section_count",
        "missing_section_ids",
        "expected_visual_count",
        "found_visual_count",
        "missing_visual_ids",
        "minimum_word_count",
        "source_word_count",
        "cover_present",
        "toc_present",
        "conclusion_present",
        "references_present",
        "report_contract_problems",
        "first_prepare_turn",
        "prepare_call_count",
        "prepare_emitted_call_count",
        "prepare_execution_count",
        "prepare_normalized_call_count",
        "prepare_schema_failure_count",
        "prepare_parallel_call_count",
        "prepare_service_call_count",
        "prepare_service_result_count",
        "prepare_result_count",
        "prepare_retry_executed",
        "prepare_policy_result_count",
        "prepare_repair_count",
        "dangling_prepare_call_count",
        "creative_plan_accepted",
        "deck_authoring_contract",
        "authoring_contract",
        "build_event_store_status",
        "builder_trace_run_id",
        "builder_trace_root_run_id",
        "deck_authoring_elapsed_ms",
        "deck_repair_elapsed_ms",
        "deck_service_elapsed_ms",
        "terminal_cleanup_elapsed_ms",
        "presentation_preflight_status",
        "presentation_preflight_elapsed_ms",
        "deck_authoring_started_at_ms",
        "deck_authoring_budget_ms",
        "deck_authoring_remaining_ms",
        "deck_authoring_prompt_bytes",
        "deck_authoring_prompt_estimated_tokens",
        "deck_authoring_tool_schema_bytes",
        "deck_authoring_context_bytes",
        "deck_authoring_output_bytes",
        "authoring_tool_call_started",
        "prepare_force_reason",
        "last_prepare_failure_code",
        "last_prepare_failure_summary",
        "source_artifact_path",
        "revision_of_artifact_path",
        "summary",
        "user_next_action",
        "error_message",
        "builder_failure_diagnostics",
        "completed_at",
        "source",
        *_SYNTHETIC_BUILDER_FIELDS,
    )
    result = {key: payload.get(key) for key in result_keys if payload.get(key) is not None}
    artifact_path = payload.get("artifact_path")
    artifact_url = payload.get("artifact_url")
    if not (isinstance(artifact_path, str) and artifact_path.strip()) and isinstance(artifact_url, str) and artifact_url.strip():
        result["artifact_url"] = artifact_url
    return result


def _present_payload_fields(payload: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: payload.get(key) for key in keys if payload.get(key) is not None}


def _terminal_async_task_update(payload: dict[str, Any]) -> dict[str, Any]:
    completed_at = payload.get("completed_at") if isinstance(payload.get("completed_at"), str) else datetime.now(UTC).isoformat()
    task_id = str(payload.get("task_id") or "")
    run_id = payload.get("run_id")
    result = _durable_builder_result(payload)
    status = str(payload.get("status") or "error")
    update: dict[str, Any] = {
        "task_id": task_id,
        "agent_name": payload.get("agent_name") or "sophia_builder",
        "thread_id": task_id,
        "run_id": run_id,
        "status": status,
        "task_type": payload.get("task_type"),
        "task_brief": payload.get("task_brief"),
        "builder_result": result,
        "completed_at": completed_at,
        "last_checked_at": completed_at,
        "last_updated_at": completed_at,
        "updated_at": completed_at,
    }
    update.update(_present_payload_fields(payload, _TERMINAL_TASK_OPTIONAL_FIELDS))
    return update


def _is_synthetic_builder_payload(*sources: object) -> bool:
    return declares_synthetic_builder_run(*sources)


def _merge_terminal_async_task(
    existing: dict[str, Any] | None,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Merge a terminal update without discarding kickoff/isolation metadata."""

    merged = dict(existing or {})
    update = _terminal_async_task_update(payload)
    prior_result = merged.get("builder_result")
    terminal_result = update.get("builder_result")
    if isinstance(prior_result, dict) and isinstance(terminal_result, dict):
        update["builder_result"] = {**prior_result, **terminal_result}

    for key, value in update.items():
        if value is not None:
            merged[key] = value

    if _is_synthetic_builder_payload(existing or {}, payload):
        context = normalize_synthetic_builder_context(existing or {}, payload)
        projection = synthetic_builder_projection(context)
        merged.update(projection)
        raw_nested = (existing or {}).get("synthetic_test")
        nested = dict(raw_nested) if isinstance(raw_nested, dict) else {}
        nested.update(dict(context or {}))
        merged["synthetic_test"] = nested
        result = merged.get("builder_result")
        if isinstance(result, dict):
            result.update(projection)
            result["synthetic_test"] = dict(nested)
    return merged


def _terminal_identity(payload: dict[str, Any]) -> tuple[str, str] | None:
    parent_thread_id = payload.get("thread_id")
    task_id = payload.get("task_id")
    if not isinstance(parent_thread_id, str) or not parent_thread_id:
        return None
    if not isinstance(task_id, str) or not task_id:
        return None
    return parent_thread_id, task_id


def _is_langgraph_thread_id(value: str) -> bool:
    """Return whether a value can be sent to LangGraph's thread APIs.

    Voice sessions use stable provider-facing identifiers such as
    gemini-prod-<hex>. They are valid Sophia session IDs, but the
    LangGraph SDK only accepts UUID thread IDs.
    """
    try:
        UUID(value)
    except (AttributeError, TypeError, ValueError):
        return False
    return True


async def _resolve_existing_builder_task(
    parent_thread_id: str,
    task_id: str,
) -> dict[str, Any] | None:
    if not _is_langgraph_thread_id(parent_thread_id):
        logger.info(
            "Builder terminal run_id lookup skipped for non-LangGraph parent_thread_id=%s task_id=%s",
            str(parent_thread_id)[:12],
            str(task_id)[:12],
        )
        return None
    try:
        from langgraph_sdk import get_client

        client = get_client(url=_langgraph_url())
        state = await client.threads.get_state(parent_thread_id)
    except Exception:
        logger.warning(
            "Builder terminal run_id lookup failed parent_thread_id=%s task_id=%s",
            str(parent_thread_id)[:12],
            str(task_id)[:12],
            exc_info=True,
        )
        return None
    values = state.get("values", {}) if isinstance(state, dict) else {}
    tasks = values.get("async_tasks", {}) if isinstance(values, dict) else {}
    if not isinstance(tasks, dict):
        return None
    task = tasks.get(task_id)
    if not isinstance(task, dict):
        return None
    return dict(task)


async def _resolve_existing_builder_run_id(parent_thread_id: str, task_id: str) -> str | None:
    task = await _resolve_existing_builder_task(parent_thread_id, task_id)
    if not isinstance(task, dict):
        return None
    run_id = task.get("run_id")
    return run_id if isinstance(run_id, str) and run_id else None


async def _hydrate_missing_run_id(payload: dict[str, Any]) -> dict[str, Any]:
    identity = _terminal_identity(payload)
    if identity is None:
        return payload
    parent_thread_id, task_id = identity
    existing = await _resolve_existing_builder_task(parent_thread_id, task_id)
    if existing is None:
        return payload
    hydrated = dict(payload)
    run_id = existing.get("run_id")
    if not hydrated.get("run_id") and isinstance(run_id, str) and run_id:
        hydrated["run_id"] = run_id
        logger.info(
            "Builder terminal payload hydrated missing run_id from parent async task parent_thread_id=%s task_id=%s run_id=%s",
            str(parent_thread_id)[:12],
            str(task_id)[:12],
            str(run_id)[:12],
        )
    if _is_synthetic_builder_payload(existing, hydrated):
        context = normalize_synthetic_builder_context(existing, hydrated)
        for key, value in synthetic_builder_projection(context).items():
            hydrated.setdefault(key, value)
    return hydrated


def _should_persist_last_builder_artifact(payload: dict[str, Any]) -> bool:
    artifact_path = payload.get("artifact_path")
    artifact_url = payload.get("artifact_url")
    return (
        not _is_synthetic_builder_payload(payload)
        and str(payload.get("status") or "").lower()
        in _SUCCESSFUL_BUILDER_STATUSES
        and (
            (isinstance(artifact_path, str) and bool(artifact_path.strip()))
            or (isinstance(artifact_url, str) and bool(artifact_url.strip()))
        )
    )


async def _persist_builder_terminal_state(payload: dict[str, Any]) -> bool:
    identity = _terminal_identity(payload)
    if identity is None:
        return False
    parent_thread_id, task_id = identity

    if not _is_langgraph_thread_id(parent_thread_id):
        logger.info(
            "Builder terminal LangGraph state persistence skipped for non-LangGraph parent_thread_id=%s task_id=%s",
            str(parent_thread_id)[:12],
            str(task_id)[:12],
        )
        return True

    existing_task = await _resolve_existing_builder_task(parent_thread_id, task_id)
    task_update = _merge_terminal_async_task(existing_task, payload)
    values: dict[str, Any] = {"async_tasks": {task_id: task_update}}
    if _should_persist_last_builder_artifact(payload):
        values["last_builder_artifact"] = _durable_builder_result(payload)

    try:
        from langgraph_sdk import get_client

        client = get_client(url=_langgraph_url())
        try:
            await client.threads.update_state(parent_thread_id, values)
        except Exception as exc:
            # Threads created before the voice-continuity rollout may not have
            # a graph assignment because Gemini Live bypasses a companion run.
            # Repair only that known legacy condition, then retry once.
            if not _is_missing_thread_graph_error(exc):
                raise
            await client.threads.update(
                parent_thread_id,
                metadata={"graph_id": _SOPHIA_COMPANION_GRAPH_ID},
            )
            await client.threads.update_state(parent_thread_id, values)
            logger.info(
                "Builder terminal state persistence repaired graphless parent thread parent_thread_id=%s task_id=%s",
                str(parent_thread_id)[:12],
                str(task_id)[:12],
            )
        return True
    except Exception:
        logger.warning(
            "Builder terminal state persistence failed parent_thread_id=%s task_id=%s run_id=%s",
            str(parent_thread_id)[:12],
            str(task_id)[:12],
            str(payload.get("run_id") or "")[:12],
            exc_info=True,
        )
        return False


def _is_missing_thread_graph_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "no assigned graph id" in message or (
        "graph id" in message and "requires" in message
    )


def _upsert_builder_terminal_artifact(payload: dict[str, Any]) -> None:
    request = builder_completion_upsert_request(payload, session_store=_session_store)
    if request is None:
        return
    user_id, upsert_request = request
    _artifact_registry.upsert(upsert_request, user_id=user_id)


# ---- Request model ---------------------------------------------------------


class BuilderCompletionEvent(BaseModel):
    """Wire contract for the LangGraph-process webhook.

    Mirrors ``deerflow.sophia.builder_events.build_completion_payload_from_artifact``.
    """

    thread_id: str = Field(..., description="Parent companion thread id.")
    task_id: str = Field(..., description="Subagent / async task id.")
    run_id: str | None = Field(
        None,
        description=(
            "LangGraph run id of the terminating run. Phase 4I post-review "
            "(codex P1): plumbed through so ``_on_builder_completion`` can "
            "pass it to ``BuilderProgressRegistry.mark_done`` / ``mark_stopped`` "
            "for run-id matching — a delayed terminal from a previous run "
            "(interrupted via ``update_async_task``) must NOT close the new "
            "run's placeholder. Optional for back-compat with any in-flight "
            "payload from a pre-4I langgraph deploy."
        ),
    )
    trace_id: str | None = None
    agent_name: str | None = None
    status: str = Field(..., description="success | error | timeout | cancelled")
    task_type: str | None = None
    task_brief: str | None = None
    artifact_path: str | None = None
    artifact_url: str | None = None
    artifact_title: str | None = None
    artifact_type: str | None = None
    artifact_filename: str | None = None
    artifact_files: list[dict[str, Any]] | None = None
    artifact_id: str | None = None
    storage_provider: str | None = None
    storage_bucket: str | None = None
    storage_object_path: str | None = None
    storage_status: str | None = None
    artifact_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    manifest_path: str | None = None
    manifest_revision: int | None = None
    deck_build_id: str | None = None
    logical_artifact_id: str | None = None
    current_artifact_version_id: str | None = None
    foundation_status: str | None = None
    requested_artifact_ext: str | None = None
    artifact_ext: str | None = None
    artifact_is_fallback: bool | None = None
    fallback_reason: str | None = None
    format_conflict_resolved: str | None = Field(
        None,
        description="Correction wave 2026-06-12: 'user_intent' when the emit-time guard honored the user's explicit current-turn format over a misderived dispatch target.",
    )
    format_conflict_original_target_ext: str | None = None
    image_generation_status: str | None = None
    image_generation_reason: str | None = None
    primary_image_batch_status: str | None = None
    primary_image_batch_error_class: str | None = None
    image_generation_startup_error_class: str | None = None
    image_generation_exit_code: int | None = None
    image_generation_raw_error_excerpt: str | None = None
    image_generation_startup_attempt_count: int | None = None
    serial_repair_count: int | None = None
    manifest_authoring_failure_count: int | None = None
    presentation_route: str | None = None
    deck_route: str | None = None
    deck_compile_mode: str | None = None
    native_required: bool | None = None
    legacy_screenshot_debug: bool | None = None
    native_editability_score: float | None = None
    native_text_shape_count: int | None = None
    picture_shape_count: int | None = None
    full_slide_picture_count: int | None = None
    native_mechanical_report: dict[str, Any] | None = None
    mechanical_gate_results: dict[str, Any] | None = None
    html_source_validation: dict[str, Any] | None = None
    source_quality_report: dict[str, Any] | None = None
    creative_plan_path: str | None = None
    deck_quality_status: str | None = None
    failure_code: str | None = None
    deck_failure_code: str | None = None
    expected_generated_visual_count: int | None = None
    successful_generated_visual_count: int | None = None
    referenced_visual_count: int | None = None
    missing_expected_visual_count: int | None = None
    visual_quality_gap_count: int | None = None
    image_generation_outcome: dict[str, Any] | None = Field(
        None,
        description="VQ-3 harness-stamped enrichment outcome: {attempted: int, succeeded: int, skip_reason?: str}.",
    )
    iterations_used: int | None = None
    unmet_conditions: list[str] | None = None
    brief_assumptions: list[str] | None = Field(
        None,
        description="Spec D D-5: assumptions the builder stated for brief fields not present in the parent conversation — relayed by the companion, never presented as something the user said.",
    )
    artifact_preview_filename: str | None = Field(
        None,
        description="Canvas preview sibling (e.g. <deck>.preview.pdf rendered from a .pptx) so the webapp can render binary formats through the PDF canvas.",
    )
    quality_warning: str | None = Field(
        None,
        description="Honest quality note on a delivered primary (e.g. visuals_not_embedded) — never a fallback flag.",
    )
    visuals_missing: bool | None = None
    budget_stop_reason: str | None = None
    terminal_status: str | None = Field(
        None,
        description="Internal builder status: completed | failed | timed_out.",
    )
    terminal_reason: str | None = None
    report_contract_status: str | None = None
    report_contract_version: str | None = None
    expected_section_count: int | None = None
    found_section_count: int | None = None
    expected_body_section_count: int | None = None
    found_body_section_count: int | None = None
    missing_section_ids: list[str] | None = None
    expected_visual_count: int | None = None
    found_visual_count: int | None = None
    missing_visual_ids: list[str] | None = None
    minimum_word_count: int | None = None
    source_word_count: int | None = None
    cover_present: bool | None = None
    toc_present: bool | None = None
    conclusion_present: bool | None = None
    references_present: bool | None = None
    report_contract_problems: list[str] | None = None
    first_prepare_turn: int | None = None
    prepare_call_count: int | None = None
    prepare_emitted_call_count: int | None = None
    prepare_execution_count: int | None = None
    prepare_normalized_call_count: int | None = None
    prepare_schema_failure_count: int | None = None
    prepare_parallel_call_count: int | None = None
    prepare_service_call_count: int | None = None
    prepare_service_result_count: int | None = None
    prepare_result_count: int | None = None
    prepare_retry_executed: bool | None = None
    prepare_policy_result_count: int | None = None
    prepare_repair_count: int | None = None
    dangling_prepare_call_count: int | None = None
    creative_plan_accepted: bool | None = None
    deck_authoring_contract: str | None = None
    authoring_contract: str | None = None
    build_event_store_status: str | None = None
    builder_trace_run_id: str | None = None
    builder_trace_root_run_id: str | None = None
    deck_authoring_elapsed_ms: int | None = None
    deck_repair_elapsed_ms: int | None = None
    deck_service_elapsed_ms: int | None = None
    terminal_cleanup_elapsed_ms: int | None = None
    presentation_preflight_status: str | None = None
    presentation_preflight_elapsed_ms: int | None = None
    deck_authoring_started_at_ms: int | None = None
    deck_authoring_budget_ms: int | None = None
    deck_authoring_remaining_ms: int | None = None
    deck_authoring_prompt_bytes: int | None = None
    deck_authoring_prompt_estimated_tokens: int | None = None
    deck_authoring_tool_schema_bytes: int | None = None
    deck_authoring_context_bytes: int | None = None
    deck_authoring_output_bytes: int | None = None
    authoring_tool_call_started: bool | None = None
    prepare_force_reason: str | None = None
    last_prepare_failure_code: str | None = None
    last_prepare_failure_summary: str | None = None
    source_retention_report: dict[str, Any] | None = None
    native_contrast_report: dict[str, Any] | None = None
    root_failure_code: str | None = None
    root_failure_summary: str | None = None
    source_artifact_path: str | None = None
    revision_of_artifact_path: str | None = None
    summary: str | None = None
    user_next_action: str | None = None
    error_message: str | None = None
    builder_failure_diagnostics: dict[str, Any] | None = None
    completed_at: str | None = None
    source: str | None = Field(None, description="Origin: subagent_executor | async_subagent_monitor")
    user_id: str | None = Field(
        None,
        description="Originating user id, used by the companion wakeup worker to construct a properly-attributed synthetic turn.",
    )
    synthetic_test: bool = False
    test_run_id: str | None = None
    test_principal_id: str | None = None
    scenario_id: str | None = None
    scenario_version: str | None = None
    environment: str | None = None
    cleanup_obligation_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    retention_hours: int | None = Field(default=None, ge=1, le=168)
    retention_anchor: Literal["builder_task_created_at_provisional"] | None = None
    retention_anchor_at: str | None = None
    retention_expires_at: str | None = None
    provider_expires_at: str | None = None
    deployment_identity: dict[str, str] | None = None
    isolation_status: str | None = None
    memory_retrieval_excluded: bool | None = None
    memory_learning_excluded: bool | None = None
    ordinary_artifact_publication_excluded: bool | None = None
    ordinary_analytics_excluded: bool | None = None
    deck_quality_publication_excluded: bool | None = None
    langsmith_export_excluded: bool | None = None
    langsmith_trace_status: Literal["trace_unavailable"] | None = None
    langsmith_trace_unavailable_reason: Literal["synthetic_isolation_policy"] | None = None
    synthetic_builder_join: dict[str, Any] | None = None
    deck_quality_publication_intent: dict[str, Any] | None = Field(
        default=None,
        description="Content-free DQ-1 canary publication ticket; stripped before user/channel fan-out.",
    )


class BuilderProgressEvent(BaseModel):
    """Wire contract for the LangGraph-side ``BuilderProgressMiddleware`` webhook.

    Phase 4H (webhook relay): replaces the ``runs.join_stream`` HTTP
    subscriber path that doesn't work cross-process against
    ``langgraph dev``'s in-mem runtime. The middleware POSTs one
    payload per phase transition (or per AI message with tool_calls);
    the endpoint dispatches it through the per-task ``ProgressRenderer``
    and calls the channel's edit callback to update the placeholder.

    ``event_name`` matches the renderer's ``apply`` API:
    - ``"custom"`` with ``data={"name": "phase", "phase": "<phase>"}``
      for lifecycle transitions (starting / researching / drafting /
      finalizing / done).
    - ``"updates"`` with ``data={"agent": {"messages": [{"tool_calls": [...]}]}}``
      for tool-call activity lines (🔍 / 🔗 / 📝 / 📦).
    - ``"messages"`` / ``"messages-tuple"`` reserved for future per-
      token streaming if we move to a runtime that supports it.
    """

    task_id: str = Field(..., description="Builder thread_id / subagent task id.")
    run_id: str = Field(..., description="LangGraph run id (for diagnostics).")
    parent_thread_id: str | None = Field(None, description="Parent companion thread id used for authenticated web fan-out.")
    sequence: int | None = Field(None, ge=1, description="Monotonic sequence within this builder run.")
    occurred_at: str | None = Field(None, description="ISO timestamp assigned by the producer.")
    event_name: str = Field(..., description="messages | updates | custom")
    data: Any | None = Field(default=None, description="Mode-specific payload — see class docstring.")
    synthetic_test: bool = False
    test_run_id: str | None = None
    test_principal_id: str | None = None
    scenario_id: str | None = None
    scenario_version: str | None = None
    environment: str | None = None
    cleanup_obligation_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    retention_hours: int | None = Field(default=None, ge=1, le=168)
    retention_anchor: Literal["builder_task_created_at_provisional"] | None = None
    retention_anchor_at: str | None = None
    retention_expires_at: str | None = None
    provider_expires_at: str | None = None
    deployment_identity: dict[str, str] | None = None
    isolation_status: str | None = None
    memory_retrieval_excluded: bool | None = None
    memory_learning_excluded: bool | None = None
    ordinary_artifact_publication_excluded: bool | None = None
    ordinary_analytics_excluded: bool | None = None
    deck_quality_publication_excluded: bool | None = None
    langsmith_export_excluded: bool | None = None
    langsmith_trace_status: Literal["trace_unavailable"] | None = None
    langsmith_trace_unavailable_reason: Literal["synthetic_isolation_policy"] | None = None
    synthetic_builder_join: dict[str, Any] | None = None


class SyntheticBuilderCleanupTask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1, max_length=512)
    run_id: str | None = Field(default=None, min_length=1, max_length=512)


class SyntheticBuilderCleanupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    test_principal_id: str = Field(min_length=1, max_length=512)
    test_run_id: str = Field(min_length=1, max_length=512)
    cleanup_obligation_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    tasks: list[SyntheticBuilderCleanupTask] = Field(
        default_factory=list,
        max_length=64,
    )


class SyntheticBuilderCleanupIssue(BaseModel):
    kind: Literal["builder_task", "builder_run"]
    identifier_hash: str = Field(pattern=r"^[0-9a-f]{32}$")
    code: str


class SyntheticBuilderCleanupReceipt(BaseModel):
    test_principal_id: str
    test_run_id: str
    discovery_complete: bool
    authoritative_zero_tasks: bool
    discovered_task_count: int = Field(ge=0)
    task_threads_matched: int = Field(ge=0)
    task_threads_deleted: int = Field(ge=0)
    task_threads_missing: int = Field(ge=0)
    runs_cancelled: int = Field(ge=0)
    artifacts: SyntheticArtifactPurgeReceipt
    cleanup_complete: bool
    unresolved: list[SyntheticBuilderCleanupIssue] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_authoritative_success_proof(self) -> SyntheticBuilderCleanupReceipt:
        if self.cleanup_complete and not (
            self.discovery_complete
            and self.authoritative_zero_tasks
            and self.artifacts.cleanup_complete
            and not self.unresolved
        ):
            raise ValueError(
                "synthetic Builder cleanup success requires authoritative zero proof"
            )
        return self


def _cleanup_identifier(kind: str, value: str) -> str:
    import hashlib

    return hashlib.sha256(f"{kind}\0{value}".encode()).hexdigest()[:32]


def _cleanup_issue(
    *,
    kind: Literal["builder_task", "builder_run"],
    identifier: str,
    code: str,
) -> SyntheticBuilderCleanupIssue:
    return SyntheticBuilderCleanupIssue(
        kind=kind,
        identifier_hash=_cleanup_identifier(kind, identifier),
        code=code,
    )


def _is_not_found_error(exc: Exception) -> bool:
    try:
        from langgraph_sdk.errors import NotFoundError

        if isinstance(exc, NotFoundError):
            return True
    except ImportError:
        pass
    message = str(exc).casefold()
    return "not found" in message or "404" in message


def _thread_metadata(thread: object) -> dict[str, Any]:
    if not isinstance(thread, dict):
        return {}
    metadata = thread.get("metadata")
    return dict(metadata) if isinstance(metadata, dict) else {}


async def _discover_synthetic_builder_tasks(
    client: Any,
    *,
    test_principal_id: str | None,
    test_run_id: str | None,
    cleanup_obligation_id: str,
    unresolved: list[SyntheticBuilderCleanupIssue],
) -> tuple[dict[str, str | None], bool]:
    """Authoritatively page the exact LangGraph task-thread metadata query."""

    page_size = 100
    max_pages = 10
    discovered: dict[str, str | None] = {}
    for page in range(max_pages):
        try:
            result = await client.threads.search(
                metadata={
                    "synthetic": True,
                    "cleanup_obligation_id": cleanup_obligation_id,
                },
                limit=page_size,
                offset=page * page_size,
            )
        except Exception:  # noqa: BLE001 - typed proof failure only.
            unresolved.append(
                _cleanup_issue(
                    kind="builder_task",
                    identifier=cleanup_obligation_id,
                    code="task_discovery_unavailable",
                )
            )
            return discovered, False
        if not isinstance(result, list):
            unresolved.append(
                _cleanup_issue(
                    kind="builder_task",
                    identifier=cleanup_obligation_id,
                    code="task_discovery_protocol_invalid",
                )
            )
            return discovered, False
        for thread in result:
            if not isinstance(thread, dict):
                unresolved.append(
                    _cleanup_issue(
                        kind="builder_task",
                        identifier=cleanup_obligation_id,
                        code="task_discovery_protocol_invalid",
                    )
                )
                return discovered, False
            task_id = thread.get("thread_id")
            if not isinstance(task_id, str) or not task_id:
                unresolved.append(
                    _cleanup_issue(
                        kind="builder_task",
                        identifier=cleanup_obligation_id,
                        code="task_discovery_protocol_invalid",
                    )
                )
                return discovered, False
            metadata = _thread_metadata(thread)
            try:
                context = normalize_synthetic_builder_context(
                    metadata,
                    require_complete=False,
                )
            except SyntheticBuilderContextError:
                context = None
            if (
                context is None
                or context.get("cleanup_obligation_id")
                != cleanup_obligation_id
                or (
                    test_principal_id is not None
                    and context.get("test_principal_id") != test_principal_id
                )
                or (
                    test_run_id is not None
                    and context.get("test_run_id") != test_run_id
                )
            ):
                unresolved.append(
                    _cleanup_issue(
                        kind="builder_task",
                        identifier=task_id,
                        code="task_identity_mismatch",
                    )
                )
                return discovered, False
            discovered[task_id] = None
        if len(result) < page_size:
            break
    else:
        unresolved.append(
            _cleanup_issue(
                kind="builder_task",
                identifier=cleanup_obligation_id,
                code="task_discovery_truncated",
            )
        )
        return discovered, False
    return discovered, True


async def _cancel_active_synthetic_runs(
    client: Any,
    *,
    task_id: str,
    explicit_run_id: str | None,
    unresolved: list[SyntheticBuilderCleanupIssue],
) -> tuple[int, bool]:
    try:
        listed = await client.runs.list(task_id, limit=100)
    except Exception as exc:  # noqa: BLE001 - typed retry receipt below.
        if _is_not_found_error(exc):
            return 0, True
        unresolved.append(
            _cleanup_issue(
                kind="builder_task",
                identifier=task_id,
                code="run_query_unavailable",
            )
        )
        return 0, False
    runs = listed if isinstance(listed, list) else []
    if len(runs) >= 100:
        unresolved.append(
            _cleanup_issue(
                kind="builder_task",
                identifier=task_id,
                code="run_query_truncated",
            )
        )
        return 0, False

    by_id = {
        str(run.get("run_id")): run
        for run in runs
        if isinstance(run, dict) and run.get("run_id")
    }
    if explicit_run_id and explicit_run_id not in by_id:
        try:
            run = await client.runs.get(task_id, explicit_run_id)
        except Exception as exc:  # noqa: BLE001 - absent is already clean.
            if not _is_not_found_error(exc):
                unresolved.append(
                    _cleanup_issue(
                        kind="builder_run",
                        identifier=explicit_run_id,
                        code="run_status_unavailable",
                    )
                )
                return 0, False
        else:
            if isinstance(run, dict):
                by_id[explicit_run_id] = run

    cancelled = 0
    for run_id, run in by_id.items():
        run_status = str(run.get("status") or "").casefold()
        if run_status not in {"pending", "running"}:
            continue
        try:
            await client.runs.cancel(
                task_id,
                run_id,
                wait=True,
                action="interrupt",
            )
            cancelled += 1
        except Exception as exc:  # noqa: BLE001 - check a terminal race once.
            try:
                refreshed = await client.runs.get(task_id, run_id)
            except Exception as refresh_exc:  # noqa: BLE001
                if _is_not_found_error(refresh_exc):
                    continue
                unresolved.append(
                    _cleanup_issue(
                        kind="builder_run",
                        identifier=run_id,
                        code="run_cancel_unconfirmed",
                    )
                )
                return cancelled, False
            refreshed_status = (
                str(refreshed.get("status") or "").casefold()
                if isinstance(refreshed, dict)
                else ""
            )
            if refreshed_status in {"pending", "running"}:
                logger.warning(
                    "Synthetic Builder cancellation unconfirmed run_hash=%s error_type=%s",
                    _cleanup_identifier("builder_run", run_id),
                    type(exc).__name__,
                )
                unresolved.append(
                    _cleanup_issue(
                        kind="builder_run",
                        identifier=run_id,
                        code="run_cancel_unconfirmed",
                    )
                )
                return cancelled, False
    return cancelled, True


async def cleanup_synthetic_builder_run(
    cleanup: SyntheticBuilderCleanupRequest,
    *,
    artifact_registry: LocalArtifactRegistry | None = None,
    langgraph_client: Any | None = None,
    purge_artifacts: bool = True,
) -> SyntheticBuilderCleanupReceipt:
    """Cancel/delete exact synthetic Builder tasks and their artifact records.

    This callable is shared by the authenticated recovery endpoint and the
    HMAC-protected independent reaper route. All deletes are identity-checked,
    idempotent, and leave hashed typed retry evidence on partial failure.
    """

    registry = artifact_registry or _artifact_registry
    artifact_records = registry.synthetic_cleanup_obligation_records(
        cleanup_obligation_id=cleanup.cleanup_obligation_id,
    )
    run_artifact_records = registry.synthetic_run_records(
        user_id=cleanup.test_principal_id,
        test_run_id=cleanup.test_run_id,
    )
    if any(
        record.user_id != cleanup.test_principal_id
        or record.test_principal_id != cleanup.test_principal_id
        or record.test_run_id != cleanup.test_run_id
        or record.cleanup_obligation_id != cleanup.cleanup_obligation_id
        for record in artifact_records
    ) or {record.artifact_id for record in artifact_records} != {
        record.artifact_id for record in run_artifact_records
    }:
        raise RuntimeError("synthetic Builder cleanup obligation binding conflict")
    targets = {task.task_id: task.run_id for task in cleanup.tasks}
    for record in artifact_records:
        task_id = record.task_id
        if isinstance(task_id, str) and task_id:
            targets.setdefault(task_id, record.run_id)

    if langgraph_client is None:
        from langgraph_sdk import get_client

        langgraph_client = get_client(url=_langgraph_url())

    deleted = 0
    missing = 0
    cancelled = 0
    unresolved: list[SyntheticBuilderCleanupIssue] = []
    discovered, initial_discovery_complete = await _discover_synthetic_builder_tasks(
        langgraph_client,
        test_principal_id=cleanup.test_principal_id,
        test_run_id=cleanup.test_run_id,
        cleanup_obligation_id=cleanup.cleanup_obligation_id,
        unresolved=unresolved,
    )
    for task_id, run_id in discovered.items():
        targets.setdefault(task_id, run_id)
    discovered_task_ids = set(discovered)
    for task_id, explicit_run_id in targets.items():
        try:
            thread = await langgraph_client.threads.get(task_id)
        except Exception as exc:  # noqa: BLE001 - absent is idempotent success.
            if _is_not_found_error(exc):
                missing += 1
                continue
            unresolved.append(
                _cleanup_issue(
                    kind="builder_task",
                    identifier=task_id,
                    code="task_identity_unavailable",
                )
            )
            continue

        try:
            # Cleanup must remain able to remove a fail-closed admission that
            # carried the exact run/principal index but never reached the
            # complete Builder context (for example a crash between thread
            # creation and run admission). Exact deletion identity is the
            # principal+test_run pair; missing scenario/retention fields must
            # not turn that bounded orphan into an undeletable resource.
            context = normalize_synthetic_builder_context(
                _thread_metadata(thread),
                require_complete=False,
            )
        except SyntheticBuilderContextError:
            context = None
        if (
            context is None
            or context.get("test_run_id") != cleanup.test_run_id
            or context.get("test_principal_id") != cleanup.test_principal_id
            or context.get("cleanup_obligation_id")
            != cleanup.cleanup_obligation_id
        ):
            unresolved.append(
                _cleanup_issue(
                    kind="builder_task",
                    identifier=task_id,
                    code="task_identity_mismatch",
                )
            )
            continue

        run_count, runs_clean = await _cancel_active_synthetic_runs(
            langgraph_client,
            task_id=task_id,
            explicit_run_id=explicit_run_id,
            unresolved=unresolved,
        )
        cancelled += run_count
        if not runs_clean:
            continue
        try:
            await langgraph_client.threads.delete(task_id)
        except Exception as exc:  # noqa: BLE001 - verify response-loss races.
            if not _is_not_found_error(exc):
                try:
                    await langgraph_client.threads.get(task_id)
                except Exception as verify_exc:  # noqa: BLE001
                    if _is_not_found_error(verify_exc):
                        deleted += 1
                        continue
                unresolved.append(
                    _cleanup_issue(
                        kind="builder_task",
                        identifier=task_id,
                        code="task_delete_unconfirmed",
                    )
                )
                continue
        try:
            await langgraph_client.threads.get(task_id)
        except Exception as exc:  # noqa: BLE001 - expected not-found proof.
            if _is_not_found_error(exc):
                deleted += 1
                continue
        unresolved.append(
            _cleanup_issue(
                kind="builder_task",
                identifier=task_id,
                code="task_still_present",
            )
        )

    verification: dict[str, str | None] = {}
    verification_complete = False
    if initial_discovery_complete and not unresolved:
        verification, verification_complete = await _discover_synthetic_builder_tasks(
            langgraph_client,
            test_principal_id=cleanup.test_principal_id,
            test_run_id=cleanup.test_run_id,
            cleanup_obligation_id=cleanup.cleanup_obligation_id,
            unresolved=unresolved,
        )
        for task_id in verification:
            unresolved.append(
                _cleanup_issue(
                    kind="builder_task",
                    identifier=task_id,
                    code="task_discovered_after_cleanup",
                )
            )
    discovery_complete = initial_discovery_complete and verification_complete
    authoritative_zero_tasks = discovery_complete and not verification
    tasks_complete = authoritative_zero_tasks and not unresolved
    if tasks_complete and purge_artifacts:
        artifact_receipt = registry.purge_synthetic_run(
            user_id=cleanup.test_principal_id,
            test_run_id=cleanup.test_run_id,
        )
    elif tasks_complete and not artifact_records:
        artifact_receipt = SyntheticArtifactPurgeReceipt(
            test_run_id=cleanup.test_run_id,
            test_principal_id=cleanup.test_principal_id,
            matched_artifact_count=0,
            artifact_records_deleted=0,
            artifact_objects_deleted=0,
            artifact_objects_missing=0,
            artifact_objects_not_applicable=0,
            remaining_artifact_count=0,
            cleanup_complete=True,
            unresolved=[],
        )
    else:
        artifact_receipt = SyntheticArtifactPurgeReceipt(
            test_run_id=cleanup.test_run_id,
            test_principal_id=cleanup.test_principal_id,
            matched_artifact_count=len(artifact_records),
            artifact_records_deleted=0,
            artifact_objects_deleted=0,
            artifact_objects_missing=0,
            artifact_objects_not_applicable=0,
            remaining_artifact_count=len(artifact_records),
            cleanup_complete=False,
            unresolved=[],
        )
    return SyntheticBuilderCleanupReceipt(
        test_principal_id=cleanup.test_principal_id,
        test_run_id=cleanup.test_run_id,
        discovery_complete=discovery_complete,
        authoritative_zero_tasks=authoritative_zero_tasks,
        discovered_task_count=len(discovered_task_ids),
        task_threads_matched=len(targets),
        task_threads_deleted=deleted,
        task_threads_missing=missing,
        runs_cancelled=cancelled,
        artifacts=artifact_receipt,
        cleanup_complete=(
            tasks_complete
            and artifact_receipt.cleanup_complete
            and authoritative_zero_tasks
        ),
        unresolved=unresolved,
    )


async def cleanup_synthetic_builder_obligation(
    cleanup_obligation_id: str,
    *,
    artifact_registry: LocalArtifactRegistry | None = None,
    langgraph_client: Any | None = None,
    purge_artifacts: bool = True,
) -> dict[str, object]:
    """Delete/read-zero Builder resources using only the opaque obligation id.

    This is the post-retention recovery authority.  It deliberately derives
    the former principal/run binding from the indexed Builder resources
    themselves, so a PREPARED cleanup remains actionable after the canonical
    session and finalization (the last raw-identity discovery sources) have
    already been erased.  The returned receipt is content-free.
    """

    try:
        parsed_cleanup_id = UUID(cleanup_obligation_id)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("cleanup obligation id must be a canonical UUIDv4") from exc
    if parsed_cleanup_id.version != 4 or str(parsed_cleanup_id) != cleanup_obligation_id:
        raise ValueError("cleanup obligation id must be a canonical UUIDv4")

    registry = artifact_registry or _artifact_registry
    if langgraph_client is None:
        from langgraph_sdk import get_client

        langgraph_client = get_client(url=_langgraph_url())

    unresolved: list[SyntheticBuilderCleanupIssue] = []
    discovered, discovery_complete = await _discover_synthetic_builder_tasks(
        langgraph_client,
        test_principal_id=None,
        test_run_id=None,
        cleanup_obligation_id=cleanup_obligation_id,
        unresolved=unresolved,
    )
    artifact_records = registry.synthetic_cleanup_obligation_records(
        cleanup_obligation_id=cleanup_obligation_id,
    )
    identities: set[tuple[str, str]] = {
        (record.test_principal_id or "", record.test_run_id or "")
        for record in artifact_records
    }
    for task_id in discovered:
        try:
            thread = await langgraph_client.threads.get(task_id)
        except Exception as exc:  # noqa: BLE001 - typed retry receipt below.
            if _is_not_found_error(exc):
                continue
            unresolved.append(
                _cleanup_issue(
                    kind="builder_task",
                    identifier=task_id,
                    code="task_identity_unavailable",
                )
            )
            continue
        try:
            context = normalize_synthetic_builder_context(
                _thread_metadata(thread),
                require_complete=False,
            )
        except SyntheticBuilderContextError:
            context = None
        principal_id = (
            context.get("test_principal_id") if isinstance(context, dict) else None
        )
        test_run_id = context.get("test_run_id") if isinstance(context, dict) else None
        if (
            context is None
            or context.get("cleanup_obligation_id") != cleanup_obligation_id
            or not isinstance(principal_id, str)
            or not principal_id
            or not isinstance(test_run_id, str)
            or not test_run_id
        ):
            unresolved.append(
                _cleanup_issue(
                    kind="builder_task",
                    identifier=task_id,
                    code="task_identity_mismatch",
                )
            )
            continue
        identities.add((principal_id, test_run_id))

    identities.discard(("", ""))
    binding_conflict = len(identities) > 1 or any(
        not principal or not run_id for principal, run_id in identities
    )
    if (
        not discovery_complete
        or unresolved
        or binding_conflict
    ):
        return {
            "cleanup_complete": False,
            "discovery_complete": discovery_complete,
            "authoritative_zero_tasks": False,
            "artifacts_cleanup_complete": False,
            "binding_conflict": binding_conflict,
            "unresolved_count": len(unresolved),
            "raw_identity_excluded": True,
        }

    if not identities:
        # The exact lookup was already empty in both durable Builder planes.
        return {
            "cleanup_complete": not artifact_records and not discovered,
            "discovery_complete": True,
            "authoritative_zero_tasks": not discovered,
            "artifacts_cleanup_complete": not artifact_records,
            "binding_conflict": False,
            "unresolved_count": 0,
            "raw_identity_excluded": True,
        }

    principal_id, test_run_id = next(iter(identities))
    # A principal/run may never be rebound to another opaque obligation.  The
    # SQL trigger rejects this for durable artifacts; this read check also
    # protects local/dev stores and rolling deployments.
    run_artifacts = registry.synthetic_run_records(
        user_id=principal_id,
        test_run_id=test_run_id,
    )
    if any(
        record.cleanup_obligation_id != cleanup_obligation_id
        for record in run_artifacts
    ):
        return {
            "cleanup_complete": False,
            "discovery_complete": True,
            "authoritative_zero_tasks": False,
            "artifacts_cleanup_complete": False,
            "binding_conflict": True,
            "unresolved_count": 0,
            "raw_identity_excluded": True,
        }
    receipt = await cleanup_synthetic_builder_run(
        SyntheticBuilderCleanupRequest(
            test_principal_id=principal_id,
            test_run_id=test_run_id,
            cleanup_obligation_id=cleanup_obligation_id,
            tasks=[
                SyntheticBuilderCleanupTask(task_id=task_id)
                for task_id in discovered
            ],
        ),
        artifact_registry=registry,
        langgraph_client=langgraph_client,
        purge_artifacts=purge_artifacts,
    )
    return {
        "cleanup_complete": bool(receipt.cleanup_complete),
        "discovery_complete": bool(receipt.discovery_complete),
        "authoritative_zero_tasks": bool(receipt.authoritative_zero_tasks),
        "artifacts_cleanup_complete": bool(receipt.artifacts.cleanup_complete),
        "binding_conflict": False,
        "unresolved_count": len(receipt.unresolved),
        "raw_identity_excluded": True,
    }


def _exact_utc_millis(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    canonical = (
        parsed.astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    return parsed.astimezone(UTC) if canonical == value else None


async def reap_expired_synthetic_builder_obligations(
    *,
    now: datetime,
    limit: int,
    artifact_registry: LocalArtifactRegistry | None = None,
    langgraph_client: Any | None = None,
) -> dict[str, object]:
    """Globally reap expired Builder threads without a PREPARED raw handle.

    The scan is keyed only by the product-authored synthetic marker, then
    groups exact canonical cleanup UUIDs in memory. It is the independent
    retry authority after a bounded PREPARED handle has been erased during a
    LangGraph outage. Returned telemetry contains counts only.
    """

    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("synthetic Builder reaper limit must be between 1 and 100")
    observed_at = now.astimezone(UTC)
    if langgraph_client is None:
        from langgraph_sdk import get_client

        langgraph_client = get_client(url=_langgraph_url())

    page_size = 100
    max_pages = 100
    malformed = 0
    due: dict[str, tuple[datetime, datetime]] = {}
    discovery_complete = False
    for page in range(max_pages):
        result = await langgraph_client.threads.search(
            metadata={"synthetic": True},
            limit=page_size,
            offset=page * page_size,
        )
        if not isinstance(result, list):
            raise RuntimeError("synthetic Builder global scan protocol invalid")
        for thread in result:
            metadata = _thread_metadata(thread)
            cleanup_id = metadata.get("cleanup_obligation_id")
            expiry = _exact_utc_millis(metadata.get("retention_expires_at"))
            provider_expiry = _exact_utc_millis(
                metadata.get("provider_expires_at")
            )
            try:
                parsed_id = UUID(str(cleanup_id))
            except (TypeError, ValueError):
                parsed_id = None
            if (
                metadata.get("synthetic") is not True
                or parsed_id is None
                or parsed_id.version != 4
                or str(parsed_id) != cleanup_id
                or expiry is None
                or provider_expiry is None
                or provider_expiry > expiry
            ):
                malformed += 1
                continue
            if expiry <= observed_at:
                prior = due.get(cleanup_id)
                candidate = (expiry, provider_expiry)
                if prior is not None and prior[1] != provider_expiry:
                    malformed += 1
                    due.pop(cleanup_id, None)
                    continue
                due[cleanup_id] = candidate if prior is None else min(prior, candidate)
        if len(result) < page_size:
            discovery_complete = True
            break

    ordered = sorted(due, key=lambda cleanup_id: (due[cleanup_id][0], cleanup_id))
    if len(ordered) > limit:
        page_count = (len(ordered) + limit - 1) // limit
        page_index = (int(observed_at.timestamp()) // 60) % page_count
        selected = ordered[page_index * limit : (page_index + 1) * limit]
    else:
        selected = ordered

    completed = 0
    pending = 0
    completed_handles: list[tuple[str, str]] = []
    for cleanup_id in selected:
        try:
            from app.gateway.routers import voice_lab_recovery
            from deerflow.sophia.cleanup_fence import (
                close_cleanup_obligation_if_retention_due,
            )

            cleanup_fence = await asyncio.to_thread(
                close_cleanup_obligation_if_retention_due,
                cleanup_id,
                due[cleanup_id][0],
                due[cleanup_id][1],
            )
            if cleanup_fence is None:
                pending += 1
                continue

            cleanup_handle_path = (
                voice_lab_recovery._ensure_retention_cleanup_handle_for_id(
                    cleanup_id,
                    retention_expires_at=(
                        due[cleanup_id][0]
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    ),
                    provider_expires_at=(
                        due[cleanup_id][1]
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    ),
                    cleanup_mode="builder_global",
                )
            )
            if cleanup_fence.active_admissions or cleanup_fence.expired_admissions:
                pending += 1
                continue
            receipt = await cleanup_synthetic_builder_obligation(
                cleanup_id,
                artifact_registry=artifact_registry,
                langgraph_client=langgraph_client,
                purge_artifacts=True,
            )
        except Exception:  # noqa: BLE001 - retry from the global thread index.
            pending += 1
            continue
        if receipt.get("cleanup_complete") is True:
            completed += 1
            completed_handles.append((cleanup_id, cleanup_handle_path))
        else:
            pending += 1
    return {
        "discovery_complete": discovery_complete,
        "discovered": len(selected),
        "completed": completed,
        "pending": pending,
        "malformed": malformed,
        "truncated": not discovery_complete,
        "raw_identity_excluded": True,
        # Private in-process handoff only. The caller consumes this immediately
        # to emit COMPLETE under the durable global-zero barrier; it is never
        # logged, persisted, or projected into readiness telemetry.
        "_completed_cleanup_handles": completed_handles,
    }


# ---- Routers ---------------------------------------------------------------


internal_router = APIRouter(prefix="/internal", tags=["builder-events"])
public_router = APIRouter(prefix="/api/threads", tags=["builder-events"])


def _normalized_builder_event_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if not _is_synthetic_builder_payload(payload):
        if any(
            payload.get(key) is not None
            for key in _SYNTHETIC_BUILDER_FIELDS
            if key != "synthetic_test"
        ):
            raise HTTPException(
                status_code=422,
                detail="Synthetic Builder metadata requires synthetic_test=true",
            )
        ordinary = dict(payload)
        for key in _SYNTHETIC_BUILDER_FIELDS:
            ordinary.pop(key, None)
        return ordinary
    try:
        context = normalize_synthetic_builder_context(payload)
    except SyntheticBuilderContextError as exc:
        raise HTTPException(
            status_code=422,
            detail="Synthetic Builder isolation metadata is incomplete",
        ) from exc
    return {**payload, **synthetic_builder_projection(context)}


def _require_builder_event_thread_owner(
    authenticated_user_id: str,
    thread_id: str,
) -> SessionRecord:
    record = _session_store.find_session_by_thread_id(
        authenticated_user_id,
        thread_id,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    return record


def _require_synthetic_builder_event_capability(
    request: Request,
    authenticated_user_id: str,
    record: SessionRecord,
) -> None:
    """Bind synthetic event egress to the canonical Voice Lab run.

    Ordinary sessions retain the normal exact-owner boundary. A canonical
    synthetic session additionally requires the short-lived capability before
    the event worker or its cache is touched, and the shared verifier checks
    principal, run, scenario, environment, and deployment identity.
    """

    metadata = getattr(record, "metadata", None)
    if not isinstance(metadata, dict) or "synthetic_voice_lab" not in metadata:
        return
    claims = capability_for_gateway_action(
        request,
        authenticated_user_id,
        required_operation="session:read",
    )
    if not assert_voice_lab_session_record(record, claims):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_session_binding_mismatch"},
        )


@internal_router.post(
    "/builder-events",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=None,
    summary="Receive a builder-completion event from the LangGraph process",
    dependencies=[Depends(require_builder_event_service_auth)],
)
async def receive_builder_event(
    event: BuilderCompletionEvent,
    request: Request,
) -> dict[str, Any]:
    """Internal webhook target.

    Accepts the event, hands it to the worker for SSE fan-out, and also
    publishes it onto the channel ``MessageBus`` so Telegram/Slack/Feishu
    adapters can deliver a card to the originating chat.
    """
    raw_payload = event.model_dump()
    raw_payload.pop("deck_quality_publication_intent", None)
    payload = _normalized_builder_event_payload(
        await _hydrate_missing_run_id(raw_payload)
    )
    synthetic = _is_synthetic_builder_payload(payload)
    if synthetic:
        try:
            _upsert_builder_terminal_artifact(payload)
        except Exception as exc:  # noqa: BLE001 - fail closed before publication.
            logger.warning(
                "Synthetic Builder artifact isolation upsert failed task_id=%s thread_id=%s",
                payload.get("task_id"),
                payload.get("thread_id"),
                exc_info=True,
            )
            raise HTTPException(
                status_code=503,
                detail="Synthetic Builder artifact isolation is unavailable",
            ) from exc
        if not await _persist_builder_terminal_state(payload):
            raise HTTPException(
                status_code=503,
                detail="Synthetic Builder terminal state persistence is unavailable",
            )
    else:
        await _persist_builder_terminal_state(payload)
        try:
            _upsert_builder_terminal_artifact(payload)
        except Exception:  # noqa: BLE001 - ordinary artifact delivery stays best effort.
            logger.warning(
                "Builder terminal artifact registry upsert failed task_id=%s thread_id=%s",
                payload.get("task_id"),
                payload.get("thread_id"),
                exc_info=True,
            )
    worker = get_builder_events_worker(request.app)
    delivered = await worker.publish(payload)
    try:
        await get_builder_canvas_worker(request.app).publish_completion(payload)
    except RuntimeError:
        # Isolated legacy endpoint tests install only the terminal worker.
        pass

    # Fan out to channel adapters too. Best-effort: never let a channel
    # failure surface to the LangGraph process (which already moved on).
    if not synthetic:
        try:
            from app.channels.message_bus import publish_builder_completion

            await publish_builder_completion(payload)
        except Exception:
            logger.warning(
                "Channel fan-out failed for builder event task_id=%s",
                payload.get("task_id"),
                exc_info=True,
            )

    # Trigger a synthetic companion turn so Sophia proactively surfaces
    # the artifact in chat without the user having to send another
    # message. Fire-and-forget: ``wake()`` swallows its own errors and
    # the user's existing turn-driven adoption flow remains the
    # fallback. See ``app/gateway/workers/companion_wakeup.py``.
    #
    # Use the ``_or_none`` lookup so test fixtures that install only the
    # SSE worker don't get a noisy warning on every webhook POST.
    wakeup = None if synthetic else get_companion_wakeup_or_none(request.app)
    if wakeup is not None:
        try:
            asyncio.create_task(wakeup.wake(payload))
        except Exception:
            logger.warning(
                "Companion wakeup scheduling failed for builder event task_id=%s",
                payload.get("task_id"),
                exc_info=True,
            )

    return {"delivered_subscribers": delivered}


@internal_router.post(
    "/builder-events/synthetic-cleanup",
    response_model=SyntheticBuilderCleanupReceipt,
    summary="Cancel and purge one exact synthetic Builder run",
    dependencies=[Depends(require_builder_event_service_auth)],
)
async def receive_synthetic_builder_cleanup(
    cleanup: SyntheticBuilderCleanupRequest,
) -> SyntheticBuilderCleanupReceipt:
    return await cleanup_synthetic_builder_run(cleanup)


@internal_router.post(
    "/deck-quality-publications",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=None,
    summary="Retired DQ-1 publication webhook tombstone",
)
async def receive_deck_quality_publication(
    request: Request,
) -> Response:
    """Reject the retired second-POST admission protocol.

    Production never deployed this endpoint's non-atomic request/commit path.
    DQ-1 v2 discovers immutable producer bundles through the gateway worker;
    accepting a webhook intent here could create an unrecoverable legacy row
    and poison reconciliation. The route remains as an explicit rolling-
    compatibility tombstone instead of silently becoming a 404.
    """

    _ = request
    return Response(status_code=status.HTTP_410_GONE)


@internal_router.post(
    "/deck-quality-producer-failures",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=None,
    summary="Record an authenticated DQ-1 producer double-storage failure",
)
async def receive_deck_quality_producer_failure(
    request: Request,
) -> Response:
    """Persist one content-free signal through the independent DB channel.

    Authentication covers the exact bytes before JSON parsing. The endpoint
    accepts only the fixed failure schema, revalidates current exact-canary
    admission before touching persistence, and returns no response body.
    """

    content_type = request.headers.get("content-type", "").split(";", 1)[0]
    if content_type.strip().casefold() != "application/json":
        return Response(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)
    try:
        body = await _bounded_failure_signal_body(request)
    except OverflowError:
        return Response(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE
        )
    signal = _parse_producer_failure_signal(body)
    try:
        authenticate_builder_event(body, request.headers)
    except BuilderEventAuthenticationError as exc:
        if exc.code == "builder_event_auth_unavailable":
            if signal is not None and is_producer_failure_hmac_probe(signal):
                return Response(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE
                )
            _degrade_producer_failure_signal_transport(
                request.app,
                reason="producer_failure_signal_auth_unavailable",
                error_type=exc.__class__.__name__,
            )
            return Response(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(status_code=status.HTTP_401_UNAUTHORIZED)
    if signal is None:
        if _authenticated_body_claims_exact_canary(body):
            _degrade_producer_failure_signal_transport(
                request.app,
                reason="producer_failure_signal_schema_failed",
            )
        return Response(status_code=status.HTTP_400_BAD_REQUEST)

    if is_producer_failure_hmac_probe(signal):
        # Legacy probes omitted the keyed scope proof; retain their side-effect
        # free 403 for rollback compatibility. The amended LangGraph startup
        # always sends a proof and refuses readiness unless the gateway's exact
        # dashboard-managed canary set produces the same value.
        if signal.canary_scope_proof is None:
            return Response(
                status_code=status.HTTP_403_FORBIDDEN,
                headers={
                    BUILDER_EVENT_PROBE_ACK_HEADER: (
                        builder_event_probe_ack(body)
                    )
                },
            )
        try:
            expected_scope_proof = builder_event_canary_scope_proof(
                get_app_config().deck_quality.canary_user_ids
            )
        except Exception as exc:  # noqa: BLE001 - no identity enters logs.
            _degrade_producer_failure_signal_transport(
                request.app,
                reason="producer_failure_signal_scope_probe_unavailable",
                error_type=exc.__class__.__name__,
            )
            return Response(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        if hmac.compare_digest(
            signal.canary_scope_proof,
            expected_scope_proof,
        ):
            return Response(
                status_code=status.HTTP_403_FORBIDDEN,
                headers={
                    BUILDER_EVENT_PROBE_ACK_HEADER: (
                        builder_event_probe_ack(body)
                    )
                },
            )
        return Response(status_code=status.HTTP_409_CONFLICT)

    if not _is_exact_canary_failure_signal(signal):
        return Response(status_code=status.HTTP_403_FORBIDDEN)

    store = get_producer_failure_signal_store_or_none(request.app)
    if store is None:
        _degrade_producer_failure_signal_transport(
            request.app,
            reason="producer_failure_signal_store_unavailable",
        )
        return Response(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    try:
        async with asyncio.timeout(
            _PRODUCER_FAILURE_SIGNAL_RPC_TIMEOUT_SECONDS
        ):
            receipt = await store.record(signal)
    except Exception as exc:  # noqa: BLE001 - response stays content-free.
        _degrade_producer_failure_signal_transport(
            request.app,
            reason="producer_failure_signal_persistence_failed",
            error_type=exc.__class__.__name__,
        )
        return Response(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    if not isinstance(receipt, ProducerFailureSignalReceipt):
        _degrade_producer_failure_signal_transport(
            request.app,
            reason="producer_failure_signal_protocol_failed",
        )
        return Response(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    component = receipt.component()
    if receipt.outcome == "conflict":
        component["reason"] = "producer_failure_signal_conflict"
        set_producer_failure_signal_readiness(request.app, component)
        return Response(status_code=status.HTTP_409_CONFLICT)
    set_producer_failure_signal_readiness(request.app, component)
    return Response(status_code=status.HTTP_202_ACCEPTED)


@internal_router.post(
    "/builder-progress",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Receive a progress event from the builder middleware",
    dependencies=[Depends(require_builder_event_service_auth)],
)
async def receive_builder_progress(event: BuilderProgressEvent, request: Request) -> dict[str, Any]:
    """Internal webhook for builder phase / tool-call events.

    The langgraph-side ``BuilderProgressMiddleware`` POSTs one of
    these per lifecycle hook (``before_agent``, ``after_model`` with
    relevant tool_calls, ``after_agent``). The gateway-side registry
    dispatches the event through the per-task ``ProgressRenderer``
    and edits the Telegram placeholder via the channel's edit
    callback. See ``app/gateway/builder_progress/registry.py`` for
    the full flow.

    Phase 4H (webhook relay) replaces the ``runs.join_stream`` HTTP
    consumer that doesn't work cross-process against the
    ``langgraph_runtime_inmem`` backend.

    Best-effort: any registry failure is logged and swallowed so the
    builder never blocks waiting on the gateway. The 202 response
    means "accepted for relay" — NOT "successfully edited".
    """
    from app.gateway.builder_progress import get_progress_registry

    event_payload = _normalized_builder_event_payload(event.model_dump())
    synthetic = _is_synthetic_builder_payload(event_payload)
    applied = False
    if not synthetic:
        registry = get_progress_registry()
        try:
            applied = await registry.apply_event(
                task_id=event.task_id,
                event_name=event.event_name,
                data=event.data,
                # Codex P1 (post-Phase-4H review): pass run_id so the
                # registry can drop in-flight POSTs from an obsoleted run
                # (interrupted via ``update_async_task``).
                run_id=event.run_id,
            )
        except Exception:
            logger.warning(
                "Builder-progress relay failed task_id=%s event=%s",
                event.task_id,
                event.event_name,
                exc_info=True,
            )
            applied = False
    web_delivered = 0
    try:
        web_delivered = await get_builder_canvas_worker(request.app).publish_progress(event_payload)
    except RuntimeError:
        # Channel-only test fixtures and older app factories need not mount
        # the browser worker.
        pass
    return {"applied": applied, "web_delivered": web_delivered} if event.parent_thread_id else {"applied": applied}


def _format_sse_event(payload: dict[str, Any]) -> bytes:
    """Encode an event for the SSE wire format.

    The webapp listener parses ``event.data`` as JSON. Always emit a
    standard ``data:`` line followed by the required blank line.
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


@public_router.get(
    "/{thread_id}/builder-events",
    summary="Subscribe to builder completion events for a thread (SSE)",
)
async def stream_builder_events(
    thread_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> StreamingResponse:
    """Hold a long-lived SSE connection and stream events as they arrive.

    The webapp opens this from ``useSessionRouteExperience`` whenever the
    local ``builderTask.status`` is ``queued`` or ``running``. The stream
    closes when the client disconnects or when the gateway shuts down.
    """
    record = _require_builder_event_thread_owner(
        authenticated_user_id,
        thread_id,
    )
    _require_synthetic_builder_event_capability(
        request,
        authenticated_user_id,
        record,
    )
    worker = get_builder_events_worker(request.app)

    async def _event_stream():
        async with worker.subscribe(thread_id) as queue:
            # Replay the last event (if any) so a fast-mounting client
            # immediately sees the current state without an extra HTTP
            # round-trip to ``/last``.
            cached = await worker.get_last(thread_id)
            if cached is not None:
                yield _format_sse_event(cached)

            try:
                while True:
                    if await request.is_disconnected():
                        return
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except TimeoutError:
                        # Heartbeat keeps proxies / browsers from closing
                        # the connection on idle. SSE comments are valid
                        # and ignored by the EventSource API.
                        yield b": keepalive\n\n"
                        continue
                    yield _format_sse_event(event)
            except asyncio.CancelledError:
                return

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # nginx: don't buffer the stream
        },
    )


@public_router.get(
    "/{thread_id}/builder-events/last",
    summary="Fetch the most recent builder event for a thread (late-mount recovery)",
)
async def last_builder_event(
    thread_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> Response:
    """Return the cached event or 204 if nothing in the TTL window."""
    record = _require_builder_event_thread_owner(
        authenticated_user_id,
        thread_id,
    )
    _require_synthetic_builder_event_capability(
        request,
        authenticated_user_id,
        record,
    )
    worker = get_builder_events_worker(request.app)
    event = await worker.get_last(thread_id)
    if event is None:
        return Response(status_code=204)
    return Response(
        content=json.dumps(event, ensure_ascii=False),
        media_type="application/json",
        status_code=200,
    )
