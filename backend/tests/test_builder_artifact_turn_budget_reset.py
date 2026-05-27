"""Phase 2E.1: BuilderArtifactMiddleware resets ``builder_non_artifact_turns``
to 0 when an interrupted builder run resumes with a new user instruction.

Production failure 2026-05-21 21:18-21:46 UTC: an ``update_async_task``
interrupted an in-flight builder via deepagents' ``multitask_strategy="interrupt"``.
The native dispatch creates a new run on the same thread; the existing
``builder_non_artifact_turns`` counter (6 turns spent on research before
the interrupt) was inherited, leaving only 24 turns for the post-update
writing work. The builder ran out of budget at turn 30 and the middleware
coerced phantom-success → error → user saw "Builder finished but couldn't
produce a deliverable."

These tests pin the reset heuristic:
- Latest message is HumanMessage AND any prior AIMessage carried tool_calls
  → reset counter to 0.
- All other shapes → no reset.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
)


def _ai_with_tool_calls() -> AIMessage:
    """Build an AIMessage with a fake tool_call payload (the signal that
    the builder did real work before being interrupted)."""
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "builder_web_search",
                "args": {"query": "recursive LLMs"},
                "id": "tc-1",
            }
        ],
    )


# ---- positive: reset fires when post-interrupt update is detected --------


def test_reset_fires_when_new_human_msg_follows_ai_with_tool_calls():
    """The canonical post-interrupt shape: human → ai(tool_calls) → ai(...) →
    human(new instruction). Reset must fire."""
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="Build a doc on recursive LLMs"),
            _ai_with_tool_calls(),
            ToolMessage(content="search results...", tool_call_id="tc-1"),
            HumanMessage(content="also include auto TTS"),  # new instruction
        ],
        "builder_non_artifact_turns": 6,
    }
    result = middleware.before_model(state)
    assert result == {"builder_non_artifact_turns": 0}


def test_reset_fires_with_minimal_history():
    """Even a 2-message history (ai(tool_calls) + new human) triggers the
    reset — the AIMessage proves work was done before the new instruction."""
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            _ai_with_tool_calls(),
            HumanMessage(content="actually add X"),
        ],
        "builder_non_artifact_turns": 3,
    }
    result = middleware.before_model(state)
    assert result == {"builder_non_artifact_turns": 0}


def test_reset_fires_when_counter_already_high():
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="initial brief"),
            _ai_with_tool_calls(),
            HumanMessage(content="update"),
        ],
        "builder_non_artifact_turns": 18,  # near soft ceiling
    }
    result = middleware.before_model(state)
    assert result == {"builder_non_artifact_turns": 0}


# ---- negative: reset does NOT fire on normal flow shapes -----------------


def test_no_reset_on_fresh_run_with_only_human_msg():
    """Brand-new builder run has only the initial brief HumanMessage. No
    prior AIMessage with tool_calls → no reset needed."""
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="Build a doc on recursive LLMs"),
        ],
        "builder_non_artifact_turns": 0,
    }
    assert middleware.before_model(state) is None


def test_no_reset_when_latest_is_ai_message():
    """Mid-conversation: model just responded with an AIMessage. Heuristic
    requires latest to be HumanMessage — must not fire."""
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="initial brief"),
            _ai_with_tool_calls(),
        ],
        "builder_non_artifact_turns": 5,
    }
    assert middleware.before_model(state) is None


def test_no_reset_when_latest_is_tool_message():
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="initial brief"),
            _ai_with_tool_calls(),
            ToolMessage(content="result", tool_call_id="tc-1"),
        ],
        "builder_non_artifact_turns": 5,
    }
    assert middleware.before_model(state) is None


def test_no_reset_when_no_ai_msg_with_tool_calls_yet():
    """If prior AIMessages exist but NONE issued tool_calls, the builder
    hasn't done real work yet; the new HumanMessage may just be a
    follow-up clarification rather than a post-interrupt update."""
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="initial brief"),
            AIMessage(content="okay, planning..."),  # no tool_calls
            HumanMessage(content="actually here's a clarification"),
        ],
        "builder_non_artifact_turns": 2,
    }
    assert middleware.before_model(state) is None


def test_no_reset_when_counter_already_zero():
    """If the counter is already 0, nothing to reset (return None to avoid
    an empty no-op state update)."""
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            HumanMessage(content="initial"),
            _ai_with_tool_calls(),
            HumanMessage(content="update"),
        ],
        "builder_non_artifact_turns": 0,
    }
    assert middleware.before_model(state) is None


# ---- async parity --------------------------------------------------------


def test_abefore_model_mirrors_before_model_async():
    import asyncio
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            _ai_with_tool_calls(),
            HumanMessage(content="add Y"),
        ],
        "builder_non_artifact_turns": 12,
    }
    result = asyncio.run(middleware.abefore_model(state))
    assert result == {"builder_non_artifact_turns": 0}


# ---- edge cases ----------------------------------------------------------


def test_no_reset_on_empty_messages():
    middleware = BuilderArtifactMiddleware()
    state = {"messages": [], "builder_non_artifact_turns": 5}
    assert middleware.before_model(state) is None


def test_no_reset_when_state_missing_messages():
    middleware = BuilderArtifactMiddleware()
    state = {"builder_non_artifact_turns": 5}
    assert middleware.before_model(state) is None


def test_system_message_is_ignored_in_search():
    """SystemMessage in history doesn't satisfy the AIMessage-with-tool_calls
    requirement."""
    middleware = BuilderArtifactMiddleware()
    state = {
        "messages": [
            SystemMessage(content="you are a builder"),
            HumanMessage(content="build X"),
            SystemMessage(content="additional context"),
            HumanMessage(content="also add Y"),
        ],
        "builder_non_artifact_turns": 4,
    }
    assert middleware.before_model(state) is None
