from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class BuildComponent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    selector: str
    type: str
    index: int = Field(ge=0)
    source_path: str
    asset_paths: list[str] = Field(default_factory=list)
    status: Literal["pending", "authored", "gated", "failed", "superseded"]
    gate_results: dict[str, Any] = Field(default_factory=dict)
    current_version_id: str
    provenance: dict[str, Any] = Field(default_factory=dict)


class BuildManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["sophia-build-manifest/v1"] = "sophia-build-manifest/v1"
    manifest_revision: int = Field(ge=0)
    build_id: str
    user_id: str
    thread_id: str
    format: str
    status: Literal["building", "complete", "partial", "failed", "cancelled"]
    logical_artifact_id: str | None = None
    current_artifact_version_id: str | None = None
    deliverable_path: str | None = None
    components: list[BuildComponent] = Field(default_factory=list)
    format_extensions: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class BuildManifestConcurrentModification(RuntimeError):
    pass


class BuildManifestStore(Protocol):
    def create(self, manifest: BuildManifest, *, expected_absent: bool = True) -> BuildManifest: ...
    def load(self, *, build_id: str, user_id: str) -> BuildManifest: ...
    def save_cas(self, manifest: BuildManifest, *, expected_revision: int) -> BuildManifest: ...


class InMemoryBuildManifestStore:
    """Test/shadow store with lock-free semantics suitable for one test process."""

    def __init__(self) -> None:
        self._items: dict[tuple[str, str], BuildManifest] = {}

    def create(self, manifest: BuildManifest, *, expected_absent: bool = True) -> BuildManifest:
        key = (manifest.user_id, manifest.build_id)
        if expected_absent and key in self._items:
            raise BuildManifestConcurrentModification("manifest already exists")
        created = manifest.model_copy(update={"manifest_revision": 1, "updated_at": utc_now_iso()}, deep=True)
        self._items[key] = created
        return created.model_copy(deep=True)

    def load(self, *, build_id: str, user_id: str) -> BuildManifest:
        return self._items[(user_id, build_id)].model_copy(deep=True)

    def save_cas(self, manifest: BuildManifest, *, expected_revision: int) -> BuildManifest:
        key = (manifest.user_id, manifest.build_id)
        current = self._items.get(key)
        if current is None or current.manifest_revision != expected_revision:
            raise BuildManifestConcurrentModification("build_manifest_concurrent_modification")
        saved = manifest.model_copy(update={"manifest_revision": expected_revision + 1, "updated_at": utc_now_iso()}, deep=True)
        self._items[key] = saved
        return saved.model_copy(deep=True)
