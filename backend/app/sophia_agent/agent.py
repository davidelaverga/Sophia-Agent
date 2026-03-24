"""make_sophia_agent — factory for the Sophia companion agent.

Follows the same factory pattern as DeerFlow's make_lead_agent().
The 14-middleware chain is assembled here. Order is load-bearing.
"""

from __future__ import annotations

import os
from pathlib import Path

from langchain_anthropic import ChatAnthropic
from langchain_core.runnables import RunnableConfig

from app.sophia_agent.middlewares.artifact import ArtifactMiddleware
from app.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
from app.sophia_agent.middlewares.crisis_check import CrisisCheckMiddleware
from app.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from app.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
from app.sophia_agent.middlewares.platform_context import PlatformContextMiddleware
from app.sophia_agent.middlewares.ritual import RitualMiddleware
from app.sophia_agent.middlewares.session_state import SessionStateMiddleware
from app.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
from app.sophia_agent.middlewares.summarization import SophiaSummarizationMiddleware
from app.sophia_agent.middlewares.title import SophiaTitleMiddleware
from app.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
from app.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from app.sophia_agent.state import SophiaState
from app.sophia.tools.emit_artifact import emit_artifact
from app.sophia.tools.retrieve_memories import retrieve_memories
from app.sophia.tools.switch_to_builder import switch_to_builder
from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware

# Skills path — override via SOPHIA_SKILLS_PATH env var
SKILLS_PATH = Path(os.environ.get("SOPHIA_SKILLS_PATH", "skills/public/sophia"))


def make_sophia_agent(config: RunnableConfig):
    """Build the Sophia companion agent with full middleware chain.

    Called by LangGraph on every invocation. Config must include:
      configurable.user_id   — required
      configurable.platform  — "voice" | "text" | "ios_voice"
      configurable.ritual    — "prepare" | "debrief" | "vent" | "reset" | None
      configurable.context_mode — "work" | "gaming" | "life"
    """
    cfg = config.get("configurable", {})
    user_id = cfg.get("user_id", "default_user")
    ritual = cfg.get("ritual", None)
    context_mode = cfg.get("context_mode", "life")

    model = ChatAnthropic(
        model="claude-haiku-4-5-20251001",
        api_key=os.environ["ANTHROPIC_API_KEY"],
    )

    # ── 14-middleware chain — order is law ──
    middlewares = [
        # 1. Infrastructure
        ThreadDataMiddleware(),
        # 2. Crisis fast-path — BEFORE any expensive middleware
        CrisisCheckMiddleware(),
        # 3. Always-loaded identity files
        FileInjectionMiddleware(SKILLS_PATH / "soul.md"),
        FileInjectionMiddleware(SKILLS_PATH / "voice.md", skip_on_crisis=True),
        FileInjectionMiddleware(SKILLS_PATH / "techniques.md", skip_on_crisis=True),
        # 4. Platform signal
        PlatformContextMiddleware(),
        # 5–6. User context
        UserIdentityMiddleware(user_id),
        SessionStateMiddleware(user_id),
        # 7–9. Calibration — tone THEN context THEN ritual
        ToneGuidanceMiddleware(SKILLS_PATH / "tone_guidance.md"),
        ContextAdaptationMiddleware(SKILLS_PATH / "context", context_mode),
        RitualMiddleware(SKILLS_PATH / "rituals", ritual),
        # 10. Skill routing — reads tone band + ritual from state
        SkillRouterMiddleware(SKILLS_PATH / "skills"),
        # 11. Memory — after ritual+skill set
        Mem0MemoryMiddleware(user_id),
        # 12. Artifact system
        ArtifactMiddleware(SKILLS_PATH / "artifact_instructions.md"),
        # 13–14. DeerFlow (adapted)
        SophiaTitleMiddleware(),
        SophiaSummarizationMiddleware(),
    ]

    tools = [emit_artifact, switch_to_builder, retrieve_memories]

    # TODO(jorge): Wire up make_agent_with_middlewares once middleware
    # protocol is finalized. For now return the components for testing.
    return {
        "model": model,
        "tools": tools,
        "middlewares": middlewares,
        "state_schema": SophiaState,
        "config": config,
    }
