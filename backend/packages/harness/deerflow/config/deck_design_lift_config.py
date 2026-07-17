from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.storage.supabase_artifact_store import safe_object_path_segment

REQUIRED_DECK_REPAIR_CAPABILITIES = frozenset(
    {
        "image_input",
        "multi_image_input",
        "strict_structured_output",
        "reasoning_effort",
    }
)


class DeckDesignLiftConfigError(ValueError):
    """Raised when an enabled DQ-2 campaign violates a locked invariant."""


class DeckDesignLiftConfig(BaseModel):
    """Separate, exact-canary authority for the bounded DQ-2 mutation loop."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    enabled: bool = False
    mode: Literal["off", "production_canary"] = "off"
    scope: Literal["canary"] = "canary"
    canary_user_ids: frozenset[str] = frozenset()
    judge_route: str = "deck.judge.visual"
    repair_route: str = "deck.repair.executor"
    judge_profile_version: str = "deck-visual-judge-v2"
    repair_profile_version: str = "deck-repair-executor-v1"
    max_repairs: Literal[1] = 1
    affect_delivery: Literal[False] = False
    promote_improved_candidate: Literal[True] = True
    max_judge_calls: Literal[4] = 4
    max_repair_calls: Literal[1] = 1
    max_campaign_cost_usd: Decimal | None = Field(default=None, gt=0)
    max_campaign_wall_clock_seconds: int = Field(default=900, ge=300, le=1_200)
    require_manifest_enforce: Literal[True] = True
    require_mutation_transactions: Literal[True] = True
    require_mechanical_pass_before_commit: Literal[True] = True
    require_second_judge_approval: Literal[True] = True
    require_deterministic_improvement: Literal[True] = True

    @field_validator("canary_user_ids", mode="before")
    @classmethod
    def normalize_canary_user_ids(cls, value: object) -> object:
        if isinstance(value, str):
            return frozenset(part.strip() for part in value.split(",") if part.strip())
        return value

    @model_validator(mode="after")
    def validate_enabled_state(self) -> DeckDesignLiftConfig:
        if not self.enabled:
            return self
        if self.mode != "production_canary":
            raise DeckDesignLiftConfigError("enabled DQ-2 execution requires production_canary mode")
        if not self.canary_user_ids:
            raise DeckDesignLiftConfigError("enabled DQ-2 requires at least one exact canary user ID")
        if any(
            safe_object_path_segment(user_id, default="user") != user_id
            for user_id in self.canary_user_ids
        ):
            raise DeckDesignLiftConfigError(
                "enabled DQ-2 canary user IDs must be canonical durable-path segments"
            )
        if self.max_campaign_cost_usd is None:
            raise DeckDesignLiftConfigError("enabled DQ-2 requires an explicit positive campaign cost cap")
        if self.max_campaign_cost_usd != Decimal("3.00"):
            raise DeckDesignLiftConfigError("enabled DQ-2 requires the locked 3.00 USD campaign cost cap")
        return self


def audit_deck_design_lift_startup(
    config: DeckDesignLiftConfig,
    *,
    judge_plan: ResolvedModelPlan | None,
    repair_plan: ResolvedModelPlan | None,
    manifest_mode: str,
    mutation_transactions_enabled: bool,
) -> None:
    """Fail closed before an enabled DQ-2 process can accept campaign work."""

    if not config.enabled:
        return
    if manifest_mode != "enforce":
        raise DeckDesignLiftConfigError("enabled DQ-2 requires manifest enforcement")
    if not mutation_transactions_enabled:
        raise DeckDesignLiftConfigError("enabled DQ-2 requires durable mutation transactions")
    for label, route_name, profile_name, plan in (
        ("judge", config.judge_route, config.judge_profile_version, judge_plan),
        ("repair", config.repair_route, config.repair_profile_version, repair_plan),
    ):
        if plan is None:
            raise DeckDesignLiftConfigError(f"enabled DQ-2 requires a resolved {label} route")
        if plan.route_name != route_name:
            raise DeckDesignLiftConfigError(
                f"resolved {label} route {plan.route_name!r} does not match {route_name!r}"
            )
        if plan.profile_name != profile_name:
            raise DeckDesignLiftConfigError(f"resolved {label} profile does not match the DQ-2 lock")
        missing = sorted(REQUIRED_DECK_REPAIR_CAPABILITIES - plan.capabilities)
        if missing:
            raise DeckDesignLiftConfigError(
                f"{label} route lacks required capabilities: {', '.join(missing)}"
            )
