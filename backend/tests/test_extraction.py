"""Tests for Sophia Mem0 memory extraction from session transcripts."""

import json
from unittest.mock import MagicMock, patch

import pytest

# Sample extraction response from Claude Haiku
_SAMPLE_EXTRACTION = [
    {
        "content": "User works as a product manager at a fintech startup",
        "category": "fact",
        "importance": 0.9,
        "confidence": 0.95,
        "target_date": None,
        "metadata": {
            "tone_estimate": 2.5,
            "ritual_phase": None,
            "temporal_anchor": None,
            "tags": ["career", "identity"],
        },
    },
    {
        "content": "User feels anxious about upcoming board presentation next week",
        "category": "feeling",
        "importance": 0.6,
        "confidence": 0.8,
        "target_date": "2026-04-03",
        "metadata": {
            "tone_estimate": 1.2,
            "ritual_phase": "prepare.step1_vent",
            "temporal_anchor": "2026-04-03",
            "tags": ["anxiety", "work"],
        },
    },
    {
        "content": "Decided to delay the product launch by two weeks to fix onboarding",
        "category": "decision",
        "importance": 0.85,
        "confidence": 0.9,
        "target_date": None,
        "metadata": {
            "tone_estimate": None,
            "ritual_phase": None,
            "temporal_anchor": "2026-03-27",
            "tags": ["product", "decision"],
        },
    },
]

_SAMPLE_MESSAGES = [
    {"role": "user", "content": "I'm really stressed about the board presentation next week."},
    {"role": "assistant", "content": "That sounds like a lot of pressure. What's weighing on you most?"},
    {"role": "user", "content": "I decided to delay the launch by two weeks. I work as a PM at a fintech startup."},
    {"role": "assistant", "content": "That's a significant call. How does it feel now that you've made it?"},
]

_SESSION_METADATA = {
    "session_date": "2026-03-27",
    "context_mode": "work",
    "ritual_type": "prepare",
    "platform": "voice",
    "tone_start": "1.0",
    "tone_end": "2.5",
    "artifacts": "None",
    "existing_memories": "None",
}


def _make_anthropic_response(text: str) -> MagicMock:
    """Create a mock Anthropic messages.create() response."""
    content_block = MagicMock()
    content_block.text = text
    response = MagicMock()
    response.content = [content_block]
    return response


