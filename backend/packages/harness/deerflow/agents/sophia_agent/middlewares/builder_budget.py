"""Builder budget circuit-breaker middleware.

A hard, model-independent cost/token ceiling for builder runs. The recent
incident burned hundreds of dollars in minutes from a runaway builder loop;
the existing loop detectors lower the *probability* of specific triggers,
but nothing bounded the *cost* regardless of trigger, model, or loop shape.
This middleware is that ceiling: enforced in ``after_model`` (constraints
over instructions) so it runs no matter what the model does.

Why a builder-GRAPH middleware (not ``subagents/executor.py``): the builder
is NOT a ``SubagentExecutor`` subagent. It is a separate LangGraph graph
(``sophia_builder``) dispatched via deepagents ``AsyncSubAgentMiddleware``,
so the ``_aexecute`` loop never runs for it. The only place that runs "no
matter what the model does" for the builder is a middleware in its chain.

On crossing a cap it (1) fires the terminal completion webhook with
``status="timed_out"`` + a clear budget message — reusing the EXISTING
``timed_out`` canvas plumbing (no gateway/frontend changes), and (2) ends
the run deterministically via ``jump_to="end"`` plus stripping ``tool_calls``
from the last AIMessage (robust even if the ephemeral ``jump_to`` were
overwritten by a later middleware in the same super-step).

Placement (``build_builder_middleware_chain``): listed immediately BEFORE
``BuilderArtifactMiddleware`` so that — because ``after_model`` hooks run in
REVERSE list order — this runs AFTER it. That ordering is deliberate: a turn
that legitimately emits an artifact lets ``BuilderArtifactMiddleware`` claim
the one-shot completion-webhook dedup with ``status="completed"`` first, so a
build that finishes exactly as it crosses the cap still DELIVERS its work
rather than being relabelled a budget kill. On a genuine runaway turn (no
artifact emitted) ``BuilderArtifactMiddleware`` fires nothing, so this
middleware's ``timed_out`` webhook wins uncontended.

Caps are seeded per-run via ``start_builder_task`` (``run_input["builder_budget"]``)
and read from state; the module defaults below back-stop a run even if seeding
is skipped. ``0`` / ``0.0`` disables a given cap (preserving prior behavior).
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, NotRequired

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import hook_config
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

from deerflow.sophia.builder_events import fire_completion_webhook_from_artifact
from deerflow.sophia.observability import annotate_builder_completion

logger = logging.getLogger(__name__)


# USD per 1M tokens. Cache reads are billed at 10% of the input rate; cache
# writes (5m TTL) at 125%. Add MiniMax/DeepSeek/Gemini here if they ever
# become builder models (see spec §5).
_MODEL_PRICES: dict[str, dict[str, float]] = {
    "claude-sonnet-5": {"in": 3.0, "out": 15.0},
    # Legacy alias while old queued jobs and config overrides drain. Keep the
    # breaker conservative until pricing is explicitly revised.
    "claude-sonnet-4-6": {"in": 3.0, "out": 15.0},
    "claude-haiku-4-5": {"in": 1.0, "out": 5.0},
}
# Fail to the Sonnet rate so an unknown model never UNDER-bills (the breaker
# would rather trip slightly early than let a runaway through).
_DEFAULT_PRICE: dict[str, float] = {"in": 3.0, "out": 15.0}

USER_BUDGET_TIMEOUT_MESSAGE = "Sorry, we hit the token limit for this task. Please let me know if you want to try again."
USER_BUDGET_COST_MESSAGE = "Sorry, we hit the cost limit for this task. Please let me know if you want to try again."
USER_BUDGET_WALL_CLOCK_MESSAGE = "Sorry, the presentation builder reached its 20-minute time limit before a complete deck was ready."
USER_BUDGET_TURN_MESSAGE = "Sorry, the builder reached its turn limit before a complete artifact was ready."

# Default per-run caps. ``0`` / ``0.0`` disables a cap. ``start_builder_task``
# seeds an explicit copy into ``run_input["builder_budget"]``; this is the
# back-stop when state doesn't carry it.
DEFAULT_BUILDER_BUDGET: dict[str, Any] = {
    "tier": "simple",
    "max_cost_usd": 5.0,
    "max_total_tokens": 2_000_000,
    "max_non_artifact_turns": 30,
    "force_emit_remaining_turns": 3,
    "soft_warn_at_turn": 18,
    "force_emit_wall_clock_fraction": 0.70,
    "repair_reserve_usd": 0.25,
    "cost_model_key": "claude-sonnet-5",
    "budget_stop_message": USER_BUDGET_TIMEOUT_MESSAGE,
}

COMPLEX_BUILDER_BUDGET: dict[str, Any] = {
    **DEFAULT_BUILDER_BUDGET,
    "tier": "complex_artifact",
    "max_cost_usd": 12.0,
    "max_total_tokens": 5_000_000,
    "max_non_artifact_turns": 45,
    "force_emit_remaining_turns": 4,
    "soft_warn_at_turn": 27,
}

PRESENTATION_BUILDER_BUDGET: dict[str, Any] = {
    **COMPLEX_BUILDER_BUDGET,
    "tier": "presentation",
    "max_non_artifact_turns": 12,
    "force_emit_remaining_turns": 2,
    "soft_warn_at_turn": 6,
    "max_wall_clock_seconds": 1_200,
    "prepare_force_at_turn": 2,
    "prepare_force_after_seconds": 15,
    "authoring_deadline_seconds": 720,
    "preflight_timeout_seconds": 15,
    "authoring_max_tokens": 16_384,
    "authoring_timeout_seconds": 360,
    "terminal_reserve_seconds": 30,
}

# Flat estimate per gpt-image-2 call (image-generation skill, enrichment-by-
# default). The CALL COUNT cap lives in BuilderArtifactMiddleware's bash
# interception (_IMAGE_GENERATION_MAX_CALLS); this constant only folds the
# spend into the cost ceiling + telemetry.
_IMAGE_GEN_COST_USD = 0.07

# VQ-10 budget pre-grant: a repair iteration is granted only when the
# remaining cost ceiling covers its estimate (one Sonnet repair turn plus a
# possible image-generation call).
_ITERATION_COST_ESTIMATE_USD = 0.25


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("[BuilderBudget] invalid float env %s=%r; using %.2f", name, raw, default)
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("[BuilderBudget] invalid int env %s=%r; using %d", name, raw, default)
        return default


def _budget_with_env(defaults: dict[str, Any], prefix: str) -> dict[str, Any]:
    budget = dict(defaults)
    budget["max_cost_usd"] = _env_float(f"{prefix}_MAX_COST_USD", float(budget["max_cost_usd"]))
    budget["max_total_tokens"] = _env_int(f"{prefix}_MAX_TOTAL_TOKENS", int(budget["max_total_tokens"]))
    budget["max_non_artifact_turns"] = _env_int(
        f"{prefix}_MAX_NON_ARTIFACT_TURNS",
        int(budget["max_non_artifact_turns"]),
    )
    budget["force_emit_remaining_turns"] = _env_int(
        f"{prefix}_FORCE_EMIT_REMAINING_TURNS",
        int(budget["force_emit_remaining_turns"]),
    )
    budget["soft_warn_at_turn"] = _env_int(f"{prefix}_SOFT_WARN_AT_TURN", int(budget["soft_warn_at_turn"]))
    budget["force_emit_wall_clock_fraction"] = _env_float(
        f"{prefix}_FORCE_EMIT_WALL_CLOCK_FRACTION",
        float(budget["force_emit_wall_clock_fraction"]),
    )
    budget["repair_reserve_usd"] = _env_float(f"{prefix}_REPAIR_RESERVE_USD", float(budget["repair_reserve_usd"]))
    if "max_wall_clock_seconds" in budget:
        budget["max_wall_clock_seconds"] = _env_int(
            f"{prefix}_MAX_WALL_CLOCK_SECONDS",
            int(budget["max_wall_clock_seconds"]),
        )
    if "prepare_force_at_turn" in budget:
        budget["prepare_force_at_turn"] = _env_int(
            f"{prefix}_PREPARE_FORCE_AT_TURN",
            int(budget["prepare_force_at_turn"]),
        )
    if "prepare_force_after_seconds" in budget:
        budget["prepare_force_after_seconds"] = _env_int(
            f"{prefix}_PREPARE_FORCE_AFTER_SECONDS",
            int(budget["prepare_force_after_seconds"]),
        )
    if "authoring_deadline_seconds" in budget:
        budget["authoring_deadline_seconds"] = _env_int(
            f"{prefix}_AUTHORING_DEADLINE_SECONDS",
            int(budget["authoring_deadline_seconds"]),
        )
    if "preflight_timeout_seconds" in budget:
        budget["preflight_timeout_seconds"] = _env_int(
            f"{prefix}_PREFLIGHT_TIMEOUT_SECONDS",
            int(budget["preflight_timeout_seconds"]),
        )
    if "authoring_max_tokens" in budget:
        budget["authoring_max_tokens"] = _env_int(
            f"{prefix}_AUTHORING_MAX_TOKENS",
            int(budget["authoring_max_tokens"]),
        )
    if "authoring_timeout_seconds" in budget:
        budget["authoring_timeout_seconds"] = _env_int(
            f"{prefix}_AUTHORING_TIMEOUT_SECONDS",
            int(budget["authoring_timeout_seconds"]),
        )
        # The first production rollout documented this shorter alias. Accept
        # it for compatibility while keeping the tiered BUDGET name canonical.
        if prefix == "SOPHIA_BUILDER_PRESENTATION_BUDGET" and os.environ.get(
            "SOPHIA_BUILDER_PRESENTATION_AUTHORING_TIMEOUT_SECONDS"
        ):
            budget["authoring_timeout_seconds"] = _env_int(
                "SOPHIA_BUILDER_PRESENTATION_AUTHORING_TIMEOUT_SECONDS",
                int(budget["authoring_timeout_seconds"]),
            )
    if "terminal_reserve_seconds" in budget:
        budget["terminal_reserve_seconds"] = _env_int(
            f"{prefix}_TERMINAL_RESERVE_SECONDS",
            int(budget["terminal_reserve_seconds"]),
        )
    return budget


def builder_budget_for_task(
    *,
    task_type: str | None,
    artifact_ext: str | None,
    cost_model_key: str | None = None,
) -> dict[str, Any]:
    """Return the per-run budget tier for a builder task.

    PDF/PPTX and visual-report/presentation tasks get more room for render,
    validation, and one bounded vision repair. Simple HTML/MD/code tasks keep
    the historical cap.
    """
    ext = str(artifact_ext or "").lower().lstrip(".")
    task = str(task_type or "").lower().strip()
    presentation_task = ext in {"pptx", "ppt"}
    complex_task = ext == "pdf" or task in {"presentation", "visual_report"}
    if presentation_task:
        defaults = PRESENTATION_BUILDER_BUDGET
        prefix = "SOPHIA_BUILDER_PRESENTATION_BUDGET"
    elif complex_task:
        defaults = COMPLEX_BUILDER_BUDGET
        prefix = "SOPHIA_BUILDER_COMPLEX_BUDGET"
    else:
        defaults = DEFAULT_BUILDER_BUDGET
        prefix = "SOPHIA_BUILDER_SIMPLE_BUDGET"
    budget = _budget_with_env(defaults, prefix)
    # Legacy escape hatch: lets operators globally tune without adopting the
    # tiered names immediately.
    if os.environ.get("SOPHIA_BUILDER_MAX_COST_USD"):
        budget["max_cost_usd"] = _env_float("SOPHIA_BUILDER_MAX_COST_USD", float(budget["max_cost_usd"]))
    if os.environ.get("SOPHIA_BUILDER_MAX_TOTAL_TOKENS"):
        budget["max_total_tokens"] = _env_int("SOPHIA_BUILDER_MAX_TOTAL_TOKENS", int(budget["max_total_tokens"]))
    if cost_model_key:
        budget["cost_model_key"] = cost_model_key
    return budget


def max_non_artifact_turns(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        budget = DEFAULT_BUILDER_BUDGET
    try:
        return max(1, int(budget.get("max_non_artifact_turns", DEFAULT_BUILDER_BUDGET["max_non_artifact_turns"])))
    except (TypeError, ValueError):
        return int(DEFAULT_BUILDER_BUDGET["max_non_artifact_turns"])


def force_emit_remaining_turns(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        budget = DEFAULT_BUILDER_BUDGET
    try:
        return max(1, int(budget.get("force_emit_remaining_turns", DEFAULT_BUILDER_BUDGET["force_emit_remaining_turns"])))
    except (TypeError, ValueError):
        return int(DEFAULT_BUILDER_BUDGET["force_emit_remaining_turns"])


def soft_warn_at_turn(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        budget = DEFAULT_BUILDER_BUDGET
    try:
        return max(1, int(budget.get("soft_warn_at_turn", DEFAULT_BUILDER_BUDGET["soft_warn_at_turn"])))
    except (TypeError, ValueError):
        return int(DEFAULT_BUILDER_BUDGET["soft_warn_at_turn"])


def force_emit_wall_clock_fraction(state: dict[str, Any]) -> float:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        budget = DEFAULT_BUILDER_BUDGET
    try:
        value = float(budget.get("force_emit_wall_clock_fraction", DEFAULT_BUILDER_BUDGET["force_emit_wall_clock_fraction"]))
    except (TypeError, ValueError):
        value = float(DEFAULT_BUILDER_BUDGET["force_emit_wall_clock_fraction"])
    return min(max(value, 0.05), 0.95)


def max_wall_clock_seconds(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        return 0
    try:
        return max(0, int(budget.get("max_wall_clock_seconds", 0) or 0))
    except (TypeError, ValueError):
        return 0


def prepare_force_at_turn(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        return 2
    try:
        return max(1, int(budget.get("prepare_force_at_turn", 2) or 2))
    except (TypeError, ValueError):
        return 2


def prepare_force_after_seconds(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        return 15
    try:
        return max(0, int(budget.get("prepare_force_after_seconds", 15) or 0))
    except (TypeError, ValueError):
        return 15


def presentation_authoring_deadline_seconds(state: dict[str, Any]) -> int:
    """Cumulative initial-authoring and repair deadline."""

    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        return 720
    try:
        return max(1, int(budget.get("authoring_deadline_seconds", 720) or 720))
    except (TypeError, ValueError):
        return 720


def presentation_preflight_timeout_seconds(state: dict[str, Any]) -> int:
    """Maximum model/tool time allocated to the one presentation preflight."""

    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        return 15
    try:
        return max(1, int(budget.get("preflight_timeout_seconds", 15) or 15))
    except (TypeError, ValueError):
        return 15


def presentation_authoring_max_tokens(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        return 16_384
    try:
        return max(1_024, int(budget.get("authoring_max_tokens", 16_384) or 16_384))
    except (TypeError, ValueError):
        return 16_384


def presentation_authoring_timeout_seconds(state: dict[str, Any]) -> int:
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        return 360
    try:
        return max(1, int(budget.get("authoring_timeout_seconds", 360) or 360))
    except (TypeError, ValueError):
        return 360


def estimate_run_cost_usd(state: dict) -> float:
    """Current estimated spend for this run (tokens + image calls)."""
    totals = _sum_usage(state.get("messages", []) or [])
    budget = state.get("builder_budget")
    key = budget.get("cost_model_key") if isinstance(budget, dict) else None
    cost = _estimate_cost_usd(totals, _price_for(key if isinstance(key, str) else None))
    image_attempts = int((state.get("builder_pptx_diagnostics") or {}).get("image_generation_attempt_count", 0) or 0)
    return cost + image_attempts * _IMAGE_GEN_COST_USD


def budget_allows_iteration(state: dict) -> bool:
    """VQ-10 pre-grant: never grant a repair iteration the ceiling can't pay for."""
    budget = state.get("builder_budget")
    if not isinstance(budget, dict):
        budget = DEFAULT_BUILDER_BUDGET
    try:
        max_cost = float(budget.get("max_cost_usd", 0.0) or 0.0)
    except (TypeError, ValueError):
        max_cost = 0.0
    try:
        reserve = float(budget.get("repair_reserve_usd", _ITERATION_COST_ESTIMATE_USD) or 0.0)
    except (TypeError, ValueError):
        reserve = _ITERATION_COST_ESTIMATE_USD
    if max_cost <= 0:
        return True  # cost cap disabled
    return estimate_run_cost_usd(state) + max(reserve, 0.0) <= max_cost


