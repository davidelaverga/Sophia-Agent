"""Tests for handoffs.py and smart_opener.py — handoff generation and smart opener."""

import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_message(role: str, content: str) -> MagicMock:
    """Create a mock LangChain message."""
    msg = MagicMock()
    msg.type = role
    msg.content = content
    return msg


def _make_anthropic_response(text: str) -> MagicMock:
    """Create a mock Anthropic API response with a single text block."""
    block = MagicMock()
    block.text = text
    response = MagicMock()
    response.content = [block]
    return response


# ---------------------------------------------------------------------------
# Smart Opener Tests
# ---------------------------------------------------------------------------

class TestGenerateSmartOpener:
    """Tests for deerflow.sophia.smart_opener.generate_smart_opener."""

    def test_happy_path_returns_opener(self):
        """LLM produces a clean opener sentence."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        mock_response = _make_anthropic_response("The pitch is tomorrow. How are you feeling?")
        with patch("deerflow.sophia.smart_opener.anthropic") as mock_mod:
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response
            result = generate_smart_opener(
                user_id="user1",
                session_summary="User discussed investor pitch scheduled for tomorrow.",
                recent_memories="commitment: investor pitch on March 28",
                last_handoff=None,
                days_since_last_session=1,
            )

        assert result == "The pitch is tomorrow. How are you feeling?"

    def test_strips_surrounding_quotes(self):
        """LLM wraps opener in quotes -- they should be stripped."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        mock_response = _make_anthropic_response('"How are you doing today?"')
        with patch("deerflow.sophia.smart_opener.anthropic") as mock_mod:
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response
            result = generate_smart_opener(
                user_id="user1",
                session_summary="Low-energy session.",
            )

        assert result == "How are you doing today?"
        assert not result.startswith('"')
        assert not result.endswith('"')

    def test_strips_single_quotes(self):
        """LLM wraps opener in single quotes -- they should be stripped."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        mock_response = _make_anthropic_response("'Where are you at?'")
        with patch("deerflow.sophia.smart_opener.anthropic") as mock_mod:
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response
            result = generate_smart_opener(
                user_id="user1",
                session_summary="User absent for 5 days.",
            )

        assert result == "Where are you at?"

    def test_strips_whitespace(self):
        """LLM returns opener with extra whitespace."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        mock_response = _make_anthropic_response("  Something shifted last time.  \n")
        with patch("deerflow.sophia.smart_opener.anthropic") as mock_mod:
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response
            result = generate_smart_opener(
                user_id="user1",
                session_summary="Breakthrough session.",
            )

        assert result == "Something shifted last time."

    def test_empty_session_summary_returns_fallback(self):
        """Empty session summary should return fallback without calling LLM."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        result = generate_smart_opener(user_id="user1", session_summary="")
        assert result == "How are you doing today?"

    def test_anthropic_sdk_failure_returns_fallback(self):
        """SDK exception should return fallback opener gracefully."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        with patch("deerflow.sophia.smart_opener.anthropic") as mock_mod:
            mock_mod.Anthropic.return_value.messages.create.side_effect = RuntimeError("API down")
            result = generate_smart_opener(
                user_id="user1",
                session_summary="Normal session.",
            )

        assert result == "How are you doing today?"

    def test_empty_llm_response_returns_fallback(self):
        """LLM returning empty text should return fallback."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        mock_response = _make_anthropic_response("")
        with patch("deerflow.sophia.smart_opener.anthropic") as mock_mod:
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response
            result = generate_smart_opener(
                user_id="user1",
                session_summary="Some session.",
            )

        assert result == "How are you doing today?"

    def test_missing_template_returns_fallback(self):
        """Missing prompt template file should return fallback."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        with patch("deerflow.sophia.smart_opener._TEMPLATE_PATH", Path("/nonexistent/template.md")):
            result = generate_smart_opener(
                user_id="user1",
                session_summary="Some session.",
            )

        assert result == "How are you doing today?"

    def test_calls_haiku_model(self):
        """Verify the correct model is used."""
        from deerflow.sophia.smart_opener import generate_smart_opener

        mock_response = _make_anthropic_response("How are you?")
        with patch("deerflow.sophia.smart_opener.anthropic") as mock_mod:
            mock_client = mock_mod.Anthropic.return_value
            mock_client.messages.create.return_value = mock_response
            generate_smart_opener(
                user_id="user1",
                session_summary="Session about work stress.",
            )
            call_kwargs = mock_client.messages.create.call_args[1]
            assert call_kwargs["model"] == "claude-haiku-4-5-20251001"
            assert call_kwargs["max_tokens"] == 100


