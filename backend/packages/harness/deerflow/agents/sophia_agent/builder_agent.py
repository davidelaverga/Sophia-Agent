"""Sophia builder agent factory.

Creates the builder agent. The middleware chain assembly lives in
``builder_middlewares.py`` so this file's import fan-out stays below
sentrux's god-files threshold; everything related to which middlewares
run, in what order, and with what parameters is owned there.

This file owns:
- The ``make_sophia_builder`` LangGraph entry point (registered in
  ``langgraph.json``).
- The ``ChatAnthropic`` model construction.
- The Builder's tool list (sandbox + web + artifact tools).
- The D7/C2 recursion guard that asserts ``task`` and
  ``start_async_task`` are never in the tool list (Builder must not
  recurse — see Stage-1 spec D7/C2).
- The agent recursion-limit tuning.
"""

import logging
import os

from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.runnables import RunnableConfig

from deerflow.agents.sophia_agent.builder_middlewares import build_builder_middleware_chain
from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.agents.sophia_agent.vision_gate import supports_vision
from deerflow.config.app_config import get_app_config
from deerflow.sandbox.tools import bash_tool, ls_tool, read_file_tool, str_replace_tool, write_file_tool
from deerflow.sophia.tools.builder_web_fetch import builder_web_fetch
from deerflow.sophia.tools.builder_web_search import builder_web_search
from deerflow.sophia.tools.create_pdf_artifact import create_pdf_artifact
from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact
from deerflow.sophia.tools.generate_excalidraw_diagram import generate_excalidraw_diagram
from deerflow.sophia.tools.generate_visual_asset import generate_visual_asset
from deerflow.sophia.tools.read_session_context import (
    read_session_context,
    read_tool_enabled,
)
from deerflow.sophia.tools.render_markdown_to_pdf import render_markdown_to_pdf
from deerflow.tools.builtins.view_image_tool import view_image_tool

logger = logging.getLogger(__name__)
DEFAULT_BUILDER_MODEL = "claude-sonnet-4-6"


