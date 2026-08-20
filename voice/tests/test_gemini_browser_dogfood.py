from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any

import httpx
import pytest
import voice.realtime.gemini_tool_loop as gemini_tool_loop
import voice.realtime.sophia_backend_tools as sophia_backend_tools
from fastapi import FastAPI
from fastapi.testclient import TestClient
from voice.realtime import (
    GEMINI_EMIT_ARTIFACT_TOOL_NAME,
    GeminiBrowserDogfoodSessionManager,
    GeminiBrowserRelayError,
    GeminiLiveEphemeralToken,
    GeminiProductionBrowserSessionManager,
    RealtimeDogfoodSessionManager,
    VoiceRuntimeMode,
    gemini_dogfood_tool_declarations,
    validate_gemini_production_route_settings,
)
from voice.realtime.gemini_browser_dogfood import GeminiRelaySourceMetadata
from voice.realtime.sophia_prompt import (
    EMOTIONAL_SKILLS_REPERTOIRE_SOURCE,
    GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE,
    gemini_live_realtime_instruction_sources,
)
from voice.tests.conftest import make_settings

ARTIFACT_FIELD_NAMES = {
    "session_goal",
    "active_goal",
    "next_step",
    "takeaway",
    "reflection",
    "tone_estimate",
    "tone_target",
    "active_tone_band",
    "skill_loaded",
    "ritual_phase",
    "voice_emotion_primary",
    "voice_emotion_secondary",
    "voice_speed",
}

BACKEND_EMIT_ARTIFACT_IMPLEMENTATION_MODULE = "deerflow.sophia.tools.emit_artifact"
BACKEND_START_BUILDER_IMPLEMENTATION_MODULE = "deerflow.sophia.tools.start_builder_task"
EXPECTED_GEMINI_TOOL_NAMES = [
    GEMINI_EMIT_ARTIFACT_TOOL_NAME,
    "start_builder_task",
    "edit_builder_artifact",
    "check_async_task",
    "update_async_task",
    "cancel_async_task",
    "list_async_tasks",
    "retrieve_memories",
]


def _gemini_settings(**overrides: object):  # noqa: ANN202
    return make_settings(
        voice_runtime_mode=VoiceRuntimeMode.GEMINI_LIVE.value,
        experimental_realtime_runtime_enabled=True,
        gemini_live_adapter_enabled=True,
        **overrides,
    )


def _gemini_production_settings(**overrides: object):  # noqa: ANN202
    return make_settings(
        voice_runtime_mode=VoiceRuntimeMode.GEMINI_LIVE.value,
        experimental_realtime_runtime_enabled=True,
        gemini_live_adapter_enabled=True,
        gemini_production_route_enabled=True,
        **overrides,
    )


def _set_gemini_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STREAM_API_KEY", "stream-key")
    monkeypatch.setenv("STREAM_API_SECRET", "stream-secret")
    monkeypatch.setenv("GOOGLE_API_KEY", "standard-google-key")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED", "true")


def _artifact_payload(**overrides: object) -> dict[str, object]:
    artifact: dict[str, object] = {
        "session_goal": "Probe Gemini artifacts.",
        "active_goal": "Confirm backend tool loop.",
        "next_step": "Read the debug page.",
        "takeaway": "Tool response returned.",
        "reflection": None,
        "tone_estimate": 2.0,
        "tone_target": 2.5,
        "active_tone_band": "engagement",
        "skill_loaded": "active_listening",
        "ritual_phase": "freeform.tool_loop",
        "voice_emotion_primary": "calm",
        "voice_emotion_secondary": "sympathetic",
        "voice_speed": "normal",
    }
    artifact.update(overrides)
    return artifact


class FakeGeminiTokenMinter:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def mint_ephemeral_token(
        self,
        *,
        api_key: str,
        setup: Mapping[str, Any],
        uses: int = 1,
    ) -> GeminiLiveEphemeralToken:
        self.requests.append({"api_key": api_key, "setup": dict(setup), "uses": uses})
        return GeminiLiveEphemeralToken(
            value="auth_tokens/gemini-browser-test",
            response={"name": "auth_tokens/gemini-browser-test"},
        )


class FakeBuilderLifecycleBackend:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def execute(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        *,
        session_id: str,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: Mapping[str, dict[str, Any]],
    ) -> gemini_tool_loop.GeminiBuilderLifecycleResult:
        self.calls.append(
            {
                "tool_name": tool_name,
                "args": dict(args),
                "session_id": session_id,
                "user_id": user_id,
                "runtime_mode": runtime_mode.value,
                "provider": provider,
                "async_tasks": dict(async_tasks),
            }
        )
        if tool_name in {"check_async_task", "update_async_task", "cancel_async_task"}:
            task_id = str(args["task_id"])
            if task_id not in async_tasks:
                raise gemini_tool_loop.GeminiBuilderTaskNotTrackedError(
                    task_id,
                    sorted(str(known_task_id) for known_task_id in async_tasks),
                )
        if tool_name == "start_builder_task":
            async_task = {
                "task_id": "builder-thread-1",
                "agent_name": "sophia_builder",
                "thread_id": "builder-thread-1",
                "run_id": "run-1",
                "status": "running",
                "created_at": "2026-05-19T00:00:00Z",
                "last_checked_at": "2026-05-19T00:00:00Z",
                "last_updated_at": "2026-05-19T00:00:00Z",
                "task_type": args.get("task_type", "document"),
            }
            return gemini_tool_loop.GeminiBuilderLifecycleResult(
                response={
                    "ok": True,
                    "tool": tool_name,
                    "started": True,
                    "task_id": "builder-thread-1",
                    "status": "running",
                    "async_task": async_task,
                    "result_summary": "Launched builder task. task_id: builder-thread-1.",
                },
                result_summary="Existing Sophia builder task launched: builder-thread-1.",
                updated_async_tasks={"builder-thread-1": async_task},
            )
        if tool_name == "edit_builder_artifact":
            async_task = {
                "task_id": "builder-edit-thread-1",
                "agent_name": "sophia_builder",
                "thread_id": "builder-edit-thread-1",
                "run_id": "run-edit-1",
                "status": "running",
                "created_at": "2026-05-19T00:00:00Z",
                "last_checked_at": "2026-05-19T00:00:00Z",
                "last_updated_at": "2026-05-19T00:00:00Z",
                "task_type": "document",
                "edit_mode": "edit_existing_artifact",
                "source_artifact_path": args.get("artifact_path") or "mnt/user-data/outputs/report.md",
                "revision_of_artifact_path": args.get("artifact_path") or "mnt/user-data/outputs/report.md",
            }
            return gemini_tool_loop.GeminiBuilderLifecycleResult(
                response={
                    "ok": True,
                    "tool": tool_name,
                    "started": True,
                    "task_id": "builder-edit-thread-1",
                    "status": "running",
                    "async_task": async_task,
                    "result_summary": "Launched builder artifact edit. task_id: builder-edit-thread-1.",
                },
                result_summary="Existing Sophia builder artifact edit launched: builder-edit-thread-1.",
                updated_async_tasks={"builder-edit-thread-1": async_task},
            )
        if tool_name == "check_async_task":
            task = dict(async_tasks[str(args["task_id"])])
            task["status"] = "success"
            return gemini_tool_loop.GeminiBuilderLifecycleResult(
                response={
                    "ok": True,
                    "tool": tool_name,
                    "task_id": args["task_id"],
                    "status": "success",
                    "result": {"status": "success", "result": "Done."},
                    "async_task": task,
                    "result_summary": "Builder task builder-thread-1 completed successfully.",
                },
                result_summary="Builder task builder-thread-1 completed successfully.",
                updated_async_tasks={"builder-thread-1": task},
            )
        if tool_name == "update_async_task":
            task = dict(async_tasks[str(args["task_id"])])
            task["run_id"] = "run-2"
            task["status"] = "running"
            return gemini_tool_loop.GeminiBuilderLifecycleResult(
                response={
                    "ok": True,
                    "tool": tool_name,
                    "task_id": args["task_id"],
                    "run_id": "run-2",
                    "status": "running",
                    "async_task": task,
                    "result_summary": "Updated builder task. task_id: builder-thread-1.",
                },
                result_summary="Updated builder task. task_id: builder-thread-1.",
                updated_async_tasks={"builder-thread-1": task},
            )
        if tool_name == "cancel_async_task":
            task = dict(async_tasks[str(args["task_id"])])
            task["status"] = "cancelled"
            return gemini_tool_loop.GeminiBuilderLifecycleResult(
                response={
                    "ok": True,
                    "tool": tool_name,
                    "task_id": args["task_id"],
                    "status": "cancelled",
                    "async_task": task,
                    "result_summary": "Cancelled builder task. task_id: builder-thread-1.",
                },
                result_summary="Cancelled builder task. task_id: builder-thread-1.",
                updated_async_tasks={"builder-thread-1": task},
            )
        if tool_name == "list_async_tasks":
            return gemini_tool_loop.GeminiBuilderLifecycleResult(
                response={
                    "ok": True,
                    "tool": tool_name,
                    "tasks": [
                        {
                            "task_id": task_id,
                            "status": task.get("status"),
                            "agent_name": task.get("agent_name"),
                        }
                        for task_id, task in async_tasks.items()
                    ],
                    "task_count": len(async_tasks),
                    "result_summary": f"{len(async_tasks)} tracked builder task(s).",
                },
                result_summary=f"{len(async_tasks)} tracked builder task(s).",
            )
        raise AssertionError(f"Unexpected fake tool {tool_name}")


def _patch_gateway_memory_response(
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response,
) -> list[dict[str, Any]]:
    requests: list[dict[str, Any]] = []

    class FakeAsyncClient:
        def __init__(self, *, timeout: float) -> None:
            self.timeout = timeout

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(
            self,
            url: str,
            *,
            json: Mapping[str, Any],
            headers: Mapping[str, str],
        ) -> httpx.Response:
            requests.append(
                {
                    "url": url,
                    "json": dict(json),
                    "headers": dict(headers),
                    "timeout": self.timeout,
                }
            )
            return response

    monkeypatch.setattr(gemini_tool_loop.httpx, "AsyncClient", FakeAsyncClient)
    return requests


class BlockingGeminiToolExecutor:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def execute(
        self,
        function_call: gemini_tool_loop.GeminiLiveFunctionCall,
        *,
        session_id: str,
        user_id: str,
        runtime_mode: VoiceRuntimeMode,
        provider: str,
        async_tasks: dict[str, dict[str, Any]],
        **_kwargs: Any,
    ) -> gemini_tool_loop.GeminiDogfoodToolExecution:
        self.started.set()
        await self.release.wait()
        return gemini_tool_loop.GeminiDogfoodToolExecution(
            call=function_call,
            response={
                "ok": True,
                "tool": function_call.name,
                "session_id": session_id,
                "user_id": user_id,
                "runtime": runtime_mode.value,
                "provider": provider,
                "result_summary": "Tool completed after cancellation.",
            },
            result_summary="Tool completed after cancellation.",
        )


