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

    def test_depth_accumulates_across_hops_in_same_chat(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Codex P1 regression: depth must accumulate across bot-to-bot
        hops in the same chat, NOT reset on each new message_id.

        Pre-fix: ``root_message_id`` was keyed to the per-hop summoning
        message_id, which changes every hop, so MAX_DEPTH was effectively
        bypassed. Post-fix: the guest-dispatch path uses ``chat_id``
        itself as the stable root, so all hops in the same chat count
        against one depth bucket.
        """
        from app.channels.telegram_loop_prevention import (
            ContentDedup,
            InteractionDepthTracker,
            LoopPreventionGate,
            PerSourceRateLimiter,
        )

        monkeypatch.setenv("TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT", "true")
        ch = WorkshopTelegramChannel(bus, {})
        # Inject a gate with a permissive rate limiter so the test
        # isolates the depth-tracker bug — distinct source bots and
        # distinct text per hop already keep dedup + rate happy in
        # principle, but tests should be deterministic.
        ch._loop_prevention = LoopPreventionGate(
            depth=InteractionDepthTracker(max_depth=5),
            rate=PerSourceRateLimiter(rate_per_second=100, burst=100),
            dedup=ContentDedup(),
        )

        chat_id = 7
        # Five hops using ``chat_id`` as the root, matching the new
        # production code path. Each hop has distinct text so dedup
        # doesn't trip.
        for i in range(5):
            ok = ch.check_loop_prevention(
                chat_id=chat_id,
                root_message_id=chat_id,
                source_bot_id=100 + i,  # vary bot id so rate is per-source happy
                text=f"hop {i}",
            )
            assert ok is True, f"hop {i + 1} should pass (depth {i + 1} <= 5)"
        # The 6th hop must be blocked — depth exceeds MAX_DEPTH=5.
        ok = ch.check_loop_prevention(
            chat_id=chat_id,
            root_message_id=chat_id,
            source_bot_id=999,
            text="hop 5 — must be blocked",
        )
        assert ok is False, "depth tracker must block beyond MAX_DEPTH"

    def test_depth_resets_for_distinct_chats(self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch) -> None:
        """Per-chat root means cross-chat traffic does not share a bucket."""
        from app.channels.telegram_loop_prevention import (
            ContentDedup,
            InteractionDepthTracker,
            LoopPreventionGate,
            PerSourceRateLimiter,
        )

        monkeypatch.setenv("TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT", "true")
        ch = WorkshopTelegramChannel(bus, {})
        ch._loop_prevention = LoopPreventionGate(
            depth=InteractionDepthTracker(max_depth=3),
            rate=PerSourceRateLimiter(rate_per_second=100, burst=100),
            dedup=ContentDedup(),
        )

        # Saturate chat 1's bucket to its cap.
        for i in range(3):
            ch.check_loop_prevention(chat_id=1, root_message_id=1, source_bot_id=100 + i, text=f"a{i}")
        # Chat 2 must still be admitted — separate bucket.
        ok = ch.check_loop_prevention(chat_id=2, root_message_id=2, source_bot_id=200, text="z")
        assert ok is True
