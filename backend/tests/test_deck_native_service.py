from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageFont
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

from deerflow.sophia.deck_native import DeckNativeService, native_mechanical_report
from deerflow.sophia.deck_native import service as native_service_module


def test_deck_native_preflight_reports_missing_scripts(tmp_path: Path) -> None:
    service = DeckNativeService(scripts_dir=tmp_path / "missing-scripts")

    result = service.preflight()

    assert result.success is False
    assert result.scripts_dir_exists is False
    assert result.deck_py_exists is False
    assert result.html2patch_py_exists is False
    assert "deck.py" in "\n".join(result.errors)


def test_deck_native_subprocess_honors_expired_parent_deadline(
    tmp_path: Path,
    monkeypatch,
) -> None:
    script = tmp_path / "deck.py"
    script.write_text("raise SystemExit(0)\n", encoding="utf-8")
    service = DeckNativeService(scripts_dir=tmp_path)
    service.set_deadline_epoch_ms(1_000)
    monkeypatch.setattr(native_service_module.time, "time", lambda: 2.0)

    result = service._run(["python", str(script)])

    assert result.returncode == 124
    assert "deck deadline exceeded" in result.stderr


def test_deck_native_subprocess_timeout_uses_process_group_runner(
    tmp_path: Path,
    monkeypatch,
) -> None:
    script = tmp_path / "deck.py"
    script.write_text("raise SystemExit(0)\n", encoding="utf-8")
    captured: dict = {}

    def _timeout(command, *, timeout, cwd, writable_files, writable_dirs):
        captured.update(
            command=command,
            timeout=timeout,
            cwd=cwd,
            writable_files=writable_files,
            writable_dirs=writable_dirs,
        )
        raise subprocess.TimeoutExpired(command, timeout, output="partial", stderr="hung child")

    monkeypatch.setattr(native_service_module, "run_process_group", _timeout)

    result = DeckNativeService(scripts_dir=tmp_path)._run(["python", str(script)], timeout=30)

    assert captured == {
        "command": ["python", str(script)],
        "timeout": 30,
        "cwd": tmp_path,
        "writable_files": (),
        "writable_dirs": (),
    }
    assert result.returncode == 124
    assert result.stdout == "partial"
    assert "hands-on-deck subprocess timed out after 30s" in result.stderr
    assert "hung child" in result.stderr


def test_deck_native_default_subprocess_timeout_supports_long_decks(
    tmp_path: Path,
    monkeypatch,
) -> None:
    script = tmp_path / "deck.py"
    script.write_text("raise SystemExit(0)\n", encoding="utf-8")
    captured: dict = {}

    def _complete(command, *, timeout, cwd, writable_files, writable_dirs):
        captured.update(
            command=command,
            timeout=timeout,
            cwd=cwd,
            writable_files=writable_files,
            writable_dirs=writable_dirs,
        )
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(native_service_module, "run_process_group", _complete)

    result = DeckNativeService(scripts_dir=tmp_path)._run(["python", str(script)])

    assert result.returncode == 0
    assert captured["timeout"] == 600


def test_deck_native_render_clears_stale_images_before_counting_success(
    tmp_path: Path,
    monkeypatch,
) -> None:
    pptx = tmp_path / "deck.pptx"
    pptx.touch()
    render_dir = tmp_path / "rendered"
    render_dir.mkdir()
    stale_render = render_dir / "slide-1.jpg"
    stale_render.write_bytes(b"stale")
    service = DeckNativeService(scripts_dir=tmp_path)
    monkeypatch.setattr(
        service,
        "_run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, stdout="", stderr=""),
    )

    result = service.render(pptx_path=str(pptx), output_dir=str(render_dir))

    assert stale_render.exists() is False
    assert result.success is False
    assert result.rendered_slide_count == 0


def test_deck_native_render_requires_every_requested_slide(
    tmp_path: Path,
    monkeypatch,
) -> None:
    pptx = tmp_path / "deck.pptx"
    pptx.touch()
    render_dir = tmp_path / "rendered"
    service = DeckNativeService(scripts_dir=tmp_path)

    def _partial_render(*_args, **_kwargs):
        render_dir.mkdir(exist_ok=True)
        (render_dir / "slide-1.jpg").write_bytes(b"current")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(service, "_run", _partial_render)

    result = service.render(
        pptx_path=str(pptx),
        output_dir=str(render_dir),
        slides=[0, 1],
    )

    assert result.success is False
    assert result.rendered_slide_count == 1
    assert result.errors == ["native render incomplete: expected 2 slide image(s), rendered 1"]


