"""Guarded builder-only web fetch tool."""

from __future__ import annotations

import re

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.sophia.builder_web_policy import normalize_builder_web_url
from deerflow.sophia.tools.builder_web_search import _budget_guard, _merge_source_records, _resolve_configured_tool

_TITLE_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)


def _extract_title(content: str, fallback_url: str) -> str:
    match = _TITLE_RE.search(content or "")
    if match:
        return match.group(1).strip()
    return fallback_url


@tool("builder_web_fetch", parse_docstring=True)
def builder_web_fetch(runtime: ToolRuntime[ContextT, SophiaState], url: str) -> str:
    """Fetch an exact URL already approved for the current builder task.

    Only fetch exact URLs returned by builder_web_search or explicitly present in
    the delegated brief.

    Args:
        url: Exact URL to fetch.
    """
    if runtime.state is None:
        return "Error: Builder runtime state is not available."

    state = runtime.state
    if not state.get("allow_web_research"):
        return "Error: Web fetch is disabled for this builder task."

    normalized_url = normalize_builder_web_url(url)
    allowed_urls = {
        normalize_builder_web_url(str(item))
        for item in (state.get("builder_allowed_urls") or [])
        if str(item).strip()
    }
    explicit_urls = {
        normalize_builder_web_url(str(item))
        for item in (state.get("explicit_user_urls") or [])
        if str(item).strip()
    }
    allowed_urls.update(explicit_urls)
    if normalized_url not in allowed_urls:
        return (
            "Error: URL not allowed for builder_web_fetch. "
            "Only exact URLs provided in the task brief or returned by builder_web_search may be fetched."
        )

    budget_error = _budget_guard(state, "fetch")
    if budget_error:
        return budget_error

    fetch_tool = _resolve_configured_tool("web_fetch")
    if fetch_tool is None:
        return "Error: No configured web_fetch provider is available."

    raw_result = fetch_tool.run(normalized_url)
    if not isinstance(raw_result, str):
        return "Error: Configured web_fetch provider returned a non-text response."
    if raw_result.startswith("Error:"):
        return raw_result

    existing_sources = [
        source
        for source in (state.get("builder_search_sources") or [])
        if isinstance(source, dict)
    ]
    source_record = {
        "title": _extract_title(raw_result, normalized_url),
        "url": normalized_url,
        "snippet": "",
        "query": "explicit_fetch",
    }
    state["builder_search_sources"] = _merge_source_records(existing_sources, [source_record])
    return raw_result
