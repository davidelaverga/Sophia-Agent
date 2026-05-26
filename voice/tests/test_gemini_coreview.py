from __future__ import annotations

import pytest

from voice.realtime.coreview import (
    COREVIEW_INSTRUCTION_BLOCK,
    READ_ARTIFACT_TEXT_TOOL_NAME,
    CoreviewArtifactTextRecord,
    InMemoryCoreviewArtifactTextBackend,
    execute_read_artifact_text,
)
from voice.realtime.gemini_tool_loop import (
    GeminiDogfoodToolExecutor,
    GeminiLiveFunctionCall,
    gemini_dogfood_tool_declarations,
)
from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.realtime.sophia_prompt import build_gemini_live_realtime_instructions


def _tool_names() -> list[str]:
    declarations = gemini_dogfood_tool_declarations()
    function_declarations = declarations[0]["functionDeclarations"]
    return [str(declaration["name"]) for declaration in function_declarations]


def test_read_artifact_text_tool_declaration_is_gated_by_feature_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED", raising=False)

    assert READ_ARTIFACT_TEXT_TOOL_NAME not in _tool_names()

    monkeypatch.setenv("SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED", "true")

    assert READ_ARTIFACT_TEXT_TOOL_NAME in _tool_names()


def test_coreview_prompt_block_only_appears_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED", raising=False)

    assert COREVIEW_INSTRUCTION_BLOCK not in build_gemini_live_realtime_instructions()

    monkeypatch.setenv("SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED", "true")

    prompt = build_gemini_live_realtime_instructions()
    assert COREVIEW_INSTRUCTION_BLOCK in prompt
    assert "call read_artifact_text" in prompt
    assert "Do not claim to read fine print" in prompt


@pytest.mark.anyio
async def test_read_artifact_text_returns_text_for_valid_trusted_artifact() -> None:
    backend = InMemoryCoreviewArtifactTextBackend(
        [
            CoreviewArtifactTextRecord(
                user_id="user-1",
                session_id="session-1",
                artifact_id="artifact-1",
                text="Large heading\nTiny table value: 42",
            )
        ]
    )

    response = await execute_read_artifact_text(
        {"artifact_id": "artifact-1"},
        user_id="user-1",
        session_id="session-1",
        backend=backend,
    )

    assert response == {
        "ok": True,
        "artifact_id": "artifact-1",
        "text": "Large heading\nTiny table value: 42",
        "source": "artifact_store",
        "truncated": False,
        "char_count": 34,
    }


@pytest.mark.anyio
async def test_read_artifact_text_returns_safe_not_found() -> None:
    response = await execute_read_artifact_text(
        {"artifact_id": "missing-artifact"},
        user_id="user-1",
        session_id="session-1",
        backend=InMemoryCoreviewArtifactTextBackend(),
    )

    assert response == {
        "ok": False,
        "artifact_id": "missing-artifact",
        "status": "not_found",
        "safe_reason": "artifact_not_found",
    }


@pytest.mark.anyio
async def test_read_artifact_text_rejects_unauthorized_artifact() -> None:
    backend = InMemoryCoreviewArtifactTextBackend(
        [
            CoreviewArtifactTextRecord(
                user_id="user-2",
                session_id="session-2",
                artifact_id="artifact-1",
                text="Private exact artifact text.",
            )
        ]
    )

    response = await execute_read_artifact_text(
        {"artifact_id": "artifact-1"},
        user_id="user-1",
        session_id="session-1",
        backend=backend,
    )

    assert response["ok"] is False
    assert response["status"] == "forbidden"
    assert "Private exact artifact text" not in str(response)


@pytest.mark.anyio
async def test_gemini_executor_redacts_read_artifact_text_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED", "true")
    backend = InMemoryCoreviewArtifactTextBackend(
        [
            CoreviewArtifactTextRecord(
                user_id="user-1",
                session_id="session-1",
                artifact_id="artifact-1",
                text="Large heading\nTiny fine print: 42",
            )
        ]
    )
    executor = GeminiDogfoodToolExecutor(artifact_text_backend=backend)

    execution = await executor.execute(
        GeminiLiveFunctionCall(
            call_id="call-1",
            name=READ_ARTIFACT_TEXT_TOOL_NAME,
            args={"artifact_id": "artifact-1"},
        ),
        session_id="session-1",
        user_id="user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="gemini-live",
    )

    assert execution.response["text"] == "Large heading\nTiny fine print: 42"
    diagnostic = execution.diagnostic()
    assert diagnostic["raw_artifact_text_excluded"] is True
    assert "Tiny fine print" not in str(diagnostic)
    assert diagnostic["response"]["char_count"] == 33
