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
        self.parent_run: _FakeRunTree | None = None
        self.parent_run_id: str | None = None
        self.run_type = "chain"
        self.end_time: object | None = None
        self.error: str | None = None
        self.patch_calls = 0
        self.end_calls = 0

    def add_metadata(self, metadata: dict[str, Any]) -> None:
        self.metadata.update(metadata)

    def add_tags(self, tags: list[str]) -> None:
        self.tags.extend(tags)

    def patch(self, *, exclude_inputs: bool = False) -> None:
        assert exclude_inputs is True
        self.patch_calls += 1

    def end(self, *, error: str | None, metadata: dict[str, Any]) -> None:
        self.error = error
        self.metadata.update(metadata)
        self.end_time = object()
        self.end_calls += 1


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


def test_builder_completion_targets_root_run_metadata_and_feedback(monkeypatch) -> None:
    root = _FakeRunTree()
    root.id = "root-run"
    child = _FakeRunTree()
    child.id = "child-run"
    child.parent_run = root
    feedback_client = _FakeFeedbackClient()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: child)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)

    artifact = {
        "artifact_path": None,
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "terminal_status": "failed",
        "terminal_reason": "deck_prepare_execution_error",
    }

    assert observability.annotate_builder_completion({}, artifact) is True
    assert root.metadata["terminal_status"] == "failed"
    assert root.metadata["terminal_reason"] == "deck_prepare_execution_error"
    assert root.patch_calls == 1
    assert feedback_client.feedback[-1]["run_id"] == "root-run"


def test_terminal_feedback_uses_deterministic_id(monkeypatch) -> None:
    feedback_client = _FakeFeedbackClient()
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)
    root = _FakeRunTree()
    root.id = "builder-root"
    artifact = {
        "status": "failed",
        "terminal_status": "failed",
        "terminal_reason": "deck_prepare_parallel_calls_forbidden",
    }

    observability._create_terminal_feedback(root, artifact)
    observability._create_terminal_feedback(root, artifact)

    assert len(feedback_client.feedback) == 2
    first, second = feedback_client.feedback
    assert first["feedback_id"] == second["feedback_id"]
    assert str(first["feedback_id"])
    assert feedback_client.feedback[-1]["score"] == 0.0


def test_builder_observability_preserves_zero_native_deck_metrics() -> None:
    state = {
        "builder_pptx_diagnostics": {
            "deck_route": "deck_ir_html_raster",
            "deck_compile_mode": "not_compiled",
            "native_required": True,
            "legacy_screenshot_debug": False,
            "native_editability_score": 0.0,
            "native_text_shape_count": 0,
            "picture_shape_count": 0,
            "full_slide_picture_count": 0,
            "expected_generated_visual_count": 0,
            "successful_generated_visual_count": 0,
            "missing_expected_visual_count": 0,
        }
    }
    artifact = {
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "artifact_path": None,
    }

    metadata, tags, feedback = observability.builder_observability_payload(state, artifact)

    assert metadata["deck_compile_mode"] == "not_compiled"
    assert metadata["native_required"] is True
    assert metadata["legacy_screenshot_debug"] is False
    assert metadata["native_editability_score"] == 0.0
    assert metadata["native_text_shape_count"] == 0
    assert metadata["picture_shape_count"] == 0
    assert metadata["full_slide_picture_count"] == 0
    assert metadata["deck_expected_visual_count"] == 0
    assert metadata["deck_successful_visual_count"] == 0
    assert metadata["deck_missing_visual_count"] == 0
    assert "deck_screenshot_forbidden" not in tags
    assert feedback == []


def test_builder_observability_tags_forbidden_screenshot_mode() -> None:
    state = {
        "builder_pptx_diagnostics": {
            "deck_route": "deck_ir_html_raster",
            "deck_compile_mode": "html_screenshot_fallback",
        }
    }
    artifact = {
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "artifact_path": "/mnt/user-data/outputs/deck.pptx",
    }

    metadata, tags, _feedback = observability.builder_observability_payload(state, artifact)

    assert metadata["deck_compile_mode"] == "html_screenshot_fallback"
    assert metadata["deck_forbidden_compile_mode"] is True
    assert "deck_screenshot_forbidden" in tags


