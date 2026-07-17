from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from deerflow.sophia.build_manifest import DECK_STYLE_ROOT_SELECTOR
from deerflow.sophia.build_runtime.identity import component_id, new_version_id
from deerflow.sophia.build_versions import BuildComponentVersion


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _write_immutable(path: Path, content: bytes) -> None:
    if path.exists():
        if path.read_bytes() != content:
            raise RuntimeError(f"immutable build source already exists with different content: {path.name}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


@dataclass(frozen=True, slots=True)
class MaterializedDeckSources:
    root: Path
    stylesheet_path: Path
    stylesheet_version: BuildComponentVersion
    versions: tuple[BuildComponentVersion, ...]
    total_source_bytes: int


def materialize_compact_deck_sources(
    *,
    build_id: str,
    root: Path,
    deck_stylesheet: str,
    slides: list[Any],
    assembly_contract: str = "compact_model_html_v1",
    harness_version: str = "sophia-deck-harness/v1",
) -> MaterializedDeckSources:
    build_root = root / ".builder" / "builds" / build_id
    stylesheet_path = build_root / "sources" / "deck.css"
    stylesheet_bytes = deck_stylesheet.encode("utf-8")
    stylesheet_hash = sha256_bytes(stylesheet_bytes)
    _write_immutable(stylesheet_path, stylesheet_bytes)
    stylesheet_component_id = component_id(build_id, DECK_STYLE_ROOT_SELECTOR)
    stylesheet_version_id = new_version_id("component_version")
    stylesheet_source_version_id = new_version_id("source_version")
    stylesheet_version_path = (
        build_root
        / "components"
        / stylesheet_component_id
        / "versions"
        / stylesheet_version_id
        / "deck.css"
    )
    _write_immutable(stylesheet_version_path, stylesheet_bytes)
    stylesheet_version = BuildComponentVersion(
        version_id=stylesheet_version_id,
        component_id=stylesheet_component_id,
        selector=DECK_STYLE_ROOT_SELECTOR,
        source_version_id=stylesheet_source_version_id,
        source_paths=[str(stylesheet_version_path)],
        source_hashes={"deck_css": stylesheet_hash},
        source_roles={"deck_css": str(stylesheet_version_path)},
        resolved_output_hash=stylesheet_hash,
        authored_by="fresh",
    )
    versions: list[BuildComponentVersion] = []
    total = len(stylesheet_bytes)
    for slide_number, slide in enumerate(slides, start=1):
        selector = str(slide.selector)
        cid = component_id(build_id, selector)
        version_id = new_version_id("component_version")
        source_version_id = new_version_id("source_version")
        version_root = build_root / "components" / cid / "versions" / version_id
        body = str(slide.html_body or "").encode("utf-8")
        css = str(slide.slide_css or "").encode("utf-8")
        notes = str(slide.speaker_notes or "").encode("utf-8")
        assembled = str(slide.html_source or "").encode("utf-8")
        paths = {
            "body": version_root / "body.html",
            "slide_css": version_root / "slide.css",
            "notes": version_root / "notes.txt",
            "assembled": version_root / "assembled.html",
        }
        payloads = {"body": body, "slide_css": css, "notes": notes, "assembled": assembled}
        for key, path in paths.items():
            _write_immutable(path, payloads[key])
        source_aliases = {
            build_root / "sources" / "slides" / f"{slide_number:02d}.body.html": body,
            build_root / "sources" / "slides" / f"{slide_number:02d}.slide.css": css,
            build_root / "sources" / "slides" / f"{slide_number:02d}.notes.txt": notes,
        }
        for path, payload in source_aliases.items():
            _write_immutable(path, payload)
        metadata = {
            "assembly_contract": assembly_contract,
            "harness_version": harness_version,
            "stylesheet_hash": stylesheet_hash,
            "source_hashes": {key: sha256_bytes(value) for key, value in payloads.items()},
        }
        _write_immutable(version_root / "assembly.json", json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode())
        total += sum(len(value) for value in payloads.values())
        versions.append(
            BuildComponentVersion(
                version_id=version_id,
                component_id=cid,
                selector=selector,
                source_version_id=source_version_id,
                source_paths=[str(path) for path in paths.values()],
                source_hashes={"deck.css": stylesheet_hash, **metadata["source_hashes"]},
                source_roles={key: str(path) for key, path in paths.items()},
                resolved_output_hash=sha256_bytes(assembled),
                authored_by="fresh",
            )
        )
    return MaterializedDeckSources(
        root=build_root,
        stylesheet_path=stylesheet_path,
        stylesheet_version=stylesheet_version,
        versions=tuple(versions),
        total_source_bytes=total,
    )
