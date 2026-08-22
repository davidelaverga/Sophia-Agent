from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from voice.realtime.gemini_live import build_gemini_live_setup_config
from voice.realtime.gemini_memory_context import (
    build_gemini_live_memory_context,
    build_gemini_live_realtime_instructions_with_memory_context,
)
from voice.realtime.sophia_prompt import (
    CORE_SKILL_FILES,
    EMOTIONAL_SKILLS_REPERTOIRE_SOURCE,
    GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE,
    REPO_ROOT,
    REALTIME_MEMORY_RECALL_GUIDANCE_SOURCE,
    SOPHIA_AGENT_MIDDLEWARE_PATH,
    build_gemini_live_realtime_instructions,
    build_gemini_live_realtime_setup_instructions,
    build_gemini_live_spoken_turn_policy_overlay,
    build_realtime_memory_recall_guidance,
    build_sophia_realtime_setup_instructions,
    build_sophia_realtime_instructions,
    gemini_live_realtime_instruction_sources,
    sophia_realtime_instruction_sources,
)
from voice.realtime.openai_realtime import build_openai_realtime_session_config
from voice.realtime.skill_slow_state import (
    MAX_RECURRING_PATTERN_CHARS,
    VoiceSkillSlowStateSeed,
    build_voice_skill_state_seed_block,
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


def test_realtime_prompt_source_files_exist_for_voice_runtime() -> None:
    assert {path.name for path in CORE_SKILL_FILES} == {
        "soul.md",
        "voice.md",
        "techniques.md",
        "coordination_core.md",
        "companion_delegation.md",
    }

    for path in CORE_SKILL_FILES:
        assert path.is_file(), f"Missing realtime prompt source: {path}"

    assert (SOPHIA_AGENT_MIDDLEWARE_PATH / "platform_context.py").is_file()
    assert (SOPHIA_AGENT_MIDDLEWARE_PATH / "artifact.py").is_file()
    assert build_sophia_realtime_instructions()


def test_voice_dockerfile_copies_realtime_prompt_sources() -> None:
    dockerfile = (REPO_ROOT / "voice" / "Dockerfile").read_text(encoding="utf-8")
    dockerignore = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")

    assert "COPY skills/public/sophia/ ./skills/public/sophia/" in dockerfile
    assert (
        "COPY backend/packages/harness/deerflow/agents/sophia_agent/middlewares/"
        "platform_context.py"
    ) in dockerfile
    assert (
        "COPY backend/packages/harness/deerflow/agents/sophia_agent/middlewares/"
        "artifact.py"
    ) in dockerfile
    assert "!skills/public/sophia/**" in dockerignore


def test_voice_dockerfile_copies_dependency_safe_tool_contracts() -> None:
    dockerfile = (REPO_ROOT / "voice" / "Dockerfile").read_text(encoding="utf-8")

    for contract_path in [
        "backend/packages/harness/deerflow/__init__.py",
        "backend/packages/harness/deerflow/sophia/__init__.py",
        "backend/packages/harness/deerflow/sophia/tools/__init__.py",
        "backend/packages/harness/deerflow/sophia/tools/emit_artifact_contract.py",
        "backend/packages/harness/deerflow/sophia/tools/builder_lifecycle_contract.py",
        "backend/packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py",
    ]:
        assert f"COPY {contract_path}" in dockerfile

    assert 'ENV PYTHONPATH="/app/backend/packages/harness:${PYTHONPATH}"' in dockerfile


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


def test_gemini_live_spoken_policy_requires_artifact_evidence_before_ready_claim() -> None:
    overlay = build_gemini_live_spoken_turn_policy_overlay()

    assert "A builder launch or update only means the work was accepted" in overlay
    assert "check_async_task for that exact task returns status=success" in overlay
    assert "non-empty accepted artifact_path" in overlay
    assert "then verify that task with check_async_task before announcing readiness" in overlay


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
    assert "dynamic seed tells you which modes are in bounds" in prompt
    assert "session count, established-trust flag, recurring-pattern flags, and prior tone band" in prompt
    for skill_name in EMOTIONAL_SKILL_NAMES:
        assert skill_name in prompt


def test_voice_skill_state_seed_renders_conservative_defaults() -> None:
    seed = build_voice_skill_state_seed_block()

    assert "### Voice Skill State" in seed
    assert "session_count: unknown" in seed
    assert "trust_established: unknown" in seed
    assert "recurring_patterns: unknown" in seed
    assert "prior_tone_band: unknown" in seed
    assert "default_posture: trust_building" in seed
    assert "challenging_growth_allowed: false" in seed
    assert "challenging_growth_reason: trust/pattern evidence unavailable" in seed
    assert "out_of_bounds: challenging_growth" in seed
    assert "crisis_override: always in bounds" in seed
    assert "The model still reads the live emotional moment." in seed


def test_voice_skill_state_seed_unknown_trust_blocks_challenging_growth() -> None:
    seed = build_voice_skill_state_seed_block(
        VoiceSkillSlowStateSeed(
            session_count=12,
            trust_established=None,
            recurring_patterns=("Avoids hard conversations until the deadline is close.",),
            recurring_patterns_known=True,
            prior_tone_band="engagement",
        )
    )

    assert "session_count: 12" in seed
    assert "trust_established: unknown" in seed
    assert "prior_tone_band: engagement" in seed
    assert "default_posture: trust_building" in seed
    assert "challenging_growth_allowed: false" in seed
    assert "challenging_growth_reason: trust is not established" in seed
    assert "out_of_bounds: challenging_growth" in seed


def test_voice_skill_state_seed_early_session_defaults_to_trust_building() -> None:
    seed = build_voice_skill_state_seed_block(
        VoiceSkillSlowStateSeed(
            session_count=1,
            trust_established=False,
            recurring_patterns=(),
            recurring_patterns_known=True,
        )
    )

    assert "session_count: 1" in seed
    assert "trust_established: false" in seed
    assert "recurring_patterns: none" in seed
    assert "default_posture: trust_building" in seed
    assert "challenging_growth_allowed: false" in seed


def test_voice_skill_state_seed_allows_challenging_growth_with_trust_and_pattern() -> None:
    seed = build_voice_skill_state_seed_block(
        VoiceSkillSlowStateSeed(
            session_count=8,
            trust_established=True,
            recurring_patterns=("Avoids the hard part by switching into planning mode.",),
            recurring_patterns_known=True,
            prior_tone_band="anger-antagonism",
        )
    )

    assert "session_count: 8" in seed
    assert "trust_established: true" in seed
    assert "prior_tone_band: anger_antagonism" in seed
    assert "default_posture: active_listening" in seed
    assert "challenging_growth_allowed: true" in seed
    assert "challenging_growth_reason: trust established and recurring pattern evidence present" in seed
    assert "in_bounds:" in seed and "challenging_growth" in seed
    assert "out_of_bounds: none" in seed


def test_voice_skill_state_seed_keeps_always_in_bounds_skills() -> None:
    seed = build_voice_skill_state_seed_block()

    assert "active_listening (always)" in seed
    assert "crisis_redirect (override)" in seed
    assert "crisis_override: always in bounds" in seed


def test_voice_skill_state_seed_bounds_pattern_summaries_and_invalid_tone() -> None:
    long_pattern = "x" * (MAX_RECURRING_PATTERN_CHARS + 30)
    seed = build_voice_skill_state_seed_block(
        VoiceSkillSlowStateSeed(
            trust_established=True,
            recurring_patterns=(long_pattern, "second pattern", "third pattern", "fourth pattern"),
            recurring_patterns_known=True,
            prior_tone_band="not-a-band",
        )
    )

    pattern_line = next(line for line in seed.splitlines() if line.startswith("- recurring_patterns:"))
    assert "..." in pattern_line
    assert "fourth pattern" not in pattern_line
    assert "prior_tone_band: unknown" in seed
    assert len(pattern_line.split(": ", 1)[1].split("; ")[0]) <= MAX_RECURRING_PATTERN_CHARS


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
        "hidden reasoning",
        "tool-repair attempts",
        "validation errors",
        "thought:",
        "emit artifact correction attempt",
        "repair silently through the structured tool path",
    ]:
        assert expected in overlay


