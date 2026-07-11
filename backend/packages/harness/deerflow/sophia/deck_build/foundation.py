from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from deerflow.config import get_app_config
from deerflow.config.build_foundation_config import BuildFoundationConfig
from deerflow.sandbox.tools import get_thread_data, replace_virtual_path
from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload
from deerflow.sophia.build_manifest import BuildComponent, BuildManifest
from deerflow.sophia.build_runtime.identity import new_version_id
from deerflow.sophia.build_sources import materialize_compact_deck_sources
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.build_foundation_store import configured_build_foundation_store

logger = logging.getLogger(__name__)


class BuildFoundationPersistenceError(RuntimeError):
    pass


def _outputs_root(runtime: Any) -> Path:
    return Path(replace_virtual_path("/mnt/user-data/outputs", get_thread_data(runtime)))


def _logical_artifact_id(user_id: str, build_id: str) -> str:
    digest = hashlib.sha256(f"{user_id}\x1f{build_id}".encode()).hexdigest()[:24]
    return f"artifact_{digest}"


def _write_immutable_json(path: Path, payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    if path.exists() and path.read_bytes() != encoded:
        raise BuildFoundationPersistenceError("immutable manifest revision already exists with different content")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest()


def materialize_deck_foundation(deck: Any, runtime: Any) -> None:
    config = _foundation_config(runtime)
    if not config.enabled or config.manifest_mode == "off":
        return
    user_id = str(deck.user_id or "").strip()
    if config.manifest_mode == "enforce" and not user_id:
        raise BuildFoundationPersistenceError("enforce-mode build requires user_id")
    user_id = user_id or "shadow-unknown-user"
    root = _outputs_root(runtime)
    source_versions = _materialize_source_versions(deck, root)
    components = _manifest_components(deck, source_versions)
    artifact_version_id = new_version_id("artifact_version")
    logical_artifact_id = _logical_artifact_id(user_id, deck.build_id)
    object_root = _foundation_object_root(user_id=user_id, thread_id=deck.thread_id, build_id=deck.build_id)
    artifact_filename = Path(str(deck.pptx_path or "presentation.pptx")).name
    artifact_object_path = f"{object_root}/artifacts/{artifact_version_id}/{artifact_filename}"
    manifest = _build_manifest(
        deck=deck,
        runtime=runtime,
        user_id=user_id,
        logical_artifact_id=logical_artifact_id,
        artifact_version_id=artifact_version_id,
        artifact_object_path=artifact_object_path,
        components=components,
    )
    relative = Path(".builder") / "builds" / deck.build_id / "manifest" / "manifest-r1.json"
    manifest_path = root / relative
    manifest_hash = _write_immutable_json(manifest_path, manifest.model_dump(mode="json"))
    deck.manifest_path = f"/mnt/user-data/outputs/{relative.as_posix()}"
    deck.manifest_revision = 1
    deck.manifest_hash = manifest_hash
    deck.logical_artifact_id = logical_artifact_id
    deck.current_artifact_version_id = artifact_version_id
    deck.foundation_status = "shadow_written"
    if config.manifest_mode == "enforce":
        _enforce_manifest(
            deck=deck,
            runtime=runtime,
            root=root,
            manifest=manifest,
            manifest_hash=manifest_hash,
            object_root=object_root,
            artifact_object_path=artifact_object_path,
        )


def _materialize_source_versions(deck: Any, root: Path) -> tuple[Any, ...]:
    if deck.deck_authoring_contract != "compact_model_html_v1" or not deck.deck_stylesheet:
        return ()
    materialized = materialize_compact_deck_sources(
        build_id=deck.build_id,
        root=root,
        deck_stylesheet=deck.deck_stylesheet,
        slides=deck.slides,
    )
    deck.source_bundle_path = f"/mnt/user-data/outputs/.builder/builds/{deck.build_id}/sources"
    deck.foundation_source_bytes = materialized.total_source_bytes
    return materialized.versions


def _manifest_components(deck: Any, source_versions: tuple[Any, ...]) -> list[BuildComponent]:
    versions_by_selector = {version.selector: version for version in source_versions}
    return [
        _manifest_component(deck, slide, versions_by_selector[slide.selector])
        for slide in deck.slides
        if slide.selector in versions_by_selector
    ]


def _manifest_component(deck: Any, slide: Any, version: Any) -> BuildComponent:
    return BuildComponent(
        id=version.component_id,
        selector=slide.selector,
        type="slide",
        index=slide.index,
        source_path=version.source_paths[0],
        asset_paths=[str(slide.visual_asset_path)] if slide.visual_asset_path else [],
        status="gated",
        gate_results={
            "mechanical_passed": bool(deck.mechanical_gate_results.get("passed")),
            "source_retention_passed": bool(deck.source_retention_report.get("passed", True)),
        },
        current_version_id=version.version_id,
        provenance={"authored_by": "fresh", "source_version_id": version.source_version_id},
    )


def _build_manifest(
    *,
    deck: Any,
    runtime: Any,
    user_id: str,
    logical_artifact_id: str,
    artifact_version_id: str,
    artifact_object_path: str,
    components: list[BuildComponent],
) -> BuildManifest:
    return BuildManifest(
        manifest_revision=1,
        build_id=deck.build_id,
        user_id=user_id,
        thread_id=deck.thread_id,
        format="pptx",
        status="complete",
        logical_artifact_id=logical_artifact_id,
        current_artifact_version_id=artifact_version_id,
        deliverable_path=deck.pptx_path,
        components=components,
        format_extensions={
            "deck": {
                "schema_version": "sophia-deck-extension/v1",
                "deck_build_path": "/mnt/user-data/outputs/deck_build/build.json",
                "source_bundle_path": deck.source_bundle_path,
                "authoring_contract": deck.deck_authoring_contract,
                "assembly_contract": "sophia-deck-harness/v1",
                "current_pptx_hash": _artifact_hash(deck.pptx_path, runtime),
                "artifact_storage_object_path": artifact_object_path,
            }
        },
    )


def _enforce_manifest(
    *,
    deck: Any,
    runtime: Any,
    root: Path,
    manifest: BuildManifest,
    manifest_hash: str,
    object_root: str,
    artifact_object_path: str,
) -> None:
    manifest_object_path = f"{object_root}/manifest/manifest-r1.json"
    _upload_enforced_objects(
        build_root=root / ".builder" / "builds" / deck.build_id,
        object_root=object_root,
        artifact_virtual_path=deck.pptx_path,
        artifact_object_path=artifact_object_path,
        runtime=runtime,
    )
    acceptance = _acceptance_payload(deck, manifest, artifact_object_path)
    committed_revision = _commit_manifest(runtime, manifest, manifest_object_path, manifest_hash, acceptance)
    if int(committed_revision) != 1:
        raise BuildFoundationPersistenceError("manifest CAS returned an unexpected revision")
    deck.foundation_status = "enforced"


def _acceptance_payload(deck: Any, manifest: BuildManifest, object_path: str) -> ArtifactAcceptedPayload:
    return ArtifactAcceptedPayload(
        build_id=deck.build_id,
        logical_artifact_id=str(manifest.logical_artifact_id),
        artifact_version_id=str(manifest.current_artifact_version_id),
        manifest_revision=1,
        artifact_type="pptx",
        artifact_path=str(deck.pptx_path),
        storage_object_path=object_path,
        origin="fresh",
    )


def _commit_manifest(
    runtime: Any,
    manifest: BuildManifest,
    manifest_path: str,
    manifest_hash: str,
    acceptance: ArtifactAcceptedPayload,
) -> int:
    context = runtime.context if isinstance(getattr(runtime, "context", None), dict) else {}
    commit = context.get("build_foundation_commit")
    if callable(commit):
        return int(commit(manifest=manifest, manifest_path=manifest_path, manifest_hash=manifest_hash, acceptance=acceptance))
    store = configured_build_foundation_store()
    if store is None:
        raise BuildFoundationPersistenceError("enforce-mode manifest CAS adapter is unavailable")
    return store.commit_manifest(
        manifest=manifest,
        manifest_path=manifest_path,
        manifest_hash=manifest_hash,
        acceptance=acceptance,
    )


def _foundation_object_root(*, user_id: str, thread_id: str, build_id: str) -> str:
    return supabase_artifact_store.normalize_object_path(
        "artifacts/"
        f"{supabase_artifact_store.safe_object_path_segment(user_id, default='user')}/"
        f"{supabase_artifact_store.safe_object_path_segment(thread_id, default='thread')}/"
        "foundation/.builder/builds/"
        f"{supabase_artifact_store.safe_object_path_segment(build_id, default='build')}"
    )


def _upload_enforced_objects(
    *,
    build_root: Path,
    object_root: str,
    artifact_virtual_path: str | None,
    artifact_object_path: str,
    runtime: Any,
) -> None:
    if not supabase_artifact_store.is_configured():
        raise BuildFoundationPersistenceError("durable object storage is unavailable")
    for host_path in build_root.rglob("*"):
        if not host_path.is_file():
            continue
        relative = host_path.relative_to(build_root).as_posix()
        object_path = f"{object_root}/{relative}"
        uploaded = supabase_artifact_store.upload_artifact_object(object_path, host_path.read_bytes())
        if uploaded != object_path or not supabase_artifact_store.check_artifact_object_exists(object_path):
            raise BuildFoundationPersistenceError("durable build object verification failed")
    if not artifact_virtual_path:
        raise BuildFoundationPersistenceError("verified artifact path is required")
    artifact_host = Path(replace_virtual_path(artifact_virtual_path, get_thread_data(runtime)))
    if not artifact_host.is_file():
        raise BuildFoundationPersistenceError("artifact file is missing before acceptance")
    uploaded = supabase_artifact_store.upload_artifact_object(
        artifact_object_path,
        artifact_host.read_bytes(),
        content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )
    if uploaded != artifact_object_path or not supabase_artifact_store.check_artifact_object_exists(artifact_object_path):
        raise BuildFoundationPersistenceError("artifact version upload verification failed")


def _artifact_hash(virtual_path: str | None, runtime: Any) -> str | None:
    if not virtual_path:
        return None
    host = Path(replace_virtual_path(virtual_path, get_thread_data(runtime)))
    if not host.is_file():
        return None
    digest = hashlib.sha256()
    with host.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def materialize_deck_foundation_safely(deck: Any, runtime: Any) -> None:
    config = _foundation_config(runtime)
    try:
        materialize_deck_foundation(deck, runtime)
    except Exception as exc:
        if config.manifest_mode == "enforce":
            raise
        deck.foundation_status = "shadow_failed"
        deck.foundation_warning = type(exc).__name__
        logger.warning(
            "[BuildFoundation] shadow materialization failed build_id=%s error_class=%s sourceContentExcluded=true",
            deck.build_id,
            type(exc).__name__,
        )


def _foundation_config(runtime: Any) -> BuildFoundationConfig:
    context = runtime.context if isinstance(getattr(runtime, "context", None), dict) else {}
    injected = context.get("build_foundation_config")
    if isinstance(injected, BuildFoundationConfig):
        return injected
    if isinstance(injected, dict):
        return BuildFoundationConfig.model_validate(injected)
    try:
        return get_app_config().build_foundation
    except Exception:
        # Direct service callers and isolated tests have no application config.
        # Production startup audits load and inject the real configuration.
        return BuildFoundationConfig(enabled=False, manifest_mode="off")