class CapturingBuilderLifecycleHttpBackend(gemini_tool_loop.GeminiBuilderLifecycleHttpBackend):
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        super().__init__(langgraph_url="http://langgraph.test")
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, Any] | None = None,
        allow_empty: bool = False,
    ) -> dict[str, Any]:
        self.requests.append(
            {
                "method": method,
                "path": path,
                "json_body": json_body,
                "params": dict(params or {}),
                "allow_empty": allow_empty,
            }
        )
        if not self.responses:
            raise AssertionError(f"No fake LangGraph response queued for {method} {path}")
        return self.responses.pop(0)


@pytest.mark.anyio
async def test_voice_presentation_builder_seeds_authoring_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_BUILDER_PRESENTATION_BUDGET_AUTHORING_MAX_TOKENS", "32768")
    backend = CapturingBuilderLifecycleHttpBackend(
        [{"thread_id": "builder-thread-voice"}, {"run_id": "run-voice"}]
    )

    result = await backend.execute(
        "start_builder_task",
        {
            "description": "Make a short presentation about reliable background agents.",
            "task_type": "presentation",
        },
        session_id="gemini-prod-voice-session",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="gemini",
        async_tasks={},
    )

    assert result.response["status"] == "running"
    run_input = backend.requests[1]["json_body"]["input"]
    assert run_input["builder_budget"]["tier"] == "presentation"
    assert run_input["builder_budget"]["authoring_max_tokens"] == 32768


def _make_backend_emit_artifact_import_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    sophia_backend_tools._emit_artifact_contract_module.cache_clear()
    sophia_backend_tools._builder_lifecycle_contract_module.cache_clear()
    original_import_module = sophia_backend_tools.importlib.import_module

    def guarded_import_module(name: str, package: str | None = None) -> object:
        if name in {
            BACKEND_EMIT_ARTIFACT_IMPLEMENTATION_MODULE,
            BACKEND_START_BUILDER_IMPLEMENTATION_MODULE,
        }:
            raise ModuleNotFoundError("No module named 'langchain_core'")
        return original_import_module(name, package)

    monkeypatch.setattr(sophia_backend_tools.importlib, "import_module", guarded_import_module)


def test_gemini_tool_declarations_align_with_prompt_and_use_dependency_safe_contracts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _make_backend_emit_artifact_import_fail(monkeypatch)

    declarations = gemini_dogfood_tool_declarations()

    tool_declarations = declarations[0]["functionDeclarations"]
    assert [tool["name"] for tool in tool_declarations] == EXPECTED_GEMINI_TOOL_NAMES
    assert "consult_skill" not in [tool["name"] for tool in tool_declarations]
    assert "consult_skill" not in json.dumps(declarations)
    assert "sophia_tool_probe" not in json.dumps(declarations)
    emit_artifact_declaration = tool_declarations[0]
    assert set(emit_artifact_declaration["parameters"]["properties"]) == ARTIFACT_FIELD_NAMES
    assert set(emit_artifact_declaration["parameters"]["required"]) == ARTIFACT_FIELD_NAMES
    emit_description = emit_artifact_declaration["description"].lower()
    assert "lightweight sophia companion/session artifacts" in emit_description
    assert "short reflection artifact" in emit_description
    assert "presence artifact ui" in emit_description
    assert "do not ask a" in emit_description
    assert "reflective follow-up question first" in emit_description
    assert "do not start builder" in emit_description
    start_builder_declaration = tool_declarations[1]
    assert set(start_builder_declaration["parameters"]["required"]) == {"description", "task_type"}
    start_description = start_builder_declaration["description"].lower()
    assert "async user-facing deliverable" in start_description
    assert "document, file, report" in start_description
    assert "do not use builder for lightweight sophia companion/session artifacts" in start_description
    assert "belong to emit_artifact" in start_description
    assert "ask one clarifying question" in start_description
    assert "FIRST builder tool" in start_builder_declaration["description"]
    assert "Returns the real task_id" in start_builder_declaration["description"]
    assert start_builder_declaration["parameters"]["properties"]["task_type"]["enum"] == [
        "document",
        "research",
        "presentation",
        "frontend",
        "visual_report",
    ]
    edit_declaration = tool_declarations[2]
    check_declaration = tool_declarations[3]
    update_declaration = tool_declarations[4]
    cancel_declaration = tool_declarations[5]
    list_declaration = tool_declarations[6]
    retrieve_declaration = tool_declarations[7]
    assert edit_declaration["name"] == "edit_builder_artifact"
    assert set(edit_declaration["parameters"]["required"]) == {"message"}
    assert "completed Sophia builder artifact" in edit_declaration["description"]
    assert "Do not use for active builds" in edit_declaration["description"]
    assert "Use ONLY with a real task_id" in check_declaration["description"]
    assert "Never invent a task id" in check_declaration["description"]
    assert "current trusted session" in check_declaration["description"]
    assert "tracked running builder task" in update_declaration["description"]
    assert "Never invent task ids" in update_declaration["description"]
    assert "tracked running builder task" in cancel_declaration["description"]
    assert "Never invent task ids" in cancel_declaration["description"]
    assert "not as a substitute for starting a new build" in list_declaration["description"]
    assert "start_builder_task first" in list_declaration["description"]
    assert "short reflection or companion/session artifact" in list_declaration["description"]
    assert "emit_artifact instead" in list_declaration["description"]
    assert retrieve_declaration["name"] == "retrieve_memories"
    assert set(retrieve_declaration["parameters"]["properties"]) == {"query"}
    assert retrieve_declaration["parameters"]["required"] == ["query"]
    assert "user_id" not in retrieve_declaration["parameters"]["properties"]
    assert "categories" not in retrieve_declaration["parameters"]["properties"]
    assert "explicit memory" in retrieve_declaration["description"]
    assert "do you remember my favorite childhood movie" in retrieve_declaration["description"]
    assert "what did we talk about last time" in retrieve_declaration["description"]
    assert "have I told you about" in retrieve_declaration["description"]
    assert "later specific recall question is a new retrieval opportunity" in retrieve_declaration["description"]
    assert "simple greetings" in retrieve_declaration["description"]
    assert "what is my name" in retrieve_declaration["description"]
    assert "every turn" in retrieve_declaration["description"]
    assert "never invent task ids" in check_declaration["parameters"]["properties"]["task_id"]["description"]
    assert "langchain" not in json.dumps(tool_declarations).lower()
    assert "deepagents" not in json.dumps(tool_declarations).lower()


@pytest.mark.anyio
async def test_browser_session_mints_gemini_ephemeral_token_without_promoting_default_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    _make_backend_emit_artifact_import_fail(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    fake_minter = FakeGeminiTokenMinter()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=fake_minter,  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-1",
    )

    payload = browser_session.as_public_payload()
    assert payload["session_id"] == "browser-gemini-1"
    assert payload["runtime"] == "gemini_live"
    assert payload["browser_audio"] == "gemini_live_websocket_experimental"
    assert payload["transport"] == "gemini_browser_websocket_ephemeral_token_with_backend_relay"
    assert payload["websocket_auth"] == "access_token_query_param"
    assert payload["ephemeral_token"] == {
        "value": "auth_tokens/gemini-browser-test",
        "name": "auth_tokens/gemini-browser-test",
    }
    assert payload["ephemeral_token"]["value"] != "standard-google-key"
    assert payload["memory_context"]["schema"] == "gemini_live_memory_context_v1"
    assert payload["memory_context"]["trusted_user_context"] is True
    assert payload["memory_context"]["injected"] is False
    assert fake_minter.requests[0]["api_key"] == "standard-google-key"
    assert fake_minter.requests[0]["uses"] == 1
    assert fake_minter.requests[0]["setup"]["model"] == "models/gemini-3.1-flash-live-preview"
    assert fake_minter.requests[0]["setup"]["inputAudioTranscription"] == {}
    assert fake_minter.requests[0]["setup"]["outputAudioTranscription"] == {}
    assert (
        fake_minter.requests[0]["setup"]["generationConfig"]["speechConfig"]["voiceConfig"][
            "prebuiltVoiceConfig"
        ]["voiceName"]
        == "Kore"
    )
    assert payload["gemini_voice_name"] == "Kore"
    assert payload["gemini_voice_source"] == "default"
    assert payload["gemini_voice_configured"] is False
    assert payload["gemini_voice_configured_value_valid"] is True
    tool_declarations = fake_minter.requests[0]["setup"]["tools"][0]["functionDeclarations"]
    assert [tool["name"] for tool in tool_declarations] == EXPECTED_GEMINI_TOOL_NAMES
    assert "consult_skill" not in [tool["name"] for tool in tool_declarations]
    emit_artifact_declaration = tool_declarations[0]
    assert set(emit_artifact_declaration["parameters"]["properties"]) == ARTIFACT_FIELD_NAMES
    assert set(emit_artifact_declaration["parameters"]["required"]) == ARTIFACT_FIELD_NAMES
    assert emit_artifact_declaration["parameters"]["properties"]["voice_speed"]["enum"] == [
        "slow",
        "gentle",
        "normal",
        "engaged",
        "energetic",
    ]
    system_instruction = fake_minter.requests[0]["setup"]["systemInstruction"]["parts"][0]["text"]
    assert "# Sophia — Soul" in system_instruction
    assert "# Sophia — Voice" in system_instruction
    assert "# Sophia — Techniques" in system_instruction
    assert "consult_skill" not in system_instruction
    assert "### §M — Your Skills (your repertoire for different moments)" in system_instruction
    assert "active_listening" in system_instruction
    assert "vulnerability_holding" in system_instruction
    assert "crisis_redirect" in system_instruction
    assert "trust_building" in system_instruction
    assert "boundary_holding" in system_instruction
    assert "challenging_growth" in system_instruction
    assert "identity_fluidity_support" in system_instruction
    assert "celebrating_breakthrough" in system_instruction
    assert "No exploring, no techniques, no prediction, no build" in system_instruction
    assert "not the record of a tool call" in system_instruction
    assert "Platform: voice. Respond in 1-3 sentences." in system_instruction
    assert "<realtime_memory_recall_guidance>" in system_instruction
    assert "Broad recall and later specific recall are separate opportunities" in system_instruction
    assert "After a user reveals or corrects an answer that was not retrieved" in system_instruction
    assert "### Voice Skill State" in system_instruction
    assert "session_count: unknown" in system_instruction
    assert "challenging_growth_allowed: false" in system_instruction
    assert system_instruction.index("### Voice Skill State") < system_instruction.index(
        "<gemini_live_spoken_turn_policy>"
    )
    assert "<artifact_contract>" in system_instruction
    assert "Use Builder only when the user explicitly asks for a document" in system_instruction
    assert "Tool calls must use the structured tool/function channel only" in system_instruction
    assert "try{emit_artifact" in system_instruction
    assert "<gemini_live_spoken_turn_policy>" in system_instruction
    assert "Choose one main conversational intent per assistant turn" in system_instruction
    assert "Ask at most one question total" in system_instruction
    assert "call emit_artifact directly with a minimal valid companion artifact" in system_instruction
    assert "Do not ask the user for a reflection question" in system_instruction
    assert "Do not assume the user is gaming" in system_instruction
    assert "latest complete user utterance" in system_instruction
    assert "quick question before I go" in system_instruction
    assert "sophia_tool_probe" not in json.dumps(fake_minter.requests[0]["setup"])
    assert gemini_live_realtime_instruction_sources() == [
        "skills/public/sophia/soul.md",
        "skills/public/sophia/voice.md",
        "skills/public/sophia/techniques.md",
        "skills/public/sophia/coordination_core.md",
        "skills/public/sophia/companion_delegation.md",
        EMOTIONAL_SKILLS_REPERTOIRE_SOURCE,
        "backend/packages/harness/deerflow/agents/sophia_agent/middlewares/platform_context.py::PLATFORM_PROMPTS",
        "skills/public/sophia/context/life.md",
        "voice/realtime/sophia_prompt.py::build_realtime_memory_recall_guidance",
        "backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py::_VOICE_ARTIFACT_INSTRUCTIONS",
        GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE,
    ]
    assert "setup" in payload

    legacy_manager = GeminiBrowserDogfoodSessionManager(RealtimeDogfoodSessionManager())
    with pytest.raises(Exception, match="gemini_live"):
        await legacy_manager.start_browser_session(make_settings(), user_id="user-1")

    await manager.close_session("browser-gemini-1")