# ---------------------------------------------------------------------------
# Handoff Tests
# ---------------------------------------------------------------------------

class TestGenerateHandoff:
    """Tests for deerflow.sophia.handoffs.generate_handoff."""

    def test_writes_handoff_with_frontmatter(self, tmp_path):
        """Handoff file should have YAML frontmatter with smart_opener."""
        from deerflow.sophia.handoffs import generate_handoff

        messages = [
            _make_message("human", "I'm stressed about the deadline."),
            _make_message("ai", "Tell me more about what's weighing on you."),
        ]

        mock_response = _make_anthropic_response(
            "## Summary\nUser discussed work deadline stress.\n\n"
            "## Tone Arc\nengagement (2.5) -> engagement (2.8)\n\n"
            "## Next Steps\n- Follow up on deadline\n\n"
            "## Decisions\nNo decisions this session.\n\n"
            "## Open Threads\nDeadline anxiety.\n\n"
            "## What Worked / What Didn't\nValidation landed.\n\n"
            "## Feeling\nTense but productive."
        )

        with (
            patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path),
            patch("deerflow.sophia.handoffs.anthropic") as mock_mod,
        ):
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response

            result_path = generate_handoff(
                user_id="test_user",
                session_id="sess_001",
                messages=messages,
                smart_opener_text="The deadline is coming up. How are you holding up?",
            )

        assert result_path.exists()
        content = result_path.read_text(encoding="utf-8")

        # Check frontmatter structure
        assert content.startswith("---\n")
        assert "schema_version: 1" in content
        assert "session_id: sess_001" in content
        assert 'smart_opener: "The deadline is coming up. How are you holding up?"' in content

    def test_round_trip_with_session_state_middleware(self, tmp_path):
        """SessionStateMiddleware regex must parse the generated frontmatter."""
        from deerflow.sophia.handoffs import generate_handoff

        messages = [_make_message("human", "Hello"), _make_message("ai", "Hi there.")]
        mock_response = _make_anthropic_response("## Summary\nGreeting session.\n")

        with (
            patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path),
            patch("deerflow.sophia.handoffs.anthropic") as mock_mod,
        ):
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response

            result_path = generate_handoff(
                user_id="test_user",
                session_id="sess_002",
                messages=messages,
                smart_opener_text="How are you doing today?",
            )

        content = result_path.read_text(encoding="utf-8")

        # Use the exact regex from SessionStateMiddleware._extract_smart_opener
        match = re.search(r"^smart_opener:\s*[\"']?(.+?)[\"']?\s*$", content, re.MULTILINE)
        assert match is not None, "SessionStateMiddleware regex failed to parse generated frontmatter"
        assert match.group(1).strip() == "How are you doing today?"

    def test_creates_missing_directories(self, tmp_path):
        """Parent directories should be created if they don't exist."""
        from deerflow.sophia.handoffs import generate_handoff

        messages = [_make_message("human", "Test")]
        mock_response = _make_anthropic_response("## Summary\nTest.\n")

        with (
            patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path),
            patch("deerflow.sophia.handoffs.anthropic") as mock_mod,
        ):
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response

            result_path = generate_handoff(
                user_id="new_user",
                session_id="sess_003",
                messages=messages,
                smart_opener_text="Welcome.",
            )

        assert result_path.exists()
        assert result_path.parent.name == "handoffs"
        assert result_path.parent.parent.name == "new_user"

    def test_empty_session_uses_fallback_body(self, tmp_path):
        """Empty messages list should produce a minimal handoff with fallback content."""
        from deerflow.sophia.handoffs import generate_handoff

        with patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path):
            result_path = generate_handoff(
                user_id="test_user",
                session_id="sess_004",
                messages=[],
                smart_opener_text="How are you doing today?",
            )

        content = result_path.read_text(encoding="utf-8")
        assert "Brief session with limited context available." in content
        assert 'smart_opener: "How are you doing today?"' in content

    def test_fallback_opener_when_none_provided(self, tmp_path):
        """No smart_opener_text should use default fallback."""
        from deerflow.sophia.handoffs import generate_handoff

        with patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path):
            result_path = generate_handoff(
                user_id="test_user",
                session_id="sess_005",
                messages=[],
            )

        content = result_path.read_text(encoding="utf-8")
        assert 'smart_opener: "How are you doing today?"' in content

    def test_anthropic_failure_uses_fallback_body(self, tmp_path):
        """SDK exception should produce handoff with fallback body."""
        from deerflow.sophia.handoffs import generate_handoff

        messages = [_make_message("human", "Hello")]

        with (
            patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path),
            patch("deerflow.sophia.handoffs.anthropic") as mock_mod,
        ):
            mock_mod.Anthropic.return_value.messages.create.side_effect = RuntimeError("API down")

            result_path = generate_handoff(
                user_id="test_user",
                session_id="sess_006",
                messages=messages,
                smart_opener_text="How are you?",
            )

        assert result_path.exists()
        content = result_path.read_text(encoding="utf-8")
        assert "Brief session with limited context available." in content

    def test_overwrites_existing_handoff(self, tmp_path):
        """Handoff always overwrites -- never accumulated."""
        from deerflow.sophia.handoffs import generate_handoff

        messages = [_make_message("human", "Hello")]
        mock_response = _make_anthropic_response("## Summary\nNew session.\n")

        with (
            patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path),
            patch("deerflow.sophia.handoffs.anthropic") as mock_mod,
        ):
            mock_mod.Anthropic.return_value.messages.create.return_value = mock_response

            # Write first handoff
            generate_handoff(
                user_id="test_user",
                session_id="sess_first",
                messages=messages,
                smart_opener_text="First opener.",
            )

            # Write second handoff -- should overwrite
            result_path = generate_handoff(
                user_id="test_user",
                session_id="sess_second",
                messages=messages,
                smart_opener_text="Second opener.",
            )

        content = result_path.read_text(encoding="utf-8")
        assert "sess_second" in content
        assert "Second opener." in content
        assert "sess_first" not in content

    def test_invalid_user_id_raises(self, tmp_path):
        """Invalid user_id should raise ValueError."""
        from deerflow.sophia.handoffs import generate_handoff

        with (
            patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path),
            pytest.raises(ValueError),
        ):
            generate_handoff(
                user_id="../evil",
                session_id="sess_007",
                messages=[],
            )

    def test_handoff_path_is_latest_md(self, tmp_path):
        """Handoff path must be users/{user_id}/handoffs/latest.md."""
        from deerflow.sophia.handoffs import generate_handoff

        with patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path):
            result_path = generate_handoff(
                user_id="test_user",
                session_id="sess_008",
                messages=[],
            )

        assert result_path.name == "latest.md"
        assert result_path.parent.name == "handoffs"

    def test_artifacts_included_in_prompt(self, tmp_path):
        """Artifacts should be formatted and passed to the LLM prompt."""
        from deerflow.sophia.handoffs import generate_handoff

        messages = [_make_message("human", "I feel good today")]
        artifacts = [
            {
                "tone_estimate": 3.0,
                "tone_target": 3.5,
                "active_tone_band": "engagement",
                "skill_loaded": "active_listening",
                "session_goal": "Explore mood",
                "active_goal": "Listen",
                "next_step": "Continue conversation",
            }
        ]

        mock_response = _make_anthropic_response("## Summary\nPositive session.\n")

        with (
            patch("deerflow.sophia.handoffs.USERS_DIR", tmp_path),
            patch("deerflow.sophia.handoffs.anthropic") as mock_mod,
        ):
            mock_client = mock_mod.Anthropic.return_value
            mock_client.messages.create.return_value = mock_response

            generate_handoff(
                user_id="test_user",
                session_id="sess_009",
                messages=messages,
                artifacts=artifacts,
                smart_opener_text="How are you?",
            )

            # Verify the prompt sent to Claude includes artifact data
            call_kwargs = mock_client.messages.create.call_args[1]
            prompt_content = call_kwargs["messages"][0]["content"]
            assert "tone_estimate: 3.0" in prompt_content
            assert "active_listening" in prompt_content


