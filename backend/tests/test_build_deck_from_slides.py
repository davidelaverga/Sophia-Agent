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
    names = [getattr(t, "name", "") for t in build_builder_tools_for_task_type("presentation", vision_enabled=False)]
    assert "build_deck_from_slides" in names
    assert "render_html_to_pdf" not in names
    # report path is unchanged
    rnames = [getattr(t, "name", "") for t in build_builder_tools_for_task_type("document", vision_enabled=False)]
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


def test_slide_render_command_sets_opaque_dark_bg_color():
    # The render harness must paint an opaque dark base so a slide that leaves a
    # region uncovered renders navy, not Chromium's default white (white-band
    # defect, prod 019f0b8a). The deck plumbs --bg-color into render_html_to_png.
    cmd = deck._slide_render_command(
        "/usr/bin/node",
        Path("/x/render_html_to_png.mjs"),
        Path("/s/01.html"),
        Path("/o/01.png"),
    )
    assert "--bg-color" in cmd
    assert cmd[cmd.index("--bg-color") + 1] == deck._DECK_BG
    assert deck._DECK_BG == "#0e1626"


def test_partial_images_ship_deck_with_quality_warning(tmp_path, monkeypatch):
    # §WS-B (2026-06-27): a deck whose slides reference some never-generated images
    # still SHIPS — render_html_to_png degrades the missing image to a placeholder
    # and reports `missing_assets=N`; build_deck_from_slides aggregates it into a
    # quality_warning instead of failing. (Prod 019f099a shipped zero deck because
    # 2/8 images made the whole build fail.)
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
            out = Path(cmd[cmd.index("--png-file") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"\x89PNG fake")
            # slide-01 degraded one missing image; slide-02 had all assets.
            missing = 1 if out.name == "slide-01.png" else 0
            return SimpleNamespace(returncode=0, stdout="", stderr=f"[render_html_to_png] wrote {out} bytes=9 missing_assets={missing}")
        if "--output-file" in cmd:
            out = Path(cmd[cmd.index("--output-file") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"PK\x03\x04 fake-pptx")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(deck.subprocess, "run", _fake_run)

    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx")

    assert r["success"] is True, r
    assert r["pptx_path"] == f"{_OUTPUTS}deck.pptx"
    assert r["quality_warning"] == "visuals_partial"
    assert r["missing_image_count"] == 1


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
    assert "build_deck_from_slides" in r.update["messages"][0].content


def test_backstop_blocks_py_writefile_with_pptx():
    r = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _req("write_file", {"path": f"{_OUTPUTS}_gen.py", "content": "import pptx\n"})
    )
    assert isinstance(r, Command)


def test_backstop_allows_slide_html_authoring():
    r = BuilderArtifactMiddleware._deck_improvisation_rejection(
        _req("write_file", {"path": f"{_OUTPUTS}slides/01.html", "content": "<html>pptx presentation(</html>"})
    )
    assert r is None  # .html is always allowed even if it mentions pptx words


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


def test_failed_deck_build_allows_repair_before_reforcing_compile(tmp_path):
    from langchain_core.messages import ToolMessage

    outputs_dir = tmp_path / "outputs"
    slides_dir = outputs_dir / "slides"
    slides_dir.mkdir(parents=True)
    for index in range(1, 4):
        (slides_dir / f"{index:02d}.html").write_text("<html><body>slide</body></html>")

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
    }
    assert mw._force_choice_for_state(blocked_state, None) is None

    write_request = SimpleNamespace(
        tool_call={"name": "write_file", "args": {"path": f"{_OUTPUTS}slides/02.html"}},
        state=blocked_state,
    )
    write_cmd = mw._tool_result_command(write_request, ToolMessage(content="OK", tool_call_id="write"))
    assert isinstance(write_cmd, Command)
    assert write_cmd.update["builder_pptx_compile_repair_pending"] is False

    repaired_state = {**blocked_state, **write_cmd.update}
    assert mw._force_choice_for_state(repaired_state, None) == {
        "type": "tool",
        "name": "build_deck_from_slides",
    }
