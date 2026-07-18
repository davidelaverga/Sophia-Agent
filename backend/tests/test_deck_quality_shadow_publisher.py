from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from types import SimpleNamespace

import pytest
from langchain_openai import ChatOpenAI

from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.deck_quality import invoker as invoker_module
from deerflow.sophia.deck_quality import publisher
from deerflow.sophia.deck_quality.evidence import prepare_blind_visual_evidence
from deerflow.sophia.deck_quality.invoker import MultimodalStructuredModelInvoker
from deerflow.sophia.deck_quality.messages import build_blind_visual_messages
from deerflow.sophia.deck_quality.prompts import VersionedPrompt
from deerflow.sophia.deck_quality.schemas import (
    BlindVisualAssessment,
    ImageEvidence,
    QualityEvidenceSnapshot,
    QualityInstrumentLock,
    RenderEvidence,
    RubricCriterionProjection,
    RubricProjection,
    VisibleTextSlide,
)


def _config(*, users: set[str] | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        deck_quality=DeckQualityConfig(
            enabled=True,
            mode="shadow",
            canary_user_ids=users or {"canary-user"},
            max_quality_cost_usd="0.60",
        )
    )


def _state(tmp_path) -> dict:
    return {"thread_data": {"outputs_path": str(tmp_path / "outputs")}}


def _artifact(artifact_bytes: bytes = b"accepted pptx bytes") -> dict:
    artifact_sha256 = hashlib.sha256(artifact_bytes).hexdigest()
    return {
        "artifact_path": "/mnt/user-data/outputs/deck.pptx",
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "artifact_is_fallback": False,
        "artifact_id": "artifact-canary-1",
        "logical_artifact_id": "artifact-canary-1",
        "current_artifact_version_id": "artifact-version-canary-1",
        "manifest_revision": 1,
        "storage_provider": "supabase",
        "storage_status": "available",
        "storage_object_path": publisher.deck_quality_immutable_artifact_snapshot_path(
            user_id="canary-user",
            thread_id="companion-thread",
            build_id="build_01KXKNNQ5Z9N198VCMJPDWSBJ0",
            logical_artifact_id="artifact-canary-1",
            artifact_version_id="artifact-version-canary-1",
            artifact_sha256=artifact_sha256,
            artifact_virtual_path="/mnt/user-data/outputs/deck.pptx",
        ),
        "artifact_sha256": artifact_sha256,
        "deck_build_id": "build_01KXKNNQ5Z9N198VCMJPDWSBJ0",
        "builder_trace_root_run_id": "builder-trace-root-1",
        "mechanical_gate_results": {"passed": True},
        "source_retention_report": {"passed": True},
        "native_contrast_report": {"passed": True},
        "native_mechanical_report": {
            "lint_fix_success": True,
            "lint_residue_count": 0,
            "render_success": True,
        },
        "native_editability_score": 0.92,
        "missing_expected_visual_count": 0,
    }


def _payload(*, user_id: str = "canary-user") -> dict:
    return {
        "status": "success",
        "task_type": "presentation",
        "task_brief": "Build a concise deck about the PSI control loop.",
        "user_id": user_id,
        "thread_id": "companion-thread",
        "task_id": "builder-thread",
        "run_id": "builder-run-1",
        # Existing companion-side diagnostic correlation. DQ provenance must
        # use builder_trace_root_run_id instead.
        "trace_id": "companion-diagnostic-trace",
        "builder_trace_root_run_id": "builder-trace-root-1",
    }


def _instrument() -> SimpleNamespace:
    lock = QualityInstrumentLock(
        rubric_version="deck-rubric-v2",
        rubric_hash="a" * 64,
        prompt_hashes={"blind_visual": "b" * 64, "plan_realization": "c" * 64},
        judge_plan_hash="d" * 64,
        judge_profile_version="deck-visual-judge-v1",
        evidence_preprocessor_version="deck-evidence-v2",
        judge_invoker_version="deck-judge-invoker-v4",
        assessment_schema_versions={
            "blind_visual": "deck-quality-blind-assessment/v4",
            "mechanical": "deck-quality-mechanical-projection/v1",
            "plan_realization": "deck-quality-plan-assessment/v4",
        },
        adjudication_policy_hash="e" * 64,
    )
    return SimpleNamespace(lock=lock)


