"""Dynamic channel session resolution helpers."""

from __future__ import annotations

from typing import Any, TypedDict

from app.channels.message_bus import InboundMessage
from app.channels.telegram_linking import get_telegram_link_store


class ResolvedChannelSession(TypedDict, total=False):
    assistant_id: str
    config: dict[str, Any]
    context: dict[str, Any]


def _normalize_context_mode(value: Any) -> str:
    if isinstance(value, str) and value in {"work", "gaming", "life"}:
        return value
    return "life"


def resolve_channel_session(
    msg: InboundMessage,
    thread_id: str,
) -> ResolvedChannelSession | None:
    """Return dynamic run overrides for channel/user combinations."""
    if msg.channel_name != "telegram":
        return None

    link_store = get_telegram_link_store()
    link = link_store.get_link_by_chat(msg.chat_id)
    if not link:
        return None

    sophia_user_id = link.get("user_id")
    if not isinstance(sophia_user_id, str) or not sophia_user_id:
        return None

    context_mode = _normalize_context_mode(link.get("context_mode"))
    return {
        "assistant_id": "sophia_companion",
        "config": {
            "configurable": {
                "user_id": sophia_user_id,
                "platform": "text",
                "context_mode": context_mode,
                "ritual": None,
                "thread_id": thread_id,
                "channel": "telegram",
                "memory_backend": "native",
            },
        },
        "context": {
            "channel_name": "telegram",
            "platform": "text",
            "context_mode": context_mode,
            "user_id": sophia_user_id,
            "thread_id": thread_id,
        },
    }
