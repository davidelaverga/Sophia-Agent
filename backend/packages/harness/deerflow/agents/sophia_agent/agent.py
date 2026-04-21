"""Sophia companion agent factory.

Creates the Sophia companion agent with its middleware chain.
"""

import logging
import os

# deepagents v0.5 async subagents (Phase 1 of the migration). The middleware
# is attached only when ``configurable.async_builder`` is truthy, so the
# sync ``switch_to_builder`` path stays the default for the rollout window.
from deepagents.middleware.async_subagents import (  # noqa: E402
    AsyncSubAgent,
    AsyncSubAgentMiddleware,
)
from langchain.agents import create_agent

# Re-export SummarizationMiddleware at module scope so
# ``test_middleware_parity_in_companion_and_builder_chains`` can patch it
# before ``make_sophia_agent`` constructs the middleware chain. The real
# subclass (``SophiaSummarizationMiddleware``) is still imported lazily
# inside ``_create_summarization_middleware`` to avoid startup-time
# coupling.
from langchain.agents.middleware import SummarizationMiddleware  # noqa: F401
from langchain_anthropic import ChatAnthropic
from langchain_core.runnables import RunnableConfig

# Apply defensive langchain patches *before* importing anything that builds
# the agent graph. See deerflow.agents._langchain_patches for details.
from deerflow.agents import _langchain_patches  # noqa: F401
from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware
from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_command import BuilderCommandMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_session import BuilderSessionMiddleware
from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
from deerflow.agents.sophia_agent.middlewares.crisis_check import CrisisCheckMiddleware
from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
from deerflow.agents.sophia_agent.middlewares.message_coercion import MessageCoercionMiddleware
from deerflow.agents.sophia_agent.middlewares.platform_context import PlatformContextMiddleware
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
from deerflow.agents.sophia_agent.middlewares.session_state import SessionStateMiddleware
from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
from deerflow.agents.sophia_agent.middlewares.title import SophiaTitleMiddleware
from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
from deerflow.agents.sophia_agent.middlewares.turn_count import TurnCountMiddleware
from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from deerflow.agents.sophia_agent.middlewares.web_research import WebResearchGuidanceMiddleware
from deerflow.agents.sophia_agent.paths import SKILLS_PATH
from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.agents.sophia_agent.tooling import load_sophia_web_tools
from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.config.summarization_config import get_summarization_config
from deerflow.models import create_chat_model
from deerflow.sophia.tools.emit_artifact import emit_artifact
from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool
from deerflow.sophia.tools.share_builder_artifact import share_builder_artifact
from deerflow.sophia.tools.switch_to_builder import make_switch_to_builder_tool

logger = logging.getLogger(__name__)


# System-prompt preface injected alongside the five async-subagent tools.
# Kept short; the heavy contract lives in ``skills/public/sophia/AGENTS.md``
# (already injected by FileInjectionMiddleware). This block just teaches the
# companion the async vocabulary so it picks the right tool for the user's
# intent.
_ASYNC_BUILDER_SYSTEM_PROMPT = """\
You can delegate long builds to the Sophia builder as a background task.
- To start a build, call ``start_async_task`` with
  ``subagent_type="sophia_builder"`` and a complete, self-contained task
  description that includes the task_type as a prefix (for example
  ``[presentation] Build a 5-slide investor deck...``). The task returns
  a task_id immediately; keep talking to the user while the build runs.
- When the user asks "how's it going?" or enough time has passed, call
  ``check_async_task`` with the task_id.
- If the user course-corrects ("actually, make it 2 slides not 5"), call
  ``update_async_task`` with the task_id and the new instruction. This
  preserves the existing thread so the builder keeps its progress.
- If the user asks you to stop, call ``cancel_async_task``.
- Use ``list_async_tasks`` when the user references "that document we
  started" and you need to recall recent task_ids.
Do not poll on a timer. Only check when the user asks or when you know
enough time has passed that a check is worth offering.
"""


def _build_async_subagent_middleware() -> AsyncSubAgentMiddleware:
    """Build the deepagents AsyncSubAgentMiddleware that exposes the five
    async-task management tools (``start_async_task``, ``check_async_task``,
    ``update_async_task``, ``cancel_async_task``, ``list_async_tasks``) and
    maintains the ``async_tasks`` state channel.

    The ``AsyncSubAgent`` spec omits ``url`` on purpose: this selects the
    ASGI (co-deployed) transport, which routes SDK calls in-process through
    our existing ``langgraph.json`` registration of ``sophia_builder``. Zero
    network hop, zero extra auth configuration. Deploying the builder on a
    separate host later is a one-line change (add ``url=``).
    """
    sophia_builder_spec: AsyncSubAgent = {
        "name": "sophia_builder",
        "description": (
            "Sophia's builder graph. Delegate file-creation, research, "
            "presentation, visual_report, frontend, and document tasks. The "
            "description you send becomes the builder's task brief, so "
            "include all specs the user gave you."
        ),
        "graph_id": "sophia_builder",
    }
    return AsyncSubAgentMiddleware(
        async_subagents=[sophia_builder_spec],
        system_prompt=_ASYNC_BUILDER_SYSTEM_PROMPT,
    )