def test_builder_completion_keeps_skipped_qc_feedback_neutral(monkeypatch) -> None:
    run_tree = _FakeRunTree()
    feedback_client = _FakeFeedbackClient()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: run_tree)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)

    state = {
        "builder_pptx_diagnostics": {
            "qc_invocation_count": 1,
            "qc_results": [
                {
                    "pass": False,
                    "skipped": True,
                    "reasons": ["slide QC skipped: ANTHROPIC_API_KEY is not set"],
                },
            ],
        }
    }

    assert (
        observability.annotate_builder_completion(
            state,
            {"artifact_path": "/mnt/user-data/outputs/deck.pptx", "artifact_ext": "pptx"},
        )
        is True
    )

    assert feedback_client.feedback == [
        {
            "run_id": "run-1",
            "key": "slide_qc",
            "score": None,
            "comment": '["slide QC skipped: ANTHROPIC_API_KEY is not set"]',
        }
    ]


def test_builder_completion_keeps_advisory_qc_feedback_neutral(monkeypatch) -> None:
    run_tree = _FakeRunTree()
    feedback_client = _FakeFeedbackClient()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: run_tree)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)

    state = {
        "builder_pptx_diagnostics": {
            "qc_invocation_count": 1,
            "qc_results": [
                {
                    "pass": False,
                    "advisory": True,
                    "parser_error": True,
                    "reasons": ["QC reviewer returned invalid JSON"],
                },
            ],
        }
    }

    assert (
        observability.annotate_builder_completion(
            state,
            {"artifact_path": "/mnt/user-data/outputs/deck.pptx", "artifact_ext": "pptx"},
        )
        is True
    )

    assert feedback_client.feedback == [
        {
            "run_id": "run-1",
            "key": "slide_qc",
            "score": None,
            "comment": '["QC reviewer returned invalid JSON"]',
        }
    ]


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


