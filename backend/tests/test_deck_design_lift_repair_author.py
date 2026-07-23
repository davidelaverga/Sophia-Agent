from __future__ import annotations

import asyncio
import hashlib
import io
import json
import threading
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.deck_design_lift.invoker import (
    DeckRepairInputTokenCount,
    DeckRepairInvocationError,
    DeckRepairInvocationMetrics,
    DeckRepairInvocationResult,
    PreparedDeckRepairRequest,
)
from deerflow.sophia.deck_design_lift.repair_author import (
    MAX_REPAIR_CONTEXT_SOURCE_BYTES,
    DeckRepairAuthorError,
    ProductionDeckRepairAuthor,
    RepairAuthorContext,
    RepairAuthorContextIdentity,
    RepairBriefContext,
    RepairContextImage,
    RepairOwnedAssetContext,
    RepairPlanContext,
    RepairSkillExcerptContext,
    RepairSourceContext,
    _campaign_acceptance_contract,
    _candidate_materializes_priority_contract,
    _priority_geometry_sources_are_feasible,
    _retained_slide_css,
    _strict_geometry_candidate_rule,
    build_repair_author_messages,
    projected_repair_campaign_cost_usd,
    repair_preflight_admitted,
)
from deerflow.sophia.deck_design_lift.repair_tracing import (
    SafeDeckRepairTraceInput,
    SafeDeckRepairTraceOutput,
)
from deerflow.sophia.deck_design_lift.runtime import RepairInvocationRequest
from deerflow.sophia.deck_design_lift.schemas import (
    DeckRepairCandidate,
    DeckRepairProgram,
    RepairRenderEvidence,
    SelectorRepair,
    SkillRef,
    SourceUpdate,
)
from deerflow.sophia.deck_design_lift.slide_css_overlay import (
    SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR,
    compose_authenticated_slide_css,
    recover_authenticated_slide_css_overlay,
    repair_overlay_utf8_budget,
)
from deerflow.sophia.deck_quality.canonical import (
    canonical_json_bytes,
    canonical_sha256,
)
from deerflow.sophia.deck_quality.schemas import BlindBrief

HASH = "a" * 64
OTHER_HASH = "b" * 64
MANIFEST_HASH = "c" * 64
SKILL_SOURCE_HASH = "d" * 64
SOURCE_TEXT = "<section><h1>Current PSI control loop</h1></section>"
BASELINE_SLIDE_CSS_TEXT = ""
SLIDE_CSS_TEXT = (
    "section{font-size:32px;line-height:1.2;"
    "border:1px solid #0B1F3A;box-sizing:border-box}"
)
RETAINED_SLIDE_CSS_TEXT = (
    "section{font-size:32px;line-height:1.2;"
    "border:1px solid #0B1F3A;box-sizing:border-box;}"
)
DECK_CSS_TEXT = ":root{}*{box-sizing:border-box}"
SKILL_EXCERPT = "Use one subject-specific mechanism visual and preserve factual text."


def _run(awaitable):
    return asyncio.run(awaitable)


def _png_bytes(*, width: int = 64, height: int = 36, color: str = "navy") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color=color).save(buffer, format="PNG")
    return buffer.getvalue()


CONTACT_BYTES = _png_bytes(color="white")
RENDER_BYTES = _png_bytes(color="navy")
CONTACT_HASH = hashlib.sha256(CONTACT_BYTES).hexdigest()
RENDER_HASH = hashlib.sha256(RENDER_BYTES).hexdigest()
SOURCE_HASH = hashlib.sha256(SOURCE_TEXT.encode()).hexdigest()
SLIDE_CSS_HASH = hashlib.sha256(BASELINE_SLIDE_CSS_TEXT.encode()).hexdigest()
DECK_CSS_HASH = hashlib.sha256(DECK_CSS_TEXT.encode()).hexdigest()
SKILL_EXCERPT_HASH = hashlib.sha256(SKILL_EXCERPT.encode()).hexdigest()


def _plan() -> ResolvedModelPlan:
    return ResolvedModelPlan.model_validate(
        {
            "route_name": "deck.repair.executor",
            "deployment_name": "openai-gpt-5-6-sol",
            "provider": "openai",
            "provider_model": "gpt-5.6-sol",
            "profile_name": "deck-repair-executor-v1",
            "profile_version": "v1",
            "capabilities": frozenset(
                {
                    "image_input",
                    "multi_image_input",
                    "strict_structured_output",
                    "reasoning_effort",
                }
            ),
            "model_overrides": {
                "reasoning": {
                    "effort": "high",
                    "mode": "standard",
                    "context": "current_turn",
                },
                "output_version": "responses/v1",
                "use_responses_api": True,
                "store": False,
                "max_completion_tokens": 24_000,
                "timeout": 360,
                "max_retries": 0,
            },
            "plan_hash": HASH,
        }
    )


def _program(
    *,
    render_hash: str = RENDER_HASH,
    source_roles: tuple[str, ...] | None = None,
    failure_codes: tuple[str, ...] = (
        "weak_subject_specificity",
        "weak_signature_realization",
        "weak_mechanism_visualization",
    ),
) -> DeckRepairProgram:
    authorized_roles = source_roles or ("body", "slide_css")
    render = RepairRenderEvidence(
        selector="slide:1",
        path="renders/slide-1.png",
        sha256=render_hash,
    )
    skill = SkillRef(
        path="skills/public/hands-on-deck/designing-slides.md",
        source_hash=SKILL_SOURCE_HASH,
        excerpt_hash=SKILL_EXCERPT_HASH,
    )
    payload: dict[str, Any] = {
        "schema_version": "sophia-deck-repair-program/v1",
        "build_id": "build-psi-001",
        "initial_quality_run_id": "quality-initial-001",
        "initial_manifest_revision": 1,
        "repair_attempt": 1,
        "plan_revision_allowed": False,
        "authorized_selectors": ("slide:1",),
        "authorized_source_roles": {"slide:1": authorized_roles},
        "deck_instruction": "Repair only the frozen PSI mechanism slide.",
        "selector_repairs": (
            SelectorRepair(
                selector="slide:1",
                failure_codes=failure_codes,
                render_evidence=(render,),
                instruction="Make the PSI mechanism visible and subject-specific.",
                retained_content=("Preserve the PSI control-loop claim.",),
                allowed_asset_changes=("hero-asset",),
            ),
        ),
        "must_preserve": ("Preserve factual content and slide count.",),
        "must_not": ("Do not edit another selector.",),
        "skill_refs": (skill,),
        "expected_improvements": failure_codes,
        "forbidden_regressions": ("content_regression",),
        "rubric_version": "deck-quality-rubric-v1",
        "instrument_hash": OTHER_HASH,
    }
    payload["program_hash"] = canonical_sha256(payload)
    return DeckRepairProgram.model_validate(payload)


def _overlapping_three_selector_program() -> DeckRepairProgram:
    codes = (
        "weak_subject_specificity",
        "weak_signature_realization",
        "weak_mechanism_visualization",
    )
    payload = _program().model_dump(mode="python", exclude={"program_hash"})
    payload["authorized_selectors"] = ("slide:1", "slide:2", "slide:3")
    payload["authorized_source_roles"] = {
        selector: ("body", "slide_css")
        for selector in payload["authorized_selectors"]
    }
    payload["selector_repairs"] = (
        SelectorRepair(
            selector="slide:1",
            failure_codes=(codes[0], codes[1]),
            render_evidence=(
                RepairRenderEvidence(
                    selector="slide:1",
                    path="renders/slide-1.png",
                    sha256=RENDER_HASH,
                ),
            ),
            instruction="Make the subject anchor unmistakable.",
            retained_content=("Preserve the PSI control-loop claim.",),
            allowed_asset_changes=(),
        ),
        SelectorRepair(
            selector="slide:2",
            failure_codes=(codes[0],),
            render_evidence=(
                RepairRenderEvidence(
                    selector="slide:2",
                    path="renders/slide-2.png",
                    sha256=RENDER_HASH,
                ),
            ),
            instruction="Make the subject-specific mechanism dominant.",
            retained_content=("Preserve the mechanism.",),
            allowed_asset_changes=(),
        ),
        SelectorRepair(
            selector="slide:3",
            failure_codes=(codes[2],),
            render_evidence=(
                RepairRenderEvidence(
                    selector="slide:3",
                    path="renders/slide-3.png",
                    sha256=RENDER_HASH,
                ),
            ),
            instruction="Make the mechanism visibly directional.",
            retained_content=("Preserve the feedback loop.",),
            allowed_asset_changes=(),
        ),
    )
    payload["expected_improvements"] = codes
    payload["program_hash"] = canonical_sha256(payload)
    return DeckRepairProgram.model_validate(payload)


def _specificity_first_three_selector_program(
    *,
    reverse_input_order: bool = False,
) -> DeckRepairProgram:
    global_codes = (
        "default_look_gravity",
        "low_sequence_rhythm",
        "weak_signature_realization",
        "weak_subject_specificity",
    )
    local_codes = (
        "weak_mechanism_visualization",
        "weak_closing_synthesis",
    )
    selector_codes = (
        ("slide:1", global_codes),
        ("slide:2", (*global_codes, local_codes[0])),
        ("slide:5", (*global_codes, local_codes[1])),
    )
    expected_improvements = (*global_codes, *local_codes)
    if reverse_input_order:
        selector_codes = tuple(reversed(selector_codes))
        expected_improvements = tuple(reversed(expected_improvements))
    payload = _program().model_dump(mode="python", exclude={"program_hash"})
    payload["authorized_selectors"] = tuple(
        selector for selector, _codes in selector_codes
    )
    payload["authorized_source_roles"] = {
        selector: ("body", "slide_css")
        for selector in payload["authorized_selectors"]
    }
    payload["selector_repairs"] = tuple(
        SelectorRepair(
            selector=selector,
            failure_codes=(
                tuple(reversed(failure_codes))
                if reverse_input_order
                else failure_codes
            ),
            render_evidence=(
                RepairRenderEvidence(
                    selector=selector,
                    path=f"renders/{selector.replace(':', '-')}.png",
                    sha256=RENDER_HASH,
                ),
            ),
            instruction="Resolve the authenticated failures on this selector.",
            retained_content=("Preserve the PSI control-loop claim.",),
            allowed_asset_changes=(),
        )
        for selector, failure_codes in selector_codes
    )
    payload["expected_improvements"] = expected_improvements
    payload["program_hash"] = canonical_sha256(payload)
    return DeckRepairProgram.model_validate(payload)


def _deferred_only_authorized_selector_program() -> DeckRepairProgram:
    priority_codes = (
        "weak_subject_specificity",
        "weak_signature_realization",
        "weak_closing_synthesis",
    )
    deferred_code = "weak_memorability"
    payload = _program().model_dump(mode="python", exclude={"program_hash"})
    payload["authorized_selectors"] = ("slide:1", "slide:2", "slide:3")
    payload["authorized_source_roles"] = {
        selector: ("body", "slide_css")
        for selector in payload["authorized_selectors"]
    }
    payload["selector_repairs"] = tuple(
        SelectorRepair(
            selector=selector,
            failure_codes=failure_codes,
            render_evidence=(
                RepairRenderEvidence(
                    selector=selector,
                    path=f"renders/{selector.replace(':', '-')}.png",
                    sha256=RENDER_HASH,
                ),
            ),
            instruction="Make only the mapped failure visibly stronger.",
            retained_content=("Preserve the PSI control-loop claim.",),
            allowed_asset_changes=(),
        )
        for selector, failure_codes in (
            ("slide:1", priority_codes[:2]),
            ("slide:2", priority_codes[2:]),
            ("slide:3", (deferred_code,)),
        )
    )
    payload["expected_improvements"] = (*priority_codes, deferred_code)
    payload["program_hash"] = canonical_sha256(payload)
    return DeckRepairProgram.model_validate(payload)


def _deck_style_root_program() -> DeckRepairProgram:
    payload = _program().model_dump(mode="python", exclude={"program_hash"})
    selector_repair = dict(payload["selector_repairs"][0])
    selector_repair["selector"] = "deck-style:root"
    selector_repair["allowed_asset_changes"] = ()
    payload["authorized_selectors"] = ("deck-style:root",)
    payload["authorized_source_roles"] = {
        "deck-style:root": ("deck_css",),
    }
    payload["selector_repairs"] = (selector_repair,)
    payload["program_hash"] = canonical_sha256(payload)
    return DeckRepairProgram.model_validate(payload)


def _request(*, program: DeckRepairProgram | None = None) -> RepairInvocationRequest:
    return RepairInvocationRequest(
        campaign_run_id="campaign-dq2-001",
        experiment_id="experiment-dq2-001",
        user_id="user-canary-001",
        thread_id="thread-canary-001",
        build_id="build-psi-001",
        operation_id="operation-dq2-001",
        transaction_id="transaction-dq2-001",
        initial_artifact_version_id="artifact-initial-001",
        program=program or _program(),
    )


def _context(*, request: RepairInvocationRequest | None = None) -> RepairAuthorContext:
    request = request or _request()
    brief = BlindBrief(
        request="Build an editable five-slide PSI deck.",
        subject="Proportional-symbolic integration",
        audience="Product and engineering leaders",
        goal="Explain the control loop",
    )
    creative = {"story": "observe, integrate, act", "slide_count": 5}
    design = {"signature": "control-loop trace", "palette": ["ink", "cyan"]}
    metadata = {"role": "mechanism-photo", "semantic_text": False}
    sources = tuple(
        RepairSourceContext(
            build_id=request.build_id,
            manifest_revision=request.program.initial_manifest_revision,
            manifest_hash=MANIFEST_HASH,
            selector="slide:1",
            source_role=source_role,
            component_version_id="slide-1-version-001",
            manifest_source_path=f"versions/slide-1/{source_role}.txt",
            manifest_source_hash=(
                SLIDE_CSS_HASH if source_role == "slide_css" else SOURCE_HASH
            ),
            text=(
                BASELINE_SLIDE_CSS_TEXT
                if source_role == "slide_css"
                else SOURCE_TEXT
            ),
        )
        for source_role in request.program.authorized_source_roles["slide:1"]
    )
    return RepairAuthorContext(
        identity=RepairAuthorContextIdentity(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            user_id=request.user_id,
            thread_id=request.thread_id,
            build_id=request.build_id,
            operation_id=request.operation_id,
            transaction_id=request.transaction_id,
            initial_artifact_version_id=request.initial_artifact_version_id,
            repair_program_hash=request.program.program_hash,
            manifest_revision=request.program.initial_manifest_revision,
            manifest_hash=MANIFEST_HASH,
        ),
        brief=RepairBriefContext(
            artifact_version_id=request.initial_artifact_version_id,
            brief=brief,
            brief_hash=canonical_sha256(brief),
        ),
        plans=(
            RepairPlanContext(
                artifact_version_id=request.initial_artifact_version_id,
                role="creative_plan",
                content=creative,
                content_hash=canonical_sha256(creative),
            ),
            RepairPlanContext(
                artifact_version_id=request.initial_artifact_version_id,
                role="design_plan",
                content=design,
                content_hash=canonical_sha256(design),
            ),
        ),
        contact_sheet=RepairContextImage(
            artifact_version_id=request.initial_artifact_version_id,
            selector="contact-sheet",
            path="renders/contact-sheet.png",
            sha256=CONTACT_HASH,
            width=64,
            height=36,
            png_bytes=CONTACT_BYTES,
        ),
        failing_renders=(
            RepairContextImage(
                artifact_version_id=request.initial_artifact_version_id,
                selector="slide:1",
                path="renders/slide-1.png",
                sha256=RENDER_HASH,
                width=64,
                height=36,
                png_bytes=RENDER_BYTES,
            ),
        ),
        authorized_sources=sources,
        read_only_sources=(
            RepairSourceContext(
                build_id=request.build_id,
                manifest_revision=request.program.initial_manifest_revision,
                manifest_hash=MANIFEST_HASH,
                selector="deck-style:root",
                source_role="deck_css",
                component_version_id="deck-style-version-001",
                manifest_source_path=(
                    "versions/deck-style/deck.css"
                ),
                manifest_source_hash=DECK_CSS_HASH,
                text=DECK_CSS_TEXT,
            ),
        ),
        owned_assets=(
            RepairOwnedAssetContext(
                build_id=request.build_id,
                manifest_revision=request.program.initial_manifest_revision,
                manifest_hash=MANIFEST_HASH,
                selector="slide:1",
                asset_id="hero-asset",
                current_path="assets/hero.png",
                current_sha256=HASH,
                media_type="image/png",
                size_bytes=1_024,
                metadata=metadata,
                metadata_hash=canonical_sha256(metadata),
            ),
        ),
        skill_excerpts=(
            RepairSkillExcerptContext(
                path="skills/public/hands-on-deck/designing-slides.md",
                source_hash=SKILL_SOURCE_HASH,
                excerpt_hash=SKILL_EXCERPT_HASH,
                excerpt=SKILL_EXCERPT,
            ),
        ),
    )


def _context_with_slide_css_baseline(
    context: RepairAuthorContext,
    baseline_css: str,
) -> RepairAuthorContext:
    baseline_hash = hashlib.sha256(baseline_css.encode()).hexdigest()
    return context.model_copy(
        update={
            "authorized_sources": tuple(
                source.model_copy(
                    update={
                        "text": baseline_css,
                        "manifest_source_hash": baseline_hash,
                    }
                )
                if source.source_role == "slide_css"
                else source
                for source in context.authorized_sources
            )
        }
    )


def _candidate_with_slide_css_baseline_hash(
    candidate: DeckRepairCandidate,
    baseline_css: str,
) -> DeckRepairCandidate:
    baseline_hash = hashlib.sha256(baseline_css.encode()).hexdigest()
    return candidate.model_copy(
        update={
            "source_updates": tuple(
                update.model_copy(
                    update={"expected_source_hash": baseline_hash}
                )
                if update.source_role == "slide_css"
                else update
                for update in candidate.source_updates
            )
        }
    )


def _candidate(*, expected_source_hash: str = SOURCE_HASH) -> DeckRepairCandidate:
    return DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=expected_source_hash,
                content=(
                    '<section class="mechanism"><div>'
                    "<h1><span>Current PSI</span> <em>control loop</em></h1>"
                    "</div></section>"
                ),
            ),
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=SLIDE_CSS_TEXT,
            ),
        ),
        rationale="Strengthen the frozen PSI mechanism without collateral edits.",
    )


