from __future__ import annotations

from decimal import Decimal

import pytest

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.deck_quality.cost import (
    exact_sol_preflight_admitted,
    projected_sol_call_cost_usd,
    sol_cost_usd,
    validate_sol_plan_locks,
)


def _resolved_plan(**overrides: object) -> ResolvedModelPlan:
    values: dict[str, object] = {
        "route_name": "deck.judge.visual",
        "deployment_name": "openai-gpt-5-6-sol",
        "provider": "openai",
        "provider_model": "gpt-5.6-sol",
        "profile_name": "deck-visual-judge-v2",
        "profile_version": "v2",
        "capabilities": frozenset(),
        "model_overrides": {
            "reasoning": {
                "effort": "high",
                "mode": "standard",
                "context": "current_turn",
            },
            "output_version": "responses/v1",
            "use_responses_api": True,
            "store": False,
            "max_completion_tokens": 6000,
            "timeout": 180,
            "max_retries": 0,
        },
        "plan_hash": "a" * 64,
    }
    values.update(overrides)
    return ResolvedModelPlan.model_validate(values)


@pytest.mark.parametrize(
    ("profile", "input_counts", "expected_cost", "admitted"),
    [
        ("3600", (49_878, 50_916), Decimal("0.863970"), False),
        ("2560", (28_088, 29_126), Decimal("0.646070"), False),
        ("2400", (25_838, 26_876), Decimal("0.623570"), False),
        ("2304", (24_198, 25_236), Decimal("0.607170"), False),
        ("2200", (22_633, 23_671), Decimal("0.591520"), True),
        ("2048", (20_308, 21_346), Decimal("0.568270"), True),
    ],
)
def test_calibrated_raster_profile_cost_table_is_locked(
    profile: str,
    input_counts: tuple[int, int],
    expected_cost: Decimal,
    admitted: bool,
) -> None:
    del profile
    projected = sum(
        (projected_sol_call_cost_usd(value) for value in input_counts),
        start=Decimal("0"),
    )

    assert projected == expected_cost
    assert (
        exact_sol_preflight_admitted(
            input_token_counts=input_counts,
        )
        is admitted
    )


def test_exact_combined_input_boundary_admits_equality_and_rejects_one_token_over() -> None:
    assert exact_sol_preflight_admitted(
        input_token_counts=(24_000, 24_000),
    )
    assert not exact_sol_preflight_admitted(
        input_token_counts=(24_000, 24_001),
    )


def test_actual_spend_plus_future_max_output_is_rechecked_exactly() -> None:
    actual_a = sol_cost_usd(input_tokens=22_633, output_tokens=6000)
    assert exact_sol_preflight_admitted(
        input_token_counts=(25_367,),
        spent_usd=actual_a,
    )
    assert not exact_sol_preflight_admitted(
        input_token_counts=(25_368,),
        spent_usd=actual_a,
    )


def test_long_context_price_branch_is_pinned_without_cache_discount() -> None:
    standard = sol_cost_usd(input_tokens=272_000, output_tokens=1)
    long = sol_cost_usd(input_tokens=272_001, output_tokens=1)

    assert standard == Decimal("1.360030")
    assert long == Decimal("2.720055")


@pytest.mark.parametrize(
    "plan",
    [
        _resolved_plan(provider_model="gpt-5.6"),
        _resolved_plan(model_overrides={}),
        _resolved_plan(profile_version="v3"),
    ],
)
def test_model_profile_and_request_lock_drift_fails_closed(plan: object) -> None:
    with pytest.raises(ValueError):
        validate_sol_plan_locks(plan)  # type: ignore[arg-type]
