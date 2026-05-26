from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

SOPHIA_GEMINI_SCREENSHARE_COREVIEW_FEATURE_FLAG = "SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED"
READ_ARTIFACT_TEXT_TOOL_NAME = "read_artifact_text"
READ_ARTIFACT_TEXT_MAX_CHARS = 12000

COREVIEW_INSTRUCTION_SOURCE = "voice/realtime/coreview.py::build_coreview_instruction_block"
COREVIEW_INSTRUCTION_BLOCK = """
<gemini_live_coreview_policy>
When co-review mode is active, the user has deliberately shared only the rendered artifact region.
Use the shared view for layout, color, composition, spacing, visual hierarchy, chart shape, and spatial references.
For exact words, copy, numbers, table values, dates, labels, or metrics, call read_artifact_text with the current artifact_id.
Do not claim to read fine print or exact data from the video feed alone. If the text tool is unavailable, say that plainly.
</gemini_live_coreview_policy>
""".strip()


def is_coreview_enabled() -> bool:
    value = os.getenv(SOPHIA_GEMINI_SCREENSHARE_COREVIEW_FEATURE_FLAG, "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def build_coreview_instruction_block() -> str:
    return COREVIEW_INSTRUCTION_BLOCK if is_coreview_enabled() else ""


def read_artifact_text_function_declaration() -> dict[str, object]:
    return {
        "name": READ_ARTIFACT_TEXT_TOOL_NAME,
        "description": (
            "Read exact text, numbers, labels, dates, and table values from the artifact currently "
            "being co-reviewed. Use this instead of relying on the live video feed for fine text."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "artifact_id": {
                    "type": "STRING",
                    "description": "Opaque artifact id from the trusted co-review session context.",
                }
            },
            "required": ["artifact_id"],
        },
    }


class CoreviewArtifactTextBackend(Protocol):
    async def read_artifact_text(
        self,
        args: Mapping[str, Any],
        *,
        user_id: str,
        session_id: str,
    ) -> dict[str, Any]:
        """Return the safe read_artifact_text response envelope."""


@dataclass(frozen=True)
class CoreviewArtifactTextRecord:
    user_id: str
    session_id: str
    artifact_id: str
    text: str
    source: str = "artifact_store"


class UnavailableCoreviewArtifactTextBackend:
    async def read_artifact_text(
        self,
        args: Mapping[str, Any],
        *,
        user_id: str,
        session_id: str,
    ) -> dict[str, Any]:
        artifact_id = _artifact_id_from_args(args)
        if artifact_id is None:
            return read_artifact_text_error(
                "",
                "unsupported",
                "artifact_id_required",
            )
        return read_artifact_text_error(
            artifact_id,
            "unavailable",
            "artifact_text_store_not_wired_for_coreview_spike",
        )


class InMemoryCoreviewArtifactTextBackend:
    """Test-only fixture backend keyed by trusted user/session/artifact scope."""

    def __init__(self, records: list[CoreviewArtifactTextRecord] | None = None) -> None:
        self._records: dict[str, list[CoreviewArtifactTextRecord]] = {}
        for record in records or []:
            self.add(record)

    def add(self, record: CoreviewArtifactTextRecord) -> None:
        self._records.setdefault(record.artifact_id, []).append(record)

    async def read_artifact_text(
        self,
        args: Mapping[str, Any],
        *,
        user_id: str,
        session_id: str,
    ) -> dict[str, Any]:
        artifact_id = _artifact_id_from_args(args)
        if artifact_id is None:
            return read_artifact_text_error("", "unsupported", "artifact_id_required")

        candidates = self._records.get(artifact_id, [])
        if not candidates:
            return read_artifact_text_error(artifact_id, "not_found", "artifact_not_found")

        for record in candidates:
            if record.user_id == user_id and record.session_id == session_id:
                return read_artifact_text_success(
                    artifact_id=artifact_id,
                    text=record.text,
                    source=record.source,
                )

        return read_artifact_text_error(artifact_id, "forbidden", "artifact_not_in_trusted_session_scope")


async def execute_read_artifact_text(
    args: Mapping[str, Any],
    *,
    user_id: str,
    session_id: str,
    backend: CoreviewArtifactTextBackend | None = None,
) -> dict[str, Any]:
    selected_backend = backend or UnavailableCoreviewArtifactTextBackend()
    return await selected_backend.read_artifact_text(args, user_id=user_id, session_id=session_id)


def read_artifact_text_success(
    *,
    artifact_id: str,
    text: str,
    source: str,
) -> dict[str, Any]:
    truncated_text = text[:READ_ARTIFACT_TEXT_MAX_CHARS]
    return {
        "ok": True,
        "artifact_id": artifact_id,
        "text": truncated_text,
        "source": source,
        "truncated": len(text) > READ_ARTIFACT_TEXT_MAX_CHARS,
        "char_count": len(text),
    }


def read_artifact_text_error(
    artifact_id: str,
    status: str,
    safe_reason: str,
) -> dict[str, Any]:
    return {
        "ok": False,
        "artifact_id": artifact_id,
        "status": status,
        "safe_reason": safe_reason,
    }


def redacted_read_artifact_text_diagnostic(response: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "ok": bool(response.get("ok")),
        "artifact_id": str(response.get("artifact_id") or ""),
        "status": str(response.get("status") or ("success" if response.get("ok") else "error")),
        "source": str(response.get("source") or "unknown"),
        "char_count": int(response.get("char_count") or 0),
        "truncated": bool(response.get("truncated")),
        "safe_reason": str(response.get("safe_reason") or ""),
        "raw_artifact_text_excluded": True,
    }


def _artifact_id_from_args(args: Mapping[str, Any]) -> str | None:
    artifact_id = args.get("artifact_id")
    if not isinstance(artifact_id, str):
        return None
    stripped = artifact_id.strip()
    if not stripped or len(stripped) > 512:
        return None
    return stripped
