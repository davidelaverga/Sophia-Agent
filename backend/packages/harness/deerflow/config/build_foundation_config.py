from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.storage.supabase_artifact_store import safe_object_path_segment

ManifestMode = Literal["off", "shadow", "enforce", "canary_enforce"]
EffectiveManifestMode = Literal["off", "shadow", "enforce"]


class BuildFoundationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True
    manifest_mode: ManifestMode = "shadow"
    enforce_canary_user_ids: frozenset[str] = frozenset()
    enforce_absolute_deadline: bool = True
    terminal_reserve_seconds: int = Field(default=45, ge=10, le=180)
    persist_event_journal: bool = True
    require_manifest_cas: bool = True
    enable_safe_boundary_hooks: bool = True
    enable_mutation_transactions: bool = False
    mirror_sources: bool = True
    verify_durable_objects: bool = True

    @field_validator("enforce_canary_user_ids", mode="before")
    @classmethod
    def normalize_enforce_canary_user_ids(cls, value: object) -> object:
        if isinstance(value, str):
            return frozenset(part.strip() for part in value.split(",") if part.strip())
        return value

    @model_validator(mode="after")
    def validate_canary_enforcement(self) -> BuildFoundationConfig:
        if self.manifest_mode == "canary_enforce":
            if not self.enforce_canary_user_ids:
                raise ValueError("canary_enforce requires an exact nonempty canary user set")
            if any(safe_object_path_segment(user_id, default="user") != user_id for user_id in self.enforce_canary_user_ids):
                raise ValueError("canary_enforce user IDs must be canonical durable-path segments")
        elif self.enforce_canary_user_ids:
            raise ValueError("enforce_canary_user_ids is valid only with canary_enforce mode")
        return self

    def effective_manifest_mode(self, user_id: str | None) -> EffectiveManifestMode:
        if self.manifest_mode != "canary_enforce":
            return self.manifest_mode
        normalized_user_id = str(user_id or "").strip()
        if normalized_user_id in self.enforce_canary_user_ids:
            return "enforce"
        return "shadow"
