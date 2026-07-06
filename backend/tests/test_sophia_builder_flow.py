"""End-to-end regression tests for Sophia builder handoff flow."""

import importlib
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langgraph.types import Command

from deerflow.config import tracing_config as tracing_module


def _reset_tracing_cache() -> None:
    tracing_module._tracing_config = None


def _make_runtime(state: dict, thread_id: str = "thread-1", user_id: str | None = None, context_user_id: str | None = None) -> SimpleNamespace:
    configurable = {"thread_id": thread_id}
    if user_id is not None:
        configurable["user_id"] = user_id
    context = {"thread_id": thread_id}
    if context_user_id is not None:
        context["user_id"] = context_user_id

    return SimpleNamespace(
        state=state,
        context=context,
        config={
            "configurable": configurable,
            "metadata": {"model_name": "claude-haiku-4-5-20251001", "trace_id": "trace-1"},
        },
    )


def _apply_update(state: dict, update: dict | None) -> dict:
    if not update:
        return state
    for key, value in update.items():
        state[key] = value
    return state


def _payload_from_builder_response(response: str | Command) -> dict:
    """Extract the JSON builder handoff payload from a string or Command."""
    if isinstance(response, Command):
        tool_message = response.update["messages"][0]
        return json.loads(tool_message.content)
    return json.loads(response)




