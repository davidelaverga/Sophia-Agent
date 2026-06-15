"""Correction wave 2026-06-12 — emit-time format-conflict guard.

Prod incident: dispatch misderived target_ext=pptx for "an actual PDF
report (not a presentation)"; the builder rendered a correct 9-page PDF and
the ext gate rejected it on every emit. The guard honors the user's
EXPLICIT current-turn format (the dispatch-stamped ``user_requested_ext``)
over the misderived target — and ONLY then. Everything else keeps the
no-format-swap rejection behavior bit-for-bit.
"""

from __future__ import annotations

from types import SimpleNamespace

from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _apply_artifact_request_metadata,
    _format_conflict_user_override,
)


def _runtime():
    return SimpleNamespace(context={}, config={})


def _state(
    outputs,
    *,
    target: str,
    user_requested_ext: str | None,
    state_target: str | None = None,
    update_epoch: int = 0,
) -> dict:
    delegation = {
        "task": "Create an actual report about architecture failure points",
        "description": "Create an actual report about architecture failure points",
        "artifact_target_path": target,
    }
    if user_requested_ext is not None:
        delegation["user_requested_ext"] = user_requested_ext
    return {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": state_target or target,
        "delegation_context": delegation,
        "builder_update_epoch": update_epoch,
        "builder_tool_turn_summaries": [],
        "builder_web_budget": {"search_calls": 1, "fetch_calls": 1},
        # These tests exercise the format-conflict guard, not the Phase 5c
        # per-target skill-read gate — latch it so emit reaches the conflict path.
        "builder_target_skill_read_forced": True,
    }


def _emit_request(state: dict, artifact_path: str) -> SimpleNamespace:
    return SimpleNamespace(
        tool_call={
            "id": "tc-emit",
            "name": "emit_builder_artifact",
            "args": {
                "artifact_path": artifact_path,
                "artifact_type": "pdf",
                "artifact_title": "Report",
                "steps_completed": 3,
                "decisions_made": ["x"],
                "companion_summary": "done",
                "companion_tone_hint": "calm",
                "confidence": 0.8,
            },
        },
        state=state,
        runtime=_runtime(),
    )


# ---- the guard's firing conditions ----------------------------------------------


def test_invariant_md_emit_for_pptx_target_gets_no_override(tmp_path):
    """THE no-format-swap invariant: a .md emission for a pptx target is
    never override-accepted, even with a matching-format user stamp."""
    state = _state(
        tmp_path / "outputs",
        target="/mnt/user-data/outputs/deck.pptx",
        user_requested_ext="pptx",
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/deck.md"}, state
    )
    assert override is None  # emitted ext != user ext → guard inert


def test_guard_inert_without_dispatch_stamp(tmp_path):
    state = _state(
        tmp_path / "outputs",
        target="/mnt/user-data/outputs/report.pdf",
        user_requested_ext=None,
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/report.md"}, state
    )
    assert override is None


def test_guard_inert_when_target_already_matches_user(tmp_path):
    state = _state(
        tmp_path / "outputs",
        target="/mnt/user-data/outputs/report.pdf",
        user_requested_ext="pdf",
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    )
    assert override is None  # no conflict → no overlay, zero behavior change


def test_third_format_emit_gets_no_override(tmp_path):
    state = _state(
        tmp_path / "outputs",
        target="/mnt/user-data/outputs/deck.pptx",
        user_requested_ext="pdf",
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/page.html"}, state
    )
    assert override is None  # html is neither the target nor the user ask


def test_stale_stamp_guard_post_interrupt_target_wins(tmp_path):
    """A post-interrupt target rewrite (state != dispatch target) outranks
    the dispatch-time user stamp."""
    state = _state(
        tmp_path / "outputs",
        target="/mnt/user-data/outputs/report.pdf",
        user_requested_ext="pdf",
        state_target="/mnt/user-data/outputs/deck.pptx",
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    )
    assert override is None


def test_update_epoch_disarms_the_guard(tmp_path):
    state = _state(
        tmp_path / "outputs",
        target="/mnt/user-data/outputs/deck.pptx",
        user_requested_ext="pdf",
        update_epoch=1,
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    )
    assert override is None


def test_override_repoints_target_to_user_ext(tmp_path):
    state = _state(
        tmp_path / "outputs",
        target="/mnt/user-data/outputs/deck.pptx",
        user_requested_ext="pdf",
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/report.pdf"}, state
    )
    assert override == {"builder_artifact_target_path": "/mnt/user-data/outputs/deck.pdf"}


