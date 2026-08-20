from __future__ import annotations

from pathlib import Path

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _pptx_compile_ready,
    _pptx_slide_html_ready,
)


@pytest.fixture(autouse=True)
def _legacy_compile_latch_route(monkeypatch):
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "false")
    monkeypatch.setenv("SOPHIA_DECK_LEGACY_SCREENSHOT_DEBUG", "true")


def _write_slide_html(outputs_dir: Path, count: int, *, with_visuals: bool = False) -> None:
    slides_dir = outputs_dir / "slides"
    slides_dir.mkdir(parents=True)
    assets_dir = outputs_dir / "assets"
    if with_visuals:
        assets_dir.mkdir(parents=True)
    for index in range(1, count + 1):
        visual = ""
        if with_visuals:
            (assets_dir / f"{index:02d}.png").write_bytes(b"png")
            visual = f"<div class='visual'><img src='../assets/{index:02d}.png'></div>"
        (slides_dir / f"{index:02d}.html").write_text(
            f"<html><body>slide{visual}</body></html>",
            encoding="utf-8",
        )


def test_slide_html_deck_without_requested_count_is_compile_ready(tmp_path: Path) -> None:
    outputs_dir = tmp_path / "outputs"
    _write_slide_html(outputs_dir, 4, with_visuals=True)
    state = {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_pptx_diagnostics": {"image_generation_success_count": 4},
    }

    assert _pptx_slide_html_ready(state) is True
    assert _pptx_compile_ready(state) is True


def test_requested_count_still_bounds_slide_html_compile_ready(tmp_path: Path) -> None:
    outputs_dir = tmp_path / "outputs"
    _write_slide_html(outputs_dir, 2)
    state = {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_requested_slide_count": 3,
        "builder_pptx_diagnostics": {},
    }

    assert _pptx_slide_html_ready(state) is False
    assert _pptx_compile_ready(state) is False


def test_compile_not_ready_when_required_visuals_are_missing(tmp_path: Path) -> None:
    outputs_dir = tmp_path / "outputs"
    _write_slide_html(outputs_dir, 3)
    state = {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_requested_slide_count": 3,
        "delegation_context": {"task_type": "presentation"},
        "builder_pptx_diagnostics": {"image_generation_success_count": 0},
    }

    assert _pptx_slide_html_ready(state) is True
    assert _pptx_compile_ready(state) is False
    assert BuilderArtifactMiddleware()._pptx_compile_tool_choice_for_state(state) is None


def test_compile_ready_forces_build_deck_from_slides_tool_choice(tmp_path: Path) -> None:
    # Codex P2 (2026-06-29): once the slide HTML exists, the tool-choice hook must
    # FORCE build_deck_from_slides (not return None) so a run that skipped the
    # compile call can't fall through to the ceiling without a deck.
    outputs_dir = tmp_path / "outputs"
    _write_slide_html(outputs_dir, 3, with_visuals=True)
    state = {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_requested_slide_count": 3,
        "delegation_context": {"task_type": "presentation"},
        "builder_pptx_diagnostics": {"image_generation_success_count": 3},
    }

    choice = BuilderArtifactMiddleware()._pptx_compile_tool_choice_for_state(state)
    assert choice == {"type": "tool", "name": "build_deck_from_slides"}


def test_compile_ready_never_forces_legacy_tool_on_deck_service_route(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "true")
    outputs_dir = tmp_path / "outputs"
    _write_slide_html(outputs_dir, 3, with_visuals=True)
    state = {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_requested_slide_count": 3,
        "delegation_context": {"task_type": "presentation"},
        "builder_pptx_diagnostics": {"image_generation_success_count": 3},
    }

    assert BuilderArtifactMiddleware()._pptx_compile_tool_choice_for_state(state) is None


def test_compile_ready_force_suppressed_during_repair(tmp_path: Path) -> None:
    outputs_dir = tmp_path / "outputs"
    _write_slide_html(outputs_dir, 3)
    state = {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "builder_pptx_requested_slide_count": 3,
        "builder_pptx_compile_repair_pending": True,
        "builder_pptx_diagnostics": {},
    }

    assert BuilderArtifactMiddleware()._pptx_compile_tool_choice_for_state(state) is None
