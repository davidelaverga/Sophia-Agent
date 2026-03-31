"""Tests for all Sophia middleware components."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

# --- User ID validation and path traversal ---

class TestUserIdValidation:
    def test_valid_user_id(self):
        from deerflow.agents.sophia_agent.utils import validate_user_id
        assert validate_user_id("user_123") == "user_123"
        assert validate_user_id("test-user") == "test-user"
        assert validate_user_id("ABC") == "ABC"

    def test_empty_user_id_rejected(self):
        from deerflow.agents.sophia_agent.utils import validate_user_id
        with pytest.raises(ValueError):
            validate_user_id("")

    @pytest.mark.parametrize("malicious_id", [
        "../etc/passwd",
        "..\\windows\\system32",
        "valid_user/../../other",
        "user\x00hidden",
        "a" * 200,
        "user id with spaces",
        "user;rm -rf",
        "user$(whoami)",
    ])
    def test_malicious_user_id_rejected(self, malicious_id):
        from deerflow.agents.sophia_agent.utils import validate_user_id
        with pytest.raises(ValueError):
            validate_user_id(malicious_id)

    def test_safe_user_path_valid(self, tmp_path):
        from deerflow.agents.sophia_agent.utils import safe_user_path
        users_dir = tmp_path / "users"
        users_dir.mkdir()
        result = safe_user_path(users_dir, "test_user", "identity.md")
        assert "test_user" in str(result)
        assert "identity.md" in str(result)

    def test_safe_user_path_traversal_rejected(self, tmp_path):
        from deerflow.agents.sophia_agent.utils import safe_user_path
        users_dir = tmp_path / "users"
        users_dir.mkdir()
        with pytest.raises(ValueError):
            safe_user_path(users_dir, "../etc", "passwd")


class TestExtractLastMessageText:
    def test_plain_string_content(self):
        from deerflow.agents.sophia_agent.utils import extract_last_message_text
        msg = MagicMock()
        msg.content = "Hello world"
        assert extract_last_message_text([msg]) == "Hello world"

    def test_multimodal_list_content(self):
        from deerflow.agents.sophia_agent.utils import extract_last_message_text
        msg = MagicMock()
        msg.content = [{"text": "Hello"}, {"text": "world"}]
        assert extract_last_message_text([msg]) == "Hello world"

    def test_empty_messages(self):
        from deerflow.agents.sophia_agent.utils import extract_last_message_text
        assert extract_last_message_text([]) == ""

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

    # --- Normalization unit tests ---

    def test_normalize_text(self):
        from deerflow.agents.sophia_agent.middlewares.crisis_check import _normalize_text
        assert _normalize_text("HELLO") == "hello"
        assert _normalize_text("dieee") == "die"
        assert _normalize_text("wannna") == "wana"
        assert _normalize_text("I... want!!! to---die???") == "i want todie"
        assert _normalize_text("  lots   of   spaces  ") == "lots of spaces"
        # 2 repeated chars should NOT be collapsed (only 3+)
        assert _normalize_text("wanna") == "wanna"

    # --- MUST_DETECT parametrized ---

    @pytest.mark.parametrize("text", [
        "I want to die",
        "I WANT TO DIE",
        "i wanna die",
        "kms",
        "I don't want to be alive",
        "better off dead",
        "honestly I just want to die sometimes",
        "been thinking about how to kill myself",
        "I wannna dieee",
    ])
    def test_must_detect(self, text):
        mw = self._get_middleware()
        state = {"messages": [_make_message(text)]}
        result = mw.before_agent(state, _make_runtime())
        assert result is not None, f"MUST_DETECT failed for: {text!r}"
        assert result["force_skill"] == "crisis_redirect"
        assert result["skip_expensive"] is True

    # --- MUST_NOT_DETECT parametrized ---

    @pytest.mark.parametrize("text", [
        "this traffic is killing me",
        "I'm dying of laughter",
        "that joke killed me",
        "I could die for some pizza right now",
        "the character dies in the movie",
    ])
    def test_must_not_detect(self, text):
        mw = self._get_middleware()
        state = {"messages": [_make_message(text)]}
        result = mw.before_agent(state, _make_runtime())
        assert result is None, f"MUST_NOT_DETECT failed for: {text!r}"


# --- FileInjectionMiddleware ---

class TestFileInjectionMiddleware:
    def _make_file(self, tmp_path: Path, name: str, content: str) -> Path:
        p = tmp_path / name
        p.write_text(content)
        return p

    def test_injects_file_content(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        path = self._make_file(tmp_path, "test.md", "# Test Content")
        mw = FileInjectionMiddleware((path, False))
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result is not None
        assert result["system_prompt_blocks"] == ["# Test Content"]

    def test_soul_md_injects_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        path = self._make_file(tmp_path, "soul.md", "Soul content")
        mw = FileInjectionMiddleware((path, False))
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is not None
        assert "Soul content" in result["system_prompt_blocks"][0]

    def test_voice_md_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        path = self._make_file(tmp_path, "voice.md", "Voice content")
        mw = FileInjectionMiddleware((path, True))
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None

    def test_multiple_files(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        soul = self._make_file(tmp_path, "soul.md", "Soul")
        voice = self._make_file(tmp_path, "voice.md", "Voice")
        mw = FileInjectionMiddleware((soul, False), (voice, True))
        # Normal turn: both injected
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result["system_prompt_blocks"] == ["Soul", "Voice"]
        # Crisis: only soul injected
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result["system_prompt_blocks"] == ["Soul"]

    def test_missing_file_raises_at_init(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        with pytest.raises(FileNotFoundError):
            FileInjectionMiddleware((tmp_path / "nonexistent.md", False))


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
        import deerflow.agents.sophia_agent.middlewares.user_identity as mod
        import deerflow.agents.sophia_agent.paths as paths
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware

        # Create a temporary user identity file
        user_dir = tmp_path / "test_user"
        user_dir.mkdir(parents=True)
        (user_dir / "identity.md").write_text("Name: Test User\nRole: Developer")

        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path
        try:
            mw = UserIdentityMiddleware("test_user")
            result = mw.before_agent({"messages": []}, _make_runtime())
            assert result is not None
            assert "Test User" in result["system_prompt_blocks"][0]
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_missing_identity_returns_none(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.user_identity as mod
        import deerflow.agents.sophia_agent.paths as paths
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware

        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path
        try:
            mw = UserIdentityMiddleware("nonexistent_user")
            result = mw.before_agent({"messages": []}, _make_runtime())
            assert result is None
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_skips_on_crisis(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
        mw = UserIdentityMiddleware("test_user")
        result = mw.before_agent({"messages": [], "skip_expensive": True}, _make_runtime())
        assert result is None


# --- SessionStateMiddleware ---

class TestSessionStateMiddleware:
    def test_smart_opener_on_greeting(self, tmp_path):
        """Greeting message → opener delivered as first_turn_instruction."""
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        import deerflow.agents.sophia_agent.paths as paths

        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path

        user_dir = tmp_path / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text(
            '---\nsmart_opener: "How did the pitch go?"\n---\nSession notes here.'
        )

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent(
                {"messages": [_make_message("hey")], "turn_count": 0},
                _make_runtime(),
            )
            assert result is not None
            block = result["system_prompt_blocks"][0]
            assert "How did the pitch go?" in block
            assert "first_turn_instruction" in block
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_substantive_message_gets_context_not_instruction(self, tmp_path):
        """Real content on turn 0 → opener becomes context, not instruction."""
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        import deerflow.agents.sophia_agent.paths as paths

        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path

        user_dir = tmp_path / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text(
            '---\nsmart_opener: "How did the pitch go?"\n---\n'
        )

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent(
                {"messages": [_make_message("There is a new girl I like named Elisabeth")], "turn_count": 0},
                _make_runtime(),
            )
            assert result is not None
            block = result["system_prompt_blocks"][0]
            assert "session_context" in block
            assert "do NOT deliver it as a greeting" in block
            assert "How did the pitch go?" in block
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_no_opener_on_turn_1(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        import deerflow.agents.sophia_agent.paths as paths

        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path

        user_dir = tmp_path / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text('---\nsmart_opener: "Hello"\n---\n')

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent({"messages": [], "turn_count": 1}, _make_runtime())
            assert result is None
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_missing_handoff_returns_none(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        import deerflow.agents.sophia_agent.paths as paths

        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path
        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent({"messages": [], "turn_count": 0}, _make_runtime())
            assert result is None
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir


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

    def test_only_active_file_loaded(self, tmp_path):
        """Only the active context mode file should be loaded, not all 3."""
        from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
        ctx_dir = tmp_path / "context"
        ctx_dir.mkdir()
        (ctx_dir / "work.md").write_text("Work context")
        (ctx_dir / "gaming.md").write_text("Gaming context")
        (ctx_dir / "life.md").write_text("Life context")
        mw = ContextAdaptationMiddleware(ctx_dir, "work")
        # Should only have the work content, not a dict of all modes
        assert mw._content == "Work context"
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert "Work context" in result["system_prompt_blocks"][0]

    def test_missing_context_file_returns_mode_only(self, tmp_path):
        """Missing context file should log warning and return None from before_agent."""
        from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
        ctx_dir = tmp_path / "context"
        ctx_dir.mkdir()
        # No work.md file created
        mw = ContextAdaptationMiddleware(ctx_dir, "work")
        assert mw._content is None
        result = mw.before_agent({"messages": []}, _make_runtime())
        assert result == {"context_mode": "work"}

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

    def test_breakthrough_detection_with_tone_spike(self, tmp_path):
        """Tone spike >= 1.0 with insight language triggers celebrating_breakthrough."""
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {
                "messages": [_make_message("oh my god i just realized everything")],
                "previous_artifact": {"tone_estimate": 3.5},
                "skill_session_data": {
                    "sessions_total": 10,
                    "trust_established": True,
                    "complaint_signatures": {},
                    "skill_history": [],
                    "last_tone_estimate": 2.0,  # Previous turn was 2.0, now 3.5 = delta 1.5
                },
            },
            _make_runtime(),
        )
        assert result["active_skill"] == "celebrating_breakthrough"

    def test_breakthrough_not_triggered_without_spike(self, tmp_path):
        """Small tone change should not trigger breakthrough."""
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {
                "messages": [_make_message("i just realized something")],
                "previous_artifact": {"tone_estimate": 2.8},
                "skill_session_data": {
                    "sessions_total": 10,
                    "trust_established": True,
                    "complaint_signatures": {},
                    "skill_history": [],
                    "last_tone_estimate": 2.5,  # Delta 0.3, below threshold
                },
            },
            _make_runtime(),
        )
        assert result["active_skill"] != "celebrating_breakthrough"

    def test_last_tone_estimate_stored_in_session_data(self, tmp_path):
        """Verify last_tone_estimate is updated after each turn."""
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {
                "messages": [_make_message("hello")],
                "previous_artifact": {"tone_estimate": 3.2},
                "skill_session_data": {
                    "sessions_total": 10,
                    "trust_established": True,
                    "complaint_signatures": {},
                    "skill_history": [],
                },
            },
            _make_runtime(),
        )
        assert result["skill_session_data"]["last_tone_estimate"] == 3.2

    def test_session_data_persists(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {"messages": [_make_message("hello")]},
            _make_runtime(),
        )
        assert "skill_session_data" in result
        assert result["skill_session_data"]["sessions_total"] == 1

    def test_sessions_total_not_incremented_on_subsequent_turns(self, tmp_path):
        """sessions_total must only increment on turn_count == 0 (session start)."""
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        sd = {
            "sessions_total": 3,
            "trust_established": False,
            "complaint_signatures": {},
            "skill_history": [],
        }
        # turn_count > 0 — sessions_total must NOT change
        result = mw.before_agent(
            {"messages": [_make_message("hello")], "skill_session_data": sd, "turn_count": 1},
            _make_runtime(),
        )
        assert result["skill_session_data"]["sessions_total"] == 3

    def test_sessions_total_increments_on_turn_zero(self, tmp_path):
        """sessions_total increments exactly once per session (turn_count == 0)."""
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        sd = {
            "sessions_total": 3,
            "trust_established": False,
            "complaint_signatures": {},
            "skill_history": [],
        }
        result = mw.before_agent(
            {"messages": [_make_message("hello")], "skill_session_data": sd, "turn_count": 0},
            _make_runtime(),
        )
        assert result["skill_session_data"]["sessions_total"] == 4

    def test_trust_established_visible_to_select_skill_same_turn(self, tmp_path):
        """trust_established updated in before_agent must be visible to _select_skill on the same turn."""
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        # sessions_total is 4 in state. turn_count == 0 increments it to 5,
        # which should set trust_established = True (threshold is 5).
        # With trust, a benign message should get active_listening, not trust_building.
        sd = {
            "sessions_total": 4,
            "trust_established": False,
            "complaint_signatures": {},
            "skill_history": [],
        }
        result = mw.before_agent(
            {
                "messages": [_make_message("I had a good day")],
                "skill_session_data": sd,
                "turn_count": 0,
            },
            _make_runtime(),
        )
        assert result["skill_session_data"]["trust_established"] is True
        assert result["active_skill"] == "active_listening"

    def test_breakthrough_detection_with_passed_session_data(self, tmp_path):
        """Breakthrough detection works with session_data passed to _select_skill."""
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        mw = SkillRouterMiddleware(self._make_skills_dir(tmp_path))
        result = mw.before_agent(
            {
                "messages": [_make_message("oh my god i just realized everything")],
                "previous_artifact": {"tone_estimate": 3.5},
                "turn_count": 1,
                "skill_session_data": {
                    "sessions_total": 10,
                    "trust_established": True,
                    "complaint_signatures": {},
                    "skill_history": [],
                    "last_tone_estimate": 2.0,
                },
            },
            _make_runtime(),
        )
        assert result["active_skill"] == "celebrating_breakthrough"


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

    def test_captures_artifact_with_tool_message_present(self, tmp_path):
        """after_model captures artifact from AIMessage even when ToolMessage is also in the list."""
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)

        artifact_args = {
            "session_goal": "Discuss project",
            "tone_estimate": 2.5,
            "tone_target": 3.0,
            "active_tone_band": "engagement",
            "skill_loaded": "active_listening",
        }
        ai_msg = _make_ai_message_with_tool_call("emit_artifact", artifact_args)

        # ToolMessage appears after AIMessage chronologically
        tool_msg = MagicMock()
        tool_msg.type = "tool"
        tool_msg.name = "emit_artifact"
        tool_msg.content = "Artifact recorded."

        # Messages in chronological order: AI first, then ToolMessage
        result = mw.after_model({"messages": [ai_msg, tool_msg]}, _make_runtime())
        assert result is not None
        assert result["current_artifact"]["session_goal"] == "Discuss project"
        assert result["current_artifact"]["tone_estimate"] == 2.5

    def test_previous_artifact_rotation(self, tmp_path):
        """previous_artifact is set to the old current_artifact when a new one is captured."""
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)

        old_artifact = {"session_goal": "Old goal", "tone_estimate": 1.5}
        new_args = {
            "session_goal": "New goal",
            "tone_estimate": 2.5,
            "tone_target": 3.0,
            "active_tone_band": "engagement",
            "skill_loaded": "active_listening",
        }
        ai_msg = _make_ai_message_with_tool_call("emit_artifact", new_args)

        result = mw.after_model(
            {"messages": [ai_msg], "current_artifact": old_artifact},
            _make_runtime(),
        )
        assert result is not None
        assert result["previous_artifact"] == old_artifact
        assert result["current_artifact"]["session_goal"] == "New goal"

    def test_after_model_returns_none_without_emit_artifact(self, tmp_path):
        """after_model returns None when no emit_artifact tool_call exists."""
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)

        # AI message with a different tool call
        ai_msg = MagicMock()
        ai_msg.type = "ai"
        ai_msg.content = "Some response"
        ai_msg.tool_calls = [{"name": "retrieve_memories", "args": {"query": "test"}}]

        result = mw.after_model({"messages": [ai_msg]}, _make_runtime())
        assert result is None


# --- PromptAssemblyMiddleware ---

class TestPromptAssemblyMiddleware:
    def test_assembles_blocks_into_system_message(self):
        from langchain_core.messages import SystemMessage

        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware

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


# --- retrieve_memories tool ---

class TestRetrieveMemoriesTool:
    def test_tool_uses_bound_user_id(self):
        from unittest.mock import patch

        from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool

        tool = make_retrieve_memories_tool("user_A")
        # Patch at mem0_client module level since import is deferred inside the closure
        with patch("deerflow.sophia.mem0_client.search_memories") as mock_search:
            mock_search.return_value = [{"content": "test memory", "id": "m1"}]
            result = tool.invoke({"query": "test query"})
            mock_search.assert_called_once_with(
                user_id="user_A",
                query="test query",
                categories=[],
            )
            assert "test memory" in result

    def test_different_user_ids_produce_different_tools(self):
        from unittest.mock import patch

        from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool

        tool_a = make_retrieve_memories_tool("user_A")
        tool_b = make_retrieve_memories_tool("user_B")

        with patch("deerflow.sophia.mem0_client.search_memories", return_value=[]) as mock_search:
            tool_a.invoke({"query": "q"})
            mock_search.assert_called_with(user_id="user_A", query="q", categories=[])

            mock_search.reset_mock()
            tool_b.invoke({"query": "q"})
            mock_search.assert_called_with(user_id="user_B", query="q", categories=[])

    def test_no_results_returns_message(self):
        from unittest.mock import patch

        from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool

        tool = make_retrieve_memories_tool("user_test")
        with patch("deerflow.sophia.mem0_client.search_memories", return_value=[]):
            result = tool.invoke({"query": "nothing"})
            assert result == "No relevant memories found."

    def test_exception_returns_unavailable(self):
        from unittest.mock import patch

        from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool

        tool = make_retrieve_memories_tool("user_test")
        with patch("deerflow.sophia.mem0_client.search_memories", side_effect=Exception("API error")):
            result = tool.invoke({"query": "test"})
            assert result == "Memory retrieval temporarily unavailable."


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

    def test_work_context_adds_work_categories(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories(None, None, [], context_mode="work")
        assert "project" in cats
        assert "colleague" in cats
        assert "career" in cats
        assert "deadline" in cats

    def test_gaming_context_adds_gaming_categories(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories(None, None, [], context_mode="gaming")
        assert "game" in cats
        assert "achievement" in cats
        assert "gaming_team" in cats
        assert "strategy" in cats

    def test_life_context_adds_life_categories(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories(None, None, [], context_mode="life")
        assert "family" in cats
        assert "health" in cats
        assert "personal_goal" in cats
        assert "life_event" in cats

    def test_no_context_mode_only_base_categories(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories(None, None, [])
        assert "project" not in cats
        assert "game" not in cats
        assert "family" not in cats

    def test_context_plus_ritual_combines_categories(self):
        from deerflow.agents.sophia_agent.middlewares.mem0_memory import _select_categories
        cats = _select_categories("debrief", None, [], context_mode="work")
        assert "project" in cats  # from work context
        assert "commitment" in cats  # from debrief ritual
        assert "decision" in cats  # from debrief ritual
        assert "fact" in cats  # always present


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
