"""Independent, observation-only rendered deck quality controller."""

from deerflow.sophia.deck_quality.adjudicator import adjudicate_shadow_result
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id

__all__ = ["adjudicate_shadow_result", "derive_quality_run_id"]