def _judge_plan() -> ResolvedModelPlan:
    return ResolvedModelPlan(
        route_name="deck.judge.visual",
        deployment_name="openai-gpt-5-6-sol",
        provider="openai",
        provider_model="gpt-5.6-sol",
        profile_name="deck-visual-judge-v2",
        profile_version="v2",
        capabilities=frozenset(
            {
                "image_input",
                "multi_image_input",
                "strict_structured_output",
                "reasoning_effort",
            }
        ),
        model_overrides={
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
        plan_hash="a" * 64,
    )


def _prepare_files(tmp_path, artifact_bytes: bytes = b"accepted pptx bytes") -> None:
    outputs = tmp_path / "outputs"
    deck_build = outputs / "deck_build"
    deck_build.mkdir(parents=True)
    (outputs / "deck.pptx").write_bytes(artifact_bytes)
    (deck_build / "creative_plan.json").write_text(
        json.dumps(
            {
                "subject": "PSI motivation architecture",
                "audience": "AI product and engineering leaders",
                "goal": "Explain the control mechanism",
                "viewing_context": "Projected technical review",
                "design_plan": {"requested_style_terms": ["restrained editorial"]},
            }
        ),
        encoding="utf-8",
    )
    (deck_build / "design_plan.json").write_text(
        json.dumps({"requested_style_terms": ["warm ivory"]}),
        encoding="utf-8",
    )
    (deck_build / "build.json").write_text(
        json.dumps({"build_id": "build_01KXKNNQ5Z9N198VCMJPDWSBJ0"}),
        encoding="utf-8",
    )


class _MemoryObjects:
    def __init__(self, artifact_path: str, artifact_bytes: bytes) -> None:
        self.objects = {artifact_path: artifact_bytes}
        self.creates: list[str] = []
        self.reads: list[tuple[str, int]] = []

    def read(self, object_path: str) -> bytes | None:
        return self.objects.get(object_path)

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        self.reads.append((object_path, max_bytes))
        content = self.objects.get(object_path)
        if content is not None and len(content) > max_bytes:
            raise ValueError("object exceeds bound")
        return content

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        del content_type
        self.creates.append(object_path)
        if object_path in self.objects:
            return "exists"
        self.objects[object_path] = content
        return "created"


def test_prepare_rejects_non_canary_before_any_file_access(tmp_path, monkeypatch) -> None:
    def forbidden_read(*_args, **_kwargs):
        raise AssertionError("ordinary-user scope must not read evidence")

    monkeypatch.setattr(publisher.Path, "read_bytes", forbidden_read)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(user_id="ordinary-user"),
    )
    assert prepared is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("artifact_is_fallback", True),
        ("storage_status", "missing"),
        ("mechanical_gate_results", {"passed": False}),
        ("artifact_path", "/mnt/user-data/outputs/deck.pdf"),
    ],
)
def test_prepare_fails_closed_for_noneligible_artifacts(
    tmp_path,
    field: str,
    value: object,
) -> None:
    artifact = _artifact()
    artifact[field] = value
    assert (
        publisher.prepare_deck_quality_publication(
            config=_config(),
            state=_state(tmp_path),
            artifact=artifact,
            completion_payload=_payload(),
        )
        is None
    )


def test_prepare_uses_exact_annotated_builder_trace_not_companion_trace(
    tmp_path,
) -> None:
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(),
    )

    assert prepared is not None
    assert prepared.parent_builder_trace_id == "builder-trace-root-1"
    assert prepared.parent_builder_trace_id != _payload()["trace_id"]


@pytest.mark.parametrize(
    ("artifact_trace", "payload_trace"),
    [
        (None, "builder-trace-root-1"),
        ("builder-trace-root-1", None),
        ("builder-trace-root-1", "different-builder-trace-root"),
        (" builder-trace-root-1 ", " builder-trace-root-1 "),
    ],
    ids=["artifact-missing", "payload-missing", "root-mismatch", "not-exact"],
)
def test_prepare_requires_matching_annotated_builder_trace_root(
    tmp_path,
    artifact_trace: str | None,
    payload_trace: str | None,
) -> None:
    artifact = _artifact()
    payload = _payload()
    if artifact_trace is None:
        artifact.pop("builder_trace_root_run_id")
    else:
        artifact["builder_trace_root_run_id"] = artifact_trace
    if payload_trace is None:
        payload.pop("builder_trace_root_run_id")
    else:
        payload["builder_trace_root_run_id"] = payload_trace

    assert (
        publisher.prepare_deck_quality_publication(
            config=_config(),
            state=_state(tmp_path),
            artifact=artifact,
            completion_payload=payload,
        )
        is None
    )


def test_publication_uses_exact_durable_artifact_version(tmp_path) -> None:
    _prepare_files(tmp_path)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(),
    )
    assert prepared is not None
    first = publisher._artifact_identity(prepared=prepared, artifact_hash="a" * 64)
    second = publisher._artifact_identity(prepared=prepared, artifact_hash="b" * 64)
    assert first == second == ("artifact-canary-1", "artifact-version-canary-1")


def test_publication_intent_is_content_free_and_reads_no_source_files(
    tmp_path,
    monkeypatch,
) -> None:
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(),
    )
    assert prepared is not None
    monkeypatch.setattr(
        publisher,
        "_captured_native_inputs",
        lambda _prepared: pytest.fail("intent construction cannot read source inputs"),
    )

    intent = publisher.build_deck_quality_publication_intent(
        prepared=prepared,
        instrument=_instrument(),
    )

    serialized = intent.model_dump_json()
    assert intent.artifact_sha256 == _artifact()["artifact_sha256"]
    assert "PSI control loop" not in serialized
    assert "mechanical_gate_results" not in serialized
    assert "creative_plan" not in serialized