@pytest.mark.anyio
async def test_trace_finalizer_runs_when_provider_close_raises() -> None:
    class FailingRealtimeSessions:
        async def close_session(self, _session_id: str) -> bool:
            raise RuntimeError("provider close failed")

    class RecordingTrace:
        def __init__(self) -> None:
            self.closed = False

        def close(self, **_: object) -> None:
            self.closed = True

    manager = GeminiBrowserDogfoodSessionManager(  # type: ignore[arg-type]
        FailingRealtimeSessions(),
    )
    trace = RecordingTrace()
    manager._traces_by_session["browser-gemini-close-error"] = trace  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="provider close failed"):
        await manager.close_session("browser-gemini-close-error")

    assert trace.closed is True
    assert "browser-gemini-close-error" not in manager._traces_by_session


@pytest.mark.anyio
async def test_browser_session_uses_configured_gemini_live_voice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    fake_minter = FakeGeminiTokenMinter()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=fake_minter,  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _gemini_settings(gemini_live_voice_name="Sulafat"),
        user_id="user-1",
        session_id="browser-gemini-sulafat",
    )

    setup = fake_minter.requests[0]["setup"]
    assert (
        setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"][
            "voiceName"
        ]
        == "Sulafat"
    )
    payload = browser_session.as_public_payload()
    assert payload["gemini_voice_name"] == "Sulafat"
    assert payload["gemini_voice_source"] == "env"
    assert payload["gemini_voice_configured"] is True
    assert payload["gemini_voice_configured_value_valid"] is True

    await manager.close_session("browser-gemini-sulafat")


@pytest.mark.anyio
async def test_browser_session_invalid_gemini_live_voice_falls_back_safely(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    fake_minter = FakeGeminiTokenMinter()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=fake_minter,  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _gemini_settings(gemini_live_voice_name="not-a-real-voice-secret"),
        user_id="user-1",
        session_id="browser-gemini-invalid-voice",
    )

    setup = fake_minter.requests[0]["setup"]
    assert (
        setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"][
            "voiceName"
        ]
        == "Kore"
    )
    payload = browser_session.as_public_payload()
    assert payload["gemini_voice_name"] == "Kore"
    assert payload["gemini_voice_source"] == "fallback_invalid"
    assert payload["gemini_voice_configured"] is True
    assert payload["gemini_voice_configured_value_valid"] is False
    assert payload["gemini_voice_diagnostic"] == "invalid_configured_voice"
    assert "not-a-real-voice-secret" not in json.dumps(payload)

    await manager.close_session("browser-gemini-invalid-voice")


@pytest.mark.anyio
async def test_browser_session_preconnect_uses_same_configured_gemini_live_voice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    fake_minter = FakeGeminiTokenMinter()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=fake_minter,  # type: ignore[arg-type]
    )
    settings = _gemini_settings(gemini_live_voice_name="Aoede")

    normal_session = await manager.start_browser_session(
        settings,
        user_id="user-1",
        session_id="browser-gemini-normal-voice",
    )
    preconnect_session = await manager.start_browser_session(
        settings,
        user_id="user-1",
        session_id="browser-gemini-preconnect-voice",
        preconnect_ttl_seconds=1.0,
    )

    voice_names = [
        request["setup"]["generationConfig"]["speechConfig"]["voiceConfig"][
            "prebuiltVoiceConfig"
        ]["voiceName"]
        for request in fake_minter.requests
    ]
    assert voice_names == ["Aoede", "Aoede"]
    assert normal_session.as_public_payload()["gemini_voice_name"] == "Aoede"
    assert preconnect_session.as_public_payload()["gemini_voice_name"] == "Aoede"
    assert preconnect_session.dogfood_session.public_payloads == ()

    await manager.close_session("browser-gemini-normal-voice")
    await manager.close_session("browser-gemini-preconnect-voice")


def test_production_gemini_route_requires_promotion_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_gemini_env(monkeypatch)

    with pytest.raises(Exception, match="SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED"):
        validate_gemini_production_route_settings(_gemini_settings())


@pytest.mark.anyio
async def test_production_browser_session_uses_production_public_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    _make_backend_emit_artifact_import_fail(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    fake_minter = FakeGeminiTokenMinter()
    dogfood_manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=fake_minter,  # type: ignore[arg-type]
    )
    manager = GeminiProductionBrowserSessionManager(dogfood_manager)
    realtime_context = {
        "preferred_name": "Luis",
        "identity_excerpt": "Name: Luis\nLuis likes direct continuity cues.",
        "handoff_excerpt": "Session initiated with Luis. Keep the opener grounded.",
        "memories": [
            {"id": "m1", "content": "Luis prefers crisp context.", "category": "preference"},
        ],
        "diagnostics": {
            "schema": "sophia_realtime_context_v1",
            "context_fetch_status": "ok",
            "mem0_status": "available",
            "mem0_provider_reason": "sdk_client",
            "identity_available": True,
            "handoff_available": True,
            "memory_count": 1,
            "memory_limit": 4,
        },
    }

    browser_session = await manager.start_browser_session(
        _gemini_production_settings(),
        user_id="user-1",
        session_id="gemini-prod-1",
        platform="ios_voice",
        context_mode="work",
        ritual="debrief",
        realtime_context=realtime_context,
    )

    payload = browser_session.as_public_payload()
    assert payload["runtime"] == "gemini_live"
    assert payload["voice_runtime"] == "gemini_live"
    assert payload["production_route"] is True
    assert payload["browser_audio"] == "gemini_live_websocket_production_candidate"
    assert payload["stream_url"] == "/production/realtime/gemini/sessions/gemini-prod-1/events"
    assert payload["provider_event_relay_url"] == (
        "/production/realtime/gemini/browser-sessions/gemini-prod-1/provider-events"
    )
    assert payload["disconnect_url"] == "/production/realtime/gemini/browser-sessions/gemini-prod-1"
    assert payload["memory_context"]["schema"] == "gemini_live_memory_context_v1"
    assert payload["memory_context"]["trusted_user_context"] is True
    assert payload["memory_context"]["status"] == "injected"
    assert payload["memory_context"]["backend_context_schema"] == "sophia_realtime_context_v1"
    assert payload["memory_context"]["mem0_status"] == "available"
    assert payload["memory_context"]["identity_available"] is True
    assert payload["memory_context"]["handoff_available"] is True
    assert payload["memory_context"]["memory_count"] == 1
    system_instruction = fake_minter.requests[0]["setup"]["systemInstruction"]["parts"][0]["text"]
    assert "Platform: iOS voice. Respond in 1-3 sentences." in system_instruction
    assert "# Context: Work" in system_instruction
    assert "<realtime_memory_recall_guidance>" in system_instruction
    assert "New facts from this live conversation are not durable memory" in system_instruction
    assert "<gemini_live_user_context>" in system_instruction
    assert "Preferred name: Luis" in system_instruction
    assert "Luis prefers crisp context." in system_instruction
    assert "### Voice Skill State" in system_instruction
    assert "challenging_growth_allowed: false" in system_instruction
    assert "<gemini_live_spoken_turn_policy>" in system_instruction
    assert "Do not assume the user is gaming" in system_instruction
    assert "latest complete user utterance" in system_instruction

    await manager.close_session("gemini-prod-1")


@pytest.mark.anyio
async def test_browser_session_preconnect_cleanup_closes_unused_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-preconnect-cleanup",
        preconnect_ttl_seconds=0.01,
    )

    assert realtime_sessions.get_session(browser_session.dogfood_session.session_id) is not None
    await asyncio.sleep(0.05)
    assert realtime_sessions.get_session(browser_session.dogfood_session.session_id) is None


@pytest.mark.anyio
async def test_browser_session_preconnect_cleanup_is_cancelled_when_adopted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-preconnect-adopted",
        preconnect_ttl_seconds=0.01,
    )

    await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={"setupComplete": {}},
    )
    await asyncio.sleep(0.05)

    assert realtime_sessions.get_session(browser_session.dogfood_session.session_id) is not None
    await manager.close_session(browser_session.dogfood_session.session_id)


