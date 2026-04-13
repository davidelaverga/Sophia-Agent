"""Focused tests for Sophia builder web-search guardrails."""

import importlib
import json
from types import SimpleNamespace
from unittest.mock import MagicMock


def _runtime(state: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(state=state or {}, context={}, config={})


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

    result = module.builder_web_search.func(runtime=_runtime(state), query="latest example research")
    parsed = json.loads(result)

    assert [item["url"] for item in parsed] == [
        "https://example.com/one",
        "https://example.com/two",
    ]
    assert state["builder_allowed_urls"] == [
        "https://example.com/one",
        "https://example.com/two",
    ]
    assert state["builder_search_sources"][0]["title"] == "Example One"
    assert state["builder_web_budget"]["search_calls"] == 1


def test_builder_web_search_respects_policy_gate():
    module = importlib.import_module("deerflow.sophia.tools.builder_web_search")
    state = {
        "allow_web_research": False,
        "builder_web_budget": {"search_limit": 3, "fetch_limit": 5, "search_calls": 0, "fetch_calls": 0},
    }

    result = module.builder_web_search.func(runtime=_runtime(state), query="do not browse")

    assert result == "Error: Web research is disabled for this builder task."


def test_builder_web_fetch_accepts_allowed_and_explicit_urls(monkeypatch):
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

    approved = module.builder_web_fetch.func(runtime=_runtime(state), url="https://example.com/approved")
    explicit = module.builder_web_fetch.func(runtime=_runtime(state), url="https://example.com/from-brief")

    assert approved.startswith("# Example Page")
    assert explicit.startswith("# Example Page")
    assert state["builder_web_budget"]["fetch_calls"] == 2
    assert {item["url"] for item in state["builder_search_sources"]} == {
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

    result = module.builder_web_fetch.func(runtime=_runtime(state), url="https://example.com/blocked")

    assert result.startswith("Error: URL not allowed for builder_web_fetch.")


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

    result = module.builder_web_search.func(runtime=_runtime(state), query="over budget")

    assert result.startswith("Error: Builder search budget exhausted")
    mock_tool.run.assert_not_called()
