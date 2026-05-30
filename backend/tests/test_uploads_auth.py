"""Gateway upload-route auth + thread-ownership (Codex P1 PR #132).

The gateway is independently reachable (public ``sophia-gateway`` web
service + nginx proxy), so the upload routes must enforce auth and
thread ownership themselves rather than trusting the Next.js proxy.
``verify_thread_access`` is the router-level dependency that does this.

Behaviour:
- auth OFF (default): no-op, returns the dev user (frontend proxy is the
  gate; existing deployments keep working).
- auth ON: 401 on missing/invalid token (via require_authorized_user_scope),
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


def test_verify_thread_access_noop_when_auth_disabled(monkeypatch) -> None:
    """Auth OFF (default): dependency returns the dev user and never
    consults the ownership store — existing deployments keep working."""
    from app.gateway.routers import uploads as up

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: False)

    def _should_not_run(*_a, **_k):
        raise AssertionError("ownership store must not be consulted when auth is off")

    monkeypatch.setattr(up, "_user_owns_thread", _should_not_run)

    result = up.verify_thread_access("thread-1", _request_with_bearer(None))
    assert isinstance(result, str)  # dev user


def test_verify_thread_access_allows_owner_when_auth_enabled(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: True)
    monkeypatch.setattr(up, "require_authorized_user_scope", lambda _req: "user-A")
    monkeypatch.setattr(up, "_user_owns_thread", lambda uid, tid: uid == "user-A" and tid == "thread-A")

    result = up.verify_thread_access("thread-A", _request_with_bearer("tok"))
    assert result == "user-A"


def test_verify_thread_access_rejects_non_owner_with_403(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: True)
    monkeypatch.setattr(up, "require_authorized_user_scope", lambda _req: "attacker")
    monkeypatch.setattr(up, "_user_owns_thread", lambda _uid, _tid: False)

    with pytest.raises(HTTPException) as exc_info:
        up.verify_thread_access("victim-thread", _request_with_bearer("tok"))
    assert exc_info.value.status_code == 403


def test_verify_thread_access_propagates_401_from_token_check(monkeypatch) -> None:
    """When the underlying token check raises 401, the dependency surfaces
    it unchanged (missing/invalid token on an auth-enabled gateway)."""
    from app.gateway.routers import uploads as up

    monkeypatch.setattr(up, "is_gateway_auth_enabled", lambda: True)

    def _raise_401(_req):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    monkeypatch.setattr(up, "require_authorized_user_scope", _raise_401)

    with pytest.raises(HTTPException) as exc_info:
        up.verify_thread_access("thread-A", _request_with_bearer("bad"))
    assert exc_info.value.status_code == 401


def test_user_owns_thread_matches_only_owned_thread(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    fake_store = SimpleNamespace(
        list_all_for_user=lambda uid: [
            SimpleNamespace(thread_id="t-owned"),
            SimpleNamespace(thread_id="t-other"),
        ]
    )
    monkeypatch.setattr(up, "_get_ownership_store", lambda: fake_store)

    assert up._user_owns_thread("user-A", "t-owned") is True
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
