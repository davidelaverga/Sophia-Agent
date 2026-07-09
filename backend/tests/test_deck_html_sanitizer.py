from __future__ import annotations

from deerflow.sophia.deck_build.html_sanitizer import validate_and_sanitize_slide_html
from deerflow.sophia.deck_build.models import DeckSlideSpec


def _slide(html: str) -> DeckSlideSpec:
    return DeckSlideSpec(
        selector="slide:1",
        index=1,
        role="cover",
        layout_kind="cover_hero",
        title="System Story",
        narrative="Concise point.",
        html_source=html,
    )


def test_valid_html_is_sanitized_and_preserves_planned_asset_ref() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #0A0E14; }
.canvas { width: 1920px; height: 1080px; background: #0A0E14; box-shadow: 0 0 12px #000; }
</style></head><body><main class="canvas"><h1>Title</h1><img src="../assets/slide-01.png"></main></body></html>"""

    sanitized, result = validate_and_sanitize_slide_html(
        _slide(html),
        allowed_asset_refs={"slide-01.png"},
    )

    assert result.valid is True
    assert result.sanitized is True
    assert result.image_refs == ["../assets/slide-01.png"]
    assert "box-shadow" not in sanitized


def test_rejects_active_and_external_html() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #fff; }
</style></head><body onclick="x()"><script>alert(1)</script><img src="https://example.com/x.png"></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("forbidden tag <script>" in error for error in result.errors)
    assert any("inline event handler" in error for error in result.errors)
    assert any("remote http" in error for error in result.errors)


def test_rejects_missing_fixed_canvas() -> None:
    html = "<html><body><main><h1>Title</h1></main></body></html>"

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert "slide canvas must be 1920x1080px" in result.errors
    assert "slide canvas must declare an opaque background" in result.errors
