from __future__ import annotations

import asyncio
import inspect
import json
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, NotRequired, override

import pytest
from anthropic.resources.messages import AsyncMessages
from langchain.agents import AgentState, create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse, ModelResponse, hook_config
from langchain.chat_models.base import BaseChatModel
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool, tool
from langgraph.runtime import Runtime
from pydantic import PrivateAttr
from test_deck_build_service import _creative_plan

from deerflow.agents.middlewares.dangling_tool_call_middleware import (
    DanglingToolCallMiddleware,
)
from deerflow.agents.sophia_agent.middlewares import builder_artifact as artifact_module
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    BuilderArtifactState,
)
from deerflow.agents.sophia_agent.middlewares.builder_provider_fallback import (
    BuilderProviderFallbackMiddleware,
)
from deerflow.sophia.tools.prepare_deck_build import prepare_deck_build


@tool("builder_web_search")
def _builder_web_search(query: str) -> str:
    """Return bounded presentation research."""
    return query


@tool("builder_web_fetch")
def _builder_web_fetch(url: str) -> str:
    """Fetch one explicit presentation source."""
    return url


@tool("bash")
def _bash(command: str) -> str:
    """Represent a forbidden general builder tool."""
    return command


class _DeckRuntimeState(BuilderArtifactState):
    thread_data: NotRequired[dict[str, Any]]
    allow_web_research: NotRequired[bool]
    explicit_user_urls: NotRequired[list[str]]


class _SkipRetryToolsMiddleware(AgentMiddleware[AgentState]):
    """Test-only reproducer for the historical retry jump around tools."""

    @hook_config(can_jump_to=["model"])
    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = state.get("messages", []) or []
        if not messages:
            return None
        calls = getattr(messages[-1], "tool_calls", None) or []
        if any(call.get("id") == "prepare-2" for call in calls):
            return {"jump_to": "model"}
        return None


class _PrepareSequenceModel(BaseChatModel):
    _responses: list[AIMessage] = PrivateAttr()
    _bind_calls: list[dict[str, Any]] = PrivateAttr(default_factory=list)

    def __init__(self, responses: list[AIMessage]) -> None:
        super().__init__()
        self._responses = list(responses)

    @property
    def _llm_type(self) -> str:
        return "prepare-sequence"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | BaseTool],
        *args: Any,
        **kwargs: Any,
    ) -> _PrepareSequenceModel:
        self._bind_calls.append(dict(kwargs))
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if not self._responses:
            raise AssertionError("deck runtime requested an unexpected extra model turn")
        return ChatResult(generations=[ChatGeneration(message=self._responses.pop(0))])


class _ModelRequest:
    def __init__(
        self,
        state: dict[str, Any],
        model_settings: dict[str, Any] | None = None,
        *,
        tools: list[Any] | None = None,
        messages: list[Any] | None = None,
        system_prompt: str = "general builder prompt",
    ) -> None:
        self.state = state
        self.model_settings = model_settings or {}
        self.tools = tools or []
        self.messages = messages or [HumanMessage(content="Create the requested presentation.")]
        self.system_prompt = system_prompt
        self.model = object()
        self.runtime = None

    def override(self, **overrides: Any) -> _ModelRequest:
        return _ModelRequest(
            overrides.get("state", self.state),
            overrides.get("model_settings", self.model_settings),
            tools=overrides.get("tools", self.tools),
            messages=overrides.get("messages", self.messages),
            system_prompt=overrides.get("system_prompt", self.system_prompt),
        )


def _prepare_call(call_id: str, *, repaired: bool) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "id": call_id,
                "name": "prepare_deck_build",
                "args": {
                    "deck_title": "Runtime Control",
                    "slides": [{"title": "Control", "narrative": "Bound the runtime.", "html_source": "<html></html>"}],
                    "output_path": "/mnt/user-data/outputs/deck.pptx",
                    "creative_plan": {"repaired": repaired},
                },
            }
        ],
    )