def _create_summarization_middleware():
    """Create a SophiaSummarizationMiddleware instance from app config."""
    from deerflow.agents.sophia_agent.middlewares.sophia_summarization import SophiaSummarizationMiddleware

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

    return SophiaSummarizationMiddleware(**kwargs)


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
    async_builder_enabled = bool(cfg.get("async_builder", False))

    logger.info(
        "Creating Sophia companion agent: user_id=%s, platform=%s, ritual=%s, context_mode=%s",
        user_id,
        platform,
        ritual,
        context_mode,
    )

    # Voice needs short responses (1-3 sentences) — lower max_tokens reduces generation time.
    # Text mode gets more room for longer responses.
    voice_mode = platform in ("voice", "ios_voice")
    model = ChatAnthropic(
        model="claude-haiku-4-5-20251001",
        api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        max_tokens=512 if voice_mode else 4096,
        timeout=60.0,
    )
    web_tools = load_sophia_web_tools()

    # Middleware chain — order is load-bearing.
    middlewares = [
        # 1. Infrastructure
        ThreadDataMiddleware(lazy_init=True),
        # 2. Normalize message-like dict payloads before middleware inspects them.
        MessageCoercionMiddleware(),
        # 3. Crisis fast-path (before any expensive middleware)
        CrisisCheckMiddleware(),
        # 4. Always-loaded identity files (soul always, voice+techniques skip on crisis).
        #    AGENTS.md is a small shared companion↔builder building contract.
        #    skip_on_crisis=False because crisis paths never call the builder
        #    and the extra ~500 tokens are negligible at peak.
        FileInjectionMiddleware(
            (SKILLS_PATH / "soul.md", False),
            (SKILLS_PATH / "voice.md", True),
            (SKILLS_PATH / "techniques.md", True),
            (SKILLS_PATH / "AGENTS.md", False),
        ),
        # 5. Platform signal
        PlatformContextMiddleware(),
        # 6. Derive prior completed turns before first-turn-only middleware runs.
        TurnCountMiddleware(),
        # 7-8. User context
        UserIdentityMiddleware(user_id),
        SessionStateMiddleware(user_id),
        # 9-11. Calibration (order matters: tone -> context -> ritual -> skill)
        ToneGuidanceMiddleware(SKILLS_PATH / "tone_guidance.md"),
        ContextAdaptationMiddleware(SKILLS_PATH / "context", context_mode),
        RitualMiddleware(SKILLS_PATH / "rituals", ritual),
        # 12. Skill routing (reads tone band + ritual from state)
        SkillRouterMiddleware(SKILLS_PATH / "skills"),
        # 13. Memory (after ritual+skill set — retrieval biased by both)
        Mem0MemoryMiddleware(user_id),
        # 14. Builder session tracking (must run before ArtifactMiddleware synthesis)
        BuilderSessionMiddleware(),
        # 15. Artifact system
        ArtifactMiddleware(SKILLS_PATH / "artifact_instructions.md"),
        # 16. Deterministic Builder command routing for explicit document requests
        BuilderCommandMiddleware(),
    ]
    if web_tools:
        middlewares.insert(-2, WebResearchGuidanceMiddleware())

    if async_builder_enabled:
        # Append AFTER the builder-session/command middlewares so those still
        # see every turn even when the companion uses the async tools. The
        # middleware adds its five tools (start/check/update/cancel/list
        # async_task) via ``AsyncSubAgentMiddleware.tools`` and prepends the
        # system prompt via ``wrap_model_call``.
        middlewares.append(_build_async_subagent_middleware())
        logger.info(
            "Sophia companion: async_builder flag enabled; "
            "AsyncSubAgentMiddleware attached with graph_id=sophia_builder"
        )

    # 17. Summarization (config-driven trigger/keep policy)
    summarization_middleware = _create_summarization_middleware()
    if summarization_middleware is not None:
        middlewares.append(summarization_middleware)

    # Post-chain: prompt assembly, then caching, then title
    from langchain_anthropic.middleware.prompt_caching import AnthropicPromptCachingMiddleware
    middlewares.extend(
        [
            PromptAssemblyMiddleware(),
            # Prompt caching AFTER assembly — adds cache_control to the assembled
            # system message. Turn 2+ reads from cache → ~85% lower TTFT.
            AnthropicPromptCachingMiddleware(ttl="5m"),
            SophiaTitleMiddleware(),
        ]
    )

    retrieve_memories = make_retrieve_memories_tool(user_id)
    switch_to_builder = make_switch_to_builder_tool(user_id)
    # share_builder_artifact is the re-share-only tool: it re-attaches the most
    # recent builder deliverable for the current thread when the user explicitly
    # asks to resend. Its docstring forbids calling it in the same turn as
    # switch_to_builder, so the model only reaches for it on resend requests.
    tools = [
        emit_artifact,
        switch_to_builder,
        share_builder_artifact,
        retrieve_memories,
        *web_tools,
    ]

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
