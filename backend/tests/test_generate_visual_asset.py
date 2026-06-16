import json
from types import SimpleNamespace

from PIL import Image

from deerflow.sophia.tools.generate_visual_asset import (
    _est_width,
    _fit_text,
    _palette,
    _svg_for,
    _validate_png,
    _write_png_pillow,
    generate_visual_asset,
)


def _runtime(outputs_path):
    return SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs_path)}},
        context={},
        config={},
    )


def _payload(result: str) -> dict:
    return json.loads(result)


def test_generate_visual_asset_writes_svg_and_png_under_visuals(tmp_path) -> None:
    outputs = tmp_path / "outputs"

    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="bar_chart",
            title="Capability Comparison",
            data=[
                {"label": "HTML", "value": 9},
                {"label": "PDF", "value": 5},
                {"label": "PPTX", "value": 4},
            ],
            output_name="capability-comparison",
        )
    )

    assert payload["success"] is True
    assert payload["svg_path"] == "/mnt/user-data/outputs/visuals/capability-comparison.svg"
    assert payload["png_path"] == "/mnt/user-data/outputs/visuals/capability-comparison.png"
    svg_file = outputs / "visuals" / "capability-comparison.svg"
    png_file = outputs / "visuals" / "capability-comparison.png"
    assert svg_file.is_file()
    assert png_file.is_file()
    assert payload["svg_bytes"] > 100
    assert payload["png_bytes"] > 0
    assert payload["png_render_engine"] in {"cairosvg", "svglib", "pillow_svg_subset"}
    assert payload["png_validation_status"] == "ok"

    with Image.open(png_file) as image:
        image.load()
        assert image.size == (960, 540)
        extrema = image.convert("L").getextrema()
    assert extrema[0] != extrema[1]


def test_generate_visual_asset_rejects_invalid_dimensions(tmp_path) -> None:
    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(tmp_path / "outputs"),
            visual_type="timeline",
            title="Too large",
            data=["A", "B"],
            width=9999,
        )
    )

    assert payload["success"] is False
    assert payload["error_type"] == "invalid_dimensions"


def test_generate_visual_asset_rejects_unlabeled_chart_data(tmp_path) -> None:
    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(tmp_path / "outputs"),
            visual_type="bar_chart",
            title="No placeholders",
            data=[{"value": 42}, {"label": "Known"}],
            output_name="bad-chart",
        )
    )

    assert payload["success"] is False
    assert payload["error_type"] == "unlabeled_chart_data"
    assert "placeholder" in payload["hint"]


def test_bar_chart_dedupes_dimensions_wraps_labels_and_drops_zero_bars(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    long_label = "Operational resilience and human escalation readiness"

    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="bar_chart",
            title="Capability profile",
            data=[
                {"label": long_label, "series": "Baseline", "value": 4},
                {"label": long_label, "series": "Sophia", "value": 5},
                {"label": "Memory continuity", "series": "Baseline", "value": 0},
                {"label": "Memory continuity", "series": "Sophia", "value": 7},
                {"label": "Zero only", "series": "Baseline", "value": 0},
            ],
            output_name="capability-profile",
        )
    )

    assert payload["success"] is True
    svg = (outputs / "visuals" / "capability-profile.svg").read_text(encoding="utf-8")
    assert long_label in svg
    assert svg.count(long_label) == 1
    assert svg.count("Memory continuity") == 1
    assert "Zero only" not in svg
    assert ">0<" not in svg


# --- VQ-1: text-fit engine ----------------------------------------------------


def test_fit_text_short_text_passes_through_unchanged() -> None:
    fitted = _fit_text("Roadmap", 400, 14, 2)

    assert fitted.lines == ["Roadmap"]
    assert fitted.font_px == 14
    assert fitted.ellipsized is False


def test_fit_text_wraps_on_word_boundaries() -> None:
    text = "deliberate expansion across resilient segments"
    fitted = _fit_text(text, 180, 14, 4)

    assert len(fitted.lines) > 1
    assert fitted.ellipsized is False
    assert " ".join(fitted.lines) == text
    for line in fitted.lines:
        assert _est_width(line, fitted.font_px) <= 180


def test_fit_text_steps_font_down_before_ellipsizing() -> None:
    text = "strategic capability assessment covering operational resilience"
    fitted = _fit_text(text, 150, 14, 3)

    assert fitted.font_px < 14
    assert fitted.font_px in {12, 11}
    assert len(fitted.lines) <= 3


def test_fit_text_ellipsizes_when_shrinking_is_not_enough() -> None:
    text = " ".join(f"segment{i}" for i in range(40))
    fitted = _fit_text(text, 120, 14, 2)

    assert fitted.ellipsized is True
    assert fitted.font_px == 11
    assert len(fitted.lines) == 2
    assert fitted.lines[-1].endswith("…")
    for line in fitted.lines:
        assert _est_width(line, fitted.font_px) <= 120


