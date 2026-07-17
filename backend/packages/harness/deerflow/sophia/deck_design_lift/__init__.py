"""Deterministic schemas and policy for the one-repair deck design-lift loop."""

from deerflow.sophia.deck_design_lift.comparator import compare_deck_versions
from deerflow.sophia.deck_design_lift.compiler import (
    RepairProgramRejected,
    compile_repair_program,
    validate_candidate_against_program,
)
from deerflow.sophia.deck_design_lift.schemas import (
    AssetUpdate,
    ContentPreservationProof,
    DeckRepairCandidate,
    DeckRepairProgram,
    DeckVersionComparison,
    DeckVersionComparisonInput,
    JudgmentRepairFinding,
    LocalityProof,
    RepairCompilerInput,
    RepairRenderEvidence,
    SelectorRepair,
    SelectorSourceAuthorization,
    SkillRef,
    SourceUpdate,
    VersionCriterionScore,
    VersionQualityEvidence,
)

__all__ = [
    "AssetUpdate",
    "ContentPreservationProof",
    "DeckRepairCandidate",
    "DeckRepairProgram",
    "DeckVersionComparison",
    "DeckVersionComparisonInput",
    "JudgmentRepairFinding",
    "LocalityProof",
    "RepairCompilerInput",
    "RepairProgramRejected",
    "RepairRenderEvidence",
    "SelectorRepair",
    "SelectorSourceAuthorization",
    "SkillRef",
    "SourceUpdate",
    "VersionCriterionScore",
    "VersionQualityEvidence",
    "compare_deck_versions",
    "compile_repair_program",
    "validate_candidate_against_program",
]
