from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
    _write_immutable(stylesheet_path, stylesheet_bytes)
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
            "stylesheet_hash": sha256_bytes(stylesheet_bytes),
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
                source_hashes={"deck.css": sha256_bytes(stylesheet_bytes), **metadata["source_hashes"]},
                resolved_output_hash=sha256_bytes(assembled),
                authored_by="fresh",
            )
        )
    return MaterializedDeckSources(build_root, stylesheet_path, tuple(versions), total)
