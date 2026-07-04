"""Tests for the Spec D Phase 0 deck pipeline (HTML slides → PNG → PPTX).

- `build_deck_from_slides`: validation, no-slides handling, success shape, and the
  per-slide render → full-bleed wrap orchestration (subprocess mocked — chromium /
  node are not in local dev).
- `_deck_improvisation_rejection`: the harness backstop that blocks model-run
  `python-pptx`/compiler attempts for `.pptx` targets (the live deck failure),
  while always allowing slide-HTML authoring.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from langgraph.types import Command

import deerflow.sophia.tools.build_deck_from_slides as deck
from deerflow.agents.sophia_agent.builder_tools import build_builder_tools_for_task_type
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

_OUTPUTS = "/mnt/user-data/outputs/"


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(state={"thread_data": {}}, context={}, config={})


def _call(**kwargs) -> dict:
    return json.loads(deck.build_deck_from_slides.func(**kwargs))


# ---- toolset wiring --------------------------------------------------------


def test_presentation_toolset_offers_deck_builder_not_pdf_renderer():
    # HTML-slide deck path restored (2026-06-29): presentations get
    # build_deck_from_slides, NOT the report HTML→PDF renderer.
    names = [getattr(t, "name", "") for t in build_builder_tools_for_task_type("presentation", vision_enabled=False)]
    assert "prepare_pptx_image_manifest" in names
    assert "build_deck_from_slides" in names
    assert "render_html_to_pdf" not in names
    # report path is unchanged — renderer yes, deck builder no
    rnames = [getattr(t, "name", "") for t in build_builder_tools_for_task_type("document", vision_enabled=False)]
    assert "prepare_pptx_image_manifest" not in rnames
    assert "render_html_to_pdf" in rnames
    assert "build_deck_from_slides" not in rnames


# ---- build_deck_from_slides ------------------------------------------------


@pytest.mark.parametrize(
    ("kwargs", "error_part"),
    [
        ({"output_path": "/tmp/deck.pptx"}, "output_path"),
        ({"output_path": f"{_OUTPUTS}../deck.pptx"}, "traversal"),
        ({"output_path": f"{_OUTPUTS}deck.pptx", "slides_dir": "/etc"}, "slides_dir"),
        ({"output_path": f"{_OUTPUTS}deck.pptx", "slides_dir": f"{_OUTPUTS}../slides"}, "traversal"),
    ],
)
def test_rejects_paths_outside_outputs(kwargs, error_part):
    r = _call(runtime=_runtime(), **kwargs)
    assert r["success"] is False
    assert r["error_type"] == "invalid_input"
    assert error_part in r["error"]


def test_rejects_non_pptx_output():
    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pdf")
    assert r["success"] is False
    assert r["error_type"] == "invalid_input"


def test_no_slides_is_reported(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    (outputs / "slides").mkdir(parents=True)  # empty slides dir
    monkeypatch.setattr(deck, "_host_path_for_virtual_output", lambda p, td: outputs / p.removeprefix(_OUTPUTS))
    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx")
    assert r["success"] is False and r["error_type"] == "no_slides"


def test_rejects_symlinked_slides_dir_escape(tmp_path, monkeypatch):
    # Codex P1 (2026-06-27): a slides_dir that is a symlink to a directory OUTSIDE
    # outputs must be rejected before enumeration, or _ordered_slide_html() would
    # follow it and render outside-HTML into the .pptx (file disclosure).
    outputs = tmp_path / "outputs"
    outputs.mkdir(parents=True)
    outside = tmp_path / "outside_secrets"
    outside.mkdir()
    (outside / "01.html").write_text("<html>secret</html>")
    try:
        (outputs / "slides").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")
    monkeypatch.setattr(deck, "_host_path_for_virtual_output", lambda p, td: outputs / p.removeprefix(_OUTPUTS))

    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx")

    assert r["success"] is False
    assert r["error_type"] == "invalid_input"
    assert "escapes the outputs directory" in r["error"]


def test_rejects_symlinked_slide_html_outside_outputs(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    slides = outputs / "slides"
    slides.mkdir(parents=True)
    outside = tmp_path / "outside_secret.html"
    outside.write_text("<html>secret slide</html>")
    try:
        (slides / "01.html").symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")
    monkeypatch.setattr(deck, "_host_path_for_virtual_output", lambda p, td: outputs / p.removeprefix(_OUTPUTS))

    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx")

    assert r["success"] is False
    assert r["error_type"] == "invalid_input"
    assert "escapes the outputs directory" in r["error"]


def test_success_renders_each_slide_then_wraps(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    slides = outputs / "slides"
    slides.mkdir(parents=True)
    (slides / "01-cover.html").write_text("<html><body>cover</body></html>")
    (slides / "02-body.html").write_text("<html><body>body</body></html>")

    monkeypatch.setattr(deck, "_host_path_for_virtual_output", lambda p, td: outputs / p.removeprefix(_OUTPUTS))
    monkeypatch.setattr(deck.shutil, "which", lambda _: "/usr/bin/node")
    monkeypatch.setattr(deck, "_js_script_path", lambda name: tmp_path / name)

    calls = {"png": 0, "wrap": 0}

    def _fake_run(cmd, **kwargs):
        # png render: write the --png-file; wrap: write the --output-file
        if "--png-file" in cmd:
            calls["png"] += 1
            out = Path(cmd[cmd.index("--png-file") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"\x89PNG fake")
        elif "--output-file" in cmd:
            calls["wrap"] += 1
            out = Path(cmd[cmd.index("--output-file") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"PK\x03\x04 fake-pptx")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(deck.subprocess, "run", _fake_run)

    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx", title="My Deck")

    assert r["success"] is True, r
    assert r["pptx_path"] == f"{_OUTPUTS}deck.pptx"
    assert r["slide_count"] == 2
    assert calls["png"] == 2  # one render per slide
    assert calls["wrap"] == 1  # one wrap call
    assert not (outputs / ".builder" / "_deck_render").exists()
    assert not (outputs / "_deck_render").exists()
    assert (tmp_path / ".deck-render").is_dir()


def test_slide_render_command_sets_opaque_neutral_bg_color():
    # The render harness must paint an opaque base so a slide that leaves a
    # region uncovered does not expose Chromium's default page background.
    # The deck plumbs --bg-color into render_html_to_png without forcing dark style.
    cmd = deck._slide_render_command(
        "/usr/bin/node",
        Path("/x/render_html_to_png.mjs"),
        Path("/s/01.html"),
        Path("/o/01.png"),
    )
    assert "--bg-color" in cmd
    assert cmd[cmd.index("--bg-color") + 1] == deck._DECK_BG
    assert deck._DECK_BG == "#f7f9fc"


def test_missing_slide_images_fail_deck_render(tmp_path, monkeypatch):
    # Generated visuals are mandatory for normal decks. A slide that references
    # an absent local image must fail render instead of screenshotting a broken or
    # placeholder image into a "successful" PPTX.
    outputs = tmp_path / "outputs"
    slides = outputs / "slides"
    slides.mkdir(parents=True)
    (slides / "01.html").write_text("<html><body>a</body></html>")
    (slides / "02.html").write_text("<html><body>b</body></html>")
    monkeypatch.setattr(deck, "_host_path_for_virtual_output", lambda p, td: outputs / p.removeprefix(_OUTPUTS))
    monkeypatch.setattr(deck.shutil, "which", lambda _: "/usr/bin/node")
    monkeypatch.setattr(deck, "_js_script_path", lambda name: tmp_path / name)

    def _fake_run(cmd, **kwargs):
        if "--png-file" in cmd:
            return SimpleNamespace(
                returncode=1,
                stdout="",
                stderr="Error: missing local render assets: /tmp/outputs/assets/slide-01.png",
            )
        if "--output-file" in cmd:
            raise AssertionError("wrap should not run when slide render fails")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(deck.subprocess, "run", _fake_run)

    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx")

    assert r["success"] is False
    assert r["error_type"] == "slide_render_failed"
    assert "missing local render assets" in r["stderr"]


def test_slide_render_failure_is_reported(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    slides = outputs / "slides"
    slides.mkdir(parents=True)
    (slides / "01.html").write_text("<html><body>x</body></html>")
    monkeypatch.setattr(deck, "_host_path_for_virtual_output", lambda p, td: outputs / p.removeprefix(_OUTPUTS))
    monkeypatch.setattr(deck.shutil, "which", lambda _: "/usr/bin/node")
    monkeypatch.setattr(deck, "_js_script_path", lambda name: tmp_path / name)
    monkeypatch.setattr(deck.subprocess, "run", lambda cmd, **k: SimpleNamespace(returncode=1, stdout="", stderr="boom"))
    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx")
    assert r["success"] is False and r["error_type"] == "slide_render_failed"


# ---- _deck_improvisation_rejection (§2.5 backstop) -------------------------


def _req(name: str, args: dict, target: str = f"{_OUTPUTS}deck.pptx"):
    state = {"builder_artifact_target_path": target, "delegation_context": {"task_type": "presentation"}}
    return SimpleNamespace(tool_call={"id": "tc", "name": name, "args": args}, state=state, runtime=_runtime())


def test_backstop_blocks_bash_python_pptx():
    r = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _req("bash", {"command": "python -c 'from pptx import Presentation'"})
    )
    assert isinstance(r, Command)
    # HTML-slide path: the block steers to build_deck_from_slides, not generate.py.
    assert "build_deck_from_slides" in r.update["messages"][0].content
    assert "generate.py --plan-file" not in r.update["messages"][0].content


def test_backstop_blocks_py_writefile_with_pptx():
    r = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _req("write_file", {"path": f"{_OUTPUTS}_gen.py", "content": "import pptx\n"})
    )
    assert isinstance(r, Command)


def test_backstop_ignores_slide_html_authoring_for_separate_path_guard():
    r = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _req("write_file", {"path": f"{_OUTPUTS}slides/01.html", "content": "<html>pptx presentation(</html>"})
    )
    assert r is None


def test_backstop_allows_innocuous_bash():
    r = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _req("bash", {"command": "ls /mnt/user-data/outputs/slides"})
    )
    assert r is None


def test_backstop_noop_for_non_pptx_target():
    r = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _req("bash", {"command": "from pptx import Presentation"}, target=f"{_OUTPUTS}report.pdf")
    )
    assert r is None


# ---- _deck_builder_result_command (Codex P2 — record deck diagnostics) -----


def _deck_tool_message(payload: dict):
    from langchain_core.messages import ToolMessage

    return ToolMessage(content=json.dumps(payload), tool_call_id="tc")


def _deck_build_request(outputs_dir: Path):
    return SimpleNamespace(
        tool_call={
            "name": "build_deck_from_slides",
            "args": {"output_path": f"{_OUTPUTS}deck.pptx"},
        },
        state={"thread_data": {"outputs_path": str(outputs_dir)}},
    )


def test_deck_compile_rejected_when_required_visuals_missing(tmp_path):
    outputs_dir = tmp_path / "outputs"
    slides = outputs_dir / "slides"
    slides.mkdir(parents=True)
    for index in range(1, 4):
        (slides / f"{index:02d}.html").write_text("<html><body>slide</body></html>", encoding="utf-8")
    request = SimpleNamespace(
        tool_call={
            "name": "build_deck_from_slides",
            "id": "tc",
            "args": {"output_path": f"{_OUTPUTS}deck.pptx"},
        },
        state={
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_artifact_target_path": f"{_OUTPUTS}deck.pptx",
            "builder_pptx_requested_slide_count": 3,
            "delegation_context": {"task_type": "presentation"},
            "builder_pptx_diagnostics": {"image_generation_success_count": 0},
        },
    )

    cmd = BuilderArtifactMiddleware._deck_compile_visuals_rejection(request)

    assert isinstance(cmd, Command)
    assert "Do not compile this presentation yet" in cmd.update["messages"][0].content
    assert cmd.update["builder_pptx_diagnostics"]["missing_expected_visual_count"] == 3


def test_deck_compile_missing_visuals_ignores_inflated_expected_count(tmp_path):
    outputs_dir = tmp_path / "outputs"
    slides = outputs_dir / "slides"
    slides.mkdir(parents=True)
    for index in range(1, 7):
        (slides / f"{index:02d}.html").write_text("<html><body>slide</body></html>", encoding="utf-8")
    request = SimpleNamespace(
        tool_call={
            "name": "build_deck_from_slides",
            "id": "tc",
            "args": {"output_path": f"{_OUTPUTS}deck.pptx"},
        },
        state={
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_artifact_target_path": f"{_OUTPUTS}deck.pptx",
            "builder_pptx_requested_slide_count": 6,
            "delegation_context": {"task_type": "presentation"},
            "builder_pptx_diagnostics": {
                "image_generation_success_count": 0,
                "image_generation_manifest_requested_count": 18,
                "expected_generated_visual_count": 4608,
                "missing_expected_visual_count": 4608,
            },
        },
    )

    cmd = BuilderArtifactMiddleware._deck_compile_visuals_rejection(request)

    assert isinstance(cmd, Command)
    assert cmd.update["builder_pptx_diagnostics"]["expected_generated_visual_count"] == 6
    assert cmd.update["builder_pptx_diagnostics"]["missing_expected_visual_count"] == 6


def test_deck_builder_result_records_pptx_diagnostics(tmp_path):
    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    (outputs_dir / "deck.pptx").write_bytes(b"PK\x03\x04 fake")
    result = _deck_tool_message(
        {
            "success": True,
            "pptx_path": f"{_OUTPUTS}deck.pptx",
            "slide_count": 4,
            "quality_warning": "visuals_partial",
            "missing_image_count": 2,
        }
    )
    cmd = BuilderArtifactMiddleware()._deck_builder_result_command(_deck_build_request(outputs_dir), result)
    assert isinstance(cmd, Command)
    diag = cmd.update["builder_pptx_diagnostics"]
    assert diag["pptx_generator_success_count"] == 1
    # picture_count == slide_count (each rendered slide is one full-bleed picture),
    # so the slide-count gate can verify/repair an explicit slide-count request.
    assert diag["pptx_generator_slide_count"] == 4
    assert diag["pptx_generator_picture_count"] == 4
    assert diag["pptx_deck_quality_warning"] == "visuals_partial"
    assert diag["pptx_deck_missing_image_count"] == 2
    assert diag["pptx_output_paths"] == [f"{_OUTPUTS}deck.pptx"]
    assert cmd.update["builder_pptx_compile_latch_pending"] is False


def test_deck_builder_result_emits_build_deck_compile_span(tmp_path, monkeypatch):
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    (outputs_dir / "deck.pptx").write_bytes(b"PK\x03\x04 fake")
    spans = []
    monkeypatch.setattr(
        ba,
        "_safe_langsmith_span",
        lambda name, **kwargs: spans.append({"name": name, **kwargs}),
    )
    result = _deck_tool_message(
        {
            "success": True,
            "pptx_path": f"{_OUTPUTS}deck.pptx",
            "slide_count": 5,
            "quality_warning": "visual_quality_warning",
            "overflow_slides": [{"slide": 3, "overflow_px": 12}],
        }
    )

    BuilderArtifactMiddleware()._deck_builder_result_command(_deck_build_request(outputs_dir), result)

    compile_span = next(span for span in spans if span["name"] == "Sophia PPTX Compile")
    assert compile_span["inputs"]["compiler"] == "build_deck_from_slides"
    assert compile_span["outputs"]["actual_slide_count"] == 5
    assert compile_span["outputs"]["picture_count"] == 5
    assert compile_span["outputs"]["quality_warning"] == "visual_quality_warning"


def test_deck_builder_result_records_failure_and_ignores_garbage(tmp_path):
    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    failed = _deck_tool_message({"success": False, "error_type": "no_slides"})
    cmd = BuilderArtifactMiddleware()._deck_builder_result_command(_deck_build_request(outputs_dir), failed)
    assert isinstance(cmd, Command)
    diag = cmd.update["builder_pptx_diagnostics"]
    assert diag["pptx_generator_attempt_count"] == 1
    assert diag["pptx_generator_success_count"] == 0
    assert diag["pptx_generator_error_class"] == "no_slides"
    # Non-JSON content is tolerated (no crash, passthrough).
    from langchain_core.messages import ToolMessage

    garbage = ToolMessage(content="not json", tool_call_id="tc")
    assert BuilderArtifactMiddleware()._deck_builder_result_command(_deck_build_request(outputs_dir), garbage) is garbage


def test_deck_build_failure_suppresses_force_then_reforces_after_slide_repair(tmp_path):
    # HTML-slide restore (2026-06-29): a slide_render_failed deck build sets
    # repair_pending — the compile force MUST stay suppressed while the model
    # rewrites the broken slide HTML. Once the fix lands (repair_pending cleared)
    # the force RE-FIRES build_deck_from_slides to recompile the repaired deck.
    # (The image-forward era asserted the opposite because the tool was unwired;
    #  build_deck_from_slides is the authoritative deck compiler again.)
    from langchain_core.messages import ToolMessage

    outputs_dir = tmp_path / "outputs"
    slides_dir = outputs_dir / "slides"
    assets_dir = outputs_dir / "assets"
    slides_dir.mkdir(parents=True)
    assets_dir.mkdir(parents=True)
    for index in range(1, 4):
        (assets_dir / f"{index:02d}.png").write_bytes(b"png")
        (slides_dir / f"{index:02d}.html").write_text(
            f"<html><body>slide<div class='visual'><img src='../assets/{index:02d}.png'></div></body></html>"
        )

    mw = BuilderArtifactMiddleware()
    failed = _deck_tool_message({"success": False, "error_type": "slide_render_failed", "slide_count": 3})
    failed_cmd = mw._deck_builder_result_command(_deck_build_request(outputs_dir), failed)
    assert isinstance(failed_cmd, Command)
    assert failed_cmd.update["builder_pptx_compile_latch_pending"] is False
    assert failed_cmd.update["builder_pptx_compile_repair_pending"] is True

    blocked_state = {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": f"{_OUTPUTS}deck.pptx",
            "builder_pptx_requested_slide_count": 3,
            "builder_pptx_compile_repair_pending": True,
            "builder_pptx_diagnostics": {"image_generation_success_count": 3},
            "delegation_context": {"task_type": "presentation"},
        }
    # Repair pending → no force; let the model rewrite the broken slide first.
    assert mw._force_choice_for_state(blocked_state, None) is None

    write_request = SimpleNamespace(
        tool_call={"name": "write_file", "args": {"path": f"{_OUTPUTS}slides/02.html"}},
        state=blocked_state,
    )
    write_cmd = mw._tool_result_command(write_request, ToolMessage(content="OK", tool_call_id="write"))
    assert isinstance(write_cmd, Command)
    assert write_cmd.update["builder_pptx_compile_repair_pending"] is False

    # Slide repaired → the compile force re-fires the deterministic HTML compiler.
    repaired_state = {**blocked_state, **write_cmd.update}
    assert mw._force_choice_for_state(repaired_state, None) == {"type": "tool", "name": "build_deck_from_slides"}


# ---- FIX 2: deterministic slide-quality gate ---------------------------------


def _quality_request(outputs_dir: Path, **extra):
    return SimpleNamespace(
        tool_call={
            "name": "build_deck_from_slides",
            "args": {"output_path": f"{_OUTPUTS}deck.pptx"},
            "id": "tc",
        },
        state={
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_artifact_target_path": f"{_OUTPUTS}deck.pptx",
            "delegation_context": {"task_type": "presentation"},
            **extra,
        },
    )


def _write_clean_slide(outputs_dir: Path) -> None:
    slides = outputs_dir / "slides"
    slides.mkdir(parents=True, exist_ok=True)
    (slides / "01.html").write_text(
        "<html><body><div class='slide'><h1 class='title'>T</h1>"
        "<p class='narrative'>Short narrative.</p></div></body></html>",
        encoding="utf-8",
    )


def test_slide_quality_gate_blocks_overflowing_deck(tmp_path):
    outputs = tmp_path / "outputs"
    _write_clean_slide(outputs)
    result = _deck_tool_message(
        {"success": True, "slide_count": 1, "overflow_slides": [{"slide": 1, "overflow_px": 240}]}
    )
    cmd = BuilderArtifactMiddleware()._slide_quality_rejection_command(
        _quality_request(outputs), result, {"pptx_generator_success_count": 1}
    )
    assert isinstance(cmd, Command)
    assert cmd.goto == "model"
    content = cmd.update["messages"][0].content
    assert "[Sophia/slide-quality]" in content
    assert "build_deck_from_slides" in content
    assert cmd.update["builder_slide_quality_rejections"] == 1
    assert cmd.update["build_iterations"] == 1
    # Suppress the compile force until the model edits a slide.
    assert cmd.update["builder_pptx_compile_repair_pending"] is True
    # Codex P2 (review 4598184111): the rejected build's success diagnostics must
    # NOT persist, or _pptx_valid_output_already_terminal would treat the rejected
    # deck as terminal and the compile force would never re-fire after the edit.
    assert "builder_pptx_diagnostics" not in cmd.update


def test_slide_quality_rejection_keeps_deck_recompilable(tmp_path):
    # Regression for the stale-deck bug: after a quality rejection, the success
    # diagnostics (picture/output-path) are NOT written, so _pptx_compile_ready
    # stays True and the compile force can re-fire once the model edits a slide.
    outputs = tmp_path / "outputs"
    _write_clean_slide(outputs)
    result = _deck_tool_message({"success": True, "overflow_slides": [{"slide": 1, "overflow_px": 260}]})
    delta_with_success = {
        "pptx_generator_success_count": 1,
        "pptx_generator_picture_count": 1,
        "pptx_generator_slide_count": 1,
        "pptx_output_paths": [f"{_OUTPUTS}deck.pptx"],
    }
    cmd = BuilderArtifactMiddleware()._slide_quality_rejection_command(
        _quality_request(outputs), result, delta_with_success
    )
    assert isinstance(cmd, Command)
    # None of the terminal-triggering success markers leak into state.
    assert "builder_pptx_diagnostics" not in cmd.update


def test_slide_quality_gate_blocks_invented_chrome(tmp_path):
    outputs = tmp_path / "outputs"
    slides = outputs / "slides"
    slides.mkdir(parents=True)
    (slides / "01.html").write_text(
        "<html><body><nav class='eyebrow'>A B C D</nav><h1>T</h1></body></html>", encoding="utf-8"
    )
    cmd = BuilderArtifactMiddleware()._slide_quality_rejection_command(
        _quality_request(outputs), _deck_tool_message({"success": True, "slide_count": 1}), {}
    )
    assert isinstance(cmd, Command)
    assert "chrome" in cmd.update["messages"][0].content.lower()


def test_slide_quality_gate_passes_clean_deck(tmp_path):
    outputs = tmp_path / "outputs"
    _write_clean_slide(outputs)
    assert (
        BuilderArtifactMiddleware()._slide_quality_rejection_command(
            _quality_request(outputs), _deck_tool_message({"success": True, "slide_count": 1}), {}
        )
        is None
    )


def test_slide_quality_gate_allows_second_reauthor(tmp_path):
    outputs = tmp_path / "outputs"
    _write_clean_slide(outputs)
    result = _deck_tool_message({"success": True, "overflow_slides": [{"slide": 1, "overflow_px": 300}]})
    delta = {}
    cmd = BuilderArtifactMiddleware()._slide_quality_rejection_command(
        _quality_request(outputs, builder_slide_quality_rejections=1), result, delta
    )
    assert isinstance(cmd, Command)
    assert cmd.update["builder_slide_quality_rejections"] == 2


def test_slide_quality_gate_fails_severe_gaps_after_two_reauthors(tmp_path):
    outputs = tmp_path / "outputs"
    _write_clean_slide(outputs)
    result = _deck_tool_message({"success": True, "overflow_slides": [{"slide": 1, "overflow_px": 300}]})
    delta = {}
    cmd = BuilderArtifactMiddleware()._slide_quality_rejection_command(
        _quality_request(outputs, builder_slide_quality_rejections=2), result, delta
    )
    assert isinstance(cmd, Command)
    assert cmd.update["builder_pptx_terminal_quality_failed"] is True
    assert "artifact_path=null" in cmd.update["messages"][0].content


def test_slide_quality_gate_soft_passes_minor_gaps_after_two_reauthors(tmp_path):
    outputs = tmp_path / "outputs"
    slides = outputs / "slides"
    slides.mkdir(parents=True)
    body = " ".join(f"word{i}" for i in range(160))
    (slides / "01.html").write_text(f"<html><body><p>{body}</p></body></html>", encoding="utf-8")
    result = _deck_tool_message({"success": True, "slide_count": 1})
    delta = {}
    assert BuilderArtifactMiddleware()._slide_quality_rejection_command(
        _quality_request(outputs, builder_slide_quality_rejections=2), result, delta
    ) is None
    assert delta["pptx_deck_quality_warning"] == "visual_quality_warning"
    assert delta["pptx_deck_visual_quality_gap_count"] == 1


def test_slide_quality_gate_blocks_visual_contract_prompt(tmp_path):
    outputs = tmp_path / "outputs"
    _write_clean_slide(outputs)
    assets = outputs / "assets"
    assets.mkdir(parents=True)
    (assets / "02.prompt.json").write_text(
        '{"prompt":"chalkboard diagram with THE TEXT READS: throughput"}',
        encoding="utf-8",
    )
    cmd = BuilderArtifactMiddleware()._slide_quality_rejection_command(
        _quality_request(outputs), _deck_tool_message({"success": True, "slide_count": 1}), {}
    )
    assert isinstance(cmd, Command)
    content = cmd.update["messages"][0].content.lower()
    assert "visual_contract" in content
    assert "regenerate" in content


def test_slide_quality_gate_only_for_pptx_targets(tmp_path):
    outputs = tmp_path / "outputs"
    _write_clean_slide(outputs)
    request = _quality_request(outputs)
    request.state["builder_artifact_target_path"] = f"{_OUTPUTS}report.pdf"
    request.state["delegation_context"] = {"task_type": "document"}
    result = _deck_tool_message({"success": True, "overflow_slides": [{"slide": 1, "overflow_px": 300}]})
    assert BuilderArtifactMiddleware()._slide_quality_rejection_command(request, result, {}) is None


# ---- Codex P2 4601126059: repair latch clears ONLY on a slide-HTML edit -------


def _write_request(path: str, tool: str = "write_file"):
    return SimpleNamespace(
        tool_call={"name": tool, "args": {"path": path}, "id": "w"},
        state={},
    )


def test_repair_latch_clears_on_slide_html_write():
    from langchain_core.messages import ToolMessage

    mw = BuilderArtifactMiddleware()
    cmd = mw._tool_result_command(
        _write_request(f"{_OUTPUTS}slides/03.html"),
        ToolMessage(content="OK wrote file", tool_call_id="w"),
    )
    assert isinstance(cmd, Command)
    assert cmd.update["builder_pptx_compile_repair_pending"] is False


def test_repair_latch_not_cleared_by_non_slide_write():
    # A manifest / notes / asset write during a deck repair must NOT clear the
    # latch — else the compile force recompiles unchanged slides and ships the
    # stale deck past the spent quality gate.
    from langchain_core.messages import ToolMessage

    mw = BuilderArtifactMiddleware()
    for path in (
        f"{_OUTPUTS}assets/manifest.json",
        f"{_OUTPUTS}notes.md",
        f"{_OUTPUTS}deck.html",  # html but not under slides/
    ):
        cmd = mw._tool_result_command(_write_request(path), ToolMessage(content="OK wrote file", tool_call_id="w"))
        assert isinstance(cmd, Command)
        assert "builder_pptx_compile_repair_pending" not in cmd.update, path


def test_repair_latch_str_replace_only_clears_for_slide_html():
    from langchain_core.messages import ToolMessage

    mw = BuilderArtifactMiddleware()
    slide_edit = mw._tool_result_command(
        _write_request(f"{_OUTPUTS}slides/01.html", tool="str_replace"),
        ToolMessage(content="OK edited", tool_call_id="w"),
    )
    assert slide_edit.update["builder_pptx_compile_repair_pending"] is False
    scratch_edit = mw._tool_result_command(
        _write_request(f"{_OUTPUTS}notes.md", tool="str_replace"),
        ToolMessage(content="OK edited", tool_call_id="w"),
    )
    assert "builder_pptx_compile_repair_pending" not in scratch_edit.update
