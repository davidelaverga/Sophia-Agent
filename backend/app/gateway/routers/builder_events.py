"""Gateway endpoints for the builder completion notifier.

Internal webhook endpoints plus legacy router definitions:

- ``POST /internal/builder-events`` — accepts the baseline webhook from the
  LangGraph process (``deerflow.sophia.builder_events``) when a sophia_builder task
  reaches a terminal state. Hands the payload to the per-app
  ``BuilderEventsWorker``, which fans it out to webapp SSE subscribers
  and the channel ``MessageBus``.

- The ``public_router`` legacy completion SSE definitions remain available
  to focused backward-compatibility tests, but the gateway app no longer
  mounts them. Browsers consume authenticated builder-canvas SSE routes.

DQ-1 publication admission is isolated at
``/internal/deck-quality-publications`` and authenticates its exact raw body
before parsing or persistence, so shadow retries can never replay or gate the
baseline terminal-delivery route.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.gateway.artifact_registry import (
    ArtifactRegistry,
    builder_completion_upsert_request,
)
from app.gateway.workers.builder_canvas import get_builder_canvas_worker
from app.gateway.workers.builder_events import get_builder_events_worker
from app.gateway.workers.companion_wakeup import get_companion_wakeup_or_none
from app.gateway.workers.deck_quality_publication import (
    DeckQualityPublicationAdmissionError,
    admit_deck_quality_publication,
)
from deerflow.sophia.builder_event_auth import (
    BuilderEventAuthenticationError,
    authenticate_builder_event,
)
from deerflow.sophia.session_store import SessionStore

logger = logging.getLogger(__name__)

_SUCCESSFUL_BUILDER_STATUSES = {"success", "completed"}
_MAX_DECK_QUALITY_PUBLICATION_BODY_BYTES = 64 * 1024
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
)
_artifact_registry = ArtifactRegistry()
_session_store = SessionStore()


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


def _terminal_identity(payload: dict[str, Any]) -> tuple[str, str] | None:
    parent_thread_id = payload.get("thread_id")
    task_id = payload.get("task_id")
    if not isinstance(parent_thread_id, str) or not parent_thread_id:
        return None
    if not isinstance(task_id, str) or not task_id:
        return None
    return parent_thread_id, task_id


async def _resolve_existing_builder_run_id(parent_thread_id: str, task_id: str) -> str | None:
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
    run_id = task.get("run_id")
    return run_id if isinstance(run_id, str) and run_id else None


async def _hydrate_missing_run_id(payload: dict[str, Any]) -> dict[str, Any]:
    if isinstance(payload.get("run_id"), str) and payload["run_id"]:
        return payload
    identity = _terminal_identity(payload)
    if identity is None:
        return payload
    parent_thread_id, task_id = identity
    run_id = await _resolve_existing_builder_run_id(parent_thread_id, task_id)
    if run_id is None:
        return payload
    logger.info(
        "Builder terminal payload hydrated missing run_id from parent async task parent_thread_id=%s task_id=%s run_id=%s",
        str(parent_thread_id)[:12],
        str(task_id)[:12],
        str(run_id)[:12],
    )
    return {**payload, "run_id": run_id}


def _should_persist_last_builder_artifact(payload: dict[str, Any]) -> bool:
    artifact_path = payload.get("artifact_path")
    artifact_url = payload.get("artifact_url")
    return str(payload.get("status") or "").lower() in _SUCCESSFUL_BUILDER_STATUSES and ((isinstance(artifact_path, str) and bool(artifact_path.strip())) or (isinstance(artifact_url, str) and bool(artifact_url.strip())))


async def _persist_builder_terminal_state(payload: dict[str, Any]) -> None:
    identity = _terminal_identity(payload)
    if identity is None:
        return
    parent_thread_id, task_id = identity

    task_update = _terminal_async_task_update(payload)
    values: dict[str, Any] = {"async_tasks": {task_id: task_update}}
    if _should_persist_last_builder_artifact(payload):
        values["last_builder_artifact"] = _durable_builder_result(payload)

    try:
        from langgraph_sdk import get_client

        client = get_client(url=_langgraph_url())
        await client.threads.update_state(parent_thread_id, values)
    except Exception:
        logger.warning(
            "Builder terminal state persistence failed parent_thread_id=%s task_id=%s run_id=%s",
            str(parent_thread_id)[:12],
            str(task_id)[:12],
            str(payload.get("run_id") or "")[:12],
            exc_info=True,
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
    deck_quality_publication_intent: dict[str, Any] | None = Field(
        default=None,
        description="Content-free DQ-1 canary publication ticket; stripped before user/channel fan-out.",
    )


class _DeckQualityMechanicalEligibility(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    passed: bool


class DeckQualityPublicationEnvelope(BaseModel):
    """Minimal authenticated metadata needed for independent DQ admission."""

    model_config = ConfigDict(extra="forbid", strict=True)

    thread_id: str
    task_id: str
    run_id: str
    builder_trace_root_run_id: str
    user_id: str
    status: Literal["success", "completed"]
    task_type: Literal["presentation"]
    artifact_path: str
    artifact_type: Literal["presentation"]
    artifact_ext: str
    artifact_is_fallback: bool
    storage_provider: str
    storage_status: str
    storage_object_path: str
    artifact_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    manifest_revision: int
    deck_build_id: str
    logical_artifact_id: str
    current_artifact_version_id: str
    mechanical_gate_results: _DeckQualityMechanicalEligibility
    deck_quality_publication_intent: dict[str, Any]


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


# ---- Routers ---------------------------------------------------------------


internal_router = APIRouter(prefix="/internal", tags=["builder-events"])
public_router = APIRouter(prefix="/api/threads", tags=["builder-events"])


async def _authenticated_publication_body(
    request: Request,
) -> bytes | Response:
    """Read a bounded body and authenticate it before any route side effect."""

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except (TypeError, ValueError, OverflowError):
            return Response(status_code=status.HTTP_400_BAD_REQUEST)
        if declared_length < 1:
            return Response(status_code=status.HTTP_400_BAD_REQUEST)
        if declared_length > _MAX_DECK_QUALITY_PUBLICATION_BODY_BYTES:
            return Response(status_code=status.HTTP_413_CONTENT_TOO_LARGE)

    chunks = bytearray()
    try:
        async for chunk in request.stream():
            chunks.extend(chunk)
            if len(chunks) > _MAX_DECK_QUALITY_PUBLICATION_BODY_BYTES:
                return Response(status_code=status.HTTP_413_CONTENT_TOO_LARGE)
    except Exception:  # noqa: BLE001 - malformed transport is content-free.
        logger.warning("DQ1 publication body read failed contentExcluded=true")
        return Response(status_code=status.HTTP_400_BAD_REQUEST)
    body = bytes(chunks)
    try:
        authenticate_builder_event(body, request.headers)
    except BuilderEventAuthenticationError as exc:
        logger.warning(
            "DQ1 publication authentication failed code=%s contentExcluded=true",
            exc.code,
        )
        response_status = status.HTTP_503_SERVICE_UNAVAILABLE if exc.code == "builder_event_auth_unavailable" else status.HTTP_401_UNAUTHORIZED
        return Response(status_code=response_status)
    return body


@internal_router.post(
    "/builder-events",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=None,
    summary="Receive a builder-completion event from the LangGraph process",
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
    payload = await _hydrate_missing_run_id(raw_payload)
    await _persist_builder_terminal_state(payload)
    try:
        _upsert_builder_terminal_artifact(payload)
    except Exception:  # noqa: BLE001 - artifact registry must not block delivery.
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
    wakeup = get_companion_wakeup_or_none(request.app)
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
    "/deck-quality-publications",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=None,
    summary="Admit one authenticated DQ-1 canary publication",
)
async def receive_deck_quality_publication(
    request: Request,
) -> dict[str, Any] | Response:
    """Durably admit metadata only, with no terminal-delivery side effects."""

    authenticated = await _authenticated_publication_body(request)
    if isinstance(authenticated, Response):
        return authenticated
    try:
        envelope = DeckQualityPublicationEnvelope.model_validate_json(authenticated)
    except (ValidationError, ValueError):
        logger.warning("DQ1 publication envelope validation failed contentExcluded=true")
        return Response(status_code=status.HTTP_400_BAD_REQUEST)
    builder_payload = envelope.model_dump(mode="python")
    publication_intent = builder_payload.pop(
        "deck_quality_publication_intent",
        None,
    )
    try:
        publication_ack = await admit_deck_quality_publication(
            request.app,
            raw_intent=publication_intent,
            builder_payload=builder_payload,
        )
    except DeckQualityPublicationAdmissionError as exc:
        logger.error(
            "DQ1 publication admission failed error_type=%s contentExcluded=true",
            exc.__class__.__name__,
            exc_info=False,
        )
        return Response(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            headers={"Retry-After": "5"},
        )
    if publication_ack is None:
        return Response(status_code=status.HTTP_400_BAD_REQUEST)
    return {
        "deck_quality_publication_ack": publication_ack.model_dump(mode="json"),
    }


@internal_router.post(
    "/builder-progress",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Receive a progress event from the builder middleware",
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
        web_delivered = await get_builder_canvas_worker(request.app).publish_progress(event.model_dump())
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
async def stream_builder_events(thread_id: str, request: Request) -> StreamingResponse:
    """Hold a long-lived SSE connection and stream events as they arrive.

    The webapp opens this from ``useSessionRouteExperience`` whenever the
    local ``builderTask.status`` is ``queued`` or ``running``. The stream
    closes when the client disconnects or when the gateway shuts down.
    """
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
async def last_builder_event(thread_id: str, request: Request) -> Response:
    """Return the cached event or 204 if nothing in the TTL window."""
    worker = get_builder_events_worker(request.app)
    event = await worker.get_last(thread_id)
    if event is None:
        return Response(status_code=204)
    return Response(
        content=json.dumps(event, ensure_ascii=False),
        media_type="application/json",
        status_code=200,
    )
