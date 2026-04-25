"""Integration tests for the Telegram deep-link flow.

Covers:
    * ``_cmd_start`` token parsing → store.pop + store.bind.
    * Channel manager replaces ``msg.user_id`` with the canonical id
      when a binding exists.
    * ``_looks_like_link_token`` regex rejects short / malformed payloads.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.channels.manager import ChannelManager
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus
from app.channels.telegram import TelegramChannel, _looks_like_link_token
from app.gateway import telegram_link_store as store


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    store.clear_all()
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    yield
    store.clear_all()


class TestLinkTokenRegex:
    @pytest.mark.parametrize(
        "token",
        [
            "a" * 16,
            "AbCdEfGh_-012345678",
            "A" * 96,
        ],
    )
    def test_accepts_plausible_tokens(self, token):
        assert _looks_like_link_token(token) is True

    @pytest.mark.parametrize(
        "token",
        [
            "",
            "short",
            "x" * 15,  # below min length
            "x" * 97,  # above max length
            "has space inside",
            "has!invalid@chars",
        ],
    )
    def test_rejects_malformed(self, token):
        assert _looks_like_link_token(token) is False


class TestCmdStartRedemption:
    @pytest.fixture
    def channel(self) -> TelegramChannel:
        bus = MessageBus()
        return TelegramChannel(bus=bus, config={"bot_token": "test-token"})

    def _make_update(
        self,
        *,
        text: str,
        chat_id: int = 42,
        user_id: int = 101,
        username: str = "alice",
        chat_type: str = "private",
    ):
        from unittest.mock import AsyncMock

        message = MagicMock()
        message.reply_text = AsyncMock()
        effective_user = SimpleNamespace(id=user_id, username=username)
        effective_chat = SimpleNamespace(id=chat_id, type=chat_type)
        return SimpleNamespace(
            message=message,
            effective_user=effective_user,
            effective_chat=effective_chat,
        )

    @pytest.mark.anyio
    async def test_redeems_valid_token_and_binds_chat(self, channel):
        rec = store.issue_link_token("user-42")
        update = self._make_update(text=f"/start {rec.token}")
        context = SimpleNamespace(args=[rec.token])

        await channel._cmd_start(update, context)

        # Binding was created with the canonical user_id.
        assert store.resolve_user_id("telegram", "42") == "user-42"
        binding = store.get_binding_for_user("user-42")
        assert binding is not None
        assert binding.telegram_user_id == "101"
        assert binding.telegram_username == "alice"

    @pytest.mark.anyio
    async def test_ignores_unknown_token(self, channel):
        update = self._make_update(text="/start bogusbogusbogusbogusbogusbogus")
        context = SimpleNamespace(args=["bogusbogusbogusbogusbogusbogus"])

        await channel._cmd_start(update, context)

        assert store.resolve_user_id("telegram", "42") is None

    @pytest.mark.anyio
    async def test_plain_start_without_token_does_not_error(self, channel):
        update = self._make_update(text="/start")
        context = SimpleNamespace(args=[])

        # Should not raise and should not bind anything.
        await channel._cmd_start(update, context)
        assert store.resolve_user_id("telegram", "42") is None

    @pytest.mark.anyio
    async def test_token_is_single_use(self, channel):
        rec = store.issue_link_token("user-42")
        update = self._make_update(text=f"/start {rec.token}")
        context = SimpleNamespace(args=[rec.token])

        await channel._cmd_start(update, context)
        # Second redemption fails — binding unchanged.
        update2 = self._make_update(text=f"/start {rec.token}", chat_id=99)
        context2 = SimpleNamespace(args=[rec.token])
        await channel._cmd_start(update2, context2)

        assert store.resolve_user_id("telegram", "42") == "user-42"
        assert store.resolve_user_id("telegram", "99") is None

    @pytest.mark.anyio
    @pytest.mark.parametrize("chat_type", ["group", "supergroup", "channel"])
    async def test_non_private_chat_redemption_is_rejected(self, channel, chat_type):
        """Redemption in non-private chats must NOT consume the token.

        Regression guard for P1-A: in groups/supergroups ``chat_id`` is
        shared by every member, so binding it to one user's canonical
        id would collapse the whole room under that identity.
        """
        rec = store.issue_link_token("user-42")
        update = self._make_update(text=f"/start {rec.token}", chat_type=chat_type)
        context = SimpleNamespace(args=[rec.token])

        await channel._cmd_start(update, context)

        # No binding created.
        assert store.resolve_user_id("telegram", "42") is None
        # Token is still redeemable in a subsequent private-chat flow.
        still = store.pop_link_token(rec.token)
        assert still is not None
        assert still.user_id == "user-42"
        # User got a helpful reply.
        update.message.reply_text.assert_awaited_once()
        reply_text = update.message.reply_text.await_args.args[0]
        assert "1:1" in reply_text or "private" in reply_text.lower()

    @pytest.mark.anyio
    async def test_disallowed_user_is_ignored(self):
        bus = MessageBus()
        channel = TelegramChannel(
            bus=bus,
            config={"bot_token": "t", "allowed_users": [999]},
        )
        rec = store.issue_link_token("user-42")
        update = self._make_update(text=f"/start {rec.token}", user_id=101)
        context = SimpleNamespace(args=[rec.token])

        await channel._cmd_start(update, context)

        # No binding — the handler short-circuited, and crucially the
        # token was NOT consumed (still redeemable by an allowed user).
        assert store.resolve_user_id("telegram", "42") is None
        assert store.pop_link_token(rec.token) is not None


class TestChannelManagerIdentity:
    def test_apply_canonical_replaces_user_id_for_telegram(self):
        from deerflow.agents.sophia_agent.utils import validate_user_id

        canonical_user_id = "user.with-dots+plus@example.com"
        store.bind_chat("telegram", "42", canonical_user_id)
        msg = InboundMessage(
            channel_name="telegram",
            chat_id="42",
            user_id="tg-101",
            text="hi",
            msg_type=InboundMessageType.CHAT,
        )
        ChannelManager._apply_canonical_user_id(msg)
        assert validate_user_id(msg.user_id) == canonical_user_id
        assert msg.metadata["platform_user_id"] == "tg-101"
        assert msg.metadata["canonical_user_id"] == canonical_user_id

    def test_apply_canonical_noop_when_no_binding(self):
        msg = InboundMessage(
            channel_name="telegram",
            chat_id="unbound",
            user_id="tg-999",
            text="hi",
        )
        ChannelManager._apply_canonical_user_id(msg)
        assert msg.user_id == "tg-999"
        assert "platform_user_id" not in msg.metadata

    def test_apply_canonical_noop_for_other_channels(self):
        store.bind_chat("telegram", "42", "canonical")
        msg = InboundMessage(
            channel_name="slack",  # NOT telegram
            chat_id="42",
            user_id="slack-u",
            text="hi",
        )
        ChannelManager._apply_canonical_user_id(msg)
        assert msg.user_id == "slack-u"

    def test_apply_canonical_idempotent_when_already_canonical(self):
        store.bind_chat("telegram", "42", "user-x")
        msg = InboundMessage(
            channel_name="telegram",
            chat_id="42",
            user_id="user-x",
            text="hi",
        )
        ChannelManager._apply_canonical_user_id(msg)
        assert msg.user_id == "user-x"
        # No metadata churn when id already canonical.
        assert "platform_user_id" not in msg.metadata
