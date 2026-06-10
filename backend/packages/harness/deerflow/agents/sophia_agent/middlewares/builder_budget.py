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
from typing import Any, NotRequired

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import hook_config
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

from deerflow.sophia.builder_events import fire_completion_webhook_from_artifact

logger = logging.getLogger(__name__)


# USD per 1M tokens. Cache reads are billed at 10% of the input rate; cache
# writes (5m TTL) at 125%. Add MiniMax/DeepSeek/Gemini here if they ever
# become builder models (see spec §5).
_MODEL_PRICES: dict[str, dict[str, float]] = {
    "claude-sonnet-4-6": {"in": 3.0, "out": 15.0},
    "claude-haiku-4-5": {"in": 1.0, "out": 5.0},
}
# Fail to the Sonnet rate so an unknown model never UNDER-bills (the breaker
# would rather trip slightly early than let a runaway through).
_DEFAULT_PRICE: dict[str, float] = {"in": 3.0, "out": 15.0}

# Default per-run caps. ``0`` / ``0.0`` disables a cap. ``start_builder_task``
# seeds an explicit copy into ``run_input["builder_budget"]``; this is the
# back-stop when state doesn't carry it.
DEFAULT_BUILDER_BUDGET: dict[str, Any] = {
    "max_cost_usd": 5.0,
    "max_total_tokens": 2_000_000,
    "cost_model_key": "claude-sonnet-4-6",
}


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

    def _apply(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        max_cost, max_tokens, cost_key = self._resolve_caps(state)
        if max_cost <= 0 and max_tokens <= 0:
            return None  # both caps disabled — no-op

        messages = state.get("messages", []) or []
        totals = _sum_usage(messages)
        total_tokens = totals["input"] + totals["output"]
        cost = _estimate_cost_usd(totals, _price_for(cost_key))

        # Telemetry (Phase 2a): per-turn cumulative usage so cache reads ≫
        # writes can be confirmed and $/build measured from logs.
        logger.info(
            "[BuilderBudget] usage in=%d out=%d cache_read=%d cache_creation=%d est_cost=$%.4f",
            totals["input"],
            totals["output"],
            totals["cache_read"],
            totals["cache_creation"],
            cost,
        )

        over_cost = max_cost > 0 and cost >= max_cost
        over_tokens = max_tokens > 0 and total_tokens >= max_tokens
        if not (over_cost or over_tokens):
            return None

        reason = (
            f"cost=${cost:.2f}>=${max_cost:.2f}"
            if over_cost
            else f"tokens={total_tokens}>={max_tokens}"
        )
        logger.error(
            "[BuilderBudget] BUDGET EXCEEDED: %s (est_cost=$%.4f total_tokens=%d) — terminating builder run",
            reason,
            cost,
            total_tokens,
        )

        # Fire the terminal webhook. status MUST be a native terminal value
        # ("timed_out"); the spec's "timeout" is rejected by the webhook.
        # Dedup is one-shot per task: on a turn that also emitted an artifact,
        # BuilderArtifactMiddleware (which runs FIRST, see module docstring)
        # already claimed it with "completed", so this no-ops and the
        # deliverable is preserved.
        try:
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact={},  # no deliverable on a budget kill
                status="timed_out",
                error_message=f"Builder stopped: run budget exceeded ({reason}).",
            )
        except Exception:  # noqa: BLE001 — the breaker must never itself crash the run
            logger.warning("[BuilderBudget] completion webhook dispatch failed", exc_info=True)

        # Deterministic stop: jump_to=end AND strip tool_calls from the last
        # AIMessage so the loop exits even if jump_to is later overwritten.
        update: dict[str, Any] = {"jump_to": "end"}
        if messages and isinstance(messages[-1], AIMessage):
            last = messages[-1]
            note = f"\n\n[Builder stopped: run budget exceeded ({reason}).]"
            # Guard list-shaped content (Anthropic tool_use blocks) — only
            # append the note to plain-string content to avoid a list+str error.
            new_content = (last.content + note) if isinstance(last.content, str) else last.content
            update["messages"] = [last.model_copy(update={"tool_calls": [], "content": new_content})]
        return update

    @hook_config(can_jump_to=["end"])
    def after_model(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)

    @hook_config(can_jump_to=["end"])
    async def aafter_model(self, state: BuilderBudgetState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)
