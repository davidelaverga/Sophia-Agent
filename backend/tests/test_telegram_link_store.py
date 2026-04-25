"""Unit tests for ``app.gateway.telegram_link_store``.

Covers token issuance/redemption, TTL expiry, single-use semantics,
binding CRUD, and Supabase no-op path when not configured.
"""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from app.gateway import telegram_link_store as store


@pytest.fixture(autouse=True)
def _reset():
    store.clear_all()
    yield
    store.clear_all()


class TestBotUsername:
    def test_defaults_to_known_production_bot(self, monkeypatch):
        monkeypatch.delenv("TELEGRAM_BOT_USERNAME", raising=False)
        assert store.get_bot_username() == "Sophia_EI_bot"

    def test_reads_env(self, monkeypatch):
        monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "OtherBot")
        assert store.get_bot_username() == "OtherBot"

    def test_strips_leading_at(self, monkeypatch):
        monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "@CoolBot")
        assert store.get_bot_username() == "CoolBot"


class TestTokenIssuance:
    def test_issue_returns_record_bound_to_user(self):
        rec = store.issue_link_token("user-abc")
        assert rec.user_id == "user-abc"
        assert len(rec.token) >= 40  # urlsafe_b64 of 32 bytes ~ 43 chars
        assert rec.expires_at > time.time()

    def test_issue_rejects_empty_user_id(self):
        with pytest.raises(ValueError):
            store.issue_link_token("")
        with pytest.raises(ValueError):
            store.issue_link_token("   ")

    def test_issue_trims_user_id(self):
        rec = store.issue_link_token("  user-x  ")
        assert rec.user_id == "user-x"

    def test_issue_accepts_auth_provider_user_id_shapes(self):
        rec = store.issue_link_token("user.with-dots+plus@example.com")
        assert rec.user_id == "user.with-dots+plus@example.com"

    def test_issue_produces_distinct_tokens(self):
        r1 = store.issue_link_token("user-a")
        r2 = store.issue_link_token("user-a")
        assert r1.token != r2.token


class TestRedemption:
    def test_pop_returns_and_consumes(self):
        rec = store.issue_link_token("user-1")
        got = store.pop_link_token(rec.token)
        assert got is not None
        assert got.user_id == "user-1"
        # Second pop fails — single-use.
        assert store.pop_link_token(rec.token) is None

    def test_pop_unknown_token_returns_none(self):
        assert store.pop_link_token("nope") is None

    def test_pop_empty_token_returns_none(self):
        assert store.pop_link_token("") is None

    def test_expired_token_is_not_redeemable(self):
        rec = store.issue_link_token("user-2", ttl_seconds=0)
        time.sleep(0.01)
        assert store.pop_link_token(rec.token) is None


class TestBindings:
    def test_bind_and_resolve(self):
        store.bind_chat("telegram", "chat-1", "user-1", telegram_username="alice")
        assert store.resolve_user_id("telegram", "chat-1") == "user-1"

    def test_bind_accepts_auth_provider_user_id_shapes(self):
        store.bind_chat("telegram", "chat-1", "auth0:abc|def", telegram_username="alice")
        assert store.resolve_user_id("telegram", "chat-1") == "auth0:abc|def"

    def test_resolve_unknown_chat_returns_none(self):
        assert store.resolve_user_id("telegram", "missing") is None

    def test_resolve_empty_chat_returns_none(self):
        assert store.resolve_user_id("telegram", "") is None

    def test_bind_overwrites_previous_user(self):
        store.bind_chat("telegram", "c", "user-a")
        store.bind_chat("telegram", "c", "user-b")
        assert store.resolve_user_id("telegram", "c") == "user-b"
        assert store.get_binding_for_user("user-a") is None
        assert store.get_binding_for_user("user-b") is not None

    def test_get_binding_for_user_returns_first_match(self):
        store.bind_chat("telegram", "chat-x", "user-1", telegram_username="bob")
        binding = store.get_binding_for_user("user-1")
        assert binding is not None
        assert binding.chat_id == "chat-x"
        assert binding.telegram_username == "bob"

    def test_unbind_user_removes_binding(self):
        store.bind_chat("telegram", "c-1", "user-1")
        store.bind_chat("telegram", "c-2", "user-1")
        removed = store.unbind_user("user-1")
        assert removed == 2
        assert store.resolve_user_id("telegram", "c-1") is None
        assert store.resolve_user_id("telegram", "c-2") is None

    def test_unbind_user_empty_user_id_returns_zero(self):
        assert store.unbind_user("") == 0

    def test_unbind_chat_returns_true_when_removed(self):
        store.bind_chat("telegram", "c-3", "user-3")
        assert store.unbind_chat("telegram", "c-3") is True
        assert store.unbind_chat("telegram", "c-3") is False

    def test_bind_rejects_empty_inputs(self):
        with pytest.raises(ValueError):
            store.bind_chat("telegram", "", "user-x")
        with pytest.raises(ValueError):
            store.bind_chat("telegram", "chat", "")

    def test_bind_rejects_invalid_user_id(self):
        with pytest.raises(ValueError):
            store.bind_chat("telegram", "chat", "user..bad")