@pytest.mark.parametrize(
    ("google_search_enabled", "web_fetch_enabled"),
    [
        (False, False),
        (False, True),
        (True, False),
        (True, True),
    ],
)
def test_gemini_live_web_prompt_overlay_matches_independent_capability_switches(
    google_search_enabled: bool,
    web_fetch_enabled: bool,
) -> None:
    overlay = build_gemini_live_spoken_turn_policy_overlay(
        google_search_enabled=google_search_enabled,
        web_fetch_enabled=web_fetch_enabled,
    )

    assert (
        "You can search the current public web with Google Search." in overlay
    ) is google_search_enabled
    assert (
        "Use web_fetch when" in overlay or "use web_fetch to read" in overlay
    ) is web_fetch_enabled
    if not google_search_enabled and not web_fetch_enabled:
        assert "Google Search" not in overlay
        assert "web_fetch" not in overlay


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


def test_realtime_prompt_contains_companion_artifact_builder_boundary() -> None:
    prompt = build_sophia_realtime_instructions().lower()

    for expected in [
        "companion artifact vs builder deliverable",
        "short reflection artifact",
        "use `emit_artifact` and do not start builder",
        "document/file/report/build/downloadable deliverable -> builder",
        "ambiguous artifact wording -> ask one clarifying question",
        "if the user asks to test artifact functionality",
        "use builder only when the user explicitly asks for a document",
    ]:
        assert expected in prompt


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