def test_producer_bundle_encode_decode_is_strict_and_deterministic(tmp_path) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    prepared = prepared.model_copy(update={"task_brief": "Build a concise PSI deck.\n\nRelevant memories from this session:\n- private memory"})

    pack, source_pack_bytes = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=_instrument(),
    )
    first_encoded, first_descriptor = publisher.encode_deck_quality_producer_bundle(
        pack=pack,
        source_pack_bytes=source_pack_bytes,
    )
    second_encoded, second_descriptor = publisher.encode_deck_quality_producer_bundle(
        pack=pack,
        source_pack_bytes=source_pack_bytes,
    )
    decoded = publisher.decode_deck_quality_producer_bundle(
        first_encoded,
        expected_quality_run_id=pack.quality_run_id,
        expected_object_path=publisher.deck_quality_producer_bundle_path(pack.quality_run_id),
    )
    archive_path = publisher.deck_quality_producer_archive_path(pack.quality_run_id)
    archive_decoded = publisher.decode_deck_quality_producer_bundle(
        first_encoded,
        expected_quality_run_id=pack.quality_run_id,
        expected_object_path=archive_path,
    )

    assert first_encoded == second_encoded
    assert first_descriptor == second_descriptor == decoded.descriptor
    assert decoded.manifest.source_pack_sha256 == hashlib.sha256(source_pack_bytes).hexdigest()
    assert decoded.manifest.source_pack_size_bytes == len(source_pack_bytes)
    assert decoded.manifest.artifact_sha256 == hashlib.sha256(artifact_bytes).hexdigest()
    assert decoded.manifest.artifact_object_path == pack.immutable_snapshot_object_path
    assert decoded.manifest.source_pack_object_path == publisher.deck_quality_source_pack_path(
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        build_id=pack.build_id,
        quality_run_id=pack.quality_run_id,
    )
    assert len(first_encoded) <= 64 * 1024
    assert artifact_bytes not in first_encoded
    assert b"PSI motivation architecture" not in first_encoded
    assert b"creative_plan" not in first_encoded
    assert b"design_plan" not in first_encoded
    assert b"build_record" not in first_encoded
    assert publisher.parse_deck_quality_producer_bundle_path(decoded.descriptor.object_path) == pack.quality_run_id
    assert archive_decoded.descriptor.object_path == archive_path
    assert publisher.parse_deck_quality_producer_archive_path(archive_path) == pack.quality_run_id
    assert pack.accepted_delivery_object_path == prepared.artifact_storage_object_path
    assert pack.immutable_snapshot_object_path == pack.accepted_delivery_object_path
    assert pack.artifact_storage_object_path == pack.immutable_snapshot_object_path
    assert "/.builder/" not in pack.artifact_storage_object_path
    assert "/versions/" in pack.artifact_storage_object_path
    assert pack.creative_plan["subject"] == "PSI motivation architecture"
    assert pack.blind_brief.request == "Build a concise PSI deck."
    assert b"private memory" not in source_pack_bytes
    assert pack.source_hashes.creative_plan == publisher.canonical_sha256(pack.creative_plan)

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_bundle_invalid",
    ):
        publisher.decode_deck_quality_producer_bundle(first_encoded + b"trailing")


def test_producer_storage_paths_are_strict_flat_and_content_bound() -> None:
    quality_run_id = f"quality_{'a' * 64}"
    inbox_path = publisher.deck_quality_producer_bundle_path(quality_run_id)
    archive_path = publisher.deck_quality_producer_archive_path(quality_run_id)

    assert inbox_path == f"dq1/producer-inbox/v1/{quality_run_id}.bin"
    assert archive_path == (f"dq1/producer-archive/v1/{quality_run_id}/bundle.bin")
    assert publisher.parse_deck_quality_producer_bundle_path(inbox_path) == quality_run_id
    assert publisher.parse_deck_quality_producer_archive_path(archive_path) == quality_run_id
    assert publisher.parse_deck_quality_producer_bundle_path(f"dq1/producer-inbox/v1/{quality_run_id}/bundle.bin") is None
    assert publisher.parse_deck_quality_producer_archive_path(inbox_path) is None

    first = publisher.deck_quality_producer_quarantine_path(
        inbox_path,
        reason="bundle_invalid",
        content_sha256="1" * 64,
    )
    second = publisher.deck_quality_producer_quarantine_path(
        inbox_path,
        reason="bundle_invalid",
        content_sha256="2" * 64,
    )
    assert first != second
    assert first.endswith(f"/{'1' * 64}.bin")
    assert second.endswith(f"/{'2' * 64}.bin")


def test_long_current_request_keeps_full_request_and_bounds_structured_projection(
    tmp_path,
) -> None:
    _prepare_files(tmp_path)
    current_request = "AUTHENTIC_CURRENT_REQUEST_" + "x" * 2_500
    completion = _payload()
    completion["task_brief"] = current_request
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=completion,
    )
    assert prepared is not None

    pack, _encoded = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=_instrument(),
    )

    assert pack.blind_brief.request == current_request
    assert pack.blind_brief.subject == current_request[:2_000]
    assert pack.blind_brief.audience == current_request[:2_000]
    assert pack.blind_brief.goal == current_request[:2_000]
    assert pack.blind_brief.explicit_brand_style_constraints == ()


