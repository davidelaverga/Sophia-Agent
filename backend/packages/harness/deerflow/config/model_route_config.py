from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ModelRouteConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    primary: str
    fallbacks: list[str] = Field(default_factory=list)
    profile: str
    required_capabilities: set[str] = Field(default_factory=set)
    reasoning: dict[str, Any] = Field(default_factory=dict)
    max_failovers: int = Field(default=1, ge=0, le=2)


class HarnessProfileConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = "v1"
    model_overrides: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: int = Field(default=120, ge=1, le=600)
    max_retries: int = Field(default=0, ge=0, le=2)


class ResolvedModelPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    route_name: str
    deployment_name: str
    provider: str
    provider_model: str
    profile_name: str
    profile_version: str
    capabilities: frozenset[str]
    model_overrides: dict[str, Any]
    policy_version: str = "sophia-model-route/v1"
    plan_hash: str