def test_gemini_live_setup_instructions_include_dynamic_skill_seed() -> None:
    prompt = build_gemini_live_realtime_setup_instructions()
    setup = build_gemini_live_setup_config(instructions=prompt)
    rendered = _system_instruction_text(setup)

    assert "### Voice Skill State" in rendered
    assert "session_count: unknown" in rendered
    assert "challenging_growth_allowed: false" in rendered
    assert rendered.index("### Voice Skill State") < rendered.index("<gemini_live_spoken_turn_policy>")


def test_openai_realtime_session_config_can_carry_dynamic_skill_seed() -> None:
    instructions = build_sophia_realtime_setup_instructions(
        skill_state=VoiceSkillSlowStateSeed(
            session_count=6,
            trust_established=True,
            recurring_patterns=("Retreats into over-planning when the emotional risk rises.",),
            recurring_patterns_known=True,
            prior_tone_band="engagement",
        )
    )
    config = build_openai_realtime_session_config(instructions=instructions)

    rendered = str(config["instructions"])
    assert "### Voice Skill State" in rendered
    assert "session_count: 6" in rendered
    assert "trust_established: true" in rendered
    assert "challenging_growth_allowed: true" in rendered
    assert "consult_skill" not in rendered


def test_stable_realtime_prompt_does_not_include_dynamic_skill_state_values() -> None:
    prompt = build_sophia_realtime_instructions()

    assert "### Voice Skill State" not in prompt
    assert "session_count: unknown" not in prompt
    assert "trust_established: unknown" not in prompt
    assert "challenging_growth_allowed:" not in prompt


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


def test_gemini_live_memory_context_uses_backend_payload_before_overlay() -> None:
    prompt, context = build_gemini_live_realtime_instructions_with_memory_context(
        user_id="user-1",
        context_mode="life",
        backend_context={
            "preferred_name": "Luis",
            "identity_excerpt": (
                "Name: Luis\nLuis responds well to direct acknowledgment before emotional probes."
            ),
            "handoff_excerpt": "Session initiated with Luis. Wait for him to name what matters.",
            "memories": [],
            "diagnostics": {
                "schema": "sophia_realtime_context_v1",
                "context_fetch_status": "ok",
                "mem0_status": "missing_api_key",
                "mem0_provider_reason": "missing_api_key",
                "identity_available": True,
                "handoff_available": True,
                "memory_count": 0,
                "memory_limit": 4,
            },
        },
    )

    assert "<gemini_live_user_context>" in prompt
    assert "### Voice Skill State" in prompt
    assert "Preferred name: Luis" in prompt
    assert "Stored identity excerpt:" in prompt
    assert "Latest session handoff excerpt:" in prompt
    assert "Do not mention files, Mem0, setup, diagnostics, or retrieval mechanics aloud" in prompt
    assert "Preferred name, identity excerpts, and handoff excerpts are setup context from earlier" in prompt
    assert "stored memories are only the items listed under Relevant stored memories" in prompt
    assert prompt.index("<gemini_live_user_context>") < prompt.index("<gemini_live_spoken_turn_policy>")
    assert prompt.index("<gemini_live_user_context>") < prompt.index("### Voice Skill State")
    assert prompt.index("### Voice Skill State") < prompt.index("<gemini_live_spoken_turn_policy>")
    assert context.diagnostics["trusted_user_context"] is True
    assert context.diagnostics["injected"] is True
    assert context.diagnostics["backend_context_status"] == "ok"
    assert context.diagnostics["backend_context_schema"] == "sophia_realtime_context_v1"
    assert context.diagnostics["preferred_name_present"] is True
    assert context.diagnostics["identity_available"] is True
    assert context.diagnostics["handoff_available"] is True
    assert context.diagnostics["mem0_status"] == "missing_api_key"
    assert context.diagnostics["mem0_provider_reason"] == "missing_api_key"
    assert context.diagnostics["skill_state"]["schema"] == "voice_skill_state_seed_v1"
    assert context.diagnostics["skill_state"]["challenging_growth_allowed"] is False


