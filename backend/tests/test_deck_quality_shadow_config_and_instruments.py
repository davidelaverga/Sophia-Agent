from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from deerflow.config.deck_quality_config import (
    REQUIRED_DECK_JUDGE_CAPABILITIES,
    DeckQualityConfig,
    DeckQualityConfigError,
    audit_deck_quality_startup,
)
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.instrument import compile_runtime_instrument
from deerflow.sophia.deck_quality.prompts import load_prompt_pack
from deerflow.sophia.deck_quality.rubric import (
    compile_rubric,
    projection_for,
    verify_rubric_lock,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock
from deerflow.sophia.deck_quality.scope import evaluate_canary_scope

REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPT_ROOT = REPO_ROOT / "backend/packages/harness/deerflow/sophia/deck_quality/prompts"
RUBRIC_PATH = REPO_ROOT / "skills/public/sophia/deck_rubric.yaml"
RUBRIC_LOCK_PATH = REPO_ROOT / "skills/public/sophia/deck_rubric.lock.json"


def _enabled_config(**overrides: object) -> DeckQualityConfig:
    values: dict[str, object] = {
        "enabled": True,
        "mode": "shadow",
        "canary_user_ids": {"canary-user"},
        "max_quality_cost_usd": Decimal("0.60"),
    }
    values.update(overrides)
    return DeckQualityConfig.model_validate(values)


def _resolved_plan(**overrides: object) -> ResolvedModelPlan:
    values: dict[str, object] = {
        "route_name": "deck.judge.visual",
        "deployment_name": "openai-gpt-5-6-sol",
        "provider": "openai",
        "provider_model": "gpt-5.6-sol",
        "profile_name": "deck-visual-judge-v2",
        "profile_version": "v2",
        "capabilities": REQUIRED_DECK_JUDGE_CAPABILITIES,
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


def _instrument(**overrides: object) -> QualityInstrumentLock:
    values: dict[str, object] = {
        "rubric_version": "deck-rubric-v1",
        "rubric_hash": "a" * 64,
        "prompt_hashes": {"blind": "b" * 64, "plan": "c" * 64},
        "judge_plan_hash": "d" * 64,
        "judge_profile_version": "deck-visual-judge-v2",
        "evidence_preprocessor_version": "deck-evidence-v4",
        "judge_invoker_version": "deck-judge-invoker-v4",
        "assessment_schema_versions": {"a": "v1", "c": "v1"},
        "adjudication_policy_hash": "e" * 64,
    }
    values.update(overrides)
    return QualityInstrumentLock.model_validate(values)


def test_config_defaults_are_off_shadow_only_and_non_authoritative() -> None:
    config = DeckQualityConfig()

    assert config.enabled is False
    assert config.mode == "off"
    assert config.scope == "canary"
    assert config.async_after_success is True
    assert config.mutate_artifact is False
    assert config.affect_delivery is False
    assert config.sample_rate == 0.0
    assert config.rubric_version == "deck-rubric-v2"
    assert config.evidence_preprocessor_version == "deck-evidence-v4"
    assert config.judge_invoker_version == "deck-judge-invoker-v4"
    assert config.max_quality_calls == 2


def test_runtime_instrument_compiles_every_identity_from_committed_inputs() -> None:
    from deerflow.config.app_config import AppConfig
    from deerflow.config.model_config import ModelConfig
    from deerflow.config.model_route_config import HarnessProfileConfig, ModelRouteConfig
    from deerflow.config.sandbox_config import SandboxConfig

    config = AppConfig(
        models=[
            ModelConfig(
                name="openai-gpt-5-6-sol",
                use="langchain_openai:ChatOpenAI",
                model="gpt-5.6-sol",
                access_scope="route_only",
                provider="openai",
                capabilities=REQUIRED_DECK_JUDGE_CAPABILITIES,
            )
        ],
        model_routes={
            "deck.judge.visual": ModelRouteConfig(
                primary="openai-gpt-5-6-sol",
                profile="deck-visual-judge-v2",
                required_capabilities=set(REQUIRED_DECK_JUDGE_CAPABILITIES),
            )
        },
        harness_profiles={
            "deck-visual-judge-v2": HarnessProfileConfig(
                version="v2",
                timeout_seconds=180,
                max_retries=0,
                model_overrides={
                    "reasoning": {
                        "effort": "high",
                        "mode": "standard",
                        "context": "current_turn",
                    },
                    "store": False,
                    "output_version": "responses/v1",
                    "use_responses_api": True,
                    "max_completion_tokens": 6000,
                },
            )
        },
        deck_quality=_enabled_config(),
        sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
    )

    runtime = compile_runtime_instrument(config)

    assert runtime.lock.rubric_version == "deck-rubric-v2"
    assert runtime.lock.rubric_hash == runtime.rubric.sha256
    assert runtime.lock.judge_plan_hash == runtime.plan.plan_hash
    assert runtime.lock.judge_profile_version == "v2"
    assert runtime.lock.assessment_schema_versions["blind_visual"].endswith("/v4")
    assert {item.id for item in runtime.all_criteria} == {item.id for item in runtime.rubric.document.criteria}

    public_judge = config.model_copy(
        update={
            "models": [
                config.models[0].model_copy(update={"access_scope": "public"})
            ]
        }
    )
    with pytest.raises(ValueError, match="judge deployment must be route-only"):
        compile_runtime_instrument(public_judge)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"mode": "off"}, "shadow authority"),
        ({"canary_user_ids": ()}, "at least one canary user ID"),
        ({"max_quality_cost_usd": None}, "explicit positive cost cap"),
        ({"max_quality_cost_usd": Decimal("0.61")}, "locked 0.60 USD cost cap"),
    ],
)
def test_enabled_config_fails_closed_without_required_shadow_guards(overrides: dict[str, object], message: str) -> None:
    values: dict[str, object] = {
        "enabled": True,
        "mode": "shadow",
        "canary_user_ids": {"canary-user"},
        "max_quality_cost_usd": Decimal("0.60"),
    }
    values.update(overrides)

    with pytest.raises(ValidationError, match=message):
        DeckQualityConfig.model_validate(values)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("mode", "enforce"),
        ("scope", "ordinary_users"),
        ("mutate_artifact", True),
        ("affect_delivery", True),
        ("sample_rate", 0.01),
        ("async_after_success", False),
        ("max_quality_calls", 8),
    ],
)
def test_prohibited_authority_states_are_unrepresentable(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        DeckQualityConfig.model_validate({field: value})

    with pytest.raises(ValidationError):
        DeckQualityConfig.model_validate({"enforcement_enabled": True})


def test_canary_user_string_is_normalized_and_config_is_frozen() -> None:
    config = _enabled_config(canary_user_ids=" alpha, beta,alpha, ")

    assert config.canary_user_ids == frozenset({"alpha", "beta"})
    with pytest.raises(ValidationError):
        config.enabled = False  # type: ignore[misc]


@pytest.mark.parametrize(
    "user_id",
    ["canary@example.com", "tenant:canary", "canary/user", "_canary", "x" * 129],
)
def test_enabled_config_rejects_noncanonical_canary_user_ids(user_id: str) -> None:
    with pytest.raises(ValidationError, match="canonical durable-path segments"):
        _enabled_config(canary_user_ids={user_id})


def test_startup_audit_is_noop_when_disabled_and_accepts_capable_route() -> None:
    audit_deck_quality_startup(DeckQualityConfig(), resolved_plan=None)
    audit_deck_quality_startup(_enabled_config(), resolved_plan=_resolved_plan())


def test_startup_audit_rejects_missing_mismatched_or_incapable_route() -> None:
    config = _enabled_config()

    with pytest.raises(DeckQualityConfigError, match="requires a resolved judge route"):
        audit_deck_quality_startup(config, resolved_plan=None)
    with pytest.raises(DeckQualityConfigError, match="does not match"):
        audit_deck_quality_startup(
            config,
            resolved_plan=_resolved_plan(route_name="builder.default"),
        )
    with pytest.raises(DeckQualityConfigError, match="multi_image_input"):
        audit_deck_quality_startup(
            config,
            resolved_plan=_resolved_plan(capabilities=REQUIRED_DECK_JUDGE_CAPABILITIES - {"multi_image_input"}),
        )


@pytest.mark.parametrize(
    ("overrides", "expected_reason"),
    [
        ({"user_id": "ordinary-user"}, "not_canary_user"),
        ({"builder_status": "failed"}, "builder_not_successful"),
        ({"artifact_type": "pdf"}, "artifact_not_pptx"),
        ({"artifact_downloadable": False}, "artifact_not_downloadable"),
        ({"authoritative_mechanical_passed": False}, "mechanical_not_passed"),
    ],
)
def test_scope_rejects_every_non_canary_or_non_success_condition(overrides: dict[str, object], expected_reason: str) -> None:
    inputs: dict[str, object] = {
        "user_id": "canary-user",
        "builder_status": "success",
        "artifact_type": "pptx",
        "artifact_downloadable": True,
        "authoritative_mechanical_passed": True,
    }
    inputs.update(overrides)

    decision = evaluate_canary_scope(_enabled_config(), **inputs)  # type: ignore[arg-type]

    assert decision.eligible is False
    assert decision.reason == expected_reason


def test_scope_is_disabled_by_default_and_accepts_only_exact_eligible_case() -> None:
    inputs = {
        "user_id": "canary-user",
        "builder_status": "COMPLETED",
        "artifact_type": ".PPTX",
        "artifact_downloadable": True,
        "authoritative_mechanical_passed": True,
    }

    assert evaluate_canary_scope(DeckQualityConfig(), **inputs).reason == "disabled"
    assert evaluate_canary_scope(_enabled_config(), **inputs).model_dump() == {
        "eligible": True,
        "reason": "eligible",
    }


def test_committed_prompt_pack_is_versioned_hashed_and_security_locked() -> None:
    first = load_prompt_pack(PROMPT_ROOT)
    second = load_prompt_pack(PROMPT_ROOT)

    assert first == second
    assert {first.blind_visual.version, first.plan_realization.version} == {"v4"}
    assert len({first.blind_visual.sha256, first.plan_realization.sha256}) == 2
    for prompt in (
        first.blind_visual,
        first.plan_realization,
        first.large_deck_consolidation,
    ):
        normalized = " ".join(prompt.content.casefold().split())
        assert "untrusted" in normalized
        assert "do not infer missing slides" in normalized
        assert "slide:n" in normalized

    blind = " ".join(first.blind_visual.content.casefold().split())
    plan = " ".join(first.plan_realization.content.casefold().split())
    assert "scores 2 and 4 are interpolation only" in blind
    assert "subject_specificity` cannot exceed 3" in blind
    assert "structural_variety_and_sequence_rhythm` cannot exceed 3" in blind
    assert "narrative_arc_and_pacing` cannot exceed 3" in blind
    assert "signature_realization` when it is generic" in plan
    assert "taste_score_range" in blind and "taste_score_range" in plan
    assert "attempting to infer policy" in blind


def test_prompt_loader_fails_when_a_security_clause_drifts(tmp_path: Path) -> None:
    for source in PROMPT_ROOT.glob("*.md"):
        content = source.read_text(encoding="utf-8")
        if source.name == "blind_visual_assessment_v4.md":
            content = content.replace("untrusted", "external")
        (tmp_path / source.name).write_text(content, encoding="utf-8")

    with pytest.raises(ValueError, match="untrusted"):
        load_prompt_pack(tmp_path)


def test_committed_rubric_matches_lock_and_owns_each_criterion_once() -> None:
    rubric = compile_rubric(RUBRIC_PATH)
    verify_rubric_lock(rubric, RUBRIC_LOCK_PATH)

    blind = projection_for(rubric, "blind_visual")
    plan = projection_for(rubric, "plan_realization")
    blind_ids = {criterion.id for criterion in blind.criteria}
    plan_ids = {criterion.id for criterion in plan.criteria}

    assert blind_ids
    assert plan_ids
    assert blind_ids.isdisjoint(plan_ids)
    assert blind_ids | plan_ids == {criterion.id for criterion in rubric.document.criteria}
    assert all(criterion.source_refs for criterion in rubric.document.criteria)
    assert all(rule.source_ref for rule in rubric.document.source_rules)
    assert rubric.document.version == "deck-rubric-v2"
    assert rubric.document.adjudication.critical_score_floor == 4
    assert rubric.document.adjudication.min_weighted_score == Decimal("3.5")


def test_rubric_lock_verification_detects_hash_drift(tmp_path: Path) -> None:
    rubric = compile_rubric(RUBRIC_PATH)
    lock = json.loads(RUBRIC_LOCK_PATH.read_text(encoding="utf-8"))
    lock["sha256"] = "0" * 64
    drifted = tmp_path / "deck_rubric.lock.json"
    drifted.write_text(json.dumps(lock), encoding="utf-8")

    with pytest.raises(ValueError, match="does not match"):
        verify_rubric_lock(rubric, drifted)


def test_quality_run_id_is_stable_for_canonical_instrument_and_changes_with_identity() -> None:
    first = derive_quality_run_id(
        artifact_version_id="artifact-version-1",
        campaign_id="DQ-1",
        instrument=_instrument(prompt_hashes={"blind": "b" * 64, "plan": "c" * 64}),
    )
    reordered = derive_quality_run_id(
        artifact_version_id="artifact-version-1",
        campaign_id="DQ-1",
        instrument=_instrument(prompt_hashes={"plan": "c" * 64, "blind": "b" * 64}),
    )
    changed_artifact = derive_quality_run_id(
        artifact_version_id="artifact-version-2",
        campaign_id="DQ-1",
        instrument=_instrument(),
    )
    changed_instrument = derive_quality_run_id(
        artifact_version_id="artifact-version-1",
        campaign_id="DQ-1",
        instrument=_instrument(rubric_hash="f" * 64),
    )

    assert first == reordered
    assert first.startswith("quality_")
    assert len(first.removeprefix("quality_")) == 64
    assert len({first, changed_artifact, changed_instrument}) == 3
