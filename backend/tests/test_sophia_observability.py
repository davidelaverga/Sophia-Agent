from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager
from typing import Any

import pytest

from deerflow.config import tracing_config as tracing_module
from deerflow.sophia import observability


def _reset_tracing_cache() -> None:
    tracing_module._tracing_config = None


@pytest.fixture(autouse=True)
def _isolate_tracing_config():
    _reset_tracing_cache()
    yield
    _reset_tracing_cache()


class _FakeRunTree:
    id = "run-1"

    def __init__(self) -> None:
        self.metadata: dict[str, Any] = {}
        self.tags: list[str] = []

    def add_metadata(self, metadata: dict[str, Any]) -> None:
        self.metadata.update(metadata)

    def add_tags(self, tags: list[str]) -> None:
        self.tags.extend(tags)


class _FakeFeedbackClient:
    def __init__(self) -> None:
        self.feedback: list[dict[str, Any]] = []

    def create_feedback(self, **kwargs: Any) -> None:
        self.feedback.append(kwargs)


def test_builder_completion_adds_metadata_tags_and_qc_feedback(monkeypatch) -> None:
    run_tree = _FakeRunTree()
    feedback_client = _FakeFeedbackClient()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: run_tree)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)

    state = {
        "builder_pptx_diagnostics": {
            "pptx_plan_json": {"slides": [{"title": "One"}, {"title": "Two"}]},
            "pptx_plan_slide_count": 2,
            "image_generation_success_count": 2,
            "qc_invocation_count": 2,
            "qc_pass_count": 1,
            "qc_failure_count": 1,
            "qc_results": [
                {"pass": True, "reasons": []},
                {"pass": False, "reasons": ["garbled title"]},
            ],
        }
    }
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/deck.pptx",
        "artifact_type": "presentation",
        "requested_artifact_ext": "pptx",
        "artifact_ext": "pptx",
        "artifact_is_fallback": False,
    }

    assert observability.annotate_builder_completion(state, artifact) is True

    assert run_tree.metadata["deck_plan"] == {"slides": [{"title": "One"}, {"title": "Two"}]}
    assert run_tree.metadata["slide_count"] == 2
    assert run_tree.metadata["image_count"] == 2
    assert run_tree.metadata["image_forward"] is True
    assert run_tree.metadata["degraded"] is False
    assert run_tree.metadata["artifact_type"] == "presentation"
    assert run_tree.metadata["requested_artifact_ext"] == "pptx"
    assert run_tree.metadata["final_artifact_ext"] == "pptx"
    assert run_tree.metadata["artifact_is_fallback"] is False
    assert "artifact:pptx" in run_tree.tags
    assert "image_forward" in run_tree.tags
    assert "qc_ran" in run_tree.tags
    assert [item["score"] for item in feedback_client.feedback] == [1.0, 0.0]
    assert feedback_client.feedback[1]["comment"] == '["garbled title"]'


def test_builder_completion_normalizes_successful_pdf_metadata(monkeypatch) -> None:
    run_tree = _FakeRunTree()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: run_tree)
    monkeypatch.setattr(observability, "_feedback_client", lambda: _FakeFeedbackClient())

    artifact = {
        "artifact_path": "/mnt/user-data/outputs/report.pdf",
        "artifact_type": "pdf",
        "requested_artifact_ext": "md",
        "artifact_ext": "pdf",
        "artifact_is_fallback": False,
        "fallback_reason": "md_generation_not_completed",
    }

    assert observability.annotate_builder_completion({}, artifact) is True

    assert run_tree.metadata["artifact_type"] == "pdf"
    assert run_tree.metadata["requested_artifact_ext"] == "pdf"
    assert run_tree.metadata["final_artifact_ext"] == "pdf"
    assert run_tree.metadata["artifact_is_fallback"] is False
    assert run_tree.metadata["degraded"] is False
    assert "fallback_reason" not in run_tree.metadata


def test_builder_completion_is_noop_without_active_run(monkeypatch) -> None:
    monkeypatch.setattr(observability, "_current_run_tree", lambda: None)

    assert observability.annotate_builder_completion({}, {"artifact_path": "deck.pptx"}) is False


