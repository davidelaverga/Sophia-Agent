"""Tests for DanglingToolCallMiddleware and its Sophia integration.

These tests cover the exact Anthropic contract we kept breaking in production:
an AIMessage containing one or more ``tool_use`` blocks must be immediately
followed by a ``ToolMessage`` for each id. When a prior tool execution is
interrupted or crashes, the middleware patches the gap before the next model
call so the companion and builder chains never send a malformed history to
Claude.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from deerflow.agents.middlewares.dangling_tool_call_middleware import (
    DanglingToolCallMiddleware,
)


def _ai_with_tool_calls(*tool_calls: dict) -> AIMessage:
    """Build an AIMessage that reports tool_calls in the LangChain shape."""
    return AIMessage(
        content="",
        tool_calls=[
            {
                "id": tc["id"],
                "name": tc.get("name", "unknown"),
                "args": tc.get("args", {}),
            }
            for tc in tool_calls
        ],
    )


class TestDanglingToolCallPatching:
    def test_single_dangling_tool_call_is_patched(self):
        middleware = DanglingToolCallMiddleware()
        messages = [
            HumanMessage(content="Please run web_search"),
            _ai_with_tool_calls({"id": "toolu_abc", "name": "web_search"}),
        ]

        patched = middleware._build_patched_messages(messages)

        assert patched is not None
        assert len(patched) == 3
        assert isinstance(patched[2], ToolMessage)
        assert patched[2].tool_call_id == "toolu_abc"
        assert patched[2].name == "web_search"
        assert patched[2].status == "error"
        assert "interrupted" in patched[2].content.lower()

    def test_multiple_dangling_tool_calls_each_get_patch(self):
        middleware = DanglingToolCallMiddleware()
        messages = [
            HumanMessage(content="Do two things"),
            _ai_with_tool_calls(
                {"id": "toolu_one", "name": "web_search"},
                {"id": "toolu_two", "name": "switch_to_builder"},
            ),
        ]

        patched = middleware._build_patched_messages(messages)

        assert patched is not None
        assert [m.type for m in patched] == ["human", "ai", "tool", "tool"]
        patched_ids = {m.tool_call_id for m in patched if isinstance(m, ToolMessage)}
        assert patched_ids == {"toolu_one", "toolu_two"}

    def test_partial_pairing_only_missing_id_is_patched(self):
        middleware = DanglingToolCallMiddleware()
        messages = [
            HumanMessage(content="partial"),
            _ai_with_tool_calls(
                {"id": "toolu_paired", "name": "web_search"},
                {"id": "toolu_orphan", "name": "switch_to_builder"},
            ),
            ToolMessage(
                content="ok",
                tool_call_id="toolu_paired",
                name="web_search",
            ),
        ]

        patched = middleware._build_patched_messages(messages)

        assert patched is not None
        # Dangling patch is inserted right after the AI message, before the
        # existing ToolMessage for the paired id, so both tool_use blocks have
        # a corresponding ToolMessage in the next messages.
        tool_messages = [m for m in patched if isinstance(m, ToolMessage)]
        assert {m.tool_call_id for m in tool_messages} == {
            "toolu_paired",
            "toolu_orphan",
        }

    def test_fully_paired_history_is_left_alone(self):
        middleware = DanglingToolCallMiddleware()
        messages = [
            HumanMessage(content="ok"),
            _ai_with_tool_calls({"id": "toolu_ok", "name": "web_search"}),
            ToolMessage(content="done", tool_call_id="toolu_ok", name="web_search"),
            AIMessage(content="Here is the answer."),
        ]

        assert middleware._build_patched_messages(messages) is None

    def test_ai_message_without_tool_calls_is_ignored(self):
        middleware = DanglingToolCallMiddleware()
        messages = [
            HumanMessage(content="hello"),
            AIMessage(content="hi there"),
        ]

        assert middleware._build_patched_messages(messages) is None

    def test_multiple_ai_messages_each_get_their_patch(self):
        middleware = DanglingToolCallMiddleware()
        messages = [
            HumanMessage(content="first"),
            _ai_with_tool_calls({"id": "toolu_first", "name": "web_search"}),
            HumanMessage(content="second"),
            _ai_with_tool_calls({"id": "toolu_second", "name": "switch_to_builder"}),
        ]

        patched = middleware._build_patched_messages(messages)

        assert patched is not None
        # Each dangling tool_use is patched directly after its AI message, so
        # the two synthetic ToolMessages are not clustered at the end.
        assert [type(m).__name__ for m in patched] == [
            "HumanMessage",
            "AIMessage",
            "ToolMessage",
            "HumanMessage",
            "AIMessage",
            "ToolMessage",
        ]
        assert patched[2].tool_call_id == "toolu_first"
        assert patched[5].tool_call_id == "toolu_second"


class TestSophiaChainsUseDanglingToolCallMiddleware:
    @pytest.fixture
    def captured_middlewares(self, monkeypatch):
        """Capture the middleware list passed to create_agent for inspection.

        Stubs out heavyweight dependencies (LLM clients, tool resolvers) first,
        then installs capture hooks for ``create_agent`` so the test can
        inspect the middleware list Sophia would pass to LangGraph without
        actually instantiating a real agent.
        """
        monkeypatch.setattr(
            "deerflow.agents.sophia_agent.agent.ChatAnthropic",
            MagicMock(),
        )
        monkeypatch.setattr(
            "deerflow.agents.sophia_agent.builder_agent.ChatAnthropic",
            MagicMock(),
        )
        monkeypatch.setattr(
            "deerflow.agents.sophia_agent.agent.load_sophia_web_tools",
            lambda: [],
        )
        monkeypatch.setattr(
            "deerflow.agents.sophia_agent.builder_agent.load_sophia_web_tools",
            lambda: [],
        )
        monkeypatch.setattr(
            "deerflow.agents.sophia_agent.agent.make_retrieve_memories_tool",
            lambda user_id: MagicMock(name="retrieve_memories"),
        )

        captured: dict[str, list] = {}

        def capture_companion(**kwargs):
            captured["companion"] = list(kwargs.get("middleware", []))
            return SimpleNamespace(recursion_limit=0)

        def capture_builder(**kwargs):
            captured["builder"] = list(kwargs.get("middleware", []))
            return SimpleNamespace(recursion_limit=0)

        monkeypatch.setattr(
            "deerflow.agents.sophia_agent.agent.create_agent",
            capture_companion,
        )
        monkeypatch.setattr(
            "deerflow.agents.sophia_agent.builder_agent.create_agent",
            capture_builder,
        )
        return captured

    def test_companion_chain_includes_dangling_tool_call_middleware(
        self, captured_middlewares
    ):
        from deerflow.agents.sophia_agent.agent import make_sophia_agent

        make_sophia_agent({"configurable": {"user_id": "dangling_test_user"}})

        middlewares = captured_middlewares["companion"]
        assert any(
            isinstance(mw, DanglingToolCallMiddleware) for mw in middlewares
        ), "Sophia companion chain must include DanglingToolCallMiddleware"

    def test_builder_chain_includes_dangling_tool_call_middleware(
        self, captured_middlewares
    ):
        from deerflow.agents.sophia_agent.builder_agent import _create_builder_agent

        _create_builder_agent(user_id="dangling_test_user")

        middlewares = captured_middlewares["builder"]
        assert any(
            isinstance(mw, DanglingToolCallMiddleware) for mw in middlewares
        ), "Sophia builder chain must include DanglingToolCallMiddleware"
