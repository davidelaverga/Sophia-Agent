"""Gateway upload-route auth + thread-ownership (Codex P1 PR #132).

The gateway is independently reachable (public ``sophia-gateway`` web
service + nginx proxy), so the upload routes must enforce auth and
thread ownership themselves rather than trusting the Next.js proxy.
``verify_thread_access`` is the router-level dependency that does this.

The upload routes are scoped by ``{thread_id}`` (no ``{user_id}`` path
param), so they can't reuse ``require_authorized_user_scope``. Instead
``verify_thread_access`` resolves the bearer token via the async
``resolve_bearer_user_id`` and checks ownership against the real
``SessionStore`` (``list_open`` / ``list_recent``).

Behaviour:
- auth OFF (default): no-op, returns ``None`` (frontend proxy is the
  gate; existing deployments keep working).
- auth ON: 401 on missing/invalid token (via resolve_bearer_user_id),
  403 when the authenticated user does not own the thread, pass-through
  when they do.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException


def _request_with_bearer(token: str | None) -> SimpleNamespace:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return SimpleNamespace(headers=headers)


@pytest.mark.anyio
async def test_verify_thread_access_noop_when_auth_disabled(monkeypatch) -> None:
    """Auth OFF (default): dependency returns None and never resolves a
    token or consults the ownership store — existing deployments keep
    working with the frontend proxy as the gate."""
    from app.gateway.routers import uploads as up

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: False)

    async def _should_not_resolve(*_a, **_k):
        raise AssertionError("token must not be resolved when auth is off")

    monkeypatch.setattr(up, "resolve_bearer_user_id", _should_not_resolve)

    result = await up.verify_thread_access("thread-1", _request_with_bearer(None))
    assert result is None


@pytest.mark.anyio
async def test_verify_thread_access_allows_owner_when_auth_enabled(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    async def _resolve(_req):
        return "user-A"

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: True)
    monkeypatch.setattr(up, "resolve_bearer_user_id", _resolve)
    monkeypatch.setattr(up, "_user_owns_thread", lambda uid, tid: uid == "user-A" and tid == "thread-A")

    result = await up.verify_thread_access("thread-A", _request_with_bearer("tok"))
    assert result == "user-A"


@pytest.mark.anyio
async def test_verify_thread_access_rejects_non_owner_with_403(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    async def _resolve(_req):
        return "attacker"

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: True)
    monkeypatch.setattr(up, "resolve_bearer_user_id", _resolve)
    monkeypatch.setattr(up, "_user_owns_thread", lambda _uid, _tid: False)

    with pytest.raises(HTTPException) as exc_info:
        await up.verify_thread_access("victim-thread", _request_with_bearer("tok"))
    assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_verify_thread_access_propagates_401_from_token_check(monkeypatch) -> None:
    """When the token resolver raises 401 (missing/invalid token on an
    auth-enabled gateway), the dependency surfaces it unchanged."""
    from app.gateway.routers import uploads as up

    async def _raise_401(_req):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: True)
    monkeypatch.setattr(up, "resolve_bearer_user_id", _raise_401)

    with pytest.raises(HTTPException) as exc_info:
        await up.verify_thread_access("thread-A", _request_with_bearer("bad"))
    assert exc_info.value.status_code == 401


def test_user_owns_thread_matches_only_owned_thread(monkeypatch) -> None:
    """Uses the REAL store API: list_open + list_recent (no list_all_for_user)."""
    from app.gateway.routers import uploads as up

    fake_store = SimpleNamespace(
        list_open=lambda uid: [SimpleNamespace(thread_id="t-open")],
        list_recent=lambda uid, limit=100: [SimpleNamespace(thread_id="t-recent")],
    )
    monkeypatch.setattr(up, "_get_ownership_store", lambda: fake_store)

    assert up._user_owns_thread("user-A", "t-open") is True       # found via list_open
    assert up._user_owns_thread("user-A", "t-recent") is True     # found via list_recent
    assert up._user_owns_thread("user-A", "t-not-mine") is False


def test_user_owns_thread_fails_closed_on_store_error(monkeypatch) -> None:
    """A store/network error must DENY access, never grant it."""
    from app.gateway.routers import uploads as up

    def _boom():
        raise RuntimeError("store down")

    monkeypatch.setattr(up, "_get_ownership_store", _boom)

    assert up._user_owns_thread("user-A", "any-thread") is False


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-v"])
