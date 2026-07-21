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


def test_letter_spacing_is_stripped_without_spending_service_quality_repair() -> None:
    html = """<!doctype html><html><head><style>
html, body { width: 1920px; height: 1080px; background: #0A0E14; }
.canvas { width: 1920px; height: 1080px; background: #0A0E14; }
h1 { font-size: 72px; letter-spacing: -0.03em; --letter-spacing: 2px; content: "letter-spacing: 3px"; }
</style></head><body><main class="canvas"><h1 style="letter-spacing: 1px; font-size: 72px">Title</h1><p>Use letter-spacing: 4px; when documenting CSS.</p></main></body></html>"""

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert result.sanitized is True
    assert result.errors == []
    assert result.warnings.count("stripped_lossy_native_deck_css: letter-spacing") == 1
    assert "letter-spacing: -0.03em" not in sanitized
    assert 'style="letter-spacing: 1px' not in sanitized
    assert "font-size: 72px" in sanitized
    assert "--letter-spacing: 2px" in sanitized
    assert 'content: "letter-spacing: 3px"' in sanitized
    assert "Use letter-spacing: 4px; when documenting CSS." in sanitized


def test_encoded_letter_spacing_declaration_fails_closed() -> None:
    for encoded_declaration in (
        "letter-spacing&#58; 1px",
        "letter&#45;spacing: 1px",
    ):
        html = f"""<!doctype html><html><head><style>
html, body {{ width: 1920px; height: 1080px; background: #0A0E14; }}
.canvas {{ width: 1920px; height: 1080px; background: #0A0E14; }}
</style></head><body><main class="canvas"><h1 style="{encoded_declaration}; font-size: 72px">Title</h1></main></body></html>"""

        sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

        assert result.valid is False
        assert result.sanitized is False
        assert "lossy_native_deck_css: letter-spacing" in result.errors
        assert encoded_declaration in sanitized


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


def test_normalizes_incomplete_required_descendants_under_valid_required_ancestor() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body="""
<section data-deck-id='s1-eyecap' data-deck-role='header' data-deck-required='true'>
  <span class='tag'>PSI AGENT ARCHITECTURE</span>
  <h1 data-deck-id='s1-title' data-deck-required='true'>Motivation as Control Signal</h1>
</section>
<div data-deck-id='s1-why' data-deck-role='evidence' data-deck-required='true'>
  <h3 data-deck-required='true'>Why leaders should care</h3>
  <p data-deck-required='true'>Motives arbitrate action before irreversible execution.</p>
</div>
""",
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert result.sanitized is True
    assert result.warnings == [
        "inferred 1 missing required data-deck-role marker(s)",
        "removed 2 redundant nested data-deck-required marker(s)",
    ]
    assert sanitized.count("data-deck-required='true'") == 3
    assert "data-deck-id='s1-title'" in sanitized
    title = next(element for element in result.source_elements if element["source_id"] == "s1-title")
    assert title["source_required"] is True
    assert title["source_role"] == "title"


def test_infers_content_role_for_addressable_required_card() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<div class='card' data-deck-id='s3-help' data-deck-required='true'><h3>Helpfulness</h3><p>Comply quickly.</p></div>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert result.sanitized is True
    assert "data-deck-id='s3-help' data-deck-required='true' data-deck-role=\"content\"" in sanitized
    assert result.warnings == ["inferred 1 missing required data-deck-role marker(s)"]
    source = next(element for element in result.source_elements if element["source_id"] == "s3-help")
    assert source["source_required"] is True
    assert source["source_role"] == "content"


def test_infers_roles_from_unambiguous_tags_and_component_classes() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body="""
<h2 data-deck-id='heading' data-deck-required='true'>Heading</h2>
<p data-deck-id='summary' data-deck-required='true'>Summary</p>
<div class='node-box' data-deck-id='node' data-deck-required='true'>Node</div>
<div class='card' data-deck-id='card' data-deck-required='true'>Card</div>
<table data-deck-id='matrix' data-deck-required='true'><tr><td>Matrix</td></tr></table>
""",
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert result.sanitized is True
    assert result.warnings == ["inferred 5 missing required data-deck-role marker(s)"]
    roles = {element["source_id"]: element["source_role"] for element in result.source_elements if element["source_required"]}
    assert roles == {
        "heading": "title",
        "summary": "narrative",
        "node": "diagram",
        "card": "content",
        "matrix": "comparison",
    }
    assert sanitized.count('data-deck-role="') == 5


