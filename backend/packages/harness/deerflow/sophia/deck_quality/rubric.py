from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    AssessmentOwner,
    RubricCriterionProjection,
    RubricProjection,
    Sha256,
)

RuleClassification = Literal[
    "visual_judge_criterion",
    "plan_realization_criterion",
    "deterministic_mechanical_gate",
    "controller_invariant",
    "future_repair_technique",
    "deck_inapplicable_exclusion",
]


class RubricCriterion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    assessment: AssessmentOwner
    critical: bool
    weight: Decimal = Field(default=Decimal("1.0"), gt=0)
    failure_codes: tuple[str, ...]
    score_anchors: dict[Literal[1, 3, 5], str]
    source_refs: tuple[str, ...]

    @field_validator("score_anchors")
    @classmethod
    def validate_anchors(cls, value: dict[int, str]) -> dict[int, str]:
        if set(value) != {1, 3, 5}:
            raise ValueError("rubric criteria require 1, 3, and 5 anchors")
        if any(not item.strip() for item in value.values()):
            raise ValueError("rubric score anchors cannot be blank")
        return value

    @model_validator(mode="after")
    def require_provenance(self) -> RubricCriterion:
        if not self.source_refs:
            raise ValueError("rubric criteria require source provenance")
        if not self.failure_codes:
            raise ValueError("rubric criteria require at least one controlled failure code")
        return self


class RubricSourceRule(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    classification: RuleClassification
    source_ref: str
    criterion_id: str | None = None


class RubricDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal["deck-quality-rubric/v1"] = "deck-quality-rubric/v1"
    version: str
    criteria: tuple[RubricCriterion, ...]
    source_rules: tuple[RubricSourceRule, ...]
    adjudication: AdjudicationPolicy

    @model_validator(mode="after")
    def validate_document(self) -> RubricDocument:
        criterion_ids = [item.id for item in self.criteria]
        if len(criterion_ids) != len(set(criterion_ids)):
            raise ValueError("rubric criterion IDs must be unique")
        rule_ids = [item.id for item in self.source_rules]
        if len(rule_ids) != len(set(rule_ids)):
            raise ValueError("rubric source-rule IDs must be unique")
        known = set(criterion_ids)
        dangling = sorted(rule.criterion_id for rule in self.source_rules if rule.criterion_id and rule.criterion_id not in known)
        if dangling:
            raise ValueError(f"source rules reference unknown criteria: {', '.join(dangling)}")
        if not self.criteria or not self.source_rules:
            raise ValueError("rubric criteria and source rule ledger cannot be empty")
        return self


class CompiledRubric(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    document: RubricDocument
    sha256: Sha256


class RubricLock(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal["deck-quality-rubric-lock/v1"] = "deck-quality-rubric-lock/v1"
    rubric_version: str
    sha256: Sha256
    source_path: str
    criterion_count: int
    source_rule_count: int


def compile_rubric(source_path: Path) -> CompiledRubric:
    raw = yaml.safe_load(source_path.read_text(encoding="utf-8")) or {}
    document = RubricDocument.model_validate(raw)
    return CompiledRubric(document=document, sha256=canonical_sha256(document))


def projection_for(rubric: CompiledRubric, assessment: AssessmentOwner) -> RubricProjection:
    criteria = tuple(
        RubricCriterionProjection(
            id=item.id,
            assessment=item.assessment,
            critical=item.critical,
            weight=item.weight,
            score_anchors=item.score_anchors,
            allowed_failure_codes=item.failure_codes,
        )
        for item in rubric.document.criteria
        if item.assessment == assessment
    )
    return RubricProjection(
        rubric_version=rubric.document.version,
        rubric_hash=rubric.sha256,
        assessment=assessment,
        criteria=criteria,
    )


def build_rubric_lock(rubric: CompiledRubric, *, source_path: str) -> RubricLock:
    return RubricLock(
        rubric_version=rubric.document.version,
        sha256=rubric.sha256,
        source_path=source_path,
        criterion_count=len(rubric.document.criteria),
        source_rule_count=len(rubric.document.source_rules),
    )


def verify_rubric_lock(rubric: CompiledRubric, lock_path: Path) -> None:
    actual = RubricLock.model_validate(json.loads(lock_path.read_text(encoding="utf-8")))
    if actual.sha256 != rubric.sha256 or actual.rubric_version != rubric.document.version:
        raise ValueError("compiled rubric does not match the committed rubric lock")
    if actual.criterion_count != len(rubric.document.criteria):
        raise ValueError("rubric lock criterion count drift")
    if actual.source_rule_count != len(rubric.document.source_rules):
        raise ValueError("rubric lock source-rule count drift")


def render_rubric_markdown(rubric: CompiledRubric) -> str:
    lines = [
        f"# Sophia Deck Quality Rubric — {rubric.document.version}",
        "",
        f"Canonical SHA-256: `{rubric.sha256}`",
        "",
        "This file is generated from `deck_rubric.yaml`; the YAML is authoritative.",
        "",
    ]
    for criterion in rubric.document.criteria:
        lines.extend(
            [
                f"## {criterion.id}",
                "",
                f"Owner: `{criterion.assessment}` · Critical: `{str(criterion.critical).lower()}` · Weight: `{criterion.weight}`",
                "",
                f"- 1: {criterion.score_anchors[1]}",
                f"- 3: {criterion.score_anchors[3]}",
                f"- 5: {criterion.score_anchors[5]}",
                "",
                "Failure codes: " + ", ".join(f"`{item}`" for item in criterion.failure_codes),
                "",
                "Sources: " + ", ".join(f"`{item}`" for item in criterion.source_refs),
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"