# ---- incident replay through wrap_tool_call --------------------------------------


def test_incident_replay_pdf_emit_accepted_for_misderived_pptx_target(tmp_path):
    """The 2026-06-12 shape: correct PDF on disk, target says pptx, user
    explicitly asked for pdf → accepted, stamped, never labeled a fallback."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.pdf").write_bytes(b"%PDF-1.4 fake report\n%%EOF")
    state = _state(
        outputs,
        target="/mnt/user-data/outputs/deck.pptx",
        user_requested_ext="pdf",
    )
    request = _emit_request(state, "/mnt/user-data/outputs/report.pdf")

    handled = {}

    def _handler(req):
        handled["args"] = dict(req.tool_call["args"])
        handled["state_target"] = req.state.get("builder_artifact_target_path")
        return "tool-executed"

    result = BuilderArtifactMiddleware().wrap_tool_call(request, _handler)

    assert result == "tool-executed"  # accepted, no rejection Command
    assert handled["args"]["artifact_path"].endswith("report.pdf")  # not hijacked
    assert handled["state_target"].endswith(".pdf")  # target re-pointed
    args = request.tool_call["args"]
    assert args["format_conflict_resolved"] == "user_intent"
    assert args["format_conflict_original_target_ext"] == "pptx"

    # Acceptance metadata under the re-pointed state: the user's format IS
    # the requested format — never a fallback.
    artifact = _apply_artifact_request_metadata(
        dict(args), {**state, "builder_artifact_target_path": handled["state_target"]}
    )
    assert artifact["requested_artifact_ext"] == "pdf"
    assert artifact["artifact_ext"] == "pdf"
    assert artifact.get("artifact_is_fallback") is False
    assert "fallback_reason" not in artifact


def test_corrupt_user_format_emit_still_integrity_rejected(tmp_path):
    """Re-pointing the target to the user's format does NOT bypass that
    format's own integrity gates: a non-zip .pptx is still rejected."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"this is not a zip archive")
    state = _state(
        outputs,
        target="/mnt/user-data/outputs/report.pdf",
        user_requested_ext="pptx",
    )
    request = _emit_request(state, "/mnt/user-data/outputs/deck.pptx")

    result = BuilderArtifactMiddleware().wrap_tool_call(
        request, lambda _req: "must-not-accept"
    )

    assert isinstance(result, Command)
    assert result.goto == "model"
    # The guard armed (stamps applied) but the pptx gate did its job.
    assert request.tool_call["args"]["format_conflict_resolved"] == "user_intent"


# ---- payload plumbing -------------------------------------------------------------


def test_conflict_fields_whitelisted_in_all_payload_sites():
    from deerflow.sophia.builder_events import _artifact_completion_fields

    fields = _artifact_completion_fields(
        {
            "format_conflict_resolved": "user_intent",
            "format_conflict_original_target_ext": "pptx",
        },
        None,
        None,
        None,
    )
    assert fields["format_conflict_resolved"] == "user_intent"
    assert fields["format_conflict_original_target_ext"] == "pptx"

    from app.gateway.routers.builder_events import (
        _TERMINAL_TASK_OPTIONAL_FIELDS,
        BuilderCompletionEvent,
        _durable_builder_result,
    )

    assert "format_conflict_resolved" in _TERMINAL_TASK_OPTIONAL_FIELDS
    assert "format_conflict_original_target_ext" in _TERMINAL_TASK_OPTIONAL_FIELDS
    assert "format_conflict_resolved" in BuilderCompletionEvent.model_fields
    durable = _durable_builder_result(
        {"format_conflict_resolved": "user_intent", "status": "success"}
    )
    assert durable["format_conflict_resolved"] == "user_intent"

    import inspect

    from app.gateway.routers import builder_canvas

    assert "format_conflict_resolved" in inspect.getsource(builder_canvas)


def test_html_emit_accepted_for_misderived_pptx_target(tmp_path):
    """The 2026-06-12 second report shape: user explicitly asked for html,
    dispatch misderived pptx — an emitted .html matching the user stamp is
    conflict-resolved instead of rejected."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "site.html").write_text("<!doctype html><html><body>ok</body></html>")
    state = _state(
        outputs,
        target="/mnt/user-data/outputs/deck.pptx",
        user_requested_ext="html",
    )
    override = _format_conflict_user_override(
        {"artifact_path": "/mnt/user-data/outputs/site.html"}, state
    )
    assert override == {"builder_artifact_target_path": "/mnt/user-data/outputs/deck.html"}
