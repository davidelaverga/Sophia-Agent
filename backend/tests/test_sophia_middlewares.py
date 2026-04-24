"""Tests for all Sophia middleware components."""

import json
import os
import tempfile
from pathlib import Path
from typing import get_type_hints
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
        msg.type = "human"
        assert extract_last_message_text([msg]) == "Hello world"

    def test_multimodal_list_content(self):
        from deerflow.agents.sophia_agent.utils import extract_last_message_text
        msg = MagicMock()
        msg.content = [{"text": "Hello"}, {"text": "world"}]
        msg.type = "human"
        assert extract_last_message_text([msg]) == "Hello world"

    def test_nested_content_dict(self):
        from deerflow.agents.sophia_agent.utils import extract_last_message_text
        msg = MagicMock()
        msg.type = "human"
        msg.content = [{"type": "text", "content": "Hello"}, {"value": "world"}]
        assert extract_last_message_text([msg]) == "Hello world"

    def test_prefers_latest_user_message(self):
        from deerflow.agents.sophia_agent.utils import extract_last_message_text

        user = MagicMock()
        user.type = "human"
        user.content = "Hey Sophia"

        trailing = MagicMock()
        trailing.type = "system"
        trailing.content = ""

        assert extract_last_message_text([user, trailing]) == "Hey Sophia"

    def test_empty_messages(self):
        from deerflow.agents.sophia_agent.utils import extract_last_message_text
        assert extract_last_message_text([]) == ""


class TestSophiaStateSchemas:
    def test_state_schemas_do_not_redeclare_messages_channel(self):
        from langchain.agents import AgentState

        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactState
        from deerflow.agents.sophia_agent.middlewares.session_state import SessionStateState
        from deerflow.agents.sophia_agent.middlewares.turn_count import TurnCountState

        agent_messages = get_type_hints(AgentState, include_extras=True)["messages"]

        assert get_type_hints(BuilderArtifactState, include_extras=True)["messages"] == agent_messages
        assert get_type_hints(SessionStateState, include_extras=True)["messages"] == agent_messages
        assert get_type_hints(TurnCountState, include_extras=True)["messages"] == agent_messages


class TestMessageCoercionMiddleware:
    def _get_middleware(self):
        from deerflow.agents.sophia_agent.middlewares.message_coercion import MessageCoercionMiddleware

        return MessageCoercionMiddleware()

    def test_coerces_role_content_dict_messages(self):
        from langchain_core.messages import HumanMessage

        mw = self._get_middleware()
        state = {"messages": [{"role": "user", "content": "Hey, Sofia. How are you?"}]}

        result = mw.before_agent(state, _make_runtime())

        assert result is not None
        assert len(result["messages"]) == 1
        assert isinstance(result["messages"][0], HumanMessage)
        assert result["messages"][0].content == "Hey, Sofia. How are you?"
        assert result["messages"][0].type == "human"

    def test_skips_already_typed_messages(self):
        from langchain_core.messages import HumanMessage

        mw = self._get_middleware()
        state = {"messages": [HumanMessage(content="hello")]}

        assert mw.before_agent(state, _make_runtime()) is None

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


def _make_ai_message_with_tool_call(tool_name: str, args: dict, tool_call_id: str = "call_test_1"):
    """Create a mock AI message with a tool call."""
    msg = MagicMock()
    msg.type = "ai"
    msg.content = "Some response text"
    msg.tool_calls = [{"name": tool_name, "args": args, "id": tool_call_id}]
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


# --- TurnCountMiddleware ---

class TestTurnCountMiddleware:
    def _get_middleware(self):
        from deerflow.agents.sophia_agent.middlewares.turn_count import TurnCountMiddleware
        return TurnCountMiddleware()

    def test_first_turn_reports_zero_completed_turns(self):
        mw = self._get_middleware()
        result = mw.before_agent({"messages": [_make_message("hello")]}, _make_runtime())
        assert result == {"turn_count": 0}

    def test_counts_prior_user_turns_from_history(self):
        mw = self._get_middleware()
        state = {
            "messages": [
                _make_message("hello"),
                _make_message("hi there", msg_type="ai"),
                _make_message("follow-up question"),
            ]
        }
        result = mw.before_agent(state, _make_runtime())
        assert result == {"turn_count": 1}

    def test_non_user_tail_still_counts_completed_user_turns(self):
        mw = self._get_middleware()
        state = {
            "messages": [
                _make_message("hello"),
                _make_message("hi there", msg_type="ai"),
                _make_message("artifact recorded", msg_type="tool"),
            ]
        }
        result = mw.before_agent(state, _make_runtime())
        assert result == {"turn_count": 1}


# --- UserIdentityMiddleware ---