def _candidate_with_body(
    content: str,
    *,
    expected_source_hash: str = SOURCE_HASH,
) -> DeckRepairCandidate:
    candidate = _candidate(expected_source_hash=expected_source_hash)
    return candidate.model_copy(
        update={
            "source_updates": (
                candidate.source_updates[0].model_copy(
                    update={"content": content}
                ),
                candidate.source_updates[1],
            )
        }
    )


def _sized_slide_css(size_bytes: int) -> str:
    prefix = SLIDE_CSS_TEXT + "/*"
    suffix = "*/"
    assert size_bytes >= len((prefix + suffix).encode())
    return prefix + ("x" * (size_bytes - len(prefix.encode()) - len(suffix.encode()))) + suffix


def _sized_baseline_slide_css(size_bytes: int) -> str:
    prefix = "section{width:1px}/*"
    suffix = "*/"
    assert size_bytes >= len((prefix + suffix).encode())
    return prefix + ("x" * (size_bytes - len(prefix.encode()) - len(suffix.encode()))) + suffix


def _prepared() -> PreparedDeckRepairRequest:
    payload = canonical_json_bytes({"input": [], "model": "gpt-5.6-sol"})
    return PreparedDeckRepairRequest(
        root_async_client=SimpleNamespace(),
        provider_payload_json=payload,
        payload_hash=hashlib.sha256(payload).hexdigest(),
        deployment_name="openai-gpt-5-6-sol",
        provider="openai",
        provider_model="gpt-5.6-sol",
        route_name="deck.repair.executor",
        profile_version="v1",
        plan_hash=HASH,
    )


class FakeContextLoader:
    def __init__(self, value: object) -> None:
        self.value = value
        self.error: Exception | None = None
        self.calls: list[RepairInvocationRequest] = []

    async def load(self, request: RepairInvocationRequest) -> Any:
        self.calls.append(request)
        if self.error is not None:
            raise self.error
        return self.value


class FakeTwoPhaseInvoker:
    def __init__(
        self,
        *,
        candidate: DeckRepairCandidate | None = None,
        input_tokens: int = 200,
    ) -> None:
        self.prepared = _prepared()
        self.input_tokens = input_tokens
        self.result = DeckRepairInvocationResult(
            candidate=candidate or _candidate(),
            metrics=DeckRepairInvocationMetrics(
                latency_ms=100,
                input_tokens=input_tokens,
                output_tokens=50,
                total_tokens=input_tokens + 50,
                deployment_name=self.prepared.deployment_name,
                provider=self.prepared.provider,
                provider_model=self.prepared.provider_model,
                route_name=self.prepared.route_name,
                profile_version=self.prepared.profile_version,
                plan_hash=self.prepared.plan_hash,
                payload_hash=self.prepared.payload_hash,
            ),
        )
        self.prepare_calls: list[dict[str, Any]] = []
        self.count_calls: list[PreparedDeckRepairRequest] = []
        self.invoke_calls: list[dict[str, Any]] = []
        self.prepare_error: Exception | None = None
        self.count_error: Exception | None = None
        self.invoke_error: Exception | None = None

    def prepare_request(self, **kwargs: Any) -> PreparedDeckRepairRequest:
        self.prepare_calls.append(kwargs)
        if self.prepare_error is not None:
            raise self.prepare_error
        return self.prepared

    async def count_input_tokens(
        self,
        *,
        request: PreparedDeckRepairRequest,
    ) -> DeckRepairInputTokenCount:
        self.count_calls.append(request)
        if self.count_error is not None:
            raise self.count_error
        return DeckRepairInputTokenCount(
            input_tokens=self.input_tokens,
            payload_hash=request.payload_hash,
        )

    async def invoke(self, **kwargs: Any) -> DeckRepairInvocationResult:
        self.invoke_calls.append(kwargs)
        if self.invoke_error is not None:
            raise self.invoke_error
        return self.result


class FakeTraceSpan:
    def __init__(self) -> None:
        self.already_terminal = False
        self.outputs: list[SafeDeckRepairTraceOutput] = []
        self.finish_error: Exception | None = None

    def finish(self, output: SafeDeckRepairTraceOutput) -> None:
        if self.finish_error is not None:
            raise self.finish_error
        self.outputs.append(output)


class FakeTraceFactory:
    def __init__(self) -> None:
        self.inputs: list[SafeDeckRepairTraceInput] = []
        self.open_existing_inputs: list[SafeDeckRepairTraceInput] = []
        self.spans: list[FakeTraceSpan] = []
        self.error: Exception | None = None
        self.already_terminal = False

    def __call__(self, trace_input: SafeDeckRepairTraceInput) -> FakeTraceSpan:
        self.inputs.append(trace_input)
        if self.error is not None:
            raise self.error
        span = FakeTraceSpan()
        span.already_terminal = self.already_terminal
        self.spans.append(span)
        return span

    def open_existing(
        self,
        trace_input: SafeDeckRepairTraceInput,
    ) -> FakeTraceSpan:
        self.open_existing_inputs.append(trace_input)
        if self.error is not None or not self.spans:
            raise self.error or RuntimeError("trace admission is missing")
        return self.spans[-1]


def _author(
    *,
    request: RepairInvocationRequest | None = None,
    context: object | None = None,
    invoker: FakeTwoPhaseInvoker | None = None,
    trace_factory: FakeTraceFactory | None = None,
) -> tuple[ProductionDeckRepairAuthor, FakeContextLoader, FakeTwoPhaseInvoker]:
    request = request or _request()
    loader = FakeContextLoader(context if context is not None else _context(request=request))
    resolved_invoker = invoker or FakeTwoPhaseInvoker()
    resolved_trace_factory = trace_factory or FakeTraceFactory()
    return (
        ProductionDeckRepairAuthor(
            context_loader=loader,
            invoker=resolved_invoker,
            plan=_plan(),
            trace_factory=resolved_trace_factory,
        ),
        loader,
        resolved_invoker,
    )


def _assert_code(error: pytest.ExceptionInfo[DeckRepairAuthorError], code: str) -> None:
    assert error.value.code == code
    assert str(error.value) == code
    assert error.value.__cause__ is None


def test_exact_context_builds_bounded_multimodal_prompt_and_one_create() -> None:
    request = _request()
    traces = FakeTraceFactory()
    author, loader, invoker = _author(request=request, trace_factory=traces)

    result = _run(author(request))

    assert result.candidate != _candidate()
    assert result.candidate.rationale == _candidate().rationale
    assert result.candidate.source_updates[0].content == SOURCE_TEXT
    assert invoker.result.candidate == _candidate()
    assert loader.calls == [request]
    assert len(invoker.prepare_calls) == len(invoker.count_calls) == len(invoker.invoke_calls) == 1
    assert len(traces.inputs) == len(traces.spans) == 1
    assert traces.inputs[0].campaign_run_id == request.campaign_run_id
    assert traces.inputs[0].initial_quality_run_id == request.program.initial_quality_run_id
    assert traces.inputs[0].program_hash == request.program.program_hash
    assert traces.inputs[0].payload_hash == invoker.prepared.payload_hash
    assert traces.inputs[0].plan_hash == invoker.prepared.plan_hash
    assert traces.spans[0].outputs == []

    _run(author.complete_success_trace(request, result))

    assert traces.open_existing_inputs == traces.inputs
    assert traces.spans[0].outputs == [
        SafeDeckRepairTraceOutput(
            status="completed",
            latency_ms=100,
            input_tokens=200,
            output_tokens=50,
            total_tokens=250,
        )
    ]
    prepare = invoker.prepare_calls[0]
    assert prepare["canary_user_id"] == request.user_id
    assert prepare["plan"] == _plan()
    messages = prepare["messages"]
    assert len(messages) == 2
    human_blocks = messages[1].content
    image_blocks = [block for block in human_blocks if block["type"] == "image_url"]
    assert len(image_blocks) == 2
    assert image_blocks[0]["image_url"]["detail"] == "high"
    assert image_blocks[1]["image_url"]["detail"] == "original"
    assert all(block["image_url"]["url"].startswith("data:image/png;base64,") for block in image_blocks)
    prompt_text = messages[0].content + "\n" + "\n".join(block["text"] for block in human_blocks if block["type"] == "text")
    assert SOURCE_TEXT in prompt_text
    assert SKILL_EXCERPT in prompt_text
    assert SOURCE_HASH in prompt_text
    assert "slide:1" in prompt_text
    assert "slide:2" not in prompt_text
    for forbidden in (
        "needs_revision",
        "weighted_score",
        "criterion_scores",
        "initial_quality_run_id",
        '"rationale"',
    ):
        assert forbidden not in prompt_text


def test_compact_v2_slide_css_contract_is_serialized_in_both_prompt_surfaces() -> None:
    request = _request(program=_program())
    messages = build_repair_author_messages(
        context=_context(request=request),
        program=request.program,
    )

    system_prompt = messages[0].content
    assert "compact_model_html_v2 limit of 1024 UTF-8 bytes" in system_prompt
    assert "retains only complete on-canvas left/top/width/height geometry" in system_prompt
    assert "paired opaque background or background-color plus color" in system_prompt
    assert "full enclosing border shorthand" in system_prompt
    assert "Directional or independently authored border sides" in system_prompt
    assert "mechanically unstable native line fragments" in system_prompt
    assert "put border, border-radius, and box-sizing:border-box in the same qualified CSS rule" in system_prompt
    assert "dependent frame declarations in split rules are stripped" in system_prompt
    assert "full border without box-sizing:border-box" in system_prompt
    assert "Do not use variables, calc(), or inheritance keywords" in system_prompt
    assert (
        "Use !important only on all four left/top/width/height declarations"
        in system_prompt
    )
    assert "all four must omit it otherwise" in system_prompt
    assert "Never use !important for paint, typography, borders" in system_prompt
    assert "inline geometry that is itself !important" in system_prompt
    assert "geometry-affecting aliases are intentionally fail-closed" in system_prompt
    assert "Move or resize only existing elements on the assigned priority selectors" in system_prompt
    assert "Preserve every title, all semantic content, and every unauthorized shape" in system_prompt
    assert "do not return body updates" in system_prompt
    assert "inserts every authorized body as an addressing echo" in system_prompt
    assert "pins body content to the authenticated manifest bytes" in system_prompt
    assert "Every slide_css output is an overlay only" in system_prompt
    assert "nonempty authenticated baseline is opaque" in system_prompt
    assert "preserves its exact bytes as the compiled prefix" in system_prompt
    assert "manifest_source_hash unchanged into expected_source_hash" in system_prompt
    assert "express every visible repair in the authorized slide_css" in system_prompt
    assert "Target only tags, classes, and IDs listed" in system_prompt
    assert "body_selector_inventory" in system_prompt
    assert "Do not restructure body markup or attributes" in system_prompt
    assert "preserve the exact normalized visible HTML token sequence" in system_prompt
    assert (
        "Do not add, remove, or rewrite visible glyphs, symbols, labels, or words"
        in system_prompt
    )
    assert (
        "The inserted authenticated body echoes preserve the exact normalized visible HTML token sequence"
        in system_prompt
    )
    assert "do not split or merge a token or change token order" in system_prompt
    assert "script, style, and template content is excluded" in system_prompt
    assert "do not use inline style, hidden, or aria-hidden attributes" in system_prompt
    assert "do not add script, style, or template elements" in system_prompt
    assert "Do not hide semantic content with HTML attributes or CSS" in system_prompt
    assert "clip it, move it off-canvas" in system_prompt
    assert "CSS-generated content" in system_prompt
    assert "Do not use CSS text-transform or the all shorthand" in system_prompt
    assert "Do not set font or font-family in slide_css" in system_prompt
    assert "Do not use rejected or lossy native CSS properties" in system_prompt
    assert "Do not change generated list-marker semantics" in system_prompt
    assert "list-style, list-style-type, or list-style-image" in system_prompt
    assert "Do not use at-rules or nested CSS rules" in system_prompt
    assert "Use read_only_sources only to account for" in system_prompt
    assert "never return an update for a read-only source" in system_prompt
    assert "Do not set display, overflow, overflow-x, or overflow-y" in system_prompt
    assert "from 12px through 64px" in system_prompt
    assert "campaign's only repair" in system_prompt
    assert "decisive, presentation-scale design lift" in system_prompt
    assert "Only campaign_acceptance.priority_failure_codes are required visible outcomes" in system_prompt
    assert "deferred failure as context and a no-regression constraint" in system_prompt
    assert "Follow campaign_acceptance.priority_selector_by_failure_code exactly" in system_prompt
    assert "Materially resolve exactly those three distinct priority families" in system_prompt
    assert (
        "The primary-selector assignment determines where each priority family must be proved"
        in system_prompt
    )
    assert "Coordinate all three interventions through the exact frozen design_plan.signature and rhythm" in system_prompt
    assert "reinforce—never replace—the frozen structural_fingerprint and composition_rationale" in system_prompt
    assert "Functional reuse of the frozen motif across different semantic beats is expected" in system_prompt
    assert "cosmetic repetition is forbidden" in system_prompt
    assert "at least two distinct existing semantic elements" in system_prompt
    assert "minimum distinct geometry targets" in system_prompt
    assert "CSS budget is a hard ceiling, never a target" in system_prompt
    assert "fewest selector-specific rules and retained declarations" in system_prompt
    assert "at most one thin, purposeful full enclosing frame per authorized slide" in system_prompt
    assert "A border-only repair is invalid" in system_prompt
    assert "from 0.5px through 2px" in system_prompt
    assert "Every geometry intervention must put left, top, width, and height together" in system_prompt
    assert "resolve to exactly one existing manifest element" in system_prompt
    assert "width at least 48px" in system_prompt
    assert "height at least 24px" in system_prompt
    assert "authenticated layout already uses absolute slide-canvas coordinates" in system_prompt
    assert "Never apply geometry to a static element or a nested child" in system_prompt
    assert "one high-level semantic container" in system_prompt
    assert "Never frame a title or other text leaf, repeated list or loop nodes" in system_prompt
    assert "without clipping or a new wrap" in system_prompt
    assert (
        "stage the existing final thesis as a decisive full-canvas synthesis"
        in system_prompt
    )
    assert "Treat every text-bearing geometry target" in system_prompt
    assert "translation-or-expansion only" in system_prompt
    assert "never reduce its authenticated width or height" in system_prompt
    assert "cluster moved anchors into one canvas band" in system_prompt
    assert (
        "Synthesis means hierarchy and relationship, not spatial compression"
        in system_prompt
    )
    assert "compress the final thesis" not in system_prompt
    assert "Preserve every existing deck and slide title fully visible" in system_prompt
    assert "Do not add a separate rule for a deferred failure" in system_prompt
    assert "each priority family needs a retained judge-visible declaration" in system_prompt
    assert "Treat every expected improvement as a required visible outcome" not in system_prompt
    assert "Spend the entire CSS budget" not in system_prompt
    assert "fresh independent rendered judgment can mark satisfied" in system_prompt
    assert "flatten the target's existing effective surface against the slide substrate" in system_prompt
    assert "preserve its effective foreground" in system_prompt
    assert "The safety pair must be visually neutral" in system_prompt
    assert "must not read as a new card, panel, band, rail, or frame" in system_prompt

    payload_text = messages[1].content[0]["text"]
    payload = json.loads(payload_text.removeprefix("Allowed repair context JSON:\n"))
    assert payload["body_selector_inventory"] == {
        "slide:1": {
            "tags": ["h1", "section"],
            "classes": [],
            "ids": [],
        }
    }
    assert payload["read_only_sources"] == [
        {
            "selector": "deck-style:root",
            "source_role": "deck_css",
            "component_version_id": "deck-style-version-001",
            "manifest_source_path": "versions/deck-style/deck.css",
            "manifest_source_hash": DECK_CSS_HASH,
            "text": DECK_CSS_TEXT,
        }
    ]
    assert payload["repair_constraints"]["campaign_acceptance"] == {
        "comparison_target": "approved_improvement",
        "preferred_candidate_verdict": "satisfied",
        "campaign_required_resolved_family_count": 3,
        "available_family_count": 3,
        "author_target_resolved_family_count": 3,
        "campaign_floor_feasible": True,
        "priority_failure_codes": [
            "weak_subject_specificity",
            "weak_signature_realization",
            "weak_mechanism_visualization",
        ],
        "priority_psi_failure_family_by_code": {
            "weak_subject_specificity": "weak_subject_specificity",
            "weak_signature_realization": "weak_signature_realization",
            "weak_mechanism_visualization": "weak_mechanism_visualization",
        },
        "priority_selector_by_failure_code": {
            "weak_subject_specificity": "slide:1",
            "weak_signature_realization": "slide:1",
            "weak_mechanism_visualization": "slide:1",
        },
        "distinct_priority_selector_count": 1,
        "priority_geometry_required": False,
        "minimum_distinct_geometry_targets_per_priority_selector": 0,
        "psi_failure_family_by_code": {
            "weak_subject_specificity": "weak_subject_specificity",
            "weak_signature_realization": "weak_signature_realization",
            "weak_mechanism_visualization": "weak_mechanism_visualization",
        },
        "deferred_failure_codes": [],
        "priority_failure_codes_are_required_visible_outcomes": True,
        "priority_primary_retained_properties": [
            "background",
            "background-color",
            "font-size",
            "height",
            "left",
            "line-height",
            "top",
            "width",
        ],
        "expected_improvements_are_required_visible_outcomes": False,
        "priority_slide_css_feasible": True,
        "cosmetic_rearrangement_is_insufficient": True,
        "forbidden_regressions_remain_binding": True,
    }
    assert payload["repair_constraints"]["compiler_contract"] == {
        "authoring_contract": "compact_model_html_v2",
        "body": {
            "source_role": "body",
            "model_output_policy": "copy_exact_manifest_source_bytes",
            "author_boundary_policy": "replace_with_authenticated_manifest_source_bytes",
            "visual_repair_channel": "slide_css_only_using_existing_body_selectors",
            "content_policy": "preserve_exact_normalized_token_sequence_before_canonicalization",
            "token_normalization": "unicode_nfkc_per_html_data_chunk_then_ordered_unicode_word_or_symbol_tokens",
            "excluded_content_elements": ["script", "style", "template"],
            "forbidden_elements": ["script", "style", "template"],
            "forbidden_attributes": ["aria-hidden", "hidden", "style"],
            "forbidden_visible_token_changes": [
                "add",
                "remove",
                "rewrite",
                "reorder",
            ],
            "markup_restructuring_rule": "forbidden",
            "forbidden_semantic_content_concealment": [
                "hide",
                "clip",
                "off_canvas",
                "css_generated_content",
            ],
            "visible_structural_tokens": {
                "list_item": "ordered_or_unordered_container_kind",
            },
        },
        "slide_css": {
            "source_role": "slide_css",
            "max_utf8_bytes": 1_024,
            "model_output_policy": "repair_overlay_only",
            "retained_properties": [
                "background",
                "background-color",
                "border",
                "border-radius",
                "box-sizing",
                "color",
                "font-size",
                "height",
                "left",
                "line-height",
                "top",
                "width",
            ],
            "author_boundary_property_filter": "strip_all_unlisted_declarations",
            "authenticated_baseline_policy": "opaque_exact_byte_prefix_when_nonempty",
            "compiled_source_policy": "authenticated_baseline_plus_deterministic_separator_plus_filtered_overlay",
            "empty_baseline_policy": "filtered_overlay_only_without_separator",
            "combined_size_policy": "baseline_separator_and_filtered_overlay_must_fit_max_utf8_bytes",
            "fill_background_text_paint_updates_retained": True,
            "geometry_updates_retained": True,
            "retained_value_contract": {
                "geometry": {
                    "properties": ["left", "top", "width", "height"],
                    "unit": "px",
                    "all_four_properties_same_rule": True,
                    "all_four_properties_same_importance": True,
                    "important_required_for_authenticated_inline_geometry": True,
                    "important_forbidden_without_authenticated_inline_geometry": True,
                    "authenticated_inline_important_geometry_target_allowed": False,
                    "ambiguous_authenticated_inline_geometry_target_allowed": False,
                    "ambiguous_authenticated_inline_geometry_properties": [
                        "all",
                        "block-size",
                        "bottom",
                        "inline-size",
                        "inset",
                        "inset-block",
                        "inset-block-end",
                        "inset-block-start",
                        "inset-inline",
                        "inset-inline-end",
                        "inset-inline-start",
                        "max-block-size",
                        "max-height",
                        "max-inline-size",
                        "max-width",
                        "min-block-size",
                        "min-height",
                        "min-inline-size",
                        "min-width",
                        "right",
                    ],
                    "canvas_width_px": 1920,
                    "canvas_height_px": 1080,
                    "must_remain_fully_on_canvas": True,
                    "selector_must_match_exactly_one_manifest_element": True,
                    "minimum_width_px": 48,
                    "minimum_height_px": 24,
                },
                "paint": {
                    "background_properties": [
                        "background",
                        "background-color",
                    ],
                    "foreground_property": "color",
                    "paired_same_rule_for_semantic_text": True,
                    "fully_opaque_literal_colors_only": True,
                    "minimum_contrast_ratio": 4.5,
                },
                "font_size": {
                    "unit": "px",
                    "minimum_inclusive": 12,
                    "maximum_inclusive": 64,
                },
                "line_height": {
                    "unitless_range_inclusive": [0.8, 3.0],
                    "px_range_inclusive": [8.0, 96.0],
                },
                "box_sizing": "border-box",
                "full_border_shorthand_only": True,
                "frame_declarations_same_qualified_rule": True,
                "full_border_requires_box_sizing_same_rule": True,
                "directional_border_sides_allowed": False,
                "border_longhands_allowed": False,
                "border_width_px_range_inclusive": [0.5, 2.0],
                "border_styles": ["solid"],
                "border_color": "literal_fully_opaque_css_color",
                "border_radius": {
                    "px_range_inclusive": [0, 1080.0],
                    "percentage_range_inclusive": [0, 50],
                },
                "important_allowed_for_non_geometry": False,
                "variables_or_calculations_allowed": False,
            },
            "forbidden_native_properties": [
                "animation",
                "animation-name",
                "backdrop-filter",
                "background-blend-mode",
                "box-shadow",
                "filter",
                "font",
                "font-family",
                "letter-spacing",
                "mix-blend-mode",
                "opacity",
                "position-fixed",
                "text-shadow",
                "transition",
            ],
            "forbidden_text_declarations": {
                "content": {
                    "allowed_single_identifiers": ["none", "normal"],
                },
                "display": {
                    "allowed": False,
                },
                "overflow": {
                    "allowed": False,
                    "property_names": [
                        "overflow",
                        "overflow-x",
                        "overflow-y",
                    ],
                },
                "visibility": {
                    "allowed_single_identifiers": ["initial", "visible"],
                },
                "opacity": {
                    "allowed": False,
                },
                "font_size": {
                    "allowed_single_token_type": "dimension",
                    "required_unit": "px",
                    "minimum_inclusive": 12,
                    "maximum_inclusive": 64,
                },
                "color": {
                    "parser": "css_color_3",
                    "minimum_alpha_exclusive": 0,
                    "variables_or_unparsed_values_allowed": False,
                },
                "text_background_contrast": {
                    "minimum_ratio": 4.5,
                    "background_properties": [
                        "background",
                        "background-color",
                    ],
                    "background_value_format": "opaque_literal_color",
                    "forbidden_background_properties": [
                        "background-image",
                    ],
                    "gradients_allowed": False,
                    "foreground_property": "color",
                    "foreground_must_be_same_rule": True,
                    "foreground_must_be_opaque_literal": True,
                    "inherited_or_separate_rule_foreground_allowed": False,
                    "effective_cascade_foreground_must_pass": True,
                    "cascade_resolution": [
                        "importance",
                        "inline_origin",
                        "specificity",
                        "source_order",
                        "inheritance",
                    ],
                    "authenticated_inline_foregrounds_must_also_pass": True,
                    "nearest_effective_opaque_background_wins": True,
                    "at_rules_allowed": False,
                    "nested_rules_allowed": False,
                    "decorative_only_rule_exempt": True,
                    "rendered_native_contrast_gate_authoritative": True,
                    "selector_match_basis": "authenticated_manifest_body",
                    "read_only_cascade_sources": [
                        "authenticated_deck_css",
                        "authenticated_inline_style",
                    ],
                    "read_only_background_paint_policy": {
                        "authenticated_deck_css": (
                            "literal_color_including_translucent_or_"
                            "provably_transparent_no_image"
                        ),
                        "authenticated_inline_style": (
                            "opaque_literal_or_"
                            "provably_transparent_no_image"
                        ),
                    },
                    "unsupported_read_only_paint_rejected_before_provider": True,
                    "translucent_deck_css_paint_is_immutable": True,
                    "semantic_text_geometry_with_any_translucent_deck_css_paint_requires_same_rule_opaque_candidate_pair": True,
                },
                "text_transform": {
                    "allowed": False,
                },
                "all": {"allowed": False},
                "list_style": {"allowed": False},
                "list_style_type": {"allowed": False},
                "list_style_image": {"allowed": False},
            },
            "forbidden_semantic_content_concealment": [
                "hide",
                "clip",
                "off_canvas",
                "css_generated_content",
            ],
            "display_and_overflow_allowed": False,
        },
    }


