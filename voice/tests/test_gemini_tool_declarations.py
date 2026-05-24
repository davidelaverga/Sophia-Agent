from __future__ import annotations

import importlib

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


def test_gemini_sophia_declarations_include_emit_artifact_from_contract() -> None:
    sophia_backend_tools._emit_artifact_contract_module.cache_clear()
    sophia_backend_tools._builder_lifecycle_contract_module.cache_clear()
    sophia_backend_tools._retrieve_memories_contract_module.cache_clear()

    declarations = sophia_backend_tools.gemini_sophia_function_declarations()

    assert [declaration["name"] for declaration in declarations] == [
        "emit_artifact",
        "start_builder_task",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
        "retrieve_memories",
    ]
