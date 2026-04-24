"""Web research guidance middleware."""

import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

_WEB_RESEARCH_GUIDANCE = """<web_research_guidance>
When you use web_search or web_fetch:
- Base factual claims on the returned results or fetched page content.
- Add inline markdown citations with the source URL immediately after externally sourced claims.
- For longer research outputs, include a short Sources section at the end.
- If builder work used web research, populate emit_builder_artifact.sources_used with the source URLs you relied on.
- Never claim you checked the web unless you actually used the web tools in this turn.
</web_research_guidance>"""


class WebResearchState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]


class WebResearchGuidanceMiddleware(AgentMiddleware[WebResearchState]):
    """Inject source-discipline guidance when Sophia has web tools available."""

    state_schema = WebResearchState

    @override
    def before_agent(self, state: WebResearchState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        blocks = list(state.get("system_prompt_blocks", []))
        blocks.append(_WEB_RESEARCH_GUIDANCE)
        log_middleware("WebResearch", "guidance injected", _t0)
        return {"system_prompt_blocks": blocks}