def test_middleware_parity_in_companion_and_builder_chains(monkeypatch):
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    builder_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.delenv("SOPHIA_BUILDER_MODEL", raising=False)
    _reset_tracing_cache()

    captured_companion = {}
    captured_builder = {}

    class DummyAgent:
        recursion_limit = 0

    class FakeSummarizationMiddleware:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    FakeSummarizationMiddleware.__name__ = "SummarizationMiddleware"

    monkeypatch.setattr(companion_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    # agent.py now constructs summarization via the _create_summarization_middleware
    # helper (which lazily imports SophiaSummarizationMiddleware). Patch that
    # helper directly — this is the public seam exposed by the refactor.
    # FakeSummarizationMiddleware.__name__ = "SummarizationMiddleware" ensures
    # the parity assertion below still matches type(mw).__name__.
    monkeypatch.setattr(
        companion_module,
        "_create_summarization_middleware",
        lambda: FakeSummarizationMiddleware(),
    )
    monkeypatch.setattr(companion_module, "make_retrieve_memories_tool", lambda user_id: {"tool": user_id})
    # `load_sophia_web_tools()` reads the global app_config; the test fixture
    # doesn't seed it, so stub the loader to return an empty list. Native web
    # tools are exercised in dedicated tests (`test_sophia_web_tools_*`).
    monkeypatch.setattr(companion_module, "load_sophia_web_tools", lambda: [])

    def _capture_companion(**kwargs):
        captured_companion["middleware"] = kwargs["middleware"]
        return DummyAgent()

    monkeypatch.setattr(companion_module, "create_agent", _capture_companion)
    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    companion_types = [type(mw).__name__ for mw in captured_companion["middleware"]]
    assert "MessageCoercionMiddleware" in companion_types
    assert companion_types.index("MessageCoercionMiddleware") < companion_types.index("CrisisCheckMiddleware")
    # PR-C: BuilderSessionMiddleware deleted; AsyncSubAgentMiddleware owns
    # builder lifecycle now via the native ``async_tasks`` channel.
    assert "AsyncSubAgentMiddleware" in companion_types
    assert "SummarizationMiddleware" in companion_types

    # B2 — DanglingToolCallMiddleware MUST sit AFTER PromptAssemblyMiddleware
    # and BEFORE AnthropicPromptCachingMiddleware in the companion chain so
    # the cache keys off the patched message list. Lock the position.
    assert "DanglingToolCallMiddleware" in companion_types
    assert "PromptAssemblyMiddleware" in companion_types
    assert "AnthropicPromptCachingMiddleware" in companion_types
    assert "LoopDetectionMiddleware" in companion_types
    assert "SafetyFinishReasonMiddleware" in companion_types
    assert "LLMErrorHandlingMiddleware" in companion_types
    assert (
        companion_types.index("PromptAssemblyMiddleware")
        < companion_types.index("DanglingToolCallMiddleware")
        < companion_types.index("AnthropicPromptCachingMiddleware")
    )
    # LLMErrorHandling must wrap OUTSIDE the provider fallback (earlier in the
    # list = outermost wrap_model_call). Inside, it converts Anthropic
    # quota/billing errors into a generic reply before the fallback can retry
    # via OpenAI — observed live as "provider rejected this request" with no
    # [CompanionProviderFallback] retry log.
    assert (
        companion_types.index("LLMErrorHandlingMiddleware")
        < companion_types.index("CompanionProviderFallbackMiddleware")
    )

    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-5")]),
    )

    def _capture_builder(**kwargs):
        captured_builder["middleware"] = kwargs["middleware"]
        captured_builder["tools"] = kwargs["tools"]
        return DummyAgent()

    monkeypatch.setattr(builder_module, "create_agent", _capture_builder)
    builder_agent = builder_module._create_builder_agent(user_id="user_123")

    builder_types = [type(mw).__name__ for mw in captured_builder["middleware"]]
    builder_tool_names = [getattr(tool, "name", None) for tool in captured_builder["tools"]]
    assert type(builder_agent).__name__ == "DummyAgent"
    assert "SandboxMiddleware" in builder_types
    assert "ToolErrorHandlingMiddleware" in builder_types
    assert "LLMErrorHandlingMiddleware" in builder_types
    assert "SafetyFinishReasonMiddleware" in builder_types
    # Same first-chance contract on the builder side: the provider fallback
    # sits INSIDE LLMErrorHandling so it catches provider errors first.
    assert (
        builder_types.index("LLMErrorHandlingMiddleware")
        < builder_types.index("BuilderProviderFallbackMiddleware")
    )
    assert "LoopDetectionMiddleware" in builder_types
    assert "TodoMiddleware" in builder_types
    assert "BuilderResearchPolicyMiddleware" in builder_types
    assert "builder_web_search" in builder_tool_names
    assert "builder_web_fetch" in builder_tool_names
    # emit_builder_artifact is the structured "I'm done" signal — the
    # BuilderCompletionCard payload depends on its 13 fields, so it must
    # remain in the builder's tool list.
    assert "emit_builder_artifact" in builder_tool_names
    # render_html_to_pdf is the skill-driven PDF path: reports are authored as
    # HTML with inline <svg> figures and rendered via headless Chromium. The
    # markdown→pandoc renderer and the remote generate_chart service are retired.
    assert "render_html_to_pdf" in builder_tool_names
    assert "render_markdown_to_pdf" not in builder_tool_names
    assert "generate_excalidraw_diagram" not in builder_tool_names
    assert "generate_chart" not in builder_tool_names
    assert "generate_visual_asset" not in builder_tool_names
    assert "generate_report_chart" not in builder_tool_names
    # ``present_files`` must NOT be in the builder's tool list. Its presence
    # invited the model (trained on upstream's pattern) to call
    # ``present_files + emit_builder_artifact`` together on the final turn,
    # which BuilderArtifactMiddleware rejected as "mixed tool calls; loop
    # continues". The fallback empty-artifact path then propagated to the
    # frontend as a phantom-success error. emit_builder_artifact's
    # artifact_path already drives the BuilderCompletionCard, so a separate
    # present_files signal is redundant.
    assert "present_files" not in builder_tool_names, (
        "present_files must not be in the builder's tool list — it conflicts "
        "with emit_builder_artifact's atomic-completion contract. See the "
        "comment block in builder_agent.py for the full rationale."
    )
    # B2 — DanglingToolCallMiddleware MUST sit AFTER PromptAssemblyMiddleware
    # and BEFORE AnthropicPromptCachingMiddleware in the builder chain (Phase 2
    # caching), mirroring the companion so the cache keys off the patched
    # message list.
    assert "DanglingToolCallMiddleware" in builder_types
    assert "PromptAssemblyMiddleware" in builder_types
    assert "AnthropicPromptCachingMiddleware" in builder_types
    builder_cache_middleware = next(
        mw for mw in captured_builder["middleware"] if type(mw).__name__ == "AnthropicPromptCachingMiddleware"
    )
    assert builder_cache_middleware.unsupported_model_behavior == "ignore"
    assert (
        builder_types.index("PromptAssemblyMiddleware")
        < builder_types.index("DanglingToolCallMiddleware")
        < builder_types.index("AnthropicPromptCachingMiddleware")
    )
    # Budget circuit-breaker (Phase 1) must be listed BEFORE
    # BuilderArtifactMiddleware so that — because after_model hooks run in
    # reverse list order — it runs AFTER it: a legitimate artifact emit wins
    # the completion-webhook dedup, while a runaway turn's "timed_out" budget
    # kill fires uncontended. See builder_budget.py.
    assert "BuilderBudgetMiddleware" in builder_types
    assert "BuilderArtifactMiddleware" in builder_types
    assert (
        builder_types.index("BuilderBudgetMiddleware")
        < builder_types.index("BuilderArtifactMiddleware")
    )