class TestExtractSessionMemories:
    """Tests for extract_session_memories()."""

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_happy_path_three_memories(self, mock_anthropic_mod, mock_add_memories):
        """Mock Anthropic response with 3 extracted memories -> 3 add_memories calls."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps(_SAMPLE_EXTRACTION)
        )
        mock_add_memories.return_value = [{"id": "mem_123"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_001",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert len(result) == 3
        assert mock_add_memories.call_count == 3

        # Verify categories
        categories = [r["category"] for r in result]
        assert categories == ["fact", "feeling", "decision"]

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_malformed_json_returns_empty(self, mock_anthropic_mod, mock_add_memories):
        """Malformed JSON response -> graceful fallback, return empty list."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            "This is not valid JSON at all {{{}"
        )

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_002",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert result == []
        mock_add_memories.assert_not_called()

    def test_empty_transcript_skips_extraction(self):
        """Empty transcript (no messages) -> skip extraction, return empty list."""
        from deerflow.sophia.extraction import extract_session_memories

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_003",
            messages=[],
        )

        assert result == []

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_json_wrapped_in_markdown_code_blocks(self, mock_anthropic_mod, mock_add_memories):
        """JSON wrapped in markdown code blocks -> properly stripped before parsing."""
        from deerflow.sophia.extraction import extract_session_memories

        wrapped_json = "```json\n" + json.dumps(_SAMPLE_EXTRACTION[:1]) + "\n```"

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(wrapped_json)
        mock_add_memories.return_value = [{"id": "mem_456"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_004",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert len(result) == 1
        assert result[0]["category"] == "fact"

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_metadata_fields_passed_to_add_memories(self, mock_anthropic_mod, mock_add_memories):
        """All metadata fields (tone_estimate, importance, platform, status, context_mode) passed to add_memories."""
        from deerflow.sophia.extraction import extract_session_memories

        # Use only the "feeling" entry which has tone_estimate and ritual_phase
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[1]])  # feeling entry
        )
        mock_add_memories.return_value = [{"id": "mem_789"}]

        extract_session_memories(
            user_id="user1",
            session_id="sess_005",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        mock_add_memories.assert_called_once()
        call_kwargs = mock_add_memories.call_args[1]

        assert call_kwargs["user_id"] == "user1"
        assert call_kwargs["session_id"] == "sess_005"

        meta = call_kwargs["metadata"]
        assert meta["status"] == "pending_review"
        assert meta["platform"] == "voice"
        assert meta["context_mode"] == "work"
        assert meta["importance"] == "potential"  # 0.6 -> potential
        assert meta["importance_score"] == 0.6
        assert meta["tone_estimate"] == 1.2
        assert meta["ritual_phase"] == "prepare.step1_vent"
        assert meta["target_date"] == "2026-04-03"
        assert meta["category"] == "feeling"
        assert meta["tags"] == ["anxiety", "work"]

    @patch("deerflow.sophia.extraction.anthropic")
    def test_anthropic_sdk_exception_returns_empty(self, mock_anthropic_mod):
        """Anthropic SDK raises exception -> graceful fallback."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("API rate limit")

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_006",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert result == []

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_importance_label_mapping(self, mock_anthropic_mod, mock_add_memories):
        """Importance score correctly mapped to labels: structural/potential/contextual."""
        from deerflow.sophia.extraction import extract_session_memories

        entries = [
            {"content": "High importance", "category": "fact", "importance": 0.9, "confidence": 0.9, "metadata": {}},
            {"content": "Medium importance", "category": "feeling", "importance": 0.5, "confidence": 0.7, "metadata": {}},
            {"content": "Low importance", "category": "pattern", "importance": 0.2, "confidence": 0.6, "metadata": {}},
        ]

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(json.dumps(entries))
        mock_add_memories.return_value = []

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_007",
            messages=_SAMPLE_MESSAGES,
        )

        assert len(result) == 3
        assert result[0]["importance"] == "structural"
        assert result[1]["importance"] == "potential"
        assert result[2]["importance"] == "contextual"

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_empty_content_entries_skipped(self, mock_anthropic_mod, mock_add_memories):
        """Entries with empty or missing content are skipped."""
        from deerflow.sophia.extraction import extract_session_memories

        entries = [
            {"content": "", "category": "fact", "importance": 0.9, "metadata": {}},
            {"content": "Valid entry", "category": "fact", "importance": 0.9, "metadata": {}},
            {"category": "feeling", "importance": 0.5, "metadata": {}},  # missing content
        ]

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(json.dumps(entries))
        mock_add_memories.return_value = []

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_008",
            messages=_SAMPLE_MESSAGES,
        )

        assert len(result) == 1
        assert result[0]["content"] == "Valid entry"

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_empty_extraction_array(self, mock_anthropic_mod, mock_add_memories):
        """Claude returns empty array -> no writes, return empty list."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response("[]")
        mock_add_memories.return_value = []

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_009",
            messages=_SAMPLE_MESSAGES,
        )

        assert result == []
        mock_add_memories.assert_not_called()

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_explicit_preferred_name_statement_creates_pending_review_candidate(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        """Explicit user name corrections create deterministic review candidates."""
        from deerflow.sophia.extraction import extract_session_memories

        messages = [
            {
                "role": "user",
                "content": "Actually, my name is Mira, no Daniel. Could you please remember that?",
            },
            {"role": "assistant", "content": "Got it."},
        ]
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response("[]")
        mock_add_memories.return_value = [{"id": "mem_name"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_name",
            messages=messages,
            session_metadata=_SESSION_METADATA,
        )

        assert len(result) == 1
        assert result[0]["content"] == "Preferred name: Mira. Explicit user statement."
        assert result[0]["category"] == "fact"
        assert result[0]["importance"] == "structural"
        mock_add_memories.assert_called_once()
        call_kwargs = mock_add_memories.call_args[1]
        assert call_kwargs["messages"] == [
            {"role": "user", "content": "Preferred name: Mira. Explicit user statement."}
        ]
        meta = call_kwargs["metadata"]
        assert meta["category"] == "fact"
        assert meta["importance"] == "structural"
        assert meta["importance_score"] == 0.95
        assert meta["confidence"] == 0.98
        assert meta["status"] == "pending_review"
        assert meta["preferred_name_source"] == "explicit_user_statement"
        assert meta["tags"] == ["preferred_name", "explicit_user_statement"]

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_ambiguous_name_like_phrases_do_not_create_preferred_name_candidate(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        """Ambiguous phrases such as task references should not update identity."""
        from deerflow.sophia.extraction import extract_session_memories

        messages = [
            {"role": "user", "content": "My name is on the list."},
            {"role": "user", "content": "Call me tomorrow about the launch."},
        ]
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response("[]")

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_ambiguous_name",
            messages=messages,
            session_metadata=_SESSION_METADATA,
        )

        assert result == []
        mock_add_memories.assert_not_called()

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_explicit_preferred_name_candidate_survives_llm_failure(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        """The deterministic explicit-name path does not depend on the LLM extraction response."""
        from deerflow.sophia.extraction import extract_session_memories

        messages = [{"role": "user", "content": "Please call me Mira from now on."}]
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("API rate limit")
        mock_add_memories.return_value = [{"id": "mem_name"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_name_fallback",
            messages=messages,
            session_metadata=_SESSION_METADATA,
        )

        assert len(result) == 1
        assert result[0]["content"] == "Preferred name: Mira. Explicit user statement."
        mock_add_memories.assert_called_once()

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_explicit_remember_durable_preference_creates_pending_candidate(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        from deerflow.sophia.extraction import extract_session_memories

        messages = [
            {
                "role": "user",
                "content": "Please remember that my preferred evening tea is chamomile tea because it helps me wind down.",
                "sequence": 9,
                "message_id": "m-9",
            },
            {
                "role": "assistant",
                "content": "Got it - chamomile tea for your evening tea preference.",
                "sequence": 10,
                "message_id": "m-10",
            },
        ]
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response("[]")
        mock_add_memories.return_value = [{"id": "mem_tea"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_explicit_pref",
            messages=messages,
            session_metadata={
                **_SESSION_METADATA,
                "sequence_start": 7,
                "sequence_end": 10,
                "source_message_ids": ["m-7", "m-8", "m-9", "m-10"],
            },
        )

        assert len(result) == 1
        assert result[0]["content"] == (
            "User's preferred evening tea is chamomile tea because it helps them wind down."
        )
        assert result[0]["category"] == "preference"
        mock_add_memories.assert_called_once()
        call_kwargs = mock_add_memories.call_args[1]
        assert call_kwargs["messages"] == [
            {
                "role": "user",
                "content": (
                    "User's preferred evening tea is chamomile tea because it helps them wind down."
                ),
            }
        ]
        meta = call_kwargs["metadata"]
        assert meta["status"] == "pending_review"
        assert meta["category"] == "preference"
        assert meta["importance"] == "structural"
        assert meta["sequence_start"] == 9
        assert meta["sequence_end"] == 10
        assert meta["source_message_ids"] == ["m-9", "m-10"]
        assert meta["explicit_remember_source"] == "deterministic_preference"
        assert meta["tags"] == ["explicit_user_statement", "explicit_remember", "preference"]

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_explicit_remember_test_preference_is_candidate_with_test_marker(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        from deerflow.sophia.extraction import extract_session_memories

        messages = [
            {
                "role": "user",
                "content": "Please remember that my second segment test preference is chamomile tea.",
                "sequence": 9,
                "message_id": "m-9",
            },
            {"role": "assistant", "content": "Got it.", "sequence": 10, "message_id": "m-10"},
        ]
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response("[]")
        mock_add_memories.return_value = [{"id": "mem_test_pref"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_test_pref",
            messages=messages,
            session_metadata=_SESSION_METADATA,
        )

        assert len(result) == 1
        assert result[0]["content"] == "User's second segment test preference is chamomile tea."
        meta = mock_add_memories.call_args[1]["metadata"]
        assert meta["importance"] == "potential"
        assert meta["confidence"] == 0.72
        assert meta["tags"] == [
            "explicit_user_statement",
            "explicit_remember",
            "preference",
            "test_marker",
        ]

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_explicit_remember_preference_suppresses_near_duplicate_llm_candidate(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        from deerflow.sophia.extraction import extract_session_memories

        messages = [
            {
                "role": "user",
                "content": "Please remember that my preferred evening tea is chamomile tea because it helps me wind down.",
            }
        ]
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(json.dumps([
            {
                "content": "User prefers chamomile tea in the evening because it helps them wind down.",
                "category": "preference",
                "importance": 0.8,
                "confidence": 0.86,
                "metadata": {},
            }
        ]))
        mock_add_memories.return_value = [{"id": "mem_tea"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_no_dup_pref",
            messages=messages,
            session_metadata=_SESSION_METADATA,
        )

        assert len(result) == 1
        assert result[0]["content"] == (
            "User's preferred evening tea is chamomile tea because it helps them wind down."
        )
        mock_add_memories.assert_called_once()

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_explicit_remember_temporary_security_token_is_rejected(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        from deerflow.sophia.extraction import analyze_explicit_remember_messages, extract_session_memories

        messages = [
            {
                "role": "user",
                "content": "Please remember this temporary security token is red rabbit seven.",
                "sequence": 3,
                "message_id": "m-3",
            }
        ]
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response("[]")

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_secret",
            messages=messages,
            session_metadata=_SESSION_METADATA,
        )

        assert result == []
        mock_add_memories.assert_not_called()
        diagnostics = analyze_explicit_remember_messages(messages)
        assert diagnostics["entries"] == []
        assert diagnostics["rejections"] == [
            {"reason": "credential_like", "sequence_start": 3, "sequence_end": 3, "source_message_ids": ["m-3"]}
        ]
        assert "red rabbit" not in json.dumps(diagnostics)

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_credential_like_llm_candidate_is_policy_filtered(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(json.dumps([
            {
                "content": "User's temporary password is red rabbit seven.",
                "category": "fact",
                "importance": 0.9,
                "confidence": 0.9,
                "metadata": {},
            }
        ]))

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_policy_filter",
            messages=[{"role": "user", "content": "I need to remember something."}],
            session_metadata=_SESSION_METADATA,
        )

        assert result == []
        mock_add_memories.assert_not_called()

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_require_memory_write_raises_when_candidate_write_returns_empty(
        self,
        mock_anthropic_mod,
        mock_add_memories,
    ):
        from deerflow.sophia.extraction import MemoryWriteError, extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(json.dumps([
            {
                "content": "User prefers directness.",
                "category": "preference",
                "importance": 0.82,
                "confidence": 0.9,
                "metadata": {},
            }
        ]))
        mock_add_memories.return_value = []

        with pytest.raises(MemoryWriteError):
            extract_session_memories(
                user_id="user1",
                session_id="sess_write_fail",
                messages=[{"role": "user", "content": "Please be direct with me."}],
                session_metadata=_SESSION_METADATA,
                require_memory_write=True,
            )

    def test_messages_with_no_user_content_skips(self):
        """Messages with only system roles -> no transcript -> skip."""
        from deerflow.sophia.extraction import extract_session_memories

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_010",
            messages=[
                {"role": "system", "content": "You are Sophia."},
                {"role": "system", "content": "System message."},
            ],
        )

        assert result == []

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_non_list_response_returns_empty(self, mock_anthropic_mod, mock_add_memories):
        """Response that parses as JSON but is not a list -> return empty."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            '{"error": "unexpected format"}'
        )

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_011",
            messages=_SAMPLE_MESSAGES,
        )

        assert result == []
        mock_add_memories.assert_not_called()

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_default_metadata_when_session_metadata_none(self, mock_anthropic_mod, mock_add_memories):
        """When session_metadata is None, defaults are used for platform and context_mode."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([{"content": "A fact", "category": "fact", "importance": 0.9, "metadata": {}}])
        )
        mock_add_memories.return_value = []

        extract_session_memories(
            user_id="user1",
            session_id="sess_012",
            messages=_SAMPLE_MESSAGES,
            session_metadata=None,
        )

        meta = mock_add_memories.call_args[1]["metadata"]
        assert meta["platform"] == "text"  # default
        assert meta["context_mode"] == "life"  # default
        assert meta["status"] == "pending_review"

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_markdown_fences_without_language_tag(self, mock_anthropic_mod, mock_add_memories):
        """Markdown code blocks without language tag (just ```) are also stripped."""
        from deerflow.sophia.extraction import extract_session_memories

        wrapped = "```\n" + json.dumps(_SAMPLE_EXTRACTION[:1]) + "\n```"

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(wrapped)
        mock_add_memories.return_value = []

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_013",
            messages=_SAMPLE_MESSAGES,
        )

        assert len(result) == 1


class TestFormatTranscript:
    """Tests for the internal _format_transcript helper."""

    def test_user_and_assistant_messages(self):
        from deerflow.sophia.extraction import _format_transcript

        result = _format_transcript([
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ])
        assert "User: Hello" in result
        assert "Sophia: Hi there" in result

    def test_empty_content_skipped(self):
        from deerflow.sophia.extraction import _format_transcript

        result = _format_transcript([
            {"role": "user", "content": ""},
            {"role": "assistant", "content": "Hi"},
        ])
        assert "User:" not in result
        assert "Sophia: Hi" in result

    def test_system_messages_excluded(self):
        from deerflow.sophia.extraction import _format_transcript

        result = _format_transcript([
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
        ])
        assert "System" not in result
        assert "User: Hello" in result


class TestStripMarkdownFences:
    """Tests for the internal _strip_markdown_fences helper."""

    def test_strips_json_fences(self):
        from deerflow.sophia.extraction import _strip_markdown_fences

        result = _strip_markdown_fences('```json\n{"key": "value"}\n```')
        assert result == '{"key": "value"}'

    def test_strips_plain_fences(self):
        from deerflow.sophia.extraction import _strip_markdown_fences

        result = _strip_markdown_fences('```\n[1, 2, 3]\n```')
        assert result == "[1, 2, 3]"

    def test_no_fences_passes_through(self):
        from deerflow.sophia.extraction import _strip_markdown_fences

        result = _strip_markdown_fences('[1, 2, 3]')
        assert result == "[1, 2, 3]"

    def test_whitespace_around_fences(self):
        from deerflow.sophia.extraction import _strip_markdown_fences

        result = _strip_markdown_fences('  ```json\n{"a": 1}\n```  ')
        assert result == '{"a": 1}'
