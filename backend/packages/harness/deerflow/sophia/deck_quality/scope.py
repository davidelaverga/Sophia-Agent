from __future__ import annotations

from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.deck_quality.schemas import ScopeDecision


def evaluate_canary_scope(
    config: DeckQualityConfig,
    *,
    user_id: str,
    builder_status: str,
    artifact_type: str,
    artifact_downloadable: bool,
    authoritative_mechanical_passed: bool,
) -> ScopeDecision:
    """Pure eligibility guard. It never dispatches work or changes delivery state."""

    if not config.enabled or config.mode == "off":
        return ScopeDecision(eligible=False, reason="disabled")
    if user_id not in config.canary_user_ids:
        return ScopeDecision(eligible=False, reason="not_canary_user")
    if builder_status.casefold() not in {"success", "completed"}:
        return ScopeDecision(eligible=False, reason="builder_not_successful")
    if artifact_type.casefold().lstrip(".") != "pptx":
        return ScopeDecision(eligible=False, reason="artifact_not_pptx")
    if not artifact_downloadable:
        return ScopeDecision(eligible=False, reason="artifact_not_downloadable")
    if not authoritative_mechanical_passed:
        return ScopeDecision(eligible=False, reason="mechanical_not_passed")
    return ScopeDecision(eligible=True, reason="eligible")
