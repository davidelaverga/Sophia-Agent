"""Phase 1 regression tests for the Telegram dual-bot architecture.

Phase 1 is config-only: the channel reads `worker_bot_token` from its config
dict and logs whether it is set. No second client is built and no behavior
changes — these tests pin that surface so Phase 2/3 wiring lands cleanly.
"""

from __future__ import annotations

import logging

import pytest

from app.channels.message_bus import MessageBus
from app.channels.telegram import TelegramChannel


@pytest.fixture
def bus() -> MessageBus:
    return MessageBus()


class TestTelegramDualBotPhase1:
    def test_logs_when_worker_token_is_set(self, bus: MessageBus, caplog: pytest.LogCaptureFixture) -> None:
        config = {"bot_token": "primary", "worker_bot_token": "worker"}
        with caplog.at_level(logging.INFO, logger="app.channels.telegram"):
            TelegramChannel(bus, config)
        messages = [r.getMessage() for r in caplog.records]
        assert any("worker bot token configured" in m for m in messages), messages

    def test_logs_single_bot_mode_when_worker_token_is_absent(self, bus: MessageBus, caplog: pytest.LogCaptureFixture) -> None:
        config = {"bot_token": "primary"}
        with caplog.at_level(logging.INFO, logger="app.channels.telegram"):
            TelegramChannel(bus, config)
        messages = [r.getMessage() for r in caplog.records]
        assert any("single-bot mode" in m for m in messages), messages

    def test_logs_single_bot_mode_when_worker_token_is_empty_string(self, bus: MessageBus, caplog: pytest.LogCaptureFixture) -> None:
        # Graceful degradation: an empty `$TELEGRAM_WORKER_BOT_TOKEN` env var
        # resolves to an empty string in config; treat that as unset.
        config = {"bot_token": "primary", "worker_bot_token": ""}
        with caplog.at_level(logging.INFO, logger="app.channels.telegram"):
            TelegramChannel(bus, config)
        messages = [r.getMessage() for r in caplog.records]
        assert any("single-bot mode" in m for m in messages), messages

    def test_no_second_client_is_built_in_phase_1(self, bus: MessageBus) -> None:
        # Phase 1 commitment: even when a worker token is provided, no second
        # `Application` is constructed. Phase 3 introduces that wiring.
        config = {"bot_token": "primary", "worker_bot_token": "worker"}
        channel = TelegramChannel(bus, config)
        assert not hasattr(channel, "_worker_application")
