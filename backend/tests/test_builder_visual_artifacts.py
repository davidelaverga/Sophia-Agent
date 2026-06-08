from types import SimpleNamespace

from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware


def _runtime():
    return SimpleNamespace(context={}, config={})


def _visual_state(outputs, *, target="/mnt/user-data/outputs/report.pdf") -> dict:
    return {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": target,
        "delegation_context": {
            "task": "Build a PDF report with charts and diagrams",
            "description": "Build a PDF report with charts and diagrams",
            "artifact_target_path": target,
        },
        "builder_web_budget": {"search_calls": 1, "fetch_calls": 1},
        "builder_tool_turn_summaries": [],
    }


def test_visual_design_correction_is_injected_before_visual_artifact_work(tmp_path) -> None:
    state = _visual_state(tmp_path / "outputs")

    update = BuilderArtifactMiddleware().before_model(state, _runtime())

    assert update is not None
    assert update["builder_visual_design_correction_emitted"] is True
    assert "/mnt/skills/public/visual-design/SKILL.md" in update["messages"][0].content


def test_generate_visual_asset_is_blocked_until_design_skill_is_read(tmp_path) -> None:
    state = _visual_state(tmp_path / "outputs")
    state["builder_tool_turn_summaries"] = [
        {"tool_names": ["builder_web_search"]},
        {"tool_names": ["builder_web_fetch"]},
    ]
    state["builder_web_budget"] = {"search_calls": 1, "fetch_calls": 1}
    request = SimpleNamespace(
        tool_call={"id": "tc-visual", "name": "generate_visual_asset", "args": {}},
        state=state,
        runtime=_runtime(),
    )

    result = BuilderArtifactMiddleware().wrap_tool_call(request, lambda _request: "unexpected")

    assert isinstance(result, Command)
    assert result.goto == "model"
    message = result.update["messages"][0]
    assert message.status == "error"
    assert "visual-design enforcement blocked" in message.content


def test_visual_pdf_emit_requires_local_visual_evidence(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.pdf").write_bytes(b"%PDF-1.4\n%%EOF")
    state = _visual_state(outputs)

    ok = BuilderArtifactMiddleware._artifact_files_exist(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"},
        state,
        _runtime(),
    )

    assert ok is False


def test_visual_pdf_emit_passes_with_visual_asset_and_source_reference(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    (outputs / "report.pdf").write_bytes(b"%PDF-1.4\n%%EOF")
    (outputs / "report.md").write_text("![Chart](visuals/chart.svg)", encoding="utf-8")
    (visuals / "chart.svg").write_text("<svg></svg>", encoding="utf-8")
    state = _visual_state(outputs)
    state["builder_visual_diagnostics"] = {
        "visual_asset_success_count": 1,
        "visual_asset_paths": ["/mnt/user-data/outputs/visuals/chart.svg"],
    }

    ok = BuilderArtifactMiddleware._artifact_files_exist(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"},
        state,
        _runtime(),
    )

    assert ok is True
