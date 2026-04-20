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

from deerflow.agents.middlewares.dangling_tool_call_middleware import DanglingToolCallMiddleware
from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from deerflow.agents.sophia_agent.middlewares.web_research import WebResearchGuidanceMiddleware
from deerflow.agents.sophia_agent.paths import SKILLS_PATH
from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.agents.sophia_agent.tooling import load_sophia_web_tools
from deerflow.sandbox.tools import bash_tool, ls_tool, read_file_tool, str_replace_tool, write_file_tool
from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact
from deerflow.tools.builtins import present_file_tool

logger = logging.getLogger(__name__)
DEFAULT_BUILDER_MODEL = "claude-sonnet-4-6"


def _resolve_builder_model_name(model_name: str | None = None) -> tuple[str, str]:
    explicit_model = model_name.strip() if isinstance(model_name, str) else ""
    if explicit_model:
        return explicit_model, "explicit"

    env_model = (os.getenv("SOPHIA_BUILDER_MODEL") or "").strip()
    if env_model:
        return env_model, "env:SOPHIA_BUILDER_MODEL"

    return DEFAULT_BUILDER_MODEL, "default"


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
        model_name: Explicit model name to use. When omitted, falls back to
                    SOPHIA_BUILDER_MODEL or the stronger Sonnet default.
    """
    resolved_model_name, model_source = _resolve_builder_model_name(model_name)
    logger.info(
        "Creating Sophia builder agent: user_id=%s, model=%s, source=%s",
        user_id,
        resolved_model_name,
        model_source,
    )

    # ``default_request_timeout`` (aliased to ``timeout`` in newer
    # langchain-anthropic) caps a single HTTP request to Anthropic. Without
    # it, a stuck connection can keep a builder subagent "running" for many
    # minutes even though the subagent-level timeout in switch_to_builder has
    # already fired. 180s leaves room for long tool-heavy turns while still
    # cutting off genuinely hung requests.
    model = ChatAnthropic(
        model=resolved_model_name,
        api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        max_tokens=8192,
        default_request_timeout=180.0,
    )
    web_tools = load_sophia_web_tools()

    # 6-middleware chain per spec §6 (adapted for Phase 1)
    # SandboxMiddleware skipped — builder inherits sandbox_state from parent via initial state
    # TodoListMiddleware deferred to Phase 2
    middlewares = [
        # 1. Infrastructure — shares thread with companion
        ThreadDataMiddleware(lazy_init=True),
        # 2. Values + shared contract.
        #    - soul.md: always on.
        #    - AGENTS.md: companion↔builder building contract (injected in
        #      both sides) so the builder and companion share one source of
        #      truth for delegation / status taxonomy / resume / crash posture.
        FileInjectionMiddleware(
            (SKILLS_PATH / "soul.md", False),
            (SKILLS_PATH / "AGENTS.md", False),
        ),
        # 3. User personalization — identity file shapes what builder creates
        UserIdentityMiddleware(user_id),
        # 4. Task briefing — translates companion artifact into builder guidance
        BuilderTaskMiddleware(),
        # 5. Builder artifact capture — after-model reads emit_builder_artifact
        BuilderArtifactMiddleware(),
        # 6. Prompt assembly
        PromptAssemblyMiddleware(),
        # 7. Tool-message integrity — patch dangling tool_use blocks so a
        # failed/interrupted tool call (bash, write_file, web_search, etc.)
        # never leaves the Anthropic contract in an invalid state.
        DanglingToolCallMiddleware(),
    ]
    if web_tools:
        middlewares.insert(-1, WebResearchGuidanceMiddleware())

    # Sandbox tools (bash, file ops) + present_files + emit_builder_artifact
    tools = [
        bash_tool,
        ls_tool,
        read_file_tool,
        write_file_tool,
        str_replace_tool,
        present_file_tool,
        emit_builder_artifact,
        *web_tools,
    ]

    agent = create_agent(
        model=model,
        tools=tools,
        middleware=middlewares,
        state_schema=SophiaState,
    )
    # Builder needs enough steps for multi-file creation.
    # Each tool call = ~3 graph steps. 50 steps ≈ 16 tool turns.
    # The per-task-type timeout in switch_to_builder (600–900s) is the real
    # safety net, with cooperative cancellation in subagents/executor.py as
    # the backstop for stuck runs.
    agent.recursion_limit = 50
    return agent
