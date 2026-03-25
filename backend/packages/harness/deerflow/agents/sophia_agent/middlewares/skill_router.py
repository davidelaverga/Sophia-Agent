"""Skill router middleware.

Deterministic cascade that selects and injects the appropriate skill file
based on crisis state, message content, tone, trust level, and ritual context.
"""

import hashlib
import logging
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

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
    "i'm broken", "i'm just not", "that's just who i am", "i'll never be",
    "i'm bad at", "i've always been", "i can't change",
]

TONE_SPIKE_THRESHOLD = 1.0
TRUST_SESSION_THRESHOLD = 5
STUCK_LOOP_THRESHOLD = 3


class SkillRouterState(AgentState):
    force_skill: NotRequired[str | None]
    skip_expensive: NotRequired[bool]
    active_tone_band: NotRequired[str]
    active_ritual: NotRequired[str | None]
    previous_artifact: NotRequired[dict | None]
    active_skill: NotRequired[str]
    skill_session_data: NotRequired[dict]
    system_prompt_blocks: NotRequired[list[str]]


def _init_session_data() -> dict:
    return {
        "sessions_total": 0,
        "trust_established": False,
        "complaint_signatures": {},
        "skill_history": [],
    }


class SkillRouterMiddleware(AgentMiddleware[SkillRouterState]):
    """Select and inject the appropriate skill file."""

    state_schema = SkillRouterState

    def __init__(self, skills_dir: Path):
        super().__init__()
        self._skill_contents: dict[str, str] = {}
        for name, filename in SKILL_FILES.items():
            path = skills_dir / filename
            if path.exists():
                self._skill_contents[name] = path.read_text(encoding="utf-8")
            else:
                logger.warning("Skill file not found: %s", path)
                self._skill_contents[name] = ""

    def _select_skill(self, state: SkillRouterState, session_data: dict) -> str:
        sd = session_data
        messages = state.get("messages", [])
        msg = ""
        if messages:
            content = getattr(messages[-1], "content", "")
            if isinstance(content, list):
                content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
            msg = str(content).lower()

        prev = state.get("previous_artifact") or {}
        tone = prev.get("tone_estimate", 2.5)

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
        if not sd.get("trust_established", False):
            return "trust_building"

        # 6. Fixed identity language (tone > 2.0)
        if tone > 2.0 and any(p in msg for p in IDENTITY_FLUIDITY_PATTERNS):
            return "identity_fluidity_support"

        # 7. Breakthrough (tone spike + insight language)
        # Compare current tone against the PREVIOUS turn's tone stored in session data.
        # (Both cannot come from `prev` — that reads the same value, yielding delta=0.)
        prev_tone = sd.get("last_tone_estimate", tone)
        tone_delta = tone - prev_tone
        if tone_delta >= TONE_SPIKE_THRESHOLD:
            insight_words = ["i just realized", "oh my god", "i never saw", "i've been"]
            if any(w in msg for w in insight_words):
                return "celebrating_breakthrough"

        # 8. Stuck loop (complaint count >= 3, trust established, tone > 2.0)
        if sd.get("trust_established", False) and tone > 2.0 and msg:
            sig = hashlib.md5(msg[:50].encode()).hexdigest()[:6]
            if sd.get("complaint_signatures", {}).get(sig, 0) >= STUCK_LOOP_THRESHOLD:
                return "challenging_growth"

        # 9. Default
        return "active_listening"

    @override
    def before_agent(self, state: SkillRouterState, runtime: Runtime) -> dict | None:
        # Crisis path: inject crisis_redirect only
        if state.get("skip_expensive", False) and state.get("force_skill") == "crisis_redirect":
            content = self._skill_contents.get("crisis_redirect", "")
            result: dict = {"active_skill": "crisis_redirect"}
            if content:
                result["system_prompt_blocks"] = [content]
            return result

        if state.get("skip_expensive", False):
            return None

        # Update session data
        sd = dict(state.get("skill_session_data") or _init_session_data())
        if state.get("turn_count", 0) == 0:
            sd["sessions_total"] = sd.get("sessions_total", 0) + 1
        sd["trust_established"] = sd["sessions_total"] >= TRUST_SESSION_THRESHOLD

        # Track complaint signatures
        messages = state.get("messages", [])
        if messages:
            content = getattr(messages[-1], "content", "")
            if isinstance(content, list):
                content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
            msg = str(content)
            if msg:
                sig = hashlib.md5(msg[:50].encode()).hexdigest()[:6]
                sigs = dict(sd.get("complaint_signatures", {}))
                sigs[sig] = sigs.get(sig, 0) + 1
                sd["complaint_signatures"] = sigs

        skill = self._select_skill(state, sd)

        # Store current tone for next turn's breakthrough comparison
        prev_artifact = state.get("previous_artifact") or {}
        sd["last_tone_estimate"] = prev_artifact.get("tone_estimate", 2.5)

        # Track skill history
        history = list(sd.get("skill_history", []))
        history.append(skill)
        sd["skill_history"] = history[-5:]

        result = {
            "active_skill": skill,
            "skill_session_data": sd,
        }

        content = self._skill_contents.get(skill, "")
        if content:
            result["system_prompt_blocks"] = [content]

        return result
