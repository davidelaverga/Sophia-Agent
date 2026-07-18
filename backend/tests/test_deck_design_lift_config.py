from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest

from deerflow.config.deck_design_lift_config import (
    DeckDesignLiftConfig,
    DeckDesignLiftConfigError,
    audit_deck_design_lift_startup,
)
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.build_runtime.startup import (
    BuildFoundationStartupError,
    audit_deck_design_lift_builder_service_startup,
)
from deerflow.sophia.builder_event_auth import BUILDER_EVENT_HMAC_SECRET_ENV

_INVOCATION_SECRET = "0123456789abcdef0123456789abcdef"


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
            enforce_canary_user_ids=frozenset(),
            mutation_transactions_enabled=True,
        )
    with pytest.raises(DeckDesignLiftConfigError, match="mutation transactions"):
        audit_deck_design_lift_startup(
            config,
            judge_plan=judge,
            repair_plan=repair,
            manifest_mode="canary_enforce",
            enforce_canary_user_ids=config.canary_user_ids,
            mutation_transactions_enabled=False,
        )

    audit_deck_design_lift_startup(
        config,
        judge_plan=judge,
        repair_plan=repair,
        manifest_mode="canary_enforce",
        enforce_canary_user_ids=config.canary_user_ids,
        mutation_transactions_enabled=True,
    )

    with pytest.raises(DeckDesignLiftConfigError, match="scopes must match"):
        audit_deck_design_lift_startup(
            config,
            judge_plan=judge,
            repair_plan=repair,
            manifest_mode="canary_enforce",
            enforce_canary_user_ids=frozenset({"different-canary"}),
            mutation_transactions_enabled=True,
        )

    with pytest.raises(DeckDesignLiftConfigError, match="exact-canary"):
        audit_deck_design_lift_startup(
            config,
            judge_plan=judge,
            repair_plan=repair,
            manifest_mode="enforce",
            enforce_canary_user_ids=frozenset(),
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
            manifest_mode="canary_enforce",
            enforce_canary_user_ids=config.canary_user_ids,
            mutation_transactions_enabled=True,
        )


def test_service_startup_audit_proves_routes_storage_and_mutation_rpcs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.models import route_resolver
    from deerflow.sophia.build_runtime import startup
    from deerflow.sophia.storage import build_mutation_store

    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _INVOCATION_SECRET)

    canaries = frozenset({"canary-user"})
    config = SimpleNamespace(
        deck_design_lift=_enabled(),
        deck_quality=SimpleNamespace(enabled=True, canary_user_ids=canaries),
        build_foundation=SimpleNamespace(
            manifest_mode="canary_enforce",
            enforce_canary_user_ids=canaries,
            enable_mutation_transactions=True,
        ),
    )
    calls: list[str] = []

    class _Resolver:
        def __init__(self, resolved_config: object) -> None:
            assert resolved_config is config

        def resolve(self, *, route_name: str) -> ResolvedModelPlan:
            profile = "deck-visual-judge-v2" if route_name == "deck.judge.visual" else "deck-repair-executor-v1"
            return _plan(route=route_name, profile=profile)

    class _Store:
        def probe(self) -> None:
            calls.append("probe")

        def close(self) -> None:
            calls.append("close")

    monkeypatch.setattr(route_resolver, "ModelRouteResolver", _Resolver)
    monkeypatch.setattr(startup, "validate_expected_supabase_project", lambda: None)
    monkeypatch.setattr(startup.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setattr(
        build_mutation_store,
        "configured_build_mutation_store",
        lambda *, canary_user_ids: (_Store() if canary_user_ids == canaries else None),
    )

    audit_deck_design_lift_builder_service_startup(config=config)

    assert calls == ["probe", "close"]


def test_service_startup_rejects_missing_private_invocation_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(BUILDER_EVENT_HMAC_SECRET_ENV, raising=False)
    config = SimpleNamespace(deck_design_lift=_enabled())

    with pytest.raises(
        BuildFoundationStartupError,
        match="private invocation authentication",
    ):
        audit_deck_design_lift_builder_service_startup(config=config)


def test_service_startup_audit_rejects_scope_drift_and_missing_rpc_surface(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.models import route_resolver
    from deerflow.sophia.build_runtime import startup
    from deerflow.sophia.storage import build_mutation_store

    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _INVOCATION_SECRET)

    config = SimpleNamespace(
        deck_design_lift=_enabled(),
        deck_quality=SimpleNamespace(
            enabled=True,
            canary_user_ids=frozenset({"different-canary"}),
        ),
        build_foundation=SimpleNamespace(
            manifest_mode="canary_enforce",
            enforce_canary_user_ids=frozenset({"canary-user"}),
            enable_mutation_transactions=True,
        ),
    )
    with pytest.raises(BuildFoundationStartupError, match="scopes must match"):
        audit_deck_design_lift_builder_service_startup(config=config)

    config.deck_quality.canary_user_ids = frozenset({"canary-user"})

    class _Resolver:
        def __init__(self, _config: object) -> None:
            pass

        def resolve(self, *, route_name: str) -> ResolvedModelPlan:
            profile = "deck-visual-judge-v2" if route_name == "deck.judge.visual" else "deck-repair-executor-v1"
            return _plan(route=route_name, profile=profile)

    class _Store:
        closed = False

        def probe(self) -> None:
            raise RuntimeError("missing RPC")

        def close(self) -> None:
            self.closed = True

    store = _Store()
    monkeypatch.setattr(route_resolver, "ModelRouteResolver", _Resolver)
    monkeypatch.setattr(startup, "validate_expected_supabase_project", lambda: None)
    monkeypatch.setattr(startup.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setattr(
        build_mutation_store,
        "configured_build_mutation_store",
        lambda **_kwargs: store,
    )

    with pytest.raises(BuildFoundationStartupError, match="transaction RPCs"):
        audit_deck_design_lift_builder_service_startup(config=config)
    assert store.closed is True
