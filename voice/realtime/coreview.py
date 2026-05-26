from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal

COREVIEW_FEATURE_FLAG = "SOPHIA_GEMINI_COREVIEW_ENABLED"
GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME = "read_artifact_text"
COREVIEW_PROMPT_SOURCE = "voice/realtime/coreview.py::build_gemini_coreview_prompt_overlay"

_TRUE_VALUES = {"1", "true", "yes", "on"}

_GEMINI_COREVIEW_PROMPT_OVERLAY = """<gemini_coreview_artifact_policy>
Artifact co-review is a separate, explicitly entered mode. Apply these rules only while Review Together is active.

- Visual input is limited to the artifact region selected by the app. Never ask for or imply whole-screen, whole-tab, desktop, or browser chrome access.
- The user must see a persistent looking indicator while visual input is active.
- Stop Looking ends visual input. After it stops, return to normal voice behavior.
- Use visual input only for layout, composition, color, spacing, rough structure, and other visual qualities.
- Exact words, numbers, table values, labels, citations, and data must come from read_artifact_text or another trusted backend artifact reader, not from vision.
- Do not store frames, screenshots, audio, video, provider credentials, or raw artifact text in telemetry.
- If the media path cannot use tools, say you need the trusted text reader for exact data instead of guessing.
</gemini_coreview_artifact_policy>"""


@dataclass(frozen=True)
class CoreviewMediaSupportReport:
    transport_kind: str
    media_capable_session_possible: Literal["yes", "no", "unknown"]
    continuous_video_supported: bool
    still_frames_supported: bool
    tools_supported_in_normal_voice: bool
    tools_supported_in_coreview_media: Literal["yes", "no", "unknown"]
    read_artifact_text_available: bool
    read_artifact_text_feature_flag: str
    normal_voice_can_remain_separate: Literal["yes", "no", "unknown"]
    normal_voice_must_pause: Literal["yes", "no", "unknown"]
    tool_parity_status: str
    blockers: tuple[str, ...]
    recommended_next_step: str
    safe_telemetry_fields: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def is_coreview_enabled(value: str | None = None) -> bool:
    if value is None:
        value = os.getenv(COREVIEW_FEATURE_FLAG)
    return str(value or "").strip().lower() in _TRUE_VALUES


def build_gemini_coreview_prompt_overlay(*, enabled: bool | None = None) -> str:
    if enabled is None:
        enabled = is_coreview_enabled()
    return _GEMINI_COREVIEW_PROMPT_OVERLAY if enabled else ""


def detect_gemini_coreview_media_support(*, coreview_enabled: bool | None = None) -> CoreviewMediaSupportReport:
    if coreview_enabled is None:
        coreview_enabled = is_coreview_enabled()

    return CoreviewMediaSupportReport(
        transport_kind="gemini_live_audio_websocket_current_path",
        media_capable_session_possible="unknown",
        continuous_video_supported=False,
        still_frames_supported=False,
        tools_supported_in_normal_voice=True,
        tools_supported_in_coreview_media="unknown",
        read_artifact_text_available=coreview_enabled,
        read_artifact_text_feature_flag=COREVIEW_FEATURE_FLAG,
        normal_voice_can_remain_separate="unknown",
        normal_voice_must_pause="unknown",
        tool_parity_status=(
            "Normal Gemini Live voice supports toolCall/toolResponse. A separate "
            "media-capable co-review session has not been found in this repo, so "
            "tool parity for that path is unproven."
        ),
        blockers=(
            "Current browser Gemini path sends audio/text over BidiGenerateContent WebSocket only.",
            "No repo code exposes RTCPeerConnection/addTrack/replaceTrack for Gemini visual input.",
            "No Gemini co-review adapter implements send_frame, send_image, or attach_video_track.",
            "Installed Vision Agents package exposes generic video-track helpers, not a wired Gemini media session.",
            "Artifact panel is DOM-first; artifact-scoped visual input needs a canvas renderer or safe still-frame path.",
        ),
        recommended_next_step=(
            "Keep normal voice untouched. Spike a feature-flagged still-frame path from an artifact canvas "
            "or wait for a proven provider media transport before continuous co-review."
        ),
        safe_telemetry_fields=(
            "normalVoiceSessionId",
            "coReviewSessionId",
            "transportKind",
            "visualTransportSupported",
            "toolsSupportedInCoReview",
            "coReviewStartLatencyMs",
            "coReviewStopLatencyMs",
            "normalVoicePaused",
            "normalVoiceRestored",
            "sessionHandoffMs",
            "videoOrFrameMode",
            "frameCount",
            "estimatedVisualCost",
        ),
    )


def gemini_read_artifact_text_function_declaration() -> dict[str, object]:
    return {
        "name": GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
        "description": (
            "Trusted backend artifact text reader for co-review. Use only for exact words, numbers, "
            "table values, labels, citations, or data from the active artifact. The response must not "
            "be written to telemetry."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "artifact_id": {
                    "type": "STRING",
                    "description": "Trusted artifact identifier supplied by the app.",
                },
                "query": {
                    "type": "STRING",
                    "description": "Short description of the exact text or data needed.",
                },
                "reason": {
                    "type": "STRING",
                    "description": "Why vision is not sufficient for this answer.",
                },
            },
            "required": ["artifact_id", "query"],
        },
    }


def execute_read_artifact_text_feature_gated(
    args: Mapping[str, Any],
    *,
    session_id: str,
    user_id: str,
    provider: str,
    enabled: bool | None = None,
) -> dict[str, Any]:
    if enabled is None:
        enabled = is_coreview_enabled()

    artifact_id = str(args.get("artifact_id") or "").strip()
    query = str(args.get("query") or "").strip()
    base = {
        "tool": GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
        "session_id": session_id,
        "user_id": user_id,
        "provider": provider,
        "artifact_id_present": bool(artifact_id),
        "query_length": len(query),
        "raw_artifact_text_excluded": True,
        "raw_query_excluded": True,
        "public_event_boundary": "SophiaEventNormalizer",
    }

    if not enabled:
        return {
            **base,
            "ok": False,
            "status": "disabled",
            "reason": "coreview_feature_flag_disabled",
            "feature_flag": COREVIEW_FEATURE_FLAG,
            "result_summary": "read_artifact_text is disabled unless co-review is explicitly feature-flagged.",
        }

    return {
        **base,
        "ok": False,
        "status": "unimplemented",
        "reason": "trusted_artifact_text_reader_not_wired_for_media_spike",
        "result_summary": (
            "read_artifact_text is feature-flagged but not wired to a trusted artifact text store in this spike."
        ),
    }


def coreview_tool_parity_status(*, coreview_enabled: bool | None = None) -> dict[str, Any]:
    report = detect_gemini_coreview_media_support(coreview_enabled=coreview_enabled)
    return {
        "normal_voice_tools_supported": report.tools_supported_in_normal_voice,
        "coreview_media_tools_supported": report.tools_supported_in_coreview_media,
        "read_artifact_text_available": report.read_artifact_text_available,
        "status": report.tool_parity_status,
    }
