"""Sophia companion agent factory.

Creates the Sophia companion agent with its middleware chain.
"""

import logging
import os

# deepagents v0.5 async subagents (B4). The middleware exposes 5 task-
# management tools (`start_async_task`, `check_async_task`,
# `update_async_task`, `cancel_async_task`, `list_async_tasks`) and is
# attached only when ``configurable.async_builder`` is truthy, so the
# default behaviour (sync `switch_to_builder` Command path with PR #78's
# JSON-string fallback) is byte-identical to today.
from deepagents.middleware.async_subagents import (
    AsyncSubAgent,
    AsyncSubAgentMiddleware,
)
from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.runnables import RunnableConfig

# Apply defensive langchain patches *before* importing anything that builds
# the agent graph. See deerflow.agents._langchain_patches for details.
from deerflow.agents import _langchain_patches  # noqa: F401
from deerflow.agents.middlewares.dangling_tool_call_middleware import DanglingToolCallMiddleware
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
from deerflow.sophia.tools.switch_to_builder import make_switch_to_builder_tool

logger = logging.getLogger(__name__)


# System-prompt preface injected alongside the five async-subagent tools.
# Kept short on purpose — the heavy contract lives in
# `skills/public/sophia/AGENTS.md` (loaded by FileInjectionMiddleware).
# This block just teaches the companion the async vocabulary so it picks the
# right tool for the user's intent. The preamble is appended by
# AsyncSubAgentMiddleware.wrap_model_call only when this middleware is in the
# chain, so the default companion behaviour is unaffected.
_ASYNC_BUILDER_SYSTEM_PROMPT = (
    "You can delegate long builds to the Sophia builder as a background task.\n"
    "- To start a build, call `start_async_task` with "
    "`subagent_type=\"sophia_builder\"` and a complete, self-contained task "
    "description that includes the task_type as a prefix (for example "
    "`[presentation] Build a 5-slide investor deck...`). The task returns a "
    "task_id immediately; keep talking to the user while the build runs.\n"
    "- When the user asks \"how's it going?\" or enough time has passed, call "
    "`check_async_task` with the task_id.\n"
    "- If the user course-corrects (\"actually, make it 2 slides not 5\"), "
    "call `update_async_task` with the task_id and the new instruction. This "
    "preserves the existing thread so the builder keeps its progress.\n"
    "- If the user asks you to stop, call `cancel_async_task`.\n"
    "- Use `list_async_tasks` when the user references \"that document we "
    "started\" and you need to recall recent task_ids.\n"
    "Do not poll on a timer. Only check when the user asks or when you know "
    "enough time has passed that a check is worth offering.\n"
)


