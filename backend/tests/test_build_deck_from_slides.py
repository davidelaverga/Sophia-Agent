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


def test_rejects_output_outside_outputs():
    r = _call(runtime=_runtime(), output_path="/tmp/deck.pptx")
    assert r["success"] is False and r["error_type"] == "invalid_input"


def test_rejects_non_pptx_output():
    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pdf")
    assert r["success"] is False and r["error_type"] == "invalid_input"


def test_no_slides_is_reported(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    (outputs / "slides").mkdir(parents=True)  # empty slides dir
    monkeypatch.setattr(deck, "_host_path_for_virtual_output", lambda p, td: outputs / p.removeprefix(_OUTPUTS))
    r = _call(runtime=_runtime(), output_path=f"{_OUTPUTS}deck.pptx")
    assert r["success"] is False and r["error_type"] == "no_slides"


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
