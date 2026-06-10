from types import SimpleNamespace

from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _apply_visual_missing_quality_metadata,
)


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


def test_visual_pdf_emit_without_embedded_visuals_gets_quality_warning(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.pdf").write_bytes(b"%PDF-1.4\n%%EOF")
    state = _visual_state(outputs)

    # The files-exist predicate stays permissive (recovery and override
    # helpers rely on it), but the emit-time visual gate blocks the first
    # attempt and grants one repair turn.
    ok = BuilderArtifactMiddleware._artifact_files_exist(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"},
        state,
        _runtime(),
    )
    assert ok is True
    assert BuilderArtifactMiddleware._visual_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    ) is True

    state["builder_visual_embed_rejections"] = 1
    assert BuilderArtifactMiddleware._visual_gate_blocks_emit(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    ) is False
    updated = _apply_visual_missing_quality_metadata(
        {
            "artifact_path": "/mnt/user-data/outputs/report.pdf",
            "artifact_type": "pdf",
        },
        state,
    )
    # A rendered primary is never flagged as a fallback; missing visuals are
    # a quality warning (prod 2026-06-10: the fallback flag made the frontend
    # surface the markdown source sibling instead of the rendered PDF).
    assert "artifact_is_fallback" not in updated
    assert "fallback_reason" not in updated
    assert updated["visuals_missing"] is True
    assert updated["quality_warning"] == "visuals_not_embedded"


def test_visual_pdf_emit_quality_warning_caps_confidence(tmp_path) -> None:
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
    state["builder_pdf_render_result"] = {
        "success": True,
        "pdf_path": "/mnt/user-data/outputs/report.pdf",
        "layout_quality": "ok",
        "image_count": 0,
    }

    ok = BuilderArtifactMiddleware._artifact_files_exist(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"},
        state,
        _runtime(),
    )

    assert ok is True
    updated = _apply_visual_missing_quality_metadata(
        {
            "artifact_path": "/mnt/user-data/outputs/report.pdf",
            "artifact_type": "pdf",
            "confidence": 0.9,
        },
        state,
    )
    assert "artifact_is_fallback" not in updated
    assert "fallback_reason" not in updated
    assert updated["visuals_missing"] is True
    assert updated["quality_warning"] == "visuals_not_embedded"
    assert updated["confidence"] == 0.65


def test_valid_pptx_completion_never_carries_fallback_reason(tmp_path) -> None:
    """Prod 2026-06-10: valid .pptx completions carried
    fallback_reason=pptx_generation_not_completed because call sites thread a
    precautionary reason through _apply_artifact_request_metadata."""
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _apply_artifact_request_metadata,
    )

    state = {
        "delegation_context": {"task": "Build a slide deck"},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
    }
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/deck.pptx",
        "fallback_reason": "stale-from-earlier-turn",
    }

    updated = _apply_artifact_request_metadata(
        artifact,
        state,
        fallback_reason="pptx_generation_not_completed",
    )

    assert updated["artifact_is_fallback"] is False
    assert "fallback_reason" not in updated
    assert updated["requested_artifact_ext"] == "pptx"
    assert updated["artifact_ext"] == "pptx"


def test_extension_mismatch_still_marks_fallback() -> None:
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _apply_artifact_request_metadata,
    )

    state = {
        "delegation_context": {"task": "Build a slide deck"},
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
    }
    artifact = {"artifact_path": "/mnt/user-data/outputs/deck.md"}

    updated = _apply_artifact_request_metadata(
        artifact,
        state,
        fallback_reason="pptx_generation_not_completed",
    )

    assert updated["artifact_is_fallback"] is True
    assert updated["fallback_reason"] == "pptx_generation_not_completed"


def test_apology_fallback_keeps_truthful_failure_reason() -> None:
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _apply_artifact_request_metadata,
    )

    state = {
        "delegation_context": {"task": "Build a PDF"},
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
    }
    artifact = {"artifact_path": None}

    updated = _apply_artifact_request_metadata(
        artifact,
        state,
        fallback_reason="pdf_generation_failed",
    )

    assert updated["fallback_reason"] == "pdf_generation_failed"


def test_source_sibling_of_primary_detection() -> None:
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _is_source_sibling_of_primary,
    )

    primary = "/mnt/user-data/outputs/sophia-roadmap.pdf"
    # The render source named <primary>.md (prod naming) is a sibling.
    assert _is_source_sibling_of_primary(
        "/mnt/user-data/outputs/sophia-roadmap.pdf.md", primary
    ) is True
    # The stem-named source is also a sibling.
    assert _is_source_sibling_of_primary(
        "/mnt/user-data/outputs/sophia-roadmap.md", primary
    ) is True
    # Unrelated supporting files still upload.
    assert _is_source_sibling_of_primary(
        "/mnt/user-data/outputs/data-appendix.md", primary
    ) is False
    assert _is_source_sibling_of_primary(
        "/mnt/user-data/outputs/visuals/chart.png", primary
    ) is False
    # Non-binary primaries keep their supporting files.
    assert _is_source_sibling_of_primary(
        "/mnt/user-data/outputs/notes.md", "/mnt/user-data/outputs/notes.html"
    ) is False