def test_plan_only_tokens_cannot_influence_blind_request_pipeline(
    tmp_path,
    monkeypatch,
) -> None:
    """Plans may change Assessment C, never any token-bearing Assessment A input."""

    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    current_request = "Build a concise PSI deck for the current product review using the user-requested cobalt accent."
    completion = _payload()
    completion["task_brief"] = current_request
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=completion,
    )
    assert prepared is not None

    baseline_pack, _baseline_encoded = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=_instrument(),
    )
    sentinel = "PLAN_ONLY_SENTINEL_7F3A9C"
    deck_build = tmp_path / "outputs" / "deck_build"
    (deck_build / "creative_plan.json").write_text(
        json.dumps(
            {
                "subject": f"{sentinel}_SUBJECT",
                "audience": f"{sentinel}_AUDIENCE",
                "goal": f"{sentinel}_GOAL",
                "viewing_context": f"{sentinel}_VIEWING_CONTEXT",
                "explicit_brand_style_constraints": [
                    f"{sentinel}_CREATIVE_BRAND",
                ],
                "requested_style_terms": [f"{sentinel}_CREATIVE_STYLE"],
                "design_plan": {
                    "subject": f"{sentinel}_EMBEDDED_SUBJECT",
                    "audience": f"{sentinel}_EMBEDDED_AUDIENCE",
                    "goal": f"{sentinel}_EMBEDDED_GOAL",
                    "requested_style_terms": [f"{sentinel}_EMBEDDED_STYLE"],
                },
            }
        ),
        encoding="utf-8",
    )
    (deck_build / "design_plan.json").write_text(
        json.dumps(
            {
                "subject": f"{sentinel}_DESIGN_SUBJECT",
                "audience": f"{sentinel}_DESIGN_AUDIENCE",
                "goal": f"{sentinel}_DESIGN_GOAL",
                "viewing_context": f"{sentinel}_DESIGN_VIEWING_CONTEXT",
                "requested_style_terms": [f"{sentinel}_DESIGN_STYLE"],
            }
        ),
        encoding="utf-8",
    )
    sentinel_pack, _sentinel_encoded = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=_instrument(),
    )

    assert baseline_pack.creative_plan != sentinel_pack.creative_plan
    assert baseline_pack.design_plan != sentinel_pack.design_plan
    assert baseline_pack.blind_brief == sentinel_pack.blind_brief
    assert baseline_pack.source_hashes.blind_brief == sentinel_pack.source_hashes.blind_brief
    assert baseline_pack.blind_brief.model_dump(mode="json") == {
        "request": current_request,
        "subject": current_request,
        "audience": current_request,
        "goal": current_request,
        "viewing_context": "presentation",
        "explicit_brand_style_constraints": [],
    }
    assert sentinel not in baseline_pack.blind_brief.model_dump_json()

    contact_sheet = tmp_path / "contact-sheet.png"
    slide = tmp_path / "slide-1.png"
    contact_sheet.write_bytes(b"bounded contact sheet")
    slide.write_bytes(b"bounded slide")
    image_hash = "1" * 64
    renders = RenderEvidence(
        expected_slide_count=1,
        contact_sheet=ImageEvidence(
            selector="contact-sheet",
            path=contact_sheet.as_posix(),
            sha256=image_hash,
            width=320,
            height=180,
        ),
        slides=(
            ImageEvidence(
                selector="slide:1",
                path=slide.as_posix(),
                sha256=image_hash,
                width=320,
                height=180,
            ),
        ),
        selectors=("slide:1",),
    )
    rubric = RubricProjection(
        rubric_version="deck-rubric-v2",
        rubric_hash="2" * 64,
        assessment="blind_visual",
        criteria=(
            RubricCriterionProjection(
                id="subject_specificity",
                assessment="blind_visual",
                critical=True,
                weight=1,
                score_anchors={1: "generic", 3: "specific", 5: "inseparable"},
                allowed_failure_codes=("weak_subject_specificity",),
            ),
        ),
    )

    def blind_snapshot(pack: publisher.DeckQualitySourcePack) -> QualityEvidenceSnapshot:
        return QualityEvidenceSnapshot(
            campaign_id=pack.campaign_id,
            build_id=pack.build_id,
            user_id=pack.user_id,
            task_id=pack.task_id,
            builder_run_id=pack.builder_run_id,
            parent_builder_trace_id=pack.parent_builder_trace_id,
            logical_artifact_id=pack.logical_artifact_id,
            artifact_version_id=pack.artifact_version_id,
            manifest_revision=pack.manifest_revision,
            artifact_path=pack.artifact_virtual_path,
            artifact_hash=pack.artifact_sha256,
            brief_hash=pack.source_hashes.blind_brief,
            creative_plan_hash=pack.source_hashes.creative_plan,
            design_plan_hash=pack.source_hashes.design_plan,
            brief=pack.blind_brief,
            renders=renders,
            visible_text=(
                VisibleTextSlide(
                    selector="slide:1",
                    text="Authentic rendered slide text.",
                    source_hash="3" * 64,
                ),
            ),
            creative_plan=pack.creative_plan,
            design_plan=pack.design_plan,
            mechanical_record=pack.mechanical_record,
            mechanical_record_hash=pack.source_hashes.mechanical_record,
        )

    baseline_evidence = prepare_blind_visual_evidence(
        blind_snapshot(baseline_pack),
        rubric,
    )
    sentinel_evidence = prepare_blind_visual_evidence(
        blind_snapshot(sentinel_pack),
        rubric,
    )
    assert baseline_evidence == sentinel_evidence
    assert sentinel not in baseline_evidence.model_dump_json()

    prompt = VersionedPrompt(
        name="blind_visual_assessment",
        version="v4",
        sha256="4" * 64,
        content="Judge only the allowed blind evidence.",
    )
    baseline_messages = build_blind_visual_messages(baseline_evidence, prompt)
    sentinel_messages = build_blind_visual_messages(sentinel_evidence, prompt)
    assert baseline_messages == sentinel_messages
    serialized_messages = json.dumps(
        [message.model_dump(mode="json") for message in baseline_messages],
        sort_keys=True,
    )
    assert sentinel not in serialized_messages
    assert current_request in serialized_messages

    def create_internal_route_chat_model(**kwargs) -> ChatOpenAI:
        kwargs.pop("plan")
        kwargs.pop("capability")
        kwargs.pop("attach_tracing")
        kwargs.pop("api_key")
        return ChatOpenAI(
            model="gpt-5.6-sol",
            api_key="synthetic-not-used",
            **kwargs,
        )

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )
    monkeypatch.setattr(invoker_module, "get_app_config", _config)
    monkeypatch.setenv(
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "synthetic-dq-only-not-used",
    )
    invoker = MultimodalStructuredModelInvoker()
    baseline_request = invoker.prepare_request(
        plan=_judge_plan(),
        schema=BlindVisualAssessment,
        messages=baseline_messages,
        campaign_id="DQ-1",
        canary_user_id=prepared.user_id,
    )
    sentinel_request = invoker.prepare_request(
        plan=_judge_plan(),
        schema=BlindVisualAssessment,
        messages=sentinel_messages,
        campaign_id="DQ-1",
        canary_user_id=prepared.user_id,
    )
    baseline_payload = json.loads(baseline_request.provider_payload_json)
    sentinel_payload = json.loads(sentinel_request.provider_payload_json)
    assert baseline_payload["input"] == sentinel_payload["input"]
    assert baseline_request.payload_hash == sentinel_request.payload_hash
    assert sentinel not in baseline_request.provider_payload_json.decode("utf-8")
    assert current_request in baseline_request.provider_payload_json.decode("utf-8")