def test_fit_text_hard_splits_overlong_single_words() -> None:
    fitted = _fit_text("a" * 90, 120, 14, 8)

    assert len(fitted.lines) > 1
    for line in fitted.lines:
        assert _est_width(line, fitted.font_px) <= 120


# --- VQ-7: duplicate variety guard ---------------------------------------------


def test_duplicate_visual_guard_rejects_identical_second_call(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    kwargs = dict(
        runtime=_runtime(outputs),
        visual_type="bar_chart",
        title="Quarterly revenue",
        data=[{"label": "Q1", "value": 4}, {"label": "Q2", "value": 6}],
        output_name="quarterly-revenue",
    )

    first = _payload(generate_visual_asset.func(**kwargs))
    second = _payload(generate_visual_asset.func(**kwargs))

    assert first["success"] is True
    assert second["success"] is False
    assert second["error_type"] == "duplicate_visual"
    assert second["existing_path"] == first["svg_path"]
    assert "reuse the existing asset" in second["hint"]


def test_duplicate_guard_allows_same_kind_with_different_data(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    first = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="bar_chart",
            title="Quarterly revenue",
            data=[{"label": "Q1", "value": 4}],
            output_name="rev-a",
        )
    )
    second = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="bar_chart",
            title="Quarterly revenue",
            data=[{"label": "Q1", "value": 9}],
            output_name="rev-b",
        )
    )

    assert first["success"] is True
    assert second["success"] is True


def test_duplicate_guard_survives_corrupt_registry(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    registry = outputs / "visuals" / ".registry.json"
    registry.parent.mkdir(parents=True, exist_ok=True)
    registry.write_text("{not-json", encoding="utf-8")

    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="timeline",
            title="Plan",
            data=["Kickoff", "Build", "Ship"],
            output_name="plan",
        )
    )

    assert payload["success"] is True


# --- VQ-2: schema additions ----------------------------------------------------


def test_comparison_matrix_rows_schema_renders_real_grid(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="comparison_matrix",
            title="Plan comparison",
            rows=[
                {"label": "SSO support", "Starter": False, "Pro": True},
                {"label": "Seats", "Starter": 5, "Pro": "Unlimited"},
            ],
            output_name="plan-comparison",
        )
    )

    assert payload["success"] is True
    svg = (outputs / "visuals" / "plan-comparison.svg").read_text(encoding="utf-8")
    assert "✓" in svg
    assert "–" in svg
    assert 'fill="#14b8a6"' in svg  # accent header band
    assert svg.count("<line ") >= 4  # grid lines


def test_architecture_edges_schema_draws_orthogonal_arrows(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="architecture_diagram",
            title="Service topology",
            data=["Gateway", "Queue", "Worker"],
            edges=[
                {"from": "Gateway", "to": "Queue", "label": "publish"},
                {"from": "Queue", "to": "Worker"},
            ],
            output_name="service-topology",
        )
    )

    assert payload["success"] is True
    svg = (outputs / "visuals" / "service-topology.svg").read_text(encoding="utf-8")
    assert "<polyline " in svg
    assert "<polygon " in svg  # arrow heads
    assert "publish" in svg


def test_process_flow_groups_schema_renders_lanes(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="process_flow",
            title="Delivery lanes",
            groups=[
                {"label": "Design", "items": ["Research", "Wireframe"]},
                {"label": "Build", "items": ["Implement", "Review", "Ship"]},
            ],
            output_name="delivery-lanes",
        )
    )

    assert payload["success"] is True
    svg = (outputs / "visuals" / "delivery-lanes.svg").read_text(encoding="utf-8")
    assert svg.count("<polygon ") >= 5  # chevrons
    assert "Design" in svg and "Build" in svg


def test_backward_compat_old_payloads_render_for_every_kind(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    kinds = [
        "bar_chart",
        "line_chart",
        "pie_chart",
        "donut_chart",
        "timeline",
        "process_flow",
        "architecture_diagram",
        "comparison_matrix",
        "quadrant",
        "concept_map",
    ]
    for kind in kinds:
        payload = _payload(
            generate_visual_asset.func(
                runtime=_runtime(outputs),
                visual_type=kind,
                title=f"Legacy payload {kind}",
                data=[{"label": "Alpha", "value": 3}, {"label": "Beta", "value": 5}, {"label": "Gamma", "value": 4}],
                output_name=f"legacy-{kind}",
            )
        )
        assert payload["success"] is True, (kind, payload)
        assert payload["png_validation_status"] == "ok", kind


# --- VQ-1: pillow fallback renders wrapped tspans -------------------------------


def test_pillow_renderer_walks_wrapped_tspans(tmp_path) -> None:
    long_label = "deliberate expansion across resilient operating segments now"
    svg = _svg_for(
        "timeline",
        "A deliberately long visual title that must wrap onto a second line",
        [f"{long_label} {i}" for i in range(8)],
        _palette(None),
        960,
        540,
    )
    assert "<tspan" in svg

    png = tmp_path / "wrapped.png"
    success, error = _write_png_pillow(svg, png, 960, 540)

    assert success is True, error
    assert _validate_png(png, 960, 540) == "ok"
