from __future__ import annotations

import base64
import logging
import mimetypes
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from deerflow.config.paths import get_paths
from deerflow.sophia.storage import supabase_artifact_store

logger = logging.getLogger(__name__)

OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
BUILDER_DELIVERY_MAX_INLINE_BYTES = 15 * 1024 * 1024


def normalize_builder_artifact_path(path: str) -> str | None:
    raw = str(path).strip()
    if not raw:
        return None
    if raw.startswith(OUTPUTS_VIRTUAL_PREFIX):
        return raw
    if raw.startswith("/mnt/user-data/outputs"):
        suffix = raw.removeprefix("/mnt/user-data/outputs").lstrip("/")
        return f"{OUTPUTS_VIRTUAL_PREFIX}{suffix}" if suffix else None
    if raw.startswith("outputs/"):
        return f"{OUTPUTS_VIRTUAL_PREFIX}{raw.removeprefix('outputs/')}"
    if raw.startswith("./outputs/"):
        return f"{OUTPUTS_VIRTUAL_PREFIX}{raw.removeprefix('./outputs/')}"
    if raw.startswith("/mnt/user-data/"):
        return None

    normalized = raw.replace("\\", "/")
    if "/outputs/" in normalized:
        return f"{OUTPUTS_VIRTUAL_PREFIX}{normalized.rsplit('/outputs/', 1)[1].lstrip('/')}"

    filename = Path(normalized).name.strip()
    if not filename or filename in {".", ".."}:
        return None
    return f"{OUTPUTS_VIRTUAL_PREFIX}{filename}"


def extract_builder_artifact_paths(builder_result: Mapping[str, Any]) -> list[str]:
    candidates: list[str] = []
    primary = builder_result.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = builder_result.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized_path = normalize_builder_artifact_path(candidate)
        if not normalized_path or normalized_path in seen:
            continue
        seen.add(normalized_path)
        normalized.append(normalized_path)
    return normalized


def build_builder_delivery_payload(
    *,
    thread_id: str | None,
    builder_result: Mapping[str, Any],
    max_inline_bytes: int = BUILDER_DELIVERY_MAX_INLINE_BYTES,
) -> dict[str, Any] | None:
    if not thread_id:
        logger.warning("[BuilderDelivery] missing thread_id; cannot build delivery payload")
        return None

    paths = get_paths()
    outputs_dir = paths.sandbox_outputs_dir(thread_id).resolve()
    attachments: list[dict[str, Any]] = []

    for virtual_path in extract_builder_artifact_paths(builder_result):
        try:
            actual = paths.resolve_virtual_path(thread_id, virtual_path)
            try:
                actual.resolve().relative_to(outputs_dir)
            except ValueError:
                logger.warning("[BuilderDelivery] resolved path escaped outputs dir: %s -> %s", virtual_path, actual)
                continue
            if not actual.is_file():
                # Supabase fallback for split-process topologies (e.g. Render)
                # where the builder wrote the file on the LangGraph host and the
                # Gateway host cannot see the local disk.
                relative = virtual_path.removeprefix(OUTPUTS_VIRTUAL_PREFIX).lstrip("/")
                supabase_result = None
                if supabase_artifact_store.is_configured() and relative:
                    try:
                        supabase_result = supabase_artifact_store.download_artifact(
                            thread_id=thread_id,
                            filename=relative,
                        )
                    except Exception:
                        logger.warning(
                            "[BuilderDelivery] Supabase fallback failed for %s",
                            virtual_path,
                            exc_info=True,
                        )
                if supabase_result is not None:
                    content, supabase_mime = supabase_result
                    size = len(content)
                    if size > max_inline_bytes:
                        logger.warning(
                            "[BuilderDelivery] skipping %s (%d bytes > %d inline limit)",
                            virtual_path,
                            size,
                            max_inline_bytes,
                        )
                        continue
                    mime_type = (
                        supabase_mime
                        or mimetypes.guess_type(relative)[0]
                        or "application/octet-stream"
                    )
                    attachments.append(
                        {
                            "virtual_path": virtual_path,
                            "filename": Path(relative).name,
                            "mime_type": mime_type,
                            "size": size,
                            "is_image": mime_type.startswith("image/"),
                            "content_base64": base64.b64encode(content).decode("ascii"),
                        }
                    )
                    logger.info(
                        "[BuilderDelivery] Supabase fallback succeeded: %s (%d bytes)",
                        virtual_path,
                        size,
                    )
                    continue
                logger.warning("[BuilderDelivery] artifact not found on disk: %s -> %s", virtual_path, actual)
                continue
            size = actual.stat().st_size
            if size > max_inline_bytes:
                logger.warning(
                    "[BuilderDelivery] skipping %s (%d bytes > %d inline limit)",
                    virtual_path,
                    size,
                    max_inline_bytes,
                )
                continue
            mime_type, _ = mimetypes.guess_type(str(actual))
            mime_type = mime_type or "application/octet-stream"
            attachments.append(
                {
                    "virtual_path": virtual_path,
                    "filename": actual.name,
                    "mime_type": mime_type,
                    "size": size,
                    "is_image": mime_type.startswith("image/"),
                    "content_base64": base64.b64encode(actual.read_bytes()).decode("ascii"),
                }
            )
        except (ValueError, OSError):
            logger.warning("[BuilderDelivery] failed to prepare artifact: %s", virtual_path, exc_info=True)

    if not attachments:
        return None

    return {
        "source": "builder_result",
        "attachments": attachments,
    }