def test_source_pack_capture_rejects_symlinked_native_input(tmp_path) -> None:
    _prepare_files(tmp_path)
    outside = tmp_path / "outside.json"
    outside.write_text(
        json.dumps(
            {
                "subject": "outside",
                "audience": "outside",
                "goal": "outside",
            }
        ),
        encoding="utf-8",
    )
    creative = tmp_path / "outputs" / "deck_build" / "creative_plan.json"
    creative.unlink()
    creative.symlink_to(outside)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(),
    )
    assert prepared is not None

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="creative_plan_unavailable",
    ):
        publisher.capture_deck_quality_source_pack(
            prepared=prepared,
            instrument=_instrument(),
        )


def test_source_pack_capture_rejects_oversized_native_input(tmp_path) -> None:
    _prepare_files(tmp_path)
    (tmp_path / "outputs" / "deck_build" / "build.json").write_bytes(b"{" + b" " * (2 * 1024 * 1024) + b"}")
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(),
    )
    assert prepared is not None

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="build_record_unavailable",
    ):
        publisher.capture_deck_quality_source_pack(
            prepared=prepared,
            instrument=_instrument(),
        )


def test_producer_persists_source_then_small_outbox_without_artifact_copy(
    tmp_path,
) -> None:
    remote_artifact = b"exact accepted Supabase PPTX bytes"
    local_artifact = b"divergent ephemeral local PPTX bytes"
    _prepare_files(tmp_path, local_artifact)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(remote_artifact),
        completion_payload=_payload(),
    )
    assert prepared is not None
    objects = _MemoryObjects(
        prepared.artifact_storage_object_path,
        remote_artifact,
    )

    receipt = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=_instrument(),
        object_store=objects,
    )

    bundle = objects.objects[receipt.bundle_object_path]
    decoded = publisher.decode_deck_quality_producer_bundle(
        bundle,
        expected_quality_run_id=receipt.quality_run_id,
        expected_object_path=receipt.bundle_object_path,
    )
    source_path = decoded.manifest.source_pack_object_path
    source_pack = publisher.DeckQualitySourcePack.model_validate_json(
        objects.objects[source_path]
    )
    assert decoded.manifest.artifact_object_path == prepared.artifact_storage_object_path
    assert source_pack.accepted_delivery_object_path == prepared.artifact_storage_object_path
    assert source_pack.immutable_snapshot_object_path == publisher._immutable_artifact_object_path(prepared)
    assert objects.creates == [source_path, receipt.bundle_object_path]
    assert all(path != prepared.artifact_storage_object_path for path, _bound in objects.reads)
    assert objects.objects[prepared.artifact_storage_object_path] == remote_artifact
    assert remote_artifact not in bundle
    assert local_artifact not in bundle
    assert remote_artifact not in objects.objects[source_path]
    assert local_artifact not in objects.objects[source_path]
    assert receipt.bundle_size_bytes <= 64 * 1024


def test_create_response_loss_reconciles_exact_committed_bundle(tmp_path) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None

    class _CreateResponseLostObjects(_MemoryObjects):
        response_lost = False

        def create_if_absent(
            self,
            object_path: str,
            content: bytes,
            *,
            content_type: str,
        ) -> str:
            outcome = super().create_if_absent(
                object_path,
                content,
                content_type=content_type,
            )
            if object_path.startswith(publisher.DECK_QUALITY_PRODUCER_PREFIX):
                self.response_lost = True
                raise RuntimeError("synthetic response loss")
            return outcome

    objects = _CreateResponseLostObjects(
        prepared.artifact_storage_object_path,
        artifact_bytes,
    )

    receipt = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=_instrument(),
        object_store=objects,
    )

    assert objects.response_lost is True
    assert receipt.bundle_object_path in objects.objects
    decoded = publisher.decode_deck_quality_producer_bundle(
        objects.objects[receipt.bundle_object_path],
        expected_quality_run_id=receipt.quality_run_id,
    )
    assert decoded.descriptor.sha256 == receipt.bundle_hash


