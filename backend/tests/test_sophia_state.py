"""Tests for SophiaState TypedDict schema."""

from pathlib import Path
from typing import get_type_hints

from deerflow.agents.sophia_agent.state import SophiaState


def test_sophia_state_has_messages():
    """SophiaState inherits messages from AgentState."""
    hints = get_type_hints(SophiaState, include_extras=True)
    assert "messages" in hints


def test_sophia_state_has_all_required_fields():
    """All companion-specific fields are present."""
    hints = get_type_hints(SophiaState, include_extras=True)
    expected_fields = [
        "platform", "active_mode", "turn_count",
        "user_id", "context_mode",
        "active_ritual", "ritual_phase",
        "force_skill", "skip_expensive",
        "active_tone_band", "active_skill", "skill_session_data",
        "current_artifact", "previous_artifact",
        "injected_memories",
        "builder_task", "builder_result",
        "system_prompt_blocks",
        "title",
    ]
    for field in expected_fields:
        assert field in hints, f"Missing field: {field}"


def test_system_prompt_blocks_does_not_use_add_reducer():
    """system_prompt_blocks should be plain state because middlewares extend it manually."""
    hints = get_type_hints(SophiaState, include_extras=True)
    annotation = hints["system_prompt_blocks"]
    assert not hasattr(annotation, "__metadata__")


def test_skills_reorganized():
    """Skill files exist at the spec-defined paths."""
    # Find project root (go up from backend/tests/)
    project_root = Path(__file__).resolve().parent.parent.parent
    skills_path = project_root / "skills" / "public" / "sophia"

    # Core files
    for name in ["soul.md", "voice.md", "techniques.md", "tone_guidance.md", "artifact_instructions.md"]:
        assert (skills_path / name).exists(), f"Missing: {name}"

    # Context files
    for name in ["gaming.md", "life.md", "work.md"]:
        assert (skills_path / "context" / name).exists(), f"Missing context: {name}"

    # Skill files
    expected_skills = [
        "active_listening.md", "vulnerability_holding.md", "crisis_redirect.md",
        "trust_building.md", "boundary_holding.md", "challenging_growth.md",
        "identity_fluidity_support.md", "celebrating_breakthrough.md",
    ]
    for name in expected_skills:
        assert (skills_path / "skills" / name).exists(), f"Missing skill: {name}"


def test_pipeline_prompts_in_backend():
    """Pipeline prompt templates are in backend, not in skills."""
    project_root = Path(__file__).resolve().parent.parent.parent
    prompts_path = project_root / "backend" / "packages" / "harness" / "deerflow" / "sophia" / "prompts"

    for name in ["mem0_extraction.md", "session_state_assembly.md", "identity_file_update.md", "reflect_prompt.md"]:
        assert (prompts_path / name).exists(), f"Missing prompt template: {name}"
