from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

import yaml
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import (
    BlindBrief,
    ImageEvidence,
    QualityEvidenceSnapshot,
    RenderEvidence,
    VisibleTextSlide,
)

FixtureCategory = Literal[
    "known_strong",
    "clean_underdesigned",
    "mechanically_invalid",
    "brand_exception",
    "minimal_text_led",
]


class FixtureExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    verdict: Literal[
        "failed_to_judge",
        "mechanically_invalid",
        "needs_revision",
        "needs_user_review",
        "satisfied",
    ]
    mechanical: Literal["passed", "failed", "incomplete"]
    expected_strengths: tuple[str, ...] = ()
    critical_criterion_floors: dict[str, str] = Field(default_factory=dict)
    top_failure_codes: tuple[str, ...] = ()
    required_failure_codes: tuple[str, ...] = ()
    prohibited_failure_codes: tuple[str, ...] = ()
    expected_selectors: tuple[str, ...]
    rationale: str | None = Field(default=None, min_length=1)
    confidence: float | None = Field(default=None, ge=0, le=1)


class FixtureRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    category: FixtureCategory
    artifact_path: str
    render_dir: str
    brief_path: str
    creative_plan_path: str
    design_plan_path: str
    mechanical_report_path: str
    manifest_path: str
    visible_text_path: str
    expected: FixtureExpectation
    label_source: Literal["human", "supplied_by_campaign_spec", "unlabeled"]

    @model_validator(mode="after")
    def validate_label_provenance(self) -> FixtureRecord:
        calibration_fields_present = bool(self.expected.critical_criterion_floors or self.expected.top_failure_codes or self.expected.rationale is not None or self.expected.confidence is not None)
        if self.label_source != "human" and calibration_fields_present:
            raise ValueError("non-human fixture anchors cannot supply human calibration fields")
        if self.label_source == "human":
            if not self.expected.critical_criterion_floors:
                raise ValueError("human fixture labels require critical criterion floors")
            if len(self.expected.top_failure_codes) != 3:
                raise ValueError("human fixture labels require exactly three top failure codes")
            if not set(self.expected.top_failure_codes).issubset(self.expected.required_failure_codes):
                raise ValueError("top failure codes must be included in required failure codes")
            if self.expected.rationale is None or self.expected.confidence is None:
                raise ValueError("human fixture labels require rationale and confidence")
        return self


class CorpusManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal["deck-quality-corpus/v1"] = "deck-quality-corpus/v1"
    fixtures: tuple[FixtureRecord, ...]

    @model_validator(mode="after")
    def unique_fixture_ids(self) -> CorpusManifest:
        ids = [fixture.id for fixture in self.fixtures]
        if len(ids) != len(set(ids)):
            raise ValueError("fixture IDs must be unique")
        return self


class CorpusReadinessReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    ready: bool
    fixture_count: int
    human_label_count: int
    complete_bundle_count: int
    category_counts: dict[str, int]
    errors: tuple[str, ...]


def load_corpus(path: Path) -> CorpusManifest:
    return CorpusManifest.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")) or {})


def _resolve_relative(root: Path, value: str) -> Path:
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"fixture paths must be relative and traversal-free: {value}")
    resolved = (root / relative).resolve()
    if root.resolve() not in resolved.parents and resolved != root.resolve():
        raise ValueError(f"fixture path escapes corpus root: {value}")
    return resolved


def fixture_paths(record: FixtureRecord, *, root: Path) -> dict[str, Path]:
    names = (
        "artifact_path",
        "render_dir",
        "brief_path",
        "creative_plan_path",
        "design_plan_path",
        "mechanical_report_path",
        "manifest_path",
        "visible_text_path",
    )
    return {name: _resolve_relative(root, str(getattr(record, name))) for name in names}


def _complete_bundle(paths: dict[str, Path]) -> bool:
    required_files = (
        "artifact_path",
        "brief_path",
        "creative_plan_path",
        "design_plan_path",
        "mechanical_report_path",
        "manifest_path",
        "visible_text_path",
    )
    if any(not paths[name].is_file() for name in required_files):
        return False
    render_dir = paths["render_dir"]
    return (render_dir / "contact-sheet.png").is_file() and bool(list(render_dir.glob("slide-*.png")))