def test_source_create_response_loss_reconciles_before_outbox_commit(tmp_path) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None

    class _SourceResponseLostObjects(_MemoryObjects):
        response_lost = False

        def create_if_absent(
            self,
            object_path: str,
            content: bytes,
            *,
            content_type: str,
        ) -> str:
            outcome = super().create_if_absent(
                object_path,
                content,
                content_type=content_type,
            )
            if "/source_pack/" in object_path and not self.response_lost:
                self.response_lost = True
                raise RuntimeError("synthetic source response loss")
            return outcome

    objects = _SourceResponseLostObjects(
        prepared.artifact_storage_object_path,
        artifact_bytes,
    )
    receipt = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=_instrument(),
        object_store=objects,
    )
    manifest = publisher.decode_deck_quality_producer_bundle(
        objects.objects[receipt.bundle_object_path]
    ).manifest

    assert objects.response_lost is True
    assert objects.creates == [
        manifest.source_pack_object_path,
        receipt.bundle_object_path,
    ]
    assert (
        manifest.source_pack_object_path,
        publisher._MAX_SOURCE_PACK_BYTES,
    ) in objects.reads


def test_source_conflict_prevents_outbox_commit(tmp_path) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    instrument = _instrument()
    pack, _source_bytes = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=instrument,
    )
    source_path = publisher.deck_quality_source_pack_path(
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        build_id=pack.build_id,
        quality_run_id=pack.quality_run_id,
    )
    objects = _MemoryObjects(prepared.artifact_storage_object_path, artifact_bytes)
    objects.objects[source_path] = b'{"conflict":true}'

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_source_persistence_conflict",
    ):
        publisher.persist_deck_quality_producer_bundle(
            prepared=prepared,
            instrument=instrument,
            object_store=objects,
        )

    assert objects.creates == [source_path]
    assert publisher.deck_quality_producer_bundle_path(pack.quality_run_id) not in objects.objects


def test_bundle_decoder_and_replay_reject_tamper_or_identity_conflict(
    tmp_path,
) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    instrument = _instrument()
    objects = _MemoryObjects(prepared.artifact_storage_object_path, artifact_bytes)
    receipt = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=instrument,
        object_store=objects,
    )
    encoded = objects.objects[receipt.bundle_object_path]

    source_tamper = encoded + b" "
    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_bundle_noncanonical",
    ):
        publisher.decode_deck_quality_producer_bundle(source_tamper)

    artifact_tamper_payload = json.loads(encoded)
    artifact_tamper_payload["artifact_sha256"] = "0" * 64
    artifact_tamper = json.dumps(
        artifact_tamper_payload,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_bundle_invalid",
    ):
        publisher.decode_deck_quality_producer_bundle(artifact_tamper)

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_bundle_invalid",
    ):
        publisher.decode_deck_quality_producer_bundle(b"{")

    conflicting_prepared = prepared.model_copy(update={"task_id": "different-builder-thread"})
    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_bundle_conflict",
    ):
        publisher.persist_deck_quality_producer_bundle(
            prepared=conflicting_prepared,
            instrument=instrument,
            object_store=objects,
        )

    objects.objects[receipt.bundle_object_path] = artifact_tamper
    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_bundle_conflict",
    ):
        publisher.persist_deck_quality_producer_bundle(
            prepared=prepared,
            instrument=instrument,
            object_store=objects,
        )


def test_bundle_replay_after_local_cleanup_skips_sources_and_accepted_object(
    tmp_path,
    monkeypatch,
) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    instrument = _instrument()
    objects = _MemoryObjects(prepared.artifact_storage_object_path, artifact_bytes)
    first = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=instrument,
        object_store=objects,
    )
    creates_after_first = tuple(objects.creates)

    for path in (tmp_path / "outputs").rglob("*"):
        if path.is_file() or path.is_symlink():
            path.unlink()
    objects.objects.pop(prepared.artifact_storage_object_path)
    reads_before_replay = len(objects.reads)
    monkeypatch.setattr(
        publisher,
        "_captured_native_inputs",
        lambda _prepared: pytest.fail("bundle replay cannot read local sources"),
    )

    replay = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=instrument,
        object_store=objects,
    )

    assert replay == first
    assert tuple(objects.creates) == creates_after_first
    assert objects.reads[reads_before_replay:] == [
        (
            publisher.deck_quality_producer_archive_path(first.quality_run_id),
            publisher._MAX_PRODUCER_BUNDLE_BYTES,
        ),
        (first.bundle_object_path, publisher._MAX_PRODUCER_BUNDLE_BYTES),
    ]