@pytest.mark.anyio
async def test_browser_relay_messages_enter_existing_gemini_adapter_and_normalizer_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-2",
    )

    for event in [
        {"setupComplete": {}},
        {
            "eventId": "user-item-1",
            "serverContent": {
                "inputTranscription": {"text": "I had a rough day."},
            },
        },
        {
            "serverContent": {
                "outputTranscription": {"text": "That sounds heavy."},
            },
        },
        {"serverContent": {"generationComplete": True}},
    ]:
        await manager.ingest_browser_provider_event(
            _gemini_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            event=event,
        )

    payloads = await browser_session.dogfood_session.wait_for_public_payloads(6)

    assert [payload["type"] for payload in payloads] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.turn",
    ]
    assert payloads[0]["data"] == {"text": "I had a rough day.", "utterance_id": "user-item-1"}
    assert payloads[3]["data"] == {
        "text": "That sounds heavy.",
        "is_final": False,
        "assistant_transcript_source": "provider_output_transcription",
        "assistant_transcript_approximate": True,
    }
    assert payloads[4]["data"] == {
        "text": "That sounds heavy.",
        "is_final": True,
        "assistant_transcript_source": "provider_output_transcription",
        "assistant_transcript_approximate": True,
    }
    assert all(str(payload["type"]).startswith("sophia.") for payload in payloads)
    assert "serverContent" not in json.dumps(payloads)

    await manager.close_session("browser-gemini-2")


@pytest.mark.anyio
async def test_browser_relay_string_input_transcription_surfaces_public_user_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    manager = GeminiBrowserDogfoodSessionManager(
        realtime_sessions,
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-string-input",
    )

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "eventId": "user-item-string-1",
            "serverContent": {
                "inputTranscription": "Please review the top section.",
            },
        },
    )
    payloads = await browser_session.dogfood_session.wait_for_public_payloads(2)

    assert response["accepted"] is True
    assert response["diagnostics"]["provider_category_counts"]["inputTranscription"] == 1
    assert [payload["type"] for payload in payloads] == [
        "sophia.user_transcript",
        "sophia.turn",
    ]
    assert payloads[0]["data"] == {
        "text": "Please review the top section.",
        "utterance_id": "user-item-string-1",
    }

    await manager.close_session("browser-gemini-string-input")


@pytest.mark.anyio
async def test_browser_relay_tool_call_executes_existing_emit_artifact_and_returns_tool_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    fake_builder_backend = FakeBuilderLifecycleBackend()
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
        tool_executor=gemini_tool_loop.GeminiDogfoodToolExecutor(
            builder_lifecycle_backend=fake_builder_backend,  # type: ignore[arg-type]
        ),
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-tool-loop",
    )

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "artifact-call-1",
                        "name": GEMINI_EMIT_ARTIFACT_TOOL_NAME,
                        "args": _artifact_payload(),
                    }
                ]
            }
        },
    )

    assert response["accepted"] is True
    action = response["client_actions"][0]
    assert action["type"] == "gemini_tool_response"
    function_response = action["payload"]["toolResponse"]["functionResponses"][0]
    assert function_response["id"] == "artifact-call-1"
    assert function_response["name"] == GEMINI_EMIT_ARTIFACT_TOOL_NAME
    assert function_response["response"]["ok"] is True
    assert function_response["response"]["tool"] == GEMINI_EMIT_ARTIFACT_TOOL_NAME
    assert function_response["response"]["backend_tool_result"] == "Artifact recorded."
    assert function_response["response"]["artifact_recorded"] is True
    assert set(function_response["response"]["artifact_keys"]) == ARTIFACT_FIELD_NAMES
    assert function_response["response"]["session_id"] == "browser-gemini-tool-loop"
    assert function_response["response"]["user_id"] == "user-1"
    assert function_response["response"]["runtime"] == "gemini_live"
    assert function_response["response"]["provider"] == "google-gemini-live"
    assert response["tool_diagnostics"][0]["success"] is True
    assert response["tool_diagnostics"][0]["result_summary"] == "Existing Sophia emit_artifact tool executed."
    diagnostics_payload = response["diagnostics"]
    assert diagnostics_payload["provider_category_counts"]["toolCall"] == 1
    assert diagnostics_payload["provider_events_pushed_into_mapper"] == 1
    assert diagnostics_payload["memory_context"]["schema"] == "gemini_live_memory_context_v1"
    assert diagnostics_payload["function_calls_extracted"] == {
        "artifact-call-1": GEMINI_EMIT_ARTIFACT_TOOL_NAME
    }
    assert diagnostics_payload["artifact_emission_attempt_count"] == 1
    assert diagnostics_payload["artifact_emission_completed_count"] == 1
    assert diagnostics_payload["artifact_public_event_emitted_count"] == 1
    assert diagnostics_payload["artifact_tool_response_prepared_count"] == 1
    assert diagnostics_payload["artifact_emission_cancelled_count"] == 0

    payloads = await browser_session.dogfood_session.wait_for_public_payloads(3)
    artifacts = [payload for payload in payloads if payload["type"] == "sophia.artifact"]
    assert artifacts == [{"type": "sophia.artifact", "data": _artifact_payload()}]
    diagnostics = [payload for payload in payloads if payload["type"] == "sophia.turn_diagnostic"]
    assert diagnostics
    assert diagnostics[0]["data"]["tool_loop_status"] == "completed"
    assert diagnostics[0]["data"]["tool_names"] == [GEMINI_EMIT_ARTIFACT_TOOL_NAME]
    assert fake_builder_backend.calls == []

    await manager.close_session("browser-gemini-tool-loop")


@pytest.mark.anyio
async def test_browser_relay_emit_artifact_invalid_args_returns_concise_tool_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-artifact-invalid",
    )

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "artifact-call-invalid",
                        "name": GEMINI_EMIT_ARTIFACT_TOOL_NAME,
                        "args": {
                            "session_goal": "Stay grounded.",
                            "active_goal": "Acknowledge the user.",
                            "next_step": "Listen for the next turn.",
                            "takeaway": "Name was confirmed.",
                            "reflection": None,
                            "tone_estimate": 2.0,
                            "tone_target": 2.5,
                            "active_tone_band": "engagement",
                            "skill_loaded": "active_listening",
                            "ritual_phase": "freeform.memory_check",
                            "voice_emotion_primary": "calm",
                            "voice_emotion_secondary": "warm",
                        },
                    }
                ]
            }
        },
    )

    function_response = response["client_actions"][0]["payload"]["toolResponse"]["functionResponses"][0]
    tool_response_text = json.dumps(function_response["response"])
    assert function_response["response"]["ok"] is False
    assert function_response["response"]["error_type"] == "invalid_tool_arguments"
    assert (
        function_response["response"]["result_summary"]
        == "Invalid emit_artifact arguments. Provide required string fields and retry."
    )
    assert "ValidationError" not in tool_response_text
    assert "Field required" not in tool_response_text
    assert "schema" not in tool_response_text.lower()
    assert response["tool_diagnostics"][0]["success"] is False
    assert response["tool_diagnostics"][0]["rejection_reason"] == "invalid_tool_arguments"
    payloads = await browser_session.dogfood_session.wait_for_public_payloads(1)
    assert not [payload for payload in payloads if payload["type"] == "sophia.artifact"]

    await manager.close_session("browser-gemini-artifact-invalid")


@pytest.mark.anyio
async def test_browser_relay_duplicate_emit_artifact_tool_call_id_is_single_shot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-artifact-duplicate",
    )
    event = {
        "toolCall": {
            "functionCalls": [
                {
                    "id": "artifact-call-duplicate",
                    "name": GEMINI_EMIT_ARTIFACT_TOOL_NAME,
                    "args": _artifact_payload(active_goal="First artifact only."),
                }
            ]
        }
    }

    first_response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event=event,
    )
    assert first_response["client_actions"][0]["type"] == "gemini_tool_response"
    assert first_response["diagnostics"]["artifact_public_event_emitted_count"] == 1

    await browser_session.dogfood_session.wait_for_public_payloads(3)

    second_response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event=event,
    )

    assert "client_actions" not in second_response
    assert second_response["tool_diagnostics"] == [
        {
            "id": "artifact-call-duplicate",
            "name": GEMINI_EMIT_ARTIFACT_TOOL_NAME,
            "success": False,
            "duplicate_suppressed": True,
            "result_summary": "Duplicate tool call id suppressed; no duplicate backend side effect or toolResponse was produced.",
        }
    ]
    assert second_response["diagnostics"]["artifact_duplicate_suppressed_count"] == 1
    assert second_response["diagnostics"]["artifact_public_event_emitted_count"] == 1
    assert second_response["diagnostics"]["artifact_tool_response_prepared_count"] == 1

    payloads = browser_session.dogfood_session.public_payloads
    artifacts = [payload for payload in payloads if payload["type"] == "sophia.artifact"]
    assert artifacts == [
        {"type": "sophia.artifact", "data": _artifact_payload(active_goal="First artifact only.")}
    ]

    await manager.close_session("browser-gemini-artifact-duplicate")


