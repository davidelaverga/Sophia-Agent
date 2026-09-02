"""Content-free legacy inventory and exact-evidence classification.

This module never treats provider metadata or fuzzy text similarity as consent.
It produces a no-write report suitable for the R6 approval boundary. Applying
an import is deliberately a separate operation.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .mem0_projection_adapter import Mem0ContractError, Mem0ProjectionAdapter
from .refs import keyed_ref

LegacyDestination = Literal[
    "canonical_import_eligible",
    "candidate_ledger_eligible",
    "ineligible_purge_obligation",
    "legacy_quarantined",
]


@dataclass(frozen=True)
class LegacyEvidence:
    exact_owner_provenance: bool = False
    durable_user_review_receipt_ref: str | None = None
    fresh_user_reapproval_ref: str | None = None
    exact_pending_review: bool = False
    trustworthy_session_source: bool = False
    rejected_evidence: bool = False
    deleted_evidence: bool = False
    local_only: bool = False
    conflicting: bool = False


@dataclass(frozen=True)
class LegacyInventoryItem:
    provider_id_ref: str
    metadata_state: str
    destination: LegacyDestination
    reason: str


@dataclass(frozen=True)
class LegacyInventoryReport:
    provider: str
    environment: str
    project_ref: str
    namespace_ref: str
    pagination_complete: bool
    page_count: int
    record_count: int
    classification_counts: dict[str, int]
    items: tuple[LegacyInventoryItem, ...]
    safe_error_code: str | None = None


@dataclass(frozen=True)
class LegacyArtifactInventoryItem:
    artifact_kind: str
    path_ref: str


@dataclass(frozen=True)
class LegacyArtifactInventoryReport:
    scan_complete: bool
    counts: dict[str, int]
    items: tuple[LegacyArtifactInventoryItem, ...]
    safe_error_codes: tuple[str, ...]


def classify_legacy_evidence(evidence: LegacyEvidence) -> tuple[LegacyDestination, str]:
    if evidence.rejected_evidence or evidence.deleted_evidence:
        return "ineligible_purge_obligation", "rejected_or_deleted_evidence"
    if evidence.local_only or evidence.conflicting or not evidence.exact_owner_provenance:
        return "legacy_quarantined", "missing_or_conflicting_provenance"
    if evidence.durable_user_review_receipt_ref or evidence.fresh_user_reapproval_ref:
        return "canonical_import_eligible", "authoritative_user_approval_evidence"
    if evidence.exact_pending_review and evidence.trustworthy_session_source:
        return "candidate_ledger_eligible", "exact_pending_source_evidence"
    return "legacy_quarantined", "provider_metadata_is_not_consent"


def _metadata_state(metadata: object) -> str:
    if not isinstance(metadata, dict):
        return "missing"
    status = metadata.get("status")
    if not isinstance(status, str) or not status.strip():
        return "statusless"
    normalized = status.strip().lower()
    return normalized if normalized in {"approved", "pending_review", "rejected", "discarded", "deleted"} else "unknown"


def inventory_legacy_subject(
    *,
    adapter: Mem0ProjectionAdapter,
    provider_subject: str,
    provider_project: str,
    environment: str,
    evidence_by_provider_id: dict[str, LegacyEvidence] | None = None,
    page_size: int = 100,
    max_pages: int = 100,
) -> LegacyInventoryReport:
    evidence_by_provider_id = evidence_by_provider_id or {}
    items: list[LegacyInventoryItem] = []
    page_count = 0
    try:
        for page in adapter._all_pages(
            provider_subject=provider_subject,
            page_size=page_size,
            max_pages=max_pages,
        ):
            page_count += 1
            for row in page:
                provider_id = row.get("id")
                if not isinstance(provider_id, str) or not provider_id:
                    continue
                destination, reason = classify_legacy_evidence(evidence_by_provider_id.get(provider_id, LegacyEvidence()))
                items.append(
                    LegacyInventoryItem(
                        provider_id_ref=keyed_ref("legacy-provider-id", provider_id),
                        metadata_state=_metadata_state(row.get("metadata")),
                        destination=destination,
                        reason=reason,
                    )
                )
    except Mem0ContractError as exc:
        counts = Counter(item.destination for item in items)
        return LegacyInventoryReport(
            provider="mem0",
            environment=environment,
            project_ref=keyed_ref("legacy-project", provider_project),
            namespace_ref=keyed_ref("legacy-namespace", provider_subject),
            pagination_complete=False,
            page_count=page_count,
            record_count=len(items),
            classification_counts=dict(counts),
            items=tuple(items),
            safe_error_code=exc.reason,
        )
    counts = Counter(item.destination for item in items)
    return LegacyInventoryReport(
        provider="mem0",
        environment=environment,
        project_ref=keyed_ref("legacy-project", provider_project),
        namespace_ref=keyed_ref("legacy-namespace", provider_subject),
        pagination_complete=True,
        page_count=page_count,
        record_count=len(items),
        classification_counts=dict(counts),
        items=tuple(items),
    )


def inventory_legacy_artifacts(
    roots: Iterable[tuple[str, Path]],
) -> LegacyArtifactInventoryReport:
    """Inventory sidecars/derived artifacts by kind and keyed path only."""

    items: list[LegacyArtifactInventoryItem] = []
    errors: list[str] = []
    for artifact_kind, root in roots:
        try:
            if not root.exists():
                continue
            paths = (root,) if root.is_file() else tuple(path for path in root.rglob("*") if path.is_file())
            for path in paths:
                items.append(
                    LegacyArtifactInventoryItem(
                        artifact_kind=artifact_kind,
                        path_ref=keyed_ref("legacy-artifact-path", str(path)),
                    )
                )
        except OSError as exc:
            errors.append(f"{artifact_kind}:{exc.__class__.__name__}")
    counts = Counter(item.artifact_kind for item in items)
    return LegacyArtifactInventoryReport(
        scan_complete=not errors,
        counts=dict(counts),
        items=tuple(items),
        safe_error_codes=tuple(errors),
    )
