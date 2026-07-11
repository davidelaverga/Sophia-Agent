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


def test_lossy_css_is_rejected_even_when_sanitized_and_asset_ref_is_preserved() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #0A0E14; }
.canvas { width: 1920px; height: 1080px; background: #0A0E14; box-shadow: 0 0 12px #000; }
</style></head><body><main class="canvas"><h1>Title</h1><img src="../assets/slide-01.png"></main></body></html>"""

    sanitized, result = validate_and_sanitize_slide_html(
        _slide(html),
        allowed_asset_refs={"slide-01.png"},
    )

    assert result.valid is False
    assert result.sanitized is True
    assert result.image_refs == ["../assets/slide-01.png"]
    assert "lossy_native_deck_css: box-shadow" in result.errors
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


def test_rejects_remote_srcset_with_planned_local_src() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #fff; }
</style></head><body><main><img src="../assets/slide-01.png" srcset="../assets/slide-01.png 1x, https://example.com/slide.png 2x"></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(
        _slide(html),
        allowed_asset_refs={"slide-01.png"},
    )

    assert result.valid is False
    assert result.image_refs == ["../assets/slide-01.png"]
    assert any("srcset subresources are forbidden" in error for error in result.errors)


def test_rejects_legacy_non_image_subresource_attributes() -> None:
    for name, value in (
        ("background", "../assets/../../uploads/secret.png"),
        ("background", "../assets/slide-01.png"),
        ("poster", "../assets/slide-01.png"),
        ("data", "../assets/slide-01.png"),
    ):
        html = f"""<!doctype html><html><head><style>
html, body {{ width: 1920px; height: 1080px; background: #fff; }}
</style></head><body {name}="{value}"><main><h1>Title</h1></main></body></html>"""

        _sanitized, result = validate_and_sanitize_slide_html(
            _slide(html),
            allowed_asset_refs={"slide-01.png"},
        )

        assert result.valid is False
        assert any(f"{name} subresource attributes are forbidden" in error for error in result.errors)


def test_rejects_remote_and_file_svg_xlink_subresources() -> None:
    for uri, expected_error in (
        ("https://example.com/visual.svg", "remote http"),
        ("file:///etc/passwd", "file URIs"),
    ):
        html = f"""<!doctype html><html><head><style>
html, body {{ width: 1920px; height: 1080px; background: #fff; }}
</style></head><body><main><svg><image xlink:href="{uri}" /></svg></main></body></html>"""

        _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

        assert result.valid is False
        assert any(expected_error in error for error in result.errors)


def test_rejects_missing_fixed_canvas() -> None:
    html = "<html><body><main><h1>Title</h1></main></body></html>"

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert "slide canvas must be 1920x1080px" in result.errors
    assert "slide canvas must declare an opaque background" in result.errors


def test_rejects_duplicate_semantic_source_ids() -> None:
    html = """<!doctype html><html><head><style>
    html, body { width: 1920px; height: 1080px; background: #fff; }
    </style></head><body><main>
    <h1 data-deck-id="title" data-deck-role="title" data-deck-required="true">One</h1>
    <p data-deck-id="title" data-deck-role="narrative">Two</p>
    </main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert "duplicate data-deck-id: title" in result.errors


def test_canvas_size_uses_slide_canvas_not_first_child_width() -> None:
    html = """<!doctype html><html><head><style>
.badge { width: 80px; height: 28px; background: #38BDF8; }
html, body { width: 1920px; height: 1080px; background: #0A0E14; }
.canvas { width: 1920px; height: 1080px; background: #0A0E14; }
</style></head><body><main class="canvas"><span class="badge">A</span><h1>Title</h1></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert result.canvas_width_px == 1920
    assert result.canvas_height_px == 1080


def test_background_uses_canvas_not_transparent_child_component() -> None:
    html = """<!doctype html><html><head><style>
.badge { background: transparent; }
html, body { width: 1920px; height: 1080px; background: #FFFFFF; }
.canvas { width: 1920px; height: 1080px; }
</style></head><body><main class="canvas"><span class="badge">A</span><h1>Title</h1></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True


def test_rejects_css_subresource_urls_before_rendering() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #0A0E14; }
.canvas { width: 1920px; height: 1080px; background-image: url(https://example.com/bg.png); }
</style></head><body><main class="canvas"><h1>Title</h1></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("CSS url(...)" in error for error in result.errors)


def test_rejects_quoted_css_subresource_urls_with_spaces() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #0A0E14; }
.canvas { width: 1920px; height: 1080px; background-image: url("https://example.com/hero image.png"); }
</style></head><body><main class="canvas"><h1>Title</h1></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("CSS url(...)" in error for error in result.errors)


def test_accepts_direct_planned_asset_reference() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #0A0E14; }
</style></head><body><main><img src="../assets/slide-01.png"></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(
        _slide(html),
        allowed_asset_refs={"slide-01.png"},
    )

    assert result.valid is True


def test_rejects_traversal_in_planned_asset_reference() -> None:
    for ref in (
        "../assets/../../uploads/slide-01.png",
        "../assets/%2e%2e%2fuploads%2fslide-01.png",
        "..\\assets\\..\\..\\uploads\\slide-01.png",
        "http://[malformed",
    ):
        html = f"""<!doctype html><html><head><style>
html, body {{ width: 1920px; height: 1080px; background: #0A0E14; }}
</style></head><body><main><img src="{ref}"></main></body></html>"""

        _sanitized, result = validate_and_sanitize_slide_html(
            _slide(html),
            allowed_asset_refs={"slide-01.png"},
        )

        assert result.valid is False
        assert any("unplanned image asset reference" in error for error in result.errors)
