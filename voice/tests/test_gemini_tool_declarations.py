from __future__ import annotations

import importlib
from typing import Any

from voice.realtime import sophia_backend_tools


def test_dependency_safe_emit_artifact_contract_imports_in_voice_runtime() -> None:
    sophia_backend_tools._emit_artifact_contract_module.cache_clear()

    loaded_contract = sophia_backend_tools._emit_artifact_contract_module()
    direct_contract = importlib.import_module(
        "deerflow.sophia.tools.emit_artifact_contract"
    )

    assert direct_contract is loaded_contract
    assert direct_contract.EMIT_ARTIFACT_TOOL_NAME == "emit_artifact"


def test_gemini_emit_artifact_declaration_builds_from_contract() -> None:
    sophia_backend_tools._emit_artifact_contract_module.cache_clear()

    declaration = sophia_backend_tools.gemini_emit_artifact_function_declaration()

    assert declaration["name"] == "emit_artifact"
    assert "parameters" in declaration
    assert set(declaration["parameters"]["required"]) == {
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


def test_gemini_emit_artifact_reflection_nullability_matches_runtime_contract() -> None:
    sophia_backend_tools._emit_artifact_contract_module.cache_clear()
    contract = sophia_backend_tools._emit_artifact_contract_module()

    declaration = sophia_backend_tools.gemini_emit_artifact_function_declaration()
    reflection_schema = contract.ArtifactInput.model_json_schema()["properties"]["reflection"]
    reflection_declaration = declaration["parameters"]["properties"]["reflection"]

    assert {"type": "null"} in reflection_schema["anyOf"]
    assert reflection_declaration["type"] == "STRING"
    assert reflection_declaration["nullable"] is True

    artifact = {
        "session_goal": "Stay grounded.",
        "active_goal": "Acknowledge the user.",
        "next_step": "Listen for the next turn.",
        "takeaway": "The user confirmed their preferred name.",
        "reflection": None,
        "tone_estimate": 2.0,
        "tone_target": 2.5,
        "active_tone_band": "engagement",
        "skill_loaded": "active_listening",
        "ritual_phase": "freeform.memory_check",
        "voice_emotion_primary": "calm",
        "voice_emotion_secondary": "warm",
        "voice_speed": "normal",
    }
    assert contract.validate_emit_artifact_args(artifact)["reflection"] is None


def test_gemini_sophia_declarations_include_emit_artifact_from_contract() -> None:
    sophia_backend_tools._emit_artifact_contract_module.cache_clear()
    sophia_backend_tools._builder_lifecycle_contract_module.cache_clear()
    sophia_backend_tools._retrieve_memories_contract_module.cache_clear()

    declarations = sophia_backend_tools.gemini_sophia_function_declarations()

    assert [declaration["name"] for declaration in declarations] == [
        "emit_artifact",
        "start_builder_task",
        "edit_builder_artifact",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
        "retrieve_memories",
        "web_fetch",
    ]


def test_realtime_web_fetch_rejects_private_network_urls() -> None:
    import asyncio

    result = asyncio.run(
        sophia_backend_tools.execute_realtime_web_fetch(
            {"url": "http://127.0.0.1:2024/threads"}
        )
    )

    assert result["ok"] is False
    assert result["status"] == "invalid_url"
    assert result["error_type"] == "invalid_public_url"


def test_realtime_web_fetch_returns_bounded_reader_text(monkeypatch) -> None:
    import asyncio

    captured: dict[str, Any] = {}

    class FakeResponse:
        status_code = 200
        text = "# Example\n\nReadable source text."

    class FakeAsyncClient:
        def __init__(self, *, timeout: float) -> None:
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, url: str, *, headers: dict[str, str], json: dict[str, str]):
            captured.update({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    monkeypatch.setattr(sophia_backend_tools.httpx, "AsyncClient", FakeAsyncClient)

    result = asyncio.run(
        sophia_backend_tools.execute_realtime_web_fetch(
            {"url": "https://example.com/reference"}
        )
    )

    assert result["ok"] is True
    assert result["content"] == "# Example\n\nReadable source text."
    assert result["truncated"] is False
    assert captured["url"] == "https://r.jina.ai/"
    assert captured["json"] == {"url": "https://example.com/reference"}