def test_campaign_acceptance_prioritizes_only_available_psi_floor_families() -> None:
    program = _program(
        failure_codes=(
            "weak_subject_specificity",
            "weak_memorability",
            "weak_signature_realization",
            "low_sequence_rhythm",
        )
    )
    request = _request(program=program)

    messages = build_repair_author_messages(
        context=_context(request=request),
        program=program,
    )

    payload_text = messages[1].content[0]["text"]
    payload = json.loads(payload_text.removeprefix("Allowed repair context JSON:\n"))
    acceptance = payload["repair_constraints"]["campaign_acceptance"]
    assert acceptance["campaign_floor_feasible"] is True
    assert acceptance["available_family_count"] == 3
    assert acceptance["author_target_resolved_family_count"] == 3
    assert acceptance["priority_failure_codes"] == [
        "weak_subject_specificity",
        "weak_signature_realization",
        "low_sequence_rhythm",
    ]
    assert "weak_memorability" not in acceptance["psi_failure_family_by_code"]


def test_campaign_acceptance_prioritizes_exactly_three_critical_psi_families() -> None:
    program = _program(
        failure_codes=(
            "default_look_gravity",
            "weak_closing_synthesis",
            "weak_fingerprint_realization",
            "weak_mechanism_visualization",
            "weak_memorability",
            "weak_signature_realization",
            "weak_spatial_tension",
            "weak_subject_specificity",
        )
    )
    request = _request(program=program)

    messages = build_repair_author_messages(
        context=_context(request=request),
        program=program,
    )

    payload_text = messages[1].content[0]["text"]
    payload = json.loads(payload_text.removeprefix("Allowed repair context JSON:\n"))
    acceptance = payload["repair_constraints"]["campaign_acceptance"]
    assert acceptance["available_family_count"] == 5
    assert acceptance["priority_failure_codes"] == [
        "weak_subject_specificity",
        "weak_signature_realization",
        "weak_closing_synthesis",
    ]
    assert acceptance["priority_psi_failure_family_by_code"] == {
        "weak_closing_synthesis": "weak_closing_synthesis",
        "weak_signature_realization": "weak_signature_realization",
        "weak_subject_specificity": "weak_subject_specificity",
    }
    assert acceptance["deferred_failure_codes"] == [
        "default_look_gravity",
        "weak_fingerprint_realization",
        "weak_mechanism_visualization",
        "weak_memorability",
        "weak_spatial_tension",
    ]


def test_campaign_acceptance_prefers_localized_mechanism_and_closing() -> None:
    acceptance = _campaign_acceptance_contract(
        _specificity_first_three_selector_program()
    )

    assert acceptance["priority_failure_codes"] == [
        "weak_subject_specificity",
        "weak_closing_synthesis",
        "weak_mechanism_visualization",
    ]
    assert acceptance["priority_selector_by_failure_code"] == {
        "weak_subject_specificity": "slide:1",
        "weak_closing_synthesis": "slide:5",
        "weak_mechanism_visualization": "slide:2",
    }
    assert acceptance["distinct_priority_selector_count"] == 3
    assert acceptance["priority_geometry_required"] is True


def test_campaign_acceptance_assignment_is_insertion_order_invariant() -> None:
    forward = _campaign_acceptance_contract(
        _specificity_first_three_selector_program()
    )
    reversed_input = _campaign_acceptance_contract(
        _specificity_first_three_selector_program(reverse_input_order=True)
    )

    for field in (
        "priority_failure_codes",
        "priority_psi_failure_family_by_code",
        "priority_selector_by_failure_code",
        "distinct_priority_selector_count",
        "priority_geometry_required",
        "minimum_distinct_geometry_targets_per_priority_selector",
    ):
        assert reversed_input[field] == forward[field]


def test_campaign_acceptance_maximizes_distinct_priority_selectors() -> None:
    acceptance = _campaign_acceptance_contract(
        _overlapping_three_selector_program()
    )

    assert acceptance["priority_selector_by_failure_code"] == {
        "weak_subject_specificity": "slide:2",
        "weak_signature_realization": "slide:1",
        "weak_mechanism_visualization": "slide:3",
    }
    assert acceptance["distinct_priority_selector_count"] == 3
    assert acceptance["priority_geometry_required"] is True
    assert (
        acceptance["minimum_distinct_geometry_targets_per_priority_selector"]
        == 2
    )


def test_deferred_only_authorized_selector_is_rejected_before_provider() -> None:
    request = _request(program=_deferred_only_authorized_selector_program())
    traces = FakeTraceFactory()
    author, loader, invoker = _author(
        request=request,
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert loader.calls == []
    assert invoker.prepare_calls == []
    assert invoker.count_calls == []
    assert invoker.invoke_calls == []
    assert traces.inputs == []


@pytest.mark.parametrize(
    "body",
    [
        (
            '<section class="subject">'
            '<div class="mechanism">Current PSI control loop</div>'
            "</section>"
        ),
        (
            '<section class="subject" style="inset:0">Current PSI</section>'
            '<section class="mechanism" style="left:0!important">'
            "Control loop</section>"
        ),
    ],
    ids=("nested-targets", "ineligible-inline-geometry"),
)
def test_priority_geometry_infeasible_context_is_rejected_before_provider(
    body: str,
) -> None:
    program = _overlapping_three_selector_program()
    request = _request(program=program)
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    base = _context(request=request)
    sources = tuple(
        RepairSourceContext(
            build_id=request.build_id,
            manifest_revision=program.initial_manifest_revision,
            manifest_hash=MANIFEST_HASH,
            selector=selector,
            source_role=role,
            component_version_id=f"{selector}-{role}-version-001",
            manifest_source_path=f"versions/{selector}/{role}.txt",
            manifest_source_hash=(
                SLIDE_CSS_HASH if role == "slide_css" else body_hash
            ),
            text=BASELINE_SLIDE_CSS_TEXT if role == "slide_css" else body,
        )
        for selector in program.authorized_selectors
        for role in program.authorized_source_roles[selector]
    )
    renders = tuple(
        RepairContextImage(
            artifact_version_id=request.initial_artifact_version_id,
            selector=evidence.selector,
            path=evidence.path,
            sha256=evidence.sha256,
            width=64,
            height=36,
            png_bytes=RENDER_BYTES,
        )
        for repair in program.selector_repairs
        for evidence in repair.render_evidence
    )
    context = base.model_copy(
        update={
            "authorized_sources": sources,
            "failing_renders": renders,
            "owned_assets": (),
        }
    )
    traces = FakeTraceFactory()
    author, loader, invoker = _author(
        request=request,
        context=context,
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert loader.calls == [request]
    assert invoker.prepare_calls == []
    assert invoker.count_calls == []
    assert invoker.invoke_calls == []
    assert traces.inputs == []


def _v32_priority_geometry_context(
    *,
    body: str,
    deck_css: str = DECK_CSS_TEXT,
) -> tuple[RepairInvocationRequest, RepairAuthorContext]:
    program = _specificity_first_three_selector_program()
    request = _request(program=program)
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    base = _context(request=request)
    sources = tuple(
        RepairSourceContext(
            build_id=request.build_id,
            manifest_revision=program.initial_manifest_revision,
            manifest_hash=MANIFEST_HASH,
            selector=selector,
            source_role=source_role,
            component_version_id=f"{selector}-{source_role}-version-001",
            manifest_source_path=(
                f"versions/{selector.replace(':', '-')}/{source_role}.txt"
            ),
            manifest_source_hash=(
                SLIDE_CSS_HASH
                if source_role == "slide_css"
                else body_hash
            ),
            text=(
                BASELINE_SLIDE_CSS_TEXT
                if source_role == "slide_css"
                else body
            ),
        )
        for selector in program.authorized_selectors
        for source_role in program.authorized_source_roles[selector]
    )
    renders = tuple(
        RepairContextImage(
            artifact_version_id=request.initial_artifact_version_id,
            selector=evidence.selector,
            path=evidence.path,
            sha256=evidence.sha256,
            width=64,
            height=36,
            png_bytes=RENDER_BYTES,
        )
        for repair in program.selector_repairs
        for evidence in repair.render_evidence
    )
    return request, base.model_copy(
        update={
            "authorized_sources": sources,
            "read_only_sources": tuple(
                source.model_copy(
                    update={
                        "text": deck_css,
                        "manifest_source_hash": hashlib.sha256(
                            deck_css.encode()
                        ).hexdigest(),
                    }
                )
                for source in base.read_only_sources
            ),
            "failing_renders": renders,
            "owned_assets": (),
        }
    )


def test_v32_static_group_layout_is_rejected_before_provider_admission() -> None:
    request, context = _v32_priority_geometry_context(
        body=(
            '<div class="group">'
            '<section class="subject">Current PSI</section>'
            '<section class="mechanism">Control loop</section>'
            "</div>"
        )
    )
    traces = FakeTraceFactory()
    author, loader, invoker = _author(
        request=request,
        context=context,
        trace_factory=traces,
    )

    assert not _priority_geometry_sources_are_feasible(
        request.program,
        context.authorized_sources,
        context.read_only_sources,
    )
    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert loader.calls == [request]
    assert invoker.prepare_calls == []
    assert invoker.count_calls == []
    assert invoker.invoke_calls == []
    assert traces.inputs == []


def test_v32_combined_absolute_pair_passes_strict_source_feasibility() -> None:
    request, context = _v32_priority_geometry_context(
        body=(
            '<section class="subject" style="position:absolute;'
            'box-sizing:border-box;left:80px;top:80px;'
            'width:640px;height:360px">Current PSI</section>'
            '<section class="mechanism" style="position:absolute;'
            'box-sizing:border-box;left:800px;top:520px;'
            'width:640px;height:360px">Control loop</section>'
        )
    )

    assert _priority_geometry_sources_are_feasible(
        request.program,
        context.authorized_sources,
        context.read_only_sources,
    )


def test_v32_translucent_deck_paint_has_safe_geometry_witness() -> None:
    request, context = _v32_priority_geometry_context(
        body=(
            '<section class="subject" style="position:absolute;'
            'box-sizing:border-box;left:80px;top:80px;'
            'width:640px;height:360px">Current PSI</section>'
            '<section class="mechanism" style="position:absolute;'
            'box-sizing:border-box;left:800px;top:520px;'
            'width:640px;height:360px">Control loop</section>'
        ),
        deck_css=(
            "section{background:rgba(29,32,39,.5);color:#FFFFFF}"
        ),
    )

    assert _priority_geometry_sources_are_feasible(
        request.program,
        context.authorized_sources,
        context.read_only_sources,
    )


def test_v32_combined_geometry_witness_rejects_aggregate_oversize() -> None:
    class_names = tuple(
        f"geometry-anchor-{index}-{'x' * 44}"
        for index in range(8)
    )
    long_classes = " ".join(class_names)
    selector_stem = "section" + "".join(
        f".{class_name}" for class_name in class_names
    )
    first_rule = _strict_geometry_candidate_rule(
        f"{selector_stem}:nth-child(1)",
        {"left": 80.0, "top": 80.0, "width": 640.0, "height": 360.0},
        important=True,
    )
    second_rule = _strict_geometry_candidate_rule(
        f"{selector_stem}:nth-child(2)",
        {
            "left": 800.0,
            "top": 520.0,
            "width": 640.0,
            "height": 360.0,
        },
        important=True,
    )
    assert first_rule is not None and second_rule is not None
    assert len(first_rule.encode()) <= repair_overlay_utf8_budget(baseline="")
    assert len(second_rule.encode()) <= repair_overlay_utf8_budget(baseline="")
    assert len((first_rule + second_rule).encode()) > repair_overlay_utf8_budget(
        baseline="",
    )
    request, context = _v32_priority_geometry_context(
        body=(
            f'<section class="{long_classes}" '
            'style="position:absolute;box-sizing:border-box;'
            'left:80px;top:80px;width:640px;height:360px">'
            "Current PSI</section>"
            f'<section class="{long_classes}" '
            'style="position:absolute;box-sizing:border-box;'
            'left:800px;top:520px;width:640px;height:360px">'
            "Control loop</section>"
        )
    )

    assert not _priority_geometry_sources_are_feasible(
        request.program,
        context.authorized_sources,
        context.read_only_sources,
    )


def test_v32_geometry_witness_rejects_candidate_only_box_sizing() -> None:
    retained = _retained_slide_css(
        ".subject{left:88px!important;top:80px!important;"
        "width:640px!important;height:360px!important;"
        "box-sizing:border-box}"
    )
    assert "box-sizing" not in retained
    request, context = _v32_priority_geometry_context(
        body=(
            '<section class="subject" style="position:absolute;'
            'left:80px;top:80px;width:640px;height:360px">'
            "Current PSI</section>"
            '<section class="mechanism" style="position:absolute;'
            'left:800px;top:520px;width:640px;height:360px">'
            "Control loop</section>"
        ),
        deck_css=":root{}",
    )

    assert not _priority_geometry_sources_are_feasible(
        request.program,
        context.authorized_sources,
        context.read_only_sources,
    )


@pytest.mark.parametrize(
    "failure_codes",
    [
        ("weak_subject_specificity",),
        (
            "weak_subject_specificity",
            "low_sequence_rhythm",
            "weak_narrative_pacing",
        ),
    ],
)
def test_infeasible_campaign_is_rejected_before_context_or_provider_work(
    failure_codes: tuple[str, ...],
) -> None:
    request = _request(program=_program(failure_codes=failure_codes))
    traces = FakeTraceFactory()
    author, loader, invoker = _author(request=request, trace_factory=traces)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert loader.calls == []
    assert invoker.prepare_calls == []
    assert invoker.count_calls == []
    assert invoker.invoke_calls == []
    assert traces.inputs == []


def test_body_selector_inventory_is_exact_and_content_free() -> None:
    request = _request(
        program=_program(source_roles=("body", "slide_css")),
    )
    messages = build_repair_author_messages(
        context=_context(request=request),
        program=request.program,
    )

    payload_text = messages[1].content[0]["text"]
    payload = json.loads(payload_text.removeprefix("Allowed repair context JSON:\n"))

    assert payload["body_selector_inventory"] == {
        "slide:1": {
            "tags": ["h1", "section"],
            "classes": [],
            "ids": [],
        }
    }


def test_body_candidate_with_preserved_tokens_is_pinned_to_manifest_source() -> None:
    request = _request()
    accepted = _candidate()
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=accepted),
    )

    result = _run(author(request))

    assert result.candidate != accepted
    assert result.candidate.rationale == accepted.rationale
    assert result.candidate.source_updates[0].content == SOURCE_TEXT
    assert invoker.result.candidate == accepted
    assert len(invoker.invoke_calls) == 1