class _FakeRunnable:
    recursion_limit = 50

    def invoke(self, *_args: Any, **_kwargs: Any) -> str:
        return "invoke"

    def bind(self, *_args: Any, **_kwargs: Any) -> _FakeRunnable:
        return self

    def bind_tools(self, *_args: Any, **_kwargs: Any) -> _FakeRunnable:
        return self

    async def ainvoke(self, *_args: Any, **_kwargs: Any) -> str:
        return "ainvoke"

    def stream(self, *_args: Any, **_kwargs: Any):
        yield "stream-1"
        yield "stream-2"

    async def astream(self, *_args: Any, **_kwargs: Any):
        yield "astream-1"
        yield "astream-2"


async def _collect_async_stream(stream) -> list[str]:
    items: list[str] = []
    async for item in stream:
        items.append(item)
    return items


def test_trace_disabled_runnable_wraps_sync_and_async_execution(monkeypatch) -> None:
    events: list[tuple[str, bool | None]] = []

    @contextmanager
    def fake_tracing_context(*, enabled: bool | None = None, **_kwargs: Any):
        events.append(("enter", enabled))
        try:
            yield
        finally:
            events.append(("exit", enabled))

    monkeypatch.setattr(observability, "_tracing_context_factory", lambda: fake_tracing_context)
    wrapped = observability.disable_langsmith_tracing_for_runnable(_FakeRunnable())

    assert wrapped.recursion_limit == 50
    wrapped.recursion_limit = 80
    assert wrapped.recursion_limit == 80
    assert wrapped.invoke({}) == "invoke"
    assert wrapped.bind(x=1).invoke({}) == "invoke"
    assert wrapped.bind_tools([]).invoke({}) == "invoke"
    assert list(wrapped.stream({})) == ["stream-1", "stream-2"]
    assert asyncio.run(wrapped.ainvoke({})) == "ainvoke"
    assert asyncio.run(_collect_async_stream(wrapped.astream({}))) == ["astream-1", "astream-2"]
    assert events == [
        ("enter", False),
        ("exit", False),
        ("enter", False),
        ("exit", False),
        ("enter", False),
        ("exit", False),
        ("enter", False),
        ("exit", False),
        ("enter", False),
        ("exit", False),
        ("enter", False),
        ("exit", False),
    ]


def test_trace_disabled_runnable_preserves_anthropic_prompt_caching() -> None:
    from langchain_anthropic import ChatAnthropic
    from langchain_anthropic.middleware.prompt_caching import (
        AnthropicPromptCachingMiddleware,
    )

    class _Request:
        def __init__(self, *, model: Any, model_settings: dict[str, Any] | None = None) -> None:
            self.model = model
            self.model_settings = model_settings or {}
            self.messages = []
            self.system_message = None
            self.tools = []

        def override(self, **overrides: Any) -> _Request:
            clone = _Request(
                model=overrides.get("model", self.model),
                model_settings=overrides.get("model_settings", self.model_settings),
            )
            clone.messages = overrides.get("messages", self.messages)
            clone.system_message = overrides.get("system_message", self.system_message)
            clone.tools = overrides.get("tools", self.tools)
            return clone

    wrapped_model = observability.disable_langsmith_tracing_for_runnable(
        ChatAnthropic(model="claude-haiku-4-5-20251001", api_key="test-key")
    )
    middleware = AnthropicPromptCachingMiddleware(
        ttl="5m", unsupported_model_behavior="raise"
    )
    captured: dict[str, Any] = {}

    assert isinstance(wrapped_model, ChatAnthropic)

    result = middleware.wrap_model_call(
        _Request(model=wrapped_model),
        lambda request: captured.setdefault("request", request),
    )

    assert result is captured["request"]
    assert captured["request"].model_settings["cache_control"] == {
        "type": "ephemeral",
        "ttl": "5m",
    }


def test_builder_trace_runnable_uses_explicit_builder_context(monkeypatch) -> None:
    events: list[tuple[str, bool | None]] = []
    context_kwargs: list[dict[str, Any]] = []

    @contextmanager
    def fake_tracing_context(*, enabled: bool | None = None, **kwargs: Any):
        events.append(("enter", enabled))
        context_kwargs.append(kwargs)
        try:
            yield
        finally:
            events.append(("exit", enabled))

    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    _reset_tracing_cache()
    monkeypatch.setattr(observability, "_tracing_context_factory", lambda: fake_tracing_context)
    monkeypatch.setattr(observability, "_langsmith_client", lambda *_args, **_kwargs: "client")
    monkeypatch.setattr(observability, "_builder_langsmith_tracer", lambda **_kwargs: object())
    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(
        _FakeRunnable(),
        metadata={"thread_id": "thread-1"},
        tags=["custom-tag"],
    )

    assert wrapped.invoke({}) == "invoke"
    assert list(wrapped.stream({})) == ["stream-1", "stream-2"]
    assert events == [
        ("enter", True),
        ("exit", True),
        ("enter", True),
        ("exit", True),
    ]
    assert context_kwargs[0]["project_name"] == "Sophia"
    assert context_kwargs[0]["client"] == "client"
    assert context_kwargs[0]["metadata"] == {"thread_id": "thread-1"}
    assert context_kwargs[0]["tags"] == ["sophia_builder", "custom-tag"]


