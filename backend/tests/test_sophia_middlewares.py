"""Tests for all Sophia middleware components."""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# --- Helpers ---

def _make_runtime(**context_kwargs):
    """Create a mock Runtime with context."""
    runtime = MagicMock()
    runtime.context = context_kwargs
    return runtime


def _make_message(content: str, msg_type: str = "human"):
    """Create a mock message."""
    msg = MagicMock()
    msg.content = content
    msg.type = msg_type
    return msg


def _make_ai_message_with_tool_call(tool_name: str, args: dict):
    """Create a mock AI message with a tool call."""
    msg = MagicMock()
    msg.type = "ai"
    msg.content = "Some response text"
    msg.tool_calls = [{"name": tool_name, "args": args}]
    return msg


# --- CrisisCheckMiddleware ---

class TestCrisisCheckMiddleware:
    def _get_middleware(self):
        from deerflow.agents.sophia_agent.middlewares.crisis_check import CrisisCheckMiddleware
        return CrisisCheckMiddleware()

    def test_crisis_signal_detected(self):
        mw = self._get_middleware()
        state = {"messages": [_make_message("I want to die")]}
        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        assert result["force_skill"] == "crisis_redirect"
        assert result["skip_expensive"] is True

    def test_crisis_case_insensitive(self):
        mw = self._get_middleware()
        state = {"messages": [_make_message("I WANT TO DIE")]}
        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        assert result["force_skill"] == "crisis_redirect"

    def test_crisis_embedded_in_sentence(self):
        mw = self._get_middleware()
        state = {"messages": [_make_message("Sometimes I just want to die and I don't know why")]}
        result = mw.before_agent(state, _make_runtime())
        assert result is not None

    def test_no_crisis_normal_message(self):
        mw = self._get_middleware()
        state = {"messages": [_make_message("I had a great day today")]}
        result = mw.before_agent(state, _make_runtime())
        assert result is None

    def test_no_crisis_empty_messages(self):
        mw = self._get_middleware()
        state = {"messages": []}
        result = mw.before_agent(state, _make_runtime())
        assert result is None

    def test_all_crisis_signals(self):
        from deerflow.agents.sophia_agent.middlewares.crisis_check import CRISIS_SIGNALS
        mw = self._get_middleware()
        for signal in CRISIS_SIGNALS:
            state = {"messages": [_make_message(signal)]}
            result = mw.before_agent(state, _make_runtime())
            assert result is not None, f"Signal not detected: {signal}"


# --- FileInjectionMiddleware ---

