"""Unit tests for the WorkshopTelegramChannel Phase 1 skeleton."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.channels.message_bus import MessageBus
from app.channels.telegram_workshop import WorkshopTelegramChannel


@pytest.fixture
def bus() -> MessageBus:
    return MessageBus()


class TestWorkshopChannelConstruction:
    def test_disabled_by_default(self, bus: MessageBus) -> None:
        ch = WorkshopTelegramChannel(bus, {"bot_token": "t"})
        assert ch.name == "telegram_workshop"
        assert ch._config_enabled is False
        assert ch._bot_username == "Sophia_work_bot"

    def test_username_stripped(self, bus: MessageBus) -> None:
        ch = WorkshopTelegramChannel(bus, {"bot_username": "@SomeBot"})
        assert ch._bot_username == "SomeBot"


class TestWorkshopStartGuards:
    @pytest.mark.anyio
    async def test_disabled_short_circuits(self, bus: MessageBus) -> None:
        ch = WorkshopTelegramChannel(bus, {"enabled": False, "bot_token": "t"})
        await ch.start()
        assert ch.is_running is False

    @pytest.mark.anyio
    async def test_env_flag_can_disable(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Phase 2 of sophia_telegram_architecture_spec_v1: the env flag now
        # defaults to ON in production. The operator-facing kill switch is
        # ``TELEGRAM_WORKSHOP_BOT_ENABLED=false`` (or
        # ``channels.telegram_workshop.enabled: false`` in config).
        monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "false")
        ch = WorkshopTelegramChannel(bus, {"enabled": True, "bot_token": "t"})
        await ch.start()
        assert ch.is_running is False

    @pytest.mark.anyio
    async def test_missing_token_refuses_to_start(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
        ch = WorkshopTelegramChannel(bus, {"enabled": True, "bot_token": ""})
        await ch.start()
        assert ch.is_running is False

    @pytest.mark.anyio
    async def test_runs_when_all_flags_on(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Polling thread is spawned but never actually contacts Telegram."""
        monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
        monkeypatch.setattr(WorkshopTelegramChannel, "_legacy_work_channel_enabled", staticmethod(lambda: False))
        # Patch _run_polling so we don't actually try to network-init PTB.
        monkeypatch.setattr(WorkshopTelegramChannel, "_run_polling", lambda self: None)
        ch = WorkshopTelegramChannel(bus, {"enabled": True, "bot_token": "tok"})
        await ch.start()
        assert ch.is_running is True
        await ch.stop()
        assert ch.is_running is False

    @pytest.mark.anyio
    async def test_mutual_exclusion_with_telegram_work(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
        monkeypatch.setattr(WorkshopTelegramChannel, "_legacy_work_channel_enabled", staticmethod(lambda: True))
        monkeypatch.setattr(WorkshopTelegramChannel, "_run_polling", lambda self: None)
        ch = WorkshopTelegramChannel(bus, {"enabled": True, "bot_token": "tok"})
        await ch.start()
        assert ch.is_running is False


class TestColdDmRedirect:
    @pytest.mark.anyio
    async def test_first_dm_sends_redirect(self, bus: MessageBus) -> None:
        ch = WorkshopTelegramChannel(bus, {})
        bot_send = AsyncMock()
        ok = await ch.handle_cold_dm(telegram_user_id=42, bot_send=bot_send, chat_id=1)
        assert ok is True
        bot_send.assert_awaited_once()
        kwargs = bot_send.await_args.kwargs
        assert kwargs["chat_id"] == 1
        assert "Sophia's workshop" in kwargs["text"]
        assert "@Sophia_EI_bot" in kwargs["text"]

    @pytest.mark.anyio
    async def test_subsequent_dm_within_mute_window_silenced(self, bus: MessageBus) -> None:
        ch = WorkshopTelegramChannel(bus, {"cold_dm_mute_minutes": 30})
        bot_send = AsyncMock()
        await ch.handle_cold_dm(telegram_user_id=42, bot_send=bot_send, chat_id=1)
        # Second call within the mute window should be silenced.
        bot_send.reset_mock()
        ok = await ch.handle_cold_dm(telegram_user_id=42, bot_send=bot_send, chat_id=1)
        assert ok is False
        bot_send.assert_not_awaited()


class TestLoopPreventionGate:
    def test_strict_mode_blocks_violations(self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT", "true")
        ch = WorkshopTelegramChannel(bus, {})
        # Saturate the rate limiter
        for _ in range(10):
            ch.check_loop_prevention(chat_id=1, root_message_id=10, source_bot_id=100, text="hi")
        ok = ch.check_loop_prevention(chat_id=1, root_message_id=10, source_bot_id=100, text="hi" * 50)
        assert ok is False

    def test_non_strict_mode_logs_but_allows(self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT", "false")
        ch = WorkshopTelegramChannel(bus, {})
        # Saturate the rate limiter
        for _ in range(20):
            ch.check_loop_prevention(chat_id=1, root_message_id=10, source_bot_id=100, text=f"hi{_}")
        # In non-strict mode the gate should still return True
        ok = ch.check_loop_prevention(chat_id=1, root_message_id=10, source_bot_id=100, text="another")
        assert ok is True