def test_presentation_builder_toolset_removes_excalidraw_diagram(monkeypatch) -> None:
    import deerflow.agents.sophia_agent.builder_agent as builder_module

    captured: dict[str, object] = {}
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.delenv("SOPHIA_BUILDER_MODEL", raising=False)
    _reset_tracing_cache()
    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-5")]),
    )

    def _capture_builder(**kwargs):
        captured["tools"] = kwargs["tools"]
        return MagicMock()

    monkeypatch.setattr(builder_module, "create_agent", _capture_builder)
    builder_module._create_builder_agent(user_id="user_123", task_type="presentation")

    tool_names = [getattr(tool, "name", None) for tool in captured["tools"]]
    assert "generate_visual_asset" not in tool_names
    assert "generate_excalidraw_diagram" not in tool_names
    assert "generate_chart" not in tool_names
    assert "generate_report_chart" not in tool_names


def test_report_builder_toolset_uses_render_html_to_pdf(monkeypatch) -> None:
    builder_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    _reset_tracing_cache()
    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-5")]),
    )
    captured = {}

    class DummyAgent:
        recursion_limit = 0

    def _capture_builder(**kwargs):
        captured["tools"] = kwargs["tools"]
        return DummyAgent()

    monkeypatch.setattr(builder_module, "create_agent", _capture_builder)

    builder_module._create_builder_agent(user_id="user_123", task_type="document")

    tool_names = [getattr(tool, "name", None) for tool in captured["tools"]]
    assert "render_html_to_pdf" in tool_names
    assert "render_markdown_to_pdf" not in tool_names
    assert "generate_excalidraw_diagram" not in tool_names
    assert "generate_chart" not in tool_names
    assert "generate_report_chart" not in tool_names
    assert "generate_visual_asset" not in tool_names


def test_pdf_presentation_delivery_keeps_deck_toolset(monkeypatch) -> None:
    builder_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    _reset_tracing_cache()
    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-5")]),
    )
    captured = {}

    class DummyAgent:
        recursion_limit = 0

    def _capture_builder(**kwargs):
        captured["tools"] = kwargs["tools"]
        return DummyAgent()

    monkeypatch.setattr(builder_module, "create_agent", _capture_builder)

    builder_module._create_builder_agent(
        user_id="user_123",
        task_type="presentation",
        artifact_target_ext=".pdf",
    )

    tool_names = [getattr(tool, "name", None) for tool in captured["tools"]]
    assert "build_deck_from_slides" in tool_names
    assert "prepare_pptx_image_manifest" in tool_names
    assert "render_html_to_pdf" not in tool_names


def test_builder_agent_anthropic_timeout_and_retries(monkeypatch) -> None:
    """F1 (2026-06-11): 240s timeout, 1 retry, 32k output tokens.

    The builder generates large documents (5k+ tokens) which can take 45-90s.
    A 120s timeout gives headroom without letting a stalled connection hang
    indefinitely. 1 retry recovers from transient blips without burning
    extra budget when the model is genuinely struggling.
    """
    import deerflow.agents.sophia_agent.builder_agent as builder_module

    captured: dict[str, object] = {}
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.delenv("SOPHIA_BUILDER_MODEL", raising=False)
    _reset_tracing_cache()

    def _capture_chat_anthropic(**kwargs):
        captured["kwargs"] = kwargs
        return MagicMock()

    monkeypatch.setattr(builder_module, "ChatAnthropic", _capture_chat_anthropic)
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-5")]),
    )
    monkeypatch.setattr(builder_module, "create_agent", lambda **kwargs: MagicMock())

    builder_module._create_builder_agent(user_id="user_123")

    assert captured["kwargs"]["timeout"] == 240.0
    assert captured["kwargs"]["max_retries"] == 1
    assert captured["kwargs"]["streaming"] is True
    # 32k output: a complete standalone HTML document must fit ONE
    # write_file call (prod F1: 8192 truncated tool-call JSON -> args lost).
    assert captured["kwargs"]["max_tokens"] == 32768


