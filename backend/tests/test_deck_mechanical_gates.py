from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from deerflow.sophia.deck_build.creative_plan import normalize_creative_plan
from deerflow.sophia.deck_build.image_assets import apply_creative_asset_plan
from deerflow.sophia.deck_build.mechanical_gates import evaluate_mechanical_gates
from deerflow.sophia.deck_build.models import DeckBuild
from deerflow.sophia.deck_build.service import DeckBuildService
from test_deck_build_service import _creative_plan, _runtime, _slides


def _built_deck(tmp_path, *, repeated: bool = False, old_marker: bool = False):
    runtime = _runtime(tmp_path / "outputs")
    service = DeckBuildService()
    slides = service._build_slide_specs(
        _slides(),
        visual_policy="auto",
        runtime=runtime,
        style_profile={},
    )
    loaded = DeckBuild(
        build_id="deck-test",
        schema_version="sophia-deck-build/v1",
        user_id="user",
        thread_id="thread",
        parent_thread_id=None,
        run_id=None,
        task_id=None,
        requested_slide_count=len(slides),
        status="compiled",
        register="professional_technical",
        visual_policy="auto",
        style_profile={},
        deck_title="Technical Deck",
        output_path="/mnt/user-data/outputs/deck.pptx",
        slides=slides,
        expected_visual_count=0,
    )
    creative_plan = normalize_creative_plan(_creative_plan(), deck=loaded, request_context="")
    loaded.creative_plan = creative_plan
    loaded.design_plan = creative_plan.design_plan
    apply_creative_asset_plan(loaded, creative_plan)
    if repeated:
        for slide in loaded.slides:
            if slide.composition_plan is not None:
                slide.composition_plan.layout_name = "same_layout"
    if old_marker:
        loaded.slides[0].html_source = (loaded.slides[0].html_source or "") + "<div class='system-diagram'></div>"
    return loaded


def _render_dir(tmp_path: Path, *, light: bool = False, blank: bool = False) -> Path:
    render_dir = tmp_path / "rendered"
    render_dir.mkdir()
    for index in range(1, 4):
        image = Image.new("RGB", (320, 180), "#FFFFFF" if light else "#0A0E14")
        if not blank:
            draw = ImageDraw.Draw(image)
            draw.rectangle((30, 30, 260, 140), outline="#38BDF8", width=8)
            draw.rectangle((60, 70, 120, 110), fill="#38BDF8")
        image.save(render_dir / f"slide-{index}.jpg")
    return render_dir


def test_mechanical_gates_pass_for_nonblank_dark_native_deck(tmp_path) -> None:
    deck = _built_deck(tmp_path)

    result = evaluate_mechanical_gates(deck, rendered_dir=_render_dir(tmp_path))

    assert result.passed is True


def test_mechanical_gates_fail_sparse_rendered_slide(tmp_path) -> None:
    deck = _built_deck(tmp_path)

    result = evaluate_mechanical_gates(deck, rendered_dir=_render_dir(tmp_path, blank=True))

    assert result.passed is False
    assert any(issue.code == "sparse_rendered_slide" for issue in result.issues)


def test_mechanical_gates_fail_repeated_skeleton_and_old_renderer_marker(tmp_path) -> None:
    deck = _built_deck(tmp_path, repeated=True, old_marker=True)

    result = evaluate_mechanical_gates(deck, rendered_dir=_render_dir(tmp_path))

    assert result.passed is False
    assert {issue.code for issue in result.issues} >= {"repeated_slide_skeleton", "old_renderer_artifact"}


def test_mechanical_gates_fail_dark_request_rendered_light(tmp_path) -> None:
    deck = _built_deck(tmp_path)

    result = evaluate_mechanical_gates(deck, rendered_dir=_render_dir(tmp_path, light=True))

    assert result.passed is False
    assert any(issue.code == "dark_request_rendered_light" for issue in result.issues)