def test_gemini_live_memory_context_uses_bounded_backend_mem0_memories() -> None:
    context = build_gemini_live_memory_context(
        user_id="user-1",
        context_mode="work",
        ritual="debrief",
        backend_context={
            "memories": [
                {"content": "Luis prefers direct, concrete acknowledgments.", "category": "preference"},
                {"content": "Luis is working through a difficult career decision.", "category": "decision"},
                {"content": "Luis uses technical detail as a processing tool.", "category": "pattern"},
                {"content": "Short pauses land better than stacked questions.", "category": "preference"},
                {"content": "This fifth memory should be outside the configured limit.", "category": "fact"},
            ],
            "diagnostics": {
                "schema": "sophia_realtime_context_v1",
                "context_fetch_status": "ok",
                "mem0_status": "available",
                "mem0_provider_reason": "sdk_client",
                "identity_available": False,
                "handoff_available": False,
                "memory_count": 5,
                "memory_limit": 4,
            },
        },
    )

    assert context.prompt_block is not None
    assert context.skill_state_prompt_block is not None
    assert context.prompt_block.count("- [") == 4
    assert "This fifth memory" not in context.prompt_block
    assert "### Voice Skill State" in context.skill_state_prompt_block
    assert "Luis uses technical detail as a processing tool." in context.skill_state_prompt_block
    assert "This fifth memory" not in context.skill_state_prompt_block
    assert "challenging_growth_allowed: false" in context.skill_state_prompt_block
    assert context.diagnostics["memory_count"] == 4
    assert context.diagnostics["memory_categories"] == ["decision", "pattern", "preference"]
    assert context.diagnostics["skill_state"]["recurring_pattern_count"] == 1
    assert context.diagnostics["skill_state"]["raw_unbounded_memory_text_included"] is False
    assert "Luis prefers" not in str(context.diagnostics)


def test_gemini_live_memory_context_degrades_without_backend_payload() -> None:
    context = build_gemini_live_memory_context(user_id="user-1")

    assert context.prompt_block is None
    assert context.skill_state_prompt_block is not None
    assert context.diagnostics["status"] == "empty"
    assert context.diagnostics["backend_context_status"] == "missing"
    assert context.diagnostics["mem0_status"] == "unavailable"
    assert context.diagnostics["mem0_provider_reason"] == "no_backend_context"
    assert context.diagnostics["memory_count"] == 0
    assert context.diagnostics["skill_state"]["challenging_growth_allowed"] is False


def test_gemini_live_memory_context_no_longer_imports_backend_mem0_client() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "realtime"
        / "gemini_memory_context.py"
    ).read_text(encoding="utf-8")

    assert "deerflow.sophia.mem0_client" not in source
    assert "_mem0_client_module" not in source
    assert "_search_mem0_memories" not in source
    assert "USERS_DIR" not in source


def test_debug_rendered_gemini_prompt_includes_strengthened_overlay() -> None:
    debug_prompt = (
        Path(__file__).resolve().parents[2]
        / "docs"
        / "debug"
        / "gemini-live-fully-rendered-sophia-prompt.md"
    ).read_text(encoding="utf-8").lower()

    for expected in [
        "### §m — your skills (your repertoire for different moments)",
        "dynamic seed tells you which modes are in bounds",
        "active_listening",
        "vulnerability_holding",
        "crisis_redirect",
        "trust_building",
        "boundary_holding",
        "challenging_growth",
        "identity_fluidity_support",
        "celebrating_breakthrough",
        "minimal crisis acknowledgment",
        "### voice skill state",
        "session_count: unknown",
        "challenging_growth_allowed: false",
        "crisis_override: always in bounds",
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
