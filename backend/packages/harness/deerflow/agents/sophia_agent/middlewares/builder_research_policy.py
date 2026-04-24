"""Builder-only policy middleware for autonomous web research."""

from __future__ import annotations

import time
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.builder_web_policy import make_builder_web_budget


class BuilderResearchPolicyState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]
    delegation_context: NotRequired[dict | None]
    allow_web_research: NotRequired[bool]
    explicit_user_urls: NotRequired[list[str]]
    # NOTE: `builder_allowed_urls`, `builder_search_sources`, and
    # `builder_web_budget` are intentionally NOT redeclared here. `SophiaState`
    # already declares them with the reducers defined in
    # ``deerflow.agents.sophia_agent.state`` (`_union_string_list`,
    # `_merge_search_sources`, `_merge_builder_web_budget`). Redeclaring them
    # here as plain ``NotRequired[...]`` shadows the reducer annotations when
    # ``langchain.agents.create_agent`` merges middleware state schemas — the
    # last-wins set iteration drops the reducer and downgrades the channel to
    # ``LastValue``. Parallel ``builder_web_search`` / ``builder_web_fetch``
    # tool calls then crash with ``INVALID_CONCURRENT_GRAPH_UPDATE`` at
    # runtime. ``tests/test_sophia_state_schema_invariants.py`` enforces this.


class BuilderResearchPolicyMiddleware(AgentMiddleware[BuilderResearchPolicyState]):
    """Initialize builder web guardrails and inject policy instructions."""

    state_schema = BuilderResearchPolicyState

    @override
    def before_agent(self, state: BuilderResearchPolicyState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        delegation_context: dict[str, Any] = state.get("delegation_context") or {}
        if not delegation_context:
            log_middleware("BuilderResearch", "no delegation_context", _t0)
            return None

        task_type = str(delegation_context.get("task_type", "unknown"))
        allow_web_research = bool(delegation_context.get("allow_web_research", False))
        explicit_user_urls = [
            str(url).strip()
            for url in (delegation_context.get("explicit_user_urls") or [])
            if str(url).strip()
        ]

        budget = dict(state.get("builder_web_budget") or delegation_context.get("builder_web_budget") or make_builder_web_budget(task_type))
        tracked_sources = [
            source
            for source in (state.get("builder_search_sources") or [])
            if isinstance(source, dict) and source.get("url")
        ]
        allowed_urls = {
            str(url).strip()
            for url in (state.get("builder_allowed_urls") or [])
            if str(url).strip()
        }
        allowed_urls.update(explicit_user_urls)

        blocks = list(state.get("system_prompt_blocks", []))
        if allow_web_research:
            block = (
                "<builder_research_policy>\n"
                "Autonomous web research is enabled for this delegated builder task.\n"
                f"- Search budget: {budget.get('search_limit', 0)} calls total.\n"
                f"- Fetch budget: {budget.get('fetch_limit', 0)} calls total.\n"
                "- Prefer authoritative, primary, or directly relevant sources.\n"
                "- Use builder_web_search for discovery and builder_web_fetch only on exact approved URLs.\n"
                "- If web tools fail or return weak results, continue the task without browsing instead of stopping.\n"
                "- If you use external sources, emit_builder_artifact.sources_used MUST contain structured {title, url} items drawn from the sources you actually relied on.\n"
            )
            if task_type == "research":
                block += (
                    "- Research reports must include inline [citation:Title](URL) citations after factual claims and end with a Sources section.\n"
                )
            else:
                block += (
                    "- Non-report deliverables that use external sources must include a concise Sources appendix or a sidecar markdown file.\n"
                )
            if explicit_user_urls:
                block += "- Explicit user URLs are approved fetch targets for this task.\n"
            if tracked_sources:
                block += f"- Tracked sources so far: {len(tracked_sources)}.\n"
            block += "</builder_research_policy>"
        else:
            block = (
                "<builder_research_policy>\n"
                "External browsing is disabled for this delegated builder task.\n"
                "- Do not use builder_web_search or builder_web_fetch unless a later delegated brief explicitly enables browsing.\n"
                "- Complete the task from the provided brief, files, and sandbox tools only.\n"
                "</builder_research_policy>"
            )

        blocks.append(block)
        log_middleware(
            "BuilderResearch",
            f"allow_web_research={allow_web_research} search_limit={budget.get('search_limit')} "
            f"fetch_limit={budget.get('fetch_limit')} explicit_urls={len(explicit_user_urls)}",
            _t0,
        )
        return {
            "system_prompt_blocks": blocks,
            "allow_web_research": allow_web_research,
            "explicit_user_urls": explicit_user_urls,
            "builder_allowed_urls": sorted(allowed_urls),
            "builder_search_sources": tracked_sources,
            "builder_web_budget": budget,
        }
