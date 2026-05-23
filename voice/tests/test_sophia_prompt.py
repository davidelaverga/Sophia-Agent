from __future__ import annotations

from pathlib import Path
from typing import Any

import voice.realtime.gemini_memory_context as gemini_memory_context
from voice.realtime.gemini_live import build_gemini_live_setup_config
from voice.realtime.gemini_memory_context import (
    build_gemini_live_memory_context,
    build_gemini_live_realtime_instructions_with_memory_context,
)
from voice.realtime.sophia_prompt import (
    EMOTIONAL_SKILLS_REPERTOIRE_SOURCE,
    GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE,
    REALTIME_MEMORY_RECALL_GUIDANCE_SOURCE,
    build_gemini_live_realtime_instructions,
    build_gemini_live_spoken_turn_policy_overlay,
    build_realtime_memory_recall_guidance,
    build_sophia_realtime_instructions,
    gemini_live_realtime_instruction_sources,
    sophia_realtime_instruction_sources,
)


EMOTIONAL_SKILL_NAMES = [
    "active_listening",
    "vulnerability_holding",
    "crisis_redirect",
    "trust_building",
    "boundary_holding",
    "challenging_growth",
    "identity_fluidity_support",
    "celebrating_breakthrough",
]


def _system_instruction_text(setup: dict[str, Any]) -> str:
    system_instruction = setup["systemInstruction"]
    return system_instruction["parts"][0]["text"]


def test_gemini_live_prompt_includes_spoken_turn_policy_overlay() -> None:
    overlay = build_gemini_live_spoken_turn_policy_overlay()
    prompt = build_gemini_live_realtime_instructions(
        context_mode="gaming",
        ritual="prepare",
    )

    assert overlay in prompt
    assert "<gemini_live_spoken_turn_policy>" in prompt
    assert "# Context: Gaming" in prompt
    assert "# Skill: ritual_prepare" in prompt


def test_base_sophia_realtime_prompt_does_not_include_gemini_overlay() -> None:
    prompt = build_sophia_realtime_instructions()

    assert "<gemini_live_spoken_turn_policy>" not in prompt
    assert "Gemini Live-specific overlay" not in prompt
    assert GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE not in sophia_realtime_instruction_sources()


def test_realtime_prompt_bakes_emotional_skills_without_skill_tool() -> None:
    prompt = build_sophia_realtime_instructions()

    assert "consult_skill" not in prompt
    assert "### §M — Your Skills (your repertoire for different moments)" in prompt
    assert "You hold all of these at once" in prompt
    assert "session count, established-trust flag, recurring-pattern flags, and prior tone band" in prompt
    for skill_name in EMOTIONAL_SKILL_NAMES:
        assert skill_name in prompt


def test_realtime_prompt_contains_crisis_override_and_artifact_exception() -> None:
    prompt = build_sophia_realtime_instructions()

    assert "### §N — Crisis (overrides everything)" in prompt
    assert "every other skill stops immediately" in prompt
    assert "No exploring, no techniques, no prediction, no build" in prompt
    assert "call or text 988" in prompt
    assert "text HOME to 741741" in prompt
    assert "minimal crisis acknowledgment" in prompt
    assert "do not emit the full artifact" in prompt.lower()


def test_realtime_prompt_reframes_skill_loaded_as_self_observation() -> None:
    prompt = build_sophia_realtime_instructions()

    assert "skill_loaded: the mode you are in this turn" in prompt
    assert "not the record of a tool call" in prompt
    assert "exact injected skill name" not in prompt
    assert "the one you loaded" not in prompt


def test_gemini_live_spoken_turn_policy_contains_required_rules() -> None:
    overlay = build_gemini_live_spoken_turn_policy_overlay().lower()

    for expected in [
        "one main conversational intent",
        "at most one question",
        "brief acknowledgement",
        "do not assume the user is gaming",
        "if context is missing ask one clarifier only",
        "latest complete user utterance",
        "what i just said",
        "quick question before i go",
        "artifact/tool obligations",
        "do not mention artifact bookkeeping aloud",
        "internal bookkeeping",
    ]:
        assert expected in overlay


def test_realtime_memory_recall_guidance_contains_epistemic_rules() -> None:
    guidance = build_realtime_memory_recall_guidance().lower()

    for expected in [
        "explicit memory questions",
        "retrieve_memories",
        "broad recall and later specific recall are separate opportunities",
        "simple greetings",
        "what is my name",
        "stored memory",
        "setup context",
        "current-session context",
        "not durable memory until offline writeback confirms",
        "do not promise permanent memory",
        "future recall",
        "inference or guess",
        "missing memory",
        "unavailable memory",
        "i knew it",
        "i remembered that",
        "i had that",
        "i knew it had to be",
        "for this session",
    ]:
        assert expected in guidance


def test_gemini_live_setup_contains_overlay_after_artifact_contract() -> None:
    prompt = build_gemini_live_realtime_instructions()
    setup = build_gemini_live_setup_config(instructions=prompt)
    rendered = _system_instruction_text(setup)

    assert rendered == prompt
    assert "consult_skill" not in rendered
    assert "### §M — Your Skills (your repertoire for different moments)" in rendered
    assert "crisis_redirect" in rendered
    assert "<artifact_contract>" in rendered
    assert "<gemini_live_spoken_turn_policy>" in rendered
    assert rendered.index("<artifact_contract>") < rendered.index(
        "<gemini_live_spoken_turn_policy>"
    )
    assert rendered.rstrip().endswith("</gemini_live_spoken_turn_policy>")