def _compact_prepare_args(*, creative_plan: Any) -> dict[str, Any]:
    return {
        "authoring_contract": "compact_model_html_v2",
        "deck_title": "Runtime Control",
        "slides": [
            {
                "title": f"Control {index}",
                "narrative": "Bound the runtime deterministically.",
                "html_body": (
                    f'<main class="slide-root" data-deck-id="slide-{index}">'
                    f'<h1 data-deck-id="headline-{index}">Control {index}</h1></main>'
                ),
            }
            for index in range(1, 4)
        ],
        "output_path": "/mnt/user-data/outputs/deck.pptx",
        "creative_plan": creative_plan,
        "deck_stylesheet": (
            ".slide-root { width: 1920px; height: 1080px; background: #101820; color: #ffffff; }"
        ),
    }


def test_parallel_prepare_calls_terminalize_before_tool_node(
    tmp_path: Path,
    monkeypatch,
) -> None:
    executions: list[str] = []

    @tool("prepare_deck_build")
    def fake_prepare_deck_build() -> str:
        """Must never execute when one model turn emits parallel prepare calls."""
        executions.append("called")
        return "{}"

    model = _PrepareSequenceModel(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "parallel-1", "name": "prepare_deck_build", "args": {}},
                    {"id": "parallel-2", "name": "prepare_deck_build", "args": {}},
                ],
            )
        ]
    )
    webhook_calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_upload_fallback_and_fire",
        lambda *args, **kwargs: webhook_calls.append(kwargs),
    )
    agent = create_agent(
        model=model,
        tools=[fake_prepare_deck_build],
        middleware=[BuilderArtifactMiddleware(), DanglingToolCallMiddleware()],
        state_schema=_DeckRuntimeState,
    )

    result = agent.invoke(
        {
            "messages": [HumanMessage(content="Build a PPTX")],
            "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
            "delegation_context": {"task_type": "presentation", "task": "Build a PPTX"},
            "allow_web_research": False,
            "builder_pptx_diagnostics": {
                "deck_root_failure_code": "deck_prepare_argument_invalid",
                "deck_root_failure_summary": "The first prepare call failed schema validation.",
                "prepare_repair_count": 1,
                "prepare_retry_executed": True,
            },
            "thread_data": {
                "outputs_path": str(tmp_path / "outputs"),
                "workspace_path": str(tmp_path / "workspace"),
            },
        },
        context={"thread_id": "builder-thread"},
    )

    assert executions == []
    assert len(webhook_calls) == 1
    artifact = result["builder_result"]
    assert artifact["failure_code"] == "deck_prepare_parallel_calls_forbidden"
    assert artifact["root_failure_code"] == "deck_prepare_argument_invalid"
    assert artifact["last_prepare_failure_code"] == "deck_prepare_parallel_calls_forbidden"
    assert artifact["prepare_emitted_call_count"] == 2
    assert artifact["prepare_result_count"] == 2
    assert artifact["prepare_policy_result_count"] == 2
    assert artifact.get("prepare_execution_count") in {None, 0}
    assert artifact.get("prepare_service_call_count") in {None, 0}
    assert artifact.get("dangling_prepare_call_count") in {None, 0}
    results = [message for message in result["messages"] if isinstance(message, ToolMessage)]
    assert {message.tool_call_id for message in results} == {"parallel-1", "parallel-2"}
    assert all(message.status == "error" for message in results)