def test_builder_trace_runnable_allows_global_langsmith_false(monkeypatch) -> None:
    events: list[tuple[str, bool | None]] = []
    context_kwargs: list[dict[str, Any]] = []

    @contextmanager
    def fake_tracing_context(*, enabled: bool | None = None, **kwargs: Any):
        events.append(("enter", enabled))
        context_kwargs.append(kwargs)
        try:
            yield
        finally:
            events.append(("exit", enabled))

    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    _reset_tracing_cache()
    monkeypatch.setattr(observability, "_tracing_context_factory", lambda: fake_tracing_context)
    monkeypatch.setattr(observability, "_langsmith_client", lambda *_args, **_kwargs: "client")
    monkeypatch.setattr(observability, "_builder_langsmith_tracer", lambda **_kwargs: object())
    runnable = _FakeRunnable()
    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(runnable)

    assert wrapped is not runnable
    assert wrapped.invoke({}) == "invoke"
    assert events == [("enter", True), ("exit", True)]
    assert context_kwargs[0]["project_name"] == "Sophia"


def test_builder_trace_runnable_inherits_global_tracing_when_builder_flag_missing(monkeypatch) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.delenv("SOPHIA_BUILDER_LANGSMITH_TRACING", raising=False)
    _reset_tracing_cache()
    monkeypatch.setattr(observability, "_builder_langsmith_tracer", lambda **_kwargs: object())

    runnable = _FakeRunnable()
    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(runnable)

    assert wrapped is not runnable


def test_builder_trace_runnable_builder_false_overrides_global_tracing(monkeypatch) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "false")
    _reset_tracing_cache()

    runnable = _FakeRunnable()
    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(runnable)

    assert wrapped is runnable


def test_builder_tracing_startup_status_logs_resolved_config(monkeypatch, caplog) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com")
    monkeypatch.delenv("SOPHIA_BUILDER_LANGSMITH_TRACING", raising=False)
    _reset_tracing_cache()
    monkeypatch.setattr(observability, "_startup_status_logged", False)
    caplog.set_level(logging.INFO, logger=observability.__name__)

    observability.log_builder_tracing_startup_status()

    assert "[tracing] builder_tracing_flag=True" in caplog.text
    assert "langsmith_tracing_enabled=True" in caplog.text
    assert "project=Sophia" in caplog.text
    assert "api_key_present=True" in caplog.text


def test_builder_trace_runnable_requires_api_key(monkeypatch) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    monkeypatch.delenv("LANGCHAIN_API_KEY", raising=False)
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    _reset_tracing_cache()

    runnable = _FakeRunnable()
    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(runnable)

    assert wrapped is runnable


def test_builder_trace_runnable_preserves_langgraph_graphs(monkeypatch) -> None:
    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langgraph.pregel import Pregel

    graph = create_agent(model=FakeListChatModel(responses=["ok"]), tools=[])
    graph.recursion_limit = 80
    assert isinstance(graph, Pregel)

    tracer = object()
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    _reset_tracing_cache()
    monkeypatch.setattr(observability, "_builder_langsmith_tracer", lambda **_kwargs: tracer)

    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(
        graph,
        metadata={"thread_id": "thread-1"},
        tags=["custom-tag"],
    )

    assert wrapped is not graph
    assert isinstance(wrapped, Pregel)
    assert wrapped.recursion_limit == 80
    assert wrapped.config["callbacks"] == [tracer]
    assert wrapped.config["run_name"] == "Sophia Builder"
    assert wrapped.config["tags"] == ["sophia_builder", "custom-tag"]
    assert wrapped.config["metadata"]["thread_id"] == "thread-1"


def test_builder_completion_logs_missing_run_tree_when_tracing_expected(monkeypatch, caplog) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    _reset_tracing_cache()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: None)

    assert observability.annotate_builder_completion({}, {"artifact_path": "deck.pptx"}) is False

    assert "no active run tree" in caplog.text
