from __future__ import annotations

import argparse
import json
import os
from decimal import Decimal
from functools import partial
from pathlib import Path
from typing import Any

import anyio
import httpx

from deerflow.config.app_config import AppConfig, reset_app_config, set_app_config
from deerflow.config.deck_quality_config import DeckQualityConfig, audit_deck_quality_startup
from deerflow.config.model_config import ModelConfig
from deerflow.config.model_route_config import HarnessProfileConfig, ModelRouteConfig
from deerflow.config.sandbox_config import SandboxConfig
from deerflow.models.route_resolver import ModelRouteResolver
from deerflow.sophia.deck_quality.adjudicator import (
    adjudicate_shadow_result,
    failed_to_judge_decision,
)
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.cost import (
    SOL_MAX_OUTPUT_TOKENS,
    exact_sol_preflight_admitted,
    sol_cost_usd,
)
from deerflow.sophia.deck_quality.evidence import (
    prepare_blind_visual_evidence,
    prepare_plan_realization_evidence,
    prove_coverage,
)
from deerflow.sophia.deck_quality.fixture_runner import load_corpus, load_fixture_inputs
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.invoker import (
    MultimodalStructuredModelInvoker,
    QualityInputTokenCount,
    QualityInvocationError,
    QualityInvocationResult,
)
from deerflow.sophia.deck_quality.mechanical import project_mechanical_truth
from deerflow.sophia.deck_quality.messages import (
    build_blind_visual_messages,
    build_plan_realization_messages,
)
from deerflow.sophia.deck_quality.plan import derive_plan_realization_inputs
from deerflow.sophia.deck_quality.prompts import load_prompt_pack
from deerflow.sophia.deck_quality.rubric import compile_rubric, projection_for
from deerflow.sophia.deck_quality.schemas import (
    BlindVisualAssessment,
    PlanRealizationAssessment,
    QualityError,
    QualityInstrumentLock,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = REPO_ROOT / "backend/tests/fixtures/deck_quality_shadow/corpus_evidence_v4.yaml"
DEFAULT_RUBRIC = REPO_ROOT / "skills/public/sophia/deck_rubric.yaml"
DEFAULT_PROMPTS = REPO_ROOT / "backend/packages/harness/deerflow/sophia/deck_quality/prompts"


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, default=str) + "\n",
        encoding="utf-8",
    )


def _app_config(api_key: str, *, http_async_client: httpx.AsyncClient) -> AppConfig:
    return AppConfig(
        models=[
            ModelConfig(
                name="openai-gpt-5-6-sol",
                display_name="OpenAI GPT-5.6 Sol",
                provider="openai",
                use="langchain_openai:ChatOpenAI",
                model="gpt-5.6-sol",
                api_key=api_key,
                http_async_client=http_async_client,
                supports_vision=True,
                supports_reasoning_effort=True,
                capabilities={
                    "image_input",
                    "multi_image_input",
                    "strict_structured_output",
                    "reasoning_effort",
                },
            )
        ],
        model_routes={
            "deck.judge.visual": ModelRouteConfig(
                primary="openai-gpt-5-6-sol",
                fallbacks=[],
                profile="deck-visual-judge-v2",
                required_capabilities={
                    "image_input",
                    "multi_image_input",
                    "strict_structured_output",
                    "reasoning_effort",
                },
                max_failovers=0,
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
                    "output_version": "responses/v1",
                    "use_responses_api": True,
                    "store": False,
                    "max_completion_tokens": 6_000,
                },
            )
        },
        deck_quality=DeckQualityConfig(
            enabled=True,
            mode="shadow",
            canary_user_ids={"synthetic-canary"},
            max_quality_cost_usd=Decimal("0.60"),
        ),
        sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
    )