class TestSupabasePersistence:
    def test_upsert_no_op_when_supabase_not_configured(self, monkeypatch):
        monkeypatch.delenv("SUPABASE_URL", raising=False)
        monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
        monkeypatch.delenv("SUPABASE_KEY", raising=False)
        # Should not raise even with no config.
        store.bind_chat("telegram", "c", "user-1")

    def test_upsert_posts_when_supabase_configured(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")

        captured: dict = {}

        class FakeClient:
            def __init__(self, *a, **kw):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def post(self, url, headers=None, json=None):
                captured["url"] = url
                captured["json"] = json

                class Response:
                    status_code = 201
                    text = ""

                return Response()

            def delete(self, url, headers=None):
                class Response:
                    status_code = 204

                return Response()

        with patch("app.gateway.telegram_link_store.httpx.Client", FakeClient):
            store.bind_chat("telegram", "c", "user-1", telegram_username="alice")

        assert captured["url"].endswith("/rest/v1/telegram_user_bindings")
        assert captured["json"][0]["user_id"] == "user-1"
        assert captured["json"][0]["telegram_username"] == "alice"

    def test_upsert_swallows_http_errors(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")

        import httpx

        class FakeClient:
            def __init__(self, *a, **kw):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def post(self, *a, **kw):
                raise httpx.ConnectError("boom")

            def delete(self, *a, **kw):
                raise httpx.ConnectError("boom")

        with patch("app.gateway.telegram_link_store.httpx.Client", FakeClient):
            # Must not raise.
            store.bind_chat("telegram", "c", "user-1")


class TestSupabaseRehydration:
    """Regression coverage for P1-B: bindings must survive gateway restarts."""

    def _fake_client_returning(self, pages: list[list[dict] | Exception]):
        """Build a FakeClient that returns one ``pages`` entry per ``get`` call."""

        calls: list[str] = []

        class Response:
            def __init__(self, status_code: int, payload: list[dict] | str):
                self.status_code = status_code
                self._payload = payload
                self.text = "" if isinstance(payload, list) else payload

            def json(self):
                if isinstance(self._payload, str):
                    raise ValueError("invalid json")
                return self._payload

        class FakeClient:
            def __init__(self, *a, **kw):
                self._pages = iter(pages)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get(self, url, headers=None):
                calls.append(url)
                try:
                    page = next(self._pages)
                except StopIteration:
                    return Response(200, [])
                if isinstance(page, Exception):
                    raise page
                if isinstance(page, tuple):
                    status, body = page
                    return Response(status, body)
                return Response(200, page)

        return FakeClient, calls

    def test_no_op_when_supabase_not_configured(self, monkeypatch):
        monkeypatch.delenv("SUPABASE_URL", raising=False)
        monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
        monkeypatch.delenv("SUPABASE_KEY", raising=False)
        assert store.load_bindings_from_supabase() == 0

    def test_loads_rows_into_in_memory_maps(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")
        rows = [
            {
                "channel": "telegram",
                "chat_id": "100",
                "user_id": "user-1",
                "telegram_user_id": "tg-1",
                "telegram_username": "alice",
                "created_at": 1000.0,
            },
            {
                "channel": "telegram",
                "chat_id": "200",
                "user_id": "user-2",
                "telegram_user_id": "tg-2",
                "telegram_username": "bob",
                "created_at": 2000.0,
            },
        ]
        fake, _ = self._fake_client_returning([rows])
        with patch("app.gateway.telegram_link_store.httpx.Client", fake):
            loaded = store.load_bindings_from_supabase()

        assert loaded == 2
        assert store.resolve_user_id("telegram", "100") == "user-1"
        assert store.resolve_user_id("telegram", "200") == "user-2"
        binding_for_user_1 = store.get_binding_for_user("user-1")
        assert binding_for_user_1 is not None
        assert binding_for_user_1.telegram_username == "alice"

    def test_skips_malformed_rows(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")
        rows = [
            {"channel": "telegram", "chat_id": "good", "user_id": "user-good"},
            {"channel": "telegram", "chat_id": "", "user_id": "user-empty"},
            {"channel": "slack", "chat_id": "s", "user_id": "u"},  # wrong channel
            {"chat_id": "x", "user_id": "y"},  # missing channel
            "not-a-dict",
            {"channel": "telegram", "chat_id": "also_good", "user_id": "user-ok"},
        ]
        fake, _ = self._fake_client_returning([rows])
        with patch("app.gateway.telegram_link_store.httpx.Client", fake):
            loaded = store.load_bindings_from_supabase()

        assert loaded == 2
        assert store.resolve_user_id("telegram", "good") == "user-good"
        assert store.resolve_user_id("telegram", "also_good") == "user-ok"

    def test_survives_5xx(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")
        fake, _ = self._fake_client_returning([(503, "Service Unavailable")])
        with patch("app.gateway.telegram_link_store.httpx.Client", fake):
            loaded = store.load_bindings_from_supabase()
        assert loaded == 0

    def test_survives_connection_error(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")
        import httpx

        fake, _ = self._fake_client_returning([httpx.ConnectError("network down")])
        with patch("app.gateway.telegram_link_store.httpx.Client", fake):
            loaded = store.load_bindings_from_supabase()
        assert loaded == 0

    def test_survives_invalid_json(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")
        fake, _ = self._fake_client_returning([(200, "this is not json")])
        with patch("app.gateway.telegram_link_store.httpx.Client", fake):
            loaded = store.load_bindings_from_supabase()
        assert loaded == 0

    def test_pagination_terminates_when_batch_is_short(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")
        # One short page -> loop must exit after the first GET.
        page = [
            {"channel": "telegram", "chat_id": "c1", "user_id": "u1"},
            {"channel": "telegram", "chat_id": "c2", "user_id": "u2"},
        ]
        fake, calls = self._fake_client_returning([page])
        with patch("app.gateway.telegram_link_store.httpx.Client", fake):
            loaded = store.load_bindings_from_supabase()
        assert loaded == 2
        assert len(calls) == 1, f"Expected single GET, got {calls}"