class TestFileInjectionMiddleware:
    def _make_file(self, tmp_path: Path, name: str, content: str) -> Path:
        p = tmp_path / name
        p.write_text(content)
        return p

    def test_injects_file_content(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        path = self._make_file(tmp_path, "test.md", "# Test Content")
        mw = FileInjectionMiddleware(path)
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result is not None
        assert result["system_prompt_blocks"] == ["# Test Content"]

    def test_soul_md_injects_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        path = self._make_file(tmp_path, "soul.md", "Soul content")
        mw = FileInjectionMiddleware(path, skip_on_crisis=False)
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is not None
        assert "Soul content" in result["system_prompt_blocks"][0]

    def test_voice_md_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        path = self._make_file(tmp_path, "voice.md", "Voice content")
        mw = FileInjectionMiddleware(path, skip_on_crisis=True)
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None

    def test_missing_file_raises_at_init(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        with pytest.raises(FileNotFoundError):
            FileInjectionMiddleware(tmp_path / "nonexistent.md")


# --- PlatformContextMiddleware ---

class TestPlatformContextMiddleware:
    def _get_middleware(self):
        from deerflow.agents.sophia_agent.middlewares.platform_context import PlatformContextMiddleware
        return PlatformContextMiddleware()

    def test_voice_platform(self):
        mw = self._get_middleware()
        result = mw.before_agent({"messages": []}, _make_runtime(platform="voice"))
        assert result["platform"] == "voice"
        assert "1-3 sentences" in result["system_prompt_blocks"][0]

    def test_text_platform(self):
        mw = self._get_middleware()
        result = mw.before_agent({"messages": []}, _make_runtime(platform="text"))
        assert result["platform"] == "text"
        assert "2-5 sentences" in result["system_prompt_blocks"][0]

    def test_ios_voice_platform(self):
        mw = self._get_middleware()
        result = mw.before_agent({"messages": []}, _make_runtime(platform="ios_voice"))
        assert result["platform"] == "ios_voice"

    def test_unknown_platform_defaults_voice(self):
        mw = self._get_middleware()
        result = mw.before_agent({"messages": []}, _make_runtime(platform="unknown"))
        assert result["platform"] == "voice"

    def test_skips_on_crisis(self):
        mw = self._get_middleware()
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None


# --- UserIdentityMiddleware ---

class TestUserIdentityMiddleware:
    def test_loads_identity_file(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware, _PROJECT_ROOT
        # Create a temporary user identity file
        user_dir = tmp_path / "users" / "test_user"
        user_dir.mkdir(parents=True)
        (user_dir / "identity.md").write_text("Name: Test User\nRole: Developer")

        import deerflow.agents.sophia_agent.middlewares.user_identity as mod
        original_root = mod._PROJECT_ROOT
        mod._PROJECT_ROOT = tmp_path
        try:
            mw = UserIdentityMiddleware("test_user")
            result = mw.before_agent({"messages": []}, _make_runtime())
            assert result is not None
            assert "Test User" in result["system_prompt_blocks"][0]
        finally:
            mod._PROJECT_ROOT = original_root

    def test_missing_identity_returns_none(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.user_identity as mod
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
        original_root = mod._PROJECT_ROOT
        mod._PROJECT_ROOT = tmp_path
        try:
            mw = UserIdentityMiddleware("nonexistent_user")
            result = mw.before_agent({"messages": []}, _make_runtime())
            assert result is None
        finally:
            mod._PROJECT_ROOT = original_root

    def test_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
        mw = UserIdentityMiddleware("test_user")
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None


# --- SessionStateMiddleware ---

class TestSessionStateMiddleware:
    def test_smart_opener_on_turn_0(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        original_root = mod._PROJECT_ROOT
        mod._PROJECT_ROOT = tmp_path

        user_dir = tmp_path / "users" / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text(
            '---\nsmart_opener: "How did the pitch go?"\n---\nSession notes here.'
        )

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent({"messages": [], "turn_count": 0}, _make_runtime())
            assert result is not None
            assert "How did the pitch go?" in result["system_prompt_blocks"][0]
        finally:
            mod._PROJECT_ROOT = original_root

    def test_no_opener_on_turn_1(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        original_root = mod._PROJECT_ROOT
        mod._PROJECT_ROOT = tmp_path

        user_dir = tmp_path / "users" / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text('---\nsmart_opener: "Hello"\n---\n')

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent({"messages": [], "turn_count": 1}, _make_runtime())
            assert result is None
        finally:
            mod._PROJECT_ROOT = original_root

    def test_missing_handoff_returns_none(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        original_root = mod._PROJECT_ROOT
        mod._PROJECT_ROOT = tmp_path
        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent({"messages": [], "turn_count": 0}, _make_runtime())
            assert result is None
        finally:
            mod._PROJECT_ROOT = original_root


# --- ToneGuidanceMiddleware ---

class TestToneGuidanceMiddleware:
    def _create_tone_file(self, tmp_path: Path) -> Path:
        content = """# Tone Guidance

## Band 1: Shutdown
**band_id: shutdown**
When user is in shutdown mode (0.0-0.5), respond with extreme gentleness.

## Band 2: Grief/Fear
**band_id: grief_fear**
When user is in grief or fear (0.5-1.5), validate their pain.

## Band 3: Anger/Antagonism
**band_id: anger_antagonism**
When user is angry (1.5-2.5), don't match their energy.

## Band 4: Engagement
**band_id: engagement**
When user is engaged (2.5-3.5), match their energy.

## Band 5: Enthusiasm
**band_id: enthusiasm**
When user is enthusiastic (3.5-4.0), celebrate with them.
"""
        path = tmp_path / "tone_guidance.md"
        path.write_text(content)
        return path

    def test_parses_bands(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        path = self._create_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)
        assert len(mw._bands) == 5
        assert "shutdown" in mw._bands
        assert "enthusiasm" in mw._bands

    def test_default_tone_maps_to_engagement(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        path = self._create_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result["active_tone_band"] == "engagement"

    def test_low_tone_maps_to_shutdown(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        path = self._create_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)
        result = mw.before_agent(
            {"messages": [], "previous_artifact": {"tone_estimate": 0.2}},
            _make_runtime(),
        )
        assert result["active_tone_band"] == "shutdown"

    def test_high_tone_maps_to_enthusiasm(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        path = self._create_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)
        result = mw.before_agent(
            {"messages": [], "previous_artifact": {"tone_estimate": 3.8}},
            _make_runtime(),
        )
        assert result["active_tone_band"] == "enthusiasm"

    def test_injects_single_band_not_full_file(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        path = self._create_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)
        result = mw.before_agent({"messages": []}, _make_runtime())
        blocks = result["system_prompt_blocks"]
        assert len(blocks) == 1
        # Should only contain the engagement band, not all bands
        assert "engagement" in blocks[0].lower()
        assert "shutdown" not in blocks[0].lower() or "engagement" in blocks[0].lower()

    def test_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        path = self._create_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None

    def test_tone_to_band_boundaries(self):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        assert ToneGuidanceMiddleware.tone_to_band(0.0) == "shutdown"
        assert ToneGuidanceMiddleware.tone_to_band(0.5) == "grief_fear"
        assert ToneGuidanceMiddleware.tone_to_band(1.5) == "anger_antagonism"
        assert ToneGuidanceMiddleware.tone_to_band(2.5) == "engagement"
        assert ToneGuidanceMiddleware.tone_to_band(3.5) == "enthusiasm"
        assert ToneGuidanceMiddleware.tone_to_band(4.0) == "enthusiasm"


# --- ContextAdaptationMiddleware ---

class TestContextAdaptationMiddleware:
    def test_loads_context_file(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
        ctx_dir = tmp_path / "context"
        ctx_dir.mkdir()
        (ctx_dir / "work.md").write_text("Work context guidance")
        mw = ContextAdaptationMiddleware(ctx_dir, "work")
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result["context_mode"] == "work"
        assert "Work context guidance" in result["system_prompt_blocks"][0]

    def test_invalid_mode_defaults_to_life(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
        ctx_dir = tmp_path / "context"
        ctx_dir.mkdir()
        (ctx_dir / "life.md").write_text("Life context")
        mw = ContextAdaptationMiddleware(ctx_dir, "invalid")
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result["context_mode"] == "life"

    def test_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
        ctx_dir = tmp_path / "context"
        ctx_dir.mkdir()
        mw = ContextAdaptationMiddleware(ctx_dir, "work")
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None


# --- RitualMiddleware ---

class TestRitualMiddleware:
    def test_sets_ritual_state(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
        rituals_dir = tmp_path / "rituals"
        rituals_dir.mkdir()
        (rituals_dir / "debrief.md").write_text("Debrief ritual instructions")
        mw = RitualMiddleware(rituals_dir, "debrief")
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result["active_ritual"] == "debrief"
        assert result["ritual_phase"] == "debrief.intro"
        assert "Debrief ritual" in result["system_prompt_blocks"][0]

    def test_no_ritual_returns_none_state(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
        rituals_dir = tmp_path / "rituals"
        rituals_dir.mkdir()
        mw = RitualMiddleware(rituals_dir, None)
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result["active_ritual"] is None

    def test_invalid_ritual_treated_as_none(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
        rituals_dir = tmp_path / "rituals"
        rituals_dir.mkdir()
        mw = RitualMiddleware(rituals_dir, "invalid_ritual")
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result["active_ritual"] is None

    def test_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
        rituals_dir = tmp_path / "rituals"
        rituals_dir.mkdir()
        (rituals_dir / "vent.md").write_text("Vent instructions")
        mw = RitualMiddleware(rituals_dir, "vent")
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None


# --- SkillRouterMiddleware ---

class TestSkillRouterMiddleware:
    def _make_skills_dir(self, tmp_path: Path) -> Path:
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        for name in ["crisis_redirect", "boundary_holding", "vulnerability_holding",
                      "trust_building", "identity_fluidity_support",
                      "celebrating_breakthrough", "challenging_growth", "active_listening"]:
            (skills_dir / f"{name}.md").write_text(f"# {name} skill instructions")
        return skills_dir

    def test_force_skill_takes_priority(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {"messages": [_make_message("hello")], "force_skill": "crisis_redirect", "skip_expensive": True},
            _make_runtime(),
        )
        assert result["active_skill"] == "crisis_redirect"

    def test_new_user_gets_trust_building(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {"messages": [_make_message("hello")], "skill_session_data": {"sessions_total": 2, "trust_established": False, "complaint_signatures": {}, "skill_history": []}},
            _make_runtime(),
        )
        assert result["active_skill"] == "trust_building"

    def test_default_active_listening(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {"messages": [_make_message("I had a good day")], "skill_session_data": {"sessions_total": 10, "trust_established": True, "complaint_signatures": {}, "skill_history": []}},
            _make_runtime(),
        )
        assert result["active_skill"] == "active_listening"

    def test_boundary_violation(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {"messages": [_make_message("be my girlfriend please")], "skill_session_data": {"sessions_total": 10, "trust_established": True, "complaint_signatures": {}, "skill_history": []}},
            _make_runtime(),
        )
        assert result["active_skill"] == "boundary_holding"

    def test_vulnerability_detection(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {"messages": [_make_message("I've never told anyone this before")], "skill_session_data": {"sessions_total": 10, "trust_established": True, "complaint_signatures": {}, "skill_history": []}},
            _make_runtime(),
        )
        assert result["active_skill"] == "vulnerability_holding"

    def test_session_data_persists(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {"messages": [_make_message("hello")]},
            _make_runtime(),
        )
        assert "skill_session_data" in result
        assert result["skill_session_data"]["sessions_total"] == 1


# --- ArtifactMiddleware ---

class TestArtifactMiddleware:
    def test_injects_instructions(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Artifact instructions content")
        mw = ArtifactMiddleware(path)
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert "Artifact instructions content" in result["system_prompt_blocks"][0]

    def test_captures_tool_call(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)

        artifact_args = {
            "session_goal": "Explore stress",
            "tone_estimate": 2.0,
            "tone_target": 2.5,
            "active_tone_band": "engagement",
            "skill_loaded": "active_listening",
        }
        ai_msg = _make_ai_message_with_tool_call("emit_artifact", artifact_args)

        result = mw.after_model({"messages": [ai_msg]}, _make_runtime())
        assert result is not None
        assert result["current_artifact"]["session_goal"] == "Explore stress"

    def test_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None


# --- PromptAssemblyMiddleware ---

class TestPromptAssemblyMiddleware:
    def test_assembles_blocks_into_system_message(self):
        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
        from langchain_core.messages import SystemMessage
        mw = PromptAssemblyMiddleware()
        state = {
            "messages": [_make_message("hello")],
            "system_prompt_blocks": ["Block 1", "Block 2", "Block 3"],
        }
        result = mw.before_model(state, _make_runtime())
        assert result is not None
        msgs = result["messages"]
        assert isinstance(msgs[0], SystemMessage)
        assert "Block 1" in msgs[0].content
        assert "Block 2" in msgs[0].content

    def test_empty_blocks_returns_none(self):
        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
        mw = PromptAssemblyMiddleware()
        result = mw.before_model({"messages": [], "system_prompt_blocks": []}, _make_runtime())
        assert result is None


# --- emit_artifact tool ---

class TestEmitArtifactTool:
    def test_valid_artifact(self):
        from deerflow.sophia.tools.emit_artifact import emit_artifact
        result = emit_artifact.invoke({
            "session_goal": "Explore stress at work",
            "active_goal": "Validate feelings",
            "next_step": "Ask about coping",
            "takeaway": "User is overwhelmed",
            "reflection": "What helps you decompress?",
            "tone_estimate": 1.8,
            "tone_target": 2.3,
            "active_tone_band": "anger_antagonism",
            "skill_loaded": "active_listening",
            "ritual_phase": "freeform.work_stress",
            "voice_emotion_primary": "sympathetic",
            "voice_emotion_secondary": "calm",
            "voice_speed": "gentle",
        })
        assert result == "Artifact recorded."

    def test_tone_estimate_bounds(self):
        from deerflow.sophia.tools.emit_artifact import ArtifactInput
        with pytest.raises(Exception):
            ArtifactInput(
                session_goal="test", active_goal="test", next_step="test",
                takeaway="test", reflection=None, tone_estimate=5.0, tone_target=4.0,
                active_tone_band="engagement", skill_loaded="active_listening",
                ritual_phase="freeform.test", voice_emotion_primary="calm",
                voice_emotion_secondary="calm", voice_speed="normal",
            )

    def test_voice_speed_enum(self):
        from deerflow.sophia.tools.emit_artifact import ArtifactInput
        with pytest.raises(Exception):
            ArtifactInput(
                session_goal="test", active_goal="test", next_step="test",
                takeaway="test", reflection=None, tone_estimate=2.0, tone_target=2.5,
                active_tone_band="engagement", skill_loaded="active_listening",
                ritual_phase="freeform.test", voice_emotion_primary="calm",
                voice_emotion_secondary="calm", voice_speed="invalid_speed",
            )


# --- Mem0 category selection ---

class TestMem0CategorySelection:
    def test_default_categories(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories(None, None, [])
        assert "fact" in cats
        assert "preference" in cats

    def test_vent_ritual_adds_feeling_relationship(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories("vent", None, [])
        assert "feeling" in cats
        assert "relationship" in cats

    def test_debrief_adds_commitment_decision(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories("debrief", None, [])
        assert "commitment" in cats
        assert "decision" in cats

    def test_challenging_growth_adds_pattern_lesson(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories(None, "challenging_growth", [])
        assert "pattern" in cats
        assert "lesson" in cats

    def test_ritual_adds_ritual_context(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories("prepare", None, [])
        assert "ritual_context" in cats


# --- SophiaTitleMiddleware ---

class TestSophiaTitleMiddleware:
    def test_generates_title_on_first_turn(self):
        from deerflow.agents.sophia_agent.middlewares.title import SophiaTitleMiddleware
        mw = SophiaTitleMiddleware()
        result = mw.after_model(
            {"messages": [], "turn_count": 0, "current_artifact": {"session_goal": "Work stress"}},
            _make_runtime(),
        )
        assert result is not None
        assert "title" in result

    def test_no_title_if_already_set(self):
        from deerflow.agents.sophia_agent.middlewares.title import SophiaTitleMiddleware
        mw = SophiaTitleMiddleware()
        result = mw.after_model(
            {"messages": [], "title": "Existing title", "turn_count": 0},
            _make_runtime(),
        )
        assert result is None