def _budget_stop_copy(budget_stop_reason: str) -> str:
    if budget_stop_reason == "cost_limit":
        return USER_BUDGET_COST_MESSAGE
    if budget_stop_reason == "wall_clock_limit":
        return USER_BUDGET_WALL_CLOCK_MESSAGE
    return USER_BUDGET_TIMEOUT_MESSAGE


def _budget_error_message(*, budget_stop_reason: str, detail: str) -> str:
    return f"{_budget_stop_copy(budget_stop_reason)} Builder budget exceeded: {detail}."


def _price_for(key: str | None) -> dict[str, float]:
    if key:
        for known, price in _MODEL_PRICES.items():
            if known in key:
                return price
    return _DEFAULT_PRICE


def _sum_usage(messages: list[Any]) -> dict[str, int]:
    """Sum per-call token usage across every AIMessage in ``messages``.

    Summing each call's ``input_tokens`` across turns intentionally counts
    the re-billed prefix every turn — that IS what the API charges, so the
    sum is the correct cumulative billed-token total for the cost estimate.
    """
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    for msg in messages:
        if not isinstance(msg, AIMessage):
            continue
        usage = getattr(msg, "usage_metadata", None) or {}
        totals["input"] += int(usage.get("input_tokens", 0) or 0)
        totals["output"] += int(usage.get("output_tokens", 0) or 0)
        details = usage.get("input_token_details") or {}
        totals["cache_read"] += int(details.get("cache_read", 0) or 0)
        totals["cache_creation"] += int(details.get("cache_creation", 0) or 0)
    return totals


