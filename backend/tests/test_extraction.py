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
        """Codex P2 round 2: a WEAK/ambiguous noun + request verb is NOT enough.

        'document'/'material'/'pdf' could name an existing artifact, so a request
        for one needs an explicit create/build cue before we drop it. Otherwise
        durable context ("asked for HR documents after the incident") is lost.
        """
        from deerflow.sophia.extraction import _candidate_policy_rejection_reason

        assert _candidate_policy_rejection_reason(
            "User asked for HR documents after the incident"
        ) is None
        assert _candidate_policy_rejection_reason(
            "User asked for the onboarding materials"
        ) is None

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
