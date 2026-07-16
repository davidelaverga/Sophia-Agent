from __future__ import annotations

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock


def derive_quality_run_id(
    *,
    artifact_version_id: str,
    campaign_id: str,
    instrument: QualityInstrumentLock,
) -> str:
    """Derive a stable ID for one artifact and complete measurement instrument."""

    digest = canonical_sha256(
        {
            "artifact_version_id": artifact_version_id,
            "campaign_id": campaign_id,
            "instrument": instrument,
        }
    )
    return f"quality_{digest}"
