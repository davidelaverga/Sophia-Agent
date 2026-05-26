from __future__ import annotations

import pytest

from voice.realtime.coreview import (
    COREVIEW_FEATURE_FLAG,
    GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
    build_gemini_coreview_prompt_overlay,
    coreview_tool_parity_status,
    detect_gemini_coreview_media_support,
    execute_read_artifact_text_feature_gated,
)
from voice.realtime.gemini_tool_loop import GeminiDogfoodToolExecutor, GeminiLiveFunctionCall
from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.realtime.sophia_backend_tools import gemini_sophia_function_declarations
from voice.realtime.sophia_prompt import build_gemini_live_realtime_setup_instructions


def test_read_artifact_text_remains_feature_flagged_by_default(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)

    declarations = gemini_sophia_function_declarations()
    assert GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME not in [declaration["name"] for declaration in declarations]

    response = execute_read_artifact_text_feature_gated(
        {"artifact_id": "artifact-1", "query": "exact number"},
        session_id="session-1",
        user_id="user-1",
        provider="gemini",
    )
    assert response["ok"] is False
    assert response["status"] == "disabled"
    assert response["raw_artifact_text_excluded"] is True
    assert "exact number" not in response.values()


def test_coreview_prompt_appears_only_when_enabled(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)
    prompt = build_gemini_live_realtime_setup_instructions()
    assert "<gemini_coreview_artifact_policy>" not in prompt

    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "1")
    prompt = build_gemini_live_realtime_setup_instructions()
    assert "<gemini_coreview_artifact_policy>" in prompt
    assert "Exact words, numbers, table values" in prompt


def test_normal_voice_tool_declarations_unchanged_when_flag_off(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)

    declarations = gemini_sophia_function_declarations()

    assert [declaration["name"] for declaration in declarations] == [
        "emit_artifact",
        "start_builder_task",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
        "retrieve_memories",
    ]


def test_coreview_tool_declaration_is_opt_in(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")

    declarations = gemini_sophia_function_declarations()

    assert declarations[-1]["name"] == GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME
    assert declarations[-1]["parameters"]["required"] == ["artifact_id", "query"]


def test_media_transport_support_detection_reports_unsupported_safely(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)

    report = detect_gemini_coreview_media_support()

    assert report.transport_kind == "gemini_live_audio_websocket_current_path"
    assert report.continuous_video_supported is False
    assert report.still_frames_supported is False
    assert report.tools_supported_in_normal_voice is True
    assert report.tools_supported_in_coreview_media == "unknown"
    assert report.read_artifact_text_available is False
    assert any("No Gemini co-review adapter" in blocker for blocker in report.blockers)


def test_tool_parity_status_is_reported(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "1")

    status = coreview_tool_parity_status()

    assert status["normal_voice_tools_supported"] is True
    assert status["coreview_media_tools_supported"] == "unknown"
    assert status["read_artifact_text_available"] is True


@pytest.mark.anyio
async def test_read_artifact_text_tool_loop_returns_flagged_safe_status(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)
    executor = GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        GeminiLiveFunctionCall(
            call_id="call-1",
            name=GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
            args={"artifact_id": "artifact-1", "query": "tiny table value"},
        ),
        session_id="session-1",
        user_id="user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="gemini",
    )

    assert execution.success is False
    assert execution.response["status"] == "disabled"
    assert execution.response["raw_artifact_text_excluded"] is True
    assert "tiny table value" not in execution.response.values()


def test_explicit_overlay_builder_is_empty_when_disabled() -> None:
    assert build_gemini_coreview_prompt_overlay(enabled=False) == ""
    assert "<gemini_coreview_artifact_policy>" in build_gemini_coreview_prompt_overlay(enabled=True)