def _estimate_cost_usd(totals: dict[str, int], price: dict[str, float]) -> float:
    """Estimate USD from accumulated usage.

    IMPORTANT: langchain-anthropic folds ``cache_read`` + ``cache_creation``
    INTO ``input_tokens`` (``_create_usage_metadata`` in chat_models.py), so
    they are subtracted before applying the base rate — otherwise cache tokens
    would be billed twice (full input rate + surcharge).
    """
    uncached_in = max(totals["input"] - totals["cache_read"] - totals["cache_creation"], 0)
    in_cost = (uncached_in / 1_000_000) * price["in"]
    out_cost = (totals["output"] / 1_000_000) * price["out"]
    cache_read_cost = (totals["cache_read"] / 1_000_000) * price["in"] * 0.10
    cache_write_cost = (totals["cache_creation"] / 1_000_000) * price["in"] * 1.25
    return in_cost + out_cost + cache_read_cost + cache_write_cost


class BuilderBudgetState(AgentState):
    # Per-run caps, seeded by start_builder_task; frozen (never mutated by the
    # graph). ``{"max_cost_usd": float, "max_total_tokens": int,
    # "cost_model_key": str | None}``. Absent → module defaults apply.
    builder_budget: NotRequired[dict | None]
    builder_task_kickoff_ms: NotRequired[int]
    builder_timeout_seconds: NotRequired[int]
    builder_deadline_epoch_ms: NotRequired[int]
    builder_result: NotRequired[dict | None]
    builder_graph_halted: NotRequired[bool]
    builder_terminal_halt_reason: NotRequired[str]


