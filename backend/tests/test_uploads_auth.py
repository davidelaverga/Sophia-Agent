"""Gateway upload-route auth + thread-ownership (Codex P1 PR #132).

The gateway is independently reachable (public ``sophia-gateway`` web
service + nginx proxy), so the upload routes enforce auth and thread
ownership themselves rather than trusting the Next.js proxy.
``verify_thread_access`` is the router-level dependency that does this.

Enforcement is UNCONDITIONAL — same posture as the voice / telegram_link
routers (the earlier feature-flag approach left the routes open in any
deployment that didn't set the flag, which render.yaml never did). The
upload routes are scoped by ``{thread_id}`` (no ``{user_id}`` path param),
so ``verify_thread_access`` resolves the bearer token via the async
``resolve_bearer_user_id`` and checks ownership against the real
``SessionStore`` (``list_open`` / ``list_recent``).

Behaviour:
- normal (prod): 401 on missing/invalid token; 403 when the authenticated
  user does not own the thread; pass-through when they do.
- dev bypass (``SOPHIA_AUTH_BYPASS=true``): resolver returns the dev user
  and ownership is skipped — local dev / tests only.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException


def _request_with_bearer(token: str | None) -> SimpleNamespace:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return SimpleNamespace(headers=headers)


@pytest.mark.anyio
async def test_verify_thread_access_allows_owner(monkeypatch) -> None:
    """Authenticated user who owns the thread is allowed through."""
    from app.gateway.routers import uploads as up

    async def _resolve(_req):
        return "user-A"

    monkeypatch.setattr(up, "is_auth_bypass_enabled", lambda: False)
    monkeypatch.setattr(up, "resolve_bearer_user_id", _resolve)
    monkeypatch.setattr(up, "_user_owns_thread", lambda uid, tid: uid == "user-A" and tid == "thread-A")

    result = await up.verify_thread_access("thread-A", _request_with_bearer("tok"))
    assert result == "user-A"


@pytest.mark.anyio
async def test_verify_thread_access_rejects_non_owner_with_403(monkeypatch) -> None:
    """Authenticated user who does NOT own the thread is rejected — this is
    the core fix: a caller who knows a foreign thread id can't touch it."""
    from app.gateway.routers import uploads as up

    async def _resolve(_req):
        return "attacker"

    monkeypatch.setattr(up, "is_auth_bypass_enabled", lambda: False)
    monkeypatch.setattr(up, "resolve_bearer_user_id", _resolve)
    monkeypatch.setattr(up, "_user_owns_thread", lambda _uid, _tid: False)

    with pytest.raises(HTTPException) as exc_info:
        await up.verify_thread_access("victim-thread", _request_with_bearer("tok"))
    assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_verify_thread_access_propagates_401_from_token_check(monkeypatch) -> None:
    """A missing/invalid token (resolver raises 401) is surfaced unchanged —
    unauthenticated direct gateway access is rejected, not allowed."""
    from app.gateway.routers import uploads as up

    async def _raise_401(_req):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    monkeypatch.setattr(up, "is_auth_bypass_enabled", lambda: False)
    monkeypatch.setattr(up, "resolve_bearer_user_id", _raise_401)

    with pytest.raises(HTTPException) as exc_info:
        await up.verify_thread_access("thread-A", _request_with_bearer(None))
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_verify_thread_access_bypass_skips_ownership(monkeypatch) -> None:
    """Dev bypass: resolver returns the dev user and ownership is skipped
    (so local dev / tests work without the auth bridge or real sessions).
    Ownership must NOT be consulted in this mode."""
    from app.gateway.routers import uploads as up

    async def _resolve(_req):
        return "local-dev-user"

    monkeypatch.setattr(up, "is_auth_bypass_enabled", lambda: True)
    monkeypatch.setattr(up, "resolve_bearer_user_id", _resolve)
    monkeypatch.setattr(
        up, "_user_owns_thread",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("ownership must not be checked in bypass mode")),
    )

    result = await up.verify_thread_access("any-thread", _request_with_bearer(None))
    assert result == "local-dev-user"


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