@pytest.mark.anyio
async def test_browser_relay_retrieve_memories_uses_trusted_user_and_redacts_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    captured: dict[str, Any] = {}
    raw_memory_text = "Luis uses the cue 'I'm in control' to stay calm during gaming pressure."

    def fake_retrieve(args: Mapping[str, Any], *, user_id: str, context_mode: str | None = None) -> dict[str, Any]:
        captured["args"] = dict(args)
        captured["user_id"] = user_id
        captured["context_mode"] = context_mode
        return {
            "ok": True,
            "status": "success",
            "provider_status": "available",
            "provider_reason": "rest_fallback",
            "query": str(args["query"]),
            "count": 1,
            "memories": [
                {
                    "text": raw_memory_text,
                    "category": "preference",
                    "source": "long_term_memory",
                }
            ],
            "guidance": "Use these memories only if relevant.",
            "diagnostics": {
                "schema": "realtime_retrieve_memories_diagnostics_v1",
                "tool": "retrieve_memories",
                "status": "success",
                "count": 1,
                "has_results": True,
                "latency_ms": 12,
                "query_length": len(str(args["query"])),
                "query_fingerprint": "sha256:query1234567890",
                "query_term_count": 4,
                "raw_query_excluded": True,
                "query_was_truncated": False,
                "limit": 5,
                "provider_status": "available",
                "provider_reason": "rest_fallback",
                "provider_transport": "mem0_rest",
                "cache_status": "unknown",
                "internal_category_count": 0,
                "result_categories": ["preference"],
                "result_text_lengths": [len(raw_memory_text)],
                "result_fingerprints": [
                    {
                        "rank": 1,
                        "text_fingerprint": "sha256:memory123456789",
                        "text_length": len(raw_memory_text),
                        "query_terms_matched_count": 3,
                        "query_term_count": 4,
                        "exact_query_terms_present": False,
                        "category": "preference",
                        "unsafe_preview": raw_memory_text,
                    }
                ],
                "result_preview_included": False,
                "raw_memory_text_excluded": True,
                "max_query_terms_matched_count": 3,
                "any_result_exact_query_terms_present": False,
            },
        }

    monkeypatch.setattr(gemini_tool_loop, "execute_realtime_retrieve_memories", fake_retrieve)

    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="trusted-user-1",
        session_id="browser-gemini-memory-tool",
    )

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "memory-call-1",
                        "name": "retrieve_memories",
                        "args": {
                            "query": "gaming pressure calm cue",
                            "user_id": "model-supplied-user",
                            "categories": ["preference"],
                        },
                    }
                ]
            }
        },
    )

    assert captured["user_id"] == "trusted-user-1"
    assert captured["args"]["user_id"] == "model-supplied-user"
    assert response["accepted"] is True
    action = response["client_actions"][0]
    function_response = action["payload"]["toolResponse"]["functionResponses"][0]
    assert function_response["id"] == "memory-call-1"
    assert function_response["name"] == "retrieve_memories"
    assert function_response["response"]["status"] == "success"
    assert function_response["response"]["count"] == 1
    assert function_response["response"]["memories"][0]["text"] == raw_memory_text
    assert function_response["response"]["tool_arg_user_id_ignored"] is True
    assert "user_id" in function_response["response"]["ignored_model_arg_names"]

    diagnostic = response["tool_diagnostics"][0]
    assert diagnostic["name"] == "retrieve_memories"
    assert diagnostic["status"] == "success"
    assert diagnostic["count"] == 1
    assert diagnostic["has_results"] is True
    assert diagnostic["latency_ms"] == 12
    assert diagnostic["query_fingerprint"] == "sha256:query1234567890"
    assert diagnostic["raw_query_excluded"] is True
    assert diagnostic["result_categories"] == ["preference"]
    assert diagnostic["result_text_lengths"] == [len(raw_memory_text)]
    assert diagnostic["result_fingerprints"][0]["text_fingerprint"] == "sha256:memory123456789"
    assert diagnostic["result_preview_included"] is False
    assert diagnostic["max_query_terms_matched_count"] == 3
    assert diagnostic["any_result_exact_query_terms_present"] is False
    assert diagnostic["provider_status"] == "available"
    assert diagnostic["provider_reason"] == "rest_fallback"
    assert diagnostic["provider_transport"] == "mem0_rest"
    assert diagnostic["trusted_user_id_source"] == "authenticated_session_context"
    assert diagnostic["tool_arg_user_id_ignored"] is True
    assert set(diagnostic["ignored_model_arg_names"]) == {"user_id", "categories"}
    assert diagnostic["raw_memory_text_excluded"] is True
    assert diagnostic["response"]["raw_query_excluded"] is True
    assert diagnostic["response"]["diagnostics"]["result_fingerprints"][0]["rank"] == 1
    assert "unsafe_preview" not in diagnostic["response"]["diagnostics"]["result_fingerprints"][0]
    assert raw_memory_text not in json.dumps(diagnostic)
    assert raw_memory_text in json.dumps(action)

    latest_execution = response["diagnostics"]["tool_execution_recent"][-1]
    assert latest_execution["tool_name"] == "retrieve_memories"
    assert latest_execution["query_fingerprint"] == "sha256:query1234567890"
    assert latest_execution["result_fingerprints"][0]["text_fingerprint"] == "sha256:memory123456789"
    assert raw_memory_text not in json.dumps(latest_execution)

    payloads = await browser_session.dogfood_session.wait_for_public_payloads(1)
    diagnostics = [payload for payload in payloads if payload["type"] == "sophia.turn_diagnostic"]
    assert diagnostics
    diagnostic_payload = diagnostics[0]["data"]
    assert diagnostic_payload["tool_loop_status"] == "completed"
    assert diagnostic_payload["tool_names"] == ["retrieve_memories"]
    assert raw_memory_text not in json.dumps(diagnostic_payload)

    await manager.close_session("browser-gemini-memory-tool")


@pytest.mark.anyio
async def test_retrieve_memories_unavailable_returns_graceful_tool_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_retrieve(args: Mapping[str, Any], *, user_id: str, context_mode: str | None = None) -> dict[str, Any]:
        return {
            "ok": False,
            "status": "unavailable",
            "provider_status": "unavailable",
            "provider_reason": "missing_api_key",
            "query": str(args["query"]),
            "count": 0,
            "memories": [],
            "message": "Memory retrieval is unavailable right now. Continue using the current conversation context.",
            "diagnostics": {
                "schema": "realtime_retrieve_memories_diagnostics_v1",
                "tool": "retrieve_memories",
                "status": "unavailable",
                "count": 0,
                "latency_ms": 3,
                "query_length": len(str(args["query"])),
                "result_categories": [],
                "result_text_lengths": [],
                "provider_status": "unavailable",
                "provider_reason": "missing_api_key",
                "cache_status": "unknown",
            },
        }

    monkeypatch.setattr(gemini_tool_loop, "execute_realtime_retrieve_memories", fake_retrieve)
    executor = gemini_tool_loop.GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        gemini_tool_loop.GeminiLiveFunctionCall(
            call_id="memory-call-unavailable",
            name="retrieve_memories",
            args={"query": "what do you remember about me"},
        ),
        session_id="session-1",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="google-gemini-live",
    )

    assert execution.success is True
    assert execution.response["ok"] is False
    assert execution.response["status"] == "unavailable"
    assert execution.response["provider_reason"] == "missing_api_key"
    assert execution.response["memories"] == []
    assert "current conversation context" in execution.response["message"]
    assert execution.diagnostic()["provider_status"] == "unavailable"
    assert execution.diagnostic()["provider_reason"] == "missing_api_key"


def test_execute_realtime_retrieve_memories_ignores_model_identity_args(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    contract = sophia_backend_tools._retrieve_memories_contract_module()

    def fake_retrieve_memories_for_realtime(**kwargs):  # noqa: ANN202
        captured.update(kwargs)
        return {
            "ok": True,
            "status": "no_results",
            "provider_status": "available",
            "provider_reason": "sdk_client",
            "query": kwargs["query"],
            "count": 0,
            "memories": [],
            "diagnostics": {
                "schema": "realtime_retrieve_memories_diagnostics_v1",
                "tool": "retrieve_memories",
                "status": "no_results",
                "count": 0,
                "provider_status": "available",
                "provider_reason": "sdk_client",
                "result_categories": [],
                "result_text_lengths": [],
            },
        }

    monkeypatch.setattr(contract, "retrieve_memories_for_realtime", fake_retrieve_memories_for_realtime)

    result = sophia_backend_tools.execute_realtime_retrieve_memories(
        {
            "query": "what do you know about my thesis",
            "user_id": "model-user",
            "categories": ["fact"],
            "filters": {"user_id": "other"},
            "memory_provider": "other-provider",
        },
        user_id="trusted-user",
        context_mode="work",
    )

    assert captured["user_id"] == "trusted-user"
    assert captured["context_mode"] == "work"
    assert "categories" not in captured
    assert set(result["ignored_model_arg_names"]) == {"categories", "filters", "memory_provider", "user_id"}
    assert result["trusted_user_id_source"] == "authenticated_session_context"
    assert result["diagnostics"]["raw_memory_text_excluded"] is True


@pytest.mark.anyio
async def test_retrieve_memories_uses_gateway_backend_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        gemini_tool_loop,
        "execute_realtime_retrieve_memories",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("voice-local memory path used")),
    )
    captured: dict[str, Any] = {}
    raw_memory_text = "User prefers solo, tactical gaming."

    class FakeMemoryBackend:
        async def execute(self, args: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
            captured["args"] = dict(args)
            captured.update(kwargs)
            return {
                "ok": True,
                "status": "success",
                "provider_status": "available",
                "provider_reason": "sdk_client",
                "query": str(args["query"]),
                "count": 1,
                "memories": [
                    {
                        "text": raw_memory_text,
                        "category": "preference",
                        "source": "long_term_memory",
                        "rank": 1,
                    }
                ],
                "trusted_user_id_source": "authenticated_realtime_session",
                "dynamic_retrieval_source": "gateway",
                "diagnostics": {
                    "schema": "sophia_realtime_memory_retrieve_v1",
                    "tool": "retrieve_memories",
                    "status": "success",
                    "count": 1,
                    "provider_status": "available",
                    "provider_reason": "sdk_client",
                    "raw_query_excluded": True,
                    "raw_memory_text_excluded": True,
                    "result_categories": ["preference"],
                    "result_text_lengths": [len(raw_memory_text)],
                },
            }

    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
        tool_executor=gemini_tool_loop.GeminiDogfoodToolExecutor(
            memory_backend=FakeMemoryBackend(),  # type: ignore[arg-type]
        ),
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="trusted-user-1",
        session_id="browser-gemini-gateway-memory-tool",
        context_mode="gaming",
        memory_retrieval_config={
            "endpoint_url": "https://gateway.example/internal/sophia-realtime/memories/retrieve",
            "token": "redacted-test-token",
        },
    )

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "memory-call-gateway",
                        "name": "retrieve_memories",
                        "args": {
                            "query": "gaming preferences",
                            "user_id": "model-supplied-user",
                        },
                    }
                ]
            }
        },
    )

    assert captured["user_id"] == "trusted-user-1"
    assert captured["session_id"] == "browser-gemini-gateway-memory-tool"
    assert captured["context_mode"] == "gaming"
    assert captured["config"]["endpoint_url"].endswith("/internal/sophia-realtime/memories/retrieve")
    assert captured["args"]["user_id"] == "model-supplied-user"
    function_response = response["client_actions"][0]["payload"]["toolResponse"]["functionResponses"][0]
    assert function_response["response"]["status"] == "success"
    assert function_response["response"]["memories"][0]["text"] == raw_memory_text
    assert function_response["response"]["tool_arg_user_id_ignored"] is True
    assert response["tool_diagnostics"][0]["success"] is True
    assert "execution_rejected" not in response["tool_diagnostics"][0]


@pytest.mark.anyio
async def test_retrieve_memories_gateway_backend_missing_token_degrades_safely(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        gemini_tool_loop,
        "execute_realtime_retrieve_memories",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("voice-local memory path used")),
    )
    executor = gemini_tool_loop.GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        gemini_tool_loop.GeminiLiveFunctionCall(
            call_id="memory-call-gateway-unavailable",
            name="retrieve_memories",
            args={"query": "what do you remember about me"},
        ),
        session_id="session-1",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="google-gemini-live",
        context_mode="life",
        memory_retrieval_config={"endpoint_url": "https://gateway.example/internal/retrieve"},
    )

    assert execution.success is True
    assert execution.response["status"] == "unavailable"
    assert execution.response["provider_reason"] == "gateway_retrieval_not_configured"
    assert execution.response["diagnostics"]["trusted_user_id_source"] == "authenticated_session_context"
    assert execution.response["diagnostics"]["raw_memory_text_excluded"] is True