def test_builder_factory_returns_langgraph_compatible_graph(monkeypatch) -> None:
    """The LangGraph server rejects Runnable proxies around compiled graphs."""

    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langgraph.pregel import Pregel

    import deerflow.agents.sophia_agent.builder_agent as builder_module

    monkeypatch.setattr(
        builder_module,
        "ChatAnthropic",
        lambda **_kwargs: FakeListChatModel(responses=["ok"]),
    )
    monkeypatch.setattr(
        builder_module,
        "get_app_config",
        lambda: SimpleNamespace(models=[SimpleNamespace(model="claude-sonnet-5")]),
    )
    monkeypatch.delenv("SOPHIA_BUILDER_MODEL", raising=False)
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    _reset_tracing_cache()

    builder_agent = builder_module._create_builder_agent(user_id="user_123")

    assert isinstance(builder_agent, Pregel)
    assert type(builder_agent).__name__ != "LangSmithBuilderTraceRunnable"
    assert builder_agent.config["run_name"] == "Sophia Builder"
    assert len(builder_agent.config["callbacks"]) == 1
    assert "sophia_builder" in builder_agent.config["tags"]
    assert builder_agent.config["metadata"]["sophia_component"] == "builder"
    assert builder_agent.config["metadata"]["builder_model_name"] == "claude-sonnet-5"
    assert builder_agent.config["metadata"]["builder_model_source"] == "config-sonnet"


# ---------------------------------------------------------------------------
# PR-B (2026-05) — deepagents v0.5 AsyncSubAgentMiddleware always-on
#
# The middleware is ALWAYS attached. ``start_async_task`` is filtered from
# the model-visible tool set; the model launches builds via the
# ``start_builder_task`` wrapper (regular agent tool). The four lifecycle
# tools (``check_async_task`` / ``update_async_task`` / ``cancel_async_task``
# / ``list_async_tasks``) remain native via the middleware's ``.tools``
# attribute. ``switch_to_builder`` stays in the agent-level tools list for
# one PR cycle as a revert path; PR-C deletes it.
# ---------------------------------------------------------------------------


def _find_async_middleware(middlewares):
    """Return the AsyncSubAgentMiddleware from a captured middleware list."""
    for mw in middlewares:
        if type(mw).__name__ == "AsyncSubAgentMiddleware":
            return mw
    raise AssertionError("AsyncSubAgentMiddleware not found in chain")


def _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured):
    """Apply the patches the parity test relies on, capturing
    `middleware` + `tools` from `create_agent` instead of building a real
    agent. Reused across the B4 gate tests below.
    """

    class _DummyAgent:
        recursion_limit = 0

    class _FakeSummarizationMiddleware:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    _FakeSummarizationMiddleware.__name__ = "SummarizationMiddleware"

    monkeypatch.setattr(companion_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(
        companion_module,
        "_create_summarization_middleware",
        lambda: _FakeSummarizationMiddleware(),
    )
    monkeypatch.setattr(
        companion_module, "make_retrieve_memories_tool", lambda user_id: {"name": "retrieve_memories"}
    )
    # If the web-tools loader is wired in (PR B1 may be merged first), stub
    # it so the chain stays deterministic. `raising=False` keeps this test
    # working both before and after B1 lands.
    monkeypatch.setattr(
        companion_module, "load_sophia_web_tools", lambda: [], raising=False
    )

    def _capture(**kwargs):
        captured["model"] = kwargs["model"]
        captured["middleware"] = kwargs["middleware"]
        captured["tools"] = kwargs["tools"]
        return _DummyAgent()

    monkeypatch.setattr(companion_module, "create_agent", _capture)


def test_companion_disables_tracing_on_model_only(monkeypatch):
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    captured: dict = {}
    _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)

    agent = companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    assert type(captured["model"]).__name__ == "LangSmithTraceDisabledRunnable"
    assert getattr(captured["model"], "_runnable") == {"model": "claude-haiku-4-5-20251001"}
    assert type(agent).__name__ == "_DummyAgent"


