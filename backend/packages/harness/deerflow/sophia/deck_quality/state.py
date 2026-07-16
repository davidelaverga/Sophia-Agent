from __future__ import annotations

from typing import Any, TypedDict


class DeckQualityShadowState(TypedDict, total=False):
    campaign_id: str
    quality_run_id: str
    build_id: str
    user_id: str
    task_id: str | None
    builder_run_id: str | None
    parent_builder_trace_id: str | None
    logical_artifact_id: str
    artifact_version_id: str
    manifest_revision: int | None
    artifact_path: str
    source_snapshot: dict[str, Any]
    evidence_manifest: dict[str, Any]
    visual_assessment: dict[str, Any]
    mechanical_projection: dict[str, Any]
    plan_realization_assessment: dict[str, Any]
    shadow_decision: dict[str, Any]
    errors: list[dict[str, Any]]
