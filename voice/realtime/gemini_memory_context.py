from __future__ import annotations

import importlib
import logging
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from voice.realtime.sophia_prompt import (
    build_gemini_live_spoken_turn_policy_overlay,
    build_sophia_realtime_instructions,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS_PACKAGE_PATH = REPO_ROOT / "backend" / "packages" / "harness"
USERS_DIR = REPO_ROOT / "users"

IDENTITY_EXCERPT_MAX_CHARS = 1200
HANDOFF_EXCERPT_MAX_CHARS = 900
MEMORY_SNIPPET_MAX_CHARS = 240
GEMINI_LIVE_MEMORY_LIMIT = 4

_MEMORY_CONTEXT_SCHEMA = "gemini_live_memory_context_v1"
_USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9._@+:|-]{1,128}$")
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GeminiLiveMemoryContext:
    prompt_block: str | None
    diagnostics: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class _MemorySnippet:
    content: str
    category: str | None = None


def build_gemini_live_realtime_instructions_with_memory_context(
    *,
    user_id: str,
    platform: str = "voice",
    context_mode: str = "life",
    ritual: str | None = None,
) -> tuple[str, GeminiLiveMemoryContext]:
    """Build Gemini Live setup instructions with trusted user context before setup minting."""
    memory_context = build_gemini_live_memory_context(
        user_id=user_id,
        context_mode=context_mode,
        ritual=ritual,
    )
    blocks = [
        build_sophia_realtime_instructions(
            platform=platform,
            context_mode=context_mode,
            ritual=ritual,
        ),
        memory_context.prompt_block,
        build_gemini_live_spoken_turn_policy_overlay(),
    ]
    instructions = "\n\n---\n\n".join(block.strip() for block in blocks if block and block.strip())
    return instructions, memory_context


def build_gemini_live_memory_context(
    *,
    user_id: str,
    context_mode: str = "life",
    ritual: str | None = None,
    memory_limit: int = GEMINI_LIVE_MEMORY_LIMIT,
) -> GeminiLiveMemoryContext:
    diagnostics: dict[str, Any] = {
        "schema": _MEMORY_CONTEXT_SCHEMA,
        "trusted_user_context": True,
        "injected": False,
        "preferred_name_present": False,
        "identity_excerpt_present": False,
        "handoff_excerpt_present": False,
        "memory_count": 0,
        "memory_limit": memory_limit,
        "memory_categories": [],
        "mem0_attempted": False,
        "mem0_status": "not_attempted",
    }

    try:
        safe_user_id = _validate_user_id(user_id)
    except ValueError:
        diagnostics["status"] = "invalid_user_id"
        return GeminiLiveMemoryContext(prompt_block=None, diagnostics=diagnostics)

    identity_text = _read_user_text_file(safe_user_id, "identity.md")
    handoff_text = _read_user_text_file(safe_user_id, "handoffs", "latest.md")
    preferred_name = _extract_preferred_name(identity_text) or _extract_preferred_name(handoff_text)
    identity_excerpt = _bounded_text(identity_text, IDENTITY_EXCERPT_MAX_CHARS)
    handoff_excerpt = _bounded_text(handoff_text, HANDOFF_EXCERPT_MAX_CHARS)
    memories, mem0_status, mem0_provider_reason = _search_mem0_memories(
        user_id=safe_user_id,
        context_mode=context_mode,
        ritual=ritual,
        limit=memory_limit,
    )

    diagnostics.update(
        {
            "preferred_name_present": preferred_name is not None,
            "identity_excerpt_present": identity_excerpt is not None,
            "handoff_excerpt_present": handoff_excerpt is not None,
            "memory_count": len(memories),
            "memory_categories": sorted({memory.category for memory in memories if memory.category}),
            "mem0_attempted": mem0_status != "not_configured",
            "mem0_status": mem0_status,
            "mem0_provider_reason": mem0_provider_reason,
            "identity_excerpt_chars": len(identity_excerpt or ""),
            "handoff_excerpt_chars": len(handoff_excerpt or ""),
            "memory_chars": sum(len(memory.content) for memory in memories),
        }
    )

    prompt_block = _render_memory_context_block(
        preferred_name=preferred_name,
        identity_excerpt=identity_excerpt,
        handoff_excerpt=handoff_excerpt,
        memories=memories,
    )
    diagnostics["injected"] = prompt_block is not None
    diagnostics["status"] = "injected" if prompt_block else "empty"
    logger.info(
        "gemini_live.memory_context status=%s preferred_name=%s identity=%s handoff=%s memories=%d mem0=%s",
        diagnostics["status"],
        diagnostics["preferred_name_present"],
        diagnostics["identity_excerpt_present"],
        diagnostics["handoff_excerpt_present"],
        diagnostics["memory_count"],
        diagnostics["mem0_status"],
    )
    return GeminiLiveMemoryContext(prompt_block=prompt_block, diagnostics=diagnostics)