def validate_campaign_corpus(corpus: CorpusManifest, *, root: Path) -> CorpusReadinessReport:
    target_counts = {
        "known_strong": 4,
        "clean_underdesigned": 4,
        "mechanically_invalid": 2,
        "brand_exception": 1,
        "minimal_text_led": 1,
    }
    counts = {category: 0 for category in target_counts}
    human_count = 0
    complete_count = 0
    errors: list[str] = []
    for record in corpus.fixtures:
        counts[record.category] += 1
        human_count += int(record.label_source == "human")
        try:
            paths = fixture_paths(record, root=root)
        except ValueError as exc:
            errors.append(f"{record.id}: {exc}")
            continue
        if _complete_bundle(paths):
            complete_count += 1
        else:
            errors.append(f"{record.id}: incomplete fixture bundle")
    for category, required in target_counts.items():
        if counts[category] < required:
            errors.append(f"category {category} requires {required}, found {counts[category]}")
    if human_count < 12:
        errors.append(f"human labels require 12, found {human_count}")
    if complete_count < 6:
        errors.append(f"complete bundles require 6, found {complete_count}")
    return CorpusReadinessReport(
        ready=not errors,
        fixture_count=len(corpus.fixtures),
        human_label_count=human_count,
        complete_bundle_count=complete_count,
        category_counts=counts,
        errors=tuple(errors),
    )


def load_fixture_label(record: FixtureRecord) -> FixtureExpectation:
    """Labels are loaded separately and must never enter evidence construction."""

    return record.expected


def _image_evidence(path: Path, *, selector: str) -> ImageEvidence:
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        width, height = image.size
    return ImageEvidence(
        selector=selector,  # type: ignore[arg-type]
        path=path.as_posix(),
        sha256=__import__("hashlib").sha256(path.read_bytes()).hexdigest(),
        width=width,
        height=height,
        decodes=True,
    )


def load_fixture_inputs(record: FixtureRecord, *, root: Path) -> QualityEvidenceSnapshot:
    """Build model-facing inputs without ever reading ``record.expected``."""

    paths = fixture_paths(record, root=root)
    brief = json.loads(paths["brief_path"].read_text(encoding="utf-8"))
    creative = json.loads(paths["creative_plan_path"].read_text(encoding="utf-8"))
    design = json.loads(paths["design_plan_path"].read_text(encoding="utf-8"))
    mechanical = json.loads(paths["mechanical_report_path"].read_text(encoding="utf-8"))
    manifest = json.loads(paths["manifest_path"].read_text(encoding="utf-8"))
    visible_text = tuple(VisibleTextSlide.model_validate(item) for item in json.loads(paths["visible_text_path"].read_text(encoding="utf-8")))
    render_dir = paths["render_dir"]
    slide_paths = sorted(render_dir.glob("slide-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    selectors = tuple(f"slide:{index}" for index in range(1, len(slide_paths) + 1))
    renders = RenderEvidence(
        expected_slide_count=len(slide_paths),
        contact_sheet=_image_evidence(render_dir / "contact-sheet.png", selector="contact-sheet"),
        slides=tuple(_image_evidence(path, selector=selector) for path, selector in zip(slide_paths, selectors, strict=True)),
        selectors=selectors,
    )
    hashes = manifest["source_hashes"]
    return QualityEvidenceSnapshot(
        campaign_id="DQ-1",
        build_id=manifest["build_id"],
        user_id="synthetic-canary",
        task_id="019f675a-dcbd-7df0-a8ec-5371ee7315f2",
        builder_run_id=manifest["trace_id"],
        parent_builder_trace_id=manifest["trace_id"],
        logical_artifact_id=manifest["artifact_id"],
        artifact_version_id=manifest["artifact_version_id"],
        artifact_path=paths["artifact_path"].as_posix(),
        artifact_hash=hashes["artifact.pptx"],
        brief_hash=hashes["brief.json"],
        creative_plan_hash=hashes["creative_plan.json"],
        design_plan_hash=hashes["design_plan.json"],
        brief=BlindBrief.model_validate(brief),
        renders=renders,
        visible_text=visible_text,
        creative_plan=creative,
        design_plan=design,
        mechanical_record=mechanical,
        mechanical_record_hash=canonical_sha256(mechanical),
    )
