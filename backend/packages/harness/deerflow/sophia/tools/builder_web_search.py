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
    """Read the current ``*_calls`` counter, enforce the ``*_limit`` cap,
    and return a per-tool DELTA to write to state.

    Returns:
        ``(delta, error)`` — ``delta`` is a per-tool patch like
        ``{"<key>_calls": 1}`` that the caller passes to
        ``_tool_response(... builder_web_budget=delta)``. The
        ``_merge_builder_web_budget`` reducer in
        ``deerflow.agents.sophia_agent.state`` SUMS ``*_calls`` keys, so
        concurrent tool bursts in the same super-step add up correctly
        without collapsing to a single increment (the bug codex bot
        flagged on PR #81). On error the delta is ``{}`` — the caller
        bails out before consuming a call, so no state mutation is
        necessary; passing an empty dict to the reducer is a no-op.

    The function still does the read-side check (``calls >= limit``) so
    a parallel burst at the boundary can over-count by at most ``N-1``
    where ``N`` is the parallel fan-out per turn, instead of
    under-counting by ``N-1`` as the prior absolute-write+max-reducer
    did. Bounded over-count is preferable to bounded under-count because
    it preserves the spend ceiling.
    """
    budget = dict(state.get("builder_web_budget") or {})
    limit_key = f"{key}_limit"
    calls_key = f"{key}_calls"
    limit = int(budget.get(limit_key, 0) or 0)
    calls = int(budget.get(calls_key, 0) or 0)
    if limit and calls >= limit:
        return {}, f"Error: Builder {key} budget exhausted ({calls}/{limit}). Continue without more browsing."
    return {calls_key: 1}, None


def _search_error(tool_call_id: str, content: str, budget: dict[str, int] | None = None) -> Command:
    updates: dict[str, object] = {}
    if budget is not None:
        updates["builder_web_budget"] = budget
    return _tool_response(tool_call_id, content, tool_name="builder_web_search", **updates)


def _configured_search_result(query: str) -> tuple[str | None, str | None]:
    search_tool = _resolve_configured_tool("web_search")
    if search_tool is None:
        return None, "Error: No configured web_search provider is available."
    raw_result = search_tool.run(query)
    if not isinstance(raw_result, str):
        return None, "Error: Configured web_search provider returned a non-text response."
    if raw_result.startswith("Error:"):
        return None, raw_result
    return raw_result, None


def _parsed_search_payload(raw_result: str) -> tuple[list[Any] | None, str | None]:
    try:
        parsed = json.loads(raw_result)
    except json.JSONDecodeError:
        return None, "Error: Configured web_search provider returned invalid JSON."
    if not isinstance(parsed, list):
        return None, "Error: Configured web_search provider returned an unexpected payload."
    return parsed, None


def _normalized_search_results(parsed: list[Any], query: str) -> list[dict[str, str]]:
    return [
        normalized
        for item in parsed
        if (normalized := _normalize_search_result(item, query)) is not None
    ]


def _updated_allowed_urls(state: SophiaState, normalized_results: list[dict[str, str]]) -> list[str]:
    allowed_urls = {
        normalize_builder_web_url(str(url))
        for url in (state.get("builder_allowed_urls") or [])
        if str(url).strip()
    }
    allowed_urls.update(result["url"] for result in normalized_results)
    return sorted(allowed_urls)


def _existing_search_sources(state: SophiaState) -> list[dict[str, str]]:
    return [
        source
        for source in (state.get("builder_search_sources") or [])
        if isinstance(source, dict)
    ]


def _public_search_payload(normalized_results: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        {"title": result["title"], "url": result["url"], "snippet": result["snippet"]}
        for result in normalized_results
    ]


@tool("builder_web_search", parse_docstring=True)
def builder_web_search(
    runtime: ToolRuntime[ContextT, SophiaState],
    query: str,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
) -> Command:
    """Search the web for current external information during builder execution.

    Builder tasks should attempt web research before substantive artifact
    writing, editing, or emitting.

    Args:
        query: Search query for the external information needed.
    """
    if runtime.state is None:
        return _search_error(tool_call_id, "Error: Builder runtime state is not available.")

    state = runtime.state
    budget, budget_error = _budget_guard(state, "search")
    if budget_error:
        return _search_error(tool_call_id, budget_error)

    raw_result, provider_error = _configured_search_result(query)
    if provider_error is not None or raw_result is None:
        return _search_error(tool_call_id, provider_error or "Error: web_search failed.", budget)

    parsed, parse_error = _parsed_search_payload(raw_result)
    if parse_error is not None or parsed is None:
        return _search_error(tool_call_id, parse_error or "Error: web_search parse failed.", budget)

    normalized_results = _normalized_search_results(parsed, query)
    existing_sources = _existing_search_sources(state)
    updated_sources = _merge_source_records(existing_sources, normalized_results)

    return _tool_response(
        tool_call_id,
        json.dumps(_public_search_payload(normalized_results), indent=2, ensure_ascii=False),
        tool_name="builder_web_search",
        builder_web_budget=budget,
        builder_allowed_urls=_updated_allowed_urls(state, normalized_results),
        builder_search_sources=updated_sources,
    )
