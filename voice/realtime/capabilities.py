from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


TurnAuthority = Literal["provider", "sophia", "hybrid"]
SpeechDeliveryControl = Literal["none", "hints", "instructions", "native_controls"]


@dataclass(frozen=True)
class ProviderCapabilities:
    """Provider-neutral descriptor for realtime session behavior.

    This is deliberately about capabilities, not provider names. Future OpenAI,
    Gemini, and legacy-cascade adapters can declare what they support without
    forcing Sophia's public event contract to know their wire protocols.
    """

    native_audio_input: bool
    native_audio_output: bool
    transcript_input: bool
    transcript_output: bool
    tool_calls: bool
    structured_tool_payloads: bool
    native_cancellation: bool
    session_updates: bool
    image_input: bool = False
    artifact_vision: bool = False
    speech_delivery_control: SpeechDeliveryControl = "none"
    turn_authority: TurnAuthority = "provider"
    provider_hints: dict[str, object] = field(default_factory=dict)

    @property
    def supports_transcripts(self) -> bool:
        return self.transcript_input or self.transcript_output