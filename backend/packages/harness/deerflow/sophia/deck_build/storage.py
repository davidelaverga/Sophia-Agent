from __future__ import annotations

import json
from dataclasses import fields
from pathlib import Path
from typing import Any

from deerflow.sandbox.tools import get_thread_data, replace_virtual_path
from deerflow.sophia.deck_build.models import DeckBuild, DeckSlideSpec

_DECK_BUILD_VIRTUAL_PATH = "/mnt/user-data/outputs/deck_build/build.json"


def _thread_data(runtime_or_thread_data: Any) -> dict[str, Any] | None:
    if isinstance(runtime_or_thread_data, dict):
        return runtime_or_thread_data
    return get_thread_data(runtime_or_thread_data)


def _host_path(virtual_path: str, runtime_or_thread_data: Any) -> Path:
    return Path(replace_virtual_path(virtual_path, _thread_data(runtime_or_thread_data)))


def save_deck_build(deck_build: DeckBuild, runtime_or_thread_data: Any) -> str:
    host_path = _host_path(_DECK_BUILD_VIRTUAL_PATH, runtime_or_thread_data)
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(json.dumps(deck_build.to_dict(), indent=2), encoding="utf-8")
    return _DECK_BUILD_VIRTUAL_PATH


def load_deck_build(build_id_or_path: str, runtime_or_thread_data: Any) -> DeckBuild | None:
    virtual_path = build_id_or_path if build_id_or_path.startswith("/mnt/user-data/") else _DECK_BUILD_VIRTUAL_PATH
    host_path = _host_path(virtual_path, runtime_or_thread_data)
    if not host_path.is_file():
        return None
    try:
        payload = json.loads(host_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return _deck_build_from_payload(payload)


def update_deck_build(deck_build: DeckBuild, **patch: Any) -> DeckBuild:
    for key, value in patch.items():
        if hasattr(deck_build, key):
            setattr(deck_build, key, value)
    return deck_build


def _deck_build_from_payload(payload: object) -> DeckBuild | None:
    if not isinstance(payload, dict):
        return None
    slide_fields = {field.name for field in fields(DeckSlideSpec)}
    deck_fields = {field.name for field in fields(DeckBuild)}
    slides: list[DeckSlideSpec] = []
    for raw_slide in payload.get("slides") or []:
        if isinstance(raw_slide, dict):
            slides.append(DeckSlideSpec(**{key: value for key, value in raw_slide.items() if key in slide_fields}))
    deck_payload = {key: value for key, value in payload.items() if key in deck_fields and key != "slides"}
    deck_payload["slides"] = slides
    try:
        return DeckBuild(**deck_payload)
    except TypeError:
        return None
