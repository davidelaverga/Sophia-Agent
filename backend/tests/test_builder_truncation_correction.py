"""F1 (prod 2026-06-11): HTML builds died on a max_tokens truncation loop.

The model wrote a complete .html in ONE write_file call; output capped at
max_tokens; the truncated tool-call JSON parsed with missing args; the
generic tool-argument correction told it to "fix the arguments" (not to
chunk) so every retry truncated identically until the 4-strike stop.

These tests pin the truncation-specific correction: detection via the
AIMessage's provider stop_reason, one-shot chunking instruction granted
BEFORE the generic correction/stop ladder, and idempotency.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
)


def _truncated_ai(content: str = "writing the file") -> AIMessage:
    return AIMessage(content=content, response_metadata={"stop_reason": "max_tokens"})


def _complete_ai(content: str = "done") -> AIMessage:
    return AIMessage(content=content, response_metadata={"stop_reason": "tool_use"})


def test_last_ai_truncated_detects_max_tokens():
    state = {"messages": [HumanMessage(content="build"), _truncated_ai()]}
    assert BuilderArtifactMiddleware._last_ai_truncated(state) is True


def test_last_ai_truncated_false_for_normal_stop():
    state = {"messages": [_complete_ai()]}
    assert BuilderArtifactMiddleware._last_ai_truncated(state) is False


def test_last_ai_truncated_reads_only_latest_ai_message():
    # An older truncated message must not trigger after a healthy turn.
    state = {"messages": [_truncated_ai(), HumanMessage(content="retry"), _complete_ai()]}
    assert BuilderArtifactMiddleware._last_ai_truncated(state) is False


def test_truncation_correction_injected_before_generic_ladder():
    mw = BuilderArtifactMiddleware()
    state = {"messages": [_truncated_ai()]}

    update = mw._truncation_correction_update(state, count=3, error_class="missing_required_tool_arg")

    assert isinstance(update, dict)
    assert update["builder_truncation_correction_emitted"] is True
    content = update["messages"][0].content
    assert "[Sophia/output-truncation correction]" in content
    assert "append=True" in content
    assert "append=False" in content


def test_truncation_correction_is_one_shot():
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [_truncated_ai()],
        "builder_truncation_correction_emitted": True,
    }
    assert mw._truncation_correction_update(state, count=4, error_class="missing_required_tool_arg") is None


def test_no_truncation_correction_without_truncation():
    mw = BuilderArtifactMiddleware()
    state = {"messages": [_complete_ai()]}
    assert mw._truncation_correction_update(state, count=3, error_class="missing_required_tool_arg") is None


def test_failure_update_prefers_truncation_correction_over_stop(tmp_path):
    """With the truncation cause present, the failure ladder grants the
    chunking turn instead of stopping the build — even when the generic
    correction was already spent."""
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [_truncated_ai()],
        "thread_data": {"outputs_path": str(tmp_path / "outputs")},
        "builder_tool_argument_correction_emitted": True,
        "builder_write_diagnostics": {"error_count": 4, "last_error_class": "missing_required_tool_arg"},
    }

    update = mw._write_tool_argument_failure_update(
        state, None, count=4, error_class="missing_required_tool_arg"
    )

    assert isinstance(update, dict)
    assert update.get("builder_truncation_correction_emitted") is True
    assert "jump_to" not in update  # build NOT stopped


def test_failure_update_still_stops_after_truncation_correction_spent(tmp_path):
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [_truncated_ai()],
        "thread_data": {"outputs_path": str(tmp_path / "outputs")},
        "builder_tool_argument_correction_emitted": True,
        "builder_truncation_correction_emitted": True,
        "builder_write_diagnostics": {"error_count": 5, "last_error_class": "missing_required_tool_arg"},
    }

    update = mw._write_tool_argument_failure_update(
        state, None, count=5, error_class="missing_required_tool_arg"
    )

    assert isinstance(update, dict)
    assert update.get("jump_to") == "end"  # backstop unchanged
