from __future__ import annotations

from decimal import Decimal

import pytest

from deerflow.config.deck_design_lift_config import (
    DeckDesignLiftConfig,
    DeckDesignLiftConfigError,
    audit_deck_design_lift_startup,
)
from deerflow.config.model_route_config import ResolvedModelPlan


def _plan(*, route: str, profile: str, capabilities: frozenset[str] | None = None) -> ResolvedModelPlan:
    return ResolvedModelPlan(
        route_name=route,
        deployment_name="openai-gpt-5-6-sol",
        provider="openai",
        provider_model="gpt-5.6-sol",
        profile_name=profile,
        profile_version="v1",
        capabilities=capabilities
        or frozenset(
            {
                "image_input",
                "multi_image_input",
                "strict_structured_output",
                "reasoning_effort",
            }
        ),
        model_overrides={},
        plan_hash="a" * 64,
    )


def _enabled() -> DeckDesignLiftConfig:
    return DeckDesignLiftConfig(
        enabled=True,
        mode="production_canary",
        canary_user_ids="canary-user",
        max_campaign_cost_usd=Decimal("3.00"),
    )


def test_defaults_are_closed_and_separate_from_dq1() -> None:
    config = DeckDesignLiftConfig()
    assert config.enabled is False
    assert config.mode == "off"
    assert config.max_repairs == 1
    assert config.max_judge_calls == 4
    assert config.max_repair_calls == 1
    assert config.affect_delivery is False
    assert config.promote_improved_candidate is True


def test_enabled_config_requires_exact_locked_canary_and_cost() -> None:
    with pytest.raises(ValueError, match="production_canary"):
        DeckDesignLiftConfig(enabled=True, max_campaign_cost_usd=Decimal("3.00"))
    with pytest.raises(ValueError, match="canary"):
        DeckDesignLiftConfig(
            enabled=True,
            mode="production_canary",
            max_campaign_cost_usd=Decimal("3.00"),
        )
    with pytest.raises(ValueError, match="3.00"):
        DeckDesignLiftConfig(
            enabled=True,
            mode="production_canary",
            canary_user_ids="canary-user",
            max_campaign_cost_usd=Decimal("2.99"),
        )


def test_startup_audit_requires_enforced_manifest_mutations_and_locked_routes() -> None:
    config = _enabled()
    judge = _plan(route="deck.judge.visual", profile="deck-visual-judge-v2")
    repair = _plan(route="deck.repair.executor", profile="deck-repair-executor-v1")

    with pytest.raises(DeckDesignLiftConfigError, match="manifest enforcement"):
        audit_deck_design_lift_startup(
            config,
            judge_plan=judge,
            repair_plan=repair,
            manifest_mode="shadow",
            mutation_transactions_enabled=True,
        )
    with pytest.raises(DeckDesignLiftConfigError, match="mutation transactions"):
        audit_deck_design_lift_startup(
            config,
            judge_plan=judge,
            repair_plan=repair,
            manifest_mode="enforce",
            mutation_transactions_enabled=False,
        )

    audit_deck_design_lift_startup(
        config,
        judge_plan=judge,
        repair_plan=repair,
        manifest_mode="enforce",
        mutation_transactions_enabled=True,
    )


def test_startup_audit_rejects_capability_or_profile_drift() -> None:
    config = _enabled()
    judge = _plan(route="deck.judge.visual", profile="deck-visual-judge-v2")
    weak_repair = _plan(
        route="deck.repair.executor",
        profile="deck-repair-executor-v1",
        capabilities=frozenset({"strict_structured_output"}),
    )
    with pytest.raises(DeckDesignLiftConfigError, match="lacks required capabilities"):
        audit_deck_design_lift_startup(
            config,
            judge_plan=judge,
            repair_plan=weak_repair,
            manifest_mode="enforce",
            mutation_transactions_enabled=True,
        )
