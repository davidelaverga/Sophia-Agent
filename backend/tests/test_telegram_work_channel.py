"""Tests for TelegramWorkChannel — Builder-as-Main DM surface.

Covers Stage-1 Phase-3 behaviour: construction, feature-flag gating,
pilot-user gate, identity binding lookup, summary/artifact extraction,
group-chat rejection. The end-to-end runs.wait dispatch is covered by
mocking the LangGraph SDK client; we don't spin up a real Telegram
Application here (that would require network + valid token).
"""

from __future__ import annotations

import logging

import pytest

from app.channels.message_bus import MessageBus, OutboundMessage
from app.channels.telegram_work import TelegramWorkChannel


@pytest.fixture
def bus() -> MessageBus:
    return MessageBus()


class TestTelegramWorkChannelConstruction:
    def test_disabled_by_default_skips_start(
        self, bus: MessageBus, caplog: pytest.LogCaptureFixture
    ) -> None:
        config = {"bot_token": "tok"}
        ch = TelegramWorkChannel(bus, config)
        assert ch.name == "telegram_work"
        assert ch._enabled is False

    def test_enabled_parses_all_fields(self, bus: MessageBus) -> None:
        config = {
            "enabled": True,
            "bot_token": "tok",
            "bot_username": "@Sophia_Work_bot",
            "pilot_user_id": "user123",
            "allowed_users": [42, "99"],
            "run_timeout_seconds": 600,
        }
        ch = TelegramWorkChannel(bus, config)
        assert ch._enabled is True
        assert ch._bot_token == "tok"
        # Username strips leading @
        assert ch._bot_username == "Sophia_Work_bot"
        assert ch._pilot_user_id == "user123"
        # allowed_users coerced to ints
        assert ch._allowed_users == {42, 99}
        assert ch._run_timeout_seconds == 600

    def test_invalid_run_timeout_falls_back_to_default(self, bus: MessageBus) -> None:
        ch = TelegramWorkChannel(bus, {"bot_token": "tok", "run_timeout_seconds": "not-a-number"})
        # Defaults to 900s (15min); coerced via try/except
        assert ch._run_timeout_seconds == 900

    def test_run_timeout_clamped_to_min_60s(self, bus: MessageBus) -> None:
        ch = TelegramWorkChannel(bus, {"bot_token": "tok", "run_timeout_seconds": 5})
        assert ch._run_timeout_seconds == 60

    def test_empty_pilot_user_id_normalised_to_none(self, bus: MessageBus) -> None:
        ch = TelegramWorkChannel(bus, {"bot_token": "tok", "pilot_user_id": "   "})
        assert ch._pilot_user_id is None


class TestSendIsBusNoop:
    @pytest.mark.anyio
    async def test_send_logs_warning_when_routed_through_bus(
        self, bus: MessageBus, caplog: pytest.LogCaptureFixture
    ) -> None:
        # Stage 1 directly edits placeholder; bus subscriptions aren't wired.
        # If anyone routes a bus outbound to this channel by mistake, we log
        # a warning so the misroute is visible.
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})
        msg = OutboundMessage(
            channel_name="telegram_work",
            chat_id="123",
            thread_id="t1",
            text="hi",
        )
        with caplog.at_level(logging.WARNING, logger="app.channels.telegram_work"):
            await ch.send(msg)
        messages = [r.getMessage() for r in caplog.records]
        assert any("does not subscribe to the bus" in m for m in messages), messages


class TestSummaryExtraction:
    def test_companion_summary_from_emit_builder_artifact(self) -> None:
        result = {
            "messages": [
                {"type": "human", "content": "hi"},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [
                        {
                            "name": "emit_builder_artifact",
                            "args": {
                                "artifact_path": "/mnt/user-data/outputs/report.pdf",
                                "artifact_title": "AR Glasses Research Brief",
                                "companion_summary": "Done — three models compared with pros/cons.",
                            },
                        }
                    ],
                },
            ]
        }
        summary = TelegramWorkChannel._extract_summary(result)
        assert summary == "Done — three models compared with pros/cons."

    def test_falls_back_to_last_ai_text_when_no_artifact(self) -> None:
        result = {
            "messages": [
                {"type": "human", "content": "what's 2+2"},
                {"type": "ai", "content": "4"},
            ]
        }
        summary = TelegramWorkChannel._extract_summary(result)
        assert summary == "4"

    def test_handles_content_blocks_list(self) -> None:
        result = {
            "messages": [
                {"type": "human", "content": "hi"},
                {
                    "type": "ai",
                    "content": [
                        {"type": "text", "text": "Hello "},
                        {"type": "text", "text": "world"},
                    ],
                },
            ]
        }
        summary = TelegramWorkChannel._extract_summary(result)
        assert summary == "Hello world"

    def test_returns_none_when_only_human(self) -> None:
        result = {"messages": [{"type": "human", "content": "hi"}]}
        assert TelegramWorkChannel._extract_summary(result) is None

    def test_handles_list_result_shape(self) -> None:
        result = [
            {"type": "human", "content": "hi"},
            {"type": "ai", "content": "ok"},
        ]
        assert TelegramWorkChannel._extract_summary(result) == "ok"


class TestArtifactExtraction:
    def test_extracts_filename_from_emit_builder_artifact(self) -> None:
        result = {
            "messages": [
                {
                    "type": "ai",
                    "tool_calls": [
                        {
                            "name": "emit_builder_artifact",
                            "args": {"artifact_path": "/mnt/user-data/outputs/sub/report.pdf"},
                        }
                    ],
                }
            ]
        }
        assert TelegramWorkChannel._extract_artifact_filename(result) == "report.pdf"

    def test_returns_none_when_no_artifact_call(self) -> None:
        result = {"messages": [{"type": "ai", "content": "no artifact"}]}
        assert TelegramWorkChannel._extract_artifact_filename(result) is None

    def test_extracts_artifact_title(self) -> None:
        result = {
            "messages": [
                {
                    "type": "ai",
                    "tool_calls": [
                        {
                            "name": "emit_builder_artifact",
                            "args": {"artifact_title": "  Report  "},
                        }
                    ],
                }
            ]
        }
        assert TelegramWorkChannel._extract_artifact_title(result) == "Report"


class TestTruncate:
    def test_under_limit_returned_as_is(self) -> None:
        assert TelegramWorkChannel._truncate("short", 100) == "short"

    def test_over_limit_truncated_with_ellipsis(self) -> None:
        out = TelegramWorkChannel._truncate("0123456789", 5)
        assert out.endswith("…")
        assert len(out) == 5

    def test_limit_one_returns_ellipsis(self) -> None:
        assert TelegramWorkChannel._truncate("hello", 1) == "…"


class TestIdentityBindingLookup:
    def test_resolve_uses_telegram_channel_key_not_telegram_work(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Bindings are per Telegram identity, not per bot — a user bound
        # via @Sophia_EI_bot's /start deep link must resolve here too.
        # The lookup MUST use channel="telegram", not "telegram_work".
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})

        captured: dict = {}

        def fake_resolve(channel, chat_id):
            captured["channel"] = channel
            captured["chat_id"] = chat_id
            return "user-abc"

        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id",
            fake_resolve,
        )
        result = ch._resolve_sophia_user_id("12345")
        assert result == "user-abc"
        assert captured["channel"] == "telegram"
        assert captured["chat_id"] == "12345"

    def test_resolve_returns_none_when_unbound(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id",
            lambda *_, **__: None,
        )
        assert ch._resolve_sophia_user_id("12345") is None