def _autowire_request(state: dict, command: str):
    return SimpleNamespace(
        tool_call={"id": "tc-bash", "name": "bash_tool", "args": {"command": command}},
        state=state,
        runtime=_runtime(),
    )


def test_autowire_assigns_generated_pngs_to_content_slides(tmp_path) -> None:
    import json as _json

    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    workspace.mkdir()
    (visuals / "timeline.png").write_bytes(b"\x89PNG fake")
    plan = {
        "title": "Deck",
        "slides": [
            {"type": "title", "title": "Deck"},
            {"title": "Roadmap", "key_points": ["a", "b"]},
            {"title": "Architecture", "key_points": ["c"]},
        ],
    }
    plan_file = workspace / "plan.json"
    plan_file.write_text(_json.dumps(plan), encoding="utf-8")

    state = _visual_state(outputs, target="/mnt/user-data/outputs/deck.pptx")
    state["thread_data"]["workspace_path"] = str(workspace)
    state["builder_visual_diagnostics"] = {
        "visual_asset_success_count": 1,
        "visual_asset_paths": ["/mnt/user-data/outputs/visuals/timeline.png"],
    }
    command = (
        "python /mnt/skills/public/ppt-generation/scripts/generate.py "
        "--plan-file /mnt/user-data/workspace/plan.json "
        "--output-file /mnt/user-data/outputs/deck.pptx"
    )

    BuilderArtifactMiddleware._maybe_autowire_pptx_plan_visuals(
        _autowire_request(state, command)
    )

    rewritten = _json.loads(plan_file.read_text(encoding="utf-8"))
    slides = rewritten["slides"]
    assert "image" not in slides[0]  # title slide untouched
    assert slides[1]["image"] == "/mnt/user-data/outputs/visuals/timeline.png"


def test_autowire_drops_refs_to_missing_files(tmp_path) -> None:
    import json as _json

    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    outputs.mkdir()
    workspace.mkdir()
    plan = {
        "title": "Deck",
        "slides": [
            {"type": "title", "title": "Deck"},
            {"title": "Roadmap", "image": "/mnt/user-data/outputs/visuals/missing.png"},
        ],
    }
    plan_file = workspace / "plan.json"
    plan_file.write_text(_json.dumps(plan), encoding="utf-8")

    state = _visual_state(outputs, target="/mnt/user-data/outputs/deck.pptx")
    state["thread_data"]["workspace_path"] = str(workspace)
    command = (
        "python /mnt/skills/public/ppt-generation/scripts/generate.py "
        "--plan-file /mnt/user-data/workspace/plan.json "
        "--output-file /mnt/user-data/outputs/deck.pptx"
    )

    BuilderArtifactMiddleware._maybe_autowire_pptx_plan_visuals(
        _autowire_request(state, command)
    )

    rewritten = _json.loads(plan_file.read_text(encoding="utf-8"))
    assert "image" not in rewritten["slides"][1]


def test_autowire_leaves_valid_plans_untouched(tmp_path) -> None:
    import json as _json

    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    workspace.mkdir()
    (visuals / "chart.png").write_bytes(b"\x89PNG fake")
    plan = {
        "title": "Deck",
        "slides": [
            {"type": "title", "title": "Deck"},
            {"title": "Roadmap", "image": "/mnt/user-data/outputs/visuals/chart.png"},
        ],
    }
    plan_file = workspace / "plan.json"
    original = _json.dumps(plan)
    plan_file.write_text(original, encoding="utf-8")

    state = _visual_state(outputs, target="/mnt/user-data/outputs/deck.pptx")
    state["thread_data"]["workspace_path"] = str(workspace)
    command = (
        "python /mnt/skills/public/ppt-generation/scripts/generate.py "
        "--plan-file /mnt/user-data/workspace/plan.json "
        "--output-file /mnt/user-data/outputs/deck.pptx"
    )

    BuilderArtifactMiddleware._maybe_autowire_pptx_plan_visuals(
        _autowire_request(state, command)
    )

    assert plan_file.read_text(encoding="utf-8") == original


