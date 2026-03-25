"""Platform context middleware.

Sets the platform state field and injects platform-specific response
length guidance into system_prompt_blocks.
"""

from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

PLATFORM_PROMPTS = {
    "voice": "Platform: voice. Respond in 1-3 sentences. Spoken rhythm. Think before each word.",
    "text": "Platform: in-app text. Respond in 2-5 sentences. Same directness, slightly more space.",
    "ios_voice": "Platform: iOS voice. Respond in 1-3 sentences. Spoken rhythm. Same as voice.",
}


class PlatformContextState(AgentState):
    platform: NotRequired[str]
    skip_expensive: NotRequired[bool]
    system_prompt_blocks: NotRequired[list[str]]


class PlatformContextMiddleware(AgentMiddleware[PlatformContextState]):
    """Set platform signal and inject response length guidance."""

    state_schema = PlatformContextState

    @override
    def before_agent(self, state: PlatformContextState, runtime: Runtime) -> dict | None:
        if state.get("skip_expensive", False):
            return None

        platform = runtime.context.get("platform", "voice")
        if platform not in PLATFORM_PROMPTS:
            platform = "voice"

        return {
            "platform": platform,
            "system_prompt_blocks": [PLATFORM_PROMPTS[platform]],
        }
