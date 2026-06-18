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


class TestCandidatePolicyRejectionReasonTaskHistory:
    """Backstop filter for builder task-history (fix/builder-memory-contamination).

    These guard the read/write contamination fix: a 'user requested creation of X'
    deliverable snippet must be rejected as task_history so it never becomes a
    durable fact/decision that hijacks future builder retrieval — while genuine
    preferences and the user's own work stay untouched.
    """

    def test_candidate_policy_rejection_reason_task_history(self):
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User requested creation of three educational materials about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a presentation about Hermes"
        ) == "task_history"

    def test_candidate_policy_rejection_reason_preserves_preferences_and_work(self):
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason("User prefers concise reports, no bullet lists") is None
        assert _candidate_policy_rejection_reason("User is building a report generator for their startup") is None
        assert _candidate_policy_rejection_reason("User's name is Davide") is None

    def test_deliverable_noun_without_request_verb_is_not_task_history(self):
        """The verb+noun AND requirement protects topical mentions.

        'board presentation' carries a deliverable noun but no request verb, so it
        must pass through — this is exactly the shape of the happy-path 'feeling'
        memory ('anxious about upcoming board presentation') that extraction must
        still keep.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User feels anxious about upcoming board presentation next week"
        ) is None
        # Request verb but no deliverable noun → not a build request.
        assert _candidate_policy_rejection_reason(
            "User asked for a raise during their performance review"
        ) is None

    def test_deliverable_noun_matches_on_word_boundaries_only(self):
        """Deliverable nouns match whole words, never as substrings of others.

        A bare ``noun in content`` test would fire inside 'reported',
        'immaterial', 'documented' and silently drop durable feeling/
        relationship/lesson memories as task_history. These all carry a
        request verb AND a noun-substring, so they are the exact shape that
        would have been wrongly rejected before word-boundary anchoring.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked me to treat the financial loss as immaterial"
        ) is None  # 'material' inside 'immaterial'
        assert _candidate_policy_rejection_reason(
            "User wanted me to know they documented everything carefully"
        ) is None  # 'document' inside 'documented'
        assert _candidate_policy_rejection_reason(
            "Manager reported the numbers; user wanted me to stay calm"
        ) is None  # 'report' inside 'reported', no standalone deliverable noun

    def test_real_logged_contamination_snippet_is_rejected(self):
        """The actual stored memory that caused the OpenClaw-vs-Hermes bug.

        Locks in that word-boundary anchoring did not regress the canonical
        case: 'educational materials' (plural, whole word) is still caught.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User requested creation of three different educational materials "
            "about the open claw agent memory system"
        ) == "task_history"

    def test_weak_deliverable_noun_without_creation_cue_is_preserved(self):
        """Codex P2 round 2: a WEAK/ambiguous noun + request verb is NOT enough
        WHEN THERE IS NO SUBJECT.

        'document'/'material'/'pdf' could name an existing artifact, so a request
        for one with NO 'about <topic>' subject needs an explicit create/build cue
        before we drop it. Otherwise durable context ("asked for HR documents
        after the incident") is lost. (A topic-scoped weak noun IS dropped — see
        test_topic_scoped_weak_deliverable_is_task_history.)
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for HR documents after the incident"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for the onboarding materials"
        ) is None

    def test_topic_scoped_weak_deliverable_is_task_history(self):
        """Codex P2: a WEAK deliverable noun WITH a subject ("a PDF about X",
        "a document about Y") is a topic-scoped build request — the subject-scoping
        is the build signal, so no separate create/build cue is required. Without
        this, 'User asked for a PDF about OpenClaw' returned None and the prior
        build subject could still contaminate a new brief via the lexical-only
        companion/builder read filters."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a PDF about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia for a document about Q3 sales"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wanted a PDF about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked on Tuesday for a PDF about onboarding"
        ) == "task_history"
        # The no-subject weak-noun keep and the guards are unaffected.
        assert _candidate_policy_rejection_reason(
            "User asked for HR documents after the incident"
        ) is None
        assert _candidate_policy_rejection_reason(
            "Boss asked for a status report about Q3 revenue"
        ) is None  # third party
        assert _candidate_policy_rejection_reason(
            "User prefers reports about competitors to be concise"
        ) is None  # delivery preference

    def test_strong_deliverable_noun_request_is_task_history(self):
        """Codex P2 round 3: 'asked for a report about Hermes' must be dropped.

        A STRONG 'make me a ___' noun (report/presentation/deck/slide/webpage) is
        a build request on the request verb alone — no separate creation cue — so
        the exact shape the prompt skips no longer slips through to the builder.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested a deck on the new pricing model"
        ) == "task_history"
        # 'requested/requests' + a bare PLURAL deliverable ("requested slides",
        # "requested reports") is a build too — but the plural NOUN "feature
        # requests" / "support requests" (a preposition follows) is NOT.
        assert _candidate_policy_rejection_reason(
            "User requested slides about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested reports about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User logs feature requests about the product"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User tracks support requests in a spreadsheet"
        ) is None

    def test_third_party_requester_is_preserved(self):
        """A request involving a third party is a relationship fact, not a build
        request made of Sophia — even with a strong deliverable noun. Covers both
        shapes: the third party is the asker, and the third party is the one asked
        to act (redirect object)."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "Boss asked for a status report in every meeting; user feels dismissed"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User's manager requested a deck for the board"
        ) is None
        # Redirect object: the user wants a third party (not Sophia) to act.
        assert _candidate_policy_rejection_reason(
            "User wants their boss to deliver the report"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants the team to build a deck"
        ) is None

    def test_audience_for_party_to_does_not_exempt_sophia_request(self):
        """Codex P2: the redirect guard must not match an AUDIENCE phrase. A
        Sophia build request whose deliverable is 'for the <party> to review' is
        still task history — the third party only receives it, it isn't the
        requestee. (The redirect guard requires the party to follow a request verb.)"""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report for the team to review"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a deck for the client to sign off"
        ) == "task_history"

    def test_wants_and_needs_build_requests_are_task_history(self):
        """Codex P2 round 4: want/need wording is a build request too.

        'User wants a report about Hermes' / 'wanted Sophia to build a deck' /
        'needs a presentation' must drop — the same classifier gates both the
        write and the companion-snippet injection, so missing these forms would
        let the subject-contamination recur.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wanted Sophia to build a deck"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User needs a presentation on the merger"
        ) == "task_history"

    def test_want_need_without_deliverable_is_preserved(self):
        """Bare want/need are common verbs — the noun gate keeps non-deliverable
        wants/needs from being dropped."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason("User wants to feel calmer at work") is None
        assert _candidate_policy_rejection_reason("User needs more sleep before the trip") is None

    def test_delivery_preference_phrased_with_want_is_preserved(self):
        """Codex P2: a delivery PREFERENCE phrased with want/need (not the word
        'prefer') must still be kept — the prompt routes these to `preference`.

        'wants reports to be concise and include citations' has a request verb
        and a strong noun but no build signal (no create cue, no 'about <topic>'),
        so the style/format phrasing marks it as a standing preference, not a
        build request. A styled request WITH a topic is still task history.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants reports to be concise and include citations"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants decks to be short and skimmable"
        ) is None
        # But a styled build request that names a subject still drops.
        assert _candidate_policy_rejection_reason(
            "User wants a concise report about Hermes"
        ) == "task_history"

    def test_styled_one_off_build_is_not_a_preference(self):
        """Codex P2: a SINGULAR styled request ("a detailed deck") or one with a
        deadline is a one-off build, not a standing preference — it must drop even
        without an 'about'/'on' subject. Generic/plural style preferences stay."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User needs a detailed deck by Monday"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a concise report for the board"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants concise decks by Friday"
        ) == "task_history"
        # A generic/plural style preference (no singular article, no deadline) stays.
        assert _candidate_policy_rejection_reason(
            "User wants their reports concise for the board"
        ) is None

    def test_passive_built_is_a_creation_cue(self):
        """Codex P2: 'built' is a passive create/build cue. The old
        build(?:s|t)? never matched 'built', so a weak-noun request like
        'a PDF built about Hermes' slipped through."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wanted a PDF built about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a document built for the launch"
        ) == "task_history"
        # 'building' (the user's own work, no request verb) still stays.
        assert _candidate_policy_rejection_reason(
            "User is building a report generator for their startup"
        ) is None

    def test_incidental_topic_words_do_not_exempt_build_requests(self):
        """Codex P2: the preference / third-party guards scan the request INTENT,
        not the deliverable's subject.

        A clear build request whose *topic* happens to mention 'prefer' or a
        third-party request must still drop — those words are about the subject
        matter, not the request itself.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report about what customers prefer in OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report about what the client requested in the contract"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested a report about what the client wanted in the deal"
        ) == "task_history"
        # The guards still fire when the third party / preference is the ACTOR.
        assert _candidate_policy_rejection_reason(
            "Boss requested a report about Q3 revenue"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User prefers reports about competitors to be concise"
        ) is None

    def test_deliverable_noun_only_in_subject_is_preserved(self):
        """When the deliverable noun is in the SUBJECT (after the topic marker)
        and the intent is not a build request, it must be kept — the requested
        thing must be named in the intent clause."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants to focus on the presentation next week"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to reflect on the report card from school"
        ) is None

    def test_temporal_on_before_deliverable_is_not_a_topic_split(self):
        """Codex P2 (finding 1): the topic split must land on the marker that
        introduces the SUBJECT, not an earlier temporal/incidental 'on'.

        'asked Sophia ON Monday to build a report about Hermes' splits on the
        first 'on' under the old single-search logic, leaving an intent with no
        deliverable noun, so the request wrongly survived. The split now walks
        every topic marker and picks the first one with the deliverable named
        before it — here 'about'."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia on Monday to build a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested a deck on Friday about the Q3 roadmap"
        ) == "task_history"
        # The keep side is unchanged: a deliverable named only after a temporal
        # 'on' (and never built/requested as an artifact) still survives.
        assert _candidate_policy_rejection_reason(
            "User wants to check in on Monday about the presentation"
        ) is None

    def test_bare_asked_to_build_is_task_history(self):
        """Codex P2: 'User asked to build a report about X' (bare 'asked to' +
        creation verb) is a build request. 'asked to see/review' an existing
        artifact is not."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked to build a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked to create a deck on the merger"
        ) == "task_history"
        # 'asked to <non-creation>' (view/review existing) is preserved.
        assert _candidate_policy_rejection_reason(
            "User asked to see the report about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked to review the deck before the meeting"
        ) is None

    def test_frontend_web_deliverables_are_task_history(self):
        """Codex P2 (finding): the frontend dispatch path
        (start_builder_task._HTML_OUTPUT_RE) treats bare web nouns — website,
        web page, web site, landing page, web app — as build targets, so a legacy
        'user asked Sophia to build a website about X' memory must drop as
        task_history too, or the prior frontend subject contaminates a new build.
        'webpage' (one word) was already covered; the spaced/missing forms were
        the gap."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a website about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a web page about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a landing page about the pricing tiers"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested a web app about scheduling"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a web site about the launch"
        ) == "task_history"
        # No request verb → durable memory about their site, kept.
        assert _candidate_policy_rejection_reason(
            "User feels anxious about their website launch next month"
        ) is None
        # A skill/activity modified by a web noun is a goal, not a build request.
        assert _candidate_policy_rejection_reason(
            "User wants website coaching before the relaunch"
        ) is None

    def test_skill_modifier_nouns_are_not_deliverables(self):
        """Codex P2: a deliverable word MODIFYING a skill/activity is a goal, not a
        build request. 'presentation coaching', 'presentation practice',
        'report-writing skills' must be kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants presentation coaching before the board meeting"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User needs presentation practice this week"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants help with their report-writing skills"
        ) is None
        # But a real deliverable ABOUT the topic of coaching still drops.
        assert _candidate_policy_rejection_reason(
            "User asked for a report about presentation coaching techniques"
        ) == "task_history"

    def test_singular_support_role_modifiers_are_not_deliverables(self):
        """Codex P2: a singular support-ROLE word after a deliverable noun (a
        presentation *coach* / *mentor* / *tutor*) names a support goal, not a
        build request — the lookahead exempted the gerund 'coaching' but not the
        role noun 'coach', so 'wants a presentation coach' was wrongly dropped."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants a presentation coach before the board meeting"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User needs a presentation mentor for the investor pitch"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User is looking for a presentation coach"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User found a great report mentor"
        ) is None
        # A real deliverable in the same memory still drops (coach ignored, report kept).
        assert _candidate_policy_rejection_reason(
            "User wants a presentation coach and a report about Q3"
        ) == "task_history"
        # A deliverable ABOUT coaching is still a build request.
        assert _candidate_policy_rejection_reason(
            "User asked for a deck about presentation coaches"
        ) == "task_history"

    def test_subject_introducing_participle_is_a_topic_marker(self):
        """Codex P2: a participle that scopes the deliverable to a subject
        ('a PDF summarizing X', 'a document outlining Y', 'a report detailing Z')
        introduces the subject exactly like 'about X' — so a weak noun in that
        shape is a topic-scoped build request, not a kept memory. Without this,
        'requested a PDF summarizing Hermes' had no 'about/on' marker and no create
        verb, so the no-subject branch kept it and the prior subject leaked."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User requested a PDF summarizing Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested a document outlining Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a report detailing the Q3 results"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia for a PDF analyzing the market"
        ) == "task_history"
        # No deliverable noun before the participle → kept (the participle alone
        # isn't a build request).
        assert _candidate_policy_rejection_reason(
            "User wants help summarizing their notes"
        ) is None
        # No request verb → the user's own summarizing activity is kept.
        assert _candidate_policy_rejection_reason(
            "User is summarizing their feelings about work"
        ) is None

    def test_deliverable_word_as_verb_or_help_object_is_preserved(self):
        """Codex P2: the deliverable WORD is not a requested artifact when it is a
        verb ('wants to report on harassment') or the object of a help/practice/
        prep request ('asked for help with a presentation'). The topic-branch
        drop must not silently exclude these durable memories on the lexical-only
        read filters."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        # Deliverable word used as a verb.
        assert _candidate_policy_rejection_reason(
            "User wants to report on harassment at work"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to document the abuse for HR"
        ) is None
        # Deliverable as the object of a help / practice / prep request.
        assert _candidate_policy_rejection_reason(
            "User asked for help with a presentation on Tuesday"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User needs help preparing for a presentation"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked me to help with their deck"
        ) is None
        # Gerund / direct-object prep + revision forms with no trailing "for"
        # ("help preparing the presentation", "help revising the report") — coaching
        # / support on an EXISTING deliverable, so the memory is preserved.
        assert _candidate_policy_rejection_reason(
            "User needs help preparing the presentation"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for help preparing the report"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants help revising the deck about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for help reviewing the proposal"
        ) is None
        # "to"-infinitive prep/revision forms ("help to prepare a presentation",
        # "help to revise the report") are coaching support too — preserved.
        assert _candidate_policy_rejection_reason(
            "User needs help to prepare a presentation"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants help to revise the report"
        ) is None
        # ...but "help to CREATE" is still a build.
        assert _candidate_policy_rejection_reason(
            "User needs help to create a deck about pricing"
        ) == "task_history"
        # Guard rails: a genuine build request is still dropped (no verb/help cue).
        assert _candidate_policy_rejection_reason(
            "User asked for a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a deck about pricing"
        ) == "task_history"
        # The exemption is prep/revision only — "help CREATING" is still a build.
        assert _candidate_policy_rejection_reason(
            "User needs help creating a deck about pricing"
        ) == "task_history"

    def test_strong_noun_in_non_deliverable_compound_is_preserved(self):
        """Codex P2: a strong noun inside a common non-deliverable compound — a
        school 'report card', a playing-card 'deck of cards' / 'card deck' — is a
        durable fact, not a build deliverable, so the request-verb + strong-noun
        test must not drop it. A real 'slide deck about X' is unaffected."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User needs a deck of cards for game night"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for a report card from school"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User bought a card deck for poker night"
        ) is None
        # A genuine slide deck about a subject still drops.
        assert _candidate_policy_rejection_reason(
            "User asked for a slide deck about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a deck about pricing"
        ) == "task_history"

    def test_deliverable_as_modifier_preference_is_preserved(self):
        """Codex P2: a deliverable word used only as a MODIFIER of a system /
        output-channel / preference noun ('document storage on Google Drive',
        'report notifications on Slack', 'presentation backups on Dropbox') names a
        durable preference, not a build request. _TOPIC_MARKER_RE treats the 'on
        <platform>' as a subject, so without an exemption the topic-scoped resolver
        would drop it. A genuine build with a creation cue ('create a report
        dashboard about Q3') still drops."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants document storage on Google Drive"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants report notifications on Slack"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants presentation backups on Dropbox"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User prefers report alerts via email"
        ) is None
        # No subject marker (subjectless form) — still a preference, still kept.
        assert _candidate_policy_rejection_reason(
            "User wants document storage"
        ) is None
        # Web / PPTX deliverable aliases as the modifier are covered too.
        assert _candidate_policy_rejection_reason(
            "User wants website storage on S3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants web app notifications on Slack"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants PowerPoint backups on Google Drive"
        ) is None
        # Guard rails: a real build still drops — deliverable as head noun, or a
        # creation cue over the modifier compound.
        assert _candidate_policy_rejection_reason(
            "User wants a report about Google Drive"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a report dashboard about Q3"
        ) == "task_history"
        # Build-target-capable suffix nouns (dashboard/portal/tracker/...) are NOT
        # preference features — they drop even with NO creation cue, for both
        # regular and web/PPT alias modifiers.
        assert _candidate_policy_rejection_reason(
            "User wants a report dashboard about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a web app dashboard about Q3 revenue"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a website portal about pricing"
        ) == "task_history"

    def test_adjectival_brief_before_interaction_word_is_preserved(self):
        """Codex P2: 'brief' is an ADJECTIVE when it modifies a conversation /
        interaction word ('brief conversations about work stress', 'brief daily
        check-ins', 'a brief chat') — a communication preference, not a 'brief'
        document deliverable. The read-path filters must keep it. A real 'brief'
        document ('a brief about the merger', 'a brief report about Q3') has no
        interaction word and still drops."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants brief conversations about work stress"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants a brief chat about the project"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User prefers brief check-ins"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User likes brief daily syncs about progress"
        ) is None
        # A genuine 'brief' document deliverable still drops.
        assert _candidate_policy_rejection_reason(
            "User asked for a brief about the merger"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a brief report about Q3"
        ) == "task_history"

    def test_emotional_support_goal_with_deliverable_context_is_preserved(self):
        """Codex P2: a strong noun naming the ACTIVITY CONTEXT of an emotional /
        support goal ('wants confidence for presentations', 'improve presentation
        confidence', 'scared of giving presentations') is not a requested
        artifact. The emotional word comes before the deliverable, which separates
        it from a real build whose subject is an emotion ('a report about anxiety'
        — deliverable first — still drops)."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants confidence for presentations"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User needs to improve presentation confidence"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User is scared of giving presentations"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to feel calm before the presentation"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User has anxiety around reports at work"
        ) is None
        # A real build whose SUBJECT is an emotion still drops (deliverable first).
        assert _candidate_policy_rejection_reason(
            "User asked for a report about their anxiety"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a report about Hermes"
        ) == "task_history"

    def test_exemption_phrase_in_subject_does_not_exempt_real_build(self):
        """Codex P2: the non-artifact exemptions are scoped to the request INTENT,
        never the deliverable's subject. A real build whose TOPIC happens to
        contain a verb/help/practice/emotional phrase must still drop."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a deck about practicing for interviews"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a report about help with presentations"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a report about how to document harassment"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a deck about confidence for public speaking"
        ) == "task_history"
        # The exemption still fires when the phrase is in the INTENT (request side).
        assert _candidate_policy_rejection_reason(
            "User wants to report on harassment at work"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for help with a presentation about Q3"
        ) is None

    def test_temporal_on_only_marker_still_drops_dated_request(self):
        """Codex P2: a temporal 'on <weekday/date>' is not a subject marker. A
        dated request ('asked on Tuesday for a report', 'asked on Tuesday to build
        a deck') must drop just like the undated form — the temporal 'on' must not
        leave the topic split empty and wrongly keep it. A genuine 'on <subject>'
        ('focus on the presentation') is still a subject and is kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked on Tuesday for a report for Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked on Tuesday to build a deck for Hermes"
        ) == "task_history"
        # Genuine subject 'on X' (not temporal) where the deliverable is the
        # object of 'on' is still kept.
        assert _candidate_policy_rejection_reason(
            "User wants to focus on the presentation next week"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to check in on Monday about the presentation"
        ) is None

    def test_deliverable_named_user_project_is_preserved(self):
        """Codex P2: a deliverable word naming the user's OWN software project —
        'report generator', 'presentation app', 'slide builder' — is the user's
        work, which the classifier keeps. The request verb + strong noun must not
        drop it. (Hyphenated 'report-generator' was already exempt; this covers
        the space-separated form.)"""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants to create a report generator for their startup"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User is building a presentation app"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to build a report tool"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User is developing a PDF generator"
        ) is None
        # A genuine deliverable request still drops (no project/product word).
        assert _candidate_policy_rejection_reason(
            "User asked for a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a deck about pricing"
        ) == "task_history"

    def test_strong_noun_in_everyday_compound_is_preserved(self):
        """Codex P2: a strong deliverable word used in an everyday non-deliverable
        compound — a 'deck chair'/'deck shoes' (furniture/nautical), a 'slide rule'
        (calculator), a 'website developer'/'presentation designer' (a person) —
        is a durable fact, not a build request, even with a want/need verb."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants a deck chair for the patio"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User needs a website developer"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User needs a slide rule"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants a presentation designer for their team"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants deck shoes for sailing"
        ) is None
        # A real deliverable (no everyday-compound head) still drops.
        assert _candidate_policy_rejection_reason(
            "User asked for a slide deck about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User would like a deck about pricing"
        ) == "task_history"

    def test_singular_weak_deliverable_scoped_by_for_is_task_history(self):
        """Codex P2: 'for' is not a topic marker (often an audience), but a
        SINGULAR INDEFINITE weak deliverable scoped by a trailing 'for <X>'
        ('a PDF for Hermes', 'a summary for OpenClaw') is a one-off build and must
        drop, while plural/definite forms (existing-artifact retrieval) stay."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a PDF for Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a summary for OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a detailed document for the merger"
        ) == "task_history"
        # Existing-artifact retrieval / generic requests stay.
        assert _candidate_policy_rejection_reason(
            "User asked for the onboarding PDF for new hires"
        ) is None  # definite "the", not a new build
        assert _candidate_policy_rejection_reason(
            "User asked for HR documents after the incident"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for a PDF"
        ) is None  # no trailing "for <X>"

    def test_feedback_support_request_about_a_deliverable_is_preserved(self):
        """Codex P2: when the request's OBJECT is feedback/advice/support (not the
        deliverable), it is not a build request — 'wants feedback on their
        presentation about Q2', 'needs support after reading a report' are kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants feedback on their presentation about Q2"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User needs support after reading a report on climate change"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for advice on their deck about pricing"
        ) is None
        # A real build request (object IS the deliverable) still drops.
        assert _candidate_policy_rejection_reason(
            "User asked for a report about Hermes"
        ) == "task_history"

    def test_own_work_commitment_goals_are_preserved(self):
        """Codex P2: an OWN-WORK goal where the user states their own intent to act
        ('needs to prepare a presentation by Monday', 'wants to finish the report
        by Friday') is a durable commitment, not a build request of Sophia. The
        'to <verb>' infinitive after want/need is the tell ('wants TO finish' vs
        'wants A report'); a Sophia-directed phrasing still drops."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User needs to prepare a presentation by Monday"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to finish the report by Friday"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to write a proposal about the merger"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User plans to build a deck for the offsite"
        ) is None
        # A request OF Sophia (not own work) still drops.
        assert _candidate_policy_rejection_reason(
            "User wants a presentation about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants Sophia to build a deck about Q3"
        ) == "task_history"

    def test_request_verb_must_be_in_intent_not_subject(self):
        """Codex P2: the request verb must occur in the INTENT, not only the
        subject. 'User keeps a report about what the client requested in Q3' is a
        durable existing-artifact fact (the request verb is inside the topic), so
        it must be kept; 'asked for a report about Hermes' (verb in intent) drops."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User keeps a report about what the client requested in Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User has a deck about what the team wanted for the launch"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for a report about Hermes"
        ) == "task_history"

    def test_causative_and_want_need_sophia_directed_builds_drop(self):
        """Codex P2: a Sophia-directed build framed causatively ('wants to have
        Sophia build a report about OpenClaw', 'get Sophia to build a deck') or
        with want/need ('wants Sophia to build a report generator for OpenClaw',
        'needs you to create a PDF tool') must drop — not be kept as own-work or
        the user's own project."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants to have Sophia build a report about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants to get Sophia to build a deck about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants Sophia to build a report generator for OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User needs you to create a PDF tool for Acme"
        ) == "task_history"
        # The user's own project (no Sophia direction) still keeps.
        assert _candidate_policy_rejection_reason(
            "User wants to create a report generator for their startup"
        ) is None

    def test_passive_third_party_request_is_preserved(self):
        """Codex P2: a passive third-party request ('User was requested by their
        boss to draft a deck about Q3', 'was asked by HR to …') is a work
        obligation, not a request made of Sophia — the third-party guard's passive
        'by <party>' arm keeps it."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User was requested by their boss to draft a deck about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User was asked by HR to prepare a report about compliance"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User was tasked by the client to build a deck about pricing"
        ) is None
        # A direct user->Sophia request still drops.
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a deck about pricing"
        ) == "task_history"

    def test_requested_to_sophia_project_build_drops(self):
        """Codex P2: _SOPHIA_DIRECTED_RE must recognize 'requested' forms too, so
        'requested Sophia to build a report generator for OpenClaw' is not exempted
        as the user's own project."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User requested Sophia to build a report generator for OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested me to build a slide tool for the launch"
        ) == "task_history"
        # The user's own project (no Sophia direction) still keeps.
        assert _candidate_policy_rejection_reason(
            "User wants to create a report generator for their startup"
        ) is None

    def test_format_extension_deliverables_csv_json_markdown(self):
        """Codex P2: format/extension deliverables the dispatch recognizes
        (csv/json/markdown/docx/xlsx/excel) are weak nouns — drop topic-scoped or
        create-cued."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a CSV about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a JSON about the config"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to write a markdown about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a docx about Q3"
        ) == "task_history"

    def test_client_requirements_specs_are_source_material(self):
        """Codex P2: 'from client requirements/specs/briefs' is source material the
        deliverable is built FROM, not a third-party producer — those must drop."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report from client requirements about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a report from the client's specs about Q3"
        ) == "task_history"
        # Genuine producer still kept.
        assert _candidate_policy_rejection_reason(
            "User asked for a report from their manager about Q3"
        ) is None

    def test_asked_if_assistant_could_build_is_task_history(self):
        """Codex P2: an indirect 'asked if/whether <assistant> could/can <create>'
        build request ('asked if Sophia could build a presentation about Hermes')
        is task history."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked if Sophia could build a presentation about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked whether you could create a report about Q3"
        ) == "task_history"
        # 'asked if' with no create cue / deliverable is not a build request.
        assert _candidate_policy_rejection_reason(
            "User asked if the meeting went well"
        ) is None

    def test_requests_that_relative_clause_is_not_a_request_verb(self):
        """Codex P2: 'requests that <verb>' (a relative clause on the noun
        'requests') must not match as a request verb — 'feature requests that
        mention reports' is durable project context. 'requested that a report be
        created' (verb + article) still drops."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User tracks feature requests that mention reports in Linear"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User requested that a report be created about Hermes"
        ) == "task_history"

    def test_requests_as_plural_noun_is_not_a_request_verb(self):
        """Codex P2: 'requests' as a plural NOUN ('feature requests', 'support
        requests') must not satisfy the request gate. It counts only as a verb
        governing a deliverable (followed by a determiner/number/'to'/'creation
        of')."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User tracks feature requests in a spreadsheet"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User triages support requests for the team"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User requested feedback on the proposal"
        ) is None
        # Verb uses governing a deliverable still drop.
        assert _candidate_policy_rejection_reason(
            "User requested a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested creation of a PDF about the merger"
        ) == "task_history"
        # Third-party redirect with 'requested' still kept.
        assert _candidate_policy_rejection_reason(
            "User requested their manager to create a report about Q3"
        ) is None

    def test_sophia_directed_re_covers_all_directed_verbs(self):
        """Codex P2: _SOPHIA_DIRECTED_RE must cover the same directed verbs as the
        request gate (incl. tasked/instructed/directed), else a Sophia-directed
        project build like 'instructed Sophia to build a report generator for
        OpenClaw' is wrongly kept as the user's own project."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User instructed Sophia to build a report generator for OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User tasked Sophia to build a report tool for Acme"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User directed me to create a slide builder for X"
        ) == "task_history"
        # The user's own project (no Sophia direction) still keeps.
        assert _candidate_policy_rejection_reason(
            "User wants to create a report generator for their startup"
        ) is None

    def test_directed_verbs_in_request_gate(self):
        """Codex P2: the request gate must accept non-ask directed verbs (told/
        had/got/expects … Sophia/me/you/us), else 'User told Sophia to build a
        report about OpenClaw' never reaches the Sophia-directed/deliverable
        checks and is kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User told Sophia to build a report about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User had me create a deck about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User got Sophia to build a report generator for OpenClaw"
        ) == "task_history"

    def test_outline_file_canvas_deliverable_nouns(self):
        """Codex P2: outline/file/canvas are companion build-intent artifacts —
        weak deliverable nouns that drop topic-scoped or create-cued."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create an outline about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a file about Q3 metrics"
        ) == "task_history"

    def test_visual_of_subject_is_task_history(self):
        """Codex P2: a build-visual scoped by 'of <subject>' ('chart of Q2
        revenue', 'diagram of the architecture') is a build — 'of' introduces the
        data the visual depicts. 'image of …' is excluded (an existing photo)."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a chart of Q2 revenue"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a diagram of the architecture"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a graph of monthly sales"
        ) == "task_history"
        # "image of <X>" stays (usually an existing photo); no request verb stays.
        assert _candidate_policy_rejection_reason(
            "User wants an image of the beach for their wallpaper"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User has a chart of the org structure"
        ) is None

    def test_present_tense_directed_verbs_are_task_history(self):
        """Codex P2: the request gate must cover present-tense directed verbs
        ('tells/tasks/has Sophia ...') that _SOPHIA_DIRECTED_RE already recognizes,
        or _is_deliverable_request returns False before the Sophia-direction check
        runs and the prior build subject survives."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User tells Sophia to build a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User tasks Sophia to build a deck about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User has Sophia make a deck about pricing"
        ) == "task_history"

    def test_support_word_modifying_deliverable_is_task_history(self):
        """Codex P2: a support word used as an ADJECTIVE on a deliverable ('a
        feedback report', 'a critique report') is a one-off report build, not a
        support request — it must drop. A support word that is the actual request
        OBJECT ('feedback on their presentation', 'critique on their pitch deck')
        is still kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants a feedback report about Q3 performance"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a critique report about the launch"
        ) == "task_history"
        # The guard also covers web / PPTX deliverable aliases that live outside
        # _DELIVERABLE_NOUNS ("a critique PowerPoint", "a feedback website"),
        # including their PLURAL forms ("feedback websites", "critique web apps").
        assert _candidate_policy_rejection_reason(
            "User asked for a critique PowerPoint about the launch"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a feedback website about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants feedback websites about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for critique web apps about launch"
        ) == "task_history"
        # The support word as the true object is still exempt.
        assert _candidate_policy_rejection_reason(
            "User wants feedback on their presentation about Q2"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants critique on their pitch deck"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants feedback on their website"
        ) is None

    def test_deliverable_from_source_material_is_task_history(self):
        """Codex P2: a singular deliverable built FROM source material ('a PDF from
        customer feedback', 'a summary from client notes') is a build — the
        'from <source-material>' phrase is the input Sophia synthesizes. A
        third-party PRODUCER ('a PDF from the vendor') is still kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a PDF from customer feedback"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a summary from client notes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a deck from the survey responses"
        ) == "task_history"
        # The source-material noun may carry modifiers ("customer support TICKETS",
        # "client discovery-call NOTES") — checked before the third-party producer
        # exemption so a modified source phrase still drops.
        assert _candidate_policy_rejection_reason(
            "User asked for a PDF from customer support tickets"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a summary from client discovery-call notes"
        ) == "task_history"
        # The guard also fires in the TOPIC branch (a trailing "about <subject>"
        # routes there) — it runs before the third-party producer exemption.
        assert _candidate_policy_rejection_reason(
            "User asked for a PDF from customer support tickets about refunds"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a summary from client discovery-call notes about churn"
        ) == "task_history"
        # A third-party producer (a person/org makes it) is kept — including when a
        # source noun appears in a SEPARATE later phrase ("about the feedback").
        assert _candidate_policy_rejection_reason(
            "User asked for a PDF from the vendor"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for a report from the manager about the feedback"
        ) is None

    def test_document_of_subject_is_task_history(self):
        """Codex P2: a singular weak DOCUMENT deliverable scoped by 'of <subject>'
        ('an executive summary of Q3 revenue', 'an outline of the proposal') is a
        one-off build — the builder treats summary as a buildable document type, and
        'of' introduces the subject. Plural ('summaries of the meetings') or definite
        ('the summary of the book club') forms read as existing-artifact retrieval
        and are kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User needs an executive summary of Q3 revenue"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a summary of the merger"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants an outline of the proposal"
        ) == "task_history"
        # Plural / definite forms read as existing-artifact retrieval — kept.
        assert _candidate_policy_rejection_reason(
            "User keeps summaries of all their meetings"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for the summary of the book club"
        ) is None
        # A standing preference over summaries is kept.
        assert _candidate_policy_rejection_reason(
            "User prefers concise summaries"
        ) is None

    def test_visual_deliverables_chart_image_diagram(self):
        """Codex P2: visual deliverables the builder produces (chart, image,
        diagram, graph, …) are weak deliverable nouns — drop topic-scoped or
        create-cued, while an existing-photo use stays."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a diagram about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a chart about Q3 revenue"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to make an image about the brand"
        ) == "task_history"
        # An existing photo (weak noun, no topic/create cue) stays.
        assert _candidate_policy_rejection_reason(
            "User wants an image of the beach for their wallpaper"
        ) is None

    def test_document_deliverables_proposal_memo_etc(self):
        """Codex P2: common document deliverables (proposal, memo, whitepaper,
        newsletter, essay) the builder produces are weak nouns — drop topic-scoped
        or create-cued."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to draft a proposal about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a memo about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a whitepaper about the protocol"
        ) == "task_history"

    def test_single_page_app_is_a_web_deliverable(self):
        """Codex P2: 'single-page app/site' is dispatched as frontend
        (_HTML_OUTPUT_RE), so it must be a recognized web deliverable."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a single-page app about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a single page site about pricing"
        ) == "task_history"

    def test_export_render_are_creation_cues(self):
        """Codex P2: export/render are build cues (PDF dispatch accepts
        'render/export … as PDF'), so a weak deliverable phrased 'export Hermes as
        a PDF' is task history without an explicit 'about'."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to export Hermes as a PDF"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to render Hermes as a PDF"
        ) == "task_history"

    def test_sophia_directed_generator_build_with_for_drops(self):
        """Codex P2: a project/product compound is the user's own work only when
        NOT Sophia-directed. 'asked Sophia to build a report generator for
        OpenClaw' ('for', not 'about', so no topic marker) is a build request and
        drops; the user's own 'a report generator for their startup' stays."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report generator for OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked to build a slide tool for the Hermes launch"
        ) == "task_history"
        # The user's own project (no Sophia direction) still keeps.
        assert _candidate_policy_rejection_reason(
            "User wants to create a report generator for their startup"
        ) is None

    def test_transformation_output_verbs_are_creation_cues(self):
        """Codex P2: content-production / transformation verbs (summarize, compile,
        collate, assemble, turn/convert … into) are build cues, so a weak
        deliverable phrased as 'summarize Hermes in a PDF' or 'turn the notes into
        a document' is task history even without an explicit 'about <topic>'."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to summarize Hermes in a PDF"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to compile the findings into a document"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked to convert the spec into a PDF"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked me to turn the notes into a deck"
        ) == "task_history"  # Sophia-directed; "wants to turn …" alone is own-work (kept)
        # No deliverable noun (verbal summary) or no request verb → kept.
        assert _candidate_policy_rejection_reason(
            "User asked me to summarize the meeting"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User summarizes their day in a journal"
        ) is None

    def test_builder_deliverable_types_summary_brief_article_explainer(self):
        """Codex P2: summary/brief/article/explainer are deliverable types the
        builder dispatches (HTML/PDF output regexes). They are WEAK nouns (verb
        'brief me', adjective 'brief chat', 'read an article'), so they drop only
        when topic-scoped or create-cued, and a bare/verbal/adjectival use stays."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a brief about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a summary about the Q3 numbers"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for an article about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to write an explainer about pricing"
        ) == "task_history"
        # Verb 'to brief', adjective 'brief chat', and reading an article are kept.
        assert _candidate_policy_rejection_reason(
            "User asked me to brief them about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants a brief chat before the call"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User read an article about competitors"
        ) is None

    def test_powerpoint_aliases_are_task_history(self):
        """Codex P2: the dispatch (`start_builder_task._PPTX_OUTPUT_RE`) routes
        'PowerPoint'/'pptx'/'power point' as a presentation build, so a prior
        'User asked for a PowerPoint about Hermes' memory must drop as task_history
        too (these aliases were absent from the deliverable noun set)."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a PowerPoint about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a pptx about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a power point about the pricing model"
        ) == "task_history"

    def test_deliverable_requested_from_third_party_is_preserved(self):
        """Codex P2: a deliverable the user requested FROM a third party
        ('a report from their manager about Q3') is a workflow/relationship fact —
        the third party produces it, not Sophia — so the third-party guard's new
        'from <party>' arm keeps it."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a report from their manager about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants a deck from the team about sales"
        ) is None
        # External producers (vendor/supplier/contractor/agency/consultant/...) are
        # recognized parties too, so a STRONG-noun deliverable from them is kept.
        assert _candidate_policy_rejection_reason(
            "User asked for a report from the vendor"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants a report from the contractor"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for a report from the consultant about Q3"
        ) is None
        # A direct build (third party is data source, not producer) still drops.
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report from scratch about Hermes"
        ) == "task_history"
        # 'vendor' as a topic word (not a producer) still drops.
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report about vendor management"
        ) == "task_history"

    def test_from_party_source_material_is_not_a_producer(self):
        """Codex P2: 'from <party>' counts as a third-party producer only when the
        party is the producer, NOT when it modifies source material ("from customer
        feedback", "from the client notes") — there Sophia builds the deliverable
        FROM that material, so it must still drop."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a report from customer feedback about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a report from the client notes about Hermes"
        ) == "task_history"
        # Possessive source material ("from the client's notes", "from their
        # manager's feedback") is also build input, not a producer — still drops.
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report from the client's notes about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a report from their manager's feedback about Q3"
        ) == "task_history"
        # Genuine producer (party is the head, not a material adjunct) still kept.
        assert _candidate_policy_rejection_reason(
            "User asked for a report from their manager about Q3"
        ) is None

    def test_sophia_directed_project_build_with_subject_drops(self):
        """Codex P2: a project/product compound is the user's own work only when
        there is NO subject. A Sophia-directed build of a generator/tool WITH a
        subject ("build a report generator about OpenClaw") is a build request and
        must drop; the user's own project ("a report generator for their startup")
        still keeps."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to build a report generator about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a presentation app about the merger"
        ) == "task_history"
        # No subject → the user's own project is kept.
        assert _candidate_policy_rejection_reason(
            "User wants to create a report generator for their startup"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants to build a report tool"
        ) is None

    def test_would_like_is_a_request_verb(self):
        """Codex P2: a polite 'would like' / "'d like" build request ('User would
        like a report about OpenClaw') must be recognized as task history — the
        verb list previously only covered ask/request/want/need."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User would like a report about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User would like a deck about pricing"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User'd like a presentation on Q3"
        ) == "task_history"
        # 'would like' with no deliverable noun, or with a help cue, is still kept.
        assert _candidate_policy_rejection_reason(
            "User would like to feel calmer at work"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User would like help with a presentation"
        ) is None

    def test_requested_third_party_redirect_is_preserved(self):
        """Codex P2: a user→third-party redirect phrased with 'requested'
        ('User requested their manager to create a report about Q3') is a
        relationship/work fact, not a build request made of Sophia — the redirect
        guard must include requested/requests, not only asked/wanted/etc."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User requested their manager to create a report about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User requested their boss to build a deck about sales"
        ) is None
        # A direct user→Sophia request (no third party) still drops.
        assert _candidate_policy_rejection_reason(
            "User requested a report about Q3"
        ) == "task_history"

    def test_adjectival_preferred_does_not_exempt_a_concrete_build(self):
        """Codex P2: an adjectival 'preferred' inside a concrete (singular) build
        request must not short-circuit it into a kept delivery preference. The
        one-off SINGULAR/deadline check runs before the prefer shortcut, so
        'requested a report in their preferred format for OpenClaw' drops, while a
        generic standing preference (no singular article) is still kept."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User requested a report in their preferred format for OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested a deck using their preferred template for Hermes"
        ) == "task_history"
        # Same, but WITH a subject marker (topic branch): the adjectival
        # "preferred" must not exempt the concrete singular build.
        assert _candidate_policy_rejection_reason(
            "User requested a report in their preferred format about OpenClaw"
        ) == "task_history"
        # Generic standing preferences (no singular article / deadline) stay.
        assert _candidate_policy_rejection_reason(
            "User wants their reports concise for the board"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants their preferred format used in reports"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User prefers concise reports, no bullet lists"
        ) is None

    def test_addressed_asked_for_build_requests_are_task_history(self):
        """Codex P2: 'asked me/you/us for a <deliverable>' (recipient before
        'for') is a build request, just like 'asked for'."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked me for a report about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked you for a deck about pricing"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked us for a presentation on Q3"
        ) == "task_history"
        # 'asked me <non-for/to>' is not a build request.
        assert _candidate_policy_rejection_reason(
            "User asked me how their presentation went"
        ) is None

    def test_intervening_time_phrase_in_asked_for_request(self):
        """Codex P2: a legacy memory often records WHEN the ask happened
        ('asked on Tuesday for a report', 'asked yesterday for a deck'). The
        for-arm / to-arm previously required 'for'/'to' to immediately follow
        'asked' or the recipient, so the time phrase blocked the match and the
        prior task-history row contaminated a new build. A tightly scoped
        temporal adverbial is now allowed between them."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked on Tuesday for a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked yesterday for a deck about pricing"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked me yesterday to build a report about the launch"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked on Monday to create a deck about the merger"
        ) == "task_history"
        # Recipient + time + for, where the bare "asked sophia" arm can't help.
        assert _candidate_policy_rejection_reason(
            "User asked me last week for a report about onboarding"
        ) == "task_history"
        # The time phrase must NOT let a TOPIC phrase masquerade as the for-arm:
        # "asked about the report for the team" is asking about an existing
        # artifact, and "on pricing" is a topic, not a weekday — both kept.
        assert _candidate_policy_rejection_reason(
            "User asked about the report for the team"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked on pricing for clarity"
        ) is None
        # Still no deliverable noun → kept even with a time phrase + request verb.
        assert _candidate_policy_rejection_reason(
            "User asked on Tuesday for help with their anxiety"
        ) is None

    def test_on_the_count_is_a_subject_not_a_date(self):
        """Codex P2: 'on the <number>' without an ordinal suffix ('on the 3
        options') is a count/subject, not a date — only 'on the 5th' is temporal."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a document on the 3 options"
        ) == "task_history"
        # 'on the 5th' (ordinal) stays temporal; the dated request still drops.
        assert _candidate_policy_rejection_reason(
            "User asked on the 12th for a report about pricing"
        ) == "task_history"

    def test_doc_page_deliverable_nouns(self):
        """Codex P2: doc/page are document build nouns in BuilderCommandMiddleware
        — weak deliverable nouns that drop topic-scoped or create-cued."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a doc about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a page about OpenClaw"
        ) == "task_history"

    def test_by_the_actor_is_not_a_deadline(self):
        """Codex P2: 'by the <actor>' ('reviewed by the team') is a passive agent,
        not a deadline, so it must not break a standing delivery preference. 'by
        the end / the 5th / Friday' stays a deadline."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User wants reports to be reviewed by the team before delivery"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User wants reports to be signed off by the lead"
        ) is None
        # A real deadline still makes a singular styled request a one-off build.
        assert _candidate_policy_rejection_reason(
            "User wants a concise report by the end of day"
        ) == "task_history"

    def test_numeric_on_count_is_a_subject_not_a_date(self):
        """Codex P2: a bare 'on <number>' that COUNTS the subject ('a PDF on 10
        competitors', 'document on 3 options') is a subject marker, not a date —
        only an ordinal ('on the 5th') is temporal. So the weak deliverable + this
        subject drops."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a PDF on 10 competitors"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a document on 3 options"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wants a report on 5 key metrics"
        ) == "task_history"
        # A genuine dated request (ordinal) still works (drops via the report).
        assert _candidate_policy_rejection_reason(
            "User asked on the 12th for a report about pricing"
        ) == "task_history"

    def test_absolute_date_time_phrase_in_asked_for_request(self):
        """Codex P2: the extraction prompt resolves temporals to ABSOLUTE dates,
        so the time phrase between asked/recipient and for/to must accept dates
        ("asked on June 12 for a report", "on 2026-06-12", "on 06/12", "on the
        12th"), not only weekdays/relative phrases."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked on June 12 for a report about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked on 2026-06-12 for a deck"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked on 06/12 for a PDF about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked on the 12th for a report about pricing"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked on June 12 to build a deck about Q3"
        ) == "task_history"
        # A genuine subject "on X" (not a date) where the deliverable follows is
        # still kept.
        assert _candidate_policy_rejection_reason(
            "User wants to focus on the presentation next week"
        ) is None

    def test_extended_deliverable_nouns_are_caught_lexically(self):
        """Codex P2: the lexical noun list (used by the synchronous companion
        filter with no LLM pass) must cover write-up / infographic / spreadsheet,
        matching the classifier prompt."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for a spreadsheet on Q3 revenue"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for an infographic about burnout"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a write-up on the incident"
        ) == "task_history"

    def test_creation_cue_makes_weak_noun_a_task_history_request(self):
        """A weak noun + request verb + explicit create/build cue IS a build request."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User requested creation of a PDF about the merger"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia to put together the onboarding materials"
        ) == "task_history"

    def test_bare_write_is_a_creation_cue_for_weak_nouns(self):
        """Codex P2: bare 'write' (not just 'write up') is a create cue, so a weak
        deliverable like 'write a PDF/document about X' drops on the lexical path."""
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to write a PDF about onboarding"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User wanted me to write a document about the reorg"
        ) == "task_history"
        # No request verb → the user's own writing is preserved.
        assert _candidate_policy_rejection_reason(
            "User wrote a PDF about their trip"
        ) is None

    def test_preference_short_circuit_matches_verb_not_topic(self):
        """Codex P2: the 'prefer' guard keys on the preference verb, not a topic.

        'report on consumer preferences' must NOT exempt itself via the topic
        word 'preferences' — it is a genuine build request (strong noun 'report')
        and is dropped. A genuine delivery preference (the prefer *verb*) is
        preserved even when it also carries a build verb and noun.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        # Topic noun 'preferences' no longer exempts; strong noun 'report' makes
        # this the build request the original Codex review wanted dropped.
        assert _candidate_policy_rejection_reason(
            "User requested a report on consumer preferences"
        ) == "task_history"
        # A real delivery preference is preserved even with verb + creation + noun.
        assert _candidate_policy_rejection_reason(
            "User wanted me to make reports the way they prefer"
        ) is None

    def test_builder_visual_request_markers_are_deliverable_nouns(self):
        """Codex P2: visual-request markers the builder dispatches on
        (BuilderTaskMiddleware._VISUAL_REQUEST_MARKERS) — timeline/map/matrix/
        quadrant/visual/visualization — must count as deliverable nouns so a
        legacy 'asked Sophia to make a timeline about X' memory drops as
        task_history instead of contaminating a new subject.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked Sophia to create a timeline about Hermes"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a matrix about the competitive options"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User requested a quadrant about the portfolio"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked for a visualization about the funnel"
        ) == "task_history"
        # Ordinary, non-request uses of these weak nouns are preserved.
        assert _candidate_policy_rejection_reason(
            "User keeps a timeline of the family's history"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User showed me a map of the hiking trail"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User is in the upper-right quadrant of the chart"
        ) is None

    def test_passive_asked_if_build_request_is_task_history(self):
        """Codex P2: the asked-if/whether arm matched only a modal IMMEDIATELY
        followed by a creation verb, so passive phrasing where the verb trails a
        'be'/'get' ('asked whether a report could BE created', '... can BE made')
        slipped through. The arm now tolerates the passive auxiliary, and the
        topic-scoped resolver recognizes the whole-string pattern even when the
        topic split strips the trailing modal+verb out of the request intent.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked whether a report about Hermes could be created"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked whether a deck can be made about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked if a summary could be generated about the merger"
        ) == "task_history"
        # Recipient-prefixed asked-if ("asked ME/YOU/US if/whether ... could ...").
        assert _candidate_policy_rejection_reason(
            "User asked me if I could make a deck about OpenClaw"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked you whether we could build a report about Q3"
        ) == "task_history"
        assert _candidate_policy_rejection_reason(
            "User asked Sophia whether she could draft a summary about the merger"
        ) == "task_history"
        # Third-party pronoun recipients (him/her/them) are work delegated to OTHER
        # people — a durable delegation fact, not a build request to Sophia — kept.
        assert _candidate_policy_rejection_reason(
            "User asked them if they could make a deck about OpenClaw"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked him whether he could build a report about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked her if she could create a presentation about pricing"
        ) is None
        # An asked-if WITHOUT a build verb is a status/approval question — kept.
        assert _candidate_policy_rejection_reason(
            "User asked if the report about Hermes is ready"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked whether the deck about Q3 was approved"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked me if the report about Hermes is ready"
        ) is None
        # An asked-if whose SUBJECT is a named third party ("asked if the client
        # could make ...") is delegation/relationship context, not a Sophia build —
        # kept. (Pronoun subjects stay ambiguous with Sophia and still drop above.)
        assert _candidate_policy_rejection_reason(
            "User asked if the client could make a deck about OpenClaw"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked whether the boss could build a report about Q3"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked me if the team could make a deck about pricing"
        ) is None


