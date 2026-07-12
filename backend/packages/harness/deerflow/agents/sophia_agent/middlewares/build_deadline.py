"""Outermost hard cancellation boundary for Sophia builder model calls."""

from __future__ import annotations

import logging
import os
from typing import Any, NotRequired

import anyio
from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse
from langchain_core.messages import AIMessage
from langgraph.types import Command

from deerflow.sophia.builder_events import fire_completion_webhook_from_artifact
from deerflow.sophia.build_runtime.deadline import BuildDeadlineExceeded, ExecutionEnvelope
from deerflow.sophia.observability import annotate_builder_completion

logger = logging.getLogger(__name__)


class BuildDeadlineState(AgentState):
    builder_budget: NotRequired[dict | None]
    builder_task_kickoff_ms: NotRequired[int]
    builder_deadline_epoch_ms: NotRequired[int]
    builder_graph_halted: NotRequired[bool]
    builder_terminal_halt_reason: NotRequired[str]
    builder_result: NotRequired[dict | None]


def _is_presentation(state: dict[str, Any]) -> bool:
    budget = state.get("builder_budget")
    return isinstance(budget, dict) and budget.get("tier") == "presentation"


def _prepare_emitted(state: dict[str, Any]) -> bool:
    diagnostics = state.get("builder_pptx_diagnostics")
    return isinstance(diagnostics, dict) and int(diagnostics.get("prepare_emitted_call_count", 0) or 0) > 0


def _terminal_failure(state: dict[str, Any], runtime: Any, exc: BuildDeadlineExceeded) -> ExtendedModelResponse:
    authoring = _is_presentation(state) and not _prepare_emitted(state)
    failure_code = "deck_authoring_deadline_exceeded" if authoring else "build_deadline_exceeded"
    artifact = {
        "artifact_path": None,
        "artifact_type": "presentation" if _is_presentation(state) else "unknown",
        "artifact_title": "Builder task did not complete",
        "status": "timed_out",
        "terminal_status": "timed_out",
        "terminal_reason": failure_code,
        "failure_code": failure_code,
        "root_failure_code": failure_code,
        "artifact_acceptance_status": "failed",
        "builder_failure_diagnostics": {
            "failure_stage": exc.stage,
            "failure_code": failure_code,
            "retryable": False,
            "deadline_epoch_ms": exc.deadline_epoch_ms,
        },
    }
    logger.error(
        "[BuildDeadline] terminal timeout stage=%s failure_code=%s rawProviderPayloadExcluded=true providerSecretsExcluded=true",
        exc.stage,
        failure_code,
    )
    try:
        annotate_builder_completion(state, artifact)
        fire_completion_webhook_from_artifact(
            state=state,
            runtime=runtime,
            artifact=artifact,
            status="timed_out",
            error_message=(
                "Presentation authoring exceeded its execution deadline."
                if authoring
                else "Builder execution exceeded its deadline."
            ),
        )
    except Exception:  # noqa: BLE001 - deadline termination must always complete.
        logger.warning("[BuildDeadline] terminal observability dispatch failed", exc_info=True)
    return ExtendedModelResponse(
        model_response=AIMessage(content="[Sophia builder stopped at its execution deadline.]"),
        command=Command(
            update={
                "builder_result": artifact,
                "builder_graph_halted": True,
                "builder_terminal_halt_reason": failure_code,
            },
            goto="end",
        ),
    )


class BuildDeadlineMiddleware(AgentMiddleware[BuildDeadlineState]):
    state_schema = BuildDeadlineState

    def wrap_model_call(self, request, handler):  # type: ignore[override]
        if os.getenv("SOPHIA_ENV", "").strip().lower() in {"prod", "production"}:
            raise RuntimeError("Production Sophia builder execution must use the async graph path")
        return handler(request)

    async def awrap_model_call(self, request, handler):  # type: ignore[override]
        state = request.state if isinstance(request.state, dict) else {}
        envelope = ExecutionEnvelope.from_state(state)
        if not envelope.enabled:
            return await handler(request)
        remaining = envelope.remaining_seconds(reserve_terminal=True)
        if remaining <= 0:
            return _terminal_failure(
                state,
                getattr(request, "runtime", None),
                BuildDeadlineExceeded(stage="model_call", deadline_epoch_ms=envelope.deadline_epoch_ms),
            )
        try:
            with anyio.fail_after(remaining):
                return await handler(request)
        except TimeoutError:
            return _terminal_failure(
                state,
                getattr(request, "runtime", None),
                BuildDeadlineExceeded(stage="model_call", deadline_epoch_ms=envelope.deadline_epoch_ms),
            )