def test_autowire_prefers_generated_hero_for_title_slide(tmp_path) -> None:
    import json as _json

    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    workspace.mkdir()
    (visuals / "hero-launch.png").write_bytes(b"\x89PNG hero")
    (visuals / "timeline.png").write_bytes(b"\x89PNG chart")
    plan = {
        "title": "Deck",
        "slides": [
            {"type": "title", "title": "Deck"},
            {"title": "Roadmap", "key_points": ["a"]},
        ],
    }
    plan_file = workspace / "plan.json"
    plan_file.write_text(_json.dumps(plan), encoding="utf-8")

    state = _visual_state(outputs, target="/mnt/user-data/outputs/deck.pptx")
    state["thread_data"]["workspace_path"] = str(workspace)
    state["builder_visual_diagnostics"] = {
        "visual_asset_success_count": 1,
        "visual_asset_paths": ["/mnt/user-data/outputs/visuals/timeline.png"],
    }
    state["builder_pptx_diagnostics"] = {
        "image_generation_attempt_count": 1,
        "image_generation_success_count": 1,
        "image_output_paths": ["/mnt/user-data/outputs/visuals/hero-launch.png"],
    }
    command = (
        "python /mnt/skills/public/ppt-generation/scripts/generate.py "
        "--plan-file /mnt/user-data/workspace/plan.json "
        "--output-file /mnt/user-data/outputs/deck.pptx"
    )

    BuilderArtifactMiddleware._maybe_autowire_pptx_plan_visuals(
        _autowire_request(state, command)
    )

    rewritten = _json.loads(plan_file.read_text(encoding="utf-8"))
    slides = rewritten["slides"]
    # Hero image lands on the title slide as a full-bleed layout.
    assert slides[0]["image"] == "/mnt/user-data/outputs/visuals/hero-launch.png"
    assert slides[0]["layout"] == "full_bleed_image"
    # The chart still round-robins onto the content slide.
    assert slides[1]["image"] == "/mnt/user-data/outputs/visuals/timeline.png"


def test_autowire_accepts_jpg_generated_images(tmp_path) -> None:
    import json as _json

    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    workspace.mkdir()
    (visuals / "hero.jpg").write_bytes(b"\xff\xd8 jpeg hero")
    plan = {
        "title": "Deck",
        "slides": [
            {"type": "title", "title": "Deck"},
            {"title": "Roadmap", "key_points": ["a"]},
        ],
    }
    plan_file = workspace / "plan.json"
    plan_file.write_text(_json.dumps(plan), encoding="utf-8")

    state = _visual_state(outputs, target="/mnt/user-data/outputs/deck.pptx")
    state["thread_data"]["workspace_path"] = str(workspace)
    state["builder_pptx_diagnostics"] = {
        "image_output_paths": ["/mnt/user-data/outputs/visuals/hero.jpg"],
    }
    command = (
        "python /mnt/skills/public/ppt-generation/scripts/generate.py "
        "--plan-file /mnt/user-data/workspace/plan.json "
        "--output-file /mnt/user-data/outputs/deck.pptx"
    )

    BuilderArtifactMiddleware._maybe_autowire_pptx_plan_visuals(
        _autowire_request(state, command)
    )

    rewritten = _json.loads(plan_file.read_text(encoding="utf-8"))
    assert rewritten["slides"][0]["image"] == "/mnt/user-data/outputs/visuals/hero.jpg"


def test_autowire_does_not_override_explicit_layout(tmp_path) -> None:
    import json as _json

    outputs = tmp_path / "outputs"
    workspace = tmp_path / "workspace"
    visuals = outputs / "visuals"
    visuals.mkdir(parents=True)
    workspace.mkdir()
    (visuals / "hero.png").write_bytes(b"\x89PNG hero")
    plan = {
        "title": "Deck",
        "slides": [
            {"type": "title", "title": "Deck", "layout": "title"},
            {"title": "Roadmap", "key_points": ["a"]},
        ],
    }
    plan_file = workspace / "plan.json"
    plan_file.write_text(_json.dumps(plan), encoding="utf-8")

    state = _visual_state(outputs, target="/mnt/user-data/outputs/deck.pptx")
    state["thread_data"]["workspace_path"] = str(workspace)
    state["builder_pptx_diagnostics"] = {
        "image_output_paths": ["/mnt/user-data/outputs/visuals/hero.png"],
    }
    command = (
        "python /mnt/skills/public/ppt-generation/scripts/generate.py "
        "--plan-file /mnt/user-data/workspace/plan.json "
        "--output-file /mnt/user-data/outputs/deck.pptx"
    )

    BuilderArtifactMiddleware._maybe_autowire_pptx_plan_visuals(
        _autowire_request(state, command)
    )

    rewritten = _json.loads(plan_file.read_text(encoding="utf-8"))
    # Image is wired but the explicit layout choice stays.
    assert rewritten["slides"][0]["image"] == "/mnt/user-data/outputs/visuals/hero.png"
    assert rewritten["slides"][0]["layout"] == "title"