class TestUserIdentityMiddleware:
    def test_loads_identity_file(self, tmp_path):
        import deerflow.agents.sophia_agent.paths as paths
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
        # Create a temporary user identity file
        user_dir = tmp_path / "test_user"
        user_dir.mkdir(parents=True)
        (user_dir / "identity.md").write_text("Name: Test User\nRole: Developer")

        import deerflow.agents.sophia_agent.middlewares.user_identity as mod
        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path
        try:
            mw = UserIdentityMiddleware("test_user")
            result = mw.before_agent({"messages": []}, _make_runtime())
            assert result is not None
            assert result["user_id"] == "test_user"
            assert "Test User" in result["system_prompt_blocks"][0]
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_missing_identity_still_caches_user_id(self, tmp_path):
        import deerflow.agents.sophia_agent.middlewares.user_identity as mod
        import deerflow.agents.sophia_agent.paths as paths
        from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path
        try:
            mw = UserIdentityMiddleware("nonexistent_user")
            result = mw.before_agent({"messages": []}, _make_runtime())
            assert result == {"user_id": "nonexistent_user"}
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

    def test_greeting_gets_first_turn_instruction(self, tmp_path):
        """Greeting on turn 0 with handoff file injects <first_turn_instruction>."""
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        import deerflow.agents.sophia_agent.paths as paths
        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path

        user_dir = tmp_path / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text(
            '---\nsmart_opener: "How did the pitch go?"\n---\nSome session notes.'
        )

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent(
                {"messages": [_make_message("hey")], "turn_count": 0},
                _make_runtime(),
            )
            assert result is not None
            blocks = result["system_prompt_blocks"]
            assert len(blocks) >= 1
            assert "<first_turn_instruction>" in blocks[0]
            assert "How did the pitch go?" in blocks[0]
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_substantive_message_gets_session_context(self, tmp_path):
        """Substantive user message on turn 0 injects <session_context>, not <first_turn_instruction>."""
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        import deerflow.agents.sophia_agent.paths as paths
        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path

        user_dir = tmp_path / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text(
            '---\nsmart_opener: "How did the pitch go?"\n---\nSome session notes.'
        )

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent(
                {"messages": [_make_message("I had a terrible day at work")], "turn_count": 0},
                _make_runtime(),
            )
            assert result is not None
            blocks = result["system_prompt_blocks"]
            assert len(blocks) >= 1
            assert "<session_context>" in blocks[0]
            assert "<first_turn_instruction>" not in blocks[0]
            assert "How did the pitch go?" in blocks[0]
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_no_handoff_file_no_error(self, tmp_path):
        """No handoff file on disk — middleware returns None gracefully."""
        import deerflow.agents.sophia_agent.middlewares.session_state as mod
        import deerflow.agents.sophia_agent.paths as paths
        original_users_dir = paths.USERS_DIR
        paths.USERS_DIR = tmp_path
        mod.USERS_DIR = tmp_path

        # Create the user dir but NOT the handoff file
        (tmp_path / "test_user").mkdir(parents=True)

        try:
            mw = mod.SessionStateMiddleware("test_user")
            result = mw.before_agent(
                {"messages": [_make_message("hey")], "turn_count": 0},
                _make_runtime(),
            )
            assert result is None
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    def test_not_turn_zero_skips(self, tmp_path):
        """turn_count=1 causes the middleware to skip entirely."""
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
                {"messages": [_make_message("hey")], "turn_count": 1},
                _make_runtime(),
            )
            assert result is None
        finally:
            paths.USERS_DIR = original_users_dir
            mod.USERS_DIR = original_users_dir

    @pytest.mark.parametrize("frontmatter,expected_opener", [
        ('smart_opener: "How did the pitch go?"', "How did the pitch go?"),
        ("smart_opener: 'How did the pitch go?'", "How did the pitch go?"),
        ("smart_opener: How did the pitch go?", "How did the pitch go?"),
    ])
    def test_opener_round_trip(self, tmp_path, frontmatter, expected_opener):
        """_extract_smart_opener handles double quotes, single quotes, and no quotes."""
        import deerflow.agents.sophia_agent.middlewares.session_state as mod

        handoff_content = f"---\n{frontmatter}\n---\nSession notes."
        opener = mod.SessionStateMiddleware.__new__(mod.SessionStateMiddleware)._extract_smart_opener(handoff_content)
        assert opener == expected_opener


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

    def _create_structured_tone_file(self, tmp_path: Path) -> Path:
        content = """# Sophia - Tone Guidance

## The Rule
Meet the user where they are before you try to lift them.

## The 2.0 Line
Below 2.0, stay emotional. Above 2.0, reasoning can help.

## Section 2 - Operational Bands

### Band 1 - Shutdown
Stay extremely gentle.

### Band 2 - Grief/Fear
Validate the pain precisely.

### Band 3 - Anger/Antagonism
Name the pressure and give it direction.

### Band 4 - Engagement
Match pace and sharpen the next step.

### Band 5 - Enthusiasm
Celebrate with them first.

## Section 3 - Response Posture and Examples

### Band 1 - Pure Presence
Short and steady.

### Band 2 - Validate First
Specific validation, then one question.

### Band 3 - Think Alongside
Extend the thread without resolving it.

### Band 4 - Match and Push
Ask what matters most right now.

### Band 5 - Be There for the Moment
Witness the win before anything else.
"""
        path = tmp_path / "tone_guidance_structured.md"
        path.write_text(content)
        return path

    def test_parses_bands(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        path = self._create_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)
        assert len(mw._bands) == 5
        assert "shutdown" in mw._bands
        assert "enthusiasm" in mw._bands

    def test_parses_structured_skill_file(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware

        path = self._create_structured_tone_file(tmp_path)
        mw = ToneGuidanceMiddleware(path)

        assert len(mw._bands) == 5
        assert "Meet the user where they are" in mw._bands["engagement"]
        assert "Match and Push" in mw._bands["engagement"]
        assert "Stay extremely gentle" not in mw._bands["engagement"]

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

    def test_voice_platform_uses_compact_instructions(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware

        path = tmp_path / "artifact_instructions.md"
        path.write_text("ORIGINAL_ARTIFACT_SENTINEL")
        mw = ArtifactMiddleware(path)

        result = mw.before_agent({"messages": [], "platform": "voice"}, _make_runtime(platform="voice"))
        block = result["system_prompt_blocks"][0]
        assert "ORIGINAL_ARTIFACT_SENTINEL" not in block
        assert "emit_artifact" in block
        assert "tone_target" in block

    def test_text_platform_keeps_original_instructions(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware

        path = tmp_path / "artifact_instructions.md"
        path.write_text("ORIGINAL_ARTIFACT_SENTINEL")
        mw = ArtifactMiddleware(path)

        result = mw.before_agent({"messages": [], "platform": "text"}, _make_runtime(platform="text"))
        assert "ORIGINAL_ARTIFACT_SENTINEL" in result["system_prompt_blocks"][0]

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
        assert result["jump_to"] == "end"

    def test_captures_tool_call_emits_tool_message(self, tmp_path):
        """after_model must close the emit_artifact tool_call with a ToolMessage so
        that resumed sessions don't accumulate dangling tool_calls across turns."""
        from langchain_core.messages import ToolMessage

        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)

        ai_msg = _make_ai_message_with_tool_call(
            "emit_artifact",
            {"session_goal": "Goal", "tone_estimate": 2.0},
            tool_call_id="call_artifact_abc",
        )

        result = mw.after_model({"messages": [ai_msg]}, _make_runtime())

        assert result is not None
        tool_msgs = result.get("messages") or []
        assert len(tool_msgs) == 1
        assert isinstance(tool_msgs[0], ToolMessage)
        assert tool_msgs[0].tool_call_id == "call_artifact_abc"
        assert tool_msgs[0].name == "emit_artifact"

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
        assert result["jump_to"] == "end"

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
        assert result["jump_to"] == "end"

    def test_after_model_persists_builder_handoff_from_tool_message(self, tmp_path):
        from langchain_core.messages import ToolMessage

        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)

        builder_result = {
            "artifact_path": "outputs/the-dangers-of-war.md",
            "artifact_type": "document",
            "artifact_title": "One-Page Document: The Dangers of War",
            "steps_completed": 3,
            "decisions_made": ["Used default audience and tone"],
            "companion_summary": "Created the requested one-page document about the dangers of war.",
            "companion_tone_hint": "Confident",
            "confidence": 0.86,
            "user_next_action": "Open or download the document and tell me what to revise next.",
        }
        tool_msg = ToolMessage(
            content=(
                "Builder completed successfully.\n"
                "Title: One-Page Document: The Dangers of War\n"
                "Summary: Created the requested one-page document about the dangers of war.\n"
                f"Full result: {json.dumps(builder_result)}"
            ),
            tool_call_id="builder-direct-test",
            name="switch_to_builder",
            status="success",
        )
        ai_msg = _make_ai_message_with_tool_call(
            "emit_artifact",
            {
                "session_goal": "Create a document about the dangers of war",
                "tone_estimate": 3.2,
                "tone_target": 3.5,
                "active_tone_band": "engagement",
                "skill_loaded": "builder_handoff",
            },
        )

        result = mw.after_model({"messages": [tool_msg, ai_msg]}, _make_runtime())

        assert result is not None
        assert result["builder_result"]["artifact_path"] == "outputs/the-dangers-of-war.md"
        assert result["builder_task"]["status"] == "synthesized"
        assert result["current_artifact"]["session_goal"] == "Create a document about the dangers of war"
        assert result["jump_to"] == "end"

    def test_after_model_does_not_end_on_mixed_tool_calls(self, tmp_path):
        """after_model leaves the loop alone when emit_artifact is mixed with other tools."""
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        path = tmp_path / "artifact_instructions.md"
        path.write_text("Instructions")
        mw = ArtifactMiddleware(path)

        ai_msg = MagicMock()
        ai_msg.type = "ai"
        ai_msg.content = "Some response"
        ai_msg.tool_calls = [
            {"name": "emit_artifact", "args": {"session_goal": "Goal", "tone_estimate": 2.0}},
            {"name": "retrieve_memories", "args": {"query": "goal"}},
        ]

        result = mw.after_model({"messages": [ai_msg]}, _make_runtime())
        assert result is None

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
    def _make_model_request(self, messages, state):
        """Create a mock ModelRequest for wrap_model_call testing."""
        def _build_request(current_messages):
            new_req = MagicMock()
            new_req.messages = current_messages
            new_req.state = state

            def _override(**kwargs):
                return _build_request(kwargs.get("messages", current_messages))

            new_req.override = _override
            return new_req

        return _build_request(messages)

    def test_assembles_blocks_into_system_message(self):
        from langchain_core.messages import HumanMessage, SystemMessage

        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
        mw = PromptAssemblyMiddleware()

        human_msg = HumanMessage(content="hello")
        state = {
            "messages": [human_msg],
            "system_prompt_blocks": ["Block 1", "Block 2", "Block 3"],
        }
        request = self._make_model_request([human_msg], state)

        # Track what the handler receives
        captured = {}
        def handler(req):
            captured["messages"] = req.messages
            return MagicMock()

        mw.wrap_model_call(request, handler)

        assert "messages" in captured
        msgs = captured["messages"]
        # First message should be the assembled system message
        assert isinstance(msgs[0], SystemMessage)
        assert "Block 1" in msgs[0].content
        assert "Block 2" in msgs[0].content
        assert "Block 3" in msgs[0].content
        # Human message should be preserved
        assert len(msgs) == 2
        assert msgs[1].content == "hello"

    def test_empty_blocks_passes_through(self):
        from langchain_core.messages import HumanMessage

        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
        mw = PromptAssemblyMiddleware()

        human_msg = HumanMessage(content="hello")
        state = {"messages": [human_msg], "system_prompt_blocks": []}
        request = self._make_model_request([human_msg], state)

        # Handler should receive the original request (unmodified)
        captured = {}
        def handler(req):
            captured["request"] = req
            return MagicMock()

        mw.wrap_model_call(request, handler)
        # Original request passed through (no override)
        assert captured["request"] is request

    def test_removes_old_system_messages(self):
        from langchain_core.messages import HumanMessage, SystemMessage

        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
        mw = PromptAssemblyMiddleware()

        old_sys = SystemMessage(content="old system", id="old-sys")
        human_msg = HumanMessage(content="hello")
        state = {
            "messages": [old_sys, human_msg],
            "system_prompt_blocks": ["New block"],
        }
        request = self._make_model_request([old_sys, human_msg], state)

        captured = {}
        def handler(req):
            captured["messages"] = req.messages
            return MagicMock()

        mw.wrap_model_call(request, handler)

        msgs = captured["messages"]
        # Only the new system message + human message
        assert len(msgs) == 2
        assert isinstance(msgs[0], SystemMessage)
        assert "New block" in msgs[0].content
        assert "old system" not in msgs[0].content
        assert msgs[1].content == "hello"

    def test_patches_interrupted_switch_to_builder_call_before_model(self):
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
        mw = PromptAssemblyMiddleware()

        ai_msg = AIMessage(
            content="",
            tool_calls=[{
                "name": "switch_to_builder",
                "id": "builder-direct-1",
                "args": {"task": "Create a document", "task_type": "document"},
            }],
        )
        human_msg = HumanMessage(content="Actually, summarize it instead.")
        state = {
            "messages": [ai_msg, human_msg],
            "system_prompt_blocks": ["Block 1"],
        }
        request = self._make_model_request([ai_msg, human_msg], state)

        captured = {}

        def handler(req):
            captured["messages"] = req.messages
            return MagicMock()

        mw.wrap_model_call(request, handler)

        msgs = captured["messages"]
        assert isinstance(msgs[0], SystemMessage)
        assert msgs[1] is ai_msg
        assert isinstance(msgs[2], ToolMessage)
        assert msgs[2].tool_call_id == "builder-direct-1"
        assert msgs[2].status == "error"
        assert "interrupted" in msgs[2].content
        assert msgs[3] is human_msg

    def test_patches_dangling_tool_calls_even_without_blocks(self):
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
        mw = PromptAssemblyMiddleware()

        ai_msg = AIMessage(
            content="",
            tool_calls=[{
                "name": "switch_to_builder",
                "id": "builder-direct-2",
                "args": {"task": "Create a document", "task_type": "document"},
            }],
        )
        human_msg = HumanMessage(content="Please keep going.")
        state = {
            "messages": [ai_msg, human_msg],
            "system_prompt_blocks": [],
        }
        request = self._make_model_request([ai_msg, human_msg], state)

        captured = {}

        def handler(req):
            captured["messages"] = req.messages
            return MagicMock()

        mw.wrap_model_call(request, handler)

        msgs = captured["messages"]
        assert msgs[0] is ai_msg
        assert isinstance(msgs[1], ToolMessage)
        assert msgs[1].tool_call_id == "builder-direct-2"
        assert msgs[2] is human_msg


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

    def test_work_context_sorts_work_memories_first(self):
        from unittest.mock import patch

        from deerflow.sophia.mem0_client import _cache, search_memories

        _cache.clear()

        mock_client = MagicMock()
        mock_client.search.return_value = {
            "results": [
                {"id": "m1", "memory": "Loves RPGs", "metadata": {"category": "game"}},
                {"id": "m2", "memory": "Project deadline Friday", "metadata": {"category": "deadline"}},
                {"id": "m3", "memory": "Sister birthday next week", "metadata": {"category": "family"}},
                {"id": "m4", "memory": "Works with Alice", "metadata": {"category": "colleague"}},
                {"id": "m5", "memory": "Prefers morning calls", "metadata": {"category": "preference"}},
            ],
        }

        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            results = search_memories("user1", "test query", context_mode="work")

        # Work categories (deadline, colleague) must appear before non-work (game, family, preference)
        work_cats = {"project", "colleague", "career", "deadline", "commitment", "decision"}
        first_non_work_idx = None
        for i, m in enumerate(results):
            if m["category"] not in work_cats and first_non_work_idx is None:
                first_non_work_idx = i
            if m["category"] in work_cats and first_non_work_idx is not None:
                pytest.fail(f"Work memory '{m['content']}' at index {i} appeared after non-work memory at index {first_non_work_idx}")

    def test_gaming_context_sorts_gaming_memories_first(self):
        from unittest.mock import patch

        from deerflow.sophia.mem0_client import _cache, search_memories

        _cache.clear()

        mock_client = MagicMock()
        mock_client.search.return_value = {
            "results": [
                {"id": "m1", "memory": "Project deadline Friday", "metadata": {"category": "deadline"}},
                {"id": "m2", "memory": "Beat final boss", "metadata": {"category": "achievement"}},
                {"id": "m3", "memory": "Plays with TeamX", "metadata": {"category": "gaming_team"}},
                {"id": "m4", "memory": "Sister birthday", "metadata": {"category": "family"}},
                {"id": "m5", "memory": "Likes strategy games", "metadata": {"category": "strategy"}},
            ],
        }

        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            results = search_memories("user1", "test query", context_mode="gaming")

        gaming_cats = {"game", "achievement", "gaming_team", "strategy"}
        first_non_gaming_idx = None
        for i, m in enumerate(results):
            if m["category"] not in gaming_cats and first_non_gaming_idx is None:
                first_non_gaming_idx = i
            if m["category"] in gaming_cats and first_non_gaming_idx is not None:
                pytest.fail(f"Gaming memory '{m['content']}' at index {i} appeared after non-gaming memory at index {first_non_gaming_idx}")

    def test_no_context_mode_preserves_original_order(self):
        from unittest.mock import patch

        from deerflow.sophia.mem0_client import _cache, search_memories

        _cache.clear()

        mock_client = MagicMock()
        mock_client.search.return_value = {
            "results": [
                {"id": "m1", "memory": "Loves RPGs", "metadata": {"category": "game"}},
                {"id": "m2", "memory": "Project deadline Friday", "metadata": {"category": "deadline"}},
                {"id": "m3", "memory": "Sister birthday", "metadata": {"category": "family"}},
            ],
        }

        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            results = search_memories("user1", "test query no ctx")

        # Without context_mode, original order should be preserved
        assert results[0]["id"] == "m1"
        assert results[1]["id"] == "m2"
        assert results[2]["id"] == "m3"

    def test_cross_context_memories_still_returned(self):
        from unittest.mock import patch

        from deerflow.sophia.mem0_client import _cache, search_memories

        _cache.clear()

        mock_client = MagicMock()
        mock_client.search.return_value = {
            "results": [
                {"id": "m1", "memory": "Loves RPGs", "metadata": {"category": "game"}},
                {"id": "m2", "memory": "Project deadline Friday", "metadata": {"category": "deadline"}},
                {"id": "m3", "memory": "Sister birthday", "metadata": {"category": "family"}},
            ],
        }

        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            results = search_memories("user1", "cross ctx query", context_mode="work")

        # All memories should still be present (not excluded)
        result_ids = [m["id"] for m in results]
        assert "m1" in result_ids  # gaming memory still present in work context
        assert "m2" in result_ids  # work memory present
        assert "m3" in result_ids  # life memory still present in work context
        # But work memory should be first
        assert results[0]["category"] == "deadline"


class TestMem0MemoryMiddleware:
    @pytest.fixture(autouse=True)
    def _reset_voice_fastcache(self):
        """Clear the module-level voice fastcache between tests so one test's
        stored entries don't leak into the next."""
        from deerflow.agents.sophia_agent.middlewares import mem0_memory

        mem0_memory._VOICE_FASTCACHE.clear()
        yield
        mem0_memory._VOICE_FASTCACHE.clear()

    def test_voice_uses_smaller_limit(self):
        from unittest.mock import patch

        from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

        mw = Mem0MemoryMiddleware("user-1")
        with patch(
            "deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories",
            return_value=[],
        ) as mock_search:
            mw.before_agent(
                {
                    "messages": [_make_message("tell me more about training")],
                    "platform": "voice",
                    "context_mode": "life",
                },
                _make_runtime(thread_id="thread-1", platform="voice"),
            )

        assert mock_search.call_args.kwargs["limit"] == 4

    def test_voice_reuses_recent_similar_results(self):
        from unittest.mock import patch

        from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

        results = [{"id": "m1", "content": "User likes physiology books", "category": "preference"}]
        mw = Mem0MemoryMiddleware("user-1")
        runtime = _make_runtime(thread_id="thread-1", platform="voice")

        with patch(
            "deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories",
            return_value=results,
        ) as mock_search:
            first = mw.before_agent(
                {
                    "messages": [_make_message("Any physiology books you recommend?")],
                    "platform": "voice",
                    "context_mode": "life",
                },
                runtime,
            )
            second = mw.before_agent(
                {
                    "messages": [_make_message("What other physiology books are good?")],
                    "platform": "voice",
                    "context_mode": "life",
                },
                runtime,
            )

        assert mock_search.call_count == 1
        assert first is not None
        assert second is not None
        assert "User likes physiology books" in second["system_prompt_blocks"][-1]

    def test_voice_reuses_recent_follow_up_results_without_overlap(self):
        from unittest.mock import patch

        from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

        results = [{"id": "m1", "content": "User is weighing long-term planning decisions", "category": "pattern"}]
        mw = Mem0MemoryMiddleware("user-1")
        runtime = _make_runtime(thread_id="thread-1", platform="voice")

        with patch(
            "deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories",
            return_value=results,
        ) as mock_search:
            mw.before_agent(
                {
                    "messages": [_make_message("Should I save first or start investing now?")],
                    "platform": "voice",
                    "context_mode": "life",
                    "turn_count": 0,
                },
                runtime,
            )
            second = mw.before_agent(
                {
                    "messages": [_make_message("Could you tell me more about that?")],
                    "platform": "voice",
                    "context_mode": "life",
                    "turn_count": 1,
                },
                runtime,
            )

        assert mock_search.call_count == 1
        assert second is not None
        assert "long-term planning" in second["system_prompt_blocks"][-1]

    def test_voice_does_not_reuse_dissimilar_results(self):
        from unittest.mock import patch

        from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

        results = [{"id": "m1", "content": "User likes physiology books", "category": "preference"}]
        mw = Mem0MemoryMiddleware("user-1")
        runtime = _make_runtime(thread_id="thread-1", platform="voice")

        with patch(
            "deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories",
            return_value=results,
        ) as mock_search:
            mw.before_agent(
                {
                    "messages": [_make_message("Any physiology books you recommend?")],
                    "platform": "voice",
                    "context_mode": "life",
                },
                runtime,
            )
            mw.before_agent(
                {
                    "messages": [_make_message("How is my work stress showing up lately?")],
                    "platform": "voice",
                    "context_mode": "life",
                },
                runtime,
            )

        assert mock_search.call_count == 2

    def test_blank_query_skips_search(self):
        from unittest.mock import patch

        from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

        mw = Mem0MemoryMiddleware("user-1")
        with patch(
            "deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories",
            return_value=[],
        ) as mock_search:
            result = mw.before_agent(
                {
                    "messages": [_make_message("   ")],
                    "platform": "voice",
                    "context_mode": "life",
                },
                _make_runtime(thread_id="thread-1", platform="voice"),
            )

        assert result is None
        mock_search.assert_not_called()

    def test_low_signal_voice_turn_skips_search_without_cache(self):
        from unittest.mock import patch

        from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

        mw = Mem0MemoryMiddleware("user-1")
        with patch(
            "deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories",
            return_value=[],
        ) as mock_search:
            result = mw.before_agent(
                {
                    "messages": [_make_message("Thanks, Sophia. That helps.")],
                    "platform": "voice",
                    "context_mode": "life",
                    "turn_count": 0,
                },
                _make_runtime(thread_id="thread-1", platform="voice"),
            )

        assert result is None
        mock_search.assert_not_called()

    def test_voice_warmup_user_skips_search(self):
        from unittest.mock import patch

        from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

        mw = Mem0MemoryMiddleware("__voice_warmup__")
        with patch(
            "deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories",
            return_value=[],
        ) as mock_search:
            result = mw.before_agent(
                {
                    "messages": [_make_message("Warmup ping. Reply with a short acknowledgment.")],
                    "platform": "voice",
                    "context_mode": "life",
                },
                _make_runtime(thread_id="thread-1", platform="voice"),
            )

        assert result is None
        mock_search.assert_not_called()


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


# --- emit_builder_artifact tool ---

class TestEmitBuilderArtifactTool:
    def test_valid_artifact(self):
        # Invoke emit_builder_artifact with valid input, verify returns JSON string
        from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact
        result = emit_builder_artifact.invoke({
            "artifact_path": "outputs/report.md",
            "artifact_type": "document",
            "artifact_title": "Business Case Report",
            "steps_completed": 5,
            "decisions_made": ["Used simple format", "Included ROI section"],
            "sources_used": [{"title": "Example", "url": "https://example.com"}],
            "companion_summary": "A clean business case document.",
            "companion_tone_hint": "Reassuring — user was stressed.",
            "confidence": 0.85,
        })
        parsed = json.loads(result)
        assert parsed["artifact_type"] == "document"
        assert parsed["confidence"] == 0.85
        assert parsed["sources_used"][0]["url"] == "https://example.com"

    def test_invalid_confidence_bounds(self):
        from deerflow.sophia.tools.emit_builder_artifact import BuilderArtifactInput
        with pytest.raises(Exception):
            BuilderArtifactInput(
                artifact_path="x", artifact_type="document", artifact_title="x",
                steps_completed=1, decisions_made=[], companion_summary="x",
                companion_tone_hint="x", confidence=1.5,  # out of bounds
            )


# --- BuilderTaskMiddleware ---

class TestBuilderTaskMiddleware:
    def test_injects_briefing_with_context(self):
        from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
        mw = BuilderTaskMiddleware()
        state = {
            "system_prompt_blocks": ["existing block"],
            "delegation_context": {
                "companion_artifact": {"tone_estimate": 1.2, "active_tone_band": "grief_fear", "session_goal": "Investor pitch"},
                "task_type": "presentation",
                "relevant_memories": ["Likes clean design"],
                "active_ritual": "prepare",
                "ritual_phase": "materials",
            },
        }
        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        blocks = result["system_prompt_blocks"]
        assert len(blocks) == 2  # existing + briefing
        assert "<builder_briefing>" in blocks[1]
        assert "relief" in blocks[1].lower()  # grief_fear tone guidance
        assert "armor" in blocks[1].lower()  # prepare ritual

    def test_no_context_returns_none(self):
        from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
        mw = BuilderTaskMiddleware()
        result = mw.before_agent({"system_prompt_blocks": []}, _make_runtime())
        assert result is None

    def test_tone_guidance_engagement(self):
        from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
        guidance = BuilderTaskMiddleware._tone_guidance(3.0, "engagement")
        assert "ambitious" in guidance.lower()

    def test_tone_guidance_shutdown(self):
        from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
        guidance = BuilderTaskMiddleware._tone_guidance(0.3, "shutdown")
        assert "simple" in guidance.lower()

    def test_adds_endgame_escalation_after_non_artifact_turns(self):
        from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware

        mw = BuilderTaskMiddleware()
        state = {
            "system_prompt_blocks": [],
            "builder_non_artifact_turns": 2,
            "builder_last_tool_names": ["bash", "write_file"],
            "delegation_context": {
                "companion_artifact": {"tone_estimate": 2.7, "active_tone_band": "engagement"},
                "task_type": "presentation",
                "relevant_memories": [],
                "active_ritual": None,
                "ritual_phase": None,
            },
        }

        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        briefing = result["system_prompt_blocks"][-1]
        assert "<builder_endgame>" in briefing
        assert "emit_builder_artifact" in briefing
        assert "bash, write_file" in briefing
        assert "/mnt/user-data/outputs/" in briefing
        assert "Do NOT use relative paths like outputs/report.md" in briefing

    def test_adds_research_citation_requirements(self):
        from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware

        mw = BuilderTaskMiddleware()
        state = {
            "system_prompt_blocks": [],
            "delegation_context": {
                "companion_artifact": {"tone_estimate": 2.7, "active_tone_band": "engagement"},
                "task_type": "research",
                "relevant_memories": [],
                "active_ritual": None,
                "ritual_phase": None,
                "allow_web_research": True,
            },
        }

        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        briefing = result["system_prompt_blocks"][-1]
        assert "[citation:Title](URL)" in briefing
        assert "Sources section" in briefing


class TestBuilderResearchPolicyMiddleware:
    def test_initializes_web_policy_state_and_prompt(self):
        from deerflow.agents.sophia_agent.middlewares.builder_research_policy import BuilderResearchPolicyMiddleware

        mw = BuilderResearchPolicyMiddleware()
        state = {
            "system_prompt_blocks": [],
            "delegation_context": {
                "task_type": "research",
                "allow_web_research": True,
                "explicit_user_urls": ["https://example.com/source"],
                "builder_web_budget": {"search_limit": 5, "fetch_limit": 8, "search_calls": 0, "fetch_calls": 0},
            },
        }

        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        assert result["allow_web_research"] is True
        assert result["explicit_user_urls"] == ["https://example.com/source"]
        assert result["builder_allowed_urls"] == ["https://example.com/source"]
        assert "Autonomous web research is enabled" in result["system_prompt_blocks"][-1]

    def test_disables_web_policy_for_non_browsing_task(self):
        from deerflow.agents.sophia_agent.middlewares.builder_research_policy import BuilderResearchPolicyMiddleware

        mw = BuilderResearchPolicyMiddleware()
        state = {
            "system_prompt_blocks": [],
            "delegation_context": {
                "task_type": "frontend",
                "allow_web_research": False,
                "explicit_user_urls": [],
            },
        }

        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        assert result["allow_web_research"] is False
        assert "External browsing is disabled" in result["system_prompt_blocks"][-1]


# --- BuilderArtifactMiddleware ---

class TestBuilderArtifactMiddleware:
    def test_captures_builder_artifact(self):
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        mw = BuilderArtifactMiddleware()
        # Create a mock AI message with emit_builder_artifact tool call
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [{"name": "emit_builder_artifact", "args": {
            "artifact_path": "outputs/doc.md",
            "artifact_type": "document",
            "confidence": 0.9,
        }}]
        state = {"messages": [msg]}
        result = mw.after_model(state, _make_runtime())
        assert result is not None
        assert result["builder_result"]["artifact_type"] == "document"
        assert result["builder_result"]["confidence"] == 0.9
        assert result["jump_to"] == "end"

    def test_fallback_on_no_tool_call(self):
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = []  # No tool calls — plain text ending
        state = {"messages": [msg]}
        result = mw.after_model(state, _make_runtime())
        assert result is not None
        assert result["builder_result"]["confidence"] == 0.3  # fallback

    def test_ignores_non_builder_tool_calls(self):
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [{"name": "bash", "args": {"command": "ls"}}]
        state = {"messages": [msg]}
        result = mw.after_model(state, _make_runtime())
        assert result is not None
        assert result["builder_non_artifact_turns"] == 1
        assert result["builder_last_tool_names"] == ["bash"]
        assert result["builder_tool_turn_summaries"][-1]["has_emit_builder_artifact"] is False

    def test_emit_resets_non_artifact_turn_counter(self):
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [{"name": "emit_builder_artifact", "args": {"artifact_type": "document", "confidence": 0.8}}]

        state = {"messages": [msg], "builder_non_artifact_turns": 3, "builder_tool_turn_summaries": []}
        result = mw.after_model(state, _make_runtime())

        assert result is not None
        assert result["builder_non_artifact_turns"] == 0
        assert result["builder_result"]["artifact_type"] == "document"

    def test_does_not_end_on_mixed_builder_tool_calls(self):
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [
            {"name": "emit_builder_artifact", "args": {"artifact_type": "document", "confidence": 0.9}},
            {"name": "bash", "args": {"command": "ls"}},
        ]
        state = {"messages": [msg]}
        result = mw.after_model(state, _make_runtime())
        assert result is None

    def test_builder_artifact_warns_at_turn_6(self, caplog):
        """PR-C F6: a soft warning is logged at the ``_SOFT_WARN_AT`` turn
        (6) so the builder (and ops watchers) get an early wrap-up signal
        before tool_choice forcing and the hard ceiling kick in."""
        import logging

        from deerflow.agents.sophia_agent.middlewares import builder_artifact as mod
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [{"name": "bash", "args": {"command": "ls"}}]
        # At turn 5 → after processing this non-artifact turn, counter = 6.
        state = {"messages": [msg], "builder_non_artifact_turns": 5}

        with caplog.at_level(logging.WARNING, logger=mod.logger.name):
            result = mw.after_model(state, _make_runtime())

        assert result is not None
        assert result["builder_non_artifact_turns"] == 6
        # builder_result should NOT be set yet — this is still a normal turn.
        assert "builder_result" not in result
        soft_warnings = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and "soft ceiling warning" in r.getMessage()
        ]
        assert soft_warnings, (
            f"Expected a soft-ceiling WARNING at turn 6. Got: "
            f"{[r.getMessage() for r in caplog.records]}"
        )
        # Warning is emitted exactly once (only at the soft-warn turn).
        assert len(soft_warnings) == 1

    def test_builder_artifact_does_not_warn_before_turn_6(self, caplog):
        """Ensure the soft warning does not fire on earlier or later turns."""
        import logging

        from deerflow.agents.sophia_agent.middlewares import builder_artifact as mod
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [{"name": "bash", "args": {"command": "ls"}}]
        # Turn 3 → next counter = 4 (no warning).
        state = {"messages": [msg], "builder_non_artifact_turns": 3}

        with caplog.at_level(logging.WARNING, logger=mod.logger.name):
            mw.after_model(state, _make_runtime())

        soft_warnings = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and "soft ceiling warning" in r.getMessage()
        ]
        assert not soft_warnings, (
            f"Did not expect a soft-ceiling WARNING before turn 6. Got: "
            f"{[r.getMessage() for r in caplog.records]}"
        )

    def test_builder_artifact_forces_at_turn_10(self):
        """PR-C F6: at the hard ceiling (10) the middleware force-ends the
        build with a fallback builder_result instead of letting the agent
        loop burn more turns. This is the final safety net."""
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [{"name": "bash", "args": {"command": "ls"}}]
        # Turn 9 → next counter = 10 → triggers hard ceiling.
        state = {"messages": [msg], "builder_non_artifact_turns": 9}

        result = mw.after_model(state, _make_runtime())
        assert result is not None
        # Hard ceiling must produce a builder_result and jump_to=end, even if
        # no file is on disk to promote.
        assert result.get("jump_to") == "end"
        assert "builder_result" in result
        builder_result = result["builder_result"]
        assert builder_result["steps_completed"] == 10
        # Without a promotable file, we get the explicit force-stop fallback.
        assert builder_result["artifact_title"] == "Build task force-stopped"
        assert builder_result["confidence"] == 0.2
        assert result["builder_non_artifact_turns"] == 0

    def test_builder_artifact_forces_tool_choice_near_ceiling(self):
        """PR-C F6: when within ``_FORCE_EMIT_REMAINING`` of the ceiling, the
        model call is forced to tool_choice=emit_builder_artifact. Verify
        via the static helper so we don't need a full model-call harness."""
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

        # ceiling=10, remaining=2 → force at turn >= 8.
        assert BuilderArtifactMiddleware._should_force_emit({"builder_non_artifact_turns": 7}) is False
        assert BuilderArtifactMiddleware._should_force_emit({"builder_non_artifact_turns": 8}) is True
        assert BuilderArtifactMiddleware._should_force_emit({"builder_non_artifact_turns": 9}) is True
        # Never force on turn 0 (guard against empty state resetting).
        assert BuilderArtifactMiddleware._should_force_emit({"builder_non_artifact_turns": 0}) is False

    def test_emit_accepted_when_file_on_disk(self, tmp_path):
        """PR-D: when the referenced artifact file exists on disk,
        emit_builder_artifact is accepted normally."""
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

        outputs_dir = tmp_path / "outputs"
        outputs_dir.mkdir()
        (outputs_dir / "report.md").write_text("# Report")

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [
            {
                "name": "emit_builder_artifact",
                "args": {
                    "artifact_path": "/mnt/user-data/outputs/report.md",
                    "artifact_type": "document",
                    "artifact_title": "Report",
                    "steps_completed": 3,
                    "decisions_made": [],
                    "companion_summary": "Done.",
                    "companion_tone_hint": "Neutral",
                    "confidence": 0.9,
                },
            },
        ]
        runtime = _make_runtime(thread_id="test-thread")
        state = {
            "messages": [msg],
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_tool_turn_summaries": [],
        }
        result = mw.after_model(state, runtime)

        assert result is not None
        assert result.get("builder_result") is not None
        assert result["builder_result"]["artifact_path"] == "/mnt/user-data/outputs/report.md"
        assert result.get("jump_to") == "end"
        assert result["builder_non_artifact_turns"] == 0

    def test_emit_accepted_when_file_in_supabase_only(self, monkeypatch, tmp_path):
        """PR-D: when the file is NOT on disk but IS in Supabase, the emit
        is still accepted (user can download from Supabase)."""
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        from deerflow.sophia.storage import supabase_artifact_store

        outputs_dir = tmp_path / "outputs"
        outputs_dir.mkdir()
        # File NOT on disk

        monkeypatch.setattr(
            supabase_artifact_store,
            "check_artifact_exists",
            lambda _tid, _fname: True,
        )

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [
            {
                "name": "emit_builder_artifact",
                "args": {
                    "artifact_path": "/mnt/user-data/outputs/report.md",
                    "artifact_type": "document",
                    "artifact_title": "Report",
                    "steps_completed": 3,
                    "decisions_made": [],
                    "companion_summary": "Done.",
                    "companion_tone_hint": "Neutral",
                    "confidence": 0.9,
                },
            },
        ]
        runtime = _make_runtime(thread_id="test-thread")
        state = {
            "messages": [msg],
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_tool_turn_summaries": [],
        }
        result = mw.after_model(state, runtime)

        assert result is not None
        assert result.get("builder_result") is not None
        assert result.get("jump_to") == "end"

    def test_emit_rejected_and_retry_when_file_missing(self, monkeypatch, tmp_path, caplog):
        """PR-D: when the referenced file is missing both locally and in
        Supabase, after_model rejects the emit (returns None) and
        wrap_tool_call routes back to the model for retry."""
        import logging

        from langgraph.prebuilt.tool_node import ToolCallRequest
        from langgraph.types import Command

        from deerflow.agents.sophia_agent.middlewares import builder_artifact as mod
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        from deerflow.sophia.storage import supabase_artifact_store

        outputs_dir = tmp_path / "outputs"
        outputs_dir.mkdir()
        # File NOT on disk

        monkeypatch.setattr(
            supabase_artifact_store,
            "check_artifact_exists",
            lambda _tid, _fname: False,
        )

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [
            {
                "name": "emit_builder_artifact",
                "args": {
                    "artifact_path": "/mnt/user-data/outputs/missing.md",
                    "artifact_type": "document",
                    "artifact_title": "Missing",
                    "steps_completed": 2,
                    "decisions_made": [],
                    "companion_summary": "Done.",
                    "companion_tone_hint": "Neutral",
                    "confidence": 0.5,
                },
            },
        ]
        runtime = _make_runtime(thread_id="test-thread")
        state = {
            "messages": [msg],
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_tool_turn_summaries": [],
        }

        with caplog.at_level(logging.WARNING, logger=mod.logger.name):
            after_result = mw.after_model(state, runtime)

        # after_model must reject the emit but STILL return a state update
        # (incremented counter) so the hard ceiling eventually triggers.
        assert after_result is not None
        assert after_result["builder_non_artifact_turns"] == 1
        assert after_result["builder_last_tool_names"] == ["emit_builder_artifact"]
        assert after_result["builder_tool_turn_summaries"][-1]["emit_rejected"] is True
        # builder_result must NOT be set, and no jump_to end
        assert "builder_result" not in after_result
        assert "jump_to" not in after_result
        warning_records = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and "emit rejected" in r.getMessage()
        ]
        assert warning_records, (
            f"Expected an 'emit rejected' WARNING. Got: "
            f"{[r.getMessage() for r in caplog.records]}"
        )

        # wrap_tool_call must return a Command routing back to model
        request = ToolCallRequest(
            tool_call={
                "id": "tc-emit-missing",
                "name": "emit_builder_artifact",
                "args": {
                    "artifact_path": "/mnt/user-data/outputs/missing.md",
                    "artifact_type": "document",
                    "artifact_title": "Missing",
                    "steps_completed": 2,
                    "decisions_made": [],
                    "companion_summary": "Done.",
                    "companion_tone_hint": "Neutral",
                    "confidence": 0.5,
                },
            },
            tool=None,
            state={"thread_data": {"outputs_path": str(outputs_dir)}, "messages": []},
            runtime=MagicMock(),
        )

        tool_result = mw.wrap_tool_call(request, lambda _req: None)  # type: ignore[return-value]
        assert isinstance(tool_result, Command)
        assert tool_result.goto == "model"
        assert "messages" in tool_result.update
        added_msg = tool_result.update["messages"][0]
        assert "does not exist" in added_msg.content
        assert added_msg.tool_call_id == "tc-emit-missing"

    def test_emit_rejection_increments_counter_to_avoid_forced_emit_trap(self, monkeypatch, tmp_path):
        """Codex fix (2026-04-24): when a forced emit is rejected because the
        file is missing, builder_non_artifact_turns MUST still be incremented.
        Otherwise the builder gets trapped: tool_choice forces emit → emit is
        rejected → counter never advances → tool_choice forces emit again →
        infinite loop. Incrementing lets the hard ceiling (10) trigger after a
        few retries and terminate the run."""
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        from deerflow.sophia.storage import supabase_artifact_store

        outputs_dir = tmp_path / "outputs"
        outputs_dir.mkdir()

        monkeypatch.setattr(
            supabase_artifact_store,
            "check_artifact_exists",
            lambda _tid, _fname: False,
        )

        mw = BuilderArtifactMiddleware()
        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [
            {
                "name": "emit_builder_artifact",
                "args": {
                    "artifact_path": "/mnt/user-data/outputs/missing.md",
                    "artifact_type": "document",
                    "artifact_title": "Missing",
                    "steps_completed": 2,
                    "decisions_made": [],
                    "companion_summary": "Done.",
                    "companion_tone_hint": "Neutral",
                    "confidence": 0.5,
                },
            },
        ]
        runtime = _make_runtime(thread_id="test-thread")
        state = {
            "messages": [msg],
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_non_artifact_turns": 4,
            "builder_tool_turn_summaries": [],
        }
        result = mw.after_model(state, runtime)

        # Rejection returns state update (not None) so the counter advances
        assert result is not None
        assert result["builder_non_artifact_turns"] == 5
        assert result["builder_last_tool_names"] == ["emit_builder_artifact"]
        assert result["builder_tool_turn_summaries"][-1]["emit_rejected"] is True
        # builder_result must NOT be set
        assert "builder_result" not in result
        assert "jump_to" not in result

    def test_rejected_emit_advances_to_hard_ceiling_and_terminates(self, monkeypatch, tmp_path):
        """Codex fix: simulate two consecutive rejected forced emits at turns
        8 and 9. The counter advances to 10 on the second rejection, so a
        subsequent non-emit turn triggers the hard ceiling fallback."""
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
        from deerflow.sophia.storage import supabase_artifact_store

        outputs_dir = tmp_path / "outputs"
        outputs_dir.mkdir()

        monkeypatch.setattr(
            supabase_artifact_store,
            "check_artifact_exists",
            lambda _tid, _fname: False,
        )

        mw = BuilderArtifactMiddleware()

        # Turn 8: forced emit, rejected → counter becomes 9
        msg1 = MagicMock()
        msg1.type = "ai"
        msg1.tool_calls = [
            {
                "name": "emit_builder_artifact",
                "args": {
                    "artifact_path": "/mnt/user-data/outputs/missing.md",
                    "artifact_type": "document",
                    "artifact_title": "Missing",
                    "steps_completed": 2,
                    "decisions_made": [],
                    "companion_summary": "Done.",
                    "companion_tone_hint": "Neutral",
                    "confidence": 0.5,
                },
            },
        ]
        runtime = _make_runtime(thread_id="test-thread")
        state = {
            "messages": [msg1],
            "thread_data": {"outputs_path": str(outputs_dir)},
            "builder_non_artifact_turns": 8,
            "builder_tool_turn_summaries": [],
        }
        result1 = mw.after_model(state, runtime)
        assert result1 is not None
        assert result1["builder_non_artifact_turns"] == 9
        assert result1["builder_tool_turn_summaries"][-1]["emit_rejected"] is True

        # Turn 9: forced emit again, rejected → counter becomes 10
        state["messages"] = [msg1]
        state["builder_non_artifact_turns"] = 9
        state["builder_tool_turn_summaries"] = result1["builder_tool_turn_summaries"]
        result2 = mw.after_model(state, runtime)
        assert result2 is not None
        assert result2["builder_non_artifact_turns"] == 10

        # Turn 10: a non-emit turn (e.g. bash) — hard ceiling triggers
        msg2 = MagicMock()
        msg2.type = "ai"
        msg2.tool_calls = [{"name": "bash", "args": {"command": "ls"}}]
        state["messages"] = [msg2]
        state["builder_non_artifact_turns"] = 10
        state["builder_tool_turn_summaries"] = result2["builder_tool_turn_summaries"]
        result3 = mw.after_model(state, runtime)
        assert result3 is not None
        assert result3.get("jump_to") == "end"
        assert "builder_result" in result3
        assert result3["builder_result"]["artifact_title"] == "Build task force-stopped"


