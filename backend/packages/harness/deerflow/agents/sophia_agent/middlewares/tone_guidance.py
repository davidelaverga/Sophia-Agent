"""Tone guidance middleware.

Parses tone_guidance.md into 5 band sections at startup. Injects only the
matching band per turn (~726 tokens instead of ~3,630 for the full file).
"""

import logging
import re
import time
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

_LEGACY_BAND_SPLIT_RE = re.compile(r"(?=^## Band \d+:)", flags=re.MULTILINE)
_LEGACY_BAND_ID_RE = re.compile(r"\*\*band_id:\s*(\w+)\*\*")
_COMMON_SECTION_RE = re.compile(
    r"(?ms)^## (The Rule|The 2\.0 Line)\s*\n(.*?)(?=^## |\Z)"
)
_STRUCTURED_BAND_RE = re.compile(
    r"(?ms)^### Band (\d+)\b.*?(?=^### Band \d+\b|^## Section \d+|\Z)"
)
_BAND_NUMBER_TO_ID = {
    1: "shutdown",
    2: "grief_fear",
    3: "anger_antagonism",
    4: "engagement",
    5: "enthusiasm",
}

BAND_RANGES: dict[str, tuple[float, float]] = {
    "shutdown": (0.0, 0.5),
    "grief_fear": (0.5, 1.5),
    "anger_antagonism": (1.5, 2.5),
    "engagement": (2.5, 3.5),
    "enthusiasm": (3.5, 4.0),
}

DEFAULT_BAND = "engagement"


class ToneGuidanceState(AgentState):
    skip_expensive: NotRequired[bool]
    previous_artifact: NotRequired[dict | None]
    active_tone_band: NotRequired[str]
    system_prompt_blocks: NotRequired[list[str]]


class ToneGuidanceMiddleware(AgentMiddleware[ToneGuidanceState]):
    """Inject a single tone band section per turn."""

    state_schema = ToneGuidanceState

    def __init__(self, tone_guidance_path: Path):
        super().__init__()
        if not tone_guidance_path.exists():
            raise FileNotFoundError(f"Tone guidance file not found: {tone_guidance_path}")
        self._bands = self._parse_bands(tone_guidance_path)

    def _parse_bands(self, path: Path) -> dict[str, str]:
        """Split tone_guidance.md into one prompt block per tone band."""
        content = path.read_text(encoding="utf-8")

        bands = self._parse_legacy_bands(content)
        if bands:
            return bands

        bands = self._parse_structured_bands(content)
        if bands:
            return bands

        logger.warning("No bands parsed from %s — falling back to full content", path)
        return {DEFAULT_BAND: content.strip()}

    def _parse_legacy_bands(self, content: str) -> dict[str, str]:
        bands: dict[str, str] = {}
        sections = _LEGACY_BAND_SPLIT_RE.split(content)
        for section in sections:
            match = _LEGACY_BAND_ID_RE.search(section)
            if match:
                bands[match.group(1)] = section.strip()
        return bands

    def _parse_structured_bands(self, content: str) -> dict[str, str]:
        shared_sections = [
            f"## {title}\n{body.strip()}"
            for title, body in _COMMON_SECTION_RE.findall(content)
            if body.strip()
        ]

        sections_by_number: dict[int, list[str]] = {}
        for match in _STRUCTURED_BAND_RE.finditer(content):
            band_number = int(match.group(1))
            section = match.group(0).strip()
            if section:
                sections_by_number.setdefault(band_number, []).append(section)

        bands: dict[str, str] = {}
        for band_number, band_id in _BAND_NUMBER_TO_ID.items():
            band_sections = sections_by_number.get(band_number)
            if not band_sections:
                continue

            combined_sections = [*shared_sections, *band_sections]
            bands[band_id] = "\n\n---\n\n".join(combined_sections)

        return bands

    @staticmethod
    def tone_to_band(tone: float) -> str:
        """Map a tone estimate (0.0-4.0) to a band ID."""
        for band_id, (low, high) in BAND_RANGES.items():
            if low <= tone < high:
                return band_id
        # Edge case: tone == 4.0 falls into enthusiasm
        if tone >= 4.0:
            return "enthusiasm"
        return DEFAULT_BAND

    @override
    def before_agent(self, state: ToneGuidanceState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("ToneGuidance", "skipped (crisis)", _t0)
            return None

        prev_artifact = state.get("previous_artifact") or {}
        tone = prev_artifact.get("tone_estimate", 2.5)
        band = self.tone_to_band(tone)

        band_content = self._bands.get(band, self._bands.get(DEFAULT_BAND, ""))

        log_middleware("ToneGuidance", f"band={band} ({len(band_content)} chars)", _t0)
        return {
            "active_tone_band": band,
            "system_prompt_blocks": list(state.get("system_prompt_blocks", [])) + ([band_content] if band_content else []),
        }