def test_missing_body_echo_is_inserted_from_authenticated_manifest() -> None:
    request = _request()
    authored = DeckRepairCandidate(
        source_updates=(_candidate().source_updates[1],),
        rationale="Strengthen the frozen PSI mechanism through the authorized overlay.",
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=authored),
    )

    result = _run(author(request))

    assert invoker.result.candidate == authored
    assert tuple(
        (update.source_role, update.expected_source_hash, update.content)
        for update in result.candidate.source_updates
    ) == (
        ("slide_css", SLIDE_CSS_HASH, RETAINED_SLIDE_CSS_TEXT),
        ("body", SOURCE_HASH, SOURCE_TEXT),
    )
    assert len(invoker.invoke_calls) == 1


def test_missing_slide_css_target_is_not_synthesized() -> None:
    request = _request()
    authored = DeckRepairCandidate(
        source_updates=(_candidate().source_updates[0],),
        rationale="Preserve the authenticated body without inventing a CSS repair.",
    )
    traces = FakeTraceFactory()
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=authored),
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_targets_invalid"
    assert len(invoker.invoke_calls) == 1
    assert traces.spans[0].outputs[0].error_code == "candidate_targets_invalid"


def test_body_pin_preserves_model_css_addressing_and_metrics() -> None:
    request = _request(
        program=_program(source_roles=("body", "slide_css")),
    )
    model_css = (
        "section{left:96px;top:112px;width:704px;height:336px;"
        "font-size:36px;border:2px solid #0B1F3A;"
        "box-sizing:border-box;padding:12px;"
        "background:#FFFFFF;color:#0B1F3A}"
    )
    retained_css = (
        "section{left:96px;top:112px;width:704px;height:336px;"
        "font-size:36px;border:2px solid #0B1F3A;"
        "box-sizing:border-box;background:#FFFFFF;color:#0B1F3A;}"
    )
    authored = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=SOURCE_HASH,
                content=(
                    '<section class="mechanism"><div>'
                    "<h1><span>Current PSI</span> <em>control loop</em></h1>"
                    "</div></section>"
                ),
            ),
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=model_css,
            ),
        ),
        rationale="Strengthen hierarchy through existing native layout styling.",
    )
    baseline_css = (
        "section{position:absolute;left:0px;top:0px;"
        "width:700px;height:300px}"
    )
    context = _context_with_slide_css_baseline(
        _context(request=request),
        baseline_css,
    )
    authored = _candidate_with_slide_css_baseline_hash(
        authored,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=authored),
    )

    result = _run(author(request))

    assert len(invoker.invoke_calls) == 1
    assert result.metrics is invoker.result.metrics
    assert result.candidate.rationale == authored.rationale
    assert tuple(
        (update.source_role, update.expected_source_hash, update.content)
        for update in result.candidate.source_updates
        ) == (
            ("body", SOURCE_HASH, SOURCE_TEXT),
            (
                "slide_css",
                hashlib.sha256(baseline_css.encode()).hexdigest(),
                retained_css,
            ),
        )
    assert invoker.result.candidate == authored


@pytest.mark.parametrize(
    ("model_css", "case"),
    [
        (
            ".model-only{font-size:36px}",
            "unknown-selector",
        ),
        (
            ".mechanism{font-size:36px}",
            "selector-invented-by-model-body",
        ),
        (
            "aside:not(section){font-size:36px}",
            "nonmatching-tag-predicate",
        ),
        ("body{font-size:36px}", "synthetic-body-wrapper"),
        (":root{font-size:36px}", "synthetic-root"),
        ("*{font-size:36px}", "universal-selector"),
        (
            "section:not(.invented){font-size:36px}",
            "invented-negated-class",
        ),
        ("section *{font-size:36px}", "descendant-universal"),
        ("section,:root{font-size:36px}", "grouped-synthetic-root"),
        ("section,*{font-size:36px}", "grouped-universal"),
        ("section,.invented{font-size:36px}", "grouped-invented-class"),
    ],
)
def test_css_repair_must_target_manifest_dom_with_retained_declaration(
    model_css: str,
    case: str,
) -> None:
    del case
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": model_css}
                ),
            )
        }
    )
    traces = FakeTraceFactory()
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1
    assert traces.spans[0].outputs[0].error_code == "candidate_css_targets_invalid"


def test_css_repair_requires_at_least_one_retained_declaration() -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": "section{color:#0B1F3A;left:96px}"}
                ),
            )
        }
    )
    traces = FakeTraceFactory()
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_canonicalization_invalid"
    assert len(invoker.invoke_calls) == 1
    assert traces.spans[0].outputs[0].error_code == (
        "candidate_canonicalization_invalid"
    )


def test_css_repair_accepts_existing_manifest_class_and_id_selectors() -> None:
    request = _request()
    body = '<section id="mechanism" class="frame panel"><h1>Current PSI control loop</h1></section>'
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    context = _context(request=request)
    body_source = context.authorized_sources[0].model_copy(
        update={"manifest_source_hash": body_hash, "text": body}
    )
    context = context.model_copy(
        update={
            "authorized_sources": (
                body_source,
                *context.authorized_sources[1:],
            )
        }
    )
    candidate = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=body_hash,
                content=body,
            ),
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                    expected_source_hash=SLIDE_CSS_HASH,
                    content=(
                        "#mechanism.frame{font-size:36px;"
                        "border:2px solid #0B1F3A;box-sizing:border-box}"
                    ),
            ),
        ),
        rationale="Use only selectors present in the authenticated body.",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        "#mechanism.frame{font-size:36px;border:2px solid #0B1F3A;"
        "box-sizing:border-box;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_css_repair_rejects_unmatched_grouped_selector_arm() -> None:
    request = _request()
    model_css = (
        ".model-only{color:#0B1F3A}"
        "section,.unused{font-size:36px;padding:12px}"
    )
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": model_css}
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_css_repair_rejects_standalone_unmatched_retained_rule() -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={
                        "content": (
                            "section{font-size:36px}"
                            ".unused{line-height:1.2}"
                        )
                    }
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_body_only_program_is_rejected_before_provider_admission() -> None:
    request = _request(program=_program(source_roles=("body",)))
    author, loader, invoker = _author(request=request)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert loader.calls == []
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


