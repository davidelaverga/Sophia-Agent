"""ToneGuidanceMiddleware — partial injection of tone_guidance.md.

Position 9 in chain. Parses tone_guidance.md into 5 band sections at
STARTUP, caches them. Injects ONE band section per turn (~726 tokens),
not the full file (~3,630 tokens).
"""

from __future__ import annotations

import re
from pathlib import Path

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState

BAND_RANGES: dict[str, tuple[float, float]] = {
    "shutdown": (0.0, 0.5),
    "grief_fear": (0.5, 1.5),
    "anger_antagonism": (1.5, 2.5),
    "engagement": (2.5, 3.5),
    "enthusiasm": (3.5, 4.0),
}


class ToneGuidanceMiddleware:
    """Parse tone bands at startup, inject one per turn."""

    runs_during_crisis = False

    def __init__(self, tone_guidance_path: Path):
        self._bands = self._parse_bands(tone_guidance_path)

    @staticmethod
    def _parse_bands(path: Path) -> dict[str, str]:
        """Split tone_guidance.md into sections by ## Band N: header."""
        if not path.exists():
            return {}
        content = path.read_text()
        bands: dict[str, str] = {}
        sections = re.split(r"(?=^## Band \d+:)", content, flags=re.MULTILINE)
        for section in sections:
            match = re.search(r"\*\*band_id: (\w+)\*\*", section)
            if match:
                bands[match.group(1)] = section.strip()
        return bands

    @staticmethod
    def _tone_to_band(tone: float) -> str:
        for band_id, (low, high) in BAND_RANGES.items():
            if low <= tone < high:
                return band_id
        return "engagement"

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive"):
            return state

        tone = 2.5
        prev = state.get("previous_artifact")
        if prev and isinstance(prev, dict):
            tone = prev.get("tone_estimate", 2.5)

        band = self._tone_to_band(tone)
        state["active_tone_band"] = band

        band_content = self._bands.get(band)
        if band_content:
            state.setdefault("system_prompt_blocks", []).append(band_content)

        return state
