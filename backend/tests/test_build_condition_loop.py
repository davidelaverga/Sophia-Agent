"""Spec VQ-6 + VQ-10 — preview self-review and the build-to-condition loop.

The three one-shot repair mechanisms share one iteration budget
(SOPHIA_BUILDER_MAX_ITERATIONS, default 3); repair turns carry preview
rasters + the review checklist; the advisory holistic pass consumes at most
one iteration; budget pre-grant stops iterations the cost ceiling can't pay
for; everything unmet ships NAMED in the payload.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from langgraph.types import Command

import deerflow.sophia.build_condition as build_condition
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _error_tool_content_text_only,
    _repair_iteration_grantable,
    _unmet_conditions_from_state,
)
from deerflow.agents.sophia_agent.middlewares.builder_budget import (
    budget_allows_iteration,
    builder_budget_for_task,
    max_non_artifact_turns,
)
from deerflow.sophia.build_condition import (
    iteration_available,
    iteration_cap,
    iterations_used,
    rasterize_preview_pages,
)


def _deck_state(**overrides) -> dict:
    state = {
        "delegation_context": {
            "task": "Build a professional technical presentation",
            "task_type": "presentation",
        },
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
    }
    state.update(overrides)
    return state


# ---- iteration cap -----------------------------------------------------------


def test_iteration_cap_default_is_three(monkeypatch):
    monkeypatch.delenv("SOPHIA_BUILDER_MAX_ITERATIONS", raising=False)
    assert iteration_cap() == 3


def test_iteration_cap_env_override(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_MAX_ITERATIONS", "1")
    assert iteration_cap() == 1  # legacy one-shot rollback


def test_iteration_cap_never_below_one(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_MAX_ITERATIONS", "0")
    assert iteration_cap() == 1


def test_iteration_cap_invalid_env_uses_default(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_MAX_ITERATIONS", "junk")
    assert iteration_cap() == 3


def test_builder_budget_policy_uses_complex_tier_for_pdf_and_pptx(monkeypatch):
    monkeypatch.delenv("SOPHIA_BUILDER_MAX_COST_USD", raising=False)
    monkeypatch.delenv("SOPHIA_BUILDER_MAX_TOTAL_TOKENS", raising=False)
    for prefix in ("SOPHIA_BUILDER_SIMPLE_BUDGET", "SOPHIA_BUILDER_COMPLEX_BUDGET"):
        for key in (
            "MAX_COST_USD",
            "MAX_TOTAL_TOKENS",
            "MAX_NON_ARTIFACT_TURNS",
            "FORCE_EMIT_REMAINING_TURNS",
            "SOFT_WARN_AT_TURN",
            "FORCE_EMIT_WALL_CLOCK_FRACTION",
            "REPAIR_RESERVE_USD",
        ):
            monkeypatch.delenv(f"{prefix}_{key}", raising=False)
    simple = builder_budget_for_task(task_type="frontend", artifact_ext="html")
    pdf = builder_budget_for_task(task_type="document", artifact_ext="pdf")
    deck = builder_budget_for_task(task_type="presentation", artifact_ext="pptx")

    assert simple["tier"] == "simple"
    assert simple["max_cost_usd"] == 5.0
    assert max_non_artifact_turns({"builder_budget": simple}) == 30
    assert pdf["tier"] == "complex_artifact"
    assert pdf["max_cost_usd"] == 12.0
    assert max_non_artifact_turns({"builder_budget": pdf}) == 45
    assert deck["tier"] == "complex_artifact"
    assert max_non_artifact_turns({"builder_budget": deck}) == 45


def test_iteration_available_respects_counter(monkeypatch):
    monkeypatch.delenv("SOPHIA_BUILDER_MAX_ITERATIONS", raising=False)
    assert iteration_available({"build_iterations": 2}) is True
    assert iteration_available({"build_iterations": 3}) is False
    assert iterations_used({"build_iterations": 2}) == 2


# ---- budget pre-grant ---------------------------------------------------------


def test_budget_pre_grant_denies_when_ceiling_close():
    state = {
        "builder_budget": {"max_cost_usd": 0.10, "max_total_tokens": 0, "cost_model_key": "claude-sonnet-5"},
        "messages": [],
        "builder_pptx_diagnostics": {"image_generation_attempt_count": 2},  # $0.14 image spend
    }
    assert budget_allows_iteration(state) is False


def test_budget_pre_grant_allows_with_headroom():
    state = {
        "builder_budget": {"max_cost_usd": 5.0, "max_total_tokens": 0, "cost_model_key": "claude-sonnet-5"},
        "messages": [],
    }
    assert budget_allows_iteration(state) is True


def test_budget_pre_grant_disabled_cap_allows():
    state = {"builder_budget": {"max_cost_usd": 0.0, "max_total_tokens": 0}, "messages": []}
    assert budget_allows_iteration(state) is True


def test_repair_iteration_grantable_combines_loop_and_budget(monkeypatch):
    monkeypatch.delenv("SOPHIA_BUILDER_MAX_ITERATIONS", raising=False)
    state = _deck_state(
        build_iterations=0,
        builder_budget={"max_cost_usd": 5.0, "max_total_tokens": 0},
        messages=[],
    )
    assert _repair_iteration_grantable(state) is True
    state["build_iterations"] = 3
    assert _repair_iteration_grantable(state) is False


# ---- rasterization (graceful degradation) -------------------------------------


def test_rasterize_returns_empty_without_poppler(tmp_path, monkeypatch):
    monkeypatch.setattr(build_condition.shutil, "which", lambda _b: None)
    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    assert rasterize_preview_pages(pdf) == []


def test_rasterize_returns_empty_for_missing_file(monkeypatch):
    monkeypatch.setattr(build_condition.shutil, "which", lambda _b: "/fake/pdftoppm")
    assert rasterize_preview_pages(Path("/nope/absent.pdf")) == []


def test_repair_turn_content_falls_back_to_text(tmp_path):
    # No artifact file on disk → plain-text rejection content.
    state = _deck_state(thread_data={"outputs_path": str(tmp_path / "outputs")})
    content = BuilderArtifactMiddleware._repair_turn_content(
        "fix it", {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    )
    assert content == "fix it"


def test_repair_turn_content_attaches_rasters(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.pdf").write_bytes(b"%PDF-1.4 fake")
    state = _deck_state(thread_data={"outputs_path": str(outputs)})
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_artifact.preview_review_blocks",
        lambda _pdf: [
            {"type": "text", "text": "checklist"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "ZmFrZQ=="}},
        ],
    )
    content = BuilderArtifactMiddleware._repair_turn_content(
        "fix it", {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    )
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "fix it"}
    assert any(block.get("type") == "image" for block in content)


def test_error_tool_content_strips_preview_image_blocks() -> None:
    content = _error_tool_content_text_only(
        [
            {"type": "text", "text": "fix the deck"},
            {"type": "image", "source": {"type": "base64", "data": "ZmFrZQ=="}},
        ]
    )

    assert isinstance(content, list)
    assert content == [{"type": "text", "text": "fix the deck"}]


def test_visual_gate_error_tool_message_is_text_only(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"pptx")
    mw = BuilderArtifactMiddleware()
    state = _deck_state(
        thread_data={"outputs_path": str(outputs)},
        build_iterations=0,
        delegation_context={
            "task": "Build a professional technical presentation with a flowchart",
            "task_type": "presentation",
        },
        builder_skill_reads={"visual_design_skill_read": True},
        builder_pptx_diagnostics={"pptx_generator_picture_count": 0},
    )
    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_repair_turn_content",
        classmethod(
            lambda cls, rejection_text, _args, _state: [
                {"type": "text", "text": rejection_text},
                {"type": "image", "source": {"type": "base64", "data": "ZmFrZQ=="}},
            ]
        ),
    )
    request = SimpleNamespace(
        tool_call={"id": "tc", "name": "emit_builder_artifact", "args": {}},
        state=state,
        runtime=None,
    )

    command = mw._visual_gate_rejection_command(
        request,
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"},
    )

    assert isinstance(command, Command)
    tool_message = command.update["messages"][0]
    assert tool_message.status == "error"
    assert isinstance(tool_message.content, list)
    assert all(block.get("type") == "text" for block in tool_message.content)


# ---- advisory pass ------------------------------------------------------------


def test_advisory_consumes_at_most_one_iteration(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.pdf").write_bytes(b"%PDF-1.4 fake")
    mw = BuilderArtifactMiddleware()
    state = _deck_state(
        thread_data={"outputs_path": str(outputs)},
        builder_artifact_target_path="/mnt/user-data/outputs/report.pdf",
        delegation_context={"task": "plain summary", "task_type": "document"},
        build_iterations=0,
        messages=[],
    )
    # Deterministic gates pass (plain task → enrichment off, no visuals
    # requested); advisory fires once with findings, then never again.
    state["builder_artifact_target_path"] = "/mnt/user-data/outputs/report.pdf"
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_artifact.rendered_artifact_review",
        lambda _pdf: {"verdict": "repair", "findings": ["the title overlaps the figure"]},
    )
    request = SimpleNamespace(
        tool_call={"id": "tc", "name": "emit_builder_artifact", "args": {}},
        state=state,
        runtime=SimpleNamespace(context={}, config={}),
    )
    result = mw._visual_gate_rejection_command(
        request, {"artifact_path": "/mnt/user-data/outputs/report.pdf"}
    )
    assert isinstance(result, Command)
    assert result.update["builder_advisory_consumed"] is True
    assert result.update["build_iterations"] == 1

    state["builder_advisory_consumed"] = True
    assert mw._visual_gate_rejection_command(
        request, {"artifact_path": "/mnt/user-data/outputs/report.pdf"}
    ) is None


def test_advisory_pass_returns_none_on_pass(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.pdf").write_bytes(b"%PDF-1.4 fake")
    mw = BuilderArtifactMiddleware()
    state = _deck_state(
        thread_data={"outputs_path": str(outputs)},
        builder_artifact_target_path="/mnt/user-data/outputs/report.pdf",
        delegation_context={"task": "plain summary", "task_type": "document"},
        messages=[],
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_artifact.rendered_artifact_review",
        lambda _pdf: None,
    )
    assert mw._advisory_rejection_text(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    ) is None


# ---- delivery honesty ----------------------------------------------------------


def test_unmet_conditions_named_at_delivery():
    state = _deck_state(builder_pptx_diagnostics={})
    unmet = _unmet_conditions_from_state(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    )
    # Visuals requested? deck brief has no chart markers → only hero unmet.
    assert "hero_missing" in unmet


def test_unmet_conditions_empty_after_success():
    state = _deck_state(
        builder_pptx_diagnostics={
            "image_generation_attempt_count": 1,
            "image_generation_success_count": 1,
        }
    )
    unmet = _unmet_conditions_from_state(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    )
    assert unmet == []


def test_iterations_used_stamped_into_artifact():
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
        _apply_artifact_request_metadata,
    )

    state = _deck_state(
        build_iterations=2,
        builder_pptx_diagnostics={
            "image_generation_attempt_count": 1,
            "image_generation_success_count": 1,
        },
    )
    artifact = _apply_artifact_request_metadata(
        {"artifact_path": "/mnt/user-data/outputs/deck.pptx"}, state
    )
    assert artifact["iterations_used"] == 2
