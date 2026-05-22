from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


DeliveryPace = Literal["slow", "gentle", "normal", "engaged", "energetic"]


@dataclass(frozen=True)
class DeliveryIntent:
    """Provider-neutral speech delivery intent for Sophia.

    This carries companion-safe speech semantics before any provider-specific
    mapping to Cartesia emotions, OpenAI voice/session instructions, Gemini
    controls, or a no-op fallback.
    """

    tone: str = "steady"
    family: str = "warm"
    intensity: float = 0.4
    pace: DeliveryPace = "normal"
    warmth: float = 0.7
    restraint: float = 0.5
    provider_hints: dict[str, object] = field(default_factory=dict)

    def clamped(self) -> "DeliveryIntent":
        return DeliveryIntent(
            tone=self.tone,
            family=self.family,
            intensity=_clamp_unit(self.intensity),
            pace=self.pace,
            warmth=_clamp_unit(self.warmth),
            restraint=_clamp_unit(self.restraint),
            provider_hints=dict(self.provider_hints),
        )


def _clamp_unit(value: float) -> float:
    return max(0.0, min(1.0, value))