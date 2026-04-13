"""Guarded builder-only web search tool."""

from __future__ import annotations

import json
from typing import Any

from langchain.tools import ToolRuntime, tool
from langchain_core.tools import BaseTool
from langgraph.typing import ContextT

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.config.app_config import get_app_config
from deerflow.reflection.resolvers import resolve_variable
from deerflow.sophia.builder_web_policy import normalize_builder_web_url


def _resolve_configured_tool(name: str) -> BaseTool | None:
    config = get_app_config().get_tool_config(name)
    if config is None:
        return None
    return resolve_variable(config.use, BaseTool)


def _normalize_search_result(item: Any, query: str) -> dict[str, str] | None:
    if not isinstance(item, dict):
        return None

    url = normalize_builder_web_url(str(item.get("url", "")).strip())
    if not url:
        return None

    title = str(item.get("title", "")).strip() or url
    snippet = str(item.get("snippet", "")).strip()
    return {
        "title": title,
        "url": url,
        "snippet": snippet,
        "query": query,
    }


def _merge_source_records(existing: list[dict[str, str]], new_sources: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: dict[str, dict[str, str]] = {}
    for source in existing:
        if isinstance(source, dict) and source.get("url"):
            merged[str(source["url"])] = dict(source)
    for source in new_sources:
        merged[source["url"]] = dict(source)
    return list(merged.values())


def _budget_guard(state: SophiaState, key: str) -> str | None:
    budget = dict(state.get("builder_web_budget") or {})
    limit_key = f"{key}_limit"
    calls_key = f"{key}_calls"
    limit = int(budget.get(limit_key, 0) or 0)
    calls = int(budget.get(calls_key, 0) or 0)
    if limit and calls >= limit:
        return f"Error: Builder {key} budget exhausted ({calls}/{limit}). Continue without more browsing."
    budget[calls_key] = calls + 1
    state["builder_web_budget"] = budget
    return None


@tool("builder_web_search", parse_docstring=True)
def builder_web_search(runtime: ToolRuntime[ContextT, SophiaState], query: str) -> str:
    """Search the web for current external information during builder execution.

    Use this only when the delegated task explicitly allows web research.

    Args:
        query: Search query for the external information needed.
    """
    if runtime.state is None:
        return "Error: Builder runtime state is not available."

    state = runtime.state
    if not state.get("allow_web_research"):
        return "Error: Web research is disabled for this builder task."

    budget_error = _budget_guard(state, "search")
    if budget_error:
        return budget_error

    search_tool = _resolve_configured_tool("web_search")
    if search_tool is None:
        return "Error: No configured web_search provider is available."

    raw_result = search_tool.run(query)
    if not isinstance(raw_result, str):
        return "Error: Configured web_search provider returned a non-text response."
    if raw_result.startswith("Error:"):
        return raw_result

    try:
        parsed = json.loads(raw_result)
    except json.JSONDecodeError:
        return "Error: Configured web_search provider returned invalid JSON."

    if not isinstance(parsed, list):
        return "Error: Configured web_search provider returned an unexpected payload."

    normalized_results = [
        normalized
        for item in parsed
        if (normalized := _normalize_search_result(item, query)) is not None
    ]

    allowed_urls = {
        normalize_builder_web_url(str(url))
        for url in (state.get("builder_allowed_urls") or [])
        if str(url).strip()
    }
    allowed_urls.update(result["url"] for result in normalized_results)
    state["builder_allowed_urls"] = sorted(allowed_urls)

    existing_sources = [
        source
        for source in (state.get("builder_search_sources") or [])
        if isinstance(source, dict)
    ]
    state["builder_search_sources"] = _merge_source_records(existing_sources, normalized_results)

    response_payload = [
        {"title": result["title"], "url": result["url"], "snippet": result["snippet"]}
        for result in normalized_results
    ]
    return json.dumps(response_payload, indent=2, ensure_ascii=False)
