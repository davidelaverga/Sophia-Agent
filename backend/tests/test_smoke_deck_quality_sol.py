from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from deerflow.sophia.deck_quality.invoker import (
    QualityInputTokenCount,
    QualityInvocationMetrics,
    QualityInvocationResult,
)
from deerflow.sophia.deck_quality.schemas import (
    BlindVisualAssessment,
    PlanRealizationAssessment,
)
from scripts import smoke_deck_quality_sol as smoke

FIXTURE_ID = "clean_underdesigned_psi_v1_evidence_v4"


@dataclass(frozen=True)
class _Prepared:
    schema: type[Any]
    payload_hash: str


class _FakeInvoker:
    def __init__(
        self,
        *,
        input_counts: tuple[int, int] = (22_633, 23_671),
        output_counts: tuple[int, int] = (100, 100),
    ) -> None:
        self.input_counts = input_counts
        self.output_counts = output_counts
        self.events: list[str] = []

    def prepare_request(self, *, schema: type[Any], **_kwargs: Any) -> _Prepared:
        operation = "a" if schema is BlindVisualAssessment else "c"
        self.events.append(f"prepare_{operation}")
        return _Prepared(
            schema=schema,
            payload_hash=("a" if operation == "a" else "c") * 64,
        )

    async def count_input_tokens(
        self,
        *,
        request: _Prepared,
        **_kwargs: Any,
    ) -> QualityInputTokenCount:
        index = 0 if request.schema is BlindVisualAssessment else 1
        operation = "a" if index == 0 else "c"
        self.events.append(f"count_{operation}")
        return QualityInputTokenCount(
            input_tokens=self.input_counts[index],
            payload_hash=request.payload_hash,
        )

    async def invoke(
        self,
        *,
        request: _Prepared,
        preflight: QualityInputTokenCount,
        plan: Any,
        **_kwargs: Any,
    ) -> QualityInvocationResult[Any]:
        index = 0 if request.schema is BlindVisualAssessment else 1
        operation = "a" if index == 0 else "c"
        self.events.append(f"invoke_{operation}")
        selectors = tuple(f"slide:{value}" for value in range(1, 6))
        parsed: BlindVisualAssessment | PlanRealizationAssessment
        if request.schema is BlindVisualAssessment:
            parsed = BlindVisualAssessment(
                coverage_confirmed=True,
                evaluated_selectors=selectors,
                overall_impression="Complete synthetic coverage.",
                criterion_scores=(),
                confidence=1,
            )
        else:
            parsed = PlanRealizationAssessment(
                evaluated_selectors=selectors,
                commitments=(),
                criterion_scores=(),
                confidence=1,
            )
        output_tokens = self.output_counts[index]
        return QualityInvocationResult(
            parsed=parsed,
            metrics=QualityInvocationMetrics(
                latency_ms=1,
                input_tokens=preflight.input_tokens,
                output_tokens=output_tokens,
                total_tokens=preflight.input_tokens + output_tokens,
                deployment_name=plan.deployment_name,
                provider=plan.provider,
                provider_model=plan.provider_model,
                route_name=plan.route_name,
                profile_version=plan.profile_version,
                plan_hash=plan.plan_hash,
                preflight_input_tokens=preflight.input_tokens,
                preflight_payload_hash=preflight.payload_hash,
            ),
        )


def _install_fake(
    monkeypatch: pytest.MonkeyPatch,
    fake: _FakeInvoker,
) -> None:
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        smoke,
        "MultimodalStructuredModelInvoker",
        lambda: fake,
    )


@pytest.mark.anyio
async def test_v4_smoke_counts_both_payloads_before_either_inference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeInvoker()
    _install_fake(monkeypatch, fake)

    result = await smoke.run_smoke(
        corpus_path=smoke.DEFAULT_CORPUS,
        fixture_id=FIXTURE_ID,
        output_dir=tmp_path,
    )

    assert fake.events == [
        "prepare_a",
        "prepare_c",
        "count_a",
        "count_c",
        "invoke_a",
        "invoke_c",
    ]
    assert result["fixture_id"] == FIXTURE_ID
    metrics = json.loads((tmp_path / "safe_metrics.json").read_text())
    assert metrics["schema_version"] == "deck-quality-smoke-metrics/v2"
    assert metrics["evidence_preprocessor_version"] == "deck-evidence-v4"
    assert metrics["judge_invoker_version"] == "deck-judge-invoker-v4"
    assert metrics["cost_preflight"] == {
        "admitted": True,
        "assessment_a": {
            "input_tokens": 22_633,
            "payload_hash": "a" * 64,
        },
        "assessment_c": {
            "input_tokens": 23_671,
            "payload_hash": "c" * 64,
        },
        "projected_max_cost_usd": "0.591520",
    }
    assert metrics["adaptive_downsample"] is False
    assert metrics["resume_assessment_a"] is False


