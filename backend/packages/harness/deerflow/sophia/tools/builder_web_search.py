"""Guarded builder-only web search tool."""

from __future__ import annotations

import json
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.types import Command
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


def _tool_response(
    tool_call_id: str,
    content: str,
    *,
    tool_name: str,
    **updates: object,
) -> Command:
    payload = {
        **updates,
        "messages": [ToolMessage(content=content, tool_call_id=tool_call_id, name=tool_name)],
    }
    return Command(update=payload)


def _budget_guard(state: SophiaState, key: str) -> tuple[dict[str, int], str | None]:
    budget = dict(state.get("builder_web_budget") or {})
    limit_key = f"{key}_limit"
    calls_key = f"{key}_calls"
    limit = int(budget.get(limit_key, 0) or 0)
    calls = int(budget.get(calls_key, 0) or 0)
    if limit and calls >= limit:
        return budget, f"Error: Builder {key} budget exhausted ({calls}/{limit}). Continue without more browsing."
    budget[calls_key] = calls + 1
    return budget, None


@tool("builder_web_search", parse_docstring=True)
def builder_web_search(
    runtime: ToolRuntime[ContextT, SophiaState],
    query: str,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
) -> Command:
    """Search the web for current external information during builder execution.

    Use this only when the delegated task explicitly allows web research.

    Args:
        query: Search query for the external information needed.
    """
    if runtime.state is None:
        return _tool_response(tool_call_id, "Error: Builder runtime state is not available.", tool_name="builder_web_search")

    state = runtime.state
    if not state.get("allow_web_research"):
        return _tool_response(tool_call_id, "Error: Web research is disabled for this builder task.", tool_name="builder_web_search")

    budget, budget_error = _budget_guard(state, "search")
    if budget_error:
        return _tool_response(tool_call_id, budget_error, tool_name="builder_web_search")

    search_tool = _resolve_configured_tool("web_search")
    if search_tool is None:
        return _tool_response(
            tool_call_id,
            "Error: No configured web_search provider is available.",
            tool_name="builder_web_search",
            builder_web_budget=budget,
        )

    raw_result = search_tool.run(query)
    if not isinstance(raw_result, str):
        return _tool_response(
            tool_call_id,
            "Error: Configured web_search provider returned a non-text response.",
            tool_name="builder_web_search",
            builder_web_budget=budget,
        )
    if raw_result.startswith("Error:"):
        return _tool_response(tool_call_id, raw_result, tool_name="builder_web_search", builder_web_budget=budget)

    try:
        parsed = json.loads(raw_result)
    except json.JSONDecodeError:
        return _tool_response(
            tool_call_id,
            "Error: Configured web_search provider returned invalid JSON.",
            tool_name="builder_web_search",
            builder_web_budget=budget,
        )

    if not isinstance(parsed, list):
        return _tool_response(
            tool_call_id,
            "Error: Configured web_search provider returned an unexpected payload.",
            tool_name="builder_web_search",
            builder_web_budget=budget,
        )

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
    updated_allowed_urls = sorted(allowed_urls)

    existing_sources = [
        source
        for source in (state.get("builder_search_sources") or [])
        if isinstance(source, dict)
    ]
    updated_sources = _merge_source_records(existing_sources, normalized_results)

    response_payload = [
        {"title": result["title"], "url": result["url"], "snippet": result["snippet"]}
        for result in normalized_results
    ]
    return _tool_response(
        tool_call_id,
        json.dumps(response_payload, indent=2, ensure_ascii=False),
        tool_name="builder_web_search",
        builder_web_budget=budget,
        builder_allowed_urls=updated_allowed_urls,
        builder_search_sources=updated_sources,
    )
