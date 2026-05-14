"""Unit tests for the TaskResolutionCache (spec §11.3)."""

from __future__ import annotations

import time

import pytest

from app.gateway.builder_events.task_resolution_cache import TaskResolutionCache


def test_register_then_resolve_round_trip() -> None:
    cache = TaskResolutionCache()
    cache.register(chat_id=1, message_id=42, task_id="task_x", user_id="user_a")
    assert cache.resolve(chat_id=1, message_id=42) == ("task_x", "user_a")


def test_resolve_unknown_returns_none() -> None:
    cache = TaskResolutionCache()
    assert cache.resolve(chat_id=1, message_id=2) is None


def test_string_keys_coerced_to_int() -> None:
    cache = TaskResolutionCache()
    cache.register(chat_id="1", message_id="42", task_id="t", user_id="u")
    assert cache.resolve(chat_id=1, message_id=42) == ("t", "u")


def test_expiry_removes_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    cache = TaskResolutionCache(ttl_seconds=1)
    cache.register(chat_id=1, message_id=2, task_id="t", user_id="u")
    # Advance time past TTL
    base = time.monotonic()
    monkeypatch.setattr(time, "monotonic", lambda: base + 5)
    assert cache.resolve(chat_id=1, message_id=2) is None


def test_lru_eviction_capped() -> None:
    cache = TaskResolutionCache(ttl_seconds=999, max_entries=2)
    cache.register(chat_id=1, message_id=10, task_id="a", user_id="u")
    cache.register(chat_id=1, message_id=11, task_id="b", user_id="u")
    cache.register(chat_id=1, message_id=12, task_id="c", user_id="u")
    # The oldest (10) should have been evicted.
    assert cache.size() == 2
    assert cache.resolve(chat_id=1, message_id=10) is None
    assert cache.resolve(chat_id=1, message_id=11) == ("b", "u")
    assert cache.resolve(chat_id=1, message_id=12) == ("c", "u")


def test_register_rejects_empty_task() -> None:
    cache = TaskResolutionCache()
    with pytest.raises(ValueError):
        cache.register(chat_id=1, message_id=2, task_id="", user_id="u")
    with pytest.raises(ValueError):
        cache.register(chat_id=1, message_id=2, task_id="t", user_id="")


def test_forget_removes_entry() -> None:
    cache = TaskResolutionCache()
    cache.register(chat_id=1, message_id=2, task_id="t", user_id="u")
    cache.forget(chat_id=1, message_id=2)
    assert cache.resolve(chat_id=1, message_id=2) is None