@pytest.mark.anyio
async def test_retrieve_memories_gateway_http_success_json_returns_tool_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_memory_text = "User prefers solo, tactical gaming."
    payload = {
        "schema": "sophia_realtime_memory_retrieve_response_v1",
        "ok": True,
        "status": "success",
        "query": "gaming preferences",
        "count": 1,
        "memories": [
            {
                "text": raw_memory_text,
                "category": "preference",
                "source": "long_term_memory",
                "rank": 1,
            }
        ],
        "provider_status": "available",
        "provider_reason": "sdk_client",
        "diagnostics": {
            "schema": "sophia_realtime_memory_retrieve_v1",
            "status": "success",
            "count": 1,
            "provider_status": "available",
            "provider_reason": "sdk_client",
            "raw_memory_text_excluded": True,
            "result_categories": ["preference"],
            "result_text_lengths": [len(raw_memory_text)],
        },
    }
    requests = _patch_gateway_memory_response(monkeypatch, httpx.Response(200, json=payload))
    executor = gemini_tool_loop.GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        gemini_tool_loop.GeminiLiveFunctionCall(
            call_id="memory-call-gateway-http-success",
            name="retrieve_memories",
            args={"query": "gaming preferences", "user_id": "model-supplied-user"},
        ),
        session_id="session-1",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="google-gemini-live",
        context_mode="gaming",
        memory_retrieval_config={
            "endpoint_url": "https://gateway.example/internal/sophia-realtime/memories/retrieve",
            "token": "secret-callback-token",
        },
    )

    assert requests[0]["url"] == "https://gateway.example/internal/sophia-realtime/memories/retrieve"
    assert requests[0]["headers"]["X-Sophia-Realtime-Memory-Token"] == "secret-callback-token"
    assert execution.success is True
    assert execution.response["status"] == "success"
    assert execution.response["memories"][0]["text"] == raw_memory_text
    assert execution.response["dynamic_retrieval_transport"] == "gateway_http"
    assert execution.diagnostic()["success"] is True
    assert "execution_rejected" not in execution.diagnostic()


@pytest.mark.anyio
async def test_retrieve_memories_gateway_invalid_json_reports_safe_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_token = "secret-callback-token"
    raw_memory_text = "User prefers tactical gaming."
    body = f"<html>{secret_token} {raw_memory_text}</html>".encode()
    response = httpx.Response(200, content=body, headers={"content-type": "text/html"})
    _patch_gateway_memory_response(monkeypatch, response)
    caplog.set_level("WARNING", logger=gemini_tool_loop.__name__)
    backend = gemini_tool_loop.GeminiRealtimeMemoryHttpBackend()

    result = await backend.execute(
        {"query": "gaming preferences"},
        user_id="trusted-user-1",
        session_id="session-1",
        context_mode="gaming",
        config={
            "endpoint_url": "https://gateway.example/internal/sophia-realtime/memories/retrieve?debug_secret=1",
            "token": secret_token,
        },
    )

    assert result["status"] == "unavailable"
    assert result["provider_reason"] == "gateway_retrieval_invalid_json"
    diagnostics = result["diagnostics"]
    assert diagnostics["gateway_status_code"] == 200
    assert diagnostics["gateway_content_type"] == "text/html"
    assert diagnostics["gateway_callback_host"] == "gateway.example"
    assert diagnostics["gateway_callback_path"] == "/internal/sophia-realtime/memories/retrieve"
    assert diagnostics["gateway_body_preview_hash"].startswith("sha256:")
    serialized_diagnostics = json.dumps(diagnostics)
    assert secret_token not in serialized_diagnostics
    assert raw_memory_text not in serialized_diagnostics
    execution_diagnostic = gemini_tool_loop.GeminiDogfoodToolExecution(
        call=gemini_tool_loop.GeminiLiveFunctionCall(
            call_id="memory-call-invalid-json",
            name="retrieve_memories",
            args={"query": "gaming preferences"},
        ),
        response=result,
        result_summary="retrieve_memories returned unavailable with 0 snippet(s).",
    ).diagnostic()
    assert execution_diagnostic["gateway_status_code"] == 200
    assert execution_diagnostic["gateway_body_preview_hash"].startswith("sha256:")
    assert secret_token not in json.dumps(execution_diagnostic)
    assert raw_memory_text not in json.dumps(execution_diagnostic)
    assert secret_token not in caplog.text
    assert raw_memory_text not in caplog.text
    assert "debug_secret" not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize("status_code", [307, 404, 500])
async def test_retrieve_memories_gateway_non_2xx_reports_http_error(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
) -> None:
    response = httpx.Response(
        status_code,
        content=b"<html>not the callback json</html>",
        headers={"content-type": "text/html"},
    )
    _patch_gateway_memory_response(monkeypatch, response)
    backend = gemini_tool_loop.GeminiRealtimeMemoryHttpBackend()

    result = await backend.execute(
        {"query": "gaming preferences"},
        user_id="trusted-user-1",
        session_id="session-1",
        context_mode="gaming",
        config={
            "endpoint_url": "https://gateway.example/internal/sophia-realtime/memories/retrieve",
            "token": "secret-callback-token",
        },
    )

    assert result["status"] == "unavailable"
    assert result["provider_reason"] == "gateway_retrieval_http_error"
    assert result["diagnostics"]["gateway_status_code"] == status_code


@pytest.mark.anyio
async def test_retrieve_memories_gateway_schema_mismatch_reports_distinct_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = httpx.Response(200, json={"ok": True, "status": "success", "memories": []})
    _patch_gateway_memory_response(monkeypatch, response)
    backend = gemini_tool_loop.GeminiRealtimeMemoryHttpBackend()

    result = await backend.execute(
        {"query": "gaming preferences"},
        user_id="trusted-user-1",
        session_id="session-1",
        context_mode="gaming",
        config={
            "endpoint_url": "https://gateway.example/internal/sophia-realtime/memories/retrieve",
            "token": "secret-callback-token",
        },
    )

    assert result["status"] == "unavailable"
    assert result["provider_reason"] == "gateway_retrieval_schema_mismatch"
    assert "missing:" in result["diagnostics"]["gateway_schema_mismatch"]
    assert result["diagnostics"]["gateway_response_status"] == "success"


@pytest.mark.anyio
async def test_browser_relay_buffers_out_of_order_transcript_http_arrivals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-source-order",
    )

    second = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={"serverContent": {"outputTranscription": {"text": "to lock"}}},
        source_metadata=GeminiRelaySourceMetadata(
            provider_receive_sequence=12,
            provider_relay_sequence=2,
            provider_received_at="2026-05-20T00:00:00.012Z",
            relay_correlation_id="gemini-relay-12-outputTranscription",
            provider_categories=("serverContent", "outputTranscription"),
        ),
    )

    assert second["accepted"] is True
    assert second["buffered"] is True
    assert second["diagnostics"]["transcript_sequence_buffered"] == 1

    first = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={"serverContent": {"outputTranscription": {"text": "You ready"}}},
        source_metadata=GeminiRelaySourceMetadata(
            provider_receive_sequence=11,
            provider_relay_sequence=1,
            provider_received_at="2026-05-20T00:00:00.011Z",
            relay_correlation_id="gemini-relay-11-outputTranscription",
            provider_categories=("serverContent", "outputTranscription"),
        ),
    )

    assert first["accepted"] is True
    assert first["diagnostics"]["transcript_sequence_applied"] == 2
    payloads = await browser_session.dogfood_session.wait_for_public_payloads(3)
    transcripts = [
        payload["data"]["text"]
        for payload in payloads
        if payload["type"] == "sophia.transcript"
    ]
    assert transcripts == ["You ready", "You ready to lock"]
    assert "to lock You ready" not in transcripts

    await manager.close_session("browser-gemini-source-order")


@pytest.mark.anyio
async def test_browser_relay_start_builder_task_dispatches_existing_builder_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    fake_builder = FakeBuilderLifecycleBackend()
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
        tool_executor=gemini_tool_loop.GeminiDogfoodToolExecutor(
            builder_lifecycle_backend=fake_builder,  # type: ignore[arg-type]
        ),
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="trusted-user-1",
        session_id="browser-gemini-builder-start",
    )

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "builder-call-1",
                        "name": "start_builder_task",
                        "args": {
                            "description": "Make a short one-page reflection document about staying grounded today.",
                            "task_type": "document",
                            "user_id": "untrusted-model-user",
                        },
                    }
                ]
            }
        },
    )

    assert response["accepted"] is True
    assert fake_builder.calls[0]["tool_name"] == "start_builder_task"
    assert fake_builder.calls[0]["user_id"] == "trusted-user-1"
    assert fake_builder.calls[0]["args"]["user_id"] == "untrusted-model-user"
    action = response["client_actions"][0]
    function_response = action["payload"]["toolResponse"]["functionResponses"][0]
    assert function_response["id"] == "builder-call-1"
    assert function_response["name"] == "start_builder_task"
    assert function_response["response"]["task_id"] == "builder-thread-1"
    assert function_response["response"]["status"] == "running"
    assert response["tool_diagnostics"][0]["task_id"] == "builder-thread-1"
    assert response["tool_diagnostics"][0]["task_status"] == "running"

    payloads = await browser_session.dogfood_session.wait_for_public_payloads(2)
    builder_events = [payload for payload in payloads if payload["type"] == "sophia.builder_task"]
    assert builder_events
    assert builder_events[0]["data"] == {
        "type": "task_started",
        "task_id": "builder-thread-1",
        "description": "Make a short one-page reflection document about staying grounded today.",
        "detail": "Launched builder task. task_id: builder-thread-1.",
        "status": "running",
        "progress_source": "none",
        "task_type": "document",
        "started_at": "2026-05-19T00:00:00Z",
        "last_update_at": "2026-05-19T00:00:00Z",
    }

    late_subscriber = browser_session.dogfood_session.subscribe()
    assert await asyncio.wait_for(late_subscriber.get(), timeout=1.0) == builder_events[0]
    assert late_subscriber.empty()
    browser_session.dogfood_session.unsubscribe(late_subscriber)

    await manager.close_session("browser-gemini-builder-start")