def make_sophia_builder(config: RunnableConfig):
    """LangGraph entry point for sophia_builder graph registration.

    Reads user_id and model from config.configurable, then delegates
    to _create_builder_agent().
    """
    cfg = config.get("configurable", {})
    # langgraph_runtime_inmem always writes a `user_id` key into configurable,
    # defaulting to None when the caller did not supply one. dict.get(..., default)
    # only returns the default for *missing* keys, so coerce None / empty / non-string
    # values back to "default_user" before validation.
    raw_user_id = cfg.get("user_id")
    user_id = validate_user_id(
        raw_user_id if isinstance(raw_user_id, str) and raw_user_id.strip() else "default_user"
    )
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
        # 32k output. Prod 2026-06-11 (F1): at 8192 a complete standalone
        # HTML document cannot fit one write_file call — the tool-call JSON
        # truncates at the cap (budget logs showed out += exactly 8192 across
        # four attempts), args go missing, and the build dies after the
        # 4-strike arg-error stop. Sonnet 4.6 supports 64k out; only actual
        # usage is billed and the budget circuit-breaker caps runaways. The
        # truncation-specific correction in BuilderArtifactMiddleware is the
        # belt to this suspender.
        max_tokens=32768,
        # streaming=True is critical: without it, the Anthropic SDK makes a
        # synchronous HTTP request and waits for the ENTIRE response before
        # returning any data.  For Sonnet generating large documents (5k+
        # tokens) this routinely takes 45-90s of server-side generation,
        # during which zero bytes flow over the wire — triggering the HTTP
        # read timeout.  With streaming, tokens arrive incrementally (~100ms
        # apart) keeping the connection alive regardless of total generation
        # time.
        streaming=True,
        # PR-F (Phase 2.3), raised with the 32k max_tokens: the httpx timeout
        # applies between streamed chunks (streaming=True keeps bytes
        # flowing), but a 32k-token turn can run several minutes wall-clock —
        # give generous headroom while still bounding a stalled connection.
        # 1 retry (not 2) balances recovery from transient blips without
        # burning extra budget when the model is genuinely struggling.
        timeout=240.0,
        max_retries=1,
    )

    vision_enabled = supports_vision(resolved_model)
    middlewares = build_builder_middleware_chain(
        user_id=user_id,
        vision_enabled=vision_enabled,
    )

    # Guarded builder tools: sandbox/file ops + web research + artifact tools.
    # ``render_markdown_to_pdf`` (Phase B) replaces the model writing
    # ``_generate_*.py`` + matplotlib + reportlab for PDFs — see the tool's
    # module docstring for the rationale.
    #
    # Note: ``present_file_tool`` is intentionally NOT in this list. Upstream
    # deer-flow uses ``present_files`` as a UX-only marker for surfacing
    # deliverables, paired with plain-text-end as the implicit completion
    # signal. Sophia replaces both with ``emit_builder_artifact``: it carries
    # the structured handoff payload (artifact_path, companion_summary,
    # decisions_made, confidence, …) that drives the BuilderCompletionCard
    # and the companion synthesis prompt — the artifact card IS the user-
    # facing surface, so a separate present_files signal is redundant.
    #
    # Keeping both invited the model (trained on upstream's pattern) to call
    # ``present_files + emit_builder_artifact`` together on the final turn.
    # ``BuilderArtifactMiddleware`` rejected that combination as "mixed tool
    # calls; loop continues", and the next turn's plain-text reply tripped
    # the empty-fallback path. Removing ``present_file_tool`` from the
    # builder's toolbox eliminates the conflict at the root: the model
    # cannot produce the bad combo, and ``emit_builder_artifact`` remains
    # the single, structured "I'm done" signal.
    tools = [
        bash_tool,
        ls_tool,
        read_file_tool,
        write_file_tool,
        str_replace_tool,
        builder_web_search,
        builder_web_fetch,
        create_pdf_artifact,
        generate_excalidraw_diagram,
        generate_visual_asset,
        render_markdown_to_pdf,
        emit_builder_artifact,
    ]
    # Vision is gated by the same `supports_vision` decision that governs
    # ViewImageMiddleware inclusion — keeping the tool list and the
    # middleware chain in lock-step. The model can only call view_image
    # when the middleware that injects the resulting image content blocks
    # back into the next turn is also in the chain.
    if vision_enabled:
        tools.append(view_image_tool)

    # Spec D D-4: scoped recall over the parent companion session's
    # delegation ledger — the floor beneath the brief. Flag-gated so
    # SOPHIA_DELEGATION_READ_TOOL=0 removes the tool AND the briefing
    # line that teaches it (BuilderTaskMiddleware checks the same flag).
    if read_tool_enabled():
        tools.append(read_session_context)

    # D7 / C2 recursion guard (Phase-3 Stage 1 spec):
    # Builder must NEVER spawn AsyncSubAgents (no `start_async_task`) and
    # must NEVER spawn deer-flow native subagents (no `task` tool). Both
    # would create unbounded Builder→Builder recursion that cannot be
    # safely budgeted. Stage 3 may relax this for specific specialist
    # subagents — when it does, the relaxation must be threaded through
    # the registry layer, not added back to this tool list silently.
    _forbidden_tool_names = {"task", "start_async_task"}
    _present_forbidden = sorted(
        {t.name for t in tools if getattr(t, "name", None) in _forbidden_tool_names}
    )
    if _present_forbidden:
        raise RuntimeError(
            "Builder tool list contains forbidden subagent-spawning tools "
            f"({_present_forbidden}). This violates Stage-1 spec D7/C2 "
            "(Builder must not recurse). Remove the tool or revisit the "
            "recursion-prevention strategy in builder_agent.py."
        )

    agent = create_agent(
        model=model,
        tools=tools,
        middleware=middlewares,
        state_schema=SophiaState,
    )
    # Keep a slightly roomier built-agent ceiling for direct invocations.
    # The delegated Builder path still enforces its runtime budget through
    # switch_to_builder -> SubagentExecutor.config.max_turns.
    agent.recursion_limit = 80
    return agent
