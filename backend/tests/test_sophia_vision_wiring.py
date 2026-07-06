"""Builder + companion include vision tool & middleware when gate is True.

Acceptance criteria #2 + #3 from the Sophia vision-port spec.

Builder uses upstream ``view_image_tool`` and
``ClearOnInjectViewImageMiddleware`` (a ``ViewImageMiddleware`` subclass
that prevents stale image accumulation). Companion uses the narrow
``view_user_image`` wrapper and
``SophiaViewImageMiddleware`` (subclass that recognizes both tool names).
Both chains gate on ``vision_gate.supports_vision(model_name)``.
"""

from __future__ import annotations

import importlib

from langchain_core.tools import BaseTool


class _DummyAgent:
    recursion_limit = 0


def _patch_companion_factories(monkeypatch, companion_module):
    monkeypatch.setattr(companion_module, "ChatAnthropic", lambda **kw: {"model": kw["model"]})
    monkeypatch.setattr(companion_module, "_create_summarization_middleware", lambda: None)
    monkeypatch.setattr(companion_module, "make_retrieve_memories_tool", lambda uid: {"tool": uid})
    monkeypatch.setattr(companion_module, "load_sophia_web_tools", lambda: [])


def _capture_create_agent(captured: dict):
    def _capture(**kwargs):
        captured["middleware"] = kwargs["middleware"]
        captured["tools"] = kwargs["tools"]
        return _DummyAgent()

    return _capture


def test_builder_includes_view_image_tool_and_middleware_when_vision_enabled(monkeypatch) -> None:
    builder_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")

    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kw: {"model": kw["model"]})
    monkeypatch.setattr(builder_module, "supports_vision", lambda _: True)

    captured: dict = {}
    monkeypatch.setattr(builder_module, "create_agent", _capture_create_agent(captured))

    builder_module._create_builder_agent(user_id="user_123", model_name="claude-sonnet-5")

    tool_names = [getattr(t, "name", None) for t in captured["tools"]]
    middleware_names = [type(mw).__name__ for mw in captured["middleware"]]

    assert "view_image" in tool_names, (
        "Builder must expose upstream view_image_tool when vision gate is True. "
        f"Got tools: {tool_names}"
    )
    assert "ClearOnInjectViewImageMiddleware" in middleware_names, (
        "Builder middleware chain must include the cleanup ViewImageMiddleware "
        "subclass when vision gate is True so injected image content blocks "
        "reach the model without stale image accumulation. "
        f"Got middlewares: {middleware_names}"
    )

    # Position assertion: image middleware must run AFTER BuilderArtifactMiddleware
    # (so artifact emission isn't shadowed by image injection) and BEFORE
    # PromptAssemblyMiddleware (so the injected HumanMessage participates in
    # prompt finalization).
    assert "BuilderArtifactMiddleware" in middleware_names
    assert "PromptAssemblyMiddleware" in middleware_names
    assert (
        middleware_names.index("BuilderArtifactMiddleware")
        < middleware_names.index("ClearOnInjectViewImageMiddleware")
        < middleware_names.index("PromptAssemblyMiddleware")
    ), f"Image middleware in wrong slot: {middleware_names}"


def test_builder_excludes_view_image_when_vision_disabled(monkeypatch) -> None:
    builder_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")

    monkeypatch.setattr(builder_module, "ChatAnthropic", lambda **kw: {"model": kw["model"]})
    monkeypatch.setattr(builder_module, "supports_vision", lambda _: False)

    captured: dict = {}
    monkeypatch.setattr(builder_module, "create_agent", _capture_create_agent(captured))

    builder_module._create_builder_agent(user_id="user_123", model_name="not-a-vision-model")

    tool_names = [getattr(t, "name", None) for t in captured["tools"]]
    middleware_names = [type(mw).__name__ for mw in captured["middleware"]]

    assert "view_image" not in tool_names
    assert "ViewImageMiddleware" not in middleware_names
    assert "ClearOnInjectViewImageMiddleware" not in middleware_names


def test_companion_includes_vision_tools_and_subclass_middleware(monkeypatch) -> None:
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    _patch_companion_factories(monkeypatch, companion_module)
    monkeypatch.setattr(companion_module, "supports_vision", lambda _: True)

    captured: dict = {}
    monkeypatch.setattr(companion_module, "create_agent", _capture_create_agent(captured))
    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    tool_names = [getattr(t, "name", None) for t in captured["tools"] if isinstance(t, BaseTool)]
    middleware_names = [type(mw).__name__ for mw in captured["middleware"]]

    assert "view_user_image" in tool_names, f"Got tools: {tool_names}"
    assert "read_user_document" in tool_names, f"Got tools: {tool_names}"
    assert "SophiaViewImageMiddleware" in middleware_names, (
        "Companion must use SophiaViewImageMiddleware (subclass) so view_user_image "
        "calls are recognized — upstream ViewImageMiddleware hard-codes the check "
        f"to 'view_image' only. Got middlewares: {middleware_names}"
    )

    # Position: after BuildAwareness + ArtifactMiddleware, before PromptAssembly.
    assert middleware_names.index("ArtifactMiddleware") < middleware_names.index("SophiaViewImageMiddleware")
    assert middleware_names.index("SophiaViewImageMiddleware") < middleware_names.index("PromptAssemblyMiddleware")


def test_companion_excludes_vision_middleware_when_disabled(monkeypatch) -> None:
    companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")
    _patch_companion_factories(monkeypatch, companion_module)
    monkeypatch.setattr(companion_module, "supports_vision", lambda _: False)

    captured: dict = {}
    monkeypatch.setattr(companion_module, "create_agent", _capture_create_agent(captured))
    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})

    middleware_names = [type(mw).__name__ for mw in captured["middleware"]]
    tool_names = [getattr(t, "name", None) for t in captured["tools"] if isinstance(t, BaseTool)]

    assert "SophiaViewImageMiddleware" not in middleware_names
    # view_user_image is gated on the same `supports_vision` decision as
    # the middleware. Codex P2 on PR #132: keeping the tool registered
    # without the middleware would let the model call view_user_image,
    # see a success tool result, but never actually receive image blocks
    # on the next turn — the companion would confidently report "I see
    # the image" without seeing anything. Hiding the tool keeps the
    # model's apparent capabilities honest.
    assert "view_user_image" not in tool_names, (
        "view_user_image must NOT be registered when vision is disabled — "
        "the tool would succeed but the model would never get image content "
        "blocks because SophiaViewImageMiddleware is also off."
    )
    # read_user_document stays unconditional since it returns text and
    # doesn't depend on vision wiring.
    assert "read_user_document" in tool_names