@pytest.mark.anyio
async def test_browser_relay_lifecycle_tools_dispatch_against_trusted_session_tasks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    fake_builder = FakeBuilderLifecycleBackend()
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
        tool_executor=gemini_tool_loop.GeminiDogfoodToolExecutor(
            builder_lifecycle_backend=fake_builder,  # type: ignore[arg-type]
        ),
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="trusted-user-1",
        session_id="browser-gemini-builder-lifecycle",
    )
    await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "builder-call-1",
                        "name": "start_builder_task",
                        "args": {"description": "Make a document.", "task_type": "document"},
                    }
                ]
            }
        },
    )

    for tool_name, args, expected_status in [
        ("check_async_task", {"task_id": "builder-thread-1"}, "success"),
        ("update_async_task", {"task_id": "builder-thread-1", "message": "Make it warmer."}, "running"),
        ("list_async_tasks", {"status_filter": "all"}, None),
        ("cancel_async_task", {"task_id": "builder-thread-1"}, "cancelled"),
    ]:
        response = await manager.ingest_browser_provider_event(
            _gemini_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            event={
                "toolCall": {
                    "functionCalls": [
                        {"id": f"{tool_name}-call", "name": tool_name, "args": args}
                    ]
                }
            },
        )
        function_response = response["client_actions"][0]["payload"]["toolResponse"]["functionResponses"][0]
        assert function_response["name"] == tool_name
        if expected_status is not None:
            assert function_response["response"]["status"] == expected_status

    assert [call["tool_name"] for call in fake_builder.calls] == [
        "start_builder_task",
        "check_async_task",
        "update_async_task",
        "list_async_tasks",
        "cancel_async_task",
    ]
    assert fake_builder.calls[1]["async_tasks"]["builder-thread-1"]["status"] == "running"

    await manager.close_session("browser-gemini-builder-lifecycle")


@pytest.mark.anyio
async def test_http_lifecycle_backend_update_list_and_cancel_request_shapes() -> None:
    tracked_task = {
        "task_id": "builder-thread-1",
        "agent_name": "sophia_builder",
        "thread_id": "builder-thread-1",
        "run_id": "run-1",
        "status": "running",
        "task_type": "document",
    }

    update_backend = CapturingBuilderLifecycleHttpBackend([{"run_id": "run-2"}])
    update_result = await update_backend.execute(
        "update_async_task",
        {"task_id": "builder-thread-1", "message": "Make it warmer."},
        session_id="browser-gemini-builder-lifecycle",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="google-gemini-live",
        async_tasks={"builder-thread-1": tracked_task},
    )

    assert update_backend.requests == [
        {
            "method": "POST",
            "path": "/threads/builder-thread-1/runs",
            "json_body": {
                "assistant_id": "sophia_builder",
                "input": {"messages": [{"role": "user", "content": "Make it warmer."}]},
                "multitask_strategy": "interrupt",
            },
            "params": {},
            "allow_empty": False,
        }
    ]
    assert update_result.response["task_id"] == "builder-thread-1"
    assert update_result.response["run_id"] == "run-2"
    assert update_result.response["status"] == "running"
    assert update_result.updated_async_tasks == {
        "builder-thread-1": {
            **tracked_task,
            "run_id": "run-2",
            "status": "running",
            "last_updated_at": update_result.updated_async_tasks["builder-thread-1"]["last_updated_at"],
        }
    }

    list_backend = CapturingBuilderLifecycleHttpBackend([{"status": "running"}])
    list_result = await list_backend.execute(
        "list_async_tasks",
        {"status_filter": "all"},
        session_id="browser-gemini-builder-lifecycle",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="google-gemini-live",
        async_tasks={"builder-thread-1": tracked_task},
    )

    assert list_backend.requests == [
        {
            "method": "GET",
            "path": "/threads/builder-thread-1/runs/run-1",
            "json_body": None,
            "params": {},
            "allow_empty": False,
        }
    ]
    assert list_result.response["task_count"] == 1
    assert list_result.response["tasks"] == [
        {
            "task_id": "builder-thread-1",
            "agent_name": "sophia_builder",
            "status": "running",
            "task_type": "document",
        }
    ]
    assert list_result.updated_async_tasks is not None
    assert list_result.updated_async_tasks["builder-thread-1"]["status"] == "running"
    assert "last_checked_at" in list_result.updated_async_tasks["builder-thread-1"]

    cancel_backend = CapturingBuilderLifecycleHttpBackend([{}])
    cancel_result = await cancel_backend.execute(
        "cancel_async_task",
        {"task_id": "builder-thread-1"},
        session_id="browser-gemini-builder-lifecycle",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="google-gemini-live",
        async_tasks={"builder-thread-1": tracked_task},
    )

    assert cancel_backend.requests == [
        {
            "method": "POST",
            "path": "/threads/builder-thread-1/runs/run-1/cancel",
            "json_body": None,
            "params": {"wait": 0, "action": "interrupt"},
            "allow_empty": True,
        }
    ]
    assert cancel_result.response["task_id"] == "builder-thread-1"
    assert cancel_result.response["status"] == "cancelled"
    assert cancel_result.updated_async_tasks is not None
    assert cancel_result.updated_async_tasks["builder-thread-1"]["status"] == "cancelled"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("tool_name", "args"),
    [
        ("check_async_task", {"task_id": "789654321"}),
        ("update_async_task", {"task_id": "789654321", "message": "Make it warmer."}),
        ("cancel_async_task", {"task_id": "789654321"}),
    ],
)
async def test_browser_relay_unknown_lifecycle_task_id_returns_recoverable_tool_response(
    monkeypatch: pytest.MonkeyPatch,
    tool_name: str,
    args: dict[str, str],
) -> None:
    _set_gemini_env(monkeypatch)
    fake_builder = FakeBuilderLifecycleBackend()
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
        tool_executor=gemini_tool_loop.GeminiDogfoodToolExecutor(
            builder_lifecycle_backend=fake_builder,  # type: ignore[arg-type]
        ),
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="trusted-user-1",
        session_id=f"browser-gemini-unknown-{tool_name}",
    )

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {"id": f"{tool_name}-call", "name": tool_name, "args": args}
                ]
            }
        },
    )

    assert response["accepted"] is True
    action = response["client_actions"][0]
    assert action["type"] == "gemini_tool_response"
    function_response = action["payload"]["toolResponse"]["functionResponses"][0]
    assert function_response["name"] == tool_name
    assert function_response["response"]["ok"] is False
    assert function_response["response"]["error_type"] == "unknown_task_id"
    assert function_response["response"]["tracked_task_count"] == 0
    assert function_response["response"]["generic_async_tool_responded_safely"] is True
    assert function_response["response"]["raw_task_id_excluded"] is True
    assert "task_id" not in function_response["response"]
    assert "tracked_task_ids" not in function_response["response"]
    assert "789654321" not in str(function_response["response"])
    assert "Coreview status action" in function_response["response"]["recovery_guidance"]
    assert "list_async_tasks" not in function_response["response"]["recovery_guidance"]
    diagnostic = response["tool_diagnostics"][0]
    assert diagnostic["success"] is False
    assert diagnostic["execution_rejected"] is True
    assert diagnostic["rejection_reason"] == "unknown_task_id"
    assert diagnostic["recovery_guidance"] == function_response["response"]["recovery_guidance"]

    payloads = await browser_session.dogfood_session.wait_for_public_payloads(2)
    tool_loop_diagnostics = [payload for payload in payloads if payload["type"] == "sophia.turn_diagnostic"]
    assert tool_loop_diagnostics
    assert tool_loop_diagnostics[0]["data"]["tool_loop_status"] == "execution_rejected"
    assert tool_loop_diagnostics[0]["data"]["tool_execution_rejections"][0]["error_type"] == "unknown_task_id"

    await manager.close_session(browser_session.dogfood_session.session_id)


@pytest.mark.anyio
async def test_lifecycle_unknown_task_id_reports_current_trusted_session_ids() -> None:
    executor = gemini_tool_loop.GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        gemini_tool_loop.GeminiLiveFunctionCall(
            call_id="check-call-1",
            name="check_async_task",
            args={"task_id": "other-session-task"},
        ),
        session_id="current-session",
        user_id="trusted-user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="google-gemini-live",
        async_tasks={
            "current-session-task": {
                "task_id": "current-session-task",
                "agent_name": "sophia_builder",
                "thread_id": "current-session-task",
                "run_id": "run-1",
                "status": "running",
            }
        },
    )

    assert execution.success is False
    assert execution.response["ok"] is False
    assert execution.response["tracked_task_count"] == 1
    assert execution.response["raw_task_id_excluded"] is True
    assert "task_id" not in execution.response
    assert "tracked_task_ids" not in execution.response
    assert "other-session-task" not in str(execution.response)
    action = gemini_tool_loop.gemini_tool_response_client_action([execution])
    function_response = action["payload"]["toolResponse"]["functionResponses"][0]
    assert function_response["response"]["error_type"] == "unknown_task_id"
    assert function_response["response"]["tracked_task_count"] == 1
    assert "tracked_task_ids" not in function_response["response"]


@pytest.mark.anyio
async def test_browser_relay_builder_tool_rejects_invalid_args(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-builder-invalid",
    )

    with pytest.raises(GeminiBrowserRelayError, match="rejected the Gemini Live arguments"):
        await manager.ingest_browser_provider_event(
            _gemini_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            event={
                "toolCall": {
                    "functionCalls": [
                        {"id": "builder-call-invalid", "name": "start_builder_task", "args": {"task_type": "document"}}
                    ]
                }
            },
        )

    await manager.close_session("browser-gemini-builder-invalid")


@pytest.mark.anyio
async def test_browser_relay_emit_artifact_tool_call_surfaces_artifact_and_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-artifact-tool",
    )
    artifact = _artifact_payload(ritual_phase="freeform.legacy_nested_artifact")

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "artifact-call-1",
                        "name": GEMINI_EMIT_ARTIFACT_TOOL_NAME,
                        "args": {"artifact": artifact},
                    }
                ]
            }
        },
    )

    function_response = response["client_actions"][0]["payload"]["toolResponse"]["functionResponses"][0]
    assert function_response["id"] == "artifact-call-1"
    assert function_response["name"] == GEMINI_EMIT_ARTIFACT_TOOL_NAME
    assert function_response["response"]["artifact_recorded"] is True
    assert function_response["response"]["backend_tool_result"] == "Artifact recorded."
    assert function_response["response"]["tool"] == GEMINI_EMIT_ARTIFACT_TOOL_NAME
    assert response["diagnostics"]["artifact_emission_attempt_count"] == 1
    assert response["diagnostics"]["artifact_emission_completed_count"] == 1
    assert response["diagnostics"]["artifact_public_event_emitted_count"] == 1
    assert response["diagnostics"]["artifact_tool_response_prepared_count"] == 1

    payloads = await browser_session.dogfood_session.wait_for_public_payloads(3)
    assert [payload for payload in payloads if payload["type"] == "sophia.artifact"] == [
        {"type": "sophia.artifact", "data": artifact}
    ]
    assert any(payload["type"] == "sophia.turn_diagnostic" for payload in payloads)

    await manager.close_session("browser-gemini-artifact-tool")


