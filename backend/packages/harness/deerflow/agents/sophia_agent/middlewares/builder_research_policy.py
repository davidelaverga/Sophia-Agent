"""Builder-only policy middleware for autonomous web research."""

from __future__ import annotations

import time
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.builder_web_policy import make_builder_web_budget


def _merged_explicit_user_urls(
    state: dict[str, Any], delegation_context: dict[str, Any]
) -> list[str]:
    explicit_user_urls: list[str] = []
    seen_explicit_urls: set[str] = set()
    for source in (
        delegation_context.get("explicit_user_urls") or [],
        state.get("explicit_user_urls") or [],
        state.get("builder_update_required_urls") or [],
    ):
        values = source if isinstance(source, list) else []
        for url in values:
            normalized = str(url).strip()
            if normalized and normalized not in seen_explicit_urls:
                seen_explicit_urls.add(normalized)
                explicit_user_urls.append(normalized)
    return explicit_user_urls


class BuilderResearchPolicyState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]
    delegation_context: NotRequired[dict | None]
    allow_web_research: NotRequired[bool]
    explicit_user_urls: NotRequired[list[str]]
    # NOTE: builder_allowed_urls / builder_search_sources / builder_web_budget
    # are NOT redeclared here. SophiaState already declares them with the
    # `_union_string_list` / `_merge_search_sources` / `_merge_builder_web_budget`
    # reducers respectively. Redeclaring them as plain `NotRequired[...]` would
    # shadow those reducers via langchain.agents.create_agent's set-based
    # schema merge, downgrade the channels to LastValue, and crash parallel
    # `builder_web_search` / `builder_web_fetch` tool calls with
    # `INVALID_CONCURRENT_GRAPH_UPDATE`. The
    # `tests/test_sophia_state_schema_invariants.py` guard locks this.


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
        allow_web_research = True
        explicit_user_urls = _merged_explicit_user_urls(state, delegation_context)

        # `_merge_builder_web_budget` SUMS *_calls keys (delta semantics) so
        # the middleware MUST be init-once for this field — re-writing the
        # whole dict on every turn would double-count the counters tools have
        # accumulated. We seed the budget on the first turn and skip the
        # write thereafter; tools own the *_calls deltas via the reducer
        # while *_limit values are static and last-wins (idempotent).
        existing_budget = state.get("builder_web_budget") or {}
        if existing_budget:
            budget = dict(existing_budget)
            seed_budget = False
        else:
            budget = dict(delegation_context.get("builder_web_budget") or make_builder_web_budget(task_type))
            seed_budget = True
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
        block = (
            "<builder_research_policy>\n"
            "Autonomous web research is enabled for this delegated builder task, regardless of task type.\n"
            f"- Search budget: {budget.get('search_limit', 0)} calls total.\n"
            f"- Fetch budget: {budget.get('fetch_limit', 0)} calls total.\n"
            "- Prefer authoritative, primary, or directly relevant sources.\n"
            "- Use builder_web_search for discovery and builder_web_fetch only on exact approved URLs.\n"
            "- You may call write_todos first. Before the first substantive write/edit/emit step, attempt builder_web_search or builder_web_fetch at least once.\n"
            "- For factual documents and PDFs, if builder_web_search returns useful results, fetch at least one approved result URL before final source writing.\n"
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

        blocks.append(block)
        log_middleware(
            "BuilderResearch",
            f"allow_web_research={allow_web_research} search_limit={budget.get('search_limit')} "
            f"fetch_limit={budget.get('fetch_limit')} explicit_urls={len(explicit_user_urls)}",
            _t0,
        )
        update: dict[str, Any] = {
            "system_prompt_blocks": blocks,
            "allow_web_research": allow_web_research,
            "explicit_user_urls": explicit_user_urls,
            "builder_allowed_urls": sorted(allowed_urls),
            "builder_search_sources": tracked_sources,
        }
        if seed_budget:
            # Only on the first turn (when state had no budget yet). On
            # subsequent turns the tools' deltas continue to accumulate via
            # the reducer; we deliberately don't re-write here.
            update["builder_web_budget"] = budget
        return update
