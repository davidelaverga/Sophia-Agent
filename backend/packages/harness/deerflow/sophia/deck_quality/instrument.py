from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict

from deerflow.config.app_config import AppConfig
from deerflow.config.deck_quality_config import audit_deck_quality_startup
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.models.route_resolver import ModelRouteResolver
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.prompts import PromptPack, load_prompt_pack
from deerflow.sophia.deck_quality.rubric import (
    CompiledRubric,
    compile_rubric,
    projection_for,
    verify_rubric_lock,
)
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    QualityInstrumentLock,
    RubricCriterionProjection,
    RubricProjection,
)

_REPO_ROOT = Path(__file__).resolve().parents[6]
DEFAULT_RUBRIC_PATH = _REPO_ROOT / "skills/public/sophia/deck_rubric.yaml"
DEFAULT_RUBRIC_LOCK_PATH = _REPO_ROOT / "skills/public/sophia/deck_rubric.lock.json"
DEFAULT_PROMPT_ROOT = Path(__file__).resolve().parent / "prompts"


class DeckQualityRuntimeInstrument(BaseModel):
    """Fully resolved, hash-locked DQ-1 measurement instrument."""

    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    plan: ResolvedModelPlan
    rubric: CompiledRubric
    blind_rubric: RubricProjection
    plan_rubric: RubricProjection
    all_criteria: tuple[RubricCriterionProjection, ...]
    prompts: PromptPack
    policy: AdjudicationPolicy
    lock: QualityInstrumentLock


def compile_runtime_instrument(
    config: AppConfig,
    *,
    rubric_path: Path = DEFAULT_RUBRIC_PATH,
    rubric_lock_path: Path = DEFAULT_RUBRIC_LOCK_PATH,
    prompt_root: Path = DEFAULT_PROMPT_ROOT,
) -> DeckQualityRuntimeInstrument:
    """Resolve and verify every runtime-significant DQ-1 input.

    The function is intentionally deterministic. A prompt, rubric, route,
    profile, schema, preprocessor, invoker, or policy change creates a new
    instrument lock and therefore a new quality-run identity.
    """

    plan = ModelRouteResolver(config).resolve(route_name=config.deck_quality.judge_route)
    deployment = config.get_model_deployment(plan.deployment_name)
    if deployment is None or deployment.access_scope != "route_only":
        raise ValueError("deck-quality judge deployment must be route-only")
    audit_deck_quality_startup(config.deck_quality, resolved_plan=plan)
    rubric = compile_rubric(rubric_path)
    verify_rubric_lock(rubric, rubric_lock_path)
    if config.deck_quality.rubric_version != rubric.document.version:
        raise ValueError("configured deck-quality rubric version does not match the committed lock")
    route = config.model_routes[config.deck_quality.judge_route]
    if config.deck_quality.judge_profile_version != route.profile:
        raise ValueError("configured deck-quality judge profile does not match the routed profile")

    blind_rubric = projection_for(rubric, "blind_visual")
    plan_rubric = projection_for(rubric, "plan_realization")
    prompts = load_prompt_pack(prompt_root)
    policy = rubric.document.adjudication
    lock = QualityInstrumentLock(
        rubric_version=rubric.document.version,
        rubric_hash=rubric.sha256,
        prompt_hashes={
            "blind_visual": prompts.blind_visual.sha256,
            "plan_realization": prompts.plan_realization.sha256,
            "large_deck_consolidation": prompts.large_deck_consolidation.sha256,
        },
        judge_plan_hash=plan.plan_hash,
        judge_profile_version=plan.profile_version,
        evidence_preprocessor_version=config.deck_quality.evidence_preprocessor_version,
        judge_invoker_version=config.deck_quality.judge_invoker_version,
        assessment_schema_versions={
            "blind_visual": "deck-quality-blind-assessment/v4",
            "mechanical": "deck-quality-mechanical-projection/v1",
            "plan_realization": "deck-quality-plan-assessment/v4",
        },
        adjudication_policy_hash=canonical_sha256(policy),
    )
    return DeckQualityRuntimeInstrument(
        plan=plan,
        rubric=rubric,
        blind_rubric=blind_rubric,
        plan_rubric=plan_rubric,
        all_criteria=tuple(blind_rubric.criteria) + tuple(plan_rubric.criteria),
        prompts=prompts,
        policy=policy,
        lock=lock,
    )
