from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from voice.realtime.sophia_prompt import (
    build_gemini_live_spoken_turn_policy_overlay,
    build_sophia_realtime_instructions,
)
from voice.realtime.skill_slow_state import (
    VoiceSkillSlowStateSeed,
    build_voice_skill_state_seed_block,
    voice_skill_slow_state_seed_diagnostics,
    voice_skill_slow_state_seed_from_setup_context,
)

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
    skill_state_prompt_block: str | None = None
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
    backend_context: Mapping[str, Any] | None = None,
) -> tuple[str, GeminiLiveMemoryContext]:
    """Build Gemini Live setup instructions with trusted user context before setup minting."""
    memory_context = build_gemini_live_memory_context(
        user_id=user_id,
        context_mode=context_mode,
        ritual=ritual,
        backend_context=backend_context,
    )
    skill_state_prompt_block = memory_context.skill_state_prompt_block or build_voice_skill_state_seed_block()
    blocks = [
        build_sophia_realtime_instructions(
            platform=platform,
            context_mode=context_mode,
            ritual=ritual,
        ),
        memory_context.prompt_block,
        skill_state_prompt_block,
        build_gemini_live_spoken_turn_policy_overlay(),
    ]
    instructions = "\n\n---\n\n".join(block.strip() for block in blocks if block and block.strip())
    return instructions, memory_context


def build_gemini_live_memory_context(
    *,
    user_id: str,
    context_mode: str = "life",
    ritual: str | None = None,
    backend_context: Mapping[str, Any] | None = None,
    memory_limit: int = GEMINI_LIVE_MEMORY_LIMIT,
) -> GeminiLiveMemoryContext:
    diagnostics: dict[str, Any] = {
        "schema": _MEMORY_CONTEXT_SCHEMA,
        "trusted_user_context": True,
        "backend_context_status": "missing" if backend_context is None else "provided",
        "backend_context_schema": None,
        "injected": False,
        "preferred_name_present": False,
        "identity_excerpt_present": False,
        "handoff_excerpt_present": False,
        "identity_available": False,
        "handoff_available": False,
        "memory_count": 0,
        "memory_limit": memory_limit,
        "memory_categories": [],
        "mem0_attempted": backend_context is not None,
        "mem0_status": "unavailable",
        "mem0_provider_reason": "no_backend_context" if backend_context is None else None,
    }

    try:
        _validate_user_id(user_id)
    except ValueError:
        diagnostics["status"] = "invalid_user_id"
        seed = VoiceSkillSlowStateSeed()
        diagnostics["skill_state"] = voice_skill_slow_state_seed_diagnostics(seed)
        return GeminiLiveMemoryContext(
            prompt_block=None,
            skill_state_prompt_block=build_voice_skill_state_seed_block(seed),
            diagnostics=diagnostics,
        )

    preferred_name, identity_excerpt, handoff_excerpt, memories, backend_diagnostics = (
        _normalize_backend_context_payload(backend_context, memory_limit=memory_limit)
    )
    preferred_name = preferred_name or _extract_preferred_name(identity_excerpt) or _extract_preferred_name(handoff_excerpt)
    mem0_status = _normalize_mem0_status(backend_diagnostics.get("mem0_status"))
    mem0_provider_reason = (
        _clean_optional_text(backend_diagnostics.get("mem0_provider_reason"))
        or diagnostics["mem0_provider_reason"]
    )
    skill_state_seed = voice_skill_slow_state_seed_from_setup_context(
        identity_text=identity_excerpt,
        handoff_text=handoff_excerpt,
        memory_snippets=memories,
        recurring_patterns_known=mem0_status == "available",
    )

    diagnostics.update(
        {
            "backend_context_status": _clean_optional_text(backend_diagnostics.get("context_fetch_status"))
            or diagnostics["backend_context_status"],
            "backend_context_schema": _clean_optional_text(backend_diagnostics.get("schema")),
            "preferred_name_present": preferred_name is not None,
            "identity_excerpt_present": identity_excerpt is not None,
            "handoff_excerpt_present": handoff_excerpt is not None,
            "identity_available": bool(backend_diagnostics.get("identity_available", identity_excerpt is not None)),
            "handoff_available": bool(backend_diagnostics.get("handoff_available", handoff_excerpt is not None)),
            "memory_count": len(memories),
            "memory_categories": sorted({memory.category for memory in memories if memory.category}),
            "mem0_attempted": backend_context is not None,
            "mem0_status": mem0_status,
            "mem0_provider_reason": mem0_provider_reason,
            "identity_excerpt_chars": len(identity_excerpt or ""),
            "handoff_excerpt_chars": len(handoff_excerpt or ""),
            "memory_chars": sum(len(memory.content) for memory in memories),
            "skill_state": voice_skill_slow_state_seed_diagnostics(skill_state_seed),
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
    return GeminiLiveMemoryContext(
        prompt_block=prompt_block,
        skill_state_prompt_block=build_voice_skill_state_seed_block(skill_state_seed),
        diagnostics=diagnostics,
    )


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


def _normalize_backend_context_payload(
    payload: Mapping[str, Any] | None,
    *,
    memory_limit: int,
) -> tuple[str | None, str | None, str | None, list[_MemorySnippet], dict[str, Any]]:
    if not isinstance(payload, Mapping):
        return None, None, None, [], {}

    diagnostics = payload.get("diagnostics")
    if not isinstance(diagnostics, Mapping):
        diagnostics = {}

    preferred_name = _clean_preferred_name(_clean_optional_text(payload.get("preferred_name")) or "")
    identity_excerpt = _bounded_text(_clean_optional_text(payload.get("identity_excerpt")), IDENTITY_EXCERPT_MAX_CHARS)
    handoff_excerpt = _bounded_text(_clean_optional_text(payload.get("handoff_excerpt")), HANDOFF_EXCERPT_MAX_CHARS)
    raw_memories = payload.get("memories")
    if not isinstance(raw_memories, list):
        raw_memories = []
    memories = [_normalize_memory_snippet(memory) for memory in raw_memories]
    memories = [memory for memory in memories if memory is not None]
    return preferred_name, identity_excerpt, handoff_excerpt, memories[:memory_limit], dict(diagnostics)


def _normalize_memory_snippet(memory: object) -> _MemorySnippet | None:
    if not isinstance(memory, Mapping):
        return None
    raw_content = memory.get("content") or memory.get("memory")
    if not isinstance(raw_content, str) or not raw_content.strip():
        return None
    category = _clean_optional_text(memory.get("category"))
    content = _collapse_whitespace(raw_content)
    if len(content) > MEMORY_SNIPPET_MAX_CHARS:
        content = content[: MEMORY_SNIPPET_MAX_CHARS - 1].rstrip() + "..."
    return _MemorySnippet(
        content=content,
        category=category,
    )


def _normalize_mem0_status(value: object) -> str:
    status = _clean_optional_text(value)
    if status in {"available", "missing_api_key", "unavailable", "error"}:
        return status
    return "unavailable"


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


def _clean_optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _collapse_whitespace(value: str) -> str:
    return " ".join(value.split())
