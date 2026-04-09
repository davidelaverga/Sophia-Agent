"""Sophia builder agent factory.

Creates the builder agent with its dedicated middleware chain.
The builder executes file-creation tasks delegated by the companion
via switch_to_builder, using DeerFlow's sandbox tools.
"""

import logging
import os

from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.runnables import RunnableConfig

from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from deerflow.agents.sophia_agent.paths import SKILLS_PATH
from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.sandbox.tools import bash_tool, ls_tool, read_file_tool, str_replace_tool, write_file_tool
from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact
from deerflow.tools.builtins import present_file_tool

logger = logging.getLogger(__name__)


def make_sophia_builder(config: RunnableConfig):
    """LangGraph entry point for sophia_builder graph registration.

    Reads user_id and model from config.configurable, then delegates
    to _create_builder_agent().
    """
    cfg = config.get("configurable", {})
    user_id = cfg.get("user_id", "default_user")
    model_name = cfg.get("model_name")
    return _create_builder_agent(user_id=user_id, model_name=model_name)


def _create_builder_agent(user_id: str, model_name: str | None = None):
    """Create the Sophia builder agent with its dedicated middleware chain.

    Called by make_sophia_builder (LangGraph entry) or directly by
    switch_to_builder (SubagentExecutor path).

    Args:
        user_id: User identifier for identity loading.
        model_name: Model name to use. Defaults to claude-haiku-4-5-20251001
                    (inherits from companion; production should use claude-sonnet-4-6).
    """
    logger.info("Creating Sophia builder agent: user_id=%s, model=%s", user_id, model_name)

    model = ChatAnthropic(
        model=model_name or "claude-haiku-4-5-20251001",
        api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        max_tokens=8192,
    )

    # 6-middleware chain per spec §6 (adapted for Phase 1)
    # SandboxMiddleware skipped — builder inherits sandbox_state from parent via initial state
    # TodoListMiddleware deferred to Phase 2
    middlewares = [
        # 1. Infrastructure — shares thread with companion
        ThreadDataMiddleware(lazy_init=True),
        # 2. Values — soul.md only (voice.md not needed, builder doesn't speak)
        FileInjectionMiddleware((SKILLS_PATH / "soul.md", False)),
        # 3. User personalization — identity file shapes what builder creates
        UserIdentityMiddleware(user_id),
        # 4. Task briefing — translates companion artifact into builder guidance
        BuilderTaskMiddleware(),
        # 5. Builder artifact capture — after-model reads emit_builder_artifact
        BuilderArtifactMiddleware(),
        # 6. Prompt assembly — assembles system_prompt_blocks into system message
        PromptAssemblyMiddleware(),
    ]

    # Sandbox tools (bash, file ops) + present_files + emit_builder_artifact
    tools = [
        bash_tool,
        ls_tool,
        read_file_tool,
        write_file_tool,
        str_replace_tool,
        present_file_tool,
        emit_builder_artifact,
    ]

    agent = create_agent(
        model=model,
        tools=tools,
        middleware=middlewares,
        state_schema=SophiaState,
    )
    # Builder needs enough steps for multi-file creation.
    # Each tool call = ~3 graph steps. 50 steps ≈ 16 tool turns.
    # The 120s timeout in switch_to_builder is the real safety net.
    agent.recursion_limit = 50
    return agent