def test_async_subagent_middleware_always_attached(monkeypatch):
    """``AsyncSubAgentMiddleware`` is in the chain on every request as of
    PR-B. ``start_builder_task`` is the model-visible launch tool;
    ``start_async_task`` is filtered out so the model only ever sees the
    enriched-description path.
    """
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    captured: dict = {}
    _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)

    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    middleware_types = [type(mw).__name__ for mw in captured["middleware"]]
    tool_names = [getattr(tool, "name", None) for tool in captured["tools"]]

    assert "AsyncSubAgentMiddleware" in middleware_types, (
        "AsyncSubAgentMiddleware must always be attached as of PR-B."
    )
    # Wrapper tool is exposed at the agent level.
    assert "start_builder_task" in tool_names, (
        "start_builder_task wrapper must be in the agent's tool list."
    )
    # PR-C: ``switch_to_builder`` deleted.
    assert "switch_to_builder" not in tool_names

    # The four lifecycle tools live on the middleware's ``.tools`` attribute,
    # not in ``create_agent(tools=...)`` — verify they are present and
    # ``start_async_task`` is filtered out so the model can't bypass the
    # ``start_builder_task`` wrapper.
    async_middleware = _find_async_middleware(captured["middleware"])
    middleware_tool_names = {
        getattr(tool, "name", None) for tool in getattr(async_middleware, "tools", [])
    }
    expected_lifecycle = {
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
    }
    assert expected_lifecycle <= middleware_tool_names, (
        f"Missing lifecycle tools: {expected_lifecycle - middleware_tool_names}"
    )
    assert "start_async_task" not in middleware_tool_names
    assert "start_async_task" not in tool_names


def test_async_subagent_middleware_after_builder_command(monkeypatch):
    """Position contract: AsyncSubAgentMiddleware sits AFTER
    BuilderCommandMiddleware so the synthesized ``start_builder_task`` tool
    call from the deterministic document fastpath is observable by the
    native middleware on the next turn.
    """
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    captured: dict = {}
    _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)

    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    middleware_types = [type(mw).__name__ for mw in captured["middleware"]]
    assert "BuilderCommandMiddleware" in middleware_types
    assert "AsyncSubAgentMiddleware" in middleware_types
    assert middleware_types.index("BuilderCommandMiddleware") < middleware_types.index(
        "AsyncSubAgentMiddleware"
    ), "AsyncSubAgentMiddleware must sit AFTER BuilderCommandMiddleware"


# ---------- lifecycle-tool discipline (companion system prompt) -------------


_LIFECYCLE_TOOLS_WITH_ACK = [
    ("start_builder_task", "Starting the build now"),
    ("edit_builder_artifact", "revising the delivered artifact"),
    ("update_async_task", "updating the build"),
    ("check_async_task", "Let me check on it"),
    ("cancel_async_task", "cancelling the build"),
    ("list_async_tasks", "Pulling up your in-flight"),
]


@pytest.mark.parametrize("tool_name,ack_marker", _LIFECYCLE_TOOLS_WITH_ACK)
def test_async_builder_system_prompt_covers_all_lifecycle_tools_with_ack_example(
    tool_name, ack_marker
):
    """The companion's async-subagent preamble must teach every lifecycle
    tool with at least one cue-phrase line AND an ack example so the model
    has full coverage of intent → tool → ack."""
    module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    prompt = module._ASYNC_BUILDER_SYSTEM_PROMPT
    assert tool_name in prompt, f"{tool_name} missing from _ASYNC_BUILDER_SYSTEM_PROMPT"
    assert ack_marker in prompt, f"ack marker '{ack_marker}' missing for {tool_name}"


def test_async_builder_system_prompt_has_stale_status_and_full_task_id_rules():
    """deepagents docs flag stale-status reporting and task_id truncation
    as top failure modes; both rules must be present in the preamble."""
    module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    prompt = module._ASYNC_BUILDER_SYSTEM_PROMPT.lower()
    assert "stale" in prompt
    assert "full task_id" in prompt or "full `task_id`" in prompt