@pytest.mark.anyio
async def test_over_cap_preflight_never_invokes_a_or_c(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeInvoker(input_counts=(24_198, 25_236))
    _install_fake(monkeypatch, fake)

    result = await smoke.run_smoke(
        corpus_path=smoke.DEFAULT_CORPUS,
        fixture_id=FIXTURE_ID,
        output_dir=tmp_path,
    )

    assert fake.events == ["prepare_a", "prepare_c", "count_a", "count_c"]
    assert result["decision"] == "failed_to_judge"
    metrics = json.loads((tmp_path / "safe_metrics.json").read_text())
    assert metrics["cost_preflight"]["admitted"] is False
    assert metrics["assessment_a"] is None
    assert metrics["assessment_c"] is None
    assert metrics["assessment_c_skipped_reason"] == "cost_preflight_rejected"
    error = json.loads((tmp_path / "error_preflight.json").read_text())
    assert error == {
        "error_code": "judge_unavailable",
        "provider_error_type": None,
        "provider_status_code": None,
        "schema_version": "deck-quality-smoke-error/v1",
        "stage": "cost_preflight",
        "validation_issues": [],
    }


@pytest.mark.anyio
async def test_actual_a_cost_is_rechecked_before_c(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeInvoker(input_counts=(1_000, 1_000))
    _install_fake(monkeypatch, fake)
    monkeypatch.setattr(
        smoke,
        "_invocation_cost_usd",
        lambda _result: smoke.Decimal("0.575"),
    )

    result = await smoke.run_smoke(
        corpus_path=smoke.DEFAULT_CORPUS,
        fixture_id=FIXTURE_ID,
        output_dir=tmp_path,
    )

    assert fake.events == [
        "prepare_a",
        "prepare_c",
        "count_a",
        "count_c",
        "invoke_a",
    ]
    assert result["total_cost_usd"] == "0.575"
    metrics = json.loads((tmp_path / "safe_metrics.json").read_text())
    assert metrics["assessment_c_skipped_reason"] == (
        "assessment_c_cost_recheck_rejected"
    )
    assert metrics["assessment_c"] is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("output_tokens", "total_tokens"),
    [
        (6_001, 7_001),
        (100, 1_099),
    ],
)
async def test_invalid_a_usage_fails_closed_before_c(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    output_tokens: int,
    total_tokens: int,
) -> None:
    fake = _FakeInvoker(input_counts=(1_000, 1_000), output_counts=(output_tokens, 100))
    original_invoke = fake.invoke

    async def invoke_with_usage_drift(**kwargs: Any) -> QualityInvocationResult[Any]:
        result = await original_invoke(**kwargs)
        if kwargs["request"].schema is not BlindVisualAssessment:
            return result
        metrics = result.metrics
        return QualityInvocationResult(
            parsed=result.parsed,
            metrics=QualityInvocationMetrics(
                **{
                    **metrics.__dict__,
                    "total_tokens": total_tokens,
                }
            ),
        )

    monkeypatch.setattr(fake, "invoke", invoke_with_usage_drift)
    _install_fake(monkeypatch, fake)

    result = await smoke.run_smoke(
        corpus_path=smoke.DEFAULT_CORPUS,
        fixture_id=FIXTURE_ID,
        output_dir=tmp_path,
    )

    assert fake.events == [
        "prepare_a",
        "prepare_c",
        "count_a",
        "count_c",
        "invoke_a",
    ]
    assert result["decision"] == "failed_to_judge"
    assert not (tmp_path / "assessment_c_plan_realization.json").exists()
    error = json.loads((tmp_path / "error_a.json").read_text())
    assert error["error_code"] == "structured_output_invalid"


def test_v4_cli_requires_fixture_and_rejects_resume_a(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "smoke_deck_quality_sol.py",
            "--fixture-id",
            FIXTURE_ID,
            "--output-dir",
            str(tmp_path),
            "--resume-a",
            "assessment-a.json",
        ],
    )

    with pytest.raises(SystemExit, match="2"):
        smoke.main()
