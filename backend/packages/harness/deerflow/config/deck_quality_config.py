from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.deck_quality.cost import validate_sol_plan_locks
from deerflow.sophia.storage.supabase_artifact_store import safe_object_path_segment

REQUIRED_DECK_JUDGE_CAPABILITIES = frozenset(
    {
        "image_input",
        "multi_image_input",
        "strict_structured_output",
        "reasoning_effort",
    }
)


class DeckQualityConfigError(ValueError):
    """Raised when a DQ-1 configuration violates a locked campaign invariant."""


class DeckQualityConfig(BaseModel):
    """DQ-1 configuration with prohibited production states made unrepresentable."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    enabled: bool = False
    mode: Literal["off", "shadow"] = "off"
    scope: Literal["canary"] = "canary"
    canary_user_ids: frozenset[str] = frozenset()
    judge_route: str = "deck.judge.visual"
    rubric_version: str = "deck-rubric-v2"
    judge_profile_version: str = "deck-visual-judge-v2"
    evidence_preprocessor_version: str = "deck-evidence-v4"
    judge_invoker_version: str = "deck-judge-invoker-v4"
    # Defaults closed. Production may opt in only after an operator explicitly
    # authorizes reusing the baseline provider credential through the DQ-only
    # environment name; route/canary/call-budget isolation still applies.
    allow_shared_provider_credential: bool = False
    async_after_success: Literal[True] = True
    mutate_artifact: Literal[False] = False
    affect_delivery: Literal[False] = False
    sample_rate: Literal[0.0] = 0.0
    max_quality_calls: Literal[2] = 2
    max_quality_cost_usd: Decimal | None = Field(default=None, gt=0)
    max_quality_wall_clock_seconds: int = Field(default=300, ge=30, le=300)

    @field_validator("canary_user_ids", mode="before")
    @classmethod
    def normalize_canary_user_ids(cls, value: object) -> object:
        if isinstance(value, str):
            return frozenset(part.strip() for part in value.split(",") if part.strip())
        return value

    @model_validator(mode="after")
    def validate_enabled_state(self) -> DeckQualityConfig:
        if not self.enabled:
            return self
        if self.mode != "shadow":
            raise DeckQualityConfigError("enabled DQ-1 execution must use shadow authority")
        if not self.canary_user_ids:
            raise DeckQualityConfigError("enabled canary scope requires at least one canary user ID")
        if any(
            safe_object_path_segment(user_id, default="user") != user_id
            for user_id in self.canary_user_ids
        ):
            raise DeckQualityConfigError(
                "enabled canary user IDs must be canonical durable-path segments"
            )
        if self.max_quality_cost_usd is None:
            raise DeckQualityConfigError("enabled DQ-1 execution requires an explicit positive cost cap")
        if self.max_quality_cost_usd != Decimal("0.60"):
            raise DeckQualityConfigError("enabled DQ-1 execution requires the locked 0.60 USD cost cap")
        return self


def audit_deck_quality_startup(
    config: DeckQualityConfig,
    *,
    resolved_plan: ResolvedModelPlan | None,
) -> None:
    """Fail closed before an enabled DQ-1 process can accept work."""

    if not config.enabled:
        return
    if resolved_plan is None:
        raise DeckQualityConfigError("enabled DQ-1 execution requires a resolved judge route")
    if resolved_plan.route_name != config.judge_route:
        raise DeckQualityConfigError(f"resolved route {resolved_plan.route_name!r} does not match {config.judge_route!r}")
    missing = sorted(REQUIRED_DECK_JUDGE_CAPABILITIES - resolved_plan.capabilities)
    if missing:
        raise DeckQualityConfigError(f"judge route lacks required capabilities: {', '.join(missing)}")
    if resolved_plan.profile_name != config.judge_profile_version:
        raise DeckQualityConfigError("resolved judge profile does not match the DQ-1 lock")
    try:
        validate_sol_plan_locks(resolved_plan)
    except ValueError as error:
        raise DeckQualityConfigError(str(error)) from None