@pytest.mark.anyio
async def test_browser_relay_rejects_unknown_tool_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-unknown-tool",
    )

    with pytest.raises(GeminiBrowserRelayError, match="unsupported Sophia tool"):
        await manager.ingest_browser_provider_event(
            _gemini_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            event={
                "toolCall": {
                    "functionCalls": [
                        {"id": "unknown-call-1", "name": "delete_everything", "args": {}}
                    ]
                }
            },
        )

    await manager.close_session("browser-gemini-unknown-tool")


@pytest.mark.anyio
async def test_browser_relay_tool_call_cancellation_suppresses_late_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-cancel-tool",
    )

    cancellation = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={"toolCallCancellation": {"ids": ["probe-call-cancelled"]}},
    )
    assert cancellation["accepted"] is True
    assert cancellation["cancelled_tool_call_ids"] == ["probe-call-cancelled"]

    response = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "probe-call-cancelled",
                        "name": GEMINI_EMIT_ARTIFACT_TOOL_NAME,
                        "args": _artifact_payload(),
                    }
                ]
            }
        },
    )

    assert "client_actions" not in response
    assert response["tool_diagnostics"][0]["cancelled"] is True
    assert response["diagnostics"]["artifact_emission_attempt_count"] == 1
    assert response["diagnostics"]["artifact_emission_cancelled_count"] == 1
    assert response["diagnostics"]["artifact_cancelled_before_backend_execution"] == 1
    assert response["diagnostics"]["artifact_public_event_emitted_count"] == 0

    payloads = browser_session.dogfood_session.public_payloads
    assert not any(payload["type"] == "sophia.artifact" for payload in payloads)

    await manager.close_session("browser-gemini-cancel-tool")


@pytest.mark.anyio
async def test_browser_relay_inflight_cancellation_records_completion_without_client_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    blocking_executor = BlockingGeminiToolExecutor()
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
        tool_executor=blocking_executor,  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-inflight-cancel-tool",
    )

    relay_task = asyncio.create_task(
        manager.ingest_browser_provider_event(
            _gemini_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            event={
                "toolCall": {
                    "functionCalls": [
                        {
                            "id": "probe-call-inflight",
                            "name": GEMINI_EMIT_ARTIFACT_TOOL_NAME,
                            "args": _artifact_payload(),
                        }
                    ]
                }
            },
        )
    )
    await blocking_executor.started.wait()

    cancellation = await manager.ingest_browser_provider_event(
        _gemini_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        event={"toolCallCancellation": {"ids": ["probe-call-inflight"]}},
    )
    assert cancellation["cancelled_tool_call_ids"] == ["probe-call-inflight"]

    blocking_executor.release.set()
    response = await relay_task

    assert "client_actions" not in response
    assert response["tool_diagnostics"][0]["completed_after_cancellation"] is True
    assert response["tool_diagnostics"][0]["cancelled"] is True
    diagnostics = response["diagnostics"]
    assert diagnostics["tool_execution_counts"]["completed_after_cancellation"] == 1
    assert diagnostics["function_calls_extracted"] == {
        "probe-call-inflight": GEMINI_EMIT_ARTIFACT_TOOL_NAME
    }
    assert diagnostics["artifact_emission_attempt_count"] == 1
    assert diagnostics["artifact_emission_cancelled_count"] == 1
    assert diagnostics["artifact_cancelled_after_backend_execution"] == 1
    assert diagnostics["artifact_public_event_emitted_count"] == 0

    payloads = browser_session.dogfood_session.public_payloads
    assert not any(payload["type"] == "sophia.artifact" for payload in payloads)

    await manager.close_session("browser-gemini-inflight-cancel-tool")


@pytest.mark.anyio
async def test_browser_relay_rejects_client_audio_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_gemini_env(monkeypatch)
    manager = GeminiBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="browser-gemini-3",
    )

    with pytest.raises(GeminiBrowserRelayError, match="server messages"):
        await manager.ingest_browser_provider_event(
            _gemini_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            event={"realtimeInput": {"audio": {"data": "AAE=", "mimeType": "audio/pcm;rate=16000"}}},
        )

    await manager.close_session("browser-gemini-3")


def test_gemini_browser_endpoint_fails_safely_when_runtime_is_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from voice import server as voice_server

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)
    monkeypatch.setattr(voice_server, "get_settings", lambda: make_settings())

    response = TestClient(app).post(
        "/dogfood/realtime/gemini/browser-sessions",
        json={"user_id": "user-1"},
    )

    assert response.status_code == 409
    assert "gemini_live" in response.json()["detail"]


def test_gemini_browser_endpoint_reports_tool_declaration_configuration_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from voice import server as voice_server

    _set_gemini_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    monkeypatch.setattr(voice_server, "realtime_dogfood_sessions", realtime_sessions)
    monkeypatch.setattr(
        voice_server,
        "gemini_browser_dogfood_sessions",
        GeminiBrowserDogfoodSessionManager(
            realtime_sessions,
            token_minter=FakeGeminiTokenMinter(),  # type: ignore[arg-type]
        ),
    )
    monkeypatch.setattr(voice_server, "get_settings", _gemini_settings)

    def broken_declaration() -> list[dict[str, object]]:
        raise sophia_backend_tools.SophiaBackendToolConfigurationError("contract unavailable")

    monkeypatch.setattr(
        gemini_tool_loop,
        "gemini_sophia_function_declarations",
        broken_declaration,
    )

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)

    response = TestClient(app).post(
        "/dogfood/realtime/gemini/browser-sessions",
        json={"user_id": "user-1", "session_id": "browser-gemini-declaration-error"},
    )

    assert response.status_code == 409
    assert "Gemini dogfood tool declaration configuration failed" in response.json()["detail"]
    assert "contract unavailable" in response.json()["detail"]


def test_gemini_browser_relay_endpoint_rejects_malformed_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from voice import server as voice_server

    _set_gemini_env(monkeypatch)
    fake_minter = FakeGeminiTokenMinter()
    realtime_sessions = RealtimeDogfoodSessionManager()
    monkeypatch.setattr(voice_server, "realtime_dogfood_sessions", realtime_sessions)
    monkeypatch.setattr(
        voice_server,
        "gemini_browser_dogfood_sessions",
        GeminiBrowserDogfoodSessionManager(realtime_sessions, token_minter=fake_minter),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(voice_server, "get_settings", _gemini_settings)

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)
    client = TestClient(app)

    start = client.post(
        "/dogfood/realtime/gemini/browser-sessions",
        json={"user_id": "user-1", "session_id": "browser-gemini-endpoint"},
    )
    assert start.status_code == 201

    response = client.post(
        "/dogfood/realtime/gemini/browser-sessions/browser-gemini-endpoint/provider-events",
        json={"event": {"realtimeInput": {"text": "client side input is not relay material"}}},
    )

    assert response.status_code == 422
    assert "server messages" in response.json()["detail"]


def test_gemini_browser_relay_endpoint_rejects_empty_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from voice import server as voice_server

    _set_gemini_env(monkeypatch)
    fake_minter = FakeGeminiTokenMinter()
    realtime_sessions = RealtimeDogfoodSessionManager()
    monkeypatch.setattr(voice_server, "realtime_dogfood_sessions", realtime_sessions)
    monkeypatch.setattr(
        voice_server,
        "gemini_browser_dogfood_sessions",
        GeminiBrowserDogfoodSessionManager(realtime_sessions, token_minter=fake_minter),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(voice_server, "get_settings", _gemini_settings)

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)
    client = TestClient(app)

    start = client.post(
        "/dogfood/realtime/gemini/browser-sessions",
        json={"user_id": "user-1", "session_id": "browser-gemini-empty-event"},
    )
    assert start.status_code == 201

    response = client.post(
        "/dogfood/realtime/gemini/browser-sessions/browser-gemini-empty-event/provider-events",
        json={"event": {}},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Gemini browser relay event cannot be empty."


def test_gemini_browser_relay_endpoint_rejects_empty_server_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from voice import server as voice_server

    _set_gemini_env(monkeypatch)
    fake_minter = FakeGeminiTokenMinter()
    realtime_sessions = RealtimeDogfoodSessionManager()
    monkeypatch.setattr(voice_server, "realtime_dogfood_sessions", realtime_sessions)
    monkeypatch.setattr(
        voice_server,
        "gemini_browser_dogfood_sessions",
        GeminiBrowserDogfoodSessionManager(realtime_sessions, token_minter=fake_minter),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(voice_server, "get_settings", _gemini_settings)

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)
    client = TestClient(app)

    start = client.post(
        "/dogfood/realtime/gemini/browser-sessions",
        json={"user_id": "user-1", "session_id": "browser-gemini-empty-server-content"},
    )
    assert start.status_code == 201

    response = client.post(
        "/dogfood/realtime/gemini/browser-sessions/browser-gemini-empty-server-content/provider-events",
        json={"event": {"serverContent": {}}},
    )

    assert response.status_code == 422
    assert "server messages" in response.json()["detail"]


def test_gemini_browser_relay_endpoint_accepts_valid_provider_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from voice import server as voice_server

    _set_gemini_env(monkeypatch)
    fake_minter = FakeGeminiTokenMinter()
    realtime_sessions = RealtimeDogfoodSessionManager()
    monkeypatch.setattr(voice_server, "realtime_dogfood_sessions", realtime_sessions)
    monkeypatch.setattr(
        voice_server,
        "gemini_browser_dogfood_sessions",
        GeminiBrowserDogfoodSessionManager(realtime_sessions, token_minter=fake_minter),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(voice_server, "get_settings", _gemini_settings)

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)
    client = TestClient(app)

    start = client.post(
        "/dogfood/realtime/gemini/browser-sessions",
        json={"user_id": "user-1", "session_id": "browser-gemini-valid-event"},
    )
    assert start.status_code == 201

    response = client.post(
        "/dogfood/realtime/gemini/browser-sessions/browser-gemini-valid-event/provider-events",
        json={"event": {"setupComplete": {}}},
    )

    assert response.status_code == 202
    response_payload = response.json()
    assert response_payload["accepted"] is True
    assert response_payload["session_id"] == "browser-gemini-valid-event"
    assert response_payload["public_event_boundary"] == "SophiaEventNormalizer"
    assert response_payload["diagnostics"]["provider_category_counts"]["setupComplete"] == 1

    snake_case_response = client.post(
        "/dogfood/realtime/gemini/browser-sessions/browser-gemini-valid-event/provider-events",
        json={"event": {"setup_complete": {}}},
    )

    assert snake_case_response.status_code == 202
