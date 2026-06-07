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
    ]
