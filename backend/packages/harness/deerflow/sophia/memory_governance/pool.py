"""Complete canonical management view; neither provider state nor model admission."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .inventory import read_complete_inventory
from .models import StrictModel
from .store import MemoryGovernanceUnavailable


class PoolMetadata(StrictModel):
    authority: Literal["sophia_canonical"] = "sophia_canonical"
    lifecycle: Literal["active", "forgotten"]
    tier: Literal["conscious", "subconscious", "none"]
    scope: str = Field(min_length=1)
    projection_state: Literal["unavailable"] = "unavailable"
    content_revision: int = Field(gt=0, strict=True)
    memory_governance_revision: int = Field(gt=0, strict=True)


class PoolEntry(StrictModel):
    id: UUID
    content: str = Field(min_length=1)
    category: str = Field(min_length=1)
    metadata: PoolMetadata
    created_at: str


class PoolFilters(StrictModel):
    category: str | None
    search: str | None


class PoolEnvelope(StrictModel):
    schema_name: Literal["mem00.pool.v1"] = Field(default="mem00.pool.v1", alias="schema")
    memory_contract_epoch: Literal[1] = 1
    authority: Literal["sophia_canonical"] = "sophia_canonical"
    owner_id: str = Field(min_length=1)
    view: Literal["active", "forgotten"]
    status: Literal["available"] = "available"
    snapshot_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    snapshot_count: int = Field(ge=0, le=50000, strict=True)
    filters: PoolFilters
    entries: tuple[PoolEntry, ...] = Field(max_length=50000)
    count: int = Field(ge=0, le=50000, strict=True)
    enumeration_complete: Literal[True] = True
    next_cursor: None = None
    projection_status: Literal["unavailable"] = "unavailable"
    provider_state_queried: Literal[False] = False

    @model_validator(mode="after")
    def validate_complete_view(self):
        ids = [item.id for item in self.entries]
        if len(set(ids)) != len(ids) or self.count != len(ids) or self.count > self.snapshot_count:
            raise ValueError("pool_enumeration_incomplete")
        if not self.filters.category and not self.filters.search and self.count != self.snapshot_count:
            raise ValueError("pool_enumeration_incomplete")
        if any(item.metadata.lifecycle != self.view
            or (self.filters.category and item.category != self.filters.category)
            or (self.filters.search and self.filters.search not in item.content.lower()) for item in self.entries):
            raise ValueError("pool_view_mismatch")
        return self


def read_pool(*, owner_id: str, store, view: str, category: str | None = None, search: str | None = None) -> PoolEnvelope:
    if view not in {"active", "forgotten"}:
        raise MemoryGovernanceUnavailable("pool_view_unavailable")
    snapshot = read_complete_inventory(owner_id=owner_id, governance_store=store, view=view)
    normalized_search = search.strip().lower() if search and search.strip() else None
    entries = tuple(PoolEntry(id=item.id, content=item.content, category=item.category, created_at=item.created_at,
        metadata=PoolMetadata(lifecycle=item.state, tier=item.user_tier, scope=item.scope,
            content_revision=item.revision, memory_governance_revision=item.memory_governance_revision))
        for item in snapshot.records
        if (not category or item.category == category) and (not normalized_search or normalized_search in item.content.lower()))
    return PoolEnvelope(owner_id=owner_id, view=view, snapshot_id=snapshot.snapshot_id, snapshot_count=snapshot.total_count,
        filters=PoolFilters(category=category or None, search=normalized_search), entries=entries, count=len(entries))
