from __future__ import annotations

from deerflow.sophia.deck_build.html_sanitizer import assemble_compact_slide_html, validate_and_sanitize_slide_html
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


def test_allows_inert_utf8_charset_meta() -> None:
    html = """<!doctype html><html><head><meta charset="utf-8"><style>
html, body { width: 1920px; height: 1080px; background: #fff; }
</style></head><body><main><h1>Title</h1></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert "meta-directive" not in result.unsupported_tags


def test_rejects_active_or_content_meta_directives() -> None:
    directives = (
        '<meta http-equiv="refresh" content="0; url=https://example.com/secret">',
        '<meta http-equiv="refresh" content="0; url=file:///etc/passwd">',
        '<meta name="viewport" content="width=device-width">',
        '<meta charset="utf-8" http-equiv="refresh" content="0; url=https://example.com">',
    )
    for directive in directives:
        html = f"""<!doctype html><html><head>{directive}<style>
html, body {{ width: 1920px; height: 1080px; background: #fff; }}
</style></head><body><main><h1>Title</h1></main></body></html>"""

        _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

        assert result.valid is False
        assert "meta-directive" in result.unsupported_tags
        assert any("meta directives are forbidden" in error for error in result.errors)


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


def test_rejects_duplicate_url_attributes_and_validates_every_value() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #fff; }
</style></head><body><main><img src="https://example.com/a.png" src="../assets/slide-01.png"></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(
        _slide(html),
        allowed_asset_refs={"slide-01.png"},
    )

    assert result.valid is False
    assert result.image_refs == ["https://example.com/a.png", "../assets/slide-01.png"]
    assert "duplicate URL attribute src is forbidden" in result.errors
    assert any("remote http" in error for error in result.errors)
    assert any("unplanned image asset reference" in error for error in result.errors)


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


def test_compact_background_uses_author_css_after_harness_rule() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet="main { background: #101828; text-transform: uppercase; }",
        html_body='<h1 data-deck-id="title" data-deck-role="title">Title</h1>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert "transform" not in result.unsupported_css


def test_compact_background_accepts_slide_root_and_rejects_unresolved_or_transparent_winner() -> None:
    valid_html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background-color: #101828; }",
        html_body="<h1>Title</h1>",
    )
    _sanitized, valid = validate_and_sanitize_slide_html(_slide(valid_html), allowed_asset_refs=set())
    assert valid.valid is True

    for stylesheet in (
        ".slide-root { background: var(--missing); }",
        ".slide-root { background: #101828; } .slide-root { background: transparent; }",
        ".slide-root { background: rgba(10, 20, 30, .5); }",
    ):
        html = assemble_compact_slide_html(deck_stylesheet=stylesheet, html_body="<h1>Title</h1>")
        _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())
        assert result.valid is False
        assert "slide background must be opaque" in result.errors


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


def test_rejects_css_image_set_subresources_before_rendering() -> None:
    for function_name, source in (
        ("image-set", '"https://example.com/hero.png" 1x'),
        ("image-set", '"file:///etc/passwd" 1x'),
        ("-webkit-image-set", '"../assets/slide-01.png" 1x'),
    ):
        html = f"""<!doctype html><html><head><style>
html, body {{ width: 1920px; height: 1080px; background: #0A0E14; }}
.canvas {{ width: 1920px; height: 1080px; background-image: {function_name}({source}); }}
</style></head><body><main class="canvas"><h1>Title</h1></main></body></html>"""

        _sanitized, result = validate_and_sanitize_slide_html(
            _slide(html),
            allowed_asset_refs={"slide-01.png"},
        )

        assert result.valid is False
        assert any("CSS image-set(...)" in error for error in result.errors)


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