def _wide_base_deck(path: Path) -> None:
    presentation = Presentation()
    presentation.slide_width = Inches(20)
    presentation.slide_height = Inches(11.25)
    path.parent.mkdir(parents=True, exist_ok=True)
    presentation.save(path)


def _native_text_patch(path: Path, *, text: str = "Hello Native") -> None:
    path.write_text(
        json.dumps(
            {
                "ops": [
                    {"op": "add-slide", "layout": "Blank"},
                    {
                        "op": "add-shape",
                        "slide": 0,
                        "kind": "textbox",
                        "at": [1, 1],
                        "size": [8, 0.8],
                        "text": [text],
                        "name": "title",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )


def test_deck_native_apply_inspect_render_and_diff(tmp_path: Path) -> None:
    if not shutil.which("soffice") or not shutil.which("pdftoppm"):
        pytest.skip("hands-on-deck render requires LibreOffice and Poppler")
    base = tmp_path / "base.pptx"
    patch = tmp_path / "patch.json"
    output = tmp_path / "out.pptx"
    render_dir = tmp_path / "rendered"
    _wide_base_deck(base)
    _native_text_patch(patch)
    service = DeckNativeService()

    applied = service.apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output), fix=True)
    inspected = service.inspect(str(output))
    rendered = service.render(pptx_path=str(output), output_dir=str(render_dir), slides=[0])
    diff = service.diff(before_path=str(base), after_path=str(output))

    assert applied.success is True
    assert output.is_file()
    assert inspected.success is True
    assert inspected.native_text_shape_count > 0
    assert inspected.full_slide_picture_count == 0
    assert inspected.native_editability_score >= 0.60
    assert Path(inspected.raw_json_path or "").parent == output.parent / ".builder" / "deck_native" / "inspect"
    assert Path(inspected.shape_inventory_path or "").parent == output.parent / ".builder" / "deck_native" / "inspect"
    assert not output.with_name("out.inspect.json").exists()
    assert not output.with_name("out.shape-inventory.json").exists()
    assert rendered.success is True
    assert rendered.rendered_slide_count == 1
    assert diff["success"] is True
    assert diff["changed"] is True


def test_deck_native_invalid_patch_fails_atomically(tmp_path: Path) -> None:
    base = tmp_path / "base.pptx"
    patch = tmp_path / "invalid.patch.json"
    output = tmp_path / "should-not-exist.pptx"
    _wide_base_deck(base)
    patch.write_text(
        json.dumps({"ops": [{"op": "add-shape", "slide": 99, "kind": "textbox", "at": [1, 1], "size": [1, 1], "text": ["bad"]}]}),
        encoding="utf-8",
    )

    result = DeckNativeService().apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output))

    assert result.success is False
    assert result.validation_error_count >= 1
    assert not output.exists()


def test_deck_native_lint_fix_reports_residue(tmp_path: Path) -> None:
    base = tmp_path / "base.pptx"
    patch = tmp_path / "covered-text.patch.json"
    output = tmp_path / "covered-text.pptx"
    image = tmp_path / "cover.png"
    _wide_base_deck(base)
    Image.new("RGB", (100, 100), "red").save(image)
    patch.write_text(
        json.dumps(
            {
                "ops": [
                    {"op": "add-slide", "layout": "Blank"},
                    {"op": "add-shape", "slide": 0, "kind": "textbox", "at": [1, 1], "size": [5, 1], "text": ["Hidden text"]},
                    {"op": "add-picture", "slide": 0, "image": str(image), "at": [1, 1], "size": [5, 1]},
                ]
            }
        ),
        encoding="utf-8",
    )
    service = DeckNativeService()
    applied = service.apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output), fix=False)

    fixed = service.lint_fix(pptx_path=str(output), touched_slides=[0])

    assert applied.success is True
    assert fixed.success is True
    assert fixed.residue_count == 1
    assert fixed.residue[0]["shape"].startswith("s")
    assert fixed.residue_kinds