def test_bundle_replay_prefers_archive_after_inbox_retirement(
    tmp_path,
    monkeypatch,
) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    instrument = _instrument()
    objects = _MemoryObjects(prepared.artifact_storage_object_path, artifact_bytes)
    first = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=instrument,
        object_store=objects,
    )
    archive_path = publisher.deck_quality_producer_archive_path(first.quality_run_id)
    objects.objects[archive_path] = objects.objects.pop(first.bundle_object_path)
    creates_after_first = tuple(objects.creates)

    for path in (tmp_path / "outputs").rglob("*"):
        if path.is_file() or path.is_symlink():
            path.unlink()
    objects.objects.pop(prepared.artifact_storage_object_path)
    reads_before_replay = len(objects.reads)
    monkeypatch.setattr(
        publisher,
        "_captured_native_inputs",
        lambda _prepared: pytest.fail("archive replay cannot read local sources"),
    )

    replay = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=instrument,
        object_store=objects,
    )

    assert replay.quality_run_id == first.quality_run_id
    assert replay.bundle_hash == first.bundle_hash
    assert replay.bundle_size_bytes == first.bundle_size_bytes
    assert replay.bundle_object_path == archive_path
    assert tuple(objects.creates) == creates_after_first
    assert objects.reads[reads_before_replay:] == [(archive_path, publisher._MAX_PRODUCER_BUNDLE_BYTES)]


def test_bound_source_pack_replay_rejects_changed_current_source(
    tmp_path,
) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    instrument = _instrument()
    objects = _MemoryObjects(prepared.artifact_storage_object_path, artifact_bytes)
    first_pack, first_source_bytes = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=instrument,
    )
    first = publisher.persist_deck_quality_producer_bundle(
        prepared=prepared,
        instrument=instrument,
        object_store=objects,
        source_pack=first_pack,
        source_pack_bytes=first_source_bytes,
    )

    build_path = tmp_path / "outputs" / "deck_build" / "build.json"
    changed_build = json.loads(build_path.read_bytes())
    changed_build["retained_provenance"] = "changed-after-publication"
    build_path.write_text(json.dumps(changed_build), encoding="utf-8")
    current_pack, current_source_bytes = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=instrument,
    )
    assert current_pack.artifact_sha256 == first_pack.artifact_sha256
    assert current_source_bytes != first_source_bytes

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_source_persistence_conflict",
    ):
        publisher.persist_deck_quality_producer_bundle(
            prepared=prepared,
            instrument=instrument,
            object_store=objects,
            source_pack=current_pack,
            source_pack_bytes=current_source_bytes,
        )

    decoded = publisher.decode_deck_quality_producer_bundle(
        objects.objects[first.bundle_object_path],
        expected_quality_run_id=first.quality_run_id,
    )
    assert decoded.manifest.source_pack_sha256 == hashlib.sha256(
        first_source_bytes
    ).hexdigest()
    assert objects.objects[decoded.manifest.source_pack_object_path] == first_source_bytes


def test_failure_marker_is_deterministic_content_free_and_create_only() -> None:
    artifact = _artifact()
    payload = _payload()
    payload["task_brief"] = "PRIVATE BRIEF SENTINEL"
    artifact["artifact_url"] = "https://private.example/signed-secret"
    candidate_digest = publisher.derive_deck_quality_candidate_digest(
        artifact=artifact,
        completion_payload=payload,
    )
    objects = _MemoryObjects("unused", b"unused")

    first = publisher.persist_deck_quality_producer_failure(
        candidate_digest=candidate_digest,
        failure_stage="candidate_metadata",
        failure_code="candidate_metadata_invalid",
        object_store=objects,
    )
    encoded = objects.objects[first.object_path]
    replay = publisher.persist_deck_quality_producer_failure(
        candidate_digest=candidate_digest,
        failure_stage="candidate_metadata",
        failure_code="candidate_metadata_invalid",
        object_store=objects,
    )

    assert replay == first
    assert objects.creates == [first.object_path]
    assert first.object_path == (
        f"{publisher.DECK_QUALITY_PRODUCER_FAILURE_PREFIX}/{candidate_digest}.json"
    )
    assert publisher.parse_deck_quality_producer_failure_path(first.object_path) == candidate_digest
    assert (
        publisher.parse_deck_quality_producer_failure_path(
            f"{publisher.DECK_QUALITY_PRODUCER_FAILURE_PREFIX}/{candidate_digest}/manifest.json"
        )
        is None
    )
    assert hashlib.sha256(encoded).hexdigest() == first.sha256
    assert json.loads(encoded) == {
        "campaign_id": "DQ-1",
        "candidate_digest": candidate_digest,
        "failure_code": "candidate_metadata_invalid",
        "failure_stage": "candidate_metadata",
        "schema_version": "deck-quality-producer-failure/v1",
        "shadow_error_code": "shadow_dispatch_unavailable",
    }
    assert b"PRIVATE BRIEF SENTINEL" not in encoded
    assert b"private.example" not in encoded
    assert b"occurred_at" not in encoded
    assert b"error_type" not in encoded


def test_owned_producer_protocol_has_one_cancellable_absolute_deadline(
    tmp_path,
    monkeypatch,
) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None

    class _DribblingAsyncStore:
        closed = False

        async def read_bounded(self, *_args, **_kwargs):
            while True:
                await asyncio.sleep(0.001)

        async def aclose(self) -> None:
            self.closed = True

    store = _DribblingAsyncStore()
    monkeypatch.setattr(
        publisher,
        "AsyncSupabaseImmutableObjectStore",
        lambda: store,
    )
    monkeypatch.setattr(
        publisher,
        "_PRODUCER_PROTOCOL_TIMEOUT_SECONDS",
        0.025,
    )
    monkeypatch.setattr(
        publisher,
        "_PRODUCER_AMBIGUITY_RESERVE_SECONDS",
        0.01,
    )
    started = time.monotonic()

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_bundle_deadline_exceeded",
    ):
        publisher.persist_deck_quality_producer_bundle(
            prepared=prepared,
            instrument=_instrument(),
        )

    assert time.monotonic() - started < 0.2
    assert store.closed is True


