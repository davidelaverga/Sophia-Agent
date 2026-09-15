"""Owner-bound current-state inventory; never runtime admission or a clear receipt."""

from __future__ import annotations

import base64
import hmac
import json
import re
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .models import StrictModel
from .owner_authority import resolve_owner_authority
from .refs import keyed_ref
from .store import MemoryGovernanceConflict, MemoryGovernanceUnavailable

InventoryView = Literal["all", "saved", "active", "forgotten", "pending_review"]
_KEY = re.compile(r"^(candidate|memory):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


class InventoryRecord(StrictModel):
    kind: Literal["candidate", "memory"]
    id: UUID
    revision: int = Field(gt=0, strict=True)
    state: Literal["pending_review", "approved", "rejected", "expired", "legacy_quarantined", "active", "forgotten", "tombstoned"]
    reviewable: bool = Field(strict=True)
    session_id: str | None
    extraction_run_id: UUID | None
    source_manifest_ref: str | None
    content: str | None
    category: str | None
    memory_governance_revision: int | None = Field(gt=0, strict=True)
    user_tier: Literal["conscious", "subconscious", "none"] | None
    scope: str | None
    created_at: str
    updated_at: str | None
    content_disposition: Literal["current_review_text", "current_canonical_text", "withheld_not_reviewable", "withheld_tombstoned"]

    @model_validator(mode="after")
    def validate_content_authority(self):
        if self.kind == "candidate":
            if self.state not in {"pending_review", "approved", "rejected", "expired", "legacy_quarantined"} or not self.session_id or not self.extraction_run_id or not self.source_manifest_ref:
                raise ValueError("inventory_candidate_scope_invalid")
            expected = "current_review_text" if self.reviewable else "withheld_not_reviewable"
            if self.memory_governance_revision is not None or self.user_tier is not None or self.scope is not None:
                raise ValueError("inventory_candidate_shape_invalid")
            if self.reviewable and self.state != "pending_review":
                raise ValueError("inventory_candidate_state_invalid")
        else:
            if self.state not in {"active", "forgotten", "tombstoned"} or self.reviewable or self.memory_governance_revision is None or self.user_tier is None:
                raise ValueError("inventory_memory_state_invalid")
            if self.session_id is not None or self.extraction_run_id is not None or self.source_manifest_ref is not None:
                raise ValueError("inventory_memory_scope_invalid")
            expected = "withheld_tombstoned" if self.state == "tombstoned" else "current_canonical_text"
        if self.content_disposition != expected:
            raise ValueError("inventory_disposition_invalid")
        if expected.startswith("withheld"):
            if self.content is not None or self.category is not None or self.scope is not None:
                raise ValueError("inventory_withheld_content_present")
        elif not self.content or not self.category or (self.kind == "memory" and not self.scope):
            raise ValueError("inventory_current_content_missing")
        return self


class InventorySummary(StrictModel):
    canonical_records: int = Field(ge=0, strict=True)
    candidate_records: int = Field(ge=0, strict=True)
    reviewable_pending: int = Field(ge=0, strict=True)
    withheld_candidates: int = Field(ge=0, strict=True)
    unavailable_review_sources: int = Field(ge=0, strict=True)
    unfinished_extraction_runs: int = Field(ge=0, strict=True)


class InventoryEnvelope(StrictModel):
    schema_name: Literal["mem00.inventory.v1"] = Field(alias="schema")
    memory_contract_epoch: Literal[1]
    owner_id: str
    scope: Literal["current_saved_and_candidate_state"]
    view: InventoryView
    status: Literal["available"]
    snapshot_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    after_key: str | None
    summary: InventorySummary
    total_count: int = Field(ge=0, strict=True)
    records: tuple[InventoryRecord, ...]
    next_after_key: str | None
    enumeration_complete: bool = Field(strict=True)
    historical_versions_included: Literal[False]
    source_transcripts_included: Literal[False]
    provider_state_queried: Literal[False]
    extraction_complete: Literal[False]
    next_cursor: str | None = None


def _signature(owner: str, view: str, snapshot: str, after: str) -> str:
    return keyed_ref("inventory-cursor", json.dumps([owner, view, snapshot, after], separators=(",", ":")))


def encode_inventory_cursor(owner: str, view: str, snapshot: str, after: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps([snapshot, after], separators=(",", ":")).encode()).decode().rstrip("=")
    return payload + "." + _signature(owner, view, snapshot, after)


def decode_inventory_cursor(owner: str, view: str, cursor: str | None) -> tuple[str | None, str | None]:
    if cursor is None:
        return None, None
    try:
        if len(cursor) > 512:
            raise ValueError
        payload, signature = cursor.split(".", 1)
        snapshot, after = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if not isinstance(snapshot, str) or not re.fullmatch(r"[a-f0-9]{32}", snapshot) or not isinstance(after, str) or not _KEY.fullmatch(after):
            raise ValueError
        if not hmac.compare_digest(signature, _signature(owner, view, snapshot, after)):
            raise ValueError
        return snapshot, after
    except Exception:
        raise MemoryGovernanceConflict("memory_inventory_cursor_invalid") from None


def read_inventory(*, owner_id: str, governance_store, view: InventoryView = "all", cursor: str | None = None, page_size: int = 100) -> InventoryEnvelope:
    if type(page_size) is not int or not 1 <= page_size <= 200 or view not in {"all", "saved", "active", "forgotten", "pending_review"}:
        raise ValueError("memory_inventory_request_invalid")
    if resolve_owner_authority(owner_id, store=governance_store).authority_state != "governed":
        raise MemoryGovernanceUnavailable("memory_inventory_owner_unavailable")
    snapshot, after = decode_inventory_cursor(owner_id, view, cursor)
    raw = governance_store.inventory_snapshot({"p_user_id": owner_id, "p_view": view, "p_snapshot_id": snapshot,
        "p_after_key": after, "p_page_size": page_size})
    if raw.get("owner_id") != owner_id or raw.get("view") != view:
        raise MemoryGovernanceUnavailable("memory_inventory_scope_invalid")
    if raw.get("status") == "snapshot_changed":
        raise MemoryGovernanceConflict("memory_inventory_snapshot_changed")
    try:
        if type(raw.get("memory_contract_epoch")) is not int or any(raw.get(name) is not False for name in
            ("historical_versions_included", "source_transcripts_included", "provider_state_queried", "extraction_complete")) or raw.get("next_cursor") is not None:
            raise ValueError
        if len(json.dumps(raw).encode()) > 2 * 1024 * 1024:
            raise ValueError
        result = InventoryEnvelope.model_validate(raw)
        if (result.owner_id, result.view, result.after_key) != (owner_id, view, after) or (snapshot is not None and snapshot != result.snapshot_id):
            raise ValueError
        keys = [f"{item.kind}:{item.id}" for item in result.records]
        if len(keys) > page_size or len(set(keys)) != len(keys) or keys != sorted(keys) or any(after is not None and key <= after for key in keys):
            raise ValueError
        if result.total_count < len(keys) or result.enumeration_complete != (result.next_after_key is None):
            raise ValueError
        if not result.enumeration_complete and (not keys or result.next_after_key != keys[-1] or len(keys) != page_size):
            raise ValueError
        if after is None and result.enumeration_complete and len(keys) != result.total_count:
            raise ValueError
        s = result.summary
        if s.reviewable_pending + s.withheld_candidates != s.candidate_records:
            raise ValueError
        if view == "all" and result.total_count != s.canonical_records + s.candidate_records:
            raise ValueError
        if view == "pending_review" and (result.total_count != s.reviewable_pending or any(not r.reviewable or r.kind != "candidate" for r in result.records)):
            raise ValueError
        if view in {"active", "forgotten"} and any(r.kind != "memory" or r.state != view for r in result.records):
            raise ValueError
        if view == "saved" and any(r.kind != "memory" or r.state not in {"active", "forgotten"} for r in result.records):
            raise ValueError
        if result.next_after_key is not None:
            result.next_cursor = encode_inventory_cursor(owner_id, view, result.snapshot_id, result.next_after_key)
        return result
    except Exception:
        raise MemoryGovernanceUnavailable("memory_inventory_unavailable") from None


def read_complete_inventory(*, owner_id: str, governance_store, view: InventoryView) -> InventoryEnvelope:
    """All-or-nothing bounded enumeration, never a successfully truncated Pool."""
    cursor = None
    first = None
    records = []
    seen_keys, seen_cursors = set(), set()
    previous_key = None
    size = 0
    for _ in range(250):
        page = read_inventory(owner_id=owner_id, governance_store=governance_store, view=view, cursor=cursor, page_size=200)
        size += len(page.model_dump_json().encode())
        if size > 8 * 1024 * 1024 or page.after_key != previous_key:
            raise MemoryGovernanceUnavailable("memory_inventory_enumeration_incomplete")
        if first is not None and (page.snapshot_id != first.snapshot_id or page.summary != first.summary or page.total_count != first.total_count):
            raise MemoryGovernanceUnavailable("memory_inventory_snapshot_changed")
        first = first or page
        for item in page.records:
            key = f"{item.kind}:{item.id}"
            if key in seen_keys:
                raise MemoryGovernanceUnavailable("memory_inventory_page_repeated")
            seen_keys.add(key)
            records.append(item)
        if len(records) > page.total_count or len(records) > 50000:
            raise MemoryGovernanceUnavailable("memory_inventory_enumeration_incomplete")
        if page.enumeration_complete:
            if len(records) != first.total_count:
                raise MemoryGovernanceUnavailable("memory_inventory_enumeration_incomplete")
            return first.model_copy(update={"records": tuple(records), "enumeration_complete": True,
                "next_after_key": None, "next_cursor": None})
        cursor = page.next_cursor
        if not cursor or cursor in seen_cursors:
            raise MemoryGovernanceUnavailable("memory_inventory_cursor_repeated")
        seen_cursors.add(cursor)
        previous_key = page.next_after_key
    raise MemoryGovernanceUnavailable("memory_inventory_enumeration_incomplete")
