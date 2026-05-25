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
    def test_malformed_json_raises_extraction_parse_error(self, mock_anthropic_mod, mock_add_memories):
        """Malformed JSON response -> raise ExtractionParseError so caller can retry.

        Contract change (H.1): previously this returned `[]` and was indistinguishable
        from a legitimate empty result, causing the offline pipeline's idempotency
        guard to lock the session permanently. Now the pipeline catches this and
        leaves the session unprocessed for a future retry.
        """
        from deerflow.sophia.extraction import ExtractionParseError, extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            "This is not valid JSON at all {{{}"
        )

        with pytest.raises(ExtractionParseError):
            extract_session_memories(
                user_id="user1",
                session_id="sess_002",
                messages=_SAMPLE_MESSAGES,
                session_metadata=_SESSION_METADATA,
            )

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
        assert call_kwargs["wait_for_events"] is False

        meta = call_kwargs["metadata"]
        assert meta["review_status"] == "pending_review"
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
    def test_non_list_response_raises_extraction_parse_error(self, mock_anthropic_mod, mock_add_memories):
        """Response that parses as JSON but is not a list -> raise ExtractionParseError.

        Contract change (H.1): a JSON object instead of an array is a malformed
        extraction response — retryable like other parse errors.
        """
        from deerflow.sophia.extraction import ExtractionParseError, extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            '{"error": "unexpected format"}'
        )

        with pytest.raises(ExtractionParseError):
            extract_session_memories(
                user_id="user1",
                session_id="sess_011",
                messages=_SAMPLE_MESSAGES,
            )

        mock_add_memories.assert_not_called()

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_bare_markdown_fence_returns_empty_not_raises(self, mock_anthropic_mod, mock_add_memories):
        """Bare fence (LLM returned no body) -> return [] cleanly, not ExtractionParseError.

        H.1 short-circuit: when ``_strip_markdown_fences("```json")`` produces an empty
        string, treat it as "LLM legitimately said nothing" rather than a parse error.
        Retrying wouldn't help — Claude already declined to extract anything.
        """
        from deerflow.sophia.extraction import extract_session_memories

        for bare_fence in ("```json", "```json\n", "```json\n\n```", "```\n```", "   ```json   "):
            mock_client = MagicMock()
            mock_anthropic_mod.Anthropic.return_value = mock_client
            mock_client.messages.create.return_value = _make_anthropic_response(bare_fence)

            result = extract_session_memories(
                user_id="user1",
                session_id="sess_bare_fence",
                messages=_SAMPLE_MESSAGES,
                session_metadata=_SESSION_METADATA,
            )

            assert result == [], f"Bare fence {bare_fence!r} should return [] cleanly"
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
        assert meta["review_status"] == "pending_review"

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


