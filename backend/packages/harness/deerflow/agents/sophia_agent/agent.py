"""Sophia companion agent factory.

Creates the Sophia companion agent with its middleware chain.
"""

import logging
import os

from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware
from langchain_anthropic import ChatAnthropic
from langchain_core.runnables import RunnableConfig

from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware
from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_session import BuilderSessionMiddleware
from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
from deerflow.agents.sophia_agent.middlewares.crisis_check import CrisisCheckMiddleware
from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
from deerflow.agents.sophia_agent.middlewares.platform_context import PlatformContextMiddleware
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
from deerflow.agents.sophia_agent.middlewares.session_state import SessionStateMiddleware
from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
from deerflow.agents.sophia_agent.middlewares.title import SophiaTitleMiddleware
from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
from deerflow.agents.sophia_agent.middlewares.turn_count import TurnCountMiddleware
from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from deerflow.agents.sophia_agent.paths import SKILLS_PATH
from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.config.summarization_config import get_summarization_config
from deerflow.models import create_chat_model
from deerflow.sophia.tools.emit_artifact import emit_artifact
from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool
from deerflow.sophia.tools.switch_to_builder import switch_to_builder

logger = logging.getLogger(__name__)


def _create_summarization_middleware() -> SummarizationMiddleware | None:
    """Create a SummarizationMiddleware instance from app config."""
    config = get_summarization_config()
    if not config.enabled:
        return None

    trigger = None
    if config.trigger is not None:
        if isinstance(config.trigger, list):
            trigger = [item.to_tuple() for item in config.trigger]
        else:
            trigger = config.trigger.to_tuple()

    model = config.model_name if config.model_name else create_chat_model(thinking_enabled=False)

    kwargs: dict = {
        "model": model,
        "trigger": trigger,
        "keep": config.keep.to_tuple(),
    }
    if config.trim_tokens_to_summarize is not None:
        kwargs["trim_tokens_to_summarize"] = config.trim_tokens_to_summarize
    if config.summary_prompt is not None:
        kwargs["summary_prompt"] = config.summary_prompt

    return SummarizationMiddleware(**kwargs)


def make_sophia_agent(config: RunnableConfig):
    """Create the Sophia companion agent with its full middleware chain.

    Configurable parameters (via config["configurable"]):
        user_id: User identifier (default: "default_user")
        platform: "voice" | "text" | "ios_voice" (default: "voice")
        ritual: "prepare" | "debrief" | "vent" | "reset" | None (default: None)
        context_mode: "work" | "gaming" | "life" (default: "life")
    """
    cfg = config.get("configurable", {})
    user_id = validate_user_id(cfg.get("user_id", "default_user"))
    platform = cfg.get("platform", "voice")
    ritual = cfg.get("ritual", None)
    context_mode = cfg.get("context_mode", "life")

    logger.info(
        "Creating Sophia companion agent: user_id=%s, platform=%s, ritual=%s, context_mode=%s",
        user_id,
        platform,
        ritual,
        context_mode,
    )

    model = ChatAnthropic(
        model="claude-haiku-4-5-20251001",
        api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        max_tokens=4096,
    )

    # Middleware chain — order is load-bearing.
    middlewares = [
        # 1. Infrastructure
        ThreadDataMiddleware(lazy_init=True),
        # 2. Crisis fast-path (before any expensive middleware)
        CrisisCheckMiddleware(),
        # 3. Always-loaded identity files (soul always, voice+techniques skip on crisis)
        FileInjectionMiddleware(
            (SKILLS_PATH / "soul.md", False),
            (SKILLS_PATH / "voice.md", True),
            (SKILLS_PATH / "techniques.md", True),
        ),
        # 4. Platform signal
        PlatformContextMiddleware(),
        # 5. Derive prior completed turns before first-turn-only middleware runs.
        TurnCountMiddleware(),
        # 6-7. User context
        UserIdentityMiddleware(user_id),
        SessionStateMiddleware(user_id),
        # 8-10. Calibration (order matters: tone -> context -> ritual -> skill)
        ToneGuidanceMiddleware(SKILLS_PATH / "tone_guidance.md"),
        ContextAdaptationMiddleware(SKILLS_PATH / "context", context_mode),
        RitualMiddleware(SKILLS_PATH / "rituals", ritual),
        # 11. Skill routing (reads tone band + ritual from state)
        SkillRouterMiddleware(SKILLS_PATH / "skills"),
        # 12. Memory (after ritual+skill set — retrieval biased by both)
        Mem0MemoryMiddleware(user_id),
        # 13. Builder session tracking (must run before ArtifactMiddleware synthesis)
        BuilderSessionMiddleware(),
        # 14. Artifact system
        ArtifactMiddleware(SKILLS_PATH / "artifact_instructions.md"),
    ]

    # 16. Summarization (config-driven trigger/keep policy)
    summarization_middleware = _create_summarization_middleware()
    if summarization_middleware is not None:
        middlewares.append(summarization_middleware)

    # Post-chain: prompt assembly, title
    middlewares.extend(
        [
            PromptAssemblyMiddleware(),
            SophiaTitleMiddleware(),
        ]
    )

    retrieve_memories = make_retrieve_memories_tool(user_id)
    tools = [emit_artifact, switch_to_builder, retrieve_memories]

    agent = create_agent(
        model=model,
        tools=tools,
        middleware=middlewares,
        state_schema=SophiaState,
    )
    # Sophia typically needs 2 model calls per turn (response + tool + end_turn).
    # Set higher than default 25 to handle multi-tool turns gracefully.
    agent.recursion_limit = 50
    return agent