def _build_async_subagent_middleware() -> AsyncSubAgentMiddleware:
    """Build the deepagents AsyncSubAgentMiddleware for B4.

    The ``AsyncSubAgent`` spec omits ``url`` on purpose — that selects the
    ASGI (in-process) transport, which routes SDK calls in-process through
    our existing ``langgraph.json`` registration of ``sophia_builder``. Zero
    network hop, zero extra auth configuration. Deploying the builder on a
    separate host later is a one-line change (add ``url=``).

    The middleware also writes to the ``async_tasks`` state channel using its
    internal ``_tasks_reducer``. Our SophiaState already declares
    ``async_tasks: Annotated[NotRequired[dict[str, dict]], merge_async_tasks]``
    and the two reducers are functionally identical (`dict.update`-based
    merge), so the schema merge is safe whichever wins. PR #78's
    ``switch_to_builder._build_async_task_metadata`` also emits records that
    explicitly match deepagents' ``AsyncTask`` shape (the comment in that
    file says so), so the two writers can coexist on the same channel.
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
    """Create a SophiaSummarizationMiddleware instance from app config.

    Returns ``None`` when summarization cannot be constructed (config
    disabled, default-model lookup fails, summarization config itself fails
    to load). Summarization is an optional middleware — agent construction
    must NOT depend on it. Codex bot review on PR #81 surfaced that the
    sister bug to ``load_sophia_web_tools()`` lives here too:
    ``create_chat_model(thinking_enabled=False)`` (used to resolve the
    default model when ``config.model_name`` is unset) calls
    ``get_app_config()``, which raises ``FileNotFoundError`` /
    ``pydantic.ValidationError`` in config-less or partially-configured
    environments. Failing open keeps ``make_sophia_agent`` constructible.
    """
    from deerflow.agents.sophia_agent.middlewares.sophia_summarization import SophiaSummarizationMiddleware

    try:
        config = get_summarization_config()
    except Exception:
        logger.warning(
            "Sophia summarization: failed to load summarization config; middleware disabled.",
            exc_info=True,
        )
        return None

    if not config.enabled:
        return None

    trigger = None
    if config.trigger is not None:
        if isinstance(config.trigger, list):
            trigger = [item.to_tuple() for item in config.trigger]
        else:
            trigger = config.trigger.to_tuple()

    if config.model_name:
        model = config.model_name
    else:
        try:
            model = create_chat_model(thinking_enabled=False)
        except Exception:
            logger.warning(
                "Sophia summarization: failed to resolve default chat model; middleware disabled.",
                exc_info=True,
            )
            return None

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
    # langgraph_runtime_inmem always writes a `user_id` key into configurable,
    # defaulting to None when the caller did not supply one. dict.get(..., default)
    # only returns the default for *missing* keys, so we explicitly coerce None
    # / empty / non-string values back to "default_user" before validation.
    raw_user_id = cfg.get("user_id")
    user_id = validate_user_id(
        raw_user_id if isinstance(raw_user_id, str) and raw_user_id.strip() else "default_user"
    )
    platform = cfg.get("platform", "voice")
    ritual = cfg.get("ritual", None)
    context_mode = cfg.get("context_mode", "life")
    # B4: opt-in deepagents v0.5 async-subagent tools. Off by default so
    # `switch_to_builder` (PR #78's sync handoff) stays the production path
    # until the async pattern is validated end-to-end.
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

    # Native web tools (Tavily web_search + Jina web_fetch). Resolves an empty
    # list when no `tools:` providers are configured — the WebResearchGuidance
    # middleware below is then also skipped, so the companion behaves exactly
    # as before. Only added to the tools list at the bottom of this factory.
    web_tools = load_sophia_web_tools()

    # Middleware chain — order is load-bearing.
    middlewares = [
        # 1. Infrastructure
        ThreadDataMiddleware(lazy_init=True),
        # 2. Normalize message-like dict payloads before middleware inspects them.
        MessageCoercionMiddleware(),
        # 3. Crisis fast-path (before any expensive middleware)
        CrisisCheckMiddleware(),
        # 4. Always-loaded identity files (soul always, voice+techniques skip on
        #    crisis). AGENTS.md is the small shared companion↔builder building
        #    contract; skip_on_crisis=False because crisis paths never call the
        #    builder and the extra ~500 tokens are negligible at peak.
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

    # 16b. Web research guidance — only when web tools were actually loaded.
    # Injects a system prompt block teaching citation discipline, populating
    # emit_builder_artifact.sources_used, and never claiming to have checked
    # the web without using the tools. Sits before BuilderCommandMiddleware so
    # the guidance is part of the model's pre-builder routing context.
    if web_tools:
        # Insert immediately before BuilderCommandMiddleware (last entry above).
        middlewares.insert(-1, WebResearchGuidanceMiddleware())

    # 16c. Optional: deepagents v0.5 async-subagent middleware (B4). Adds 5
    # new tools (`start_async_task` / `check_async_task` / `update_async_task`
    # / `cancel_async_task` / `list_async_tasks`) and a system-prompt preamble
    # that teaches the model the async vocabulary. Appended AFTER
    # `BuilderSessionMiddleware` and `BuilderCommandMiddleware` so those
    # middlewares still see every turn — the async tools are added on top, not
    # in place of `switch_to_builder`. Default off; opt in per request via
    # `configurable.async_builder=True`.
    if async_builder_enabled:
        middlewares.append(_build_async_subagent_middleware())
        logger.info(
            "Sophia companion: async_builder flag enabled; "
            "AsyncSubAgentMiddleware attached with graph_id=sophia_builder"
        )

    # 17. Summarization (config-driven trigger/keep policy)
    summarization_middleware = _create_summarization_middleware()
    if summarization_middleware is not None:
        middlewares.append(summarization_middleware)

    # Post-chain: prompt assembly, dangling-tool-call patching, caching, then title.
    #
    # `DanglingToolCallMiddleware` MUST run inside `wrap_model_call` (not
    # `before_model`) and MUST sit BEFORE `AnthropicPromptCachingMiddleware`
    # so the cache keys off the final, patched message list and
    # langchain-anthropic never sees a tool_result without its preceding
    # tool_use (Anthropic 400 `unexpected tool_use_id found in tool_result
    # blocks`). It was wired in commit 4383dba7 / c4af3e09 on the
    # voice-transport-migration-telegram branch and accidentally dropped in
    # the main merge (31cabe9d); the chain-membership assertion in
    # `tests/test_sophia_builder_flow.py::test_middleware_parity_in_companion_and_builder_chains`
    # locks the position so a future refactor can't re-drop it silently.
    from langchain_anthropic.middleware.prompt_caching import AnthropicPromptCachingMiddleware
    middlewares.extend(
        [
            PromptAssemblyMiddleware(),
            DanglingToolCallMiddleware(),
            # Prompt caching AFTER assembly + dangling-tool patching — adds
            # cache_control to the assembled system message and keys the
            # cache off the patched messages. Turn 2+ reads from cache →
            # ~85% lower TTFT.
            AnthropicPromptCachingMiddleware(ttl="5m"),
            SophiaTitleMiddleware(),
        ]
    )

    retrieve_memories = make_retrieve_memories_tool(user_id)
    switch_to_builder = make_switch_to_builder_tool(user_id)
    tools = [emit_artifact, switch_to_builder, retrieve_memories, *web_tools]

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
