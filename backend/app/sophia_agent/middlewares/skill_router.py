"""SkillRouterMiddleware — cascade logic for skill selection.

Position 12 in chain. Reads tone band + ritual from state.
Full cascade: crisis → danger → boundary → vulnerability → trust →
identity fluidity → breakthrough → stuck loop → default (active_listening).
"""

from __future__ import annotations

import hashlib
from collections import deque
from pathlib import Path

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState

SKILL_FILES = {
    "crisis_redirect": "crisis_redirect.md",
    "boundary_holding": "boundary_holding.md",
    "vulnerability_holding": "vulnerability_holding.md",
    "trust_building": "trust_building.md",
    "identity_fluidity_support": "identity_fluidity_support.md",
    "celebrating_breakthrough": "celebrating_breakthrough.md",
    "challenging_growth": "challenging_growth.md",
    "active_listening": "active_listening.md",
}

IDENTITY_FLUIDITY_PATTERNS = [
    "i'm broken",
    "i'm just not",
    "that's just who i am",
    "i'll never be",
    "i'm bad at",
    "i've always been",
    "i can't change",
]

TONE_SPIKE_THRESHOLD = 1.0


class SkillRouterMiddleware:
    """Select and inject the appropriate skill file per turn."""

    runs_during_crisis = True  # handles crisis_redirect injection

    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self._skill_contents: dict[str, str] = {}
        for name, filename in SKILL_FILES.items():
            path = skills_dir / filename
            if path.exists():
                self._skill_contents[name] = path.read_text()

    @staticmethod
    def _init_session_data() -> dict:
        return {
            "sessions_total": 0,
            "trust_established": False,
            "complaint_signatures": {},
            "skill_history": list(deque(maxlen=5)),
        }

    def _select_skill(self, state: SophiaState) -> str:
        sd = state.get("skill_session_data", self._init_session_data())
        msg = ""
        if state.get("messages"):
            content = state["messages"][-1].content
            msg = content.lower() if isinstance(content, str) else ""
        prev = state.get("previous_artifact") or {}
        tone = prev.get("tone_estimate", 2.5)
        tone_prev = prev.get("tone_estimate", tone)
        tone_delta = tone - tone_prev

        # 1. Force override (crisis middleware set this)
        if state.get("force_skill"):
            return state["force_skill"]

        # 2. Danger language
        if any(s in msg for s in ["want to die", "hurt myself", "suicide"]):
            return "crisis_redirect"

        # 3. Boundary violation
        if any(s in msg for s in ["sexual", "send me", "be my girlfriend"]):
            return "boundary_holding"

        # 4. Raw vulnerability
        if any(s in msg for s in ["never told anyone", "i'm ashamed", "i hate myself"]):
            return "vulnerability_holding"
        if tone < 1.5 and any(s in msg for s in ["crying", "can't stop", "breaking"]):
            return "vulnerability_holding"

        # 5. New or guarded user
        if not sd.get("trust_established"):
            return "trust_building"

        # 6. Fixed identity language (tone > 2.0 required)
        if tone > 2.0 and any(p in msg for p in IDENTITY_FLUIDITY_PATTERNS):
            return "identity_fluidity_support"

        # 7. Breakthrough (tone spike + insight language)
        if tone_delta >= TONE_SPIKE_THRESHOLD:
            insight_words = ["i just realized", "oh my god", "i never saw", "i've been"]
            if any(w in msg for w in insight_words):
                return "celebrating_breakthrough"

        # 8. Stuck loop (complaint count >= 3, trust established, tone > 2.0)
        if sd.get("trust_established") and tone > 2.0:
            sig = hashlib.md5(msg[:50].encode()).hexdigest()[:6]
            if sd["complaint_signatures"].get(sig, 0) >= 3:
                return "challenging_growth"

        # 9. Default
        return "active_listening"

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive") and state.get("force_skill") == "crisis_redirect":
            content = self._skill_contents.get("crisis_redirect", "")
            if content:
                state.setdefault("system_prompt_blocks", []).append(content)
            return state

        if state.get("skip_expensive"):
            return state

        # Update session data
        sd = state.get("skill_session_data", self._init_session_data())
        sd["sessions_total"] = sd.get("sessions_total", 0) + 1
        sd["trust_established"] = sd["sessions_total"] >= 5

        # Track complaint signatures
        if state.get("messages"):
            content = state["messages"][-1].content
            if isinstance(content, str):
                sig = hashlib.md5(content[:50].encode()).hexdigest()[:6]
                sd["complaint_signatures"][sig] = sd["complaint_signatures"].get(sig, 0) + 1

        skill = self._select_skill(state)
        state["active_skill"] = skill

        # Track skill history
        history = list(sd.get("skill_history", []))
        history.append(skill)
        sd["skill_history"] = history[-5:]
        state["skill_session_data"] = sd

        # Inject skill file
        content = self._skill_contents.get(skill, "")
        if content:
            state.setdefault("system_prompt_blocks", []).append(content)

        return state
