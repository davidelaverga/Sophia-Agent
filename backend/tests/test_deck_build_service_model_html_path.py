from __future__ import annotations

from pathlib import Path

from deerflow.sophia.deck_build.service import DeckBuildService
from test_deck_build_service import _FakeNativeService, _creative_plan, _fake_batch, _runtime, _slides

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