def test_async_builder_system_prompt_has_update_failure_handling():
    """If update_async_task itself errors, the companion must NOT fall back
    to start_builder_task — the preamble must say so explicitly."""
    module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    prompt = module._ASYNC_BUILDER_SYSTEM_PROMPT
    assert "update_async_task" in prompt
    assert "error" in prompt.lower()
    # Critical anti-pattern guard.
    assert "do not call" in prompt.lower() or "do NOT call" in prompt
    assert "start_builder_task" in prompt


def test_embedded_artifact_instructions_list_ack_example_per_lifecycle_tool():
    """The artifact markdown file is retired; the embedded companion
    contract still needs the lifecycle ack examples."""
    from deerflow.agents.sophia_agent.middlewares.artifact import (
        _DEFAULT_ARTIFACT_INSTRUCTIONS,
    )

    text = _DEFAULT_ARTIFACT_INSTRUCTIONS
    for tool_name, ack_marker in _LIFECYCLE_TOOLS_WITH_ACK:
        assert tool_name in text, f"{tool_name} missing from embedded artifact instructions"
        assert ack_marker in text, f"ack '{ack_marker}' missing from embedded artifact instructions"


def test_update_async_task_wrapped_with_terminal_guard(monkeypatch):
    """Phase 2B chain-membership invariant: the native deepagents
    ``update_async_task`` must be filtered from the middleware's tool list
    and replaced by the Phase 2B terminal-thread-guard wrapper.

    A future refactor that drops the wrapper would silently regress to the
    behaviour that caused the 2026-05-20 19:53–19:57 production dangling-tool
    loop — this test pins the wrap in place.
    """
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    captured: dict = {}
    _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)

    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    async_middleware = _find_async_middleware(captured["middleware"])
    update_tools = [
        t for t in getattr(async_middleware, "tools", [])
        if getattr(t, "name", None) == "update_async_task"
    ]
    # Exactly one update_async_task tool — the wrapper, not the native.
    assert len(update_tools) == 1, (
        f"Expected exactly one update_async_task tool; found {len(update_tools)}"
    )
    wrapper = update_tools[0]
    # The wrapper's func / coroutine must come from the Phase 2B module,
    # not from deepagents.middleware.async_subagents.
    func_module = (getattr(wrapper.func, "__module__", None)
                   or getattr(wrapper.coroutine, "__module__", None) or "")
    assert "update_async_task_wrapper" in func_module, (
        f"update_async_task tool is not the Phase 2B wrapper "
        f"(func module={func_module!r}). Wrapper must shadow the native dispatch."
    )


def test_async_builder_system_prompt_names_terminal_redirect_rule():
    """The system-prompt preamble must explicitly tell the model that
    update_async_task is for ACTIVE builds only, and that targeted edits to
    terminal builds require edit_builder_artifact."""
    module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    prompt = module._ASYNC_BUILDER_SYSTEM_PROMPT
    # Active-only language for update_async_task.
    assert "RUNNING" in prompt or "running" in prompt.lower()
    # Terminal-status language.
    assert "TERMINAL" in prompt or "terminal" in prompt.lower()
    # The directive: terminal modify cues → edit_builder_artifact with
    # prior-artifact identity.
    assert "edit_builder_artifact" in prompt
    assert "prior artifact" in prompt.lower() or "previous version" in prompt.lower()


def test_lifecycle_tool_observer_middleware_registered_in_companion_chain(monkeypatch):
    """The observer middleware emits one structured log per lifecycle-tool
    call. Chain-membership test so a future refactor cannot silently drop
    the production observability hook.
    """
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    captured: dict = {}
    _stub_companion_for_chain_inspection(monkeypatch, companion_module, captured)

    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    middleware_types = [type(mw).__name__ for mw in captured["middleware"]]
    assert "LifecycleToolObserverMiddleware" in middleware_types
    # Must sit between BuildAwarenessMiddleware and ArtifactMiddleware so the
    # active-build block shapes the turn first and emit_artifact comes after.
    assert middleware_types.index("BuildAwarenessMiddleware") < middleware_types.index(
        "LifecycleToolObserverMiddleware"
    )
    assert middleware_types.index("LifecycleToolObserverMiddleware") < middleware_types.index(
        "ArtifactMiddleware"
    )
