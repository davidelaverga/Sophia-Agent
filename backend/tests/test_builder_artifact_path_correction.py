"""Phase 2F.3: BuilderArtifactMiddleware injects a path-correction
HumanMessage after N consecutive ``write_file_tool`` errors.

Production failure 2026-05-22 19:54-20:14 UTC: builder spent 20+ minutes
retrying write_file_tool with bare filenames (test.md, test2.md, etc.),
each rejected with PermissionError. Phase 2F.2's auto-prefix elevates
the common bare-filename case to /mnt/user-data/outputs/, but residual
path errors (relative dirs, paths outside /mnt/user-data, etc.) could
still trap the model in a write-error loop.

This escape hatch:
  1. Counts trailing consecutive write_file ToolMessages whose content
     starts with "Error".
  2. After 3 such errors, injects a strong corrective HumanMessage and
     sets ``builder_path_correction_emitted`` to True for idempotency.
  3. Will not re-inject on subsequent before_model calls.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
)


def _wf_error(content: str = "Error: Permission denied writing to file: test.md") -> ToolMessage:
    return ToolMessage(name="write_file", content=content, tool_call_id="tc-x")


def _wf_ok() -> ToolMessage:
    return ToolMessage(name="write_file", content="OK", tool_call_id="tc-x")


def _ai() -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": "write_file", "args": {"path": "test.md"}, "id": "tc-x"}])


# ---- helper: trailing-error counter --------------------------------------


def test_count_trailing_errors_three_consecutive():
    mw = BuilderArtifactMiddleware()
    messages = [HumanMessage(content="brief"), _ai(), _wf_error(), _wf_error(), _wf_error()]
    assert mw._count_trailing_write_file_errors(messages, lookback=8) == 3


def test_count_trailing_errors_two_consecutive():
    mw = BuilderArtifactMiddleware()
    messages = [_ai(), _wf_error(), _wf_error()]
    assert mw._count_trailing_write_file_errors(messages, lookback=8) == 2


def test_count_trailing_errors_stops_at_first_ok():
    """OK breaks the streak so a model that recovered then errored
    twice doesn't trigger the threshold."""
    mw = BuilderArtifactMiddleware()
    messages = [_wf_error(), _wf_error(), _wf_ok(), _wf_error(), _wf_error()]
    # Trailing tail (from the right): error, error, OK, ... → streak count = 2 (then OK breaks).
    assert mw._count_trailing_write_file_errors(messages, lookback=8) == 2


def test_count_trailing_errors_zero_when_no_errors():
    mw = BuilderArtifactMiddleware()
    messages = [_wf_ok(), _wf_ok(), _wf_ok()]
    assert mw._count_trailing_write_file_errors(messages, lookback=8) == 0


def test_count_trailing_errors_tolerates_ai_msgs_between_tool_msgs():
    """The trailing streak should not be broken by intervening AIMessages
    (the model thinks between tool calls)."""
    mw = BuilderArtifactMiddleware()
    messages = [_wf_error(), _ai(), _wf_error(), _ai(), _wf_error()]
    assert mw._count_trailing_write_file_errors(messages, lookback=8) == 3


def test_count_trailing_errors_non_write_file_tool_breaks_streak():
    """Other tools' results break the streak — we only want to escape
    write_file_tool error loops, not other tool failures."""
    mw = BuilderArtifactMiddleware()
    bash_err = ToolMessage(name="bash", content="Error: command failed", tool_call_id="tc-b")
    messages = [_wf_error(), _wf_error(), bash_err, _wf_error()]
    # Walking back: write_file error (1), then bash error (NOT write_file → streak broken).
    assert mw._count_trailing_write_file_errors(messages, lookback=8) == 1


# ---- escape-hatch injection ----------------------------------------------


def test_correction_injected_after_three_errors():
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="brief"),
            _ai(), _wf_error(),
            _ai(), _wf_error(),
            _ai(), _wf_error(),
        ],
    }
    result = mw.before_model(state)
    assert result is not None
    # Idempotency flag set.
    assert result.get("builder_path_correction_emitted") is True
    # Corrective message appended.
    new_msgs = result.get("messages", [])
    assert len(new_msgs) == 1
    msg = new_msgs[0]
    assert isinstance(msg, HumanMessage)
    assert "[Sophia/path-correction directive]" in msg.content
    assert "/mnt/user-data/outputs/" in msg.content


def test_no_correction_below_threshold():
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [HumanMessage(content="brief"), _ai(), _wf_error(), _wf_error()],
    }
    # 2 errors — below the 3-error threshold.
    assert mw.before_model(state) is None


def test_correction_idempotent_after_flag_set():
    """Once the flag is set, subsequent before_model calls do not
    re-emit the correction — even if more errors pile up."""
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [_wf_error(), _wf_error(), _wf_error(), _wf_error(), _wf_error()],
        "builder_path_correction_emitted": True,
    }
    assert mw.before_model(state) is None


def test_correction_combined_with_turn_budget_reset():
    """The combined before_model probe runs BOTH the turn-budget reset
    AND the path correction. When both fire on the same turn, both
    state updates are merged into the return."""
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [
            # post-interrupt shape: prior AI w/ tool_calls + new HumanMessage.
            _ai(),  # AIMessage with tool_calls
            HumanMessage(content="new update"),
            # ...then 3 consecutive write_file errors after the resume.
            _ai(), _wf_error(),
            _ai(), _wf_error(),
            _ai(), _wf_error(),
        ],
        "builder_non_artifact_turns": 5,
    }
    # Note: the trailing 3 errors trigger the path correction; the
    # post-interrupt-update detector looks for a HumanMessage at the
    # TAIL. The error messages are at the tail here, so the reset
    # won't fire. This test confirms the combined probe at least
    # produces the path correction.
    result = mw.before_model(state)
    assert result is not None
    assert result.get("builder_path_correction_emitted") is True


# ---- async parity --------------------------------------------------------


def test_abefore_model_mirrors_before_model_for_path_correction():
    import asyncio
    mw = BuilderArtifactMiddleware()
    state = {
        "messages": [_wf_error(), _wf_error(), _wf_error()],
    }
    result = asyncio.run(mw.abefore_model(state))
    assert result is not None
    assert result.get("builder_path_correction_emitted") is True


# ---- defensive: edge cases -----------------------------------------------


def test_no_correction_with_empty_messages():
    mw = BuilderArtifactMiddleware()
    assert mw.before_model({"messages": []}) is None


def test_no_correction_with_only_non_tool_msgs():
    mw = BuilderArtifactMiddleware()
    state = {"messages": [HumanMessage(content="hi"), SystemMessage(content="sys"), _ai()]}
    assert mw.before_model(state) is None


def test_correction_with_error_content_variations():
    """Any tool result whose content starts with 'Error' counts —
    accommodates the various error strings write_file_tool can return
    (Permission denied, Path is a directory, Failed to write, etc.)."""
    mw = BuilderArtifactMiddleware()
    err1 = ToolMessage(name="write_file", content="Error: Permission denied", tool_call_id="t1")
    err2 = ToolMessage(name="write_file", content="Error: Failed to write file", tool_call_id="t2")
    err3 = ToolMessage(name="write_file", content="Error: Path is a directory", tool_call_id="t3")
    state = {"messages": [err1, err2, err3]}
    result = mw.before_model(state)
    assert result is not None
    assert result.get("builder_path_correction_emitted") is True