def test_blocked_local_source_capture_returns_at_deadline_and_cannot_write_late(
    tmp_path,
    monkeypatch,
) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    capture_started = threading.Event()
    release_capture = threading.Event()

    class _AsyncStore:
        closed = False
        creates: list[str] = []

        async def read_bounded(self, *_args, **_kwargs):
            return None

        async def create_if_absent(
            self,
            object_path: str,
            *_args,
            **_kwargs,
        ) -> str:
            self.creates.append(object_path)
            return "created"

        async def aclose(self) -> None:
            self.closed = True

    store = _AsyncStore()

    def blocked_capture(**_kwargs):
        capture_started.set()
        release_capture.wait(timeout=1.0)
        raise RuntimeError("late read result must be discarded")

    monkeypatch.setattr(
        publisher,
        "AsyncSupabaseImmutableObjectStore",
        lambda: store,
    )
    monkeypatch.setattr(
        publisher,
        "capture_deck_quality_source_pack",
        blocked_capture,
    )
    monkeypatch.setattr(
        publisher,
        "_PRODUCER_PROTOCOL_TIMEOUT_SECONDS",
        0.05,
    )
    monkeypatch.setattr(
        publisher,
        "_PRODUCER_AMBIGUITY_RESERVE_SECONDS",
        0.015,
    )
    started = time.monotonic()

    try:
        with pytest.raises(
            publisher.DeckQualityPublicationError,
            match="producer_bundle_deadline_exceeded",
        ):
            publisher.persist_deck_quality_producer_bundle(
                prepared=prepared,
                instrument=_instrument(),
            )
        elapsed = time.monotonic() - started
        assert capture_started.wait(timeout=0.05)
        assert elapsed < 0.2
        assert store.closed is True
        assert store.creates == []
    finally:
        release_capture.set()
    time.sleep(0.02)
    assert store.creates == []


def test_owned_failure_marker_has_reserved_absolute_deadline(tmp_path, monkeypatch) -> None:
    artifact_bytes = b"accepted pptx bytes"
    _prepare_files(tmp_path, artifact_bytes)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(artifact_bytes),
        completion_payload=_payload(),
    )
    assert prepared is not None
    instrument = _instrument()
    intent = publisher.build_deck_quality_producer_intent(
        prepared=prepared,
        instrument=instrument,
    )
    class _DribblingAsyncStore:
        closed = False

        async def exists(self, *_args, **_kwargs):
            while True:
                await asyncio.sleep(0.001)

        async def read_bounded(self, *_args, **_kwargs):
            while True:
                await asyncio.sleep(0.001)

        async def aclose(self) -> None:
            self.closed = True

    store = _DribblingAsyncStore()
    monkeypatch.setattr(
        publisher,
        "AsyncSupabaseImmutableObjectStore",
        lambda: store,
    )
    monkeypatch.setattr(
        publisher,
        "_FAILURE_PROTOCOL_TIMEOUT_SECONDS",
        0.025,
    )
    started = time.monotonic()

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="producer_failure_deadline_exceeded",
    ):
        publisher.persist_deck_quality_producer_failure(
            candidate_digest="a" * 64,
            failure_stage="producer_bundle",
            failure_code="producer_bundle_unavailable",
            quality_run_id=intent.quality_run_id,
            prepared=prepared,
            instrument=instrument,
        )

    assert time.monotonic() - started < 0.2
    assert store.closed is True


def test_candidate_digest_excludes_task_brief_urls_and_content() -> None:
    baseline_artifact = _artifact()
    baseline_payload = _payload()
    baseline_payload["task_brief"] = "PRIVATE TASK CONTENT ALPHA"
    baseline_payload["artifact_url"] = "https://private.example/alpha"
    baseline_artifact["artifact_url"] = "https://private.example/artifact-alpha"
    baseline_artifact["creative_plan"] = {"private": "alpha"}
    baseline = publisher.derive_deck_quality_candidate_digest(
        artifact=baseline_artifact,
        completion_payload=baseline_payload,
    )

    changed_artifact = dict(baseline_artifact)
    changed_artifact["artifact_url"] = "https://private.example/artifact-beta"
    changed_artifact["creative_plan"] = {"private": "beta"}
    changed_payload = dict(baseline_payload)
    changed_payload["task_brief"] = "PRIVATE TASK CONTENT BETA"
    changed_payload["artifact_url"] = "https://private.example/beta"
    changed = publisher.derive_deck_quality_candidate_digest(
        artifact=changed_artifact,
        completion_payload=changed_payload,
    )

    changed_identity_payload = dict(changed_payload)
    changed_identity_payload["task_id"] = "different-builder-thread"
    changed_identity = publisher.derive_deck_quality_candidate_digest(
        artifact=changed_artifact,
        completion_payload=changed_identity_payload,
    )

    assert changed == baseline
    assert changed_identity != baseline
    assert baseline.isascii()
    assert len(baseline) == 64
    assert "PRIVATE" not in baseline