def _render_memory_context_block(
    *,
    preferred_name: str | None,
    identity_excerpt: str | None,
    handoff_excerpt: str | None,
    memories: list[_MemorySnippet],
) -> str | None:
    if not any((preferred_name, identity_excerpt, handoff_excerpt, memories)):
        return None

    lines = [
        "<gemini_live_user_context>",
        "This block comes from the authenticated Sophia user context before the Gemini Live setup message is minted.",
        "Use it quietly for continuity and personalization. Do not mention files, Mem0, setup, diagnostics, or retrieval mechanics aloud.",
        "Preferred name, identity excerpts, and handoff excerpts are setup context from earlier; stored memories are only the items listed under Relevant stored memories.",
        "If the user asks what you remember, answer only from concrete details present here or from a retrieve_memories result, be brief, and label the source honestly.",
    ]
    if preferred_name:
        lines.append(f"Preferred name: {preferred_name}")
    if identity_excerpt:
        lines.extend(["", "Stored identity excerpt:", identity_excerpt])
    if handoff_excerpt:
        lines.extend(["", "Latest session handoff excerpt:", handoff_excerpt])
    if memories:
        lines.append("")
        lines.append("Relevant stored memories:")
        for memory in memories:
            label = f"[{memory.category}] " if memory.category else ""
            lines.append(f"- {label}{memory.content}")
    lines.append("</gemini_live_user_context>")
    return "\n".join(lines)


def _search_mem0_memories(
    *,
    user_id: str,
    context_mode: str,
    ritual: str | None,
    limit: int,
) -> tuple[list[_MemorySnippet], str, str | None]:
    try:
        mem0_client = _mem0_client_module()
    except Exception:
        logger.warning("gemini_live.memory_context Mem0 search function unavailable", exc_info=True)
        return [], "unavailable", "import_error"

    provider_status = mem0_client.memory_provider_status()
    provider_reason = str(provider_status.get("provider_reason") or "client_unavailable")
    if not provider_status.get("available"):
        if provider_reason == "missing_api_key":
            return [], "not_configured", provider_reason
        return [], "unavailable", provider_reason

    query = _memory_context_query(context_mode=context_mode, ritual=ritual)
    try:
        search_result = mem0_client.search_memories_with_diagnostics(
            user_id=user_id,
            query=query,
            categories=_memory_categories(context_mode=context_mode, ritual=ritual),
            context_mode=context_mode,
            limit=limit,
            log_content_previews=False,
            raise_on_error=True,
        )
    except Exception:
        logger.warning("gemini_live.memory_context Mem0 search failed", exc_info=True)
        return [], "failed", "provider_exception"

    raw_memories = search_result.get("memories", []) if isinstance(search_result, Mapping) else []
    snippets = [_normalize_memory_snippet(memory) for memory in raw_memories]
    snippets = [snippet for snippet in snippets if snippet is not None]
    status = str(search_result.get("provider_reason") or "ok") if isinstance(search_result, Mapping) else "ok"
    return snippets[:limit], "ok" if snippets or status in {"sdk_client", "rest_fallback", "cache_hit"} else status, status


def _mem0_client_module() -> Any:
    harness_path = str(HARNESS_PACKAGE_PATH)
    if harness_path not in sys.path:
        sys.path.insert(0, harness_path)
    return importlib.import_module("deerflow.sophia.mem0_client")


