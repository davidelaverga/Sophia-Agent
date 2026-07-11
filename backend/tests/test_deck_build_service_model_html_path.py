from __future__ import annotations

import re
from pathlib import Path

from test_deck_build_service import _creative_plan, _fake_batch, _FakeNativeService, _runtime, _slides

from deerflow.sophia.deck_build.service import DeckBuildService

_OUTPUTS = "/mnt/user-data/outputs/"


def test_prepare_deck_build_requires_creative_plan(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(native_service=_FakeNativeService())

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
    )

    assert result.success is False
    assert result.retryable is True
    assert result.failure_code == "deck_creative_plan_required"
    assert result.pptx_path is None
    assert result.repair_instruction is not None


def test_prepare_deck_build_requires_slide_html_source(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    slides = _slides()
    slides[1].pop("html_source")
    service = DeckBuildService(native_service=_FakeNativeService())

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is False
    assert result.retryable is True
    assert result.failure_code == "deck_slide_html_missing"
    assert result.pptx_path is None


def test_prepare_deck_build_writes_model_authored_html_not_template(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
    )

    assert result.success is True
    html = (tmp_path / "outputs" / "slides" / "02-architecture.html").read_text(encoding="utf-8")
    assert 'class="diagram"' in html
    assert "system-diagram" not in html
    assert result.deck_route == "deck_creative_html_native"
    assert result.html_source_validation["valid"] is True


def test_prepare_deck_build_requires_declared_assets_in_slide_html(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=_slides(include_asset=False),
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(include_asset=True),
    )

    assert result.success is False
    assert result.retryable is True
    assert result.failure_code == "deck_slide_html_invalid"
    assert result.expected_visual_count == 1
    assert result.referenced_visual_count == 0
    assert result.pptx_path is None


def _compact_sources() -> tuple[str, list[dict]]:
    slides = _slides()
    style_match = re.search(r"<style>(.*?)</style>", slides[0]["html_source"], re.S)
    assert style_match is not None
    for slide in slides:
        body_match = re.search(r"<body>(.*?)</body>", slide.pop("html_source"), re.S)
        assert body_match is not None
        slide["html_body"] = body_match.group(1)
    return style_match.group(1), slides


def test_prepare_deck_build_assembles_compact_model_html(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path / "outputs")
    stylesheet, slides = _compact_sources()
    service = DeckBuildService(
        image_batch_runner=_fake_batch(runtime),
        native_service=_FakeNativeService(),
    )

    result = service.prepare_and_build(
        runtime=runtime,
        deck_title="Technical Deck",
        slides=slides,
        output_path=f"{_OUTPUTS}deck.pptx",
        creative_plan=_creative_plan(),
        deck_stylesheet=stylesheet,
    )

    assert result.success is True
    assert result.deck_authoring_contract == "compact_model_html_v1"
    assert result.deck_html_fragment_count == 3
    assert result.deck_assembled_html_bytes > 0
    assert result.deck_stylesheet_hash is not None
    html = (tmp_path / "outputs" / "slides" / "02-architecture.html").read_text(encoding="utf-8")
    assert html.startswith("<!doctype html>")
    assert 'class="slide-root"' in html
    assert 'class="diagram"' in html
