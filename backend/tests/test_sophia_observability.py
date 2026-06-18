from __future__ import annotations

import asyncio
from contextlib import contextmanager
from typing import Any

from deerflow.sophia import observability


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
        "artifact_is_fallback": False,
    }

    assert observability.annotate_builder_completion(state, artifact) is True

    assert run_tree.metadata["deck_plan"] == {"slides": [{"title": "One"}, {"title": "Two"}]}
    assert run_tree.metadata["slide_count"] == 2
    assert run_tree.metadata["image_count"] == 2
    assert run_tree.metadata["image_forward"] is True
    assert run_tree.metadata["degraded"] is False
    assert "artifact:pptx" in run_tree.tags
    assert "image_forward" in run_tree.tags
    assert "qc_ran" in run_tree.tags
    assert [item["score"] for item in feedback_client.feedback] == [1.0, 0.0]
    assert feedback_client.feedback[1]["comment"] == '["garbled title"]'


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


def test_builder_trace_runnable_uses_builder_only_env(monkeypatch) -> None:
    events: list[tuple[str, bool | None]] = []

    @contextmanager
    def fake_tracing_context(*, enabled: bool | None = None, **_kwargs: Any):
        events.append(("enter", enabled))
        try:
            yield
        finally:
            events.append(("exit", enabled))

    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    monkeypatch.setattr(observability, "_tracing_context_factory", lambda: fake_tracing_context)
    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(_FakeRunnable())

    assert wrapped.invoke({}) == "invoke"
    assert list(wrapped.stream({})) == ["stream-1", "stream-2"]
    assert events == [
        ("enter", True),
        ("exit", True),
        ("enter", True),
        ("exit", True),
    ]


def test_builder_trace_runnable_honors_global_langsmith_false(monkeypatch) -> None:
    events: list[tuple[str, bool | None]] = []

    @contextmanager
    def fake_tracing_context(*, enabled: bool | None = None, **_kwargs: Any):
        events.append(("enter", enabled))
        try:
            yield
        finally:
            events.append(("exit", enabled))

    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    monkeypatch.setattr(observability, "_tracing_context_factory", lambda: fake_tracing_context)
    wrapped = observability.enable_langsmith_tracing_for_builder_runnable(_FakeRunnable())

    assert wrapped.invoke({}) == "invoke"
    assert events == []