# ---------------------------------------------------------------------------
# Formatting Helpers Tests
# ---------------------------------------------------------------------------

class TestFormatHelpers:
    """Tests for internal formatting functions."""

    def test_format_messages_as_transcript(self):
        from deerflow.sophia.handoffs import _format_messages_as_transcript

        messages = [
            _make_message("human", "Hello"),
            _make_message("ai", "Hi, how can I help?"),
        ]
        result = _format_messages_as_transcript(messages)
        assert "User: Hello" in result
        assert "Sophia: Hi, how can I help?" in result

    def test_format_empty_messages(self):
        from deerflow.sophia.handoffs import _format_messages_as_transcript

        assert _format_messages_as_transcript([]) == "(empty session)"

    def test_format_multimodal_content(self):
        from deerflow.sophia.handoffs import _format_messages_as_transcript

        msg = MagicMock()
        msg.type = "human"
        msg.content = [{"type": "text", "text": "Hello"}, {"type": "image_url"}]
        result = _format_messages_as_transcript([msg])
        assert "User: Hello" in result

    def test_format_artifacts_none(self):
        from deerflow.sophia.handoffs import _format_artifacts

        assert _format_artifacts(None) == "No artifacts available."

    def test_format_artifacts_with_data(self):
        from deerflow.sophia.handoffs import _format_artifacts

        artifacts = [{"tone_estimate": 2.5, "skill_loaded": "active_listening"}]
        result = _format_artifacts(artifacts)
        assert "Turn 1:" in result
        assert "tone_estimate: 2.5" in result
        assert "active_listening" in result

    def test_format_memories_none(self):
        from deerflow.sophia.handoffs import _format_memories

        assert _format_memories(None) == "No memories extracted yet."

    def test_format_memories_with_data(self):
        from deerflow.sophia.handoffs import _format_memories

        memories = [{"content": "User works at Acme", "category": "fact"}]
        result = _format_memories(memories)
        assert "[fact] User works at Acme" in result


# ---------------------------------------------------------------------------
# Frontmatter Builder Tests
# ---------------------------------------------------------------------------

class TestBuildFrontmatter:
    """Tests for _build_frontmatter."""

    def test_structure(self):
        from deerflow.sophia.handoffs import _build_frontmatter

        fm = _build_frontmatter(session_id="sess_100", smart_opener="Hello there.")
        assert fm.startswith("---\n")
        assert fm.endswith("---\n")
        assert "schema_version: 1" in fm
        assert "session_id: sess_100" in fm
        assert 'smart_opener: "Hello there."' in fm

    def test_parseable_by_middleware_regex(self):
        from deerflow.sophia.handoffs import _build_frontmatter

        fm = _build_frontmatter(
            session_id="sess_200",
            smart_opener="The deadline is tomorrow. Ready?",
        )
        match = re.search(r"^smart_opener:\s*[\"']?(.+?)[\"']?\s*$", fm, re.MULTILINE)
        assert match is not None
        assert match.group(1).strip() == "The deadline is tomorrow. Ready?"