def test_deck_native_lint_fix_promotes_every_remaining_issue_to_residue(
    tmp_path: Path,
    monkeypatch,
) -> None:
    output = tmp_path / "remaining-issues.pptx"
    Presentation().save(output)
    payload = {
        "fixed": [],
        "residue": [],
        "remaining_issue_shapes": [
            "slide 1 s7: {'frame_overflow_bottom': 0.47}",
            "slide 2 s11: {'misaligned': ['vcenter edge 0.09 off gridline']}",
        ],
        "remaining_issues": [
            {
                "slide": 1,
                "shape": "s7",
                "issues": {"frame_overflow_bottom": 0.47},
            },
            {
                "slide": 2,
                "shape": "s11",
                "issues": {"misaligned": ["vcenter edge 0.09 off gridline"]},
            },
        ],
    }
    service = DeckNativeService()
    monkeypatch.setattr(
        service,
        "_run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            [],
            0,
            stdout=json.dumps(payload),
            stderr="",
        ),
    )

    result = service.lint_fix(pptx_path=str(output), touched_slides=[0])

    assert result.success is True
    assert result.lint_issue_count_before == 2
    assert result.fix_applied_count == 0
    assert result.residue_count == 2
    assert result.residue_kinds == {"frame_overflow": 1, "misaligned": 1}
    assert {(item["slide"], item["shape"]) for item in result.residue} == {
        (1, "s7"),
        (2, "s11"),
    }


def test_deck_native_lint_fix_repairs_compatible_alignment_geometry(
    tmp_path: Path,
) -> None:
    output = tmp_path / "production-alignment.pptx"
    presentation = Presentation()
    presentation.slide_width = Inches(20)
    presentation.slide_height = Inches(11.25)
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    for index, left in enumerate((1.0, 4.5, 8.0, 11.5)):
        shape = slide.shapes.add_shape(
            MSO_SHAPE.RECTANGLE,
            Inches(left),
            Inches(3.13),
            Inches(2.9),
            Inches(3.88),
        )
        shape.name = f"alignment-peer-{index}"
    target = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        Inches(15.0),
        Inches(3.13),
        Inches(2.9),
        Inches(3.8),
    )
    target.name = "production-alignment-target"
    presentation.save(output)

    service = DeckNativeService()
    fixed = service.lint_fix(pptx_path=str(output), touched_slides=[0])

    assert fixed.success is True
    assert fixed.lint_issue_count_before == 1
    assert fixed.fix_applied_count == 1
    assert fixed.issue_kinds == {"align-y": 1}
    assert fixed.residue_count == 0
    repaired = Presentation(output)
    repaired_target = next(shape for shape in repaired.slides[0].shapes if shape.name == "production-alignment-target")
    assert repaired_target.top.inches == pytest.approx(3.13, abs=0.01)
    assert repaired_target.height.inches == pytest.approx(3.88, abs=0.01)

    clean = service.lint_fix(pptx_path=str(output), touched_slides=[0])
    assert clean.lint_issue_count_before == 0
    assert clean.fix_applied_count == 0
    assert clean.residue_count == 0


def test_deck_native_lint_fix_grows_small_overflow_inside_containing_panel(
    tmp_path: Path,
) -> None:
    output = tmp_path / "production-contained-overflow.pptx"
    presentation = Presentation()
    presentation.slide_width = Inches(20)
    presentation.slide_height = Inches(11.25)
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    panel = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        Inches(1.25),
        Inches(8.54),
        Inches(18.04),
        Inches(1.95),
    )
    panel.name = "production-container"
    text = slide.shapes.add_textbox(
        Inches(2.49),
        Inches(8.9),
        Inches(9.56),
        Inches(0.33),
    )
    text.name = "production-small-overflow"
    frame = text.text_frame
    frame.margin_left = 0
    frame.margin_right = 0
    frame.margin_top = Inches(0.05)
    frame.margin_bottom = Inches(0.05)
    paragraph = frame.paragraphs[0]
    paragraph.text = "Caution requests explicit confirmation."
    paragraph.line_spacing = Pt(21)
    paragraph.runs[0].font.size = Pt(18)
    presentation.save(output)

    service = DeckNativeService()
    fixed = service.lint_fix(pptx_path=str(output), touched_slides=[0])

    assert fixed.success is True
    assert fixed.lint_issue_count_before == 1
    assert fixed.fix_applied_count == 1
    assert fixed.issue_kinds == {"grow": 1}
    assert fixed.residue_count == 0
    repaired = Presentation(output)
    repaired_text = next(shape for shape in repaired.slides[0].shapes if shape.name == "production-small-overflow")
    assert repaired_text.height.inches == pytest.approx(0.44, abs=0.01)
    assert repaired_text.text_frame.paragraphs[0].runs[0].font.size.pt == 18

    clean = service.lint_fix(pptx_path=str(output), touched_slides=[0])
    assert clean.lint_issue_count_before == 0
    assert clean.fix_applied_count == 0
    assert clean.residue_count == 0


