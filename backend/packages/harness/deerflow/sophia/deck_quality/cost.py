from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from deerflow.config.model_route_config import ResolvedModelPlan

SOL_PRICING_VERSION: Final = "gpt-5.6-sol-pricing-2026-07-16"
SOL_LONG_CONTEXT_INPUT_THRESHOLD: Final = 272_000
SOL_STANDARD_INPUT_USD_PER_MILLION: Final = Decimal("5")
SOL_STANDARD_OUTPUT_USD_PER_MILLION: Final = Decimal("30")
SOL_LONG_INPUT_USD_PER_MILLION: Final = Decimal("10")
SOL_LONG_OUTPUT_USD_PER_MILLION: Final = Decimal("45")
SOL_MAX_OUTPUT_TOKENS: Final = 6000


def locked_sol_model_overrides() -> dict[str, object]:
    """Return a fresh copy of the cost- and retention-significant route lock."""

    return {
        "reasoning": {
            "effort": "high",
            "mode": "standard",
            "context": "current_turn",
        },
        "output_version": "responses/v1",
        "use_responses_api": True,
        "store": False,
        "max_completion_tokens": SOL_MAX_OUTPUT_TOKENS,
        "timeout": 180,
        "max_retries": 0,
    }


def validate_sol_plan_locks(plan: ResolvedModelPlan) -> None:
    if plan.route_name != "deck.judge.visual":
        raise ValueError("deck quality judge route is not locked")
    if plan.deployment_name != "openai-gpt-5-6-sol":
        raise ValueError("deck quality judge deployment is not locked")
    if plan.provider != "openai" or plan.provider_model != "gpt-5.6-sol":
        raise ValueError("deck quality judge provider model is not locked")
    if plan.profile_name != "deck-visual-judge-v2" or plan.profile_version != "v2":
        raise ValueError("deck quality judge profile is not locked")
    if plan.model_overrides != locked_sol_model_overrides():
        raise ValueError("deck quality judge request controls are not locked")


def sol_cost_usd(*, input_tokens: int, output_tokens: int) -> Decimal:
    """Compute uncached list-price cost; cached-token discounts never count."""

    if isinstance(input_tokens, bool) or input_tokens < 0:
        raise ValueError("input token count is invalid")
    if isinstance(output_tokens, bool) or output_tokens < 0:
        raise ValueError("output token count is invalid")
    long_context = input_tokens > SOL_LONG_CONTEXT_INPUT_THRESHOLD
    input_rate = SOL_LONG_INPUT_USD_PER_MILLION if long_context else SOL_STANDARD_INPUT_USD_PER_MILLION
    output_rate = SOL_LONG_OUTPUT_USD_PER_MILLION if long_context else SOL_STANDARD_OUTPUT_USD_PER_MILLION
    return (Decimal(input_tokens) * input_rate + Decimal(output_tokens) * output_rate) / Decimal("1000000")


def projected_sol_call_cost_usd(input_tokens: int) -> Decimal:
    return sol_cost_usd(
        input_tokens=input_tokens,
        output_tokens=SOL_MAX_OUTPUT_TOKENS,
    )


def exact_sol_preflight_admitted(
    *,
    input_token_counts: tuple[int, ...],
    spent_usd: Decimal = Decimal("0"),
    max_calls: int = 2,
    cost_cap_usd: Decimal = Decimal("0.60"),
) -> bool:
    """Admit only if every future call at max output remains within the cap."""

    if isinstance(max_calls, bool) or max_calls < 0:
        raise ValueError("call ceiling is invalid")
    if spent_usd < 0 or cost_cap_usd <= 0:
        raise ValueError("cost boundary is invalid")
    if len(input_token_counts) > max_calls:
        return False
    projected = spent_usd + sum(
        (projected_sol_call_cost_usd(value) for value in input_token_counts),
        start=Decimal("0"),
    )
    return projected <= cost_cap_usd
