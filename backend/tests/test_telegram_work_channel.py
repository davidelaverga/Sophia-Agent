"""Tests for TelegramWorkChannel — Builder-as-Main DM surface.

Covers Stage-1 Phase-3 behaviour: construction, feature-flag gating,
pilot-user gate, identity binding lookup, summary/artifact extraction,
group-chat rejection, and the runs.wait dispatch payload shape. The
end-to-end runs.wait dispatch is covered by mocking the LangGraph SDK
client; we don't spin up a real Telegram Application here (that would
require network + valid token).
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

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
    """3-step resolver: forward fast path → reverse lookup → auto-bind.

    Production-critical: the resolver is the entry point for every
    EI-bound user who DMs @Sophia_Work_bot for the first time. Telegram
    assigns different chat_ids per bot DM, so the same human gets a
    different chat_id when they DM Work vs EI; only the reverse lookup
    by Telegram user_id can bridge the two.
    """

    def test_step1_forward_lookup_hits_when_work_dm_already_bound(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Fast path: Work-DM was previously auto-bound — forward lookup hits."""
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})

        forward_calls: list = []
        reverse_calls: list = []
        bind_calls: list = []

        def fake_forward(channel, chat_id):
            forward_calls.append((channel, chat_id))
            return "user-abc"  # hit

        def fake_reverse(*args, **kwargs):
            reverse_calls.append((args, kwargs))
            return None

        def fake_bind(*args, **kwargs):
            bind_calls.append((args, kwargs))
            return None

        monkeypatch.setattr("app.gateway.telegram_link_store.resolve_user_id", fake_forward)
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id_by_telegram_user_id",
            fake_reverse,
        )
        monkeypatch.setattr("app.gateway.telegram_link_store.bind_chat", fake_bind)

        result = ch._resolve_sophia_user_id(
            chat_id="work-12345",
            telegram_user_id="42",
            telegram_username="davide",
        )

        assert result == "user-abc"
        # Forward lookup with channel="telegram" (not "telegram_work")
        assert forward_calls == [("telegram", "work-12345")]
        # Step 2 + 3 must NOT run when step 1 hits (no wasted reverse-lookup or auto-bind)
        assert reverse_calls == []
        assert bind_calls == []

    def test_step2_reverse_lookup_hits_for_ei_bound_user_first_work_dm(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """EI-bound user DMs Work bot first time → reverse lookup hits, auto-bind fires."""
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})

        bind_calls: list = []

        # Forward miss (no prior Work-DM binding)
        monkeypatch.setattr("app.gateway.telegram_link_store.resolve_user_id", lambda *_, **__: None)
        # Reverse hit (EI's deep-link populated _bindings_by_telegram_user_id earlier)
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id_by_telegram_user_id",
            lambda tg_user_id, **kw: "user-abc" if tg_user_id == "42" else None,
        )

        def fake_bind(channel, chat_id, user_id, *, telegram_user_id, telegram_username):
            bind_calls.append({
                "channel": channel,
                "chat_id": chat_id,
                "user_id": user_id,
                "telegram_user_id": telegram_user_id,
                "telegram_username": telegram_username,
            })

        monkeypatch.setattr("app.gateway.telegram_link_store.bind_chat", fake_bind)

        result = ch._resolve_sophia_user_id(
            chat_id="work-12345",
            telegram_user_id="42",
            telegram_username="davide",
        )

        assert result == "user-abc"
        # Auto-bind fired with all the right fields — Work-DM chat is now
        # in the forward index AND the reverse index gains a second
        # binding entry pointing at the same canonical user.
        assert len(bind_calls) == 1
        bind_call = bind_calls[0]
        assert bind_call["channel"] == "telegram"
        assert bind_call["chat_id"] == "work-12345"
        assert bind_call["user_id"] == "user-abc"
        assert bind_call["telegram_user_id"] == "42"
        assert bind_call["telegram_username"] == "davide"

    def test_step2_reverse_lookup_misses_for_brand_new_user(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """User never bound through ANY Telegram bot → returns None (caller sends unbound prompt)."""
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})

        bind_calls: list = []

        monkeypatch.setattr("app.gateway.telegram_link_store.resolve_user_id", lambda *_, **__: None)
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id_by_telegram_user_id",
            lambda *_, **__: None,
        )
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.bind_chat",
            lambda *args, **kwargs: bind_calls.append((args, kwargs)),
        )

        result = ch._resolve_sophia_user_id(
            chat_id="work-12345",
            telegram_user_id="999",
            telegram_username=None,
        )
        assert result is None
        # Auto-bind MUST NOT fire when reverse lookup misses (no canonical
        # user_id to bind to).
        assert bind_calls == []

    def test_step3_auto_bind_failure_does_not_block_request(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Auto-bind error (e.g., Supabase outage) is swallowed — caller still gets the resolved user_id."""
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})

        monkeypatch.setattr("app.gateway.telegram_link_store.resolve_user_id", lambda *_, **__: None)
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id_by_telegram_user_id",
            lambda *_, **__: "user-abc",
        )

        def boom(*_, **__):
            raise RuntimeError("Supabase down")

        monkeypatch.setattr("app.gateway.telegram_link_store.bind_chat", boom)

        with caplog.at_level(logging.WARNING, logger="app.channels.telegram_work"):
            result = ch._resolve_sophia_user_id(
                chat_id="work-12345",
                telegram_user_id="42",
                telegram_username="davide",
            )

        # Build still proceeds with the resolved canonical user_id.
        assert result == "user-abc"
        # Failure logged at WARNING for ops visibility.
        warning_messages = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
        assert any("auto-bind failed" in m for m in warning_messages), warning_messages

    def test_username_passthrough_when_present(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """telegram_username threads through to bind_chat verbatim when set."""
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})
        captured: dict = {}

        monkeypatch.setattr("app.gateway.telegram_link_store.resolve_user_id", lambda *_, **__: None)
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id_by_telegram_user_id",
            lambda *_, **__: "user-abc",
        )

        def fake_bind(channel, chat_id, user_id, *, telegram_user_id, telegram_username):
            captured["telegram_username"] = telegram_username

        monkeypatch.setattr("app.gateway.telegram_link_store.bind_chat", fake_bind)

        ch._resolve_sophia_user_id(
            chat_id="work-12345",
            telegram_user_id="42",
            telegram_username="davide",
        )
        assert captured["telegram_username"] == "davide"

    def test_username_can_be_none(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Telegram users without a username — telegram_username=None is valid."""
        ch = TelegramWorkChannel(bus, {"bot_token": "tok"})
        captured: dict = {}

        monkeypatch.setattr("app.gateway.telegram_link_store.resolve_user_id", lambda *_, **__: None)
        monkeypatch.setattr(
            "app.gateway.telegram_link_store.resolve_user_id_by_telegram_user_id",
            lambda *_, **__: "user-abc",
        )

        def fake_bind(channel, chat_id, user_id, *, telegram_user_id, telegram_username):
            captured["telegram_username"] = telegram_username

        monkeypatch.setattr("app.gateway.telegram_link_store.bind_chat", fake_bind)

        result = ch._resolve_sophia_user_id(
            chat_id="work-12345",
            telegram_user_id="42",
            telegram_username=None,
        )
        assert result == "user-abc"
        assert captured["telegram_username"] is None


class TestDispatchPayloadShape:
    """Regression guard for the langgraph-api 0.7+ runs.wait validation.

    langgraph-api rejects (with HTTP 400, in 1ms, before the run starts)
    any request that sets BOTH ``config["configurable"]`` AND ``context``
    with overlapping keys. The contract — documented in ``manager.py``
    lines 633–645 — is: put thread_id / user_id / channel in ``context``
    ONLY. langgraph-api copies context → configurable server-side so the
    builder factory still reads ``cfg["configurable"]["user_id"]``.

    An earlier version of TelegramWorkChannel._dispatch_build set both,
    causing 100% failure on the first real DM (``runs.wait`` returned
    400 instantly). This test exercises the dispatch path with a stubbed
    LangGraph SDK client and asserts the kwargs shape.
    """

    @pytest.mark.anyio
    async def test_runs_wait_does_not_set_configurable_on_config(
        self, bus: MessageBus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ch = TelegramWorkChannel(
            bus,
            {
                "enabled": True,
                "bot_token": "tok",
                "bot_username": "Sophia_Work_bot",
            },
        )

        # Stub the resolver so it returns a known canonical user_id without
        # going through telegram_link_store.
        monkeypatch.setattr(
            ch,
            "_resolve_sophia_user_id",
            lambda **_kwargs: "user-davide",
        )

        # Stub the in-memory store: existing thread, no creation needed.
        store = MagicMock()
        store.get_thread_id = MagicMock(return_value="thread-existing")
        ch._store = store

        # Stub the LangGraph SDK client. runs.wait captures kwargs we want
        # to assert; threads.create is unused on this branch (existing
        # thread).
        runs = SimpleNamespace(wait=AsyncMock(return_value={"messages": []}))
        threads = SimpleNamespace(create=AsyncMock())
        ch._lg_client = SimpleNamespace(runs=runs, threads=threads)

        # Stub the bot just enough for placeholder + edit + reply.
        bot = SimpleNamespace()
        bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=999))
        bot.edit_message_text = AsyncMock()
        bot.send_document = AsyncMock()
        ch._application = SimpleNamespace(bot=bot)

        await ch._dispatch_build(
            chat_id="6075088249",
            telegram_user_id="42",
            user_text="research the best EVs in Europe for families",
            reply_to_message_id=12345,
            telegram_username="davide",
        )

        # The fix asserts both behaviours that broke production:
        runs.wait.assert_awaited_once()
        call = runs.wait.await_args

        # Positional args: (thread_id, assistant_id)
        assert call.args == ("thread-existing", "sophia_builder"), (
            f"Expected positional ('thread-existing', 'sophia_builder'), got {call.args}"
        )

        kwargs = call.kwargs
        assert "config" in kwargs and "context" in kwargs, (
            f"Expected both config + context kwargs; got {sorted(kwargs)}"
        )

        # *** The bug *** — must NOT have configurable in config:
        assert "configurable" not in kwargs["config"], (
            "REGRESSION: telegram_work passed config={'configurable': ...} which "
            "langgraph-api 0.7+ rejects with HTTP 400. See manager.py:633–645 "
            "and the comment in telegram_work.py._dispatch_build for why "
            "thread_id/user_id/channel must live in `context` ONLY."
        )
        assert kwargs["config"] == {"recursion_limit": 100}

        # context is the single source of truth for thread_id/user_id/channel:
        assert kwargs["context"]["thread_id"] == "thread-existing"
        assert kwargs["context"]["user_id"] == "user-davide"
        assert kwargs["context"]["channel"] == "telegram_work"

        # input shape unchanged:
        assert kwargs["input"] == {
            "messages": [
                {
                    "role": "user",
                    "content": "research the best EVs in Europe for families",
                }
            ]
        }
