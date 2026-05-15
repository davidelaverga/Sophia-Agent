"""Regression tests for channel_origin normalization (codex P2 fix).

``BuilderEvent.channel_origin`` only accepts ``telegram | web | voice``.
The manager must normalize ``msg.channel_name`` before writing it to
``configurable.channel``; otherwise raw values like ``"slack"`` /
``"feishu"`` flow through to the terminal webhook and the fanout's
pydantic Literal validation drops the event silently — trace +
companion-awareness sinks would never fire for builder runs from
those surfaces.
"""

from __future__ import annotations

import pytest

from app.channels.manager import _normalize_channel_origin
from app.gateway.builder_events.adapters import (
    _VALID_CHANNEL_ORIGINS,
    _coerce_channel_origin,
    adapt_terminal_webhook,
)
from app.gateway.builder_events.types import CompletedEvent


class TestNormalizeAtManager:
    @pytest.mark.parametrize(
        ("channel_name", "expected"),
        [
            ("telegram", "telegram"),
            ("telegram_work", "telegram"),
            ("telegram_workshop", "telegram"),
            ("telegram_anything_future", "telegram"),
            ("voice", "voice"),
            ("web", "web"),
            ("slack", "web"),
            ("feishu", "web"),
            ("discord_imagined", "web"),
            ("", "web"),
        ],
    )
    def test_normalize_maps_to_supported_origins(self, channel_name: str, expected: str) -> None:
        assert _normalize_channel_origin(channel_name) == expected

    def test_every_normalized_value_is_accepted_by_builder_event(self) -> None:
        """The output set must be a subset of BuilderEvent.channel_origin."""
        for raw in ["telegram", "telegram_work", "voice", "web", "slack", "feishu", ""]:
            normalized = _normalize_channel_origin(raw)
            assert normalized in _VALID_CHANNEL_ORIGINS, (
                f"normalize returned {normalized!r} for {raw!r} — not in {_VALID_CHANNEL_ORIGINS}"
            )


class TestAdapterCoerce:
    @pytest.mark.parametrize("value", sorted(_VALID_CHANNEL_ORIGINS))
    def test_valid_origin_passes_through(self, value: str) -> None:
        assert _coerce_channel_origin(value, task_id="t") == value

    @pytest.mark.parametrize("value", ["slack", "feishu", "unknown", ""])
    def test_unknown_origin_coerced_to_web(self, value: str) -> None:
        assert _coerce_channel_origin(value, task_id="t") == "web"


class TestAdapterEndToEnd:
    """Codex P2 regression — terminal webhook must NOT silently drop
    when an in-flight builder run carries a raw non-supported origin.
    """

    def test_slack_origin_does_not_drop_terminal_event(self) -> None:
        payload = {
            "task_id": "task-slack",
            "thread_id": "thread-slack",
            "status": "success",
            "user_id": "u",
            "summary": "All done.",
            "artifact_filename": "report.pdf",
        }
        evt = adapt_terminal_webhook(payload, channel_origin="slack")
        # Pre-fix this returned None. Post-fix the adapter coerces to
        # 'web' and the CompletedEvent is constructed successfully.
        assert evt is not None
        assert isinstance(evt, CompletedEvent)
        assert evt.channel_origin == "web"
        assert evt.task_id == "task-slack"

    def test_telegram_origin_still_passes(self) -> None:
        payload = {
            "task_id": "task-tg",
            "thread_id": "thread-tg",
            "status": "success",
            "user_id": "u",
        }
        evt = adapt_terminal_webhook(payload, channel_origin="telegram")
        assert evt is not None
        assert evt.channel_origin == "telegram"

    def test_missing_thread_id_still_drops(self) -> None:
        """Sanity: only the channel_origin gate is relaxed."""
        payload = {"task_id": "t", "status": "success"}
        assert adapt_terminal_webhook(payload, channel_origin="slack") is None
