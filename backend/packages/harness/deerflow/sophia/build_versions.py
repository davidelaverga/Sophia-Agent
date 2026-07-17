from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from deerflow.sophia.build_manifest import utc_now_iso


class BuildComponentVersion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version_id: str
    component_id: str
    selector: str
    source_version_id: str
    source_paths: list[str]
    source_hashes: dict[str, str]
    source_roles: dict[str, str] = Field(default_factory=dict)
    asset_version_ids: list[str] = Field(default_factory=list)
    resolved_output_hash: str | None = None
    authored_by: Literal["fresh", "user_revise", "quality_repair", "resume"]
    instruction_hash: str | None = None
    transaction_id: str | None = None
    created_at: str = Field(default_factory=utc_now_iso)


class BuildArtifactVersion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version_id: str
    build_id: str
    logical_artifact_id: str
    manifest_revision: int
    artifact_path: str
    artifact_hash: str
    storage_object_path: str
    verified: bool
    created_at: str = Field(default_factory=utc_now_iso)