# --- ArtifactMiddleware synthesis (builder handoff) ---

class TestArtifactMiddlewareSynthesis:
    def test_synthesis_injection(self):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        # Create with a mock instructions file
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Artifact Instructions\nTest instructions.")
            f.flush()
            mw = ArtifactMiddleware(Path(f.name))

        state = {
            "system_prompt_blocks": [],
            "builder_result": {
                "companion_summary": "A clean report.",
                "artifact_title": "Business Case",
                "artifact_type": "document",
                "decisions_made": ["Kept it simple"],
                "companion_tone_hint": "Reassuring",
            },
            "builder_task": {"status": "completed"},
            "active_tone_band": "engagement",
        }
        result = mw.before_agent(state, _make_runtime())
        assert result is not None
        # Should have injected synthesis block
        blocks_text = "\n".join(result["system_prompt_blocks"])
        assert "<builder_completed>" in blocks_text
        assert "A clean report." in blocks_text
        # builder_task status should be updated
        assert result["builder_task"]["status"] == "synthesized"
        os.unlink(f.name)

    def test_no_synthesis_when_already_synthesized(self):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Test")
            f.flush()
            mw = ArtifactMiddleware(Path(f.name))

        state = {
            "system_prompt_blocks": [],
            "builder_result": {"companion_summary": "Done."},
            "builder_task": {"status": "synthesized"},  # Already done
        }
        result = mw.before_agent(state, _make_runtime())
        # Should NOT inject synthesis (status is already "synthesized")
        blocks_text = "\n".join(result["system_prompt_blocks"])
        assert "<builder_completed>" not in blocks_text
        os.unlink(f.name)

    def test_synthesizes_when_builder_result_lacks_task_status(self):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware

        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Test")
            f.flush()
            mw = ArtifactMiddleware(Path(f.name))

        state = {
            "system_prompt_blocks": [],
            "builder_result": {
                "companion_summary": "Created the requested one-page document about the dangers of war.",
                "artifact_title": "One-Page Document: the dangers of war",
                "artifact_type": "document",
                "artifact_path": "outputs/the-dangers-of-war.md",
                "decisions_made": ["Used default audience and tone"],
                "companion_tone_hint": "Confident",
            },
            "builder_task": {},
            "active_tone_band": "engagement",
        }

        result = mw.before_agent(state, _make_runtime())

        assert result is not None
        assert result["builder_result"]["artifact_path"] == "outputs/the-dangers-of-war.md"
        assert result["builder_task"]["status"] == "synthesized"
        blocks_text = "\n".join(result["system_prompt_blocks"])
        assert "<builder_completed>" in blocks_text
        os.unlink(f.name)

    def test_recovers_builder_result_from_switch_to_builder_tool_message(self):
        from langchain_core.messages import ToolMessage

        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware

        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Test")
            f.flush()
            mw = ArtifactMiddleware(Path(f.name))

        builder_result = {
            "artifact_path": "outputs/dangers_of_war.md",
            "artifact_type": "document",
            "artifact_title": "The Dangers of War: A Personal Reflection",
            "steps_completed": 4,
            "decisions_made": ["Kept it reflective"],
            "companion_summary": "Created the document.",
            "companion_tone_hint": "Direct and serious.",
            "user_next_action": "Download it.",
            "confidence": 0.92,
        }
        tool_message = ToolMessage(
            content=(
                "Builder completed successfully.\n"
                "Title: The Dangers of War: A Personal Reflection\n"
                "Summary: Created the document.\n"
                f"Full result: {json.dumps(builder_result)}"
            ),
            tool_call_id="toolu_builder",
            name="switch_to_builder",
            status="success",
        )

        state = {
            "messages": [tool_message],
            "system_prompt_blocks": [],
            "active_tone_band": "engagement",
        }
        result = mw.before_agent(state, _make_runtime())

        assert result is not None
        assert result["builder_result"]["artifact_path"] == "outputs/dangers_of_war.md"
        assert result["builder_task"]["status"] == "synthesized"
        blocks_text = "\n".join(result["system_prompt_blocks"])
        assert "<builder_completed>" in blocks_text
        assert "Created the document." in blocks_text
        os.unlink(f.name)