def test_schema_repair_then_service_failure_exhausts_global_retry(
    tmp_path: Path,
    monkeypatch,
) -> None:
    class _RejectedDeckResult:
        success = False
        retryable = True
        failure_code = "deck_slide_html_invalid"
        repair_instruction = {"repair_message": "Remove opacity."}

        def to_dict(self) -> dict[str, Any]:
            return {
                "success": False,
                "failure_code": self.failure_code,
                "failure_summary": "slides[0].html_body uses lossy CSS property opacity.",
                "retryable": True,
                "repair_instruction": self.repair_instruction,
                "slide_count": 3,
                "quality_status": "failed",
            }

    invalid_args = _compact_prepare_args(creative_plan="{malformed-json")
    valid_args = _compact_prepare_args(creative_plan=_creative_plan())
    model = _PrepareSequenceModel(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "schema-1", "name": "prepare_deck_build", "args": invalid_args}
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "service-2", "name": "prepare_deck_build", "args": valid_args}
                ],
            ),
        ]
    )
    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)
    with monkeypatch.context() as patch_context:
        service = type("Service", (), {"prepare_and_build": lambda self, **kwargs: _RejectedDeckResult()})()
        # Keep the decorated production tool and replace only its service boundary.
        patch_context.setattr(
            "deerflow.sophia.tools.prepare_deck_build.DeckBuildService",
            lambda **kwargs: service,
        )
        agent = create_agent(
            model=model,
            tools=[prepare_deck_build],
            middleware=[BuilderArtifactMiddleware(), DanglingToolCallMiddleware()],
            state_schema=_DeckRuntimeState,
        )
        result = agent.invoke(
            {
                "messages": [HumanMessage(content="Build a PPTX")],
                "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
                "delegation_context": {"task_type": "presentation", "task": "Build a PPTX"},
                "allow_web_research": False,
                "thread_data": {
                    "outputs_path": str(tmp_path / "outputs"),
                    "workspace_path": str(tmp_path / "workspace"),
                },
            },
            context={"thread_id": "builder-thread"},
        )

    artifact = result["builder_result"]
    assert artifact["failure_code"] == "deck_prepare_retry_exhausted"
    assert artifact["root_failure_code"] == "deck_prepare_argument_invalid"
    assert artifact["last_prepare_failure_code"] == "deck_slide_html_invalid"
    assert artifact["prepare_emitted_call_count"] == 2
    assert artifact["prepare_execution_count"] == 2
    assert artifact["prepare_service_call_count"] == 1
    assert artifact["prepare_result_count"] == 2
    assert artifact["prepare_repair_count"] == 1
    assert artifact["prepare_retry_executed"] is True