class BuilderBudgetMiddleware(AgentMiddleware[BuilderBudgetState]):
    """Deterministic cost/token ceiling for builder runs (see module docstring)."""

    state_schema = BuilderBudgetState

    @staticmethod
    def _resolve_caps(state: BuilderBudgetState) -> tuple[float, int, str | None]:
        budget = state.get("builder_budget")
        if not isinstance(budget, dict):
            budget = DEFAULT_BUILDER_BUDGET
        try:
            max_cost = float(budget.get("max_cost_usd", 0.0) or 0.0)
        except (TypeError, ValueError):
            max_cost = 0.0
        try:
            max_tokens = int(budget.get("max_total_tokens", 0) or 0)
        except (TypeError, ValueError):
            max_tokens = 0
        key = budget.get("cost_model_key")
        return max_cost, max_tokens, (key if isinstance(key, str) else None)

    @staticmethod
    def _deadline_epoch_ms(state: BuilderBudgetState) -> int:
        raw_deadline = state.get("builder_deadline_epoch_ms")
        if isinstance(raw_deadline, (int, float)) and raw_deadline > 0:
            return int(raw_deadline)
        timeout_s = max_wall_clock_seconds(state)
        kickoff_ms = state.get("builder_task_kickoff_ms")
        if timeout_s > 0 and isinstance(kickoff_ms, (int, float)) and kickoff_ms > 0:
            return int(kickoff_ms) + timeout_s * 1000
        return 0

    @classmethod
    def _wall_clock_exceeded(cls, state: BuilderBudgetState) -> bool:
        deadline_ms = cls._deadline_epoch_ms(state)
        return deadline_ms > 0 and int(time.time() * 1000) >= deadline_ms

    @staticmethod
    def _terminal_artifact(
        *,
        budget_stop_reason: str,
        failure_code: str,
        detail: str,
    ) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "presentation" if budget_stop_reason == "wall_clock_limit" else "unknown",
            "artifact_title": "Builder task did not complete",
            "steps_completed": 0,
            "decisions_made": [],
            "companion_summary": _budget_stop_copy(budget_stop_reason),
            "companion_tone_hint": "Direct and apologetic — the build stopped at a hard runtime limit.",
            "user_next_action": "Retry with a narrower scope or fewer slides.",
            "confidence": 0.0,
            "status": "timed_out",
            "terminal_status": "timed_out",
            "terminal_reason": budget_stop_reason,
            "artifact_acceptance_status": "failed",
            "failure_code": failure_code,
            "budget_stop_reason": budget_stop_reason,
            "builder_failure_diagnostics": {
                "failure_stage": "runtime_budget",
                "failure_code": failure_code,
                "failure_reason": detail,
                "budget_stop_reason": budget_stop_reason,
                "retryable": False,
            },
        }

    def _terminal_update(
        self,
        state: BuilderBudgetState,
        runtime: Runtime,
        *,
        budget_stop_reason: str,
        failure_code: str,
        detail: str,
    ) -> dict[str, Any]:
        artifact = self._terminal_artifact(
            budget_stop_reason=budget_stop_reason,
            failure_code=failure_code,
            detail=detail,
        )
        logger.error(
            "[BuilderBudget] terminal stop reason=%s failure_code=%s detail=%s",
            budget_stop_reason,
            failure_code,
            detail,
        )
        try:
            annotate_builder_completion(state, artifact)
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=artifact,
                status="timed_out",
                error_message=_budget_error_message(
                    budget_stop_reason=budget_stop_reason,
                    detail=detail,
                ),
            )
        except Exception:  # noqa: BLE001 - a circuit breaker must always terminate
            logger.warning("[BuilderBudget] terminal observability dispatch failed", exc_info=True)
        update: dict[str, Any] = {
            "builder_result": artifact,
            "builder_graph_halted": True,
            "builder_terminal_halt_reason": budget_stop_reason,
            "jump_to": "end",
        }
        messages = state.get("messages", []) or []
        if messages and isinstance(messages[-1], AIMessage):
            last = messages[-1]
            note = f"\n\n[Builder stopped: {budget_stop_reason}.]"
            content = last.content
            if isinstance(content, str):
                content = content + note
            elif isinstance(content, list):
                content = [*content, {"type": "text", "text": note.strip()}]
            update["messages"] = [last.model_copy(update={"tool_calls": [], "content": content})]
        return update

    def _apply(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        if state.get("builder_result") is not None or state.get("builder_graph_halted") is True:
            return None
        if self._wall_clock_exceeded(state):
            deadline_ms = self._deadline_epoch_ms(state)
            return self._terminal_update(
                state,
                runtime,
                budget_stop_reason="wall_clock_limit",
                failure_code="deck_deadline_exceeded",
                detail=f"deadline_epoch_ms={deadline_ms}",
            )
        max_cost, max_tokens, cost_key = self._resolve_caps(state)
        if max_cost <= 0 and max_tokens <= 0:
            return None  # both caps disabled — no-op

        messages = state.get("messages", []) or []
        totals = _sum_usage(messages)
        total_tokens = totals["input"] + totals["output"]
        cost = _estimate_cost_usd(totals, _price_for(cost_key))
        # Image-generation spend (enrichment-by-default). Read the diagnostics
        # channel dynamically — do NOT redeclare ``builder_pptx_diagnostics``
        # in BuilderBudgetState: a plain NotRequired redeclaration would
        # shadow the accumulating reducer down to LastValue (see the
        # documented trap in builder_task.py).
        image_attempts = int((state.get("builder_pptx_diagnostics") or {}).get("image_generation_attempt_count", 0) or 0)
        image_cost = image_attempts * _IMAGE_GEN_COST_USD
        cost += image_cost

        # Telemetry (Phase 2a): per-turn cumulative usage so cache reads ≫
        # writes can be confirmed and $/build measured from logs.
        logger.info(
            "[BuilderBudget] usage in=%d out=%d cache_read=%d cache_creation=%d image_calls=%d image_cost=$%.2f est_cost=$%.4f",
            totals["input"],
            totals["output"],
            totals["cache_read"],
            totals["cache_creation"],
            image_attempts,
            image_cost,
            cost,
        )

        over_cost = max_cost > 0 and cost >= max_cost
        over_tokens = max_tokens > 0 and total_tokens >= max_tokens
        if not (over_cost or over_tokens):
            return None

        budget_stop_reason = "cost_limit" if over_cost else "token_limit"
        reason = f"cost=${cost:.2f}>=${max_cost:.2f}" if over_cost else f"tokens={total_tokens}>={max_tokens}"
        return self._terminal_update(
            state,
            runtime,
            budget_stop_reason=budget_stop_reason,
            failure_code="builder_budget_exceeded",
            detail=reason,
        )

    @hook_config(can_jump_to=["end"])
    def before_model(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime) if self._wall_clock_exceeded(state) else None

    @hook_config(can_jump_to=["end"])
    async def abefore_model(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime) if self._wall_clock_exceeded(state) else None

    @hook_config(can_jump_to=["end"])
    def after_model(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)

    @hook_config(can_jump_to=["end"])
    async def aafter_model(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)
