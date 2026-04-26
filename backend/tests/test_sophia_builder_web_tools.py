"""Focused tests for Sophia builder web-search guardrails."""

import importlib
import json
from types import SimpleNamespace
from unittest.mock import MagicMock


def _runtime(state: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(state=state or {}, context={}, config={})


def _message_content(result) -> str:
    return result.update["messages"][0].content


def test_builder_web_search_records_allowed_urls_and_sources(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.builder_web_search")
    mock_tool = MagicMock()
    mock_tool.run.return_value = json.dumps(
        [
            {"title": "Example One", "url": "https://example.com/one", "snippet": "Result one"},
            {"title": "Example Two", "url": "https://example.com/two", "snippet": "Result two"},
        ]
    )
    monkeypatch.setattr(module, "_resolve_configured_tool", lambda _name: mock_tool)

    state = {
        "allow_web_research": True,
        "builder_allowed_urls": [],
        "builder_search_sources": [],
        "builder_web_budget": {"search_limit": 3, "fetch_limit": 5, "search_calls": 0, "fetch_calls": 0},
    }

    result = module.builder_web_search.func(runtime=_runtime(state), query="latest example research", tool_call_id="tc-search")
    parsed = json.loads(_message_content(result))

    assert [item["url"] for item in parsed] == [
        "https://example.com/one",
        "https://example.com/two",
    ]
    assert result.update["builder_allowed_urls"] == [
        "https://example.com/one",
        "https://example.com/two",
    ]
    assert result.update["builder_search_sources"][0]["title"] == "Example One"
    assert result.update["builder_web_budget"]["search_calls"] == 1
    assert state["builder_allowed_urls"] == []
    assert state["builder_web_budget"]["search_calls"] == 0


def test_builder_web_search_respects_policy_gate():
    module = importlib.import_module("deerflow.sophia.tools.builder_web_search")
    state = {
        "allow_web_research": False,
        "builder_web_budget": {"search_limit": 3, "fetch_limit": 5, "search_calls": 0, "fetch_calls": 0},
    }

    result = module.builder_web_search.func(runtime=_runtime(state), query="do not browse", tool_call_id="tc-search")

    assert _message_content(result) == "Error: Web research is disabled for this builder task."
    assert set(result.update) == {"messages"}


def test_builder_web_fetch_accepts_allowed_and_explicit_urls(monkeypatch):
    """The fetch tool now writes per-call deltas (``{"fetch_calls": 1}``)
    rather than the whole budget dict — the reducer
    ``_merge_builder_web_budget`` sums deltas at the LangGraph layer so
    parallel bursts no longer collapse increments. This test simulates two
    sequential fetches and verifies the delta contract; reducer-level
    accumulation is covered by the dedicated reducer tests in
    ``test_sophia_state_schema_invariants.py``."""
    from deerflow.agents.sophia_agent.state import _merge_builder_web_budget

    module = importlib.import_module("deerflow.sophia.tools.builder_web_fetch")
    mock_tool = MagicMock()
    mock_tool.run.return_value = "# Example Page\n\nFetched body"
    monkeypatch.setattr(module, "_resolve_configured_tool", lambda _name: mock_tool)

    state = {
        "allow_web_research": True,
        "builder_allowed_urls": ["https://example.com/approved"],
        "explicit_user_urls": ["https://example.com/from-brief"],
        "builder_search_sources": [],
        "builder_web_budget": {"search_limit": 3, "fetch_limit": 5, "search_calls": 0, "fetch_calls": 0},
    }

    approved = module.builder_web_fetch.func(
        runtime=_runtime(state),
        url="https://example.com/approved",
        tool_call_id="tc-fetch-approved",
    )

    # Apply the approved-call delta through the SAME reducer LangGraph uses,
    # then run the second fetch on the merged state. This is the integration
    # equivalent of two sequential super-steps.
    merged_budget = _merge_builder_web_budget(
        state["builder_web_budget"], approved.update["builder_web_budget"]
    )
    updated_state = dict(state)
    updated_state.update(
        {
            "builder_search_sources": approved.update["builder_search_sources"],
            "builder_web_budget": merged_budget,
        }
    )
    explicit = module.builder_web_fetch.func(
        runtime=_runtime(updated_state),
        url="https://example.com/from-brief",
        tool_call_id="tc-fetch-explicit",
    )

    assert _message_content(approved).startswith("# Example Page")
    assert _message_content(explicit).startswith("# Example Page")
    # Delta contract: each tool invocation writes a +1 delta, NOT an absolute.
    assert approved.update["builder_web_budget"] == {"fetch_calls": 1}
    assert explicit.update["builder_web_budget"] == {"fetch_calls": 1}
    # End-to-end accumulation happens through the reducer.
    final_budget = _merge_builder_web_budget(
        merged_budget, explicit.update["builder_web_budget"]
    )
    assert final_budget["fetch_calls"] == 2
    assert final_budget["fetch_limit"] == 5  # static limit preserved
    assert {item["url"] for item in explicit.update["builder_search_sources"]} == {
        "https://example.com/approved",
        "https://example.com/from-brief",
    }


def test_builder_web_fetch_rejects_unapproved_url():
    module = importlib.import_module("deerflow.sophia.tools.builder_web_fetch")
    state = {
        "allow_web_research": True,
        "builder_allowed_urls": ["https://example.com/approved"],
        "explicit_user_urls": [],
        "builder_web_budget": {"search_limit": 3, "fetch_limit": 5, "search_calls": 0, "fetch_calls": 0},
    }

    result = module.builder_web_fetch.func(runtime=_runtime(state), url="https://example.com/blocked", tool_call_id="tc-fetch")

    assert _message_content(result).startswith("Error: URL not allowed for builder_web_fetch.")
    assert set(result.update) == {"messages"}


def test_builder_web_budget_exhaustion_short_circuits_provider(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.builder_web_search")
    mock_tool = MagicMock()
    monkeypatch.setattr(module, "_resolve_configured_tool", lambda _name: mock_tool)
    state = {
        "allow_web_research": True,
        "builder_allowed_urls": [],
        "builder_search_sources": [],
        "builder_web_budget": {"search_limit": 1, "fetch_limit": 5, "search_calls": 1, "fetch_calls": 0},
    }

    result = module.builder_web_search.func(runtime=_runtime(state), query="over budget", tool_call_id="tc-search")

    assert _message_content(result).startswith("Error: Builder search budget exhausted")
    mock_tool.run.assert_not_called()