def test_retryable_prepare_runs_one_real_retry_then_finalizes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"pptx")
    calls: list[dict[str, Any]] = []

    @tool("prepare_deck_build")
    def fake_prepare_deck_build(
        deck_title: str,
        slides: list[dict[str, Any]],
        output_path: str,
        creative_plan: dict[str, Any],
    ) -> str:
        """Return deterministic first-failure/second-success deck results."""
        calls.append(creative_plan)
        if len(calls) == 1:
            return json.dumps(
                {
                    "success": False,
                    "build_id": "deck-1",
                    "deck_build_path": "/mnt/user-data/outputs/deck_build/build.json",
                    "failure_code": "deck_creative_plan_invalid",
                    "failure_summary": "creative_plan.slide_compositions[0].headline_intent is required",
                    "retryable": True,
                    "repair_instruction": {"repair_message": "Add the missing headline_intent."},
                    "slide_count": 1,
                    "quality_status": "failed",
                }
            )
        return json.dumps(
            {
                "success": True,
                "build_id": "deck-1",
                "deck_build_path": "/mnt/user-data/outputs/deck_build/build.json",
                "creative_plan_path": "/mnt/user-data/outputs/deck_build/creative_plan.json",
                "pptx_path": output_path,
                "deck_route": "deck_creative_html_native",
                "deck_compile_mode": "native_html2patch",
                "slide_count": 1,
                "expected_visual_count": 0,
                "successful_visual_count": 0,
                "referenced_visual_count": 0,
                "missing_visual_count": 0,
                "quality_status": "passed",
                "native_editability_score": 1.0,
                "native_text_shape_count": 3,
                "picture_shape_count": 0,
                "full_slide_picture_count": 0,
            }
        )

    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_upload_fallback_and_fire",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_attach_pptx_canvas_preview",
        staticmethod(lambda artifact, _state: artifact),
    )
    monkeypatch.setattr(
        artifact_module,
        "_apply_visual_missing_quality_metadata",
        lambda artifact, _state: artifact,
    )

    model = _PrepareSequenceModel(
        [
            _prepare_call("prepare-1", repaired=False),
            _prepare_call("prepare-2", repaired=True),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[fake_prepare_deck_build],
        middleware=[BuilderArtifactMiddleware(), DanglingToolCallMiddleware()],
        state_schema=_DeckRuntimeState,
    )

    result = agent.invoke(
        {
            "messages": [HumanMessage(content="Build a one-slide PPTX")],
            "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
            "delegation_context": {"task_type": "presentation", "task": "Build a one-slide PPTX"},
            "allow_web_research": False,
            "thread_data": {"outputs_path": str(outputs), "workspace_path": str(tmp_path / "workspace")},
        },
        context={"thread_id": "builder-thread"},
    )

    assert calls == [{"repaired": False}, {"repaired": True}]
    assert result["builder_result"]["artifact_path"] == "/mnt/user-data/outputs/deck.pptx"
    assert result["builder_result"]["status"] == "completed"
    assert result["builder_result"]["terminal_status"] == "completed"
    assert result["builder_result"]["terminal_reason"] == "deck_build_succeeded"
    assert result["builder_result"]["prepare_call_count"] == 2
    assert result["builder_result"]["prepare_emitted_call_count"] == 2
    assert result["builder_result"]["prepare_execution_count"] == 2
    assert result["builder_result"]["prepare_normalized_call_count"] == 2
    assert result["builder_result"]["prepare_service_call_count"] == 2
    assert result["builder_result"]["prepare_service_result_count"] == 2
    assert result["builder_result"]["prepare_result_count"] == 2
    assert result["builder_result"]["prepare_retry_executed"] is True
    assert result["builder_result"]["creative_plan_accepted"] is True
    assert result["builder_result"]["root_failure_code"] == "deck_creative_plan_invalid"
    assert result["builder_deck_prepare_phase"] == "terminal"
    diagnostics = result["builder_pptx_diagnostics"]
    assert diagnostics["prepare_call_count"] == 2
    assert diagnostics["prepare_emitted_call_count"] == 2
    assert diagnostics["prepare_execution_count"] == 2
    assert diagnostics["prepare_normalized_call_count"] == 2
    assert diagnostics["prepare_service_call_count"] == 2
    assert diagnostics["prepare_service_result_count"] == 2
    assert diagnostics["prepare_result_count"] == 2
    assert diagnostics["prepare_retry_executed"] is True
    assert diagnostics["creative_plan_accepted"] is True
    assert not any("interrupted and did not return" in str(message.content) for message in result["messages"])
    assert any(call.get("tool_choice") for call in model._bind_calls)


def test_presentation_prepare_latch_forces_turn_eight() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_non_artifact_turns": 7,
        "builder_budget": {
            "max_non_artifact_turns": 12,
            "prepare_force_at_turn": 8,
            "prepare_force_after_seconds": 120,
        },
    }

    choice, update = BuilderArtifactMiddleware()._force_choice_plan_for_state(state)

    assert choice == {"type": "tool", "name": "prepare_deck_build"}
    assert update is not None
    assert update["builder_deck_prepare_latch_active"] is True
    assert update["builder_pptx_diagnostics"]["prepare_latch_activated_at_turn"] == 8


def test_presentation_without_research_forces_prepare_immediately() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "allow_web_research": False,
    }
    middleware = BuilderArtifactMiddleware()

    phase_update = middleware._presentation_phase_before_model_update(state)
    assert phase_update is not None
    assert phase_update["builder_presentation_phase"] == "authoring_pending"
    assert phase_update["builder_pptx_diagnostics"]["presentation_preflight_status"] == "skipped"

    choice, force_update = middleware._force_choice_plan_for_state({**state, **phase_update})
    assert choice == {"type": "tool", "name": "prepare_deck_build"}
    assert force_update is not None
    assert force_update["builder_pptx_diagnostics"]["prepare_force_reason"] == "research_disabled"


@pytest.mark.parametrize(
    ("explicit_urls", "expected_tool"),
    [([], "builder_web_search"), (["https://example.com/source"], "builder_web_fetch")],
)
def test_presentation_research_uses_exactly_one_bounded_preflight(
    explicit_urls: list[str],
    expected_tool: str,
) -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "allow_web_research": True,
        "explicit_user_urls": explicit_urls,
    }
    middleware = BuilderArtifactMiddleware()
    phase_update = middleware._presentation_phase_before_model_update(state)
    assert phase_update is not None
    preflight_state = {**state, **phase_update}

    choice, force_update = middleware._force_choice_plan_for_state(preflight_state)
    assert choice == {"type": "tool", "name": expected_tool}
    assert force_update is not None
    assert force_update["builder_presentation_phase"] == "preflight_call_emitted"

    result = ToolMessage(content="bounded source context", name=expected_tool, tool_call_id="preflight-1")
    completed_state = {
        **preflight_state,
        **force_update,
        "messages": [result],
    }
    next_update = middleware._presentation_phase_before_model_update(completed_state)
    assert next_update is not None
    assert next_update["builder_presentation_phase"] == "authoring_pending"
    next_state = {**completed_state, **next_update}
    prepare_choice, _ = middleware._force_choice_plan_for_state(next_state)
    assert prepare_choice == {"type": "tool", "name": "prepare_deck_build"}