class TestSessionStartUnixAnchor:
    """Regression tests for the Upgrade A timestamp anchoring contract."""

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_missing_session_start_unix_passes_none_not_now(self, mock_anthropic_mod, mock_add_memories):
        """When session_start_unix is missing, add_memories MUST receive None.

        Codex P1 review on PR #130: the old behavior fell back to
        ``datetime.now(UTC).timestamp()``, which re-dated historical turns
        to ingestion time and broke Mem0 v3 temporal reasoning. Now we pass
        None so Mem0 uses its server-side default rather than us actively
        writing a wrong anchor.
        """
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[0]])
        )
        mock_add_memories.return_value = [{"id": "mem_1"}]

        # session_metadata WITHOUT session_start_unix
        metadata_no_anchor = {
            "session_date": "2026-03-27",
            "context_mode": "work",
            "platform": "text",
        }

        extract_session_memories(
            user_id="user1",
            session_id="sess_no_anchor",
            messages=_SAMPLE_MESSAGES,
            session_metadata=metadata_no_anchor,
        )

        assert mock_add_memories.call_count == 1
        kwargs = mock_add_memories.call_args.kwargs
        assert kwargs["timestamp"] is None, (
            "Missing session_start_unix MUST result in timestamp=None, "
            "NOT datetime.now() — falling back to now would re-date historical "
            "turns to ingestion time and break temporal queries"
        )

    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_present_session_start_unix_is_propagated(self, mock_anthropic_mod, mock_add_memories):
        """When session_start_unix is present, it MUST be passed as the timestamp."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[0]])
        )
        mock_add_memories.return_value = [{"id": "mem_1"}]

        # A specific historical timestamp — Mar 27 2026 12:00 UTC
        historical_anchor = 1774785600
        metadata_with_anchor = {
            "session_date": "2026-03-27",
            "context_mode": "work",
            "platform": "text",
            "session_start_unix": historical_anchor,
        }

        extract_session_memories(
            user_id="user1",
            session_id="sess_with_anchor",
            messages=_SAMPLE_MESSAGES,
            session_metadata=metadata_with_anchor,
        )

        kwargs = mock_add_memories.call_args.kwargs
        assert kwargs["timestamp"] == historical_anchor, (
            "Present session_start_unix MUST flow through unchanged "
            "(this is the Upgrade A anchor)"
        )


# ======================================================================
# Local review_metadata overlay write (PR #130 §I.1 — recap pipeline fix)
# ======================================================================


class TestReviewMetadataOverlayWrite:
    """Pin the contract that ``extract_session_memories`` writes to the local
    review_metadata overlay AFTER each successful Mem0 add.

    Recap pipeline fix on PR #130 §I.1: Mem0 v3 does NOT propagate
    event-level ``metadata.status`` onto the persisted memory record. Without
    the local-overlay write, every newly-extracted candidate has
    ``status=None`` when queried back via ``get_all``, so the gateway's
    ``_hydrate_memories_for_review`` strict ``status==pending_review`` filter
    drops them and the recap UI shows empty state.
    """

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_writes_review_overlay_with_resolved_memory_id(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """Happy path: Mem0 returned a resolved memory_id (sync path or
        successful event resolution). The overlay write MUST receive that
        memory_id so subsequent ``apply_review_metadata_overlays`` joins
        cleanly with the Mem0 record."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[0]])  # one "fact" candidate
        )
        # Mem0 returned a resolved memory_id — the wait_for_pending_events
        # succeeded (or sync path with no event_id at all).
        mock_add_memories.return_value = [
            {"id": "mem_resolved_abc", "memory": "User works as a PM"}
        ]

        extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_1",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert mock_upsert.call_count == 1, (
            "Overlay MUST be written exactly once per successful candidate"
        )
        call_kwargs = mock_upsert.call_args.kwargs
        assert call_kwargs["memory_id"] == "mem_resolved_abc", (
            "Resolved memory_id MUST be passed through so the overlay joins "
            "with the Mem0 record (review_metadata_store._select_entry "
            "matches on memory_id first)"
        )
        assert call_kwargs["content"] == _SAMPLE_EXTRACTION[0]["content"]
        assert call_kwargs["session_id"] == "sess_overlay_1"
        assert call_kwargs["sync_state"] == "extraction"
        assert call_kwargs["metadata"]["status"] == "pending_review", (
            "status=pending_review MUST land in the overlay metadata so "
            "_hydrate_memories_for_review's strict filter accepts it"
        )
        assert call_kwargs["metadata"]["review_status"] == "pending_review"
        # No mem0_event_id when we have a real memory_id — only the timeout
        # case needs the event_id for future reconciliation.
        assert "mem0_event_id" not in call_kwargs["metadata"]

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_writes_overlay_with_event_id_when_memory_id_missing(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """Bug A (wait_for_pending_events timeout) shape: ``add_memories``
        returns raw event-wrapper list ``[{"event_id": "evt_1", "memory": None}]``
        when the wait timed out. The overlay MUST still be written with
        ``memory_id=None`` (content_hash carries the entry) AND
        ``mem0_event_id`` stashed in metadata so a future reconciliation
        worker can backfill the real memory_id once events resolve."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[1]])  # "feeling" candidate
        )
        mock_add_memories.return_value = [
            {"event_id": "evt_pending_xyz", "memory": None}
        ]

        extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_timeout",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert mock_upsert.call_count == 1
        call_kwargs = mock_upsert.call_args.kwargs
        assert call_kwargs["memory_id"] is None, (
            "Bug-A timeout case: memory_id is unknown — overlay relies on "
            "content_hash keying (review_metadata_store handles None)"
        )
        assert call_kwargs["content"] == _SAMPLE_EXTRACTION[1]["content"]
        assert call_kwargs["sync_state"] == "pending", (
            "sync_state=pending signals reconcile_review_metadata_entries "
            "should backfill memory_id when the event eventually resolves"
        )
        assert call_kwargs["metadata"]["mem0_event_id"] == "evt_pending_xyz", (
            "event_id MUST be stashed in metadata so a future reconciler "
            "can match the timed-out event to its eventual memory_id"
        )
        assert call_kwargs["metadata"]["status"] == "pending_review"

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_writes_event_overlay_without_waiting_for_mem0_polling(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """Offline extraction must surface recap candidates from event handles
        immediately instead of blocking the UI on serial Mem0 event polling."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[1]])
        )
        mock_add_memories.return_value = [
            {"event_id": "evt_no_wait_123", "memory": None}
        ]

        extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_no_wait",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert mock_add_memories.call_args.kwargs["wait_for_events"] is False
        assert mock_upsert.call_count == 1
        call_kwargs = mock_upsert.call_args.kwargs
        assert call_kwargs["memory_id"] is None
        assert call_kwargs["session_id"] == "sess_overlay_no_wait"
        assert call_kwargs["sync_state"] == "pending"
        assert call_kwargs["metadata"]["mem0_event_id"] == "evt_no_wait_123"
        assert call_kwargs["metadata"]["status"] == "pending_review"

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_writes_overlay_for_dedupe_only_event_result(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """Mem0 v3 may resolve an ADD by linking older memories only.

        In that shape there is no new memory id, but the provider normalizer
        must preserve event_id so recap still gets a review overlay for this
        session's extracted candidate.
        """
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[1]])
        )
        mock_add_memories.return_value = [
            {"event_id": "evt_dedupe_123", "linked_memory_ids": ["mem_existing"]}
        ]

        extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_dedupe",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert mock_upsert.call_count == 1
        call_kwargs = mock_upsert.call_args.kwargs
        assert call_kwargs["memory_id"] is None
        assert call_kwargs["sync_state"] == "pending"
        assert call_kwargs["metadata"]["mem0_event_id"] == "evt_dedupe_123"
        assert call_kwargs["metadata"]["status"] == "pending_review"

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_overlay_failure_does_not_block_subsequent_writes(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """A corrupted local store MUST NOT take down the extraction loop.
        The Mem0 write is the durable record; the overlay is best-effort
        UX scaffolding. If upsert_review_metadata raises on candidate 1,
        candidate 2's Mem0 write must still happen."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        # Two candidates — make upsert raise on the FIRST one only.
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps(_SAMPLE_EXTRACTION[:2])
        )
        mock_add_memories.return_value = [{"id": "mem_x"}]
        mock_upsert.side_effect = [
            RuntimeError("local store IO error"),  # first candidate
            None,                                    # second candidate
        ]

        result = extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_resilient",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        # Both Mem0 writes happened — extraction loop continued past the
        # overlay failure.
        assert mock_add_memories.call_count == 2, (
            f"Mem0 writes MUST continue past local-overlay failures; "
            f"got {mock_add_memories.call_count} calls"
        )
        # Both candidates landed in the returned written_memories.
        assert len(result) == 2
        # Both overlay writes were attempted.
        assert mock_upsert.call_count == 2

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_skips_overlay_when_mem0_returns_empty(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """Codex P1 R14: when ``add_memories`` returns an empty list (Mem0
        client unavailable, ``client.add()`` raised, or
        ``Mem0EventFailedError`` was caught), the overlay write MUST be
        SKIPPED — not written with ``memory_id=None`` and no
        ``mem0_event_id``.

        Without this guard the overlay store accumulates "ghost"
        pending_review candidates with no tracking handle. They surface
        in /memories/recent (via the synthetic ``local:<hash>`` path)
        but were never persisted remotely and can never be reconciled
        with a real Mem0 memory, polluting the review UI with permanent
        false positives.
        """
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[0]])
        )
        # Mem0 unavailable / failed → returns [] (per add_memories contract
        # for unavailable / failed outcomes).
        mock_add_memories.return_value = []

        extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_no_handle",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert mock_upsert.call_count == 0, (
            f"Overlay MUST NOT be written when Mem0 returned no tracking "
            f"handle (memory_id or event_id). Got {mock_upsert.call_count} "
            f"upsert calls — these would create unreconciliable ghost "
            f"candidates in the review UI."
        )

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_skips_overlay_when_result_has_no_id_or_event_id(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """Defensive: even when ``add_memories`` returns a non-empty list,
        if the entries have neither a real ``id`` nor an ``event_id``
        (e.g. a malformed Mem0 response shape we don't recognise), the
        overlay write MUST still skip — same orphan-candidate reasoning."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps([_SAMPLE_EXTRACTION[0]])
        )
        # Result has SOME shape but no id and no event_id (e.g. malformed
        # response, or a synthetic ``local:`` placeholder which our
        # resolved_memory_id check explicitly filters out).
        mock_add_memories.return_value = [{"memory": "just text, no ids"}]

        extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_no_handle_v2",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        assert mock_upsert.call_count == 0, (
            "Overlay MUST skip when neither id nor event_id is present, "
            "regardless of whether the result list is empty or just lacks "
            "tracking handles."
        )

    @patch("deerflow.sophia.extraction.upsert_review_metadata")
    @patch("deerflow.sophia.extraction.add_memories")
    @patch("deerflow.sophia.extraction.anthropic")
    def test_extraction_writes_overlay_when_some_candidates_succeed_and_others_fail(
        self, mock_anthropic_mod, mock_add_memories, mock_upsert
    ):
        """Partial failure: candidate 1's Mem0 write succeeds (memory_id
        present), candidate 2's fails (empty list). Overlay MUST be
        written only for candidate 1; candidate 2 is skipped cleanly."""
        from deerflow.sophia.extraction import extract_session_memories

        mock_client = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client
        # Two candidates this time.
        mock_client.messages.create.return_value = _make_anthropic_response(
            json.dumps(_SAMPLE_EXTRACTION[:2])
        )
        # First add succeeds with a real memory_id; second fails (returns []).
        mock_add_memories.side_effect = [
            [{"id": "mem_succeeded", "memory": "ok"}],
            [],  # Mem0 outage / failed event between writes
        ]

        extract_session_memories(
            user_id="user1",
            session_id="sess_overlay_partial",
            messages=_SAMPLE_MESSAGES,
            session_metadata=_SESSION_METADATA,
        )

        # Only ONE overlay write — the successful one. The failed
        # candidate is correctly skipped.
        assert mock_upsert.call_count == 1, (
            f"Partial-failure case: expected exactly 1 overlay write "
            f"(for the successful candidate); got {mock_upsert.call_count}"
        )
        assert mock_upsert.call_args.kwargs["memory_id"] == "mem_succeeded"
