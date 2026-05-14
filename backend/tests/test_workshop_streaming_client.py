"""Unit tests for StreamingTextClient (Phase 2 regression coverage)."""

from __future__ import annotations

import pytest

from app.channels.telegram_workshop_streaming import StreamingTextClient


class _FakeBot:
    """Minimal stand-in for PTB's ``Bot`` — records every call."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.edits: list[dict] = []
        self._next_msg_id = 1000

    async def send_message(self, **kwargs):  # type: ignore[no-untyped-def]
        self.sent.append(kwargs)
        mid = self._next_msg_id
        self._next_msg_id += 1

        class _Msg:
            def __init__(self, m):
                self.message_id = m

        return _Msg(mid)

    async def edit_message_text(self, **kwargs):  # type: ignore[no-untyped-def]
        self.edits.append(kwargs)


@pytest.mark.anyio
async def test_open_sends_plain_text_no_parse_mode() -> None:
    """Initial message must not request a Telegram parse mode.

    Phase 2 regression: user / tool-arg content (URLs, paths, queries)
    gets spliced into the streaming body without escaping; any Markdown
    metachar would cause Telegram to reject the edit. The defence is to
    drop parse_mode entirely.
    """
    bot = _FakeBot()
    client = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=0)
    await client.open(initial_body="[ Working ]\n\n🛠 Starting work…")

    assert len(bot.sent) == 1
    payload = bot.sent[0]
    assert payload["chat_id"] == 42
    # The CRITICAL invariant: parse_mode must NOT be set.
    assert "parse_mode" not in payload


@pytest.mark.anyio
async def test_set_body_pushes_edit_with_no_parse_mode() -> None:
    bot = _FakeBot()
    client = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=0)
    await client.open(initial_body="initial")
    bot.sent.clear()

    # Body contains characters that would explode under Markdown parse mode.
    danger_body = "[ Researching ]\n\n🔍 Searching: x_y*z\n🔗 Reading: a.com/b[c]"
    pushed = await client.set_body(danger_body, flush=True)
    assert pushed is True
    assert len(bot.edits) == 1
    edit = bot.edits[0]
    assert edit["chat_id"] == 42
    assert "parse_mode" not in edit
    # The body round-trips verbatim — no escaping, no transformation.
    assert edit["text"] == danger_body


@pytest.mark.anyio
async def test_finalize_pushes_unconditionally_no_parse_mode() -> None:
    bot = _FakeBot()
    client = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=99_999)
    await client.open(initial_body="opening")
    bot.sent.clear()

    # ``set_body`` would be rate-limited (we set a huge interval), but
    # ``finalize`` must flush regardless.
    await client.set_body("[ Drafting ]\n\n📝 Drafting…", flush=False)
    assert bot.edits == []

    await client.finalize("[ Done ]\n\n✓ Done.\n\nSummary text.")
    assert len(bot.edits) == 1
    final = bot.edits[0]
    assert "parse_mode" not in final
    assert "✓ Done." in final["text"]


@pytest.mark.anyio
async def test_consecutive_edit_failures_mark_degraded() -> None:
    """Spec §15.6 fallback: switch to degraded mode after 3 failures."""

    class _FailingBot(_FakeBot):
        def __init__(self) -> None:
            super().__init__()
            self.fail_edits = True

        async def edit_message_text(self, **kwargs):  # type: ignore[no-untyped-def]
            await super().edit_message_text(**kwargs)
            if self.fail_edits:
                raise RuntimeError("simulated Telegram failure")

    bot = _FailingBot()
    client = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=0)
    await client.open(initial_body="o")

    for i in range(3):
        await client.set_body(f"body {i}", flush=True)

    assert client.is_degraded is True