def test_forced_presentation_authoring_uses_only_compact_prepare_context() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {
            "task_type": "presentation",
            "task": "Create a concise six-slide systems presentation.",
            "relevant_memories": ["Prefer terse technical headlines."],
            "uploaded_image_paths": ["/mnt/user-data/uploads/architecture.png"],
        },
        "allow_web_research": False,
        "builder_presentation_phase": "authoring_pending",
        "builder_task_kickoff_ms": int(time.time() * 1000),
        "builder_budget": {
            "tier": "presentation",
            "prepare_force_after_seconds": 8,
            "authoring_deadline_seconds": 120,
            "authoring_max_tokens": 16_384,
        },
    }
    request = _ModelRequest(
        state,
        tools=[_builder_web_search, _builder_web_fetch, _bash, prepare_deck_build],
        messages=[
            HumanMessage(content="Create a concise six-slide systems presentation."),
            AIMessage(content="general-agent planning that must not be replayed"),
        ],
    )

    bounded, update = BuilderArtifactMiddleware._presentation_request_for_choice(
        request,
        {"type": "tool", "name": "prepare_deck_build"},
    )

    assert [tool.name for tool in bounded.tools] == ["prepare_deck_build"]
    assert len(bounded.messages) == 1
    assert "general-agent planning" not in str(bounded.messages[0].content)
    assert "architecture.png" in str(bounded.messages[0].content)
    assert "Prefer terse technical headlines" in str(bounded.messages[0].content)
    assert "compact_model_html_v2" in bounded.system_prompt
    assert "Do not use lossy CSS properties: box-shadow, letter-spacing, opacity, text-shadow" in bounded.system_prompt
    assert "creative_plan as a JSON object" in bounded.system_prompt
    assert bounded.model_settings["max_tokens"] == 16_384
    assert update is not None
    diagnostics = update["builder_pptx_diagnostics"]
    assert diagnostics["deck_authoring_context_bytes"] <= 40 * 1024
    assert diagnostics["deck_authoring_tool_schema_bytes"] > 0


def test_presentation_preflight_model_timeout_continues_to_authoring() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation", "task": "Create a deck."},
        "allow_web_research": True,
        "builder_presentation_phase": "preflight_pending",
        "builder_presentation_preflight_started_at_ms": int(time.time() * 1000) - 950,
        "builder_task_kickoff_ms": int(time.time() * 1000),
        "builder_budget": {
            "tier": "presentation",
            "preflight_timeout_seconds": 1,
            "authoring_deadline_seconds": 120,
        },
    }

    async def slow_handler(_request):
        await asyncio.sleep(0.5)
        return AIMessage(content="late")

    started = time.monotonic()
    result = asyncio.run(
        BuilderArtifactMiddleware().awrap_model_call(
            _ModelRequest(state, tools=[_builder_web_search, prepare_deck_build]),
            slow_handler,
        )
    )

    assert time.monotonic() - started < 0.35
    assert isinstance(result, ExtendedModelResponse)
    assert isinstance(result.model_response, ModelResponse)
    assert result.model_response.result[0].additional_kwargs["error_reason"] == "presentation_preflight_timeout"
    assert result.command is not None
    assert result.command.update["builder_presentation_phase"] == "authoring_pending"
    assert result.command.update["builder_pptx_diagnostics"]["presentation_preflight_status"] == "timed_out"