def test_required_table_covers_incomplete_markers_inside_explicit_cells() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=(
            "<table data-deck-id='comparison' data-deck-required='true'><tbody><tr><td>"
            "<p data-deck-required='true' "
            "style='font-size:24px;color:#F0F3FA;line-height:1.4'>"
            "Action selection</p></td></tr></tbody></table>"
        ),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert result.sanitized is True
    assert result.warnings == [
        "inferred 1 missing required data-deck-role marker(s)",
        "removed 1 redundant nested data-deck-required marker(s)",
    ]
    assert "data-deck-id='comparison' data-deck-required='true' data-deck-role=\"comparison\"" in sanitized
    assert sanitized.count("data-deck-required='true'") == 1
    comparison = next(element for element in result.source_elements if element["source_id"] == "comparison")
    assert comparison["source_role"] == "comparison"


def test_required_table_keeps_addressable_paragraph_independently_required() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=(
            "<table data-deck-id='comparison' data-deck-role='comparison' "
            "data-deck-required='true'><tr><td>"
            "<p data-deck-id='criterion' data-deck-required='true'>Action selection</p>"
            "</td></tr></table>"
        ),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True
    assert result.sanitized is True
    assert result.warnings == ["inferred 1 missing required data-deck-role marker(s)"]
    assert sanitized.count("data-deck-required='true'") == 2
    criterion = next(element for element in result.source_elements if element["source_id"] == "criterion")
    assert criterion["source_required"] is True
    assert criterion["source_role"] == "narrative"


def test_required_table_does_not_cover_discarded_non_text_descendants() -> None:
    for discarded in (
        "<img data-deck-required='true' src='../assets/x.png'>",
        "<div data-deck-required='true' style='background:#fff;width:20px;height:20px'></div>",
        "<p data-deck-required='true'><img src='../assets/x.png'></p>",
        "<p data-deck-required='true' style='display:none'>Must keep</p>",
        "<p data-deck-required='true' style='display:contents'>Must keep</p>",
        "<p data-deck-required='true' style='color:transparent'>Must keep</p>",
        "<p data-deck-required='true' style='font-size:0'>Must keep</p>",
        "<p data-deck-required='true' style='height:0;overflow:hidden'>Must keep</p>",
        "<p data-deck-required='true'>   </p>",
        "<p class='hidden' data-deck-required='true'>Must keep</p>",
        "<div><p data-deck-required='true'>Nested text</p></div>",
    ):
        html = assemble_compact_slide_html(
            deck_stylesheet=".slide-root { background: #101828; }",
            html_body=(
                "<table data-deck-id='comparison' data-deck-role='comparison' "
                "data-deck-required='true'><tr><td>"
                f"{discarded}</td></tr></table>"
            ),
        )

        sanitized, result = validate_and_sanitize_slide_html(
            _slide(html),
            allowed_asset_refs={"x.png"},
        )

        assert result.valid is False
        assert result.sanitized is False
        assert sanitized == html
        assert "data-deck-required=true requires data-deck-id" in result.errors
        assert "required element <unknown> requires data-deck-role" in result.errors


def test_does_not_infer_discarded_component_geometry_inside_required_table() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=(
            "<table data-deck-id='comparison' data-deck-role='comparison' "
            "data-deck-required='true'><tr><td>"
            "<div class='node-box' data-deck-id='nested-node' data-deck-required='true'>"
            "Flattened text, discarded node geometry</div></td></tr></table>"
        ),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert "required element nested-node requires data-deck-role" in result.errors


def test_does_not_infer_role_for_ambiguous_required_container() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<div class='card node-box' data-deck-id='ambiguous' data-deck-required='true'>Ambiguous</div>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert "required element ambiguous requires data-deck-role" in result.errors


def test_does_not_infer_role_for_generic_addressable_root_element() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<section data-deck-id='generic' data-deck-required='true'>Generic semantic container</section>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert "required element generic requires data-deck-role" in result.errors


def test_root_required_element_still_requires_its_own_id_and_role() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body="<h1 data-deck-required='true'>Motivation as Control Signal</h1>",
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert "data-deck-required=true requires data-deck-id" in result.errors
    assert "required element <unknown> requires data-deck-role" in result.errors


def test_nested_required_element_is_not_normalized_under_invalid_required_ancestor() -> None:
    for ancestor_attrs in (
        "data-deck-id='section' data-deck-role='' data-deck-required='true'",
        "data-deck-id='Invalid!' data-deck-role='evidence' data-deck-required='true'",
    ):
        html = assemble_compact_slide_html(
            deck_stylesheet=".slide-root { background: #101828; }",
            html_body=(f"<section {ancestor_attrs}><h1 data-deck-required='true'>Motivation as Control Signal</h1></section>"),
        )

        sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

        assert result.valid is False
        assert result.sanitized is False
        assert sanitized == html
        assert sanitized.count("data-deck-required='true'") == 2
        assert "data-deck-required=true requires data-deck-id" in result.errors
        assert "required element <unknown> requires data-deck-role" in result.errors


