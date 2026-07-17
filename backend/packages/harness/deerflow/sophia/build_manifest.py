from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

DECK_STYLE_ROOT_SELECTOR = "deck-style:root"


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
    source_roles: dict[str, str] = Field(default_factory=dict)
    source_hashes: dict[str, str] = Field(default_factory=dict)
    shared_dependencies: list[str] = Field(default_factory=list)


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


def manifest_components_by_selector(manifest: BuildManifest) -> dict[str, BuildComponent]:
    """Return the manifest component index, rejecting ambiguous selectors."""

    indexed: dict[str, BuildComponent] = {}
    for component in manifest.components:
        if component.selector in indexed:
            raise ValueError(f"duplicate component selector: {component.selector}")
        indexed[component.selector] = component
    return indexed


def resolve_component_source_role(
    manifest: BuildManifest,
    *,
    selector: str,
    source_role: str,
) -> str:
    """Resolve one explicit source role, with a body fallback for legacy v1 slides."""

    components_by_selector = manifest_components_by_selector(manifest)
    component = components_by_selector.get(selector)
    if component is None:
        raise ValueError(f"unknown component selector: {selector}")
    role = source_role.strip()
    if not role:
        raise ValueError("source role must be non-empty")
    resolved = component.source_roles.get(role)
    if resolved:
        return resolved
    if not component.source_roles and component.type == "slide" and role == "body":
        return component.source_path
    raise ValueError(f"unknown source role {role!r} for component {selector}")


def component_dependency_closure(
    manifest: BuildManifest,
    changed_selectors: Iterable[str],
) -> tuple[str, ...]:
    """Resolve changed components plus every component that depends on them.

    The result follows manifest order so persisted repair programs and locality
    proofs can hash it deterministically. A slide-local change therefore stays
    local, while changing ``deck-style:root`` includes every slide that declares
    the shared stylesheet dependency.
    """

    components_by_selector = manifest_components_by_selector(manifest)
    requested = tuple(dict.fromkeys(str(selector).strip() for selector in changed_selectors))
    if not requested or any(not selector for selector in requested):
        raise ValueError("dependency closure requires at least one non-empty selector")
    unknown = sorted(set(requested) - components_by_selector.keys())
    if unknown:
        raise ValueError(f"unknown component selector: {', '.join(unknown)}")

    for component in manifest.components:
        missing = sorted(set(component.shared_dependencies) - components_by_selector.keys())
        if missing:
            raise ValueError(
                f"component {component.selector} has unknown shared dependencies: "
                f"{', '.join(missing)}"
            )

    closure = set(requested)
    while True:
        dependents = {
            component.selector
            for component in manifest.components
            if closure.intersection(component.shared_dependencies)
        }
        expanded = closure | dependents
        if expanded == closure:
            break
        closure = expanded
    return tuple(component.selector for component in manifest.components if component.selector in closure)


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
