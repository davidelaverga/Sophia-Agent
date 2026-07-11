from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class BuildFoundationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True
    manifest_mode: Literal["off", "shadow", "enforce"] = "shadow"
    enforce_absolute_deadline: bool = True
    terminal_reserve_seconds: int = Field(default=45, ge=10, le=180)
    persist_event_journal: bool = True
    require_manifest_cas: bool = True
    enable_safe_boundary_hooks: bool = True
    enable_mutation_transactions: bool = False
    mirror_sources: bool = True
    verify_durable_objects: bool = True
