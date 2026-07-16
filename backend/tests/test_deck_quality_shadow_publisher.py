from __future__ import annotations

import hashlib
import json
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
from deerflow.sophia.deck_quality.publication_persistence import PublicationState
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
        "storage_object_path": ("artifacts/canary-user/companion-thread/artifact-canary-1/deck.pptx"),
        "artifact_sha256": hashlib.sha256(artifact_bytes).hexdigest(),
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

    def read(self, object_path: str) -> bytes | None:
        return self.objects.get(object_path)

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        del content_type
        if object_path in self.objects:
            return "exists"
        self.objects[object_path] = content
        return "created"


def _publication_record(request, *, state=PublicationState.AWAITING_INPUTS):
    return SimpleNamespace(
        quality_run_id=request.quality_run_id,
        campaign_id=request.campaign_id,
        instrument_identity_hash=request.instrument_identity_hash,
        instrument_lock=lambda: request.instrument,
        user_id=request.user_id,
        thread_id=request.thread_id,
        task_id=request.task_id,
        build_id=request.build_id,
        builder_run_id=request.builder_run_id,
        parent_builder_trace_id=request.parent_builder_trace_id,
        logical_artifact_id=request.logical_artifact_id,
        artifact_version_id=request.artifact_version_id,
        manifest_revision=request.manifest_revision,
        artifact_object_path=request.artifact_object_path,
        artifact_hash=request.artifact_hash,
        max_attempts=request.max_attempts,
        deadline_at=request.deadline_at,
        quality_max_attempts=request.quality_max_attempts,
        quality_run_deadline_at=request.quality_run_deadline_at,
        source_pack_object_path=None,
        source_pack_hash=None,
        state=state,
    )


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


def test_source_pack_captures_once_and_uploads_create_only(tmp_path) -> None:
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

    pack, encoded = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=_instrument(),
    )
    (tmp_path / "outputs" / "deck_build" / "creative_plan.json").write_text(
        json.dumps({"subject": "mutated after capture"}),
        encoding="utf-8",
    )
    objects = _MemoryObjects(
        prepared.artifact_storage_object_path,
        artifact_bytes,
    )
    descriptor = publisher.upload_deck_quality_source_pack(
        pack=pack,
        encoded=encoded,
        object_store=objects,
    )
    replay = publisher.upload_deck_quality_source_pack(
        pack=pack,
        encoded=encoded,
        object_store=objects,
    )

    assert descriptor == replay
    assert descriptor.object_path.endswith(f"/quality/{pack.quality_run_id}/publication/source_pack/{descriptor.sha256}.json")
    assert objects.objects[descriptor.object_path] == encoded
    assert pack.creative_plan["subject"] == "PSI motivation architecture"
    assert pack.blind_brief.request == "Build a concise PSI deck."
    assert b"private memory" not in encoded
    assert pack.source_hashes.creative_plan == publisher.canonical_sha256(pack.creative_plan)


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
    current_request = (
        "Build a concise PSI deck for the current product review using the "
        "user-requested cobalt accent."
    )
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

    def create_chat_model(_name: str, **kwargs) -> ChatOpenAI:
        kwargs.pop("attach_tracing")
        return ChatOpenAI(
            model="gpt-5.6-sol",
            api_key="synthetic-not-used",
            **kwargs,
        )

    monkeypatch.setattr(invoker_module, "create_chat_model", create_chat_model)
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


def test_source_pack_upload_rejects_existing_conflict(tmp_path) -> None:
    _prepare_files(tmp_path)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(),
    )
    assert prepared is not None
    pack, encoded = publisher.capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=_instrument(),
    )
    objects = _MemoryObjects(
        prepared.artifact_storage_object_path,
        b"accepted pptx bytes",
    )
    descriptor = publisher.upload_deck_quality_source_pack(
        pack=pack,
        encoded=encoded,
        object_store=objects,
    )
    objects.objects[descriptor.object_path] = b"conflict"

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="source_pack_persistence_conflict",
    ):
        publisher.upload_deck_quality_source_pack(
            pack=pack,
            encoded=encoded,
            object_store=objects,
        )


def test_after_ack_captures_once_and_commits_exact_source_pack(
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
    intent = publisher.build_deck_quality_publication_intent(
        prepared=prepared,
        instrument=instrument,
    )
    request = publisher._publication_request_from_intent(
        intent,
        instrument=instrument,
    )
    record = _publication_record(request)
    objects = _MemoryObjects(prepared.artifact_storage_object_path, artifact_bytes)
    captures = 0
    real_capture = publisher._captured_native_inputs

    def counted_capture(value):
        nonlocal captures
        captures += 1
        return real_capture(value)

    class _PublicationStore:
        def __init__(self) -> None:
            self.commits = []
            self.closed = False

        async def get(self, quality_run_id):
            assert quality_run_id == intent.quality_run_id
            return record

        async def commit_inputs(
            self,
            current,
            *,
            source_pack_object_path,
            source_pack_hash,
        ):
            assert current is record
            self.commits.append((source_pack_object_path, source_pack_hash))
            committed = _publication_record(
                request,
                state=PublicationState.PENDING,
            )
            committed.source_pack_object_path = source_pack_object_path
            committed.source_pack_hash = source_pack_hash
            return committed

        async def aclose(self):
            self.closed = True

    store = _PublicationStore()
    monkeypatch.setattr(publisher, "_captured_native_inputs", counted_capture)
    monkeypatch.setattr(publisher, "SupabaseImmutableObjectStore", lambda: objects)
    monkeypatch.setattr(
        publisher,
        "configured_deck_quality_publication_store",
        lambda: store,
    )

    committed = publisher.complete_deck_quality_publication_after_ack(
        prepared=prepared,
        intent=intent,
        instrument=instrument,
    )

    assert captures == 1
    assert len(store.commits) == 1
    assert committed.source_pack_object_path == store.commits[0][0]
    assert committed.source_pack_hash == store.commits[0][1]
    assert objects.objects[committed.source_pack_object_path]
    assert store.closed is True


def test_after_ack_identity_mismatch_reads_no_source_files(
    tmp_path,
    monkeypatch,
) -> None:
    _prepare_files(tmp_path)
    prepared = publisher.prepare_deck_quality_publication(
        config=_config(),
        state=_state(tmp_path),
        artifact=_artifact(),
        completion_payload=_payload(),
    )
    assert prepared is not None
    instrument = _instrument()
    intent = publisher.build_deck_quality_publication_intent(
        prepared=prepared,
        instrument=instrument,
    ).model_copy(update={"artifact_sha256": "0" * 64})
    monkeypatch.setattr(
        publisher,
        "_captured_native_inputs",
        lambda _prepared: pytest.fail("identity mismatch cannot read source files"),
    )

    with pytest.raises(
        publisher.DeckQualityPublicationError,
        match="publication_identity_mismatch",
    ):
        publisher.complete_deck_quality_publication_after_ack(
            prepared=prepared,
            intent=intent,
            instrument=instrument,
        )