def test_expired_preflight_timeout_flows_through_async_agent_middleware(tmp_path: Path) -> None:
    model = _PrepareSequenceModel([])
    agent = create_agent(
        model=model,
        tools=[_builder_web_search, prepare_deck_build],
        middleware=[BuilderArtifactMiddleware()],
        state_schema=_DeckRuntimeState,
    )

    result = asyncio.run(
        agent.ainvoke(
            {
                "messages": [HumanMessage(content="Build a researched PPTX")],
                "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
                "delegation_context": {
                    "task_type": "presentation",
                    "task": "Build a researched PPTX",
                },
                "allow_web_research": True,
                "builder_presentation_phase": "preflight_pending",
                "builder_presentation_preflight_started_at_ms": int(time.time() * 1000) - 30_000,
                "builder_task_kickoff_ms": int(time.time() * 1000),
                "builder_budget": {
                    "tier": "presentation",
                    "preflight_timeout_seconds": 1,
                    "authoring_deadline_seconds": 120,
                },
                "thread_data": {
                    "outputs_path": str(tmp_path / "outputs"),
                    "workspace_path": str(tmp_path / "workspace"),
                },
            },
            context={"thread_id": "builder-thread"},
        )
    )

    assert result["builder_presentation_phase"] == "authoring_pending"
    timeout_messages = [
        message
        for message in result["messages"]
        if isinstance(message, AIMessage)
        and message.additional_kwargs.get("error_reason") == "presentation_preflight_timeout"
    ]
    assert len(timeout_messages) == 1


def test_research_preflight_runs_once_then_prepare_finalizes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"pptx")
    search_calls: list[str] = []
    prepare_calls: list[dict[str, Any]] = []

    @tool("builder_web_search")
    def fake_builder_web_search(query: str) -> str:
        """Return one bounded source result."""
        search_calls.append(query)
        return "Primary source: https://example.com/source"

    @tool("prepare_deck_build")
    def fake_prepare_deck_build(
        deck_title: str,
        slides: list[dict[str, Any]],
        output_path: str,
        creative_plan: dict[str, Any],
    ) -> str:
        """Return one successful authoritative deck result."""
        prepare_calls.append(creative_plan)
        return json.dumps(
            {
                "success": True,
                "build_id": "deck-preflight",
                "pptx_path": output_path,
                "deck_route": "deck_creative_html_native",
                "deck_compile_mode": "native_html2patch",
                "slide_count": 1,
                "quality_status": "passed",
                "native_editability_score": 1.0,
                "native_text_shape_count": 2,
                "picture_shape_count": 0,
                "full_slide_picture_count": 0,
            }
        )

    monkeypatch.setattr(BuilderArtifactMiddleware, "_upload_fallback_and_fire", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_attach_pptx_canvas_preview",
        staticmethod(lambda artifact, _state: artifact),
    )
    model = _PrepareSequenceModel(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "preflight-1",
                        "name": "builder_web_search",
                        "args": {"query": "bounded systems deck research"},
                    }
                ],
            ),
            _prepare_call("prepare-1", repaired=False),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[fake_builder_web_search, fake_prepare_deck_build],
        middleware=[BuilderArtifactMiddleware(), DanglingToolCallMiddleware()],
        state_schema=_DeckRuntimeState,
    )

    result = agent.invoke(
        {
            "messages": [HumanMessage(content="Build a one-slide researched PPTX")],
            "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
            "delegation_context": {"task_type": "presentation", "task": "Build a researched PPTX"},
            "allow_web_research": True,
            "thread_data": {"outputs_path": str(outputs), "workspace_path": str(tmp_path / "workspace")},
        },
        context={"thread_id": "builder-thread"},
    )

    assert search_calls == ["bounded systems deck research"]
    assert prepare_calls == [{"repaired": False}]
    assert result["builder_result"]["status"] == "completed"
    assert result["builder_result"]["presentation_preflight_status"] == "completed"
    assert result["builder_result"]["first_prepare_turn"] == 2
    assert result["builder_presentation_phase"] == "terminal"


def test_service_owned_presentation_completion_never_forces_write_file() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_non_artifact_turns": 10,
        "builder_budget": {
            "max_non_artifact_turns": 12,
            "force_emit_remaining_turns": 2,
            "prepare_force_at_turn": 8,
            "prepare_force_after_seconds": 120,
        },
    }

    choice = BuilderArtifactMiddleware()._completion_tool_choice_for_state(state)

    assert choice == {"type": "tool", "name": "prepare_deck_build"}


