"""Tests for Telegram linking persistence and session resolver behavior."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from app.channels.message_bus import InboundMessage
from app.channels.session_resolver import resolve_channel_session
from app.channels.telegram_linking import TelegramLinkStore


def test_issue_and_redeem_link_token_once(tmp_path):
    store = TelegramLinkStore(path=tmp_path / "telegram_links.json")

    issued = store.issue_link_token(
        sophia_user_id="user_123",
        context_mode="work",
        ttl_seconds=300,
    )
    assert issued["token"]

    linked = store.redeem_link_token(
        token=issued["token"],
        telegram_chat_id="777",
        telegram_user_id="888",
        telegram_username="oz_user",
    )
    assert linked is not None
    assert linked["user_id"] == "user_123"
    assert linked["context_mode"] == "work"
    assert linked["telegram_chat_id"] == "777"

    # One-time token: second redemption should fail.
    assert (
        store.redeem_link_token(
            token=issued["token"],
            telegram_chat_id="777",
            telegram_user_id="888",
        )
        is None
    )


def test_expired_token_cannot_be_redeemed(tmp_path):
    path = tmp_path / "telegram_links.json"
    store = TelegramLinkStore(path=path)
    issued = store.issue_link_token(sophia_user_id="user_123", ttl_seconds=120)

    data = json.loads(path.read_text(encoding="utf-8"))
    token_key = next(iter(data["tokens"].keys()))
    data["tokens"][token_key]["expires_at"] = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    path.write_text(json.dumps(data), encoding="utf-8")

    # Reload from disk to pick up the modified expiration.
    reloaded = TelegramLinkStore(path=path)
    assert (
        reloaded.redeem_link_token(
            token=issued["token"],
            telegram_chat_id="777",
            telegram_user_id="888",
        )
        is None
    )


def test_touch_and_unlink(tmp_path):
    store = TelegramLinkStore(path=tmp_path / "telegram_links.json")
    issued = store.issue_link_token(sophia_user_id="user_123", context_mode="life")
    linked = store.redeem_link_token(
        token=issued["token"],
        telegram_chat_id="777",
        telegram_user_id="888",
    )
    assert linked is not None

    before = store.get_link_by_chat("777")
    assert before is not None
    before_seen = before["last_seen_at"]

    store.touch_chat_activity("777")
    after = store.get_link_by_chat("777")
    assert after is not None
    assert after["last_seen_at"] >= before_seen

    assert store.unlink_user("user_123") is True
    assert store.get_link_by_chat("777") is None
    assert store.get_link_by_user("user_123") is None


def test_redeem_replaces_existing_chat_owner_reverse_mapping(tmp_path):
    store = TelegramLinkStore(path=tmp_path / "telegram_links.json")
    first = store.issue_link_token(sophia_user_id="user_111", context_mode="life")
    second = store.issue_link_token(sophia_user_id="user_222", context_mode="work")

    linked_first = store.redeem_link_token(
        token=first["token"],
        telegram_chat_id="777",
        telegram_user_id="888",
    )
    assert linked_first is not None
    assert store.get_link_by_user("user_111") is not None

    linked_second = store.redeem_link_token(
        token=second["token"],
        telegram_chat_id="777",
        telegram_user_id="999",
    )
    assert linked_second is not None
    assert linked_second["user_id"] == "user_222"
    assert store.get_link_by_user("user_111") is None
    assert store.get_link_by_chat("777")["user_id"] == "user_222"  # type: ignore[index]

    # Old owner should no longer be able to remove the active chat link.
    assert store.unlink_user("user_111") is False
    assert store.get_link_by_chat("777")["user_id"] == "user_222"  # type: ignore[index]


def test_resolve_channel_session_uses_telegram_link(monkeypatch, tmp_path):
    store = TelegramLinkStore(path=tmp_path / "telegram_links.json")
    issued = store.issue_link_token(sophia_user_id="user_123", context_mode="gaming")
    store.redeem_link_token(
        token=issued["token"],
        telegram_chat_id="777",
        telegram_user_id="888",
    )

    monkeypatch.setattr("app.channels.session_resolver.get_telegram_link_store", lambda: store)
    msg = InboundMessage(
        channel_name="telegram",
        chat_id="777",
        user_id="888",
        text="hello",
    )
    resolved = resolve_channel_session(msg, thread_id="thread-1")
    assert resolved is not None
    assert resolved["assistant_id"] == "sophia_companion"
    assert resolved["config"]["configurable"]["user_id"] == "user_123"
    assert resolved["config"]["configurable"]["context_mode"] == "gaming"
    assert resolved["config"]["configurable"]["memory_backend"] == "native"


def test_resolve_channel_session_non_telegram_returns_none():
    msg = InboundMessage(
        channel_name="slack",
        chat_id="c1",
        user_id="u1",
        text="hello",
    )
    assert resolve_channel_session(msg, thread_id="thread-1") is None
