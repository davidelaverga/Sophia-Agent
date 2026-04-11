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
from deerflow.agents.middlewares.todo_middleware import TodoMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from deerflow.agents.sophia_agent.paths import SKILLS_PATH
from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.config.app_config import get_app_config
from deerflow.sandbox.middleware import SandboxMiddleware
from deerflow.sandbox.tools import bash_tool, ls_tool, read_file_tool, str_replace_tool, write_file_tool
from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact
from deerflow.tools.builtins import present_file_tool

logger = logging.getLogger(__name__)
DEFAULT_BUILDER_MODEL = "claude-sonnet-4-6"


def make_sophia_builder(config: RunnableConfig):
    """LangGraph entry point for sophia_builder graph registration.

    Reads user_id and model from config.configurable, then delegates
    to _create_builder_agent().
    """
    cfg = config.get("configurable", {})
    user_id = cfg.get("user_id", "default_user")
    model_name = cfg.get("model_name")
    return _create_builder_agent(user_id=user_id, model_name=model_name)

def _resolve_builder_model_name(model_name: str | None) -> tuple[str, str]:
    """Resolve model name and source for builder creation logging."""
    if model_name:
        return model_name, "parent"

    env_model = os.environ.get("SOPHIA_BUILDER_MODEL")
    if env_model:
        return env_model, "env"

    try:
        app_config = get_app_config()
        for model_cfg in app_config.models:
            provider_model = getattr(model_cfg, "model", None)
            if isinstance(provider_model, str) and "sonnet" in provider_model.lower():
                return provider_model, "config-sonnet"
    except Exception:
        logger.warning("Could not resolve sonnet builder model from app config; using default", exc_info=True)

    return DEFAULT_BUILDER_MODEL, "default"


def _create_builder_todo_middleware() -> TodoMiddleware:
    """Create Todo middleware configured for always-plan builder execution."""
    return TodoMiddleware(
        system_prompt="""
<builder_todo_system>
You are the Sophia builder. Keep a live todo list while executing delegated build tasks.
- Create and maintain todos for non-trivial build execution.
- Keep at least one item in progress until the task is finished.
- Mark items completed immediately after you finish them.
</builder_todo_system>
""",
        tool_description=(
            "Use this tool to maintain your execution todo list while building. "
            "Update task status continuously as work progresses."
        ),
    )


def _create_builder_agent(user_id: str, model_name: str | None = None):
    """Create the Sophia builder agent with its dedicated middleware chain.

    Called by make_sophia_builder (LangGraph entry) or directly by
    switch_to_builder (SubagentExecutor path).

    Args:
        user_id: User identifier for identity loading.
        model_name: Model name inherited from companion if present.
    """
    resolved_model, model_source = _resolve_builder_model_name(model_name)
    logger.info(
        "Creating Sophia builder agent: user_id=%s, model=%s, model_source=%s",
        user_id,
        resolved_model,
        model_source,
    )

    model = ChatAnthropic(
        model=resolved_model,
        api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        max_tokens=8192,
    )
    # 8-middleware chain for builder execution.
    # TodoListMiddleware deferred to Phase 2
    middlewares = [
        # 1. Infrastructure — shares thread with companion
        ThreadDataMiddleware(lazy_init=True),
        # 2. Sandbox execution capabilities for file/tool operations
        SandboxMiddleware(lazy_init=True),
        # 3. Values — soul.md only (voice.md not needed, builder doesn't speak)
        FileInjectionMiddleware((SKILLS_PATH / "soul.md", False)),
        # 4. User personalization — identity file shapes what builder creates
        UserIdentityMiddleware(user_id),
        # 5. Task briefing — translates companion artifact into builder guidance
        BuilderTaskMiddleware(),
        # 6. Planning — todo list always enabled for delegated build execution
        _create_builder_todo_middleware(),
        # 7. Builder artifact capture — after-model reads emit_builder_artifact
        BuilderArtifactMiddleware(),
        # 8. Prompt assembly — assembles system_prompt_blocks into system message
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