def _invocation_cost_usd(result: QualityInvocationResult[Any]) -> Decimal:
    metrics = result.metrics
    input_tokens = metrics.input_tokens
    output_tokens = metrics.output_tokens
    total_tokens = metrics.total_tokens
    if (
        type(input_tokens) is not int
        or type(output_tokens) is not int
        or type(total_tokens) is not int
        or input_tokens < 0
        or output_tokens < 0
        or total_tokens != input_tokens + output_tokens
        or input_tokens != metrics.preflight_input_tokens
        or output_tokens > SOL_MAX_OUTPUT_TOKENS
    ):
        raise QualityInvocationError("structured_output_invalid")
    return sol_cost_usd(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _safe_preflight(count: QualityInputTokenCount | None) -> dict[str, Any] | None:
    if count is None:
        return None
    return {
        "input_tokens": count.input_tokens,
        "payload_hash": count.payload_hash,
    }


def _projected_preflight_cost_usd(
    assessment_a: QualityInputTokenCount,
    assessment_c: QualityInputTokenCount,
) -> Decimal:
    return sum(
        (
            sol_cost_usd(
                input_tokens=count.input_tokens,
                output_tokens=SOL_MAX_OUTPUT_TOKENS,
            )
            for count in (assessment_a, assessment_c)
        ),
        start=Decimal("0"),
    )


def _safe_invocation_error(error: QualityInvocationError, *, stage: str) -> dict[str, Any]:
    return {
        "schema_version": "deck-quality-smoke-error/v1",
        "stage": stage,
        "error_code": error.code,
        "provider_error_type": error.provider_error_type,
        "provider_status_code": error.provider_status_code,
        "validation_issues": error.validation_issues,
    }


async def run_smoke(
    *,
    corpus_path: Path,
    output_dir: Path,
    fixture_id: str,
) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for the opt-in Sol smoke")
    http_async_client = httpx.AsyncClient(timeout=httpx.Timeout(180.0))
    config = _app_config(api_key, http_async_client=http_async_client)
    set_app_config(config)
    try:
        plan = ModelRouteResolver(config).resolve(route_name="deck.judge.visual")
        audit_deck_quality_startup(config.deck_quality, resolved_plan=plan)
        corpus = load_corpus(corpus_path)
        fixture = next(
            (item for item in corpus.fixtures if item.id == fixture_id),
            None,
        )
        if fixture is None:
            raise ValueError("requested deck-quality fixture is not in the corpus")
        snapshot = load_fixture_inputs(fixture, root=corpus_path.parent)
        rubric = compile_rubric(DEFAULT_RUBRIC)
        blind_rubric = projection_for(rubric, "blind_visual")
        plan_rubric = projection_for(rubric, "plan_realization")
        prompts = load_prompt_pack(DEFAULT_PROMPTS)
        plan_inputs = derive_plan_realization_inputs(
            creative_plan=snapshot.creative_plan,
            design_plan=snapshot.design_plan,
            selectors=snapshot.renders.selectors,
            explicit_style_constraints=snapshot.brief.explicit_brand_style_constraints,
        )
        policy = rubric.document.adjudication
        instrument = QualityInstrumentLock(
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
        quality_run_id = derive_quality_run_id(
            artifact_version_id=snapshot.artifact_version_id,
            campaign_id=snapshot.campaign_id,
            instrument=instrument,
        )
        invoker = MultimodalStructuredModelInvoker()
        output_dir.mkdir(parents=True, exist_ok=True)
        _write_json(output_dir / "instrument.json", instrument.model_dump(mode="json"))

        blind_evidence = prepare_blind_visual_evidence(snapshot, blind_rubric)
        plan_evidence = prepare_plan_realization_evidence(
            snapshot,
            rubric=plan_rubric,
            subject_materials=plan_inputs.subject_materials,
            signature=plan_inputs.signature,
            rhythm=plan_inputs.rhythm,
            commitments=plan_inputs.commitments,
            explicit_style_constraints=plan_inputs.explicit_style_constraints,
        )
        blind_messages = build_blind_visual_messages(
            blind_evidence,
            prompts.blind_visual,
        )
        plan_messages = build_plan_realization_messages(
            plan_evidence,
            prompts.plan_realization,
        )
        assessment_a_preflight: QualityInputTokenCount | None = None
        assessment_c_preflight: QualityInputTokenCount | None = None
        projected_max_cost: Decimal | None = None
        preflight_admitted: bool | None = None
        cost_cap = config.deck_quality.max_quality_cost_usd
        if cost_cap is None:
            raise RuntimeError("quality smoke requires an explicit cost cap")

        def safe_metrics(
            *,
            assessment_a: dict[str, Any] | None,
            assessment_c: dict[str, Any] | None,
            assessment_c_skipped_reason: str | None,
            assessment_c_error: dict[str, Any] | None,
            total_cost_usd: Decimal | None,
        ) -> dict[str, Any]:
            return {
                "schema_version": "deck-quality-smoke-metrics/v2",
                "quality_run_id": quality_run_id,
                "fixture_id": fixture_id,
                "model": "gpt-5.6-sol",
                "route": plan.route_name,
                "profile_version": plan.profile_version,
                "evidence_preprocessor_version": instrument.evidence_preprocessor_version,
                "judge_invoker_version": instrument.judge_invoker_version,
                "image_count_per_assessment": 1 + snapshot.renders.expected_slide_count,
                "contact_sheet_image_detail": "high",
                "individual_slide_image_detail": "original",
                "lossless_png_inputs": True,
                "adaptive_downsample": False,
                "resume_assessment_a": False,
                "reasoning": {
                    "effort": "high",
                    "mode": "standard",
                    "context": "current_turn",
                },
                "store": False,
                "previous_response_reused": False,
                "safety_identifier_present": True,
                "structured_output_method": "json_schema_strict",
                "cost_preflight": {
                    "assessment_a": _safe_preflight(assessment_a_preflight),
                    "assessment_c": _safe_preflight(assessment_c_preflight),
                    "projected_max_cost_usd": projected_max_cost,
                    "admitted": preflight_admitted,
                },
                "assessment_a": assessment_a,
                "assessment_c": assessment_c,
                "assessment_c_skipped_reason": assessment_c_skipped_reason,
                "assessment_c_error": assessment_c_error,
                "total_cost_usd": total_cost_usd,
                "configured_cost_cap_usd": cost_cap,
                "pricing_source": "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
            }

        def finish_failure(
            *,
            error: QualityInvocationError,
            stage: str,
            error_filename: str,
            visual: BlindVisualAssessment | None = None,
            mechanical: Any | None = None,
            visual_result: QualityInvocationResult[Any] | None = None,
            visual_cost: Decimal | None = None,
            assessment_c_skipped_reason: str | None = None,
        ) -> dict[str, Any]:
            safe_error = _safe_invocation_error(error, stage=stage)
            _write_json(output_dir / error_filename, safe_error)
            coverage = prove_coverage(snapshot, visual)
            decision = failed_to_judge_decision(
                coverage=coverage,
                rubric_hash=rubric.sha256,
                policy=policy,
                errors=(QualityError(code=error.code, stage=stage),),
                visual=visual,
                mechanical=mechanical,
            )
            _write_json(output_dir / "decision.json", decision.model_dump(mode="json"))
            assessment_a_metrics = (
                {**visual_result.metrics.__dict__, "cost_usd": visual_cost}
                if visual_result is not None
                else None
            )
            _write_json(
                output_dir / "safe_metrics.json",
                safe_metrics(
                    assessment_a=assessment_a_metrics,
                    assessment_c=None,
                    assessment_c_skipped_reason=assessment_c_skipped_reason,
                    assessment_c_error=(
                        safe_error if error_filename == "error_c.json" else None
                    ),
                    total_cost_usd=visual_cost,
                ),
            )
            return {
                "quality_run_id": quality_run_id,
                "fixture_id": fixture_id,
                "decision": decision.result,
                "mechanical": getattr(mechanical, "status", None),
                "coverage": coverage.complete,
                "total_cost_usd": (
                    str(visual_cost) if visual_cost is not None else None
                ),
                "output_dir": output_dir.as_posix(),
            }

        try:
            assessment_a_request = invoker.prepare_request(
                plan=plan,
                schema=BlindVisualAssessment,
                messages=blind_messages,
                campaign_id=snapshot.campaign_id,
                canary_user_id=snapshot.user_id,
            )
        except QualityInvocationError as error:
            return finish_failure(
                error=error,
                stage="assessment_a_prepare",
                error_filename="error_a.json",
            )
        try:
            assessment_c_request = invoker.prepare_request(
                plan=plan,
                schema=PlanRealizationAssessment,
                messages=plan_messages,
                campaign_id=snapshot.campaign_id,
                canary_user_id=snapshot.user_id,
            )
        except QualityInvocationError as error:
            return finish_failure(
                error=error,
                stage="assessment_c_prepare",
                error_filename="error_c.json",
                assessment_c_skipped_reason="assessment_c_prepare_error",
            )
        try:
            assessment_a_preflight = await invoker.count_input_tokens(
                request=assessment_a_request,
                timeout_seconds=180,
            )
        except QualityInvocationError as error:
            return finish_failure(
                error=error,
                stage="assessment_a_preflight",
                error_filename="error_a.json",
            )
        try:
            assessment_c_preflight = await invoker.count_input_tokens(
                request=assessment_c_request,
                timeout_seconds=180,
            )
        except QualityInvocationError as error:
            return finish_failure(
                error=error,
                stage="assessment_c_preflight",
                error_filename="error_c.json",
                assessment_c_skipped_reason="assessment_c_preflight_error",
            )

        projected_max_cost = _projected_preflight_cost_usd(
            assessment_a_preflight,
            assessment_c_preflight,
        )
        preflight_admitted = exact_sol_preflight_admitted(
            input_token_counts=(
                assessment_a_preflight.input_tokens,
                assessment_c_preflight.input_tokens,
            ),
            max_calls=2,
            cost_cap_usd=cost_cap,
        )
        if not preflight_admitted:
            return finish_failure(
                error=QualityInvocationError("judge_unavailable"),
                stage="cost_preflight",
                error_filename="error_preflight.json",
                assessment_c_skipped_reason="cost_preflight_rejected",
            )

        try:
            visual_result = await invoker.invoke(
                request=assessment_a_request,
                plan=plan,
                timeout_seconds=180,
                preflight=assessment_a_preflight,
            )
            visual_cost = _invocation_cost_usd(visual_result)
        except QualityInvocationError as error:
            return finish_failure(
                error=error,
                stage="assessment_a",
                error_filename="error_a.json",
            )
        visual = visual_result.parsed
        _write_json(output_dir / "assessment_a_visual.json", visual.model_dump(mode="json"))
        mechanical = project_mechanical_truth(snapshot)
        _write_json(output_dir / "assessment_b_mechanical.json", mechanical.model_dump(mode="json"))
        coverage = prove_coverage(snapshot, visual)
        plan_result = None
        plan_cost = None
        plan_error = None
        plan_error_stage = "assessment_c"
        plan_call_attempted = False
        if coverage.complete and mechanical.status == "passed":
            c_admitted_after_a = exact_sol_preflight_admitted(
                input_token_counts=(assessment_c_preflight.input_tokens,),
                spent_usd=visual_cost,
                max_calls=1,
                cost_cap_usd=cost_cap,
            )
            if not c_admitted_after_a:
                plan_error = QualityInvocationError("judge_unavailable")
                plan_error_stage = "assessment_c_cost_recheck"
                _write_json(
                    output_dir / "error_c.json",
                    _safe_invocation_error(plan_error, stage=plan_error_stage),
                )
            else:
                plan_call_attempted = True
                try:
                    plan_result = await invoker.invoke(
                        request=assessment_c_request,
                        plan=plan,
                        timeout_seconds=180,
                        preflight=assessment_c_preflight,
                    )
                    plan_cost = _invocation_cost_usd(plan_result)
                except QualityInvocationError as error:
                    plan_error = error
                    _write_json(
                        output_dir / "error_c.json",
                        _safe_invocation_error(error, stage=plan_error_stage),
                    )
                else:
                    _write_json(
                        output_dir / "assessment_c_plan_realization.json",
                        plan_result.parsed.model_dump(mode="json"),
                    )
        all_criteria = (*blind_rubric.criteria, *plan_rubric.criteria)
        if plan_error:
            decision = failed_to_judge_decision(
                coverage=coverage,
                rubric_hash=rubric.sha256,
                policy=policy,
                errors=(QualityError(code=plan_error.code, stage=plan_error_stage),),
                visual=visual,
                mechanical=mechanical,
            )
        else:
            decision = adjudicate_shadow_result(
                coverage=coverage,
                visual=visual,
                mechanical=mechanical,
                plan=plan_result.parsed if plan_result else None,
                criteria=all_criteria,
                expected_plan_commitment_ids=tuple(item.commitment_id for item in plan_inputs.commitments),
                rubric_hash=rubric.sha256,
                policy=policy,
            )
        total_cost = (
            None
            if plan_error is not None and plan_call_attempted
            else visual_cost + (plan_cost or Decimal("0"))
        )
        if total_cost is not None and total_cost > config.deck_quality.max_quality_cost_usd:
            raise RuntimeError("quality smoke exceeded its configured cost cap")
        _write_json(output_dir / "decision.json", decision.model_dump(mode="json"))
        assessment_c_skipped_reason = (
            None
            if plan_result
            else (
                "assessment_c_cost_recheck_rejected"
                if plan_error_stage == "assessment_c_cost_recheck"
                else (
                    "assessment_c_error"
                    if plan_error
                    else "coverage_or_mechanical_precondition_failed"
                )
            )
        )
        metrics = safe_metrics(
            assessment_a={
                **visual_result.metrics.__dict__,
                "cost_usd": visual_cost,
            },
            assessment_c=(
                {**plan_result.metrics.__dict__, "cost_usd": plan_cost}
                if plan_result
                else None
            ),
            assessment_c_skipped_reason=assessment_c_skipped_reason,
            assessment_c_error=(
                _safe_invocation_error(plan_error, stage=plan_error_stage)
                if plan_error
                else None
            ),
            total_cost_usd=total_cost,
        )
        _write_json(output_dir / "safe_metrics.json", metrics)
        return {
            "quality_run_id": quality_run_id,
            "fixture_id": fixture_id,
            "decision": decision.result,
            "mechanical": mechanical.status,
            "coverage": coverage.complete,
            "total_cost_usd": str(total_cost) if total_cost is not None else None,
            "output_dir": output_dir.as_posix(),
        }
    finally:
        reset_app_config()
        await http_async_client.aclose()


def main() -> int:
    parser = argparse.ArgumentParser(description="Opt-in GPT-5.6 Sol DQ-1 multimodal smoke")
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    result = anyio.run(
        partial(
            run_smoke,
            corpus_path=args.corpus,
            fixture_id=args.fixture_id,
            output_dir=args.output_dir,
        )
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