def test_does_not_use_unstable_text_container_as_required_coverage() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<p data-deck-id='intro' data-deck-role='body' data-deck-required='true'>Intro<div data-deck-required='true'>Detached block</div></p>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert "data-deck-required=true requires data-deck-id" in result.errors


def test_does_not_strip_required_marker_across_table_foster_parenting_context() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<table><div data-deck-id='cover' data-deck-role='content' data-deck-required='true'><tr><td><h3 data-deck-required='true'>Must keep</h3></td></tr></div></table>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert sanitized.count("data-deck-required='true'") == 2
    assert "data-deck-required=true requires data-deck-id" in result.errors


def test_does_not_strip_table_marker_after_implicit_or_malformed_structure() -> None:
    malformed_bodies = (
        ("<table data-deck-id='comparison' data-deck-role='comparison' data-deck-required='true'><tr><td>one<tr><p data-deck-required='true'>Must keep</p></tr></table>"),
        ("<table data-deck-id='comparison' data-deck-role='comparison' data-deck-required='true'><tr><td>one</tbody><p data-deck-required='true'>Must keep</p></table>"),
        ("<table data-deck-id='comparison' data-deck-role='comparison' data-deck-required='true'><tr><td>one<thead><p data-deck-required='true'>Must keep</p></thead></table>"),
        ("<table data-deck-id='comparison' data-deck-role='comparison' data-deck-required='true'><tr><td>one<tr/><p data-deck-required='true'>Must keep</p></table>"),
        ("<table data-deck-id='comparison' data-deck-role='comparison' data-deck-required='true'><tr><td>one<col><p data-deck-required='true'>Must keep</p></table>"),
        ("<table data-deck-id='comparison' data-deck-role='comparison' data-deck-required='true'><tr><td>outer<table><tr><td><p data-deck-required='true'>Must keep</p></td></tr></table></td></tr></table>"),
    )
    for html_body in malformed_bodies:
        html = assemble_compact_slide_html(
            deck_stylesheet=".slide-root { background: #101828; }",
            html_body=html_body,
        )

        sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

        assert result.valid is False
        assert result.sanitized is False
        assert sanitized == html
        assert sanitized.count("data-deck-required='true'") == 2
        assert "data-deck-required=true requires data-deck-id" in result.errors
        assert any("table structure must use explicit canonical" in error for error in result.errors)


def test_rejects_malformed_required_table_even_without_incomplete_markers() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<table data-deck-id='comparison' data-deck-role='comparison' data-deck-required='true'><tr/><td>Detached cell</td></table>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert any("table structure must use explicit canonical" in error for error in result.errors)


def test_does_not_strip_required_marker_across_implicit_list_item_close() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<ul><li><div data-deck-id='cover' data-deck-role='content' data-deck-required='true'>Cover<li><h3 data-deck-required='true'>Must keep</h3></ul>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert sanitized.count("data-deck-required='true'") == 2
    assert "data-deck-required=true requires data-deck-id" in result.errors


def test_does_not_strip_required_marker_after_mismatched_heading_close() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<h1><div data-deck-id='cover' data-deck-role='content' data-deck-required='true'>Cover</h2><h3 data-deck-required='true'>Must keep</h3>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert sanitized.count("data-deck-required='true'") == 2
    assert "data-deck-required=true requires data-deck-id" in result.errors


def test_rejects_duplicate_semantic_attributes_without_normalizing_them() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body=("<div data-deck-id='card' data-deck-required='true' data-deck-required='true'>Duplicate semantics</div>"),
    )

    sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert result.sanitized is False
    assert sanitized == html
    assert "duplicate semantic attribute data-deck-required is forbidden" in result.errors


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


def test_rejects_inline_offsets_without_effective_position() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; } .card { box-sizing: border-box; }",
        html_body="""
<div class="card" style="left:120px; top:470px; width:1680px; height:430px"
     data-deck-id="cover-body" data-deck-role="content">Body</div>
""",
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert (
        "ineffective_position_offset: data-deck-id cover-body uses left/top without a non-static position; "
        "add position:absolute or position:relative to that exact element or its matching class"
    ) in result.errors


def test_accepts_inline_offsets_with_matching_class_position() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } "
            ".card, .unused { position: absolute; box-sizing: border-box; }"
        ),
        html_body='<div class="card" style="left:120px; top:470px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True


def test_accepts_inline_offsets_with_inline_position() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body='<div style="position:relative; inset-inline-start:120px; top:470px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True