def _normalize_memory_snippet(memory: object) -> _MemorySnippet | None:
    if not isinstance(memory, Mapping):
        return None
    raw_content = memory.get("content") or memory.get("memory")
    if not isinstance(raw_content, str) or not raw_content.strip():
        return None
    category = memory.get("category")
    content = _collapse_whitespace(raw_content)
    if len(content) > MEMORY_SNIPPET_MAX_CHARS:
        content = content[: MEMORY_SNIPPET_MAX_CHARS - 1].rstrip() + "..."
    return _MemorySnippet(
        content=content,
        category=category.strip() if isinstance(category, str) and category.strip() else None,
    )


def _memory_context_query(*, context_mode: str, ritual: str | None) -> str:
    parts = [
        "stable facts, preferred name, communication preferences, relationships, commitments, emotional patterns, and useful context about this user",
    ]
    normalized_context = context_mode if context_mode in {"work", "gaming", "life"} else "life"
    parts.append(f"current context mode: {normalized_context}")
    if ritual:
        parts.append(f"active ritual: {ritual}")
    return ". ".join(parts)


def _memory_categories(*, context_mode: str, ritual: str | None) -> list[str]:
    categories = ["fact", "preference", "relationship", "feeling", "commitment", "decision", "lesson", "pattern"]
    if ritual:
        categories.append("ritual_context")
    if context_mode == "work":
        categories.extend(["project", "colleague", "career", "deadline"])
    elif context_mode == "gaming":
        categories.extend(["game", "achievement", "gaming_team", "strategy"])
    elif context_mode == "life":
        categories.extend(["family", "health", "personal_goal", "life_event"])
    return categories


def _read_user_text_file(user_id: str, *segments: str) -> str | None:
    path = _safe_user_path(user_id, *segments)
    if not path.exists() or not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("gemini_live.memory_context could not read user context file %s", "/".join(segments), exc_info=True)
        return None


def _safe_user_path(user_id: str, *segments: str) -> Path:
    safe_user_id = _validate_user_id(user_id)
    target = USERS_DIR / safe_user_id / Path(*segments)
    resolved = target.resolve()
    base_resolved = USERS_DIR.resolve()
    if not resolved.is_relative_to(base_resolved):
        raise ValueError("Path traversal detected")
    return target


def _validate_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("Invalid user_id format")
    if user_id != user_id.strip():
        raise ValueError("Invalid user_id format")
    if any(ch in user_id for ch in ("/", "\\", "\x00")) or ".." in user_id:
        raise ValueError("Invalid user_id format")
    if not _USER_ID_PATTERN.match(user_id):
        raise ValueError("Invalid user_id format")
    return user_id


def _extract_preferred_name(text: str | None) -> str | None:
    if not text:
        return None
    explicit = re.search(
        r"(?im)^\s*(?:preferred[_ -]?name|display[_ -]?name|name)\s*:\s*([^\n#]{1,80})",
        text,
    )
    if explicit:
        return _clean_preferred_name(explicit.group(1))

    inferred = re.search(
        r"(?m)^\s*([A-Z][A-Za-z'_-]{1,40})\s+"
        r"(?:responds|prefers|likes|wants|needs|arrives|uses|is|has)\b",
        text,
    )
    if inferred:
        return _clean_preferred_name(inferred.group(1))

    session_initiated = re.search(r"(?i)\bsession initiated with\s+([A-Z][A-Za-z'_-]{1,40})\b", text)
    if session_initiated:
        return _clean_preferred_name(session_initiated.group(1))
    return None


def _clean_preferred_name(value: str) -> str | None:
    name = value.strip().strip("-:.,;()[]{}\"'")
    name = re.split(r"\s+(?:responds|prefers|likes|wants|needs|arrives|uses|is|has)\b", name, maxsplit=1)[0].strip()
    if not name or len(name) > 60:
        return None
    if any(ch in name for ch in ("/", "\\", "\x00", "<", ">", "{" , "}")):
        return None
    if name.lower() in {"user", "unknown", "anonymous", "none", "null", "n/a"}:
        return None
    return name


def _bounded_text(text: str | None, limit: int) -> str | None:
    if not text:
        return None
    normalized = _collapse_whitespace(text)
    if not normalized:
        return None
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "..."


def _collapse_whitespace(value: str) -> str:
    return " ".join(value.split())