def test_gemini_live_instruction_sources_append_overlay_source() -> None:
    sources = gemini_live_realtime_instruction_sources(
        context_mode="work",
        ritual="debrief",
    )

    assert sources[-1] == GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE
    assert EMOTIONAL_SKILLS_REPERTOIRE_SOURCE in sources
    assert REALTIME_MEMORY_RECALL_GUIDANCE_SOURCE in sources
    assert sources.index(EMOTIONAL_SKILLS_REPERTOIRE_SOURCE) < sources.index(
        "backend/packages/harness/deerflow/agents/sophia_agent/middlewares/"
        "platform_context.py::PLATFORM_PROMPTS"
    )
    assert sources.index(REALTIME_MEMORY_RECALL_GUIDANCE_SOURCE) < sources.index(
        "backend/packages/harness/deerflow/agents/sophia_agent/middlewares/"
        "artifact.py::_VOICE_ARTIFACT_INSTRUCTIONS"
    )
    assert "skills/public/sophia/context/work.md" in sources
    assert "skills/public/sophia/rituals/debrief.md" in sources


def test_gemini_live_memory_context_uses_trusted_user_files_before_overlay(tmp_path, monkeypatch) -> None:
    user_dir = tmp_path / "user-1"
    (user_dir / "handoffs").mkdir(parents=True)
    (user_dir / "identity.md").write_text(
        "Name: Luis\nLuis responds well to direct acknowledgment before emotional probes.",
        encoding="utf-8",
    )
    (user_dir / "handoffs" / "latest.md").write_text(
        "Session initiated with Luis. Wait for him to name what matters.",
        encoding="utf-8",
    )
    monkeypatch.setattr(gemini_memory_context, "USERS_DIR", tmp_path)

    class MissingMem0Client:
        @staticmethod
        def memory_provider_status() -> dict[str, object]:
            return {
                "available": False,
                "provider_status": "unavailable",
                "provider_reason": "missing_api_key",
            }

    monkeypatch.setattr(gemini_memory_context, "_mem0_client_module", lambda: MissingMem0Client)

    prompt, context = build_gemini_live_realtime_instructions_with_memory_context(
        user_id="user-1",
        context_mode="life",
    )

    assert "<gemini_live_user_context>" in prompt
    assert "Preferred name: Luis" in prompt
    assert "Stored identity excerpt:" in prompt
    assert "Latest session handoff excerpt:" in prompt
    assert "Do not mention files, Mem0, setup, diagnostics, or retrieval mechanics aloud" in prompt
    assert "Preferred name, identity excerpts, and handoff excerpts are setup context from earlier" in prompt
    assert "stored memories are only the items listed under Relevant stored memories" in prompt
    assert prompt.index("<gemini_live_user_context>") < prompt.index("<gemini_live_spoken_turn_policy>")
    assert context.diagnostics["trusted_user_context"] is True
    assert context.diagnostics["injected"] is True
    assert context.diagnostics["preferred_name_present"] is True
    assert context.diagnostics["mem0_status"] == "not_configured"
    assert context.diagnostics["mem0_provider_reason"] == "missing_api_key"


def test_gemini_live_memory_context_fetches_bounded_mem0_memories(monkeypatch) -> None:
    calls: list[dict[str, object]] = []

    class FakeMem0Client:
        @staticmethod
        def memory_provider_status() -> dict[str, object]:
            return {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            }

        @staticmethod
        def search_memories_with_diagnostics(**kwargs):  # noqa: ANN202
            calls.append(dict(kwargs))
            return {
                "memories": [
                    {"content": "Luis prefers direct, concrete acknowledgments.", "category": "preference"},
                    {"content": "Luis is working through a difficult career decision.", "category": "decision"},
                    {"content": "Luis uses technical detail as a processing tool.", "category": "pattern"},
                    {"content": "Short pauses land better than stacked questions.", "category": "preference"},
                    {"content": "This fifth memory should be outside the configured limit.", "category": "fact"},
                ],
                "provider_status": "available",
                "provider_reason": "sdk_client",
                "cache_status": "miss",
            }

    monkeypatch.setattr(gemini_memory_context, "_mem0_client_module", lambda: FakeMem0Client)
    context = build_gemini_live_memory_context(
        user_id="user-1",
        context_mode="work",
        ritual="debrief",
    )

    assert calls[0]["user_id"] == "user-1"
    assert calls[0]["limit"] == 4
    assert calls[0]["log_content_previews"] is False
    assert calls[0]["raise_on_error"] is True
    assert "preference" in calls[0]["categories"]
    assert "ritual_context" in calls[0]["categories"]
    assert context.prompt_block is not None
    assert context.prompt_block.count("- [") == 4
    assert "This fifth memory" not in context.prompt_block
    assert context.diagnostics["memory_count"] == 4
    assert context.diagnostics["memory_categories"] == ["decision", "pattern", "preference"]
    assert "Luis prefers" not in str(context.diagnostics)


def test_debug_rendered_gemini_prompt_includes_strengthened_overlay() -> None:
    debug_prompt = (
        Path(__file__).resolve().parents[2]
        / "docs"
        / "debug"
        / "gemini-live-fully-rendered-sophia-prompt.md"
    ).read_text(encoding="utf-8").lower()

    for expected in [
        "### §m — your skills (your repertoire for different moments)",
        "active_listening",
        "vulnerability_holding",
        "crisis_redirect",
        "trust_building",
        "boundary_holding",
        "challenging_growth",
        "identity_fluidity_support",
        "celebrating_breakthrough",
        "minimal crisis acknowledgment",
        "<realtime_memory_recall_guidance>",
        "broad recall and later specific recall are separate opportunities",
        "current-session context",
        "i knew it",
        "<gemini_live_spoken_turn_policy>",
        "do not assume the user is gaming",
        "latest complete user utterance",
        "quick question before i go",
        "do not mention artifact bookkeeping aloud",
    ]:
        assert expected in debug_prompt
    assert "consult_skill" not in debug_prompt