def test_builder_completion_attaches_prepare_terminal_metadata_and_failure_feedback(
    monkeypatch,
) -> None:
    run_tree = _FakeRunTree()
    feedback_client = _FakeFeedbackClient()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: run_tree)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)
    state = {
        "builder_pptx_diagnostics": {
            "first_prepare_turn": 8,
            "prepare_call_count": 2,
            "prepare_emitted_call_count": 2,
            "prepare_execution_count": 1,
            "prepare_normalized_call_count": 1,
            "prepare_schema_failure_count": 1,
            "prepare_service_call_count": 1,
            "prepare_service_result_count": 1,
            "prepare_result_count": 1,
            "prepare_retry_executed": True,
            "dangling_prepare_call_count": 1,
            "creative_plan_accepted": False,
            "deck_authoring_contract": "compact_model_html_v1",
            "deck_authoring_elapsed_ms": 119000,
            "deck_repair_elapsed_ms": 12000,
            "deck_service_elapsed_ms": 480000,
            "terminal_cleanup_elapsed_ms": 800,
            "prepare_force_reason": "turn_limit",
            "deck_root_failure_code": "deck_prepare_argument_invalid",
            "deck_root_failure_summary": "The first prepare call failed schema validation.",
            "source_quality_report": {
                "passed": False,
                "hard_failures": [
                    {"selector": "slide:2", "check": "chrome"},
                    {"selector": "slide:3", "check": "chrome"},
                ],
                "soft_warnings": [{"selector": "slide:1", "check": "density"}],
            },
            "source_retention_report": {
                "passed": False,
                "missing_required_count": 1,
                "duplicate_source_id_count": 0,
                "low_retention": [{"selector": "slide:1", "retention_ratio": 0.5}],
            },
            "native_contrast_report": {
                "passed": False,
                "checked_run_count": 4,
                "required_issue_count": 1,
                "indeterminate_required_count": 1,
            },
        }
    }
    artifact = {
        "artifact_path": None,
        "artifact_type": "presentation",
        "artifact_ext": "pptx",
        "status": "failed",
        "terminal_status": "failed",
        "terminal_reason": "deck_prepare_tool_result_missing",
        "failure_code": "deck_prepare_tool_result_missing",
        "authoring_contract": "compact_model_html_v2",
        "build_event_store_status": "available",
    }

    assert observability.annotate_builder_completion(state, artifact) is True

    assert run_tree.metadata["first_prepare_turn"] == 8
    assert run_tree.metadata["prepare_call_count"] == 2
    assert run_tree.metadata["prepare_emitted_call_count"] == 2
    assert run_tree.metadata["prepare_execution_count"] == 1
    assert run_tree.metadata["prepare_normalized_call_count"] == 1
    assert run_tree.metadata["prepare_schema_failure_count"] == 1
    assert run_tree.metadata["prepare_service_call_count"] == 1
    assert run_tree.metadata["prepare_service_result_count"] == 1
    assert run_tree.metadata["prepare_result_count"] == 1
    assert run_tree.metadata["prepare_retry_executed"] is True
    assert run_tree.metadata["dangling_prepare_call_count"] == 1
    assert run_tree.metadata["deck_authoring_contract"] == "compact_model_html_v1"
    assert run_tree.metadata["authoring_contract"] == "compact_model_html_v2"
    assert run_tree.metadata["build_event_store_status"] == "available"
    assert run_tree.metadata["deck_authoring_elapsed_ms"] == 119000
    assert run_tree.metadata["deck_repair_elapsed_ms"] == 12000
    assert run_tree.metadata["deck_service_elapsed_ms"] == 480000
    assert run_tree.metadata["terminal_cleanup_elapsed_ms"] == 800
    assert run_tree.metadata["prepare_force_reason"] == "turn_limit"
    assert run_tree.metadata["creative_plan_accepted"] is False
    assert run_tree.metadata["root_failure_code"] == "deck_prepare_argument_invalid"
    assert run_tree.metadata["source_quality_passed"] is False
    assert run_tree.metadata["source_quality_hard_failure_count"] == 2
    assert run_tree.metadata["source_quality_soft_warning_count"] == 1
    assert run_tree.metadata["source_quality_checks"] == "chrome,density"
    assert run_tree.metadata["source_quality_affected_selectors"] == "slide:2,slide:3"
    assert run_tree.metadata["source_retention_passed"] is False
    assert run_tree.metadata["source_retention_missing_required_count"] == 1
    assert run_tree.metadata["source_retention_low_count"] == 1
    assert run_tree.metadata["native_contrast_passed"] is False
    assert run_tree.metadata["native_contrast_required_issue_count"] == 1
    assert run_tree.metadata["terminal_status"] == "failed"
    assert run_tree.metadata["terminal_reason"] == "deck_prepare_tool_result_missing"
    assert "builder_terminal:failed" in run_tree.tags
    assert "deck_prepare_result_missing" in run_tree.tags
    assert feedback_client.feedback[-1]["key"] == "builder_terminal_success"
    assert feedback_client.feedback[-1]["score"] == 0.0


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

    wrapped_model = observability.disable_langsmith_tracing_for_runnable(ChatAnthropic(model="claude-haiku-4-5-20251001", api_key="test-key"))
    middleware = AnthropicPromptCachingMiddleware(ttl="5m", unsupported_model_behavior="raise")
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


