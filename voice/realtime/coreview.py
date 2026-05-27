from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal

COREVIEW_FEATURE_FLAG = "SOPHIA_GEMINI_COREVIEW_ENABLED"
COREVIEW_STILL_FRAME_FEATURE_FLAG = "SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED"
GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME = "read_artifact_text"
COREVIEW_FIXTURE_ARTIFACT_ID = "coreview-fixture-q3-launch-review"
COREVIEW_PROMPT_SOURCE = "voice/realtime/coreview.py::build_gemini_coreview_prompt_overlay"

_TRUE_VALUES = {"1", "true", "yes", "on"}
_MAX_ARTIFACT_TEXT_CHARS = 12_000

COREVIEW_FIXTURE_EXACT_TEXT = "\n".join(
    [
        "Q3 Launch Review",
        "Strengths",
        "Risks",
        "North = 42",
        "budget delta is 17.4%",
    ]
)

_GEMINI_COREVIEW_PROMPT_OVERLAY = """<gemini_coreview_artifact_policy>
Artifact co-review is a separate, explicitly entered mode. Apply these rules only while Review Together is active.

- Visual input is limited to the artifact region selected by the app. Never ask for or imply whole-screen, whole-tab, desktop, or browser chrome access.
- The user must see a persistent looking indicator while visual input is active.
- Stop Looking ends visual input. After it stops, return to normal voice behavior.
- Still-frame co-review is single-frame or low-rate artifact-canvas input, not continuous video.
- Use visual input only for layout, composition, color, spacing, rough structure, and other visual qualities.
- Exact words, numbers, table values, labels, citations, and data must come from read_artifact_text or another trusted artifact text sideband, not from vision.
- When the user asks what a heading says, asks for a number/table value/label, or asks you to read fine print, call read_artifact_text with the active artifact_id before answering.
- If read_artifact_text returns unavailable, unsupported, forbidden, or not_found, say that the exact text is unavailable instead of guessing from the image.
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


def is_coreview_still_frame_enabled(value: str | None = None) -> bool:
    if value is None:
        value = os.getenv(COREVIEW_STILL_FRAME_FEATURE_FLAG)
    return str(value or "").strip().lower() in _TRUE_VALUES


def build_gemini_coreview_prompt_overlay(*, enabled: bool | None = None) -> str:
    if enabled is None:
        enabled = is_coreview_enabled()
    return _GEMINI_COREVIEW_PROMPT_OVERLAY if enabled else ""


def detect_gemini_coreview_media_support(*, coreview_enabled: bool | None = None) -> CoreviewMediaSupportReport:
    if coreview_enabled is None:
        coreview_enabled = is_coreview_enabled()
    still_frame_enabled = coreview_enabled and is_coreview_still_frame_enabled()

    return CoreviewMediaSupportReport(
        transport_kind="gemini_live_audio_websocket_current_path",
        media_capable_session_possible="unknown",
        continuous_video_supported=False,
        still_frames_supported=still_frame_enabled,
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
            "Current browser Gemini path sends audio/text/video over BidiGenerateContent WebSocket only.",
            "No repo code exposes RTCPeerConnection/addTrack/replaceTrack for Gemini visual input.",
            "Still-frame WebSocket mediaChunks send is experimental and not provider-ack verified.",
            "Installed Vision Agents package exposes generic video-track helpers, not a wired Gemini media session.",
            "Artifact panel is DOM-first; artifact-scoped visual input needs a canvas renderer or safe still-frame path.",
        ),
        recommended_next_step=(
            "Keep normal voice untouched. Manually smoke-test one feature-flagged artifact-canvas still frame "
            "before attempting low-rate stills or continuous co-review."
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
            "frameSentCount",
            "frameBytes",
            "frameDimensions",
            "frameSendLatencyMs",
            "providerAcceptedFrame",
            "visualResponseObserved",
            "toolCallStillWorks",
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

    if not enabled:
        return _read_artifact_text_failure(
            artifact_id,
            status="unavailable",
            safe_reason="read_artifact_text is disabled unless Coreview is explicitly feature-flagged.",
        )

    if not artifact_id:
        return _read_artifact_text_failure(
            artifact_id,
            status="not_found",
            safe_reason="No artifact_id was supplied for the trusted text read.",
        )

    if artifact_id == COREVIEW_FIXTURE_ARTIFACT_ID:
        return _read_artifact_text_success(
            artifact_id,
            source="fixture",
            text=COREVIEW_FIXTURE_EXACT_TEXT,
        )

    if artifact_id.startswith("coreview-real-artifact-"):
        return _read_artifact_text_failure(
            artifact_id,
            status="unsupported",
            safe_reason=(
                "This artifact's exact text is not available in the backend reader. "
                "The app may provide a trusted metadata-only sideband, but full file body reading is unsupported."
            ),
        )

    return _read_artifact_text_failure(
        artifact_id,
        status="not_found",
        safe_reason="No trusted artifact text source is registered for that artifact_id.",
    )


def read_artifact_text_result_summary(response: Mapping[str, Any]) -> str:
    artifact_id = str(response.get("artifact_id") or "")
    if response.get("ok") is True:
        source = str(response.get("source") or "unknown")
        char_count = int(response.get("char_count") or 0)
        return f"read_artifact_text returned {source} text for {artifact_id} ({char_count} chars)."
    status = str(response.get("status") or "unavailable")
    return f"read_artifact_text returned {status} for {artifact_id or 'missing artifact_id'}."


def redacted_read_artifact_text_diagnostic(
    response: Mapping[str, Any],
    *,
    latency_ms: int | None = None,
) -> dict[str, Any]:
    artifact_id = str(response.get("artifact_id") or "")
    if response.get("ok") is True:
        return {
            "ok": True,
            "artifact_id": artifact_id,
            "source": str(response.get("source") or "unsupported"),
            "char_count": int(response.get("char_count") or 0),
            "truncated": bool(response.get("truncated")),
            "status": "success",
            "latency_ms": latency_ms,
            "raw_artifact_text_excluded": True,
        }

    return {
        "ok": False,
        "artifact_id": artifact_id,
        "status": str(response.get("status") or "unavailable"),
        "safe_reason": str(response.get("safe_reason") or "Exact artifact text is unavailable."),
        "latency_ms": latency_ms,
        "raw_artifact_text_excluded": True,
    }


def _read_artifact_text_success(
    artifact_id: str,
    *,
    source: Literal["fixture", "builder_metadata", "builder_file", "artifact_store", "unsupported"],
    text: str,
) -> dict[str, Any]:
    char_count = len(text)
    truncated = char_count > _MAX_ARTIFACT_TEXT_CHARS
    return {
        "ok": True,
        "artifact_id": artifact_id,
        "source": source,
        "text": text[:_MAX_ARTIFACT_TEXT_CHARS],
        "truncated": truncated,
        "char_count": char_count,
    }


def _read_artifact_text_failure(
    artifact_id: str,
    *,
    status: Literal["not_found", "unavailable", "forbidden", "unsupported"],
    safe_reason: str,
) -> dict[str, Any]:
    return {
        "ok": False,
        "artifact_id": artifact_id,
        "status": status,
        "safe_reason": safe_reason,
    }


def coreview_tool_parity_status(*, coreview_enabled: bool | None = None) -> dict[str, Any]:
    report = detect_gemini_coreview_media_support(coreview_enabled=coreview_enabled)
    return {
        "normal_voice_tools_supported": report.tools_supported_in_normal_voice,
        "coreview_media_tools_supported": report.tools_supported_in_coreview_media,
        "read_artifact_text_available": report.read_artifact_text_available,
        "status": report.tool_parity_status,
    }
