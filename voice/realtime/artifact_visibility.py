from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal


VisibilityResult = Literal["proven_visible", "proven_not_visible", "inconclusive"]
PublicEventVisibility = Literal["proven_not_visible", "inconclusive"]


@dataclass(frozen=True)
class ArtifactVisibilityProbe:
    probe_id: str = "artifact_visibility_probe_phase_12_5c_b"
    session_goal: str = "artifact_visibility_probe_session_goal_alpha_7291"
    takeaway: str = "artifact_visibility_probe_takeaway_blue_lantern_4832"
    next_step: str = "artifact_visibility_probe_next_step_copper_bridge_9157"
    reflection: str = "artifact_visibility_probe_reflection_silver_orbit_6204"
    next_turn_question: str = "Without guessing, what was your previous internal takeaway?"

    def artifact_payload(self) -> dict[str, Any]:
        return {
            "session_goal": self.session_goal,
            "active_goal": "Probe artifact visibility without speaking the probe.",
            "next_step": self.next_step,
            "takeaway": self.takeaway,
            "reflection": self.reflection,
            "tone_estimate": 2.0,
            "tone_target": 2.5,
            "active_tone_band": "engagement",
            "skill_loaded": "active_listening",
            "ritual_phase": "artifact_visibility.probe",
            "voice_emotion_primary": "curious",
            "voice_emotion_secondary": "calm",
            "voice_speed": "normal",
        }

    def function_call_args(self) -> dict[str, Any]:
        return dict(self.artifact_payload())

    def distinctive_values(self) -> tuple[str, ...]:
        return (self.session_goal, self.takeaway, self.next_step, self.reflection)


def default_artifact_visibility_probe() -> ArtifactVisibilityProbe:
    return ArtifactVisibilityProbe()


def artifact_visibility_fingerprint(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8",
    )
    return hashlib.sha256(encoded).hexdigest()[:16]


def record_contains_probe_value(value: Any, probe: ArtifactVisibilityProbe) -> bool:
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return any(distinctive_value in serialized for distinctive_value in probe.distinctive_values())


def answer_contains_probe_takeaway(answer_text: str | None, probe: ArtifactVisibilityProbe) -> bool:
    if not answer_text:
        return False
    return probe.takeaway.lower() in answer_text.lower()


def classify_next_turn_answer(
    answer_text: str | None,
    probe: ArtifactVisibilityProbe,
) -> VisibilityResult:
    if answer_text is None or not answer_text.strip():
        return "inconclusive"
    if answer_contains_probe_takeaway(answer_text, probe):
        return "proven_visible"
    return "proven_not_visible"


def classify_public_artifact_event_visibility(
    *,
    public_artifact_seen: bool,
    provider_send_count_after_public_event: int,
) -> PublicEventVisibility:
    if public_artifact_seen and provider_send_count_after_public_event == 0:
        return "proven_not_visible"
    return "inconclusive"


def build_artifact_visibility_diagnostic(
    *,
    probe: ArtifactVisibilityProbe,
    provider: str,
    variant: str,
    tool_call_args: Mapping[str, Any] | None = None,
    tool_response: Mapping[str, Any] | None = None,
    public_artifact_seen: bool = False,
    next_turn_user_probe_seen: bool = False,
    next_turn_answer: str | None = None,
) -> dict[str, Any]:
    tool_call_args_dict = dict(tool_call_args or {})
    tool_response_dict = dict(tool_response or {})
    return {
        "artifact_visibility_probe_id": probe.probe_id,
        "provider": provider,
        "variant": variant,
        "tool_call_seen": bool(tool_call_args_dict),
        "tool_call_args_fingerprint": artifact_visibility_fingerprint(tool_call_args_dict)
        if tool_call_args_dict
        else None,
        "tool_call_args_contains_probe": record_contains_probe_value(tool_call_args_dict, probe)
        if tool_call_args_dict
        else False,
        "public_artifact_seen": public_artifact_seen,
        "tool_response_sent": bool(tool_response_dict),
        "tool_response_fingerprint": artifact_visibility_fingerprint(tool_response_dict)
        if tool_response_dict
        else None,
        "tool_response_contains_probe": record_contains_probe_value(tool_response_dict, probe)
        if tool_response_dict
        else False,
        "next_turn_user_probe_seen": next_turn_user_probe_seen,
        "next_turn_answer_contains_probe": answer_contains_probe_takeaway(next_turn_answer, probe),
        "visibility_result": classify_next_turn_answer(next_turn_answer, probe),
    }