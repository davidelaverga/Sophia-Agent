from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, NotRequired, override

from langchain.agents import AgentState, create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import hook_config
from langchain.chat_models.base import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool, tool
from langgraph.runtime import Runtime
from pydantic import PrivateAttr

from deerflow.agents.middlewares.dangling_tool_call_middleware import (
    DanglingToolCallMiddleware,
)
from deerflow.agents.sophia_agent.middlewares import builder_artifact as artifact_module
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    BuilderArtifactState,
)


class _DeckRuntimeState(BuilderArtifactState):
    thread_data: NotRequired[dict[str, Any]]


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
    assert diagnostics["prepare_normalized_call_count"] == 2
    assert diagnostics["prepare_service_call_count"] == 2
    assert diagnostics["prepare_service_result_count"] == 2
    assert diagnostics["prepare_result_count"] == 2
    assert diagnostics["prepare_retry_executed"] is True
    assert diagnostics["creative_plan_accepted"] is True
    assert not any(
        "interrupted and did not return" in str(message.content)
        for message in result["messages"]
    )
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
    assert not any(
        "interrupted and did not return" in str(message.content)
        for message in result["messages"]
    )