def test_inline_static_position_overrides_matching_class_for_offset_validation() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; } .card { position:absolute; }",
        html_body=(
            '<div class="card" style="position:static; left:120px" '
            'data-deck-id="body">Body</div>'
        ),
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: data-deck-id body uses left" in error for error in result.errors)


def test_unrelated_or_descendant_position_rule_does_not_license_inline_offsets() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } "
            ".other { position:absolute; } .wrapper .card { position:absolute; }"
        ),
        html_body='<div class="card" style="left:120px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_later_matching_descendant_rule_can_reset_position_to_static() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } "
            ".card { position:absolute; } .wrapper .card { position:static; }"
        ),
        html_body='<section class="wrapper"><div class="card" style="left:120px">Body</div></section>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_pseudo_class_static_override_cannot_be_ruled_out_by_argument_classes() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } "
            ".card { position:absolute; } .card:not(.disabled) { position:static; }"
        ),
        html_body='<div class="card" style="left:120px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_conditional_negated_feature_static_override_is_conservative() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } .card { position:absolute; } "
            "@media not (min-width:3000px) { .card { position:static; } }"
        ),
        html_body='<div class="card" style="left:120px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_negated_screen_query_with_feature_can_apply_after_whole_query_negation() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } .card { position:absolute; } "
            "@media not screen and (min-width:3000px) { .card { position:static; } }"
        ),
        html_body='<div class="card" style="left:120px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_complex_rules_cannot_make_known_non_static_position_inert() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } .card { position:absolute; } "
            ".wrapper .card { position:relative; }"
        ),
        html_body=(
            '<section class="wrapper"><div class="card" style="left:120px">'
            "Body</div></section>"
        ),
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True


def test_only_screen_position_rule_is_unconditional_for_screen_canvas() -> None:
    html = """<!doctype html><html><head>
<style media="only screen">.card { position:absolute; }</style>
<style>html, body { width:1920px; height:1080px; background:#101828; }</style>
</head><body><main><div class="card" style="left:120px">Body</div></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True


def test_css_all_reset_invalidates_a_previous_position_rule() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=(
            ".slide-root { background: #101828; } "
            ".card { position:absolute; } .card { all:initial; }"
        ),
        html_body='<div class="card" style="left:120px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_inline_all_reset_invalidates_a_previous_inline_position() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; }",
        html_body='<div style="position:absolute; all:initial; left:120px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: <div> uses left" in error for error in result.errors)


def test_print_only_position_rule_does_not_license_screen_offsets() -> None:
    html = """<!doctype html><html><head>
<style media="print">.card { position:absolute; }</style>
<style>html, body { width:1920px; height:1080px; background:#101828; }</style>
</head><body><main><div class="card" style="left:120px">Body</div></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_later_harness_style_position_reset_is_not_ignored() -> None:
    html = """<!doctype html><html><head>
<style>html, body { width:1920px; height:1080px; background:#101828; } .card { position:absolute; }</style>
<style data-deck-harness="true">.card { position:static; }</style>
</head><body><main><div class="card" style="left:120px">Body</div></main></body></html>"""

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: class card uses left" in error for error in result.errors)


def test_complex_attribute_selector_is_not_accepted_as_position_proof() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background:#101828; } [data-x] { position:absolute; }",
        html_body='<div data-x="true" style="left:120px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is False
    assert any("ineffective_position_offset: <div> uses left" in error for error in result.errors)


def test_logical_inset_without_physical_offset_is_outside_narrow_position_contract() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background:#101828; }",
        html_body='<div style="inset-inline-start:120px; width:400px">Body</div>',
    )

    _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

    assert result.valid is True


def test_position_offset_validation_ignores_auto_or_absent_offsets() -> None:
    html = assemble_compact_slide_html(
        deck_stylesheet=".slide-root { background: #101828; } .card { box-sizing:border-box; }",
        html_body='<div class="card" style="left:auto; width:400px">Body</div>',
    )

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


def test_rejects_escaped_css_subresource_identifiers_before_rendering() -> None:
    for stylesheet, expected in (
        (r".canvas { background-image: u\72l(https://example.com/bg.png); }", "CSS url(...)"),
        (r'.canvas { background-image: image\2d set("https://example.com/bg.png" 1x); }', "CSS image-set(...)"),
        (r'@\69mport "https://example.com/deck.css";', "CSS @import"),
    ):
        html = f"""<!doctype html><html><head><style>
html, body {{ width: 1920px; height: 1080px; background: #0A0E14; }}
{stylesheet}
</style></head><body><main class="canvas"><h1>Title</h1></main></body></html>"""

        _sanitized, result = validate_and_sanitize_slide_html(_slide(html), allowed_asset_refs=set())

        assert result.valid is False
        assert any(expected in error for error in result.errors)


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