def test_builder_completion_uses_active_pregel_tracer_root(monkeypatch) -> None:
    class _FakeTracer:
        pass

    root = _FakeRunTree()
    root.id = "pregel-root"
    root.parent_run_id = None
    root.metadata = {"thread_id": "thread-1"}
    tracer = _FakeTracer()
    tracer.run_map = {root.id: root}
    feedback_client = _FakeFeedbackClient()

    observability._ACTIVE_BUILDER_TRACERS.add(tracer)
    monkeypatch.setattr(observability, "_current_run_tree", lambda: None)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)
    try:
        assert observability.annotate_builder_completion(
            {"thread_id": "thread-1"},
            {
                "artifact_path": "deck.pptx",
                "terminal_status": "completed",
                "terminal_reason": "artifact_emitted",
            },
        ) is True
    finally:
        observability._ACTIVE_BUILDER_TRACERS.discard(tracer)

    assert root.metadata["terminal_status"] == "completed"
    assert root.patch_calls == 1
    assert feedback_client.feedback[-1]["run_id"] == "pregel-root"


def test_builder_completion_prefers_matching_pregel_root_over_detached_current_span(monkeypatch) -> None:
    class _FakeTracer:
        pass

    detached = _FakeRunTree()
    detached.id = "detached-span"
    detached.metadata = {"thread_id": "unrelated-thread"}
    root = _FakeRunTree()
    root.id = "builder-root"
    root.parent_run_id = None
    root.metadata = {"thread_id": "builder-thread", "run_id": "builder-run"}
    tracer = _FakeTracer()
    tracer.run_map = {root.id: root}
    feedback_client = _FakeFeedbackClient()

    observability._ACTIVE_BUILDER_TRACERS.add(tracer)
    monkeypatch.setattr(observability, "_current_run_tree", lambda: detached)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)
    artifact = {
        "artifact_path": None,
        "terminal_status": "failed",
        "terminal_reason": "deck_slide_html_invalid",
        "run_id": "builder-run",
    }
    try:
        assert observability.annotate_builder_completion(
            {"thread_id": "builder-thread", "run_id": "builder-run"},
            artifact,
        ) is True
    finally:
        observability._ACTIVE_BUILDER_TRACERS.discard(tracer)

    assert root.metadata["terminal_reason"] == "deck_slide_html_invalid"
    assert "terminal_reason" not in detached.metadata
    assert artifact["builder_trace_run_id"] == "builder-root"
    assert artifact["builder_trace_root_run_id"] == "builder-root"
    assert feedback_client.feedback[-1]["run_id"] == "builder-root"


def test_builder_completion_matches_build_identity_and_closes_canceled_model_span(monkeypatch) -> None:
    class _FakeTracer:
        pass

    detached = _FakeRunTree()
    detached.id = "detached-span"
    detached.metadata = {"build_id": "different-build"}
    root = _FakeRunTree()
    root.id = "builder-root"
    root.metadata = {"build_id": "build-123", "operation_id": "operation-123"}
    model_span = _FakeRunTree()
    model_span.id = "authoring-model"
    model_span.parent_run_id = root.id
    model_span.run_type = "llm"
    tracer = _FakeTracer()
    tracer.run_map = {root.id: root, model_span.id: model_span}
    feedback_client = _FakeFeedbackClient()

    observability._ACTIVE_BUILDER_TRACERS.add(tracer)
    monkeypatch.setattr(observability, "_current_run_tree", lambda: detached)
    monkeypatch.setattr(observability, "_feedback_client", lambda: feedback_client)
    artifact = {
        "artifact_path": None,
        "terminal_status": "timed_out",
        "terminal_reason": "deck_authoring_deadline_exceeded",
    }
    try:
        assert observability.annotate_builder_completion(
            {
                "builder_build_id": "build-123",
                "builder_operation_id": "operation-123",
                "builder_run_id": "native-run-123",
            },
            artifact,
        ) is True
    finally:
        observability._ACTIVE_BUILDER_TRACERS.discard(tracer)

    assert root.metadata["terminal_status"] == "timed_out"
    assert root.metadata["builder_run_id"] == "native-run-123"
    assert model_span.end_calls == 1
    assert model_span.end_time is not None
    assert model_span.error == "Builder terminated: deck_authoring_deadline_exceeded"
    assert artifact["builder_trace_root_run_id"] == "builder-root"
    assert artifact["builder_run_id"] == "native-run-123"