def test_nonempty_authenticated_slide_css_is_opaque_and_overlay_only() -> None:
    request = _request()
    baseline_css = (
        "section{left:80px;top:120px;background:#FFFFFF;color:#15171C}"
    )
    context = _context_with_slide_css_baseline(
        _context(request=request),
        baseline_css,
    )
    candidate = _candidate_with_slide_css_baseline_hash(
        _candidate(),
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = result.candidate.source_updates[1]
    assert slide_css.content == RETAINED_SLIDE_CSS_TEXT
    baseline_hash = hashlib.sha256(baseline_css.encode()).hexdigest()
    assert slide_css.expected_source_hash == baseline_hash
    composed = compose_authenticated_slide_css(
        baseline=baseline_css,
        overlay=slide_css.content,
    )
    assert composed.startswith(baseline_css + SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR)
    assert recover_authenticated_slide_css_overlay(
        baseline=baseline_css,
        composed=composed,
    ) == slide_css.content

    messages = invoker.prepare_calls[0]["messages"]
    prompt_text = messages[0].content + "\n" + "\n".join(
        block["text"]
        for block in messages[1].content
        if block["type"] == "text"
    )
    assert baseline_css not in prompt_text
    payload = json.loads(
        messages[1].content[0]["text"].removeprefix(
            "Allowed repair context JSON:\n"
        )
    )
    source = next(
        item
        for item in payload["authorized_sources"]
        if item["source_role"] == "slide_css"
    )
    assert "text" not in source
    assert source["manifest_source_hash"] == baseline_hash
    assert source["authenticated_baseline"] == {
        "content_exposed": False,
        "preservation": "exact_bytes_as_compiled_prefix",
        "utf8_bytes": len(baseline_css.encode()),
        "repair_overlay_max_utf8_bytes": repair_overlay_utf8_budget(
            baseline=baseline_css
        ),
    }
    assert len(invoker.invoke_calls) == 1


def test_parseable_comment_only_baseline_is_preserved_as_opaque_bytes() -> None:
    request = _request()
    baseline_css = "/* authenticated baseline comment */\n"
    context = _context_with_slide_css_baseline(
        _context(request=request),
        baseline_css,
    )
    candidate = _candidate_with_slide_css_baseline_hash(
        _candidate(),
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    overlay = result.candidate.source_updates[1].content
    assert compose_authenticated_slide_css(
        baseline=baseline_css,
        overlay=overlay,
    ) == baseline_css + SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR + overlay
    prompt_text = "\n".join(
        block["text"]
        for block in invoker.prepare_calls[0]["messages"][1].content
        if block["type"] == "text"
    )
    assert baseline_css.strip() not in prompt_text


@pytest.mark.parametrize(
    "baseline_css",
    (
        "section{}",
        "section{/* authenticated empty rule */}",
    ),
)
def test_semantically_empty_qualified_baseline_is_preserved(
    baseline_css: str,
) -> None:
    request = _request()
    context = _context_with_slide_css_baseline(
        _context(request=request),
        baseline_css,
    )
    candidate = _candidate_with_slide_css_baseline_hash(
        _candidate(),
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    overlay = result.candidate.source_updates[1].content
    assert compose_authenticated_slide_css(
        baseline=baseline_css,
        overlay=overlay,
    ) == baseline_css + SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR + overlay
    assert len(invoker.invoke_calls) == 1


def test_already_composed_provider_css_is_rejected_before_canonicalization() -> None:
    request = _request()
    baseline_css = "section{font-size:24px}"
    context = _context_with_slide_css_baseline(
        _context(request=request),
        baseline_css,
    )
    candidate = _candidate_with_slide_css_baseline_hash(
        _candidate(),
        baseline_css,
    )
    overlay = candidate.source_updates[1]
    candidate = candidate.model_copy(
        update={
            "source_updates": (
                candidate.source_updates[0],
                overlay.model_copy(
                    update={
                        "content": compose_authenticated_slide_css(
                            baseline=baseline_css,
                            overlay=overlay.content,
                        )
                    }
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_canonicalization_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "baseline_css",
    (
        "@media print{section{width:100px}}",
        "section{width:100px;broken}",
        "section{width:100px",
        "/* unterminated baseline comment",
        'section{content:"unterminated}',
        "section{position:fixed;width:100px}",
        "section{opacity:.5;width:100px}",
        "section::before{content:'untrusted'}",
        "section{background-image:url(https://invalid.example/a.png)}",
        "section{width:100px}\x00",
    ),
)
def test_unsafe_or_invalid_authenticated_slide_css_fails_before_provider(
    baseline_css: str,
) -> None:
    request = _request()
    context = _context_with_slide_css_baseline(
        _context(request=request),
        baseline_css,
    )
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


def test_deck_style_root_program_is_rejected_before_provider_admission() -> None:
    request = _request(program=_deck_style_root_program())
    context = _context()
    context = context.model_copy(
        update={
            "identity": context.identity.model_copy(
                update={
                    "repair_program_hash": request.program.program_hash,
                }
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


@pytest.mark.parametrize(
    "candidate_text",
    [
        "<section hidden><h1>Current PSI control loop</h1></section>",
        '<section aria-hidden="true"><h1>Current PSI control loop</h1></section>',
        '<section style="display:none"><h1>Current PSI control loop</h1></section>',
        '<section style="visibility:hidden"><h1>Current PSI control loop</h1></section>',
        '<section style="visibility:collapse"><h1>Current PSI control loop</h1></section>',
        '<section style="opacity:0%"><h1>Current PSI control loop</h1></section>',
        '<section style="opacity:var(--alpha)"><h1>Current PSI control loop</h1></section>',
        '<section style="font-size:0px"><h1>Current PSI control loop</h1></section>',
        '<section style="font-size:calc(0px)"><h1>Current PSI control loop</h1></section>',
        '<section style="color:transparent"><h1>Current PSI control loop</h1></section>',
        '<section style="color:rgba(0,0,0,0)"><h1>Current PSI control loop</h1></section>',
        '<section style="color:#0000"><h1>Current PSI control loop</h1></section>',
        '<section style="text-transform:uppercase"><h1>Current PSI control loop</h1></section>',
        "<section><h1 hidden/>Current PSI control loop</section>",
    ],
    ids=(
        "hidden",
        "aria-hidden",
        "display-none",
        "visibility-hidden",
        "visibility-collapse",
        "opacity-zero",
        "opacity-variable",
        "font-size-zero",
        "font-size-calculation",
        "transparent-color",
        "rgba-alpha-zero",
        "hex-alpha-zero",
        "inline-text-transform",
        "hidden-self-closing-nonvoid",
    ),
)
def test_body_candidate_discards_hiding_markup_before_materialization(
    candidate_text: str,
) -> None:
    request = _request()
    candidate = _candidate_with_body(candidate_text)
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[0].content == SOURCE_TEXT
    assert candidate_text not in tuple(
        update.content for update in result.candidate.source_updates
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "injected_node",
    [
        '<p aria-hidden="true">INJECTED COPY</p>',
        '<p style="text-transform:uppercase">INJECTED COPY</p>',
        '<p style="--a:1;opacity:var(--a)">INJECTED COPY</p>',
        '<p style="font-size:calc(12px)">INJECTED COPY</p>',
        '<p style="color:var(--ink)">INJECTED COPY</p>',
        '<style>.x::before{content:"INJECTED COPY"}</style>',
        '<script>document.body.dataset.copy="INJECTED COPY"</script>',
        '<template><p>INJECTED COPY</p></template>',
    ],
    ids=(
        "aria-hidden",
        "inline-text-transform",
        "inline-opacity-variable",
        "inline-font-size-calculation",
        "inline-color-variable",
        "embedded-style",
        "embedded-script",
        "embedded-template",
    ),
)
def test_body_candidate_discards_injected_copy_cloaks(
    injected_node: str,
) -> None:
    request = _request()
    candidate = _candidate_with_body(SOURCE_TEXT + injected_node)
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[0].content == SOURCE_TEXT
    assert injected_node not in tuple(
        update.content for update in result.candidate.source_updates
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "candidate_text",
    [
        "<section><h1>Current PSI + control loop</h1></section>",
        "<section><h1>Current PSI feedback loop</h1></section>",
        "<section><h1>Current PSI loop</h1></section>",
        "<section><h1>PSI Current control loop</h1></section>",
    ],
    ids=("symbol-insertion", "rewrite", "removal", "order-change"),
)
def test_body_candidate_discards_visible_token_sequence_changes(
    candidate_text: str,
) -> None:
    request = _request()
    context = _context(request=request)
    candidate = _candidate_with_body(candidate_text)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[0].content == SOURCE_TEXT
    assert invoker.result.candidate == candidate
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("source_text", "candidate_text"),
    [
        (
            SOURCE_TEXT,
            "<section><h1>Current PSI con<span>trol</span> loop</h1></section>",
        ),
        (
            "<section><h1>Current PSI con<span>trol</span> loop</h1></section>",
            SOURCE_TEXT,
        ),
    ],
    ids=("token-split", "token-merge"),
)
def test_body_candidate_discards_token_boundary_changes_across_markup(
    source_text: str,
    candidate_text: str,
) -> None:
    request = _request()
    context = _context(request=request)
    source_hash = hashlib.sha256(source_text.encode()).hexdigest()
    source = context.authorized_sources[0].model_copy(
        update={"manifest_source_hash": source_hash, "text": source_text}
    )
    context = context.model_copy(
        update={
            "authorized_sources": (
                source,
                *context.authorized_sources[1:],
            )
        }
    )
    candidate = _candidate_with_body(
        candidate_text,
        expected_source_hash=source_hash,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[0].content == source_text
    assert invoker.result.candidate == candidate
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("source_text", "candidate_text"),
    [
        (
            "<section><p>One</p></section>",
            "<section><ul><li>One</li></ul></section>",
        ),
        (
            "<section><p>One</p></section>",
            "<section><ol><li>One</li></ol></section>",
        ),
        (
            "<section><ul><li>One</li></ul></section>",
            "<section><ol><li>One</li></ol></section>",
        ),
    ],
    ids=("paragraph-to-ul", "paragraph-to-ol", "ul-to-ol"),
)
def test_body_candidate_discards_list_marker_semantic_changes(
    source_text: str,
    candidate_text: str,
) -> None:
    request = _request()
    context = _context(request=request)
    source_hash = hashlib.sha256(source_text.encode()).hexdigest()
    source = context.authorized_sources[0].model_copy(
        update={"manifest_source_hash": source_hash, "text": source_text}
    )
    context = context.model_copy(
        update={
            "authorized_sources": (
                source,
                *context.authorized_sources[1:],
            )
        }
    )
    candidate = _candidate_with_body(
        candidate_text,
        expected_source_hash=source_hash,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[0].content == source_text
    assert invoker.result.candidate == candidate
    assert len(invoker.invoke_calls) == 1


def test_discardable_raw_oversize_css_is_canonicalized_before_byte_limit() -> None:
    request = _request(program=_program())
    context = _context(request=request)
    accepted = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=SOURCE_HASH,
                content=SOURCE_TEXT,
            ),
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=_sized_slide_css(1_024),
            ),
        ),
        rationale="Keep the repair inside the frozen compiler contract.",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=accepted),
    )

    result = _run(author(request))
    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1

    prefix = SLIDE_CSS_TEXT + "/*"
    suffix = "*/"
    oversized_content = (
        prefix
        + ("é" * ((1_025 - len(prefix.encode()) - len(suffix.encode())) // 2))
        + "x"
        + suffix
    )
    assert len(oversized_content) < 1_024
    assert len(oversized_content.encode("utf-8")) == 1_025
    oversized = accepted.model_copy(
        update={
            "source_updates": (
                accepted.source_updates[0],
                accepted.source_updates[1].model_copy(
                    update={"content": oversized_content}
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=oversized),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1


def test_retained_slide_css_must_fit_compact_v2_byte_limit() -> None:
    request = _request(program=_program())
    retained_content = "section{font-size:32px}" * 48
    assert len(_retained_slide_css(retained_content).encode()) > 1_024
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": retained_content}
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_nonempty_baseline_and_filtered_overlay_share_compact_v2_limit() -> None:
    request = _request()
    overlay = "section{font-size:12px}"
    canonical_overlay = "section{font-size:12px;}"
    baseline_size = (
        1_024
        - len(SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR.encode())
        - len(canonical_overlay.encode())
    )

    def author_for_baseline(size_bytes: int):
        baseline_css = _sized_baseline_slide_css(size_bytes)
        context = _context_with_slide_css_baseline(
            _context(request=request),
            baseline_css,
        )
        candidate = _candidate_with_slide_css_baseline_hash(
            _candidate().model_copy(
                update={
                    "source_updates": (
                        _candidate().source_updates[0],
                        _candidate().source_updates[1].model_copy(
                            update={"content": overlay}
                        ),
                    )
                }
            ),
            baseline_css,
        )
        return (
            baseline_css,
            *_author(
                request=request,
                context=context,
                invoker=FakeTwoPhaseInvoker(candidate=candidate),
            ),
        )

    baseline_css, author, _loader, invoker = author_for_baseline(
        baseline_size
    )
    result = _run(author(request))
    result_css = result.candidate.source_updates[1]
    assert result_css.content == canonical_overlay
    assert result_css.expected_source_hash == hashlib.sha256(
        baseline_css.encode()
    ).hexdigest()
    assert len(
        compose_authenticated_slide_css(
            baseline=baseline_css,
            overlay=result_css.content,
        ).encode()
    ) == 1_024
    assert len(invoker.invoke_calls) == 1

    _baseline_css, author, _loader, invoker = author_for_baseline(
        baseline_size + 1
    )
    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))
    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_allows_safe_content_visibility_color_and_font_size_boundary() -> None:
    request = _request(program=_program())
    context = _context(request=request)
    accepted = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=SOURCE_HASH,
                content=SOURCE_TEXT,
            ),
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=(
                    SLIDE_CSS_TEXT
                    + "section{position:absolute;content:normal;"
                    "visibility:visible;"
                    "font-size:64px;"
                    "color:rgba(0,0,0,.5)}"
                ),
            ),
        ),
        rationale="Use ordinary layout without concealing or transforming text.",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=accepted),
    )

    result = _run(author(request))
    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT + "section{font-size:64px;}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("declaration", "canonical"),
    [
        ("font-size:12px", "font-size:12px;"),
        ("font-size:64px", "font-size:64px;"),
        ("line-height:0.8", "line-height:0.8;"),
        ("line-height:3", "line-height:3;"),
        ("line-height:8px", "line-height:8px;"),
        ("line-height:96px", "line-height:96px;"),
        (
            "font-size:32px;border:1px solid #0B1F3A;box-sizing:border-box",
            "font-size:32px;border:1px solid #0B1F3A;box-sizing:border-box;",
        ),
        (
            "font-size:32px;border:0.5px solid #0B1F3A;box-sizing:border-box",
            "font-size:32px;border:0.5px solid #0B1F3A;box-sizing:border-box;",
        ),
        (
            "font-size:32px;border:2px solid rgb(11,31,58);box-sizing:border-box",
            "font-size:32px;border:2px solid rgb(11,31,58);box-sizing:border-box;",
        ),
        (
            "font-size:32px;border:1px solid #0B1F3A;border-radius:0px;box-sizing:border-box",
            "font-size:32px;border:1px solid #0B1F3A;border-radius:0px;box-sizing:border-box;",
        ),
        (
            "font-size:32px;border:1px solid #0B1F3A;border-radius:1080px;box-sizing:border-box",
            "font-size:32px;border:1px solid #0B1F3A;border-radius:1080px;box-sizing:border-box;",
        ),
        (
            "font-size:32px;border:1px solid #0B1F3A;border-radius:50%;box-sizing:border-box",
            "font-size:32px;border:1px solid #0B1F3A;border-radius:50%;box-sizing:border-box;",
        ),
    ],
)
def test_slide_css_retained_value_boundaries_are_canonicalized(
    declaration: str,
    canonical: str,
) -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": f"section{{{declaration}}}"}
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == f"section{{{canonical}}}"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_retains_only_complete_on_canvas_geometry() -> None:
    assert _retained_slide_css(
        "section{left:0px;top:0px;width:1920px;height:1080px}"
    ) == "section{left:0px;top:0px;width:1920px;height:1080px;}"


def test_slide_css_retains_complete_uniform_important_geometry() -> None:
    assert _retained_slide_css(
        "section{left:80px!important;top:80px!important;"
        "width:640px!important;height:360px!important}"
    ) == (
        "section{left:80px!important;top:80px!important;"
        "width:640px!important;height:360px!important;}"
    )


@pytest.mark.parametrize("ordinary_property", ["left", "top", "width", "height"])
def test_slide_css_strips_mixed_importance_geometry(
    ordinary_property: str,
) -> None:
    geometry = {
        "left": "80px!important",
        "top": "80px!important",
        "width": "640px!important",
        "height": "360px!important",
    }
    geometry[ordinary_property] = geometry[ordinary_property].replace(
        "!important",
        "",
    )
    declarations = ";".join(
        f"{name}:{value}" for name, value in geometry.items()
    )

    assert _retained_slide_css(
        f"section{{font-size:32px;{declarations}}}"
    ) == "section{font-size:32px;}"


@pytest.mark.parametrize(
    "geometry",
    [
        "left:0px;top:0px;width:1920px",
        "left:0%;top:0px;width:640px;height:360px",
        "left:calc(1px);top:0px;width:640px;height:360px",
        "left:-1px;top:0px;width:640px;height:360px",
        "left:1281px;top:0px;width:640px;height:360px",
        "left:0px;top:721px;width:640px;height:360px",
        "left:0px;top:0px;width:0px;height:360px",
        "left:0px;top:0px;width:47.99px;height:360px",
        "left:0px;top:0px;width:640px;height:23.99px",
    ],
)
def test_slide_css_strips_partial_or_off_canvas_geometry(geometry: str) -> None:
    assert _retained_slide_css(
        f"section{{font-size:32px;{geometry}}}"
    ) == "section{font-size:32px;}"


def test_slide_css_strips_border_above_two_pixels() -> None:
    assert _retained_slide_css(
        "section{font-size:32px;border:2.01px solid #0B1F3A;"
        "box-sizing:border-box}"
    ) == "section{font-size:32px;}"


def test_slide_css_rejects_border_only_priority_repair() -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={
                        "content": (
                            "section{border:2px solid #0B1F3A;"
                            "box-sizing:border-box}"
                        )
                    }
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_geometry_must_target_exactly_one_manifest_element() -> None:
    body = (
        '<section><div class="node">First</div>'
        '<div class="node">Second</div></section>'
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=".node{left:80px;top:80px;width:320px;height:120px}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_requires_important_for_authenticated_inline_geometry() -> None:
    body = (
        '<section style="left:0px;width:640px;height:360px">'
        "Current PSI control loop</section>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css="section{left:80px;top:80px;width:640px;height:360px}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_allows_important_for_authenticated_inline_geometry() -> None:
    body = (
        '<section style="position:absolute;left:0px;top:0px;'
        'width:640px;height:360px">'
        "Current PSI control loop</section>"
    )
    geometry = (
        "section{left:80px!important;top:80px!important;"
        "width:640px!important;height:360px!important}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=geometry,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
        + "section{left:80px!important;top:80px!important;"
        "width:640px!important;height:360px!important;}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("body", "geometry"),
    [
        (
            '<section style="position:absolute;left:80px;top:80px;'
            'width:640px;height:360px">Current PSI control loop</section>',
            "left:120px!important;top:120px!important;"
            "width:320px!important;height:360px!important",
        ),
        (
            '<section style="position:absolute;left:80px;top:80px;'
            'width:640px;height:360px">Current PSI control loop</section>',
            "left:120px!important;top:120px!important;"
            "width:640px!important;height:180px!important",
        ),
        (
            '<section style="position:absolute;left:80px;top:80px;'
            'width:640px;height:360px"><h1>Current PSI</h1>'
            "<p>Control loop</p></section>",
            "left:120px!important;top:120px!important;"
            "width:320px!important;height:360px!important",
        ),
    ],
    ids=(
        "width",
        "height",
        "text-bearing-container",
    ),
)
def test_slide_css_normalizes_shrinking_authenticated_semantic_geometry(
    body: str,
    geometry: str,
) -> None:
    request, context, candidate = _contrast_candidate(
        body=body,
        css=f"section{{{geometry}}}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert "left:120px!important;top:120px!important" in slide_css
    assert "width:640px!important;height:360px!important" in slide_css
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("geometry", "retained_size"),
    [
        (
            "left:160px!important;top:120px!important;"
            "width:640px!important;height:360px!important",
            "width:640px!important;height:360px!important",
        ),
        (
            "left:40px!important;top:40px!important;"
            "width:720px!important;height:400px!important",
            "width:720px!important;height:400px!important",
        ),
    ],
    ids=("translation", "expansion"),
)
def test_slide_css_allows_translation_or_expansion_of_semantic_geometry(
    geometry: str,
    retained_size: str,
) -> None:
    body = (
        '<section style="position:absolute;left:80px;top:80px;'
        'width:640px;height:360px"><h1>Current PSI</h1>'
        "<p>Control loop</p></section>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=f"section{{{geometry}}}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert retained_size in slide_css
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize("source_role", ["slide_css", "deck_css"])
def test_slide_css_normalizes_shrinking_authenticated_stylesheet_geometry(
    source_role: str,
) -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    baseline_css = (
        ".target{position:absolute;left:80px;top:80px;"
        "width:640px;height:360px}"
    )
    if source_role == "slide_css":
        context = _context_with_slide_css_baseline(
            context,
            baseline_css,
        )
        candidate = _candidate_with_slide_css_baseline_hash(
            candidate,
            baseline_css,
        )
    else:
        context = _with_deck_css(context, baseline_css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert slide_css == (
        RETAINED_SLIDE_CSS_TEXT
        + ".target{left:120px;top:120px;width:640px;height:360px;}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("baseline_css", "expected_size"),
    [
        (
            "section{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
            ".target{width:720px}",
            "width:720px;height:360px",
        ),
        (
            ".target{position:absolute;left:80px;top:80px;"
            "width:640.25px;height:360.5px}",
            "width:640.25px;height:360.5px",
        ),
    ],
    ids=("specificity", "fractional-pixels"),
)
def test_slide_css_normalizes_authenticated_size_cascade_regression(
    baseline_css: str,
    expected_size: str,
) -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert expected_size in slide_css
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "baseline_css",
    [
        "",
        ".target{width:640px}",
        ".target{width:auto;height:360px}",
    ],
    ids=("absent", "partial", "auto"),
)
def test_slide_css_rejects_text_geometry_without_literal_baseline_dimensions(
    baseline_css: str,
) -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:48px;height:24px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("body", "baseline_css"),
    [
        (
            '<section class="target">Current PSI control loop</section>',
            (
                ".target{left:80px!important;top:80px!important;"
                "width:640px!important;height:360px!important}"
            ),
        ),
        (
            '<section class="frame"><div class="target">Current PSI control '
            "loop</div></section>",
            (
                ".frame .target{left:80px;top:80px;"
                "width:640px;height:360px}"
            ),
        ),
    ],
    ids=("important", "higher-specificity"),
)
def test_slide_css_rejects_cascade_dead_geometry(
    body: str,
    baseline_css: str,
) -> None:
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_canvas_wrapper_cascade_dead_geometry() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".slide-root .target{left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_appended_same_specificity_geometry_wins_cascade() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    baseline_css = (
        ".target{position:absolute;left:80px;top:80px;"
        "width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert slide_css.endswith(
        ".target{left:120px;top:120px;width:640px;height:360px;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_pins_trusted_canvas_origin_against_authenticated_margin() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".slide-root{margin-left:1000px}"
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert slide_css.endswith(
        ".target{left:120px;top:120px;width:640px;height:360px;}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "canvas_override",
    [
        "position:static!important",
        "width:100px!important;height:100px!important",
    ],
    ids=("position", "dimensions"),
)
def test_slide_css_trusted_canvas_resists_authenticated_override(
    canvas_override: str,
) -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            f".slide-root{{{canvas_override}}}"
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert slide_css.endswith(
        ".target{left:120px;top:120px;width:640px;height:360px;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_trusted_canvas_resists_authenticated_display_override() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".slide-root{display:contents!important}"
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert slide_css.endswith(
        ".target{left:120px;top:120px;width:640px;height:360px;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_target_without_principal_box() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    baseline_css = (
        ".target{display:contents;position:absolute;left:80px;top:80px;"
        "width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "body",
    [
        '<section hidden class="target">Current PSI control loop</section>',
        (
            '<div hidden><section class="target">'
            "Current PSI control loop</section></div>"
        ),
    ],
    ids=("target", "ancestor"),
)
def test_slide_css_rejects_hidden_html_geometry_target(body: str) -> None:
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:80px;width:640px;height:360px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "hidden_ancestor_css",
    [
        "display:none",
        "visibility:hidden",
        "opacity:0",
        "clip-path:inset(100%)",
    ],
)
def test_slide_css_rejects_hidden_geometry_target_ancestor(
    hidden_ancestor_css: str,
) -> None:
    body = (
        '<div class="frame"><section class="target">'
        "Current PSI control loop</section></div>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:80px;width:640px;height:360px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            f".frame{{{hidden_ancestor_css}}}"
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "hidden_shell_css",
    [
        "visibility:hidden",
        "opacity:0",
        "clip-path:inset(100%)",
    ],
)
def test_slide_css_rejects_hidden_shell_ancestor(
    hidden_shell_css: str,
) -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:80px;width:640px;height:360px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            f"body{{{hidden_shell_css}}}"
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_trusted_shell_resists_authenticated_display_override() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:80px;width:640px;height:360px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            "body{display:none!important}"
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert slide_css.endswith(
        ".target{left:120px;top:80px;width:640px;height:360px;}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "coordinate_effect",
    [
        "transform:rotate(0deg)",
        'offset:path("M 0 0 L 1000 0") 100%',
        'motion-path:path("M 0 0 L 1000 0")',
    ],
)
def test_slide_css_rejects_transformed_geometry_target(
    coordinate_effect: str,
) -> None:
    body = '<section class="target">Current PSI control loop</section>'
    baseline_css = (
        f".target{{position:absolute;{coordinate_effect};"
        "left:80px;top:80px;width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_nonzero_authenticated_target_margin() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    baseline_css = (
        ".target{position:absolute;left:80px;top:80px;"
        "width:640px;height:360px;margin-left:100px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:1280px;top:80px;width:640px;height:360px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_unreset_user_agent_target_margin() -> None:
    body = '<h1 class="target">Current PSI control loop</h1>'
    baseline_css = (
        ".target{position:absolute;left:80px;top:80px;"
        "width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:640px;height:360px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_content_box_geometry_target() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    baseline_css = (
        ".target{position:absolute;box-sizing:content-box;"
        "left:80px;top:80px;width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:640px;height:360px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_static_target_geometry_noop() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    baseline_css = (
        ".target{left:80px;top:80px;width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_nested_positioned_containing_block() -> None:
    body = (
        '<section class="frame"><div class="target">'
        "Current PSI control loop</div></section>"
    )
    baseline_css = (
        ".frame{position:relative}"
        ".target{position:absolute;left:80px;top:80px;"
        "width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "containing_block_css",
    [
        "transform:rotate(0deg)",
        "-webkit-transform:rotate(0deg)",
        "perspective:1000px",
        "contain:layout",
        "container-type:inline-size",
        "content-visibility:auto",
        "will-change:transform",
        "translate:0px",
        "zoom:2",
    ],
)
def test_slide_css_rejects_nonpositioned_containing_block_ancestor(
    containing_block_css: str,
) -> None:
    body = (
        '<section class="frame"><div class="target">'
        "Current PSI control loop</div></section>"
    )
    baseline_css = (
        f".frame{{{containing_block_css}}}"
        ".target{position:absolute;left:80px;top:80px;"
        "width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_unit_spelling_only_geometry_change() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    baseline_css = (
        ".target{position:absolute;left:0;top:0;"
        "width:640px;height:360px}"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:0px;top:0px;width:640px;height:360px}"
        ),
    )
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_ambiguous_authenticated_size_cascade() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;width:320px;height:180px}"
        ),
    )
    baseline_css = ".target{width:50%;height:360px}"
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_preserved_text_geometry_must_remain_on_canvas() -> None:
    body = (
        '<section class="target" style="position:absolute;left:80px;'
        'top:80px;width:640px;height:360px">Current PSI control loop'
        "</section>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:1500px!important;top:120px!important;"
            "width:320px!important;height:180px!important}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_preserved_text_geometry_must_fit_compiled_budget() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    raw_css = ".target{left:0px;top:0px;width:48px;height:24px}"
    request, context, candidate = _contrast_candidate(
        body=body,
        css=raw_css,
    )
    retained_raw_css = _retained_slide_css(raw_css)
    normalized_css = (
        ".target{left:0px;top:0px;width:1920px;height:24px;}"
    )
    baseline_prefix = ".target{width:1920px;height:24px}/*"
    baseline_suffix = "*/"
    baseline_size = (
        1_024
        - len(SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR.encode())
        - len(retained_raw_css.encode())
    )
    baseline_css = (
        baseline_prefix
        + (
            "x"
            * (
                baseline_size
                - len(baseline_prefix.encode())
                - len(baseline_suffix.encode())
            )
        )
        + baseline_suffix
    )
    assert len(
        compose_authenticated_slide_css(
            baseline=baseline_css,
            overlay=retained_raw_css,
        ).encode()
    ) == 1_024
    assert len(
        compose_authenticated_slide_css(
            baseline=baseline_css,
            overlay=normalized_css,
        ).encode()
    ) > 1_024
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_inline_size_wins_over_authenticated_stylesheet() -> None:
    body = (
        '<section class="target" style="position:absolute;left:80px;'
        'top:80px;width:640px;height:360px">Current PSI control loop'
        "</section>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px!important;top:120px!important;"
            "width:700px!important;height:400px!important}"
        ),
    )
    context = _with_deck_css(
        context,
        ".target{width:800px;height:500px}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert "width:700px!important;height:400px!important" in slide_css
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_shrinking_text_free_geometry() -> None:
    body = (
        '<section><div class="ornament" style="position:absolute;'
        'left:20px;top:20px;width:200px;height:120px"></div></section>'
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".ornament{left:40px!important;top:40px!important;"
            "width:100px!important;height:60px!important}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_geometry_without_authenticated_baseline_insets() -> None:
    body = (
        '<section class="target" style="position:absolute;width:640px;'
        'height:360px">Current PSI control loop</section>'
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:10px!important;top:10px!important;"
            "width:640px!important;height:360px!important}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("body", "authenticated_css"),
    [
        (
            '<section class="target">Current PSI control loop</section>',
            ".target{z-index:-1;position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}",
        ),
        (
            '<div class="frame"><section class="target">'
            "Current PSI control loop</section></div>",
            ".frame{z-index:-1}.target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}",
        ),
    ],
    ids=("target", "ancestor"),
)
def test_slide_css_rejects_negative_authenticated_stacking_order(
    body: str,
    authenticated_css: str,
) -> None:
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:80px;width:640px;height:360px}"
        ),
    )
    context = _with_deck_css(context, authenticated_css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_allows_nonnegative_authenticated_stacking_order() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:80px;width:640px;height:360px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".target{z-index:1;position:absolute;left:80px;top:80px;"
            "width:640px;height:360px}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert slide_css.endswith(
        ".target{left:120px;top:80px;width:640px;height:360px;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_unnecessary_important_geometry() -> None:
    body = "<section>Current PSI control loop</section>"
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            "section{left:80px!important;top:80px!important;"
            "width:640px!important;height:360px!important}"
        ),
    )
    baseline_css = "section{width:640px;height:360px}"
    context = _context_with_slide_css_baseline(context, baseline_css)
    candidate = _candidate_with_slide_css_baseline_hash(
        candidate,
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_inline_important_geometry_target() -> None:
    body = (
        '<section style="left:0px!important;width:640px;height:360px">'
        "Current PSI control loop</section>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            "section{left:80px!important;top:80px!important;"
            "width:640px!important;height:360px!important}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_css_targets_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "inline_style",
    [
        "inset:0",
        "inset:0!important",
        "inset-inline-start:0",
        "all:initial",
        "all:initial!important",
        "inline-size:640px",
        "max-width:640px",
        "right:0",
    ],
)
def test_slide_css_rejects_ambiguous_inline_geometry_target(
    inline_style: str,
) -> None:
    body = (
        f'<section style="{inline_style}">'
        "Current PSI control loop</section>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            "section{left:80px!important;top:80px!important;"
            "width:640px!important;height:360px!important}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_three_priority_selectors_each_require_retained_geometry() -> None:
    program = _overlapping_three_selector_program()
    body = (
        '<section class="subject" style="position:absolute;box-sizing:border-box;left:80px;top:80px;'
        'width:640px;height:360px">Current PSI</section>'
        '<section class="mechanism" style="position:absolute;box-sizing:border-box;left:800px;top:80px;'
        'width:640px;height:360px">Control loop</section>'
    )
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    sources = tuple(
        RepairSourceContext(
            build_id="build-psi-001",
            manifest_revision=1,
            manifest_hash=MANIFEST_HASH,
            selector=selector,
            source_role="body",
            component_version_id=f"{selector}-version-001",
            manifest_source_path=f"versions/{selector}/body.html",
            manifest_source_hash=body_hash,
            text=body,
        )
        for selector in program.authorized_selectors
    )

    def candidate_with(css_by_selector: dict[str, str]) -> DeckRepairCandidate:
        return DeckRepairCandidate(
            source_updates=tuple(
                SourceUpdate(
                    selector=selector,
                    source_role="slide_css",
                    expected_source_hash=SLIDE_CSS_HASH,
                    content=_retained_slide_css(css),
                )
                for selector, css in css_by_selector.items()
            ),
            rationale="Use distinct structural interventions for every priority.",
        )

    complete = candidate_with(
        {
            "slide:1": (
                ".subject{left:120px!important;top:100px!important;"
                "width:640px!important;height:360px!important}"
                ".mechanism{left:840px!important;top:100px!important;"
                "width:640px!important;height:360px!important}"
            ),
            "slide:2": (
                ".subject{left:130px!important;top:140px!important;"
                "width:640px!important;height:360px!important}"
                ".mechanism{left:830px!important;top:140px!important;"
                "width:640px!important;height:360px!important}"
            ),
            "slide:3": (
                ".subject{left:140px!important;top:180px!important;"
                "width:640px!important;height:360px!important}"
                ".mechanism{left:820px!important;top:180px!important;"
                "width:640px!important;height:360px!important}"
            ),
        }
    )
    one_geometry_target = candidate_with(
        {
            "slide:1": (
                ".subject{left:120px!important;top:100px!important;"
                "width:640px!important;height:360px!important}"
                ".mechanism{left:840px!important;top:100px!important;"
                "width:640px!important;height:360px!important}"
            ),
            "slide:2": (
                ".subject{left:130px!important;top:140px!important;"
                "width:640px!important;height:360px!important}"
                ".mechanism{left:830px!important;top:140px!important;"
                "width:640px!important;height:360px!important}"
            ),
            "slide:3": (
                ".subject{left:140px!important;top:180px!important;"
                "width:640px!important;height:360px!important}"
            ),
        }
    )

    assert _candidate_materializes_priority_contract(
        complete,
        program,
        sources,
    )
    assert not _candidate_materializes_priority_contract(
        one_geometry_target,
        program,
        sources,
    )

    nonimportant_complete = complete.model_copy(
        update={
            "source_updates": tuple(
                update.model_copy(
                    update={
                        "content": update.content.replace("!important", "")
                    }
                )
                for update in complete.source_updates
            )
        }
    )
    assert not _candidate_materializes_priority_contract(
        nonimportant_complete,
        program,
        sources,
    )

    nested_body = (
        '<section class="subject" style="left:80px;top:80px;'
        'width:640px;height:360px">'
        '<div class="mechanism" style="left:800px;top:80px;'
        'width:640px;height:360px">Current PSI control loop</div>'
        "</section>"
    )
    nested_hash = hashlib.sha256(nested_body.encode()).hexdigest()
    nested_sources = tuple(
        source.model_copy(
            update={"manifest_source_hash": nested_hash, "text": nested_body}
        )
        for source in sources
    )
    assert not _candidate_materializes_priority_contract(
        complete,
        program,
        nested_sources,
    )


def _three_priority_author_pipeline_case(
    *,
    incomplete_geometry_selector: str | None = None,
    authenticated_geometry: bool = True,
    shrink_geometry: bool = False,
) -> tuple[
    RepairInvocationRequest,
    RepairAuthorContext,
    DeckRepairCandidate,
    dict[str, str],
]:
    program = _overlapping_three_selector_program()
    request = _request(program=program)
    body = (
        (
            '<section class="subject" style="position:absolute;box-sizing:border-box;left:80px;'
            'top:80px;width:640px;height:360px">Current PSI</section>'
            '<section class="mechanism" style="position:absolute;box-sizing:border-box;left:800px;'
            'top:80px;width:640px;height:360px">Control loop</section>'
        )
        if authenticated_geometry
        else (
            '<section class="subject">Current PSI</section>'
            '<section class="mechanism">Control loop</section>'
        )
    )
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    base = _context(request=request)
    sources = tuple(
        RepairSourceContext(
            build_id=request.build_id,
            manifest_revision=program.initial_manifest_revision,
            manifest_hash=MANIFEST_HASH,
            selector=selector,
            source_role=source_role,
            component_version_id=f"{selector}-{source_role}-version-001",
            manifest_source_path=(
                f"versions/{selector.replace(':', '-')}/{source_role}.txt"
            ),
            manifest_source_hash=(
                SLIDE_CSS_HASH if source_role == "slide_css" else body_hash
            ),
            text=BASELINE_SLIDE_CSS_TEXT if source_role == "slide_css" else body,
        )
        for selector in program.authorized_selectors
        for source_role in program.authorized_source_roles[selector]
    )
    renders = tuple(
        RepairContextImage(
            artifact_version_id=request.initial_artifact_version_id,
            selector=evidence.selector,
            path=evidence.path,
            sha256=evidence.sha256,
            width=64,
            height=36,
            png_bytes=RENDER_BYTES,
        )
        for repair in program.selector_repairs
        for evidence in repair.render_evidence
    )
    context = base.model_copy(
        update={
            "authorized_sources": sources,
            "failing_renders": renders,
            "owned_assets": (),
        }
    )
    css_by_selector: dict[str, str] = {}
    for index, selector in enumerate(program.authorized_selectors):
        top = 100 + index * 40
        subject_left = 120 + index * 10
        mechanism_left = 840 - index * 10
        importance = "!important" if authenticated_geometry else ""
        width = 320 if shrink_geometry else 640
        height = 180 if shrink_geometry else 360
        mechanism_geometry = (
            f"left:{mechanism_left}px{importance};top:{top}px{importance};"
            f"width:{width}px{importance}"
            if selector == incomplete_geometry_selector
            else (
                f"left:{mechanism_left}px{importance};top:{top}px{importance};"
                f"width:{width}px{importance};height:{height}px{importance}"
            )
        )
        css_by_selector[selector] = (
            f".subject{{left:{subject_left}px{importance};top:{top}px{importance};"
            f"width:{width}px{importance};height:{height}px{importance};"
            "display:flex}"
            f".mechanism{{{mechanism_geometry};display:flex}}"
        )
    candidate = DeckRepairCandidate(
        source_updates=tuple(
            SourceUpdate(
                selector=selector,
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=css_by_selector[selector],
            )
            for selector in program.authorized_selectors
        ),
        rationale="Use two independent geometry targets for every priority.",
    )
    return request, context, candidate, css_by_selector


def test_production_author_retains_three_priority_geometry_repairs_after_filtering(
) -> None:
    request, context, candidate, raw_css_by_selector = (
        _three_priority_author_pipeline_case()
    )
    acceptance = _campaign_acceptance_contract(request.program)
    assert acceptance["distinct_priority_selector_count"] == 3
    assert set(acceptance["priority_selector_by_failure_code"].values()) == set(
        request.program.authorized_selectors
    )
    assert all("display:flex" in css for css in raw_css_by_selector.values())
    invoker = FakeTwoPhaseInvoker(candidate=candidate)
    author, _loader, _invoker = _author(
        request=request,
        context=context,
        invoker=invoker,
    )

    result = _run(author(request))

    result_css_by_selector = {
        update.selector: update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    }
    assert result_css_by_selector == {
        selector: _retained_slide_css(raw_css)
        for selector, raw_css in raw_css_by_selector.items()
    }
    assert all(
        css.count("left:") == 2 and "display" not in css
        for css in result_css_by_selector.values()
    )
    assert _candidate_materializes_priority_contract(
        result.candidate,
        request.program,
        context.authorized_sources,
    )
    assert len(invoker.invoke_calls) == 1


def test_production_author_normalizes_three_priority_text_geometry_shrink(
) -> None:
    request, context, candidate, raw_css_by_selector = (
        _three_priority_author_pipeline_case(
            authenticated_geometry=True,
            shrink_geometry=True,
        )
    )
    assert all(
        "width:320px!important;height:180px!important" in css
        for css in raw_css_by_selector.values()
    )
    invoker = FakeTwoPhaseInvoker(candidate=candidate)
    author, _loader, _invoker = _author(
        request=request,
        context=context,
        invoker=invoker,
    )

    result = _run(author(request))

    result_css = tuple(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert len(result_css) == 3
    assert all(
        css.count("width:640px!important;height:360px!important") == 2
        and "width:320px" not in css
        and "height:180px" not in css
        and "display" not in css
        for css in result_css
    )
    assert _candidate_materializes_priority_contract(
        result.candidate,
        request.program,
        context.authorized_sources,
        context.read_only_sources,
    )
    assert len(invoker.invoke_calls) == 1


def test_production_author_rejects_filtered_required_priority_geometry_target(
) -> None:
    request, context, candidate, raw_css_by_selector = (
        _three_priority_author_pipeline_case(
            incomplete_geometry_selector="slide:3",
        )
    )
    retained_slide_three = _retained_slide_css(raw_css_by_selector["slide:3"])
    assert ".subject{" in retained_slide_three
    assert ".mechanism{" not in retained_slide_three
    traces = FakeTraceFactory()
    invoker = FakeTwoPhaseInvoker(candidate=candidate)
    author, _loader, _invoker = _author(
        request=request,
        context=context,
        invoker=invoker,
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1
    assert traces.spans[0].outputs[0].error_code == (
        "candidate_source_contract_invalid"
    )


def test_slide_css_keeps_full_frame_and_strips_directional_border_fragments() -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={
                        "content": (
                            "section{font-size:32px;box-sizing:border-box;"
                            "border:2px solid #0B1F3A;border-radius:12px;"
                            "border-left:4px solid #EA7C32;"
                            "border-top-width:3px;border-color:#FFFFFF}"
                        )
                    }
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        "section{font-size:32px;box-sizing:border-box;"
        "border:2px solid #0B1F3A;border-radius:12px;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_strips_frame_dependents_split_from_full_border_rule() -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={
                        "content": (
                            "section{border:2px solid #0B1F3A}"
                            "section{border-radius:12px;box-sizing:border-box;"
                            "font-size:32px}"
                        )
                    }
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        "section{font-size:32px;}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "declaration",
    [
        "border-left-width:2px",
        "border-left-style:solid",
        "border-left-color:#0B1F3A",
        "border-right-width:2px",
        "border-right-style:solid",
        "border-right-color:#0B1F3A",
        "border-top-width:2px",
        "border-top-style:solid",
        "border-top-color:#0B1F3A",
        "border-bottom-width:2px",
        "border-bottom-style:solid",
        "border-bottom-color:#0B1F3A",
        "border-top-left-radius:12px",
        "border-top-right-radius:12px",
        "border-bottom-left-radius:12px",
        "border-bottom-right-radius:12px",
        "border-inline:2px solid #0B1F3A",
        "border-inline-start:2px solid #0B1F3A",
        "border-inline-end:2px solid #0B1F3A",
        "border-block:2px solid #0B1F3A",
        "border-block-start:2px solid #0B1F3A",
        "border-block-end:2px solid #0B1F3A",
        "border-start-start-radius:12px",
        "border-start-end-radius:12px",
        "border-end-start-radius:12px",
        "border-end-end-radius:12px",
    ],
)
def test_slide_css_strips_every_directional_border_longhand(
    declaration: str,
) -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": f"section{{font-size:32px;{declaration}}}"}
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == "section{font-size:32px;}"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "declaration",
    [
        "line-height:0",
        "line-height:-999px",
        "line-height:var(--x)",
        "box-sizing:border-box",
        "border-radius:12px",
        "border:1px solid #0B1F3A",
        "border:9999px solid #0B1F3A",
        "border-left:1px solid #0B1F3A",
        "border-top:1px solid #0B1F3A",
        "border-bottom:1px solid #0B1F3A",
        "border-right:1px solid #0B1F3A",
        "border-width:1px",
        "border-style:solid",
        "border-color:#0B1F3A",
        "border:1px dashed #0B1F3A",
        "border:1px dotted #0B1F3A",
        "border:1px double #0B1F3A",
        "border:1px solid rgba(11,31,58,.5)",
        "border-width:calc(100% + 1px)",
        "box-sizing:inherit",
        "font-size:32px!important",
        "border:1px solid transparent",
        "border-radius:51%",
        "border-radius:-1px",
    ],
)
def test_slide_css_rejects_candidate_without_safe_retained_value(
    declaration: str,
) -> None:
    request = _request()
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": f"section{{{declaration}}}"}
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_canonicalization_invalid"
    assert len(invoker.invoke_calls) == 1


def _contrast_candidate(
    *,
    body: str,
    css: str,
) -> tuple[
    RepairInvocationRequest,
    RepairAuthorContext,
    DeckRepairCandidate,
]:
    request = _request(program=_program())
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    base_context = _context(request=request)
    context = base_context.model_copy(
        update={
            "authorized_sources": tuple(
                source.model_copy(
                    update={
                        "text": body,
                        "manifest_source_hash": body_hash,
                    }
                )
                if source.source_role == "body"
                else source
                for source in base_context.authorized_sources
            )
        }
    )
    candidate = _candidate_with_body(
        body,
        expected_source_hash=body_hash,
    )
    candidate = candidate.model_copy(
        update={
            "source_updates": (
                candidate.source_updates[0],
                candidate.source_updates[1].model_copy(
                    update={"content": SLIDE_CSS_TEXT + css}
                ),
            )
        }
    )
    return request, context, candidate


def _with_deck_css(
    context: RepairAuthorContext,
    deck_css: str,
) -> RepairAuthorContext:
    deck_css = "*{box-sizing:border-box}" + deck_css
    deck_css_hash = hashlib.sha256(deck_css.encode()).hexdigest()
    return context.model_copy(
        update={
            "read_only_sources": tuple(
                source.model_copy(
                    update={
                        "text": deck_css,
                        "manifest_source_hash": deck_css_hash,
                    }
                )
                for source in context.read_only_sources
            )
        }
    )


@pytest.mark.parametrize(
    ("paired_color", "safe_cascade"),
    [
        ("#FFFFFF", ""),
        ("rgb(255,255,255)", ""),
        ("#FFFFFF", "h1{color:#EDEEF2}"),
    ],
    ids=("hex", "rgb", "safe-child-foreground"),
)
def test_slide_css_allows_same_rule_opaque_text_background_contrast(
    paired_color: str,
    safe_cascade: str,
) -> None:
    request = _request(program=_program())
    context = _context(request=request)
    candidate = _candidate_with_body(SOURCE_TEXT)
    candidate_css = (
        SLIDE_CSS_TEXT
        + f"section{{background:#1D2027;color:{paired_color}}}{safe_cascade}"
    )
    candidate = candidate.model_copy(
        update={
            "source_updates": (
                candidate.source_updates[0],
                candidate.source_updates[1].model_copy(
                    update={"content": candidate_css}
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
        + f"section{{background:#1D2027;color:{paired_color};}}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "css",
    [
        (
            "section{background:#F4F5F7;color:#15171C}"
            "section{background:#1D2027;color:#FFFFFF}"
        ),
        (
            "section{background:#F4F5F7;color:#15171C}"
            "section h1{background:#1D2027;color:#FFFFFF}"
        ),
        (
            "section{background:#F4F5F7!important;color:#15171C!important}"
            "section{background:#1D2027;color:#FFFFFF}"
        ),
        (
            "section{background:#F4F5F7;color:#15171C}"
            "section{background:#1D2027!important;color:#FFFFFF!important}"
        ),
    ],
    ids=(
        "later-equal-specificity",
        "later-higher-specificity",
        "earlier-important",
        "later-important",
    ),
)
def test_slide_css_allows_safe_background_pair_cascade(css: str) -> None:
    request, context, candidate = _contrast_candidate(
        body=SOURCE_TEXT,
        css=css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))
    expected_overlay = {
        (
            "section{background:#F4F5F7;color:#15171C}"
            "section{background:#1D2027;color:#FFFFFF}"
        ): (
            "section{background:#F4F5F7;color:#15171C;}"
            "section{background:#1D2027;color:#FFFFFF;}"
        ),
        (
            "section{background:#F4F5F7;color:#15171C}"
            "section h1{background:#1D2027;color:#FFFFFF}"
        ): (
            "section{background:#F4F5F7;color:#15171C;}"
            "section h1{background:#1D2027;color:#FFFFFF;}"
        ),
        (
            "section{background:#F4F5F7!important;color:#15171C!important}"
            "section{background:#1D2027;color:#FFFFFF}"
        ): "section{background:#1D2027;color:#FFFFFF;}",
        (
            "section{background:#F4F5F7;color:#15171C}"
            "section{background:#1D2027!important;color:#FFFFFF!important}"
        ): "section{background:#F4F5F7;color:#15171C;}",
    }[css]
    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT + expected_overlay
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_allows_nested_opaque_surfaces() -> None:
    body = (
        '<section class="outer"><div class="inner">'
        "<p>Nested text</p></div></section>"
    )
    css = (
        ".outer{background:#1D2027;color:#FFFFFF}"
        ".inner{background:#F4F5F7;color:#15171C}"
    )
    request, context, candidate = _contrast_candidate(body=body, css=css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))
    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
        + ".outer{background:#1D2027;color:#FFFFFF;}"
        + ".inner{background:#F4F5F7;color:#15171C;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_allows_outer_foreground_shielded_by_nested_surface() -> None:
    body = (
        '<section class="outer"><div class="inner">'
        "<p>Nested text</p></div></section>"
    )
    css = (
        ".outer{background:#1D2027;color:#FFFFFF}"
        ".outer{color:#15171C}"
        ".inner{background:#F4F5F7;color:#15171C}"
    )
    request, context, candidate = _contrast_candidate(body=body, css=css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))
    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
        + ".outer{background:#1D2027;color:#FFFFFF;}"
        + ".inner{background:#F4F5F7;color:#15171C;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_discards_unpaired_outer_foreground_for_exposed_text() -> None:
    body = (
        '<section class="outer">Exposed text<div class="inner">'
        "<p>Nested text</p></div></section>"
    )
    css = (
        ".outer{background:#1D2027;color:#FFFFFF}"
        ".outer{color:#15171C}"
        ".inner{background:#F4F5F7;color:#15171C}"
    )
    request, context, candidate = _contrast_candidate(body=body, css=css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
        + ".outer{background:#1D2027;color:#FFFFFF;}"
        + ".inner{background:#F4F5F7;color:#15171C;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_discards_unpaired_foreground_without_collapsing_nodes() -> None:
    body = (
        '<section class="dark"><p>Same</p></section>'
        '<section class="light"><p>Same</p></section>'
    )
    css = (
        ".dark{background:#1D2027;color:#FFFFFF}"
        ".light{background:#F4F5F7;color:#15171C}"
        "p{color:#FFFFFF}"
    )
    request, context, candidate = _contrast_candidate(body=body, css=css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
        + ".dark{background:#1D2027;color:#FFFFFF;}"
        + ".light{background:#F4F5F7;color:#15171C;}"
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_rejects_authenticated_inline_low_contrast() -> None:
    body = (
        "<section>"
        '<h1 style="color:#15171C">Current PSI control loop</h1>'
        "</section>"
    )
    css = "section{background:#1D2027;color:#FFFFFF}"
    request, context, candidate = _contrast_candidate(body=body, css=css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_discards_non_geometry_important_paint_pair() -> None:
    body = (
        '<section style="background:#FFFFFF;color:#15171C">'
        "<h1>Current PSI control loop</h1></section>"
    )
    css = "section{background:#1D2027;color:#FFFFFF!important}"
    request, context, candidate = _contrast_candidate(body=body, css=css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1


def test_slide_css_resolves_authenticated_shared_deck_css_cascade() -> None:
    css = "section{background:#1D2027;color:#FFFFFF}"
    request, context, candidate = _contrast_candidate(
        body=SOURCE_TEXT,
        css=css,
    )
    deck_css = "h1{color:#15171C}"
    context = _with_deck_css(context, deck_css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "canvas_selector",
    [
        "main",
        ".slide-root",
        '[data-slide-canvas="true"]',
    ],
    ids=("main", "class", "data-attribute"),
)
def test_slide_css_discards_unpaired_foreground_over_compiler_canvas_shell(
    canvas_selector: str,
) -> None:
    css = "h1{color:#FFFFFF}"
    request, context, candidate = _contrast_candidate(
        body=SOURCE_TEXT,
        css=css,
    )
    deck_css = (
        f"{canvas_selector}{{background:#FFFFFF;color:#15171C}}"
    )
    context = _with_deck_css(context, deck_css)
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1


def test_slide_css_resolves_shared_canvas_descendant_foreground() -> None:
    css = "section{background:#1D2027;color:#FFFFFF}"
    request, context, candidate = _contrast_candidate(
        body=SOURCE_TEXT,
        css=css,
    )
    context = _with_deck_css(
        context,
        ".slide-root h1{color:#15171C}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_slide_css_skips_provably_transparent_shared_surface() -> None:
    body = '<section class="inner"><h1>Nested text</h1></section>'
    css = "h1{color:#FFFFFF}"
    request, context, candidate = _contrast_candidate(body=body, css=css)
    context = _with_deck_css(
        context,
        (
            ".slide-root{background:#1D2027;color:#FFFFFF}"
            ".inner{background:transparent;color:#FFFFFF}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))
    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1


def test_authenticated_shared_contrast_does_not_block_nonpaint_overlay() -> None:
    request = _request()
    context = _with_deck_css(
        _context(request=request),
        "section{background:#1D2027;color:#15171C}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=_candidate()),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "paint",
    ("#1D202780", "rgba(29,32,39,.5)"),
)
def test_authenticated_translucent_deck_paint_allows_nonpaint_overlay(
    paint: str,
) -> None:
    request = _request()
    context = _with_deck_css(
        _context(request=request),
        f"section{{background:{paint};color:#FFFFFF}}",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=_candidate()),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
    )
    assert len(invoker.invoke_calls) == 1


def test_geometry_over_translucent_deck_paint_requires_opaque_pair() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;"
            "width:320px;height:180px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px;"
            "background:#1D202780;color:#FFFFFF}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_geometry_over_translucent_deck_paint_allows_opaque_pair() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;"
            "width:320px;height:180px;"
            "background:#1D2027;color:#FFFFFF}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px;"
            "background:#1D202780;color:#FFFFFF}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    slide_css = next(
        update.content
        for update in result.candidate.source_updates
        if update.source_role == "slide_css"
    )
    assert "background:#1D2027;" in slide_css
    assert "color:#FFFFFF;" in slide_css
    assert len(invoker.invoke_calls) == 1


def test_geometry_over_translucent_deck_paint_rejects_split_pair() -> None:
    body = '<section class="target">Current PSI control loop</section>'
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;"
            "width:320px;height:180px}"
            ".target{background:#1D2027;color:#FFFFFF}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px;"
            "background:#1D202780;color:#FFFFFF}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_geometry_over_translucent_deck_paint_rejects_descendant_pair() -> None:
    body = (
        '<section class="target">'
        '<span class="label">Current PSI control loop</span>'
        "</section>"
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;"
            "width:320px;height:180px}"
            ".label{background:#1D2027;color:#FFFFFF}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".target{position:absolute;left:80px;top:80px;"
            "width:640px;height:360px;"
            "background:#1D202780;color:#FFFFFF}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_geometry_rejects_unpaired_translucent_sibling_surface() -> None:
    body = (
        '<section class="target">Current PSI control loop</section>'
        '<aside class="panel"></aside>'
    )
    request, context, candidate = _contrast_candidate(
        body=body,
        css=(
            ".target{left:120px;top:120px;"
            "width:320px;height:180px}"
        ),
    )
    context = _with_deck_css(
        context,
        (
            ".target{position:absolute;left:80px;top:80px;"
            "width:320px;height:180px;color:#FFFFFF}"
            ".panel{position:absolute;left:400px;top:80px;"
            "width:320px;height:180px;background:#1D202780}"
        ),
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_contract_invalid"
    assert len(invoker.invoke_calls) == 1


def test_authenticated_slide_contrast_does_not_block_nonpaint_overlay() -> None:
    request = _request()
    baseline_css = "section{background:#FFFFFF;color:#FFFFFF}"
    context = _context_with_slide_css_baseline(
        _context(request=request),
        baseline_css,
    )
    candidate = _candidate_with_slide_css_baseline_hash(
        _candidate(),
        baseline_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_allows_unmatched_auxiliary_foreground_with_safe_surface() -> None:
    css = (
        "section{background:#1D2027;color:#FFFFFF}"
        ".missing{color:#15171C}"
    )
    request, context, candidate = _contrast_candidate(
        body=SOURCE_TEXT,
        css=css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))
    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT
        + "section{background:#1D2027;color:#FFFFFF;}"
    )
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    ("unsafe_css", "trace_error_code"),
    [
        (
            "section{background:#1D2027;color:#15171C}",
            "candidate_source_contract_invalid",
        ),
        (
            "section{background:#1D2027;color:#FFFFFF;color:#15171C}",
            "candidate_source_contract_invalid",
        ),
        (
            ".missing{background:#1D2027;color:#FFFFFF}",
            "candidate_source_contract_invalid",
        ),
        (
            "@media (min-width:1px){section{background:#1D2027;color:#FFFFFF}"
            "h1{color:#15171C}}",
            "candidate_canonicalization_invalid",
        ),
        (
            "@media (min-width:1px){section{background:#1D2027}}",
            "candidate_canonicalization_invalid",
        ),
        (
            "@media (min-width:1px){"
            "section{background:#1D2027;color:#FFFFFF}}",
            "candidate_canonicalization_invalid",
        ),
    ],
    ids=(
        "low-contrast-pair",
        "final-duplicate-is-low-contrast",
        "unmatched-retained-selector",
        "nested-at-rule-override",
        "nested-at-rule",
        "safe-pair-at-rule-forbidden",
    ),
)
def test_slide_css_rejects_unsafe_final_paint_selector_or_structure(
    unsafe_css: str,
    trace_error_code: str,
) -> None:
    request = _request(program=_program())
    context = _context(request=request)
    candidate = _candidate_with_body(SOURCE_TEXT)
    candidate = candidate.model_copy(
        update={
            "source_updates": (
                candidate.source_updates[0],
                candidate.source_updates[1].model_copy(
                    update={"content": SLIDE_CSS_TEXT + unsafe_css}
                ),
            )
        }
    )
    traces = FakeTraceFactory()
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == trace_error_code
    assert len(invoker.invoke_calls) == 1
    assert traces.spans[0].outputs[0].error_code == trace_error_code


@pytest.mark.parametrize(
    ("discarded_css", "expected_suffix"),
    [
        ("section{background:#1D2027}", ""),
        ("section{color:#FFFFFF}section{background:#1D2027}", ""),
        (
            "section{background:#1D2027;color:#FFFFFF}"
            "section{color:#15171C}",
            "section{background:#1D2027;color:#FFFFFF;}",
        ),
        (
            "section{background:#1D2027;color:#FFFFFF}"
            "section{color:#15171C!important}",
            "section{background:#1D2027;color:#FFFFFF;}",
        ),
        (
            "section{background:#1D2027;color:#FFFFFF}"
            "html body section{color:#15171C}",
            "section{background:#1D2027;color:#FFFFFF;}",
        ),
        (
            "section{background:#1D2027;color:#FFFFFF}"
            "h1{color:#15171C}",
            "section{background:#1D2027;color:#FFFFFF;}",
        ),
        (
            "section{background-image:linear-gradient(#1D2027,#1D2027);"
            "color:#15171C}",
            "",
        ),
        (
            "section{background:linear-gradient(#1D2027,#1D2027);"
            "color:#FFFFFF}",
            "",
        ),
        ("section{background:rgba(29,32,39,.8);color:#FFFFFF}", ""),
    ],
    ids=(
        "missing-paired-foreground",
        "paint-split-across-rules",
        "later-unpaired-foreground",
        "later-important-foreground",
        "higher-specificity-unpaired-foreground",
        "child-unpaired-foreground",
        "background-image",
        "non-opaque-background-shorthand",
        "translucent-background",
    ),
)
def test_slide_css_discards_paint_that_is_not_safely_retained(
    discarded_css: str,
    expected_suffix: str,
) -> None:
    request, context, candidate = _contrast_candidate(
        body=SOURCE_TEXT,
        css=discarded_css,
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == (
        RETAINED_SLIDE_CSS_TEXT + expected_suffix
    )
    assert len(invoker.invoke_calls) == 1


def test_slide_css_allows_solid_background_on_decorative_only_element() -> None:
    body = (
        '<section><h1>Current PSI control loop</h1>'
        '<div class="ornament"></div></section>'
    )
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    request = _request(program=_program())
    context = _context(request=request)
    context = context.model_copy(
        update={
            "authorized_sources": tuple(
                source.model_copy(
                    update={"text": body, "manifest_source_hash": body_hash}
                )
                if source.source_role == "body"
                else source
                for source in context.authorized_sources
            )
        }
    )
    candidate = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=body_hash,
                content=body,
            ),
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=SLIDE_CSS_TEXT + ".ornament{background:#1D2027}",
            ),
        ),
        rationale="Use a decorative background without changing semantic text.",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "declaration",
    [
        "opacity:1",
        "box-shadow:0 1px 2px #000",
        "text-shadow:0 1px #000",
        "letter-spacing:1px",
        "filter:blur(1px)",
        "font-family:Inter",
        "font:700 20px Inter",
        "transition:all 1s",
    ],
)
def test_slide_css_discards_native_lossy_or_font_overrides_before_admission(
    declaration: str,
) -> None:
    request = _request(program=_program())
    context = _context(request=request)
    candidate = _candidate()
    candidate = candidate.model_copy(
        update={
            "source_updates": (
                candidate.source_updates[0],
                candidate.source_updates[1].model_copy(
                    update={
                        "content": SLIDE_CSS_TEXT
                        + f"section{{{declaration}}}"
                    }
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "declaration",
    [
        'content:"+"',
        "display:none",
        "display:var(--display)",
        "visibility:hidden",
        "visibility:collapse",
        "visibility:var(--visibility)",
        "visibility:inherit",
        "opacity:.0",
        "opacity:-.1",
        "opacity:var(--alpha)",
        "opacity:calc(1 - 1)",
        "font-size:0rem",
        "font-size:-1px",
        "font-size:var(--size)",
        "font-size:calc(12px - 12px)",
        "color:transparent",
        "color:rgba(0,0,0,0)",
        "color:#0000",
        "color:#00000000",
        "color:var(--ink)",
        "text-transform:none",
        "text-transform:uppercase",
        "all:initial",
        "list-style:none",
        "list-style-type:decimal",
        'list-style-image:url("marker.svg")',
    ],
    ids=(
        "generated-content",
        "display-none",
        "display-variable",
        "visibility-hidden",
        "visibility-collapse",
        "visibility-variable",
        "visibility-inherit",
        "opacity-zero",
        "opacity-negative",
        "opacity-variable",
        "opacity-calculation",
        "font-size-zero",
        "font-size-negative",
        "font-size-variable",
        "font-size-calculation",
        "transparent-color",
        "rgba-alpha-zero",
        "short-hex-alpha-zero",
        "long-hex-alpha-zero",
        "color-variable",
        "text-transform-none",
        "text-transform",
        "all-shorthand",
        "list-style",
        "list-style-type",
        "list-style-image",
    ),
)
def test_slide_css_filter_input_rejects_text_concealment_or_generation(
    declaration: str,
) -> None:
    request = _request(program=_program())
    context = _context(request=request)
    candidate = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=SLIDE_CSS_TEXT + f".candidate{{{declaration}}}",
            ),
        ),
        rationale="Keep visible text unchanged while adjusting the slide style.",
    )
    traces = FakeTraceFactory()
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_canonicalization_invalid"
    assert len(invoker.invoke_calls) == 1
    assert traces.spans[0].outputs[0].error_code == (
        "candidate_canonicalization_invalid"
    )


@pytest.mark.parametrize(
    "declaration",
    [
        "display:block",
        "display:inline-block",
        "display:flex",
        "overflow:hidden",
        "overflow:clip",
        "overflow:auto",
        "overflow:scroll",
        "overflow:visible",
        "overflow-x:hidden",
        "overflow-y:auto",
        "font-size:1px",
        "font-size:65px",
        "font-size:70px",
        "font-size:84px",
        "font-size:12pt",
        "font-size:2rem",
        "font-size:100%",
    ],
)
def test_slide_css_discards_benign_layout_or_invalid_font_size(
    declaration: str,
) -> None:
    request = _request(program=_program())
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={
                        "content": SLIDE_CSS_TEXT
                        + f"section{{{declaration}}}"
                    }
                ),
            )
        }
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    result = _run(author(request))

    assert result.candidate.source_updates[1].content == RETAINED_SLIDE_CSS_TEXT
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "nested_css",
    [
        ".outer{& .inner{opacity:0}}",
        "@media (min-width:1px){.outer{& .inner{color:#0000}}}",
    ],
    ids=("nested-qualified", "nested-qualified-in-media"),
)
def test_slide_css_candidate_rejects_nested_concealment(
    nested_css: str,
) -> None:
    request = _request(program=_program())
    context = _context(request=request)
    candidate = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="slide_css",
                expected_source_hash=SLIDE_CSS_HASH,
                content=SLIDE_CSS_TEXT + nested_css,
            ),
        ),
        rationale="Keep nested CSS from concealing visible text.",
    )
    author, _loader, invoker = _author(
        request=request,
        context=context,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_canonicalization_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize(
    "case",
    [
        "malformed",
        "nul",
        "style-breakout",
        "external-url",
        "external-image-set",
        "at-import",
        "oversize",
    ],
)
def test_slide_css_filter_input_rejects_structural_or_external_hazards(
    case: str,
) -> None:
    raw_css = {
        "malformed": "section{font-size:32px;broken}",
        "nul": "section{font-size:32px}\x00",
        "style-breakout": "section{font-size:32px}</style>",
        "external-url": 'section{background-image:url("asset.png")}',
        "external-image-set": (
            'section{background-image:image-set(url("asset.png") 1x)}'
        ),
        "at-import": '@import url("asset.css");section{font-size:32px}',
        "oversize": SLIDE_CSS_TEXT + "/*" + ("x" * (16 * 1_024)) + "*/",
    }[case]
    if case == "oversize":
        assert len(raw_css.encode()) > 16 * 1_024
    request = _request(program=_program())
    candidate = _candidate().model_copy(
        update={
            "source_updates": (
                _candidate().source_updates[0],
                _candidate().source_updates[1].model_copy(
                    update={"content": raw_css}
                ),
            )
        }
    )
    traces = FakeTraceFactory()
    author, _loader, invoker = _author(
        request=request,
        invoker=FakeTwoPhaseInvoker(candidate=candidate),
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_canonicalization_invalid"
    assert len(invoker.invoke_calls) == 1
    assert traces.spans[0].outputs[0].error_code == (
        "candidate_canonicalization_invalid"
    )


def test_safe_trace_network_work_runs_off_the_async_event_loop() -> None:
    request = _request()

    class ThreadRecordingSpan(FakeTraceSpan):
        def __init__(self) -> None:
            super().__init__()
            self.finish_thread_id: int | None = None

        def finish(self, output: SafeDeckRepairTraceOutput) -> None:
            self.finish_thread_id = threading.get_ident()
            super().finish(output)

    class ThreadRecordingFactory(FakeTraceFactory):
        def __init__(self) -> None:
            super().__init__()
            self.factory_thread_id: int | None = None
            self.span = ThreadRecordingSpan()

        def __call__(self, trace_input: SafeDeckRepairTraceInput) -> ThreadRecordingSpan:
            self.factory_thread_id = threading.get_ident()
            self.inputs.append(trace_input)
            self.spans.append(self.span)
            return self.span

    traces = ThreadRecordingFactory()
    author, _loader, invoker = _author(
        request=request,
        trace_factory=traces,
    )

    async def invoke() -> tuple[DeckRepairInvocationResult, int]:
        event_loop_thread_id = threading.get_ident()
        result = await author(request)
        await author.complete_success_trace(request, result)
        return result, event_loop_thread_id

    result, event_loop_thread_id = _run(invoke())

    assert result.metrics is invoker.result.metrics
    assert result.candidate.source_updates[0].content == SOURCE_TEXT
    assert traces.factory_thread_id is not None
    assert traces.span.finish_thread_id is not None
    assert traces.factory_thread_id != event_loop_thread_id
    assert traces.span.finish_thread_id != event_loop_thread_id


def test_cost_projection_reserves_both_dq1_runs_and_rejects_without_create() -> None:
    assert projected_repair_campaign_cost_usd(input_tokens=200) > 1
    assert repair_preflight_admitted(input_tokens=200)
    assert projected_repair_campaign_cost_usd(input_tokens=216_000) == Decimal("3.00")
    assert repair_preflight_admitted(input_tokens=216_000)
    assert projected_repair_campaign_cost_usd(input_tokens=216_001) == Decimal("3.000005")
    assert not repair_preflight_admitted(input_tokens=216_001)
    assert not repair_preflight_admitted(input_tokens=300_000)
    request = _request()
    invoker = FakeTwoPhaseInvoker(input_tokens=300_000)
    author, _loader, invoker = _author(request=request, invoker=invoker)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_cost_rejected")
    assert len(invoker.prepare_calls) == len(invoker.count_calls) == 1
    assert invoker.invoke_calls == []


@pytest.mark.parametrize("kind", ["source", "render"])
def test_unrelated_source_or_render_is_rejected_before_provider(kind: str) -> None:
    request = _request()
    context = _context(request=request)
    if kind == "source":
        extra = context.authorized_sources[0].model_copy(
            update={
                "selector": "slide:2",
                "component_version_id": "slide-2-version-001",
                "manifest_source_path": "versions/slide-2/body.html",
            }
        )
        context = context.model_copy(update={"authorized_sources": (*context.authorized_sources, extra)})
    else:
        extra = context.failing_renders[0].model_copy(update={"selector": "slide:2", "path": "renders/slide-2.png"})
        context = context.model_copy(update={"failing_renders": (*context.failing_renders, extra)})
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []


def test_render_hash_or_program_identity_mismatch_is_rejected_before_provider() -> None:
    request = _request(program=_program(render_hash=OTHER_HASH))
    context = _context(request=request)
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []


def test_unsupported_read_only_deck_css_is_rejected_before_provider() -> None:
    request = _request()
    context = _context(request=request)
    deck_css = "@media (min-width:1px){h1{color:#15171C}}"
    deck_css_hash = hashlib.sha256(deck_css.encode()).hexdigest()
    context = context.model_copy(
        update={
            "read_only_sources": tuple(
                source.model_copy(
                    update={
                        "text": deck_css,
                        "manifest_source_hash": deck_css_hash,
                    }
                )
                for source in context.read_only_sources
            )
        }
    )
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


@pytest.mark.parametrize("source", ["deck_css", "inline_body"])
def test_read_only_background_image_is_rejected_before_provider(
    source: str,
) -> None:
    request = _request()
    context = _context(request=request)
    if source == "deck_css":
        context = _with_deck_css(
            context,
            (
                ".special{background-color:#FFFFFF;"
                "background-image:linear-gradient(#000000,#000000);"
                "color:#FFFFFF}"
            ),
        )
    else:
        body = (
            '<section style="background:linear-gradient(#000000,#000000);'
            'color:#FFFFFF"><h1>Current PSI control loop</h1></section>'
        )
        body_hash = hashlib.sha256(body.encode()).hexdigest()
        context = context.model_copy(
            update={
                "authorized_sources": tuple(
                    source_context.model_copy(
                        update={
                            "text": body,
                            "manifest_source_hash": body_hash,
                        }
                    )
                    if source_context.source_role == "body"
                    else source_context
                    for source_context in context.authorized_sources
                )
            }
        )
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


def test_read_only_inline_translucent_paint_is_rejected_before_provider() -> None:
    request = _request()
    context = _context(request=request)
    body = (
        '<section style="background:rgba(29,32,39,.5);color:#FFFFFF">'
        "<h1>Current PSI control loop</h1></section>"
    )
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    context = context.model_copy(
        update={
            "authorized_sources": tuple(
                source.model_copy(
                    update={
                        "text": body,
                        "manifest_source_hash": body_hash,
                    }
                )
                if source.source_role == "body"
                else source
                for source in context.authorized_sources
            )
        }
    )
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


@pytest.mark.parametrize("source", ["deck_css", "inline_body"])
def test_invalid_background_color_none_is_rejected_before_provider(
    source: str,
) -> None:
    request = _request()
    context = _context(request=request)
    if source == "deck_css":
        context = _with_deck_css(
            context,
            (
                ".slide-root{background:#FFFFFF;color:#15171C}"
                "section{background-color:#000000;color:#FFFFFF}"
                "section{background-color:none}"
            ),
        )
    else:
        body = (
            '<section style="background-color:#000000;color:#FFFFFF;'
            'background-color:none"><h1>Current PSI control loop</h1></section>'
        )
        body_hash = hashlib.sha256(body.encode()).hexdigest()
        context = context.model_copy(
            update={
                "authorized_sources": tuple(
                    source_context.model_copy(
                        update={
                            "text": body,
                            "manifest_source_hash": body_hash,
                        }
                    )
                    if source_context.source_role == "body"
                    else source_context
                    for source_context in context.authorized_sources
                )
            }
        )
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


@pytest.mark.parametrize("source", ["deck_css", "inline_body"])
def test_invalid_literal_background_image_is_rejected_before_provider(
    source: str,
) -> None:
    request = _request()
    context = _context(request=request)
    if source == "deck_css":
        context = _with_deck_css(
            context,
            ".special{background-image:#000000;color:#FFFFFF}",
        )
    else:
        body = (
            '<section style="background-image:#000000;color:#FFFFFF">'
            "<h1>Current PSI control loop</h1></section>"
        )
        body_hash = hashlib.sha256(body.encode()).hexdigest()
        context = context.model_copy(
            update={
                "authorized_sources": tuple(
                    source_context.model_copy(
                        update={
                            "text": body,
                            "manifest_source_hash": body_hash,
                        }
                    )
                    if source_context.source_role == "body"
                    else source_context
                    for source_context in context.authorized_sources
                )
            }
        )
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert invoker.prepare_calls == []
    assert invoker.invoke_calls == []


def test_exact_program_source_role_and_manifest_hash_bind_candidate() -> None:
    request = _request()
    wrong = FakeTwoPhaseInvoker(candidate=_candidate(expected_source_hash=OTHER_HASH))
    author, _loader, invoker = _author(request=request, invoker=wrong)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "candidate_invalid")
    assert error.value.trace_error_code == "candidate_source_hash_invalid"
    assert len(invoker.invoke_calls) == 1


@pytest.mark.parametrize("kind", ["malformed", "oversize"])
def test_malformed_or_oversized_context_is_sanitized_before_provider(kind: str) -> None:
    request = _request()
    if kind == "malformed":
        context: object = {"private_source": "SECRET_CONTEXT"}
    else:
        valid = _context(request=request)
        oversized_source = valid.authorized_sources[0].model_copy(update={"text": "x" * (MAX_REPAIR_CONTEXT_SOURCE_BYTES + 1)})
        context = valid.model_copy(update={"authorized_sources": (oversized_source,)})
    author, _loader, invoker = _author(request=request, context=context)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "context_invalid")
    assert "SECRET_CONTEXT" not in str(error.value)
    assert invoker.prepare_calls == []


