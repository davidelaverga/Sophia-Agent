from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from deerflow.sophia.deck_quality.brief import forbidden_brief_marker, sanitize_current_request
from deerflow.sophia.deck_quality.canonical import file_sha256
from deerflow.sophia.deck_quality.evidence import (
    assert_blind_context_is_clean,
    brief_scoped_criteria,
    prepare_blind_visual_evidence,
    prepare_plan_realization_evidence,
    prove_coverage,
)
from deerflow.sophia.deck_quality.fixture_runner import (
    FixtureRecord,
    fixture_paths,
    load_corpus,
    load_fixture_inputs,
    load_fixture_label,
    validate_campaign_corpus,
)
from deerflow.sophia.deck_quality.mechanical import project_mechanical_truth
from deerflow.sophia.deck_quality.schemas import (
    BlindBrief,
    BlindVisualAssessment,
    CriterionScore,
    EvidenceFinding,
    ImageEvidence,
    MechanicalProjection,
    PlanCommitment,
    QualityEvidenceSnapshot,
    RenderEvidence,
    RubricCriterionProjection,
    RubricProjection,
    VisibleTextSlide,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_ROOT = REPO_ROOT / "backend/tests/fixtures/deck_quality_shadow"
CORPUS_PATH = CORPUS_ROOT / "corpus.yaml"
EVIDENCE_V4_CORPUS_PATH = CORPUS_ROOT / "corpus_evidence_v4.yaml"
HASH = "a" * 64
RUBRIC_HASH = "b" * 64


def _image(selector: str, *, path: str | None = None, decodes: bool = True) -> ImageEvidence:
    return ImageEvidence(
        selector=selector,  # type: ignore[arg-type]
        path=path or f"/evidence/{selector.replace(':', '-')}.png",
        sha256=HASH,
        width=1600,
        height=900,
        decodes=decodes,
    )


def _renders(count: int = 2) -> RenderEvidence:
    selectors = tuple(f"slide:{index}" for index in range(1, count + 1))
    return RenderEvidence(
        expected_slide_count=count,
        contact_sheet=_image("contact-sheet", path="/evidence/contact-sheet.png"),
        slides=tuple(_image(selector) for selector in selectors),
        selectors=selectors,
    )


def _rubric(assessment: str) -> RubricProjection:
    return RubricProjection(
        rubric_version="deck-rubric-v1",
        rubric_hash=RUBRIC_HASH,
        assessment=assessment,  # type: ignore[arg-type]
        criteria=(
            RubricCriterionProjection(
                id="subject_specificity",
                assessment=assessment,  # type: ignore[arg-type]
                critical=True,
                weight=1,
                score_anchors={1: "generic", 3: "specific", 5: "exceptional"},
                allowed_failure_codes=("weak_subject_specificity",),
            ),
        ),
    )


def _snapshot(*, mechanical_record: dict[str, object] | None = None) -> QualityEvidenceSnapshot:
    renders = _renders()
    return QualityEvidenceSnapshot(
        campaign_id="DQ-1",
        build_id="build-1",
        user_id="synthetic-canary",
        logical_artifact_id="artifact-1",
        artifact_version_id="artifact-version-1",
        artifact_path="/artifact/deck.pptx",
        artifact_hash=HASH,
        brief_hash=HASH,
        creative_plan_hash=HASH,
        design_plan_hash=HASH,
        brief=BlindBrief(
            request="Explain the feedback loop",
            subject="Agent motivation",
            audience="AI engineers",
            goal="Explain the mechanism",
        ),
        renders=renders,
        visible_text=tuple(VisibleTextSlide(selector=selector, text=f"Text for {selector}", source_hash=HASH) for selector in renders.selectors),
        creative_plan={"subject_materials": ["feedback loop"]},
        design_plan={"signature": "control loop", "rhythm": "setup-mechanism-close"},
        mechanical_record=mechanical_record or {},
        mechanical_record_hash=HASH,
    )


def _visual(*, selectors: tuple[str, ...], coverage_confirmed: bool) -> BlindVisualAssessment:
    return BlindVisualAssessment(
        coverage_confirmed=coverage_confirmed,
        evaluated_selectors=selectors,
        overall_impression="A coherent deck.",
        criterion_scores=(),
        confidence=0.9,
    )


def _recursive_keys(value: object) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            keys.add(str(key))
            keys.update(_recursive_keys(child))
    elif isinstance(value, (list, tuple)):
        for child in value:
            keys.update(_recursive_keys(child))
    return keys


def test_render_evidence_requires_exact_order_unique_paths_and_decodable_images() -> None:
    renders = _renders()
    assert renders.selectors == ("slide:1", "slide:2")

    with pytest.raises(ValidationError, match="exactly match selector order"):
        RenderEvidence(
            expected_slide_count=2,
            contact_sheet=renders.contact_sheet,
            slides=tuple(reversed(renders.slides)),
            selectors=renders.selectors,
        )
    with pytest.raises(ValidationError, match="unique image path"):
        RenderEvidence(
            expected_slide_count=2,
            contact_sheet=renders.contact_sheet,
            slides=(renders.slides[0], renders.slides[1].model_copy(update={"path": renders.slides[0].path})),
            selectors=renders.selectors,
        )
    with pytest.raises(ValidationError, match="must decode"):
        RenderEvidence(
            expected_slide_count=2,
            contact_sheet=renders.contact_sheet,
            slides=(renders.slides[0], renders.slides[1].model_copy(update={"decodes": False})),
            selectors=renders.selectors,
        )


def test_strict_schema_rejects_unstable_selectors_hashes_and_unscored_applicable_criteria() -> None:
    with pytest.raises(ValidationError):
        _image("slide:0")
    with pytest.raises(ValidationError):
        ImageEvidence(
            selector="slide:1",
            path="/slide.png",
            sha256="A" * 64,
            width=1,
            height=1,
        )
    with pytest.raises(ValidationError, match="applicable criteria require a score"):
        CriterionScore(
            criterion_id="subject_specificity",
            applicable=True,
            score=None,
            rationale="Missing score",
            evidence_selectors=("slide:1",),
        )
    with pytest.raises(ValidationError, match="material findings require"):
        EvidenceFinding(code="weak_subject_specificity", observation="Generic", evidence_selectors=())


def test_blind_evidence_contains_only_brief_renders_text_and_blind_rubric() -> None:
    snapshot = _snapshot()
    blind = prepare_blind_visual_evidence(snapshot, _rubric("blind_visual"))
    payload = blind.model_dump(mode="json")

    assert_blind_context_is_clean(blind)
    assert set(payload) == {"schema_version", "brief", "renders", "visible_text", "rubric"}
    assert {
        "creative_plan",
        "design_plan",
        "mechanical_record",
        "expected_verdict",
        "human_label",
    }.isdisjoint(_recursive_keys(payload))


def test_blind_evidence_projects_explicit_taste_only_for_structured_constraints() -> None:
    base = _rubric("blind_visual")
    explicit_taste = RubricCriterionProjection(
        id="explicit_user_taste_fit",
        assessment="blind_visual",
        critical=False,
        weight=1,
        score_anchors={1: "contradicts", 3: "partial", 5: "honors"},
        allowed_failure_codes=("explicit_taste_mismatch",),
    )
    compiled = base.model_copy(
        update={"criteria": (*base.criteria, explicit_taste)}
    )
    empty_snapshot = _snapshot()
    constrained_snapshot = empty_snapshot.model_copy(
        update={
            "brief": empty_snapshot.brief.model_copy(
                update={"explicit_brand_style_constraints": ("Use a restrained blue palette.",)}
            )
        }
    )

    empty = prepare_blind_visual_evidence(empty_snapshot, compiled)
    constrained = prepare_blind_visual_evidence(constrained_snapshot, compiled)

    assert tuple(item.id for item in empty.rubric.criteria) == ("subject_specificity",)
    assert tuple(item.id for item in constrained.rubric.criteria) == (
        "subject_specificity",
        "explicit_user_taste_fit",
    )
    assert brief_scoped_criteria(compiled.criteria, empty_snapshot.brief) == empty.rubric.criteria
    assert compiled.criteria == (base.criteria[0], explicit_taste)


def test_blind_request_preprocessor_removes_appended_prior_memory() -> None:
    request = "Build a five-slide PSI deck.\n\nRelevant memories from this session:\n- private history"

    sanitized = sanitize_current_request(request)

    assert sanitized == "Build a five-slide PSI deck."
    assert forbidden_brief_marker(sanitized) is None


def test_blind_evidence_rejects_unsanitized_prior_memory_sections() -> None:
    snapshot = _snapshot()
    unsafe = snapshot.model_copy(
        update={
            "brief": snapshot.brief.model_copy(
                update={
                    "request": "Current request.\n\nRelevant memories:\n- private history",
                }
            )
        }
    )

    with pytest.raises(ValueError, match="forbidden prior-memory section"):
        prepare_blind_visual_evidence(unsafe, _rubric("blind_visual"))


def test_plan_evidence_adds_only_declared_plan_context_and_rejects_wrong_projection() -> None:
    snapshot = _snapshot()
    commitment = PlanCommitment(
        commitment_id="signature.loop",
        dimension="signature",
        promise="Use a visible control-loop signature",
        selectors=("slide:2",),
    )
    plan = prepare_plan_realization_evidence(
        snapshot,
        rubric=_rubric("plan_realization"),
        subject_materials=("feedback loop",),
        signature="control loop",
        rhythm="setup-mechanism-close",
        commitments=(commitment,),
        explicit_style_constraints=(),
    )

    assert plan.creative_plan == snapshot.creative_plan
    assert plan.design_plan == snapshot.design_plan
    assert plan.commitments == (commitment,)
    with pytest.raises(ValidationError, match="plan-realization rubric"):
        prepare_plan_realization_evidence(
            snapshot,
            rubric=_rubric("blind_visual"),
            subject_materials=(),
            signature="none",
            rhythm="none",
            commitments=(),
            explicit_style_constraints=(),
        )


def test_blind_evidence_requires_visible_text_to_cover_rendered_selectors_in_order() -> None:
    snapshot = _snapshot()
    misordered = snapshot.model_copy(update={"visible_text": tuple(reversed(snapshot.visible_text))})

    with pytest.raises(ValidationError, match="visible-text sidecar"):
        prepare_blind_visual_evidence(misordered, _rubric("blind_visual"))


def test_coverage_proof_is_complete_only_for_exact_confirmed_selector_coverage() -> None:
    snapshot = _snapshot()
    complete = prove_coverage(
        snapshot,
        _visual(selectors=snapshot.renders.selectors, coverage_confirmed=True),
    )
    missing_confirmation = prove_coverage(
        snapshot,
        _visual(selectors=snapshot.renders.selectors, coverage_confirmed=False),
    )
    wrong_selectors = prove_coverage(
        snapshot,
        _visual(selectors=("slide:1",), coverage_confirmed=True),
    )
    absent_judge = prove_coverage(snapshot, None)

    assert complete.complete is True
    assert complete.errors == ()
    assert missing_confirmation.errors == ("judge_coverage_not_confirmed",)
    assert wrong_selectors.errors == ("evaluated_selector_mismatch",)
    assert absent_judge.errors == (
        "judge_coverage_not_confirmed",
        "evaluated_selector_mismatch",
    )


@pytest.mark.parametrize(
    ("checks", "expected_status"),
    [
        (
            {
                "authoritative_gate": True,
                "source_retention": True,
                "native_editability": True,
                "contrast": True,
                "native_lint": True,
                "overflow_collision_clipping": True,
                "render_success": True,
                "visual_asset_completeness": True,
                "artifact_identity": True,
            },
            "passed",
        ),
        ({"authoritative_gate": False}, "failed"),
        ({"authoritative_gate": True}, "incomplete"),
        ({"authoritative_gate": {"status": "unexpected"}}, "incomplete"),
    ],
)
def test_mechanical_projection_uses_stored_truth_without_rejudging(checks: dict[str, object], expected_status: str) -> None:
    projection = project_mechanical_truth(_snapshot(mechanical_record={"checks": checks}))

    assert projection.status == expected_status
    assert len(projection.checks) == 9
    assert projection.authoritative_record_hash == HASH
    if expected_status == "failed":
        failure = next(check for check in projection.checks if check.status == "failed")
        assert failure.failure_codes == ("authoritative_gate_failed",)


def test_mechanical_projection_schema_cannot_claim_pass_with_unknown_check() -> None:
    projected = project_mechanical_truth(_snapshot(mechanical_record={"checks": {}}))

    with pytest.raises(ValidationError, match="passed mechanical projection"):
        MechanicalProjection(
            status="passed",
            checks=projected.checks,
            authoritative_record_hash=HASH,
        )


def test_mechanical_projection_schema_rejects_missing_required_checks() -> None:
    projected = project_mechanical_truth(
        _snapshot(
            mechanical_record={
                "checks": {
                    "authoritative_gate": True,
                    "source_retention": True,
                    "native_editability": True,
                    "contrast": True,
                    "native_lint": True,
                    "overflow_collision_clipping": True,
                    "render_success": True,
                    "visual_asset_completeness": True,
                    "artifact_identity": True,
                }
            }
        )
    )

    with pytest.raises(
        ValidationError,
        match=r"check coverage invalid; missing=artifact_identity; extra=none",
    ):
        MechanicalProjection(
            status="passed",
            checks=projected.checks[:-1],
            authoritative_record_hash=HASH,
        )


def test_committed_fixture_is_complete_but_corpus_readiness_fails_honestly() -> None:
    corpus = load_corpus(CORPUS_PATH)
    report = validate_campaign_corpus(corpus, root=CORPUS_ROOT)

    assert len(corpus.fixtures) == 1
    assert report.fixture_count == 1
    assert report.complete_bundle_count == 1
    assert report.human_label_count == 0
    assert report.ready is False
    assert "human labels require 12, found 0" in report.errors
    assert "complete bundles require 6, found 1" in report.errors


def test_v4_evidence_bundle_preserves_source_bytes_and_locks_new_render_geometry() -> None:
    historical = CORPUS_ROOT / "bundles/clean_underdesigned_psi_v1"
    record = load_corpus(EVIDENCE_V4_CORPUS_PATH).fixtures[0]
    paths = fixture_paths(record, root=CORPUS_ROOT)
    snapshot = load_fixture_inputs(record, root=CORPUS_ROOT)
    manifest = json.loads(paths["manifest_path"].read_text(encoding="utf-8"))

    assert record.id == "clean_underdesigned_psi_v1_evidence_v4"
    assert manifest["source_fixture_id"] == "clean_underdesigned_psi_v1"
    assert manifest["evidence_preprocessor_version"] == "deck-evidence-v4"
    assert manifest["direct_evidence_budget_version"] == "dq1-direct-evidence-v2"
    assert manifest["raster_max_dimension"] == 2200
    assert manifest["contact_sheet_max_dimension"] == 2048
    assert file_sha256(paths["artifact_path"]) == file_sha256(
        historical / "artifact.pptx"
    )
    assert {item.width for item in snapshot.renders.slides} == {2200}
    assert {item.height for item in snapshot.renders.slides} == {1238}
    assert (
        snapshot.renders.contact_sheet.width,
        snapshot.renders.contact_sheet.height,
    ) == (2048, 792)
    assert {
        path.name: file_sha256(path)
        for path in sorted(paths["render_dir"].glob("*.png"))
    } == manifest["render_hashes"]
    historical_manifest = json.loads(
        (historical / "manifest.json").read_text(encoding="utf-8")
    )
    assert "evidence_preprocessor_version" not in historical_manifest
    assert file_sha256(historical / "renders/slide-1.png") != (
        snapshot.renders.slides[0].sha256
    )


def test_supplied_psi_anchor_contains_exactly_the_observations_from_appendix_b() -> None:
    raw = yaml.safe_load(CORPUS_PATH.read_text(encoding="utf-8"))
    fixture = raw["fixtures"][0]

    assert fixture["id"] == "clean_underdesigned_psi_v1"
    assert fixture["label_source"] == "supplied_by_campaign_spec"
    assert fixture["expected"] == {
        "verdict": "needs_revision",
        "mechanical": "passed",
        "expected_strengths": [
            "clear hierarchy",
            "readable typography",
            "coherent content arc",
            "native editability",
        ],
        "required_failure_codes": [
            "default_look_gravity",
            "weak_subject_specificity",
            "weak_signature_realization",
            "low_sequence_rhythm",
            "weak_closing_synthesis",
        ],
        "expected_selectors": ["slide:2", "slide:3", "slide:5"],
    }
    assert {
        "critical_criterion_floors",
        "top_failure_codes",
        "rationale",
        "confidence",
    }.isdisjoint(fixture["expected"])


@pytest.mark.parametrize(
    "missing_field",
    [
        "critical_criterion_floors",
        "top_failure_codes",
        "rationale",
        "confidence",
    ],
)
def test_human_labels_require_every_calibration_field(missing_field: str) -> None:
    raw = yaml.safe_load(CORPUS_PATH.read_text(encoding="utf-8"))
    payload = copy.deepcopy(raw["fixtures"][0])
    payload["label_source"] = "human"
    payload["expected"].update(
        {
            "critical_criterion_floors": {
                "subject_specificity": "below_pass_floor",
            },
            "top_failure_codes": [
                "default_look_gravity",
                "weak_subject_specificity",
                "weak_signature_realization",
            ],
            "rationale": "A human reviewer calibrated the rendered deck against the locked rubric.",
            "confidence": 0.9,
        }
    )
    payload["expected"].pop(missing_field)

    with pytest.raises(ValidationError):
        FixtureRecord.model_validate(payload)


def test_complete_human_label_accepts_calibration_fields_without_changing_spec_anchor() -> None:
    raw = yaml.safe_load(CORPUS_PATH.read_text(encoding="utf-8"))
    payload = copy.deepcopy(raw["fixtures"][0])
    payload["label_source"] = "human"
    payload["expected"].update(
        {
            "critical_criterion_floors": {
                "subject_specificity": "below_pass_floor",
            },
            "top_failure_codes": [
                "default_look_gravity",
                "weak_subject_specificity",
                "weak_signature_realization",
            ],
            "rationale": "A human reviewer calibrated the rendered deck against the locked rubric.",
            "confidence": 0.9,
        }
    )

    human_record = FixtureRecord.model_validate(payload)

    assert human_record.label_source == "human"
    assert human_record.expected.top_failure_codes == (
        "default_look_gravity",
        "weak_subject_specificity",
        "weak_signature_realization",
    )
    committed = yaml.safe_load(CORPUS_PATH.read_text(encoding="utf-8"))["fixtures"][0]
    assert committed["label_source"] == "supplied_by_campaign_spec"
    assert "top_failure_codes" not in committed["expected"]


def test_fixture_label_is_loaded_separately_and_never_read_for_model_inputs() -> None:
    record = load_corpus(CORPUS_PATH).fixtures[0]

    class LabelAccessTrap:
        def __getattr__(self, name: str) -> object:
            if name == "expected":
                raise AssertionError("model input construction accessed the human label")
            return getattr(record, name)

    snapshot = load_fixture_inputs(LabelAccessTrap(), root=CORPUS_ROOT)  # type: ignore[arg-type]
    payload = snapshot.model_dump(mode="json")
    label = load_fixture_label(record)

    assert label.verdict == "needs_revision"
    assert label.mechanical == "passed"
    assert label.expected_strengths == (
        "clear hierarchy",
        "readable typography",
        "coherent content arc",
        "native editability",
    )
    assert label.required_failure_codes == (
        "default_look_gravity",
        "weak_subject_specificity",
        "weak_signature_realization",
        "low_sequence_rhythm",
        "weak_closing_synthesis",
    )
    assert label.expected_selectors == ("slide:2", "slide:3", "slide:5")
    assert {
        "critical_criterion_floors",
        "top_failure_codes",
        "rationale",
        "confidence",
    }.isdisjoint(label.model_dump(exclude_unset=True))
    assert {
        "expected",
        "verdict",
        "label_source",
        "top_failure_codes",
        "required_failure_codes",
        "prohibited_failure_codes",
        "human_label",
        "strengths",
        "failures",
    }.isdisjoint(_recursive_keys(payload))


def test_fixture_paths_reject_traversal_before_reading_any_artifact() -> None:
    record = load_corpus(CORPUS_PATH).fixtures[0].model_copy(update={"artifact_path": "../deck.pptx"})

    with pytest.raises(ValueError, match="traversal-free"):
        fixture_paths(record, root=CORPUS_ROOT)
