"""Voice normalizer sequence regressions."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from voice.realtime.events import ProviderEvent  # noqa: E402
from voice.realtime.normalizer import SophiaEventNormalizer  # noqa: E402


def test_assistant_transcript_accepts_increasing_non_contiguous_source_sequences():
    normalizer = SophiaEventNormalizer()

    events = normalizer.normalize_events(
        [
            ProviderEvent.assistant_text_delta(
                "Hello",
                is_delta=False,
                response_id="response-1",
                segment_id="segment-1",
                source_sequence=2,
                transcript_assembly="auto",
            ),
            ProviderEvent.assistant_text_delta(
                "Hello there",
                is_delta=False,
                response_id="response-1",
                segment_id="segment-1",
                source_sequence=4,
                transcript_assembly="auto",
            ),
        ]
    )

    transcript_events = [event for event in events if event.type == "sophia.transcript"]
    assert [event.data["source_sequence"] for event in transcript_events] == [2, 4]
    assert transcript_events[-1].data["text"] == "Hello there"

    stale_events = normalizer.normalize_event(
        ProviderEvent.assistant_text_delta(
            "Hello stale",
            is_delta=False,
            response_id="response-1",
            segment_id="segment-1",
            source_sequence=3,
            transcript_assembly="auto",
        )
    )

    assert [event.type for event in stale_events] == ["sophia.turn_diagnostic"]
    assert stale_events[0].data["provider_event_name"] == "transcript_sequence_stale_rejected"


def test_assistant_transcript_delta_like_fragments_assemble_when_all_fragments_arrive():
    normalizer = SophiaEventNormalizer()

    events = normalizer.normalize_events(
        [
            ProviderEvent.assistant_text_delta(
                text,
                is_delta=False,
                response_id="response-1",
                segment_id="segment-1",
                source_sequence=source_sequence,
                transcript_assembly="auto",
            )
            for source_sequence, text in enumerate(
                ["You're asking", "for a", "deeper", "understanding"],
                start=1,
            )
        ]
    )

    transcript_events = [event for event in events if event.type == "sophia.transcript"]
    assert transcript_events[-1].data["text"] == "You're asking for a deeper understanding"
    assert [event.data["source_sequence"] for event in transcript_events] == [1, 2, 3, 4]