@pytest.mark.parametrize("stage", ["loader", "prepare", "count", "invoke"])
def test_raw_loader_or_provider_errors_are_sanitized(stage: str) -> None:
    request = _request()
    author, loader, invoker = _author(request=request)
    raw_error = RuntimeError("SECRET_PROMPT_IMAGE_SOURCE_PROVIDER_PAYLOAD")
    if stage == "loader":
        loader.error = raw_error
        expected = "context_unavailable"
    else:
        setattr(invoker, f"{stage}_error", raw_error)
        expected = "repair_unavailable"

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, expected)
    assert "SECRET_PROMPT_IMAGE_SOURCE_PROVIDER_PAYLOAD" not in str(error.value)
    if stage in {"loader", "prepare", "count"}:
        assert invoker.invoke_calls == []


@pytest.mark.parametrize("terminal", [False, True])
def test_trace_admission_failure_never_spends_provider_call(terminal: bool) -> None:
    request = _request()
    traces = FakeTraceFactory()
    if terminal:
        traces.already_terminal = True
    else:
        traces.error = RuntimeError("Authorization: Bearer raw-secret https://private.example/context")
    author, _loader, invoker = _author(
        request=request,
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert invoker.invoke_calls == []


def test_provider_failure_emits_only_controlled_trace_failure() -> None:
    request = _request()
    traces = FakeTraceFactory()
    invoker = FakeTwoPhaseInvoker()
    invoker.invoke_error = RuntimeError("SECRET_CONTEXT_SOURCE_MESSAGES_CANDIDATE_PROVIDER_PAYLOAD")
    author, _loader, invoker = _author(
        request=request,
        invoker=invoker,
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(author(request))

    _assert_code(error, "repair_unavailable")
    assert len(invoker.invoke_calls) == 1
    assert len(traces.spans) == 1
    output = traces.spans[0].outputs[0]
    assert output.status == "error"
    assert output.input_tokens == invoker.input_tokens
    assert output.output_tokens is None
    assert output.total_tokens is None
    assert output.error_code == "repair_unavailable"
    assert output.provider_error_type is None
    assert output.provider_status_code is None
    assert output.provider_response_status is None
    assert output.provider_incomplete_reason is None
    assert "SECRET_CONTEXT" not in repr(output)


def test_provider_exception_diagnostics_survive_to_safe_trace() -> None:
    request = _request()
    traces = FakeTraceFactory()
    invoker = FakeTwoPhaseInvoker()
    provider_error = DeckRepairInvocationError(
        "repair_unavailable",
        provider_error_type="BadRequestError",
        provider_status_code=400,
    )
    provider_error.__cause__ = RuntimeError("SECRET_RAW_PROVIDER_BODY")
    invoker.invoke_error = provider_error
    author, _loader, invoker = _author(
        request=request,
        invoker=invoker,
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as captured:
        _run(author(request))

    _assert_code(captured, "repair_unavailable")
    assert len(invoker.invoke_calls) == 1
    output = traces.spans[0].outputs[0]
    assert output.status == "error"
    assert output.error_code == "repair_unavailable"
    assert output.provider_error_type == "BadRequestError"
    assert output.provider_status_code == 400
    assert output.provider_response_status is None
    assert output.provider_incomplete_reason is None
    assert "SECRET_RAW_PROVIDER_BODY" not in repr(output)


def test_incomplete_response_diagnostics_survive_to_safe_trace() -> None:
    request = _request()
    traces = FakeTraceFactory()
    invoker = FakeTwoPhaseInvoker()
    invoker.invoke_error = DeckRepairInvocationError(
        "structured_output_invalid",
        provider_response_status="incomplete",
        provider_incomplete_reason="max_output_tokens",
    )
    author, _loader, invoker = _author(
        request=request,
        invoker=invoker,
        trace_factory=traces,
    )

    with pytest.raises(DeckRepairAuthorError) as captured:
        _run(author(request))

    _assert_code(captured, "repair_unavailable")
    assert len(invoker.invoke_calls) == 1
    output = traces.spans[0].outputs[0]
    assert output.status == "error"
    assert output.error_code == "structured_output_invalid"
    assert output.provider_error_type is None
    assert output.provider_status_code is None
    assert output.provider_response_status == "incomplete"
    assert output.provider_incomplete_reason == "max_output_tokens"