def test_deck_native_lint_fix_repairs_canary_headline_and_kpi_overflow(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Exercise the production lint/fix subprocess with the failed canary geometry."""

    # Give both macOS and Linux subprocesses the same font bytes so this
    # regression tests geometry rather than whichever fonts the host installs.
    home = tmp_path / "home"
    embedded_font = ImageFont.load_default(size=12).path
    assert hasattr(embedded_font, "getvalue")
    for relative_dir in (Path("Library/Fonts"), Path(".fonts")):
        font_dir = home / relative_dir
        font_dir.mkdir(parents=True, exist_ok=True)
        (font_dir / "CanarySerif-Bold.ttf").write_bytes(embedded_font.getvalue())
    monkeypatch.setenv("HOME", str(home))

    output = tmp_path / "canary-overflow.pptx"
    presentation = Presentation()
    presentation.slide_width = Inches(20)
    presentation.slide_height = Inches(11.25)
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])

    def add_textbox(
        *,
        name: str,
        at: tuple[float, float],
        size: tuple[float, float],
        text: str,
        font_size: float,
        line_spacing: float,
        bold: bool = False,
    ):
        shape = slide.shapes.add_textbox(
            Inches(at[0]),
            Inches(at[1]),
            Inches(size[0]),
            Inches(size[1]),
        )
        shape.name = name
        frame = shape.text_frame
        frame.margin_left = 0
        frame.margin_right = 0
        frame.margin_top = 0
        frame.margin_bottom = 0
        paragraph = frame.paragraphs[0]
        paragraph.text = text
        paragraph.line_spacing = Pt(line_spacing)
        run = paragraph.runs[0]
        run.font.name = "CanarySerif"
        run.font.size = Pt(font_size)
        run.font.bold = bold
        return shape

    add_textbox(
        name="canary-headline",
        at=(1.25, 0.85),
        size=(7.75, 0.60),
        text="Habitat is fragmented, not absent",
        font_size=37.5,
        line_spacing=43.1,
        bold=True,
    )
    add_textbox(
        name="canary-narrative",
        at=(1.25, 1.77),
        size=(8.07, 1.56),
        text="Bees and butterflies forage between existing habitat patches.",
        font_size=18.75,
        line_spacing=25.6,
    )
    add_textbox(
        name="canary-kpi",
        at=(11.22, 6.87),
        # The production box was 1.47in. Keep the same tight composition with
        # a 0.02in cushion so the embedded cross-platform test font rewraps.
        size=(1.45, 0.61),
        text="0.9 mi",
        font_size=39,
        line_spacing=46.8,
        bold=True,
    )
    add_textbox(
        name="canary-kpi-label",
        at=(11.22, 7.59),
        size=(3.19, 0.69),
        text="average gap between usable forage patches",
        font_size=14.25,
        line_spacing=17.1,
    )
    mixed = add_textbox(
        name="canary-mixed-run",
        at=(1.25, 10.40),
        size=(4.5, 0.60),
        text="Signal ",
        font_size=12,
        line_spacing=43.1,
    )
    emphasis = mixed.text_frame.paragraphs[0].add_run()
    emphasis.text = "critical corridor failure"
    emphasis.font.name = "CanarySerif"
    emphasis.font.size = Pt(40)
    emphasis.font.bold = True
    presentation.save(output)

    service = DeckNativeService()
    fixed = service.lint_fix(pptx_path=str(output), touched_slides=[0])

    assert fixed.success is True
    assert fixed.lint_issue_count_before >= 2
    assert fixed.fix_applied_count >= 2
    assert fixed.residue_count == 0
    # The producer counts unresolved `remaining_issue_shapes` in the first
    # number, so equality proves none survived this repair pass.
    assert fixed.lint_issue_count_before == fixed.fix_applied_count

    clean = service.lint_fix(pptx_path=str(output), touched_slides=[0])
    assert clean.success is True
    assert clean.lint_issue_count_before == 0
    assert clean.fix_applied_count == 0
    assert clean.residue_count == 0

    repaired = Presentation(output)
    repaired_sizes = {
        shape.name: min(
            run.font.size.pt
            for paragraph in shape.text_frame.paragraphs
            for run in paragraph.runs
            if run.font.size is not None
        )
        for shape in repaired.slides[0].shapes
        if shape.name in {"canary-headline", "canary-kpi"}
    }
    assert set(repaired_sizes) == {"canary-headline", "canary-kpi"}
    assert 31 <= repaired_sizes["canary-headline"] < 37.5
    assert 31 <= repaired_sizes["canary-kpi"] < 39
    repaired_mixed = next(shape for shape in repaired.slides[0].shapes if shape.name == "canary-mixed-run")
    mixed_sizes = [
        run.font.size.pt
        for run in repaired_mixed.text_frame.paragraphs[0].runs
        if run.font.size is not None
    ]
    assert len(mixed_sizes) == 2
    assert mixed_sizes[0] >= 10
    assert mixed_sizes[1] >= mixed_sizes[0] * 2
    assert mixed_sizes[1] < 40


def test_deck_native_inspect_marks_full_slide_picture_inventory(tmp_path: Path) -> None:
    base = tmp_path / "base.pptx"
    patch = tmp_path / "full-slide-picture.patch.json"
    output = tmp_path / "full-slide-picture.pptx"
    image = tmp_path / "background.png"
    _wide_base_deck(base)
    Image.new("RGB", (1920, 1080), "blue").save(image)
    patch.write_text(
        json.dumps(
            {
                "ops": [
                    {"op": "add-slide", "layout": "Blank"},
                    {
                        "op": "add-picture",
                        "slide": 0,
                        "image": str(image),
                        "at": [0, 0],
                        "size": [20, 11.25],
                        "name": "hero-background",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    service = DeckNativeService()

    applied = service.apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output), fix=False)
    inspected = service.inspect(str(output))

    assert applied.success is True
    assert inspected.success is True
    assert inspected.full_slide_picture_count == 1
    inventory = json.loads(Path(inspected.shape_inventory_path or "").read_text(encoding="utf-8"))
    slide = inventory["slides"]["slide:1"]
    assert slide["full_slide_picture_count"] == 1
    assert slide["shapes"][0]["full_slide"] is True
    assert slide["shapes"][0]["name"] == "hero-background"


def test_native_mechanical_report_is_compact() -> None:
    from deerflow.sophia.deck_native.models import (
        NativeDeckInspectResult,
        NativeDeckLintFixResult,
        NativeDeckRenderResult,
    )

    report = native_mechanical_report(
        inspect=NativeDeckInspectResult(True, 2, 5, 4, 1, 1, 0.9, "inventory.json", "raw.json", []),
        lint_fix=NativeDeckLintFixResult(True, 1, 1, 0, 2, [], []),
        render=NativeDeckRenderResult(True, "rendered", 2, []),
        diff={"success": True, "changed": True, "diff_text": "x" * 2000},
    )

    assert report == {
        "inspect_success": True,
        "native_editability_score": 0.9,
        "native_text_shape_count": 4,
        "picture_shape_count": 1,
        "full_slide_picture_count": 1,
        "lint_fix_success": True,
        "lint_issue_count_before": 1,
        "lint_fix_applied_count": 1,
        "lint_residue_count": 0,
        "lint_residue_kinds": {},
        "lint_residue": [],
        "render_success": True,
        "rendered_slide_count": 2,
        "diff_success": True,
        "diff_changed": True,
    }


def test_deck_native_html_to_patch_compiles_when_playwright_available(tmp_path: Path) -> None:
    if importlib.util.find_spec("playwright") is None:
        pytest.skip("Python Playwright is not installed in this backend env")
    base = tmp_path / "base.pptx"
    html = tmp_path / "slide.html"
    patch = tmp_path / "html.patch.json"
    output = tmp_path / "html-native.pptx"
    _wide_base_deck(base)
    html.write_text(
        """<!doctype html><html><body style="margin:0;width:1920px;height:1080px">
        <h1 data-deck-id="title" data-deck-role="title" data-deck-required="true" style="position:absolute;left:96px;top:90px;font-size:72px;background:#fff;border:2px solid #111">Native HTML</h1>
        <p data-deck-id="narrative" data-deck-role="narrative" data-deck-required="true" style="position:absolute;left:96px;top:220px;font-size:36px">Compiled through html2patch.</p>
        </body></html>""",
        encoding="utf-8",
    )
    service = DeckNativeService()

    patched = service.html_to_patch(html_paths=[str(html)], base_deck_path=str(base), output_patch_path=str(patch))
    if not patched.success and any("browser" in error.lower() or "chromium" in error.lower() for error in patched.errors):
        pytest.skip("Python Playwright is installed but Chromium is unavailable")
    applied = service.apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output), fix=True)
    inspected = service.inspect(str(output))

    assert patched.success is True
    assert patched.patch_op_count > 0
    source_map = json.loads(Path(patched.source_map_path or "").read_text(encoding="utf-8"))
    assert set(source_map["slides"]["slide:1"]["elements"]) == {"title", "narrative"}
    assert len(source_map["slides"]["slide:1"]["elements"]["title"]["shape_names"]) >= 2
    assert applied.success is True
    assert inspected.native_text_shape_count >= 2
    assert inspected.full_slide_picture_count == 0


def test_deck_native_html_to_patch_retains_transparent_required_wrapper(tmp_path: Path) -> None:
    if importlib.util.find_spec("playwright") is None:
        pytest.skip("Python Playwright is not installed in this backend env")
    base = tmp_path / "base.pptx"
    html = tmp_path / "transparent-wrapper.html"
    patch = tmp_path / "transparent-wrapper.patch.json"
    output = tmp_path / "transparent-wrapper.pptx"
    _wide_base_deck(base)
    html.write_text(
        """<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#0A0E14;color:#EEF4FB">
        <section data-deck-id="system" data-deck-role="architecture" data-deck-required="true"
                 style="position:absolute;left:96px;top:90px;width:1500px;height:700px">
          <h1 style="position:absolute;left:0;top:0;width:1200px;font-size:72px">Transparent semantic wrapper</h1>
          <p style="position:absolute;left:0;top:180px;width:1100px;font-size:36px">Its native descendants retain the wrapper identity.</p>
        </section>
        </body></html>""",
        encoding="utf-8",
    )
    service = DeckNativeService()

    patched = service.html_to_patch(
        html_paths=[str(html)],
        base_deck_path=str(base),
        output_patch_path=str(patch),
    )
    if not patched.success and any(
        "browser" in error.lower() or "chromium" in error.lower()
        for error in patched.errors
    ):
        pytest.skip("Python Playwright is installed but Chromium is unavailable")
    applied = service.apply_patch(
        base_deck_path=str(base),
        patch_path=str(patch),
        output_path=str(output),
        fix=True,
    )
    inspected = service.inspect(str(output))

    assert patched.success is True
    source_map = json.loads(Path(patched.source_map_path or "").read_text(encoding="utf-8"))
    system = source_map["slides"]["slide:1"]["elements"]["system"]
    assert system["source_role"] == "architecture"
    assert system["source_required"] is True
    assert len(system["shape_names"]) == 2
    assert applied.success is True
    assert inspected.success is True
    inventory = json.loads(Path(inspected.shape_inventory_path or "").read_text(encoding="utf-8"))
    native_names = {
        shape["name"]
        for shape in inventory["slides"]["slide:1"]["shapes"]
        if shape.get("name")
    }
    assert set(system["shape_names"]).issubset(native_names)


def test_deck_native_html_to_patch_retains_nested_semantic_ids(tmp_path: Path) -> None:
    if importlib.util.find_spec("playwright") is None:
        pytest.skip("Python Playwright is not installed in this backend env")
    base = tmp_path / "base.pptx"
    html = tmp_path / "nested-semantic-ids.html"
    patch = tmp_path / "nested-semantic-ids.patch.json"
    output = tmp_path / "nested-semantic-ids.pptx"
    _wide_base_deck(base)
    html.write_text(
        """<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#0A0E14;color:#EEF4FB">
        <section data-deck-id="system" data-deck-role="architecture" data-deck-required="true"
                 style="position:absolute;left:96px;top:90px;width:1500px;height:700px">
          <div data-deck-id="cluster" data-deck-role="diagram" data-deck-required="true"
               style="position:absolute;left:0;top:0;width:1300px;height:600px">
            <h1 data-deck-id="title" data-deck-role="title" data-deck-required="true"
                style="position:absolute;left:0;top:0;width:1200px;font-size:72px">Nested semantic identities</h1>
            <p data-deck-id="detail" data-deck-role="narrative" data-deck-required="true"
               style="position:absolute;left:0;top:180px;width:1100px;font-size:36px">One native shape satisfies its leaf and container identities.</p>
          </div>
        </section>
        </body></html>""",
        encoding="utf-8",
    )
    service = DeckNativeService()

    patched = service.html_to_patch(
        html_paths=[str(html)],
        base_deck_path=str(base),
        output_patch_path=str(patch),
    )
    if not patched.success and any(
        "browser" in error.lower() or "chromium" in error.lower()
        for error in patched.errors
    ):
        pytest.skip("Python Playwright is installed but Chromium is unavailable")
    applied = service.apply_patch(
        base_deck_path=str(base),
        patch_path=str(patch),
        output_path=str(output),
        fix=True,
    )
    inspected = service.inspect(str(output))

    assert patched.success is True
    source_map = json.loads(Path(patched.source_map_path or "").read_text(encoding="utf-8"))
    elements = source_map["slides"]["slide:1"]["elements"]
    assert set(elements) == {"system", "cluster", "title", "detail"}
    title_names = set(elements["title"]["shape_names"])
    detail_names = set(elements["detail"]["shape_names"])
    assert title_names
    assert detail_names
    assert title_names.isdisjoint(detail_names)
    assert set(elements["cluster"]["shape_names"]) == title_names | detail_names
    assert set(elements["system"]["shape_names"]) == title_names | detail_names
    assert applied.success is True
    assert inspected.success is True
    inventory = json.loads(Path(inspected.shape_inventory_path or "").read_text(encoding="utf-8"))
    native_names = {
        shape["name"]
        for shape in inventory["slides"]["slide:1"]["shapes"]
        if shape.get("name")
    }
    assert title_names | detail_names <= native_names


def test_deck_native_html_to_patch_still_rejects_duplicate_semantic_ids(tmp_path: Path) -> None:
    if importlib.util.find_spec("playwright") is None:
        pytest.skip("Python Playwright is not installed in this backend env")
    base = tmp_path / "base.pptx"
    html = tmp_path / "duplicate-semantic-ids.html"
    patch = tmp_path / "duplicate-semantic-ids.patch.json"
    _wide_base_deck(base)
    html.write_text(
        """<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#0A0E14;color:#EEF4FB">
        <h1 data-deck-id="duplicate" style="position:absolute;left:96px;top:90px;font-size:72px">First</h1>
        <p data-deck-id="duplicate" style="position:absolute;left:96px;top:220px;font-size:36px">Second</p>
        </body></html>""",
        encoding="utf-8",
    )
    service = DeckNativeService()

    patched = service.html_to_patch(
        html_paths=[str(html)],
        base_deck_path=str(base),
        output_patch_path=str(patch),
    )
    if not patched.success and any(
        "browser" in error.lower() or "chromium" in error.lower()
        for error in patched.errors
    ):
        pytest.skip("Python Playwright is installed but Chromium is unavailable")

    assert patched.success is False
    assert patched.patch_path is None
    assert "duplicate data-deck-id: duplicate" in "\n".join(patched.errors)