class TestTaskHistoryLLMClassifier:
    """The Haiku task-history classifier and its integration into the filter."""

    @staticmethod
    def _client_returning(text: str):
        client = MagicMock()
        client.messages.create.return_value = _make_anthropic_response(text)
        return client

    def test_returns_flagged_indices(self):
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = self._client_returning("[0, 2]")
        result = _classify_task_history_with_llm(
            [
                "User asked to build a report about Hermes",
                "User's name is Davide",
                "User wants a deck on Q3 revenue",
            ],
            client=client,
        )
        assert result == {0, 2}

    def test_empty_contents_makes_no_call(self):
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = MagicMock()
        assert _classify_task_history_with_llm([], client=client) == set()
        client.messages.create.assert_not_called()

    def test_unparseable_response_returns_none(self):
        # P1: non-JSON response must be a FAILURE (None) so the caller falls back
        # to lexical — NOT an empty set, which would drop nothing.
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = self._client_returning("sorry, I cannot help with that")
        assert _classify_task_history_with_llm(["x"], client=client) is None

    def test_non_index_response_returns_none(self):
        # Valid JSON, but a list carrying no integer indices (objects/prose) is a
        # malformed classifier response → None (fallback), not "flag nothing".
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = self._client_returning('[{"content": "x"}]')
        assert _classify_task_history_with_llm(["x"], client=client) is None

    def test_empty_list_response_is_empty_success(self):
        # A clean empty list is a successful "flag nothing" — a set, not None.
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = self._client_returning("[]")
        assert _classify_task_history_with_llm(["x"], client=client) == set()

    def test_out_of_range_and_bool_indices_ignored(self):
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = self._client_returning("[0, 5, true]")
        assert _classify_task_history_with_llm(["only one entry"], client=client) == {0}

    def test_only_out_of_range_indices_returns_none(self):
        # P2: a non-empty list with NO valid in-range index (e.g. [5] for one
        # candidate) is a misnumbered response → None (fallback), not an empty set
        # that would bypass the lexical filter and let a build request through.
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = self._client_returning("[5]")
        assert _classify_task_history_with_llm(["only one entry"], client=client) is None
        client = self._client_returning("[5, 6]")
        assert _classify_task_history_with_llm(["a", "b"], client=client) is None

    def test_client_error_returns_none(self):
        # P1: an API error must be a FAILURE (None) → lexical fallback.
        from deerflow.sophia.extraction import _classify_task_history_with_llm

        client = MagicMock()
        client.messages.create.side_effect = Exception("rate limit")
        assert _classify_task_history_with_llm(["x"], client=client) is None

    def test_filter_sends_reviewable_candidates_to_llm(self):
        from deerflow.sophia.extraction import _filter_policy_rejected_entries

        entries = [
            {"content": "User's name is Davide"},                          # reviewable, kept
            {"content": "User mused an obscure phrasing the regex misses"}, # reviewable, LLM flags
            {"content": "User's temporary password is hunter2"},            # lexical credential hard-drop
        ]
        seen = {}

        def stub(contents):
            seen["contents"] = list(contents)
            return {1}

        result = _filter_policy_rejected_entries(entries, llm_classifier=stub)
        assert [e["content"] for e in result] == ["User's name is Davide"]
        # The classifier sees all reviewable candidates (credential hard-dropped first).
        assert seen["contents"] == [
            "User's name is Davide",
            "User mused an obscure phrasing the regex misses",
        ]

    def test_llm_is_authoritative_and_clears_lexical_task_history(self):
        """Finding 1b: a lexical task_history flag must NOT pre-empt the LLM. If
        the LLM clears a lexically-flagged candidate, it is kept."""
        from deerflow.sophia.extraction import _filter_policy_rejected_entries

        entries = [{"content": "User asked for a report about Hermes"}]  # lexical flags this
        seen = {}

        def stub(contents):
            seen["contents"] = list(contents)
            return set()  # LLM says: not task history → keep

        result = _filter_policy_rejected_entries(entries, llm_classifier=stub)
        assert [e["content"] for e in result] == ["User asked for a report about Hermes"]
        # The lexically-flagged candidate was still handed to the LLM to review.
        assert seen["contents"] == ["User asked for a report about Hermes"]

    def test_lexical_fallback_drops_task_history_when_no_llm(self):
        """Without a classifier, the lexical signal is the fallback and still drops."""
        from deerflow.sophia.extraction import _filter_policy_rejected_entries

        entries = [
            {"content": "User asked for a report about Hermes"},
            {"content": "User's name is Davide"},
        ]
        result = _filter_policy_rejected_entries(entries, llm_classifier=None)
        assert [e["content"] for e in result] == ["User's name is Davide"]

    def test_filter_llm_failure_falls_back_to_lexical(self):
        from deerflow.sophia.extraction import _filter_policy_rejected_entries

        # A lexically-flagged build request + a durable fact; the classifier errors.
        entries = [
            {"content": "User asked for a report about Hermes"},
            {"content": "User's name is Davide"},
        ]

        def boom(_contents):
            raise RuntimeError("classifier down")

        # On LLM failure the lexical signal is the fallback: drop the build request,
        # keep the durable fact.
        result = _filter_policy_rejected_entries(entries, llm_classifier=boom)
        assert [e["content"] for e in result] == ["User's name is Davide"]

    def test_filter_falls_back_to_lexical_when_classifier_returns_none(self):
        """P1: a classifier that swallows its error and returns None (the real
        _classify_task_history_with_llm contract on failure) must NOT be read as
        'drop nothing' — the lexical signal is the fallback."""
        from deerflow.sophia.extraction import _filter_policy_rejected_entries

        entries = [
            {"content": "User asked for a report about Hermes"},  # lexical build-request hit
            {"content": "User's name is Davide"},
        ]
        # Returns None (not raises), exactly like the helper on a malformed/failed call.
        result = _filter_policy_rejected_entries(entries, llm_classifier=lambda _c: None)
        assert [e["content"] for e in result] == ["User's name is Davide"]

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_llm_classifier_drops_lexical_miss_end_to_end(self, mock_anthropic_mod, mock_add_memories):
        """A build request the lexical filter misses is dropped by the Haiku pass."""
        from deerflow.sophia.extraction import extract_session_memories

        extraction = json.dumps([
            {"content": "User's name is Davide", "category": "fact", "importance": 0.9, "metadata": {}},
            {"content": "User mused an obscure phrasing the regex misses", "category": "fact", "importance": 0.6, "metadata": {}},
        ])
        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        # 1st create() = extraction, 2nd create() = task-history classifier flagging index 1.
        mock_client.messages.create.side_effect = [
            _make_anthropic_response(extraction),
            _make_anthropic_response("[1]"),
        ]
        mock_add_memories.return_value = [{"id": "m"}]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_llm_drop",
            messages=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
            session_metadata=_SESSION_METADATA,
        )

        assert [r["content"] for r in result] == ["User's name is Davide"]
        assert mock_add_memories.call_count == 1