def test_presentation_model_request_is_bounded_by_authoring_deadline() -> None:
    authoring_started_ms = int(time.time() * 1000) - 30_000
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_task_kickoff_ms": int(time.time() * 1000) - 90_000,
        "builder_presentation_authoring_started_at_ms": authoring_started_ms,
        "builder_budget": {
            "tier": "presentation",
            "prepare_force_after_seconds": 15,
            "authoring_deadline_seconds": 720,
            "authoring_max_tokens": 16_384,
            "authoring_timeout_seconds": 360,
        },
    }

    request = BuilderArtifactMiddleware._bounded_presentation_model_request(_ModelRequest(state))

    assert request.model_settings["max_tokens"] == 16_384
    assert request.model_settings["timeout"] == 360
    assert "max_retries" not in request.model_settings


def test_presentation_authoring_budget_starts_after_preflight() -> None:
    now_ms = int(time.time() * 1000)
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_task_kickoff_ms": now_ms - 300_000,
        "builder_presentation_authoring_started_at_ms": now_ms - 60_000,
        "builder_budget": {
            "tier": "presentation",
            "authoring_deadline_seconds": 720,
            "authoring_timeout_seconds": 700,
        },
    }

    request = BuilderArtifactMiddleware._bounded_presentation_model_request(_ModelRequest(state))

    assert 659 <= request.model_settings["timeout"] <= 660


def test_presentation_authoring_stream_is_cancelled_at_absolute_deadline() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_task_kickoff_ms": int(time.time() * 1000) - 950,
        "builder_budget": {
            "tier": "presentation",
            "prepare_force_after_seconds": 8,
            "authoring_deadline_seconds": 1,
            "authoring_max_tokens": 16_384,
            "authoring_timeout_seconds": 110,
        },
    }
    calls = 0

    async def slow_handler(_request):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.5)
        return AIMessage(content="late")

    started = time.monotonic()
    result = asyncio.run(
        BuilderArtifactMiddleware().awrap_model_call(
            _ModelRequest(state),
            slow_handler,
        )
    )

    assert calls == 1
    assert time.monotonic() - started < 0.35
    assert isinstance(result, AIMessage)
    assert result.additional_kwargs["error_reason"] == "authoring_deadline"


def test_presentation_repair_stream_keeps_original_authoring_deadline() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_task_kickoff_ms": int(time.time() * 1000) - 950,
        "builder_deck_prepare_phase": "retry_pending",
        "builder_presentation_phase": "authoring_pending",
        "builder_pptx_diagnostics": {
            "prepare_emitted_call_count": 1,
            "prepare_result_count": 1,
        },
        "builder_budget": {
            "tier": "presentation",
            "prepare_force_after_seconds": 8,
            "authoring_deadline_seconds": 1,
            "authoring_max_tokens": 16_384,
            "authoring_timeout_seconds": 110,
        },
    }
    calls = 0

    async def slow_handler(_request):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.5)
        return AIMessage(content="late repair")

    started = time.monotonic()
    result = asyncio.run(
        BuilderArtifactMiddleware().awrap_model_call(
            _ModelRequest(state, tools=[prepare_deck_build]),
            slow_handler,
        )
    )

    assert calls == 1
    assert time.monotonic() - started < 0.35
    assert isinstance(result, ExtendedModelResponse)
    assert isinstance(result.model_response, ModelResponse)
    assert result.command is not None
    assert result.model_response.result[-1].additional_kwargs["error_reason"] == "authoring_deadline"


def test_authoring_deadline_takes_precedence_over_output_truncation(monkeypatch) -> None:
    latest = AIMessage(content="partial", response_metadata={"stop_reason": "max_tokens"})
    state = {
        "messages": [latest],
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_task_kickoff_ms": int(time.time() * 1000) - 121_000,
        "builder_budget": {
            "tier": "presentation",
            "prepare_force_after_seconds": 8,
            "authoring_deadline_seconds": 120,
        },
    }
    captured: dict[str, str] = {}

    def terminal(_state, _runtime, *, failure_code, tool_calls=None):
        captured["failure_code"] = failure_code
        return {"failure_code": failure_code}

    middleware = BuilderArtifactMiddleware()
    monkeypatch.setattr(middleware, "_deck_authoring_terminal_update", terminal)

    update = middleware._deck_authoring_message_failure_update(state, object(), latest)

    assert update == {"failure_code": "deck_authoring_deadline_exceeded"}
    assert captured["failure_code"] == "deck_authoring_deadline_exceeded"


def test_presentation_model_settings_are_valid_anthropic_message_parameters() -> None:
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
        "delegation_context": {"task_type": "presentation"},
        "builder_task_kickoff_ms": int(time.time() * 1000) - 10_000,
        "builder_budget": {
            "tier": "presentation",
            "prepare_force_after_seconds": 120,
            "authoring_max_tokens": 16_384,
            "authoring_timeout_seconds": 110,
        },
    }
    request = BuilderArtifactMiddleware._bounded_presentation_model_request(_ModelRequest(state))
    model = ChatAnthropic(
        model="claude-sonnet-4-5",
        api_key="test-anthropic-key",
        max_tokens=16_384,
        streaming=False,
    )

    payload = model._get_request_payload(
        [HumanMessage(content="Create the deck.")],
        **request.model_settings,
    )
    provider_parameters = set(inspect.signature(AsyncMessages.create).parameters)

    assert set(payload).issubset(provider_parameters)
    assert "max_retries" not in payload


def test_presentation_authoring_disables_provider_fallback() -> None:
    state = {
        "builder_budget": {"tier": "presentation"},
        "builder_pptx_diagnostics": {"prepare_emitted_call_count": 0},
    }
    request = _ModelRequest(state)
    calls = 0

    def handler(_request):
        nonlocal calls
        calls += 1
        raise RuntimeError("primary failed")

    with pytest.raises(RuntimeError, match="primary failed"):
        BuilderProviderFallbackMiddleware().wrap_model_call(request, handler)

    assert calls == 1


def test_missing_retry_result_terminalizes_before_dangling_repair(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[dict[str, Any]] = []

    @tool("prepare_deck_build")
    def fake_prepare_deck_build(
        deck_title: str,
        slides: list[dict[str, Any]],
        output_path: str,
        creative_plan: dict[str, Any],
    ) -> str:
        """Return one retryable result; the test router skips the second call."""
        calls.append(creative_plan)
        if len(calls) > 1:  # pragma: no cover - the assertion below proves this is unreachable.
            raise AssertionError("second prepare call should have been skipped by the test router")
        return json.dumps(
            {
                "success": False,
                "build_id": "deck-1",
                "failure_code": "deck_creative_plan_invalid",
                "failure_summary": "creative_plan.slide_compositions[0].headline_intent is required",
                "retryable": True,
                "repair_instruction": {"repair_message": "Add the missing headline_intent."},
                "slide_count": 1,
                "quality_status": "failed",
            }
        )

    monkeypatch.setattr(
        BuilderArtifactMiddleware,
        "_upload_fallback_and_fire",
        lambda *args, **kwargs: None,
    )
    model = _PrepareSequenceModel(
        [
            _prepare_call("prepare-1", repaired=False),
            _prepare_call("prepare-2", repaired=True),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[fake_prepare_deck_build],
        middleware=[
            _SkipRetryToolsMiddleware(),
            BuilderArtifactMiddleware(),
            DanglingToolCallMiddleware(),
        ],
        state_schema=_DeckRuntimeState,
    )

    result = agent.invoke(
        {
            "messages": [HumanMessage(content="Build a one-slide PPTX")],
            "builder_artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
            "delegation_context": {"task_type": "presentation", "task": "Build a one-slide PPTX"},
            "allow_web_research": False,
            "thread_data": {"outputs_path": str(tmp_path / "outputs"), "workspace_path": str(tmp_path / "workspace")},
        },
        context={"thread_id": "builder-thread"},
    )

    assert calls == [{"repaired": False}]
    assert result["builder_result"]["failure_code"] == "deck_prepare_tool_result_missing"
    assert result["builder_deck_prepare_phase"] == "terminal"
    assert result["builder_pptx_diagnostics"]["dangling_prepare_call_count"] == 1
    assert not any("interrupted and did not return" in str(message.content) for message in result["messages"])
