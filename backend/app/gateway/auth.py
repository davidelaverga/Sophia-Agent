"""User-scoped authorization helpers for gateway routes."""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import HTTPException, Request
from starlette.routing import compile_path

from deerflow.agents.sophia_agent.utils import validate_user_id

logger = logging.getLogger(__name__)

AUTH_ME_TIMEOUT_SECONDS = 5.0

# The dedicated Voice Lab principal is a deny-by-default product identity.  It
# may reach only routes whose owning handlers enforce the short-lived signed
# capability and exact synthetic session/thread/run binding.  The value is the
# operation that the common authentication boundary verifies before the
# handler runs.  Keeping this map beside the common authentication boundary
# makes a newly mounted ordinary/provider-bearing route fail closed without
# depending on every router author remembering a synthetic check.
_VOICE_LAB_GOVERNED_ROUTE_OPERATIONS = {
    # Canonical production Gemini lane.  Legacy voice, warmup, OpenAI and
    # dogfood/debug routes are intentionally absent.
    ("POST", "/api/sophia/{user_id}/voice/connect"): "voice:start",
    ("POST", "/api/sophia/{user_id}/voice/gemini/relay"): "session:create",
    ("POST", "/api/sophia/{user_id}/voice/gemini/activate"): "session:create",
    ("POST", "/api/sophia/{user_id}/voice/gemini/continuation-bootstrap"): "session:create",
    ("GET", "/api/sophia/{user_id}/voice/gemini/events"): "session:finalize",
    ("POST", "/api/sophia/{user_id}/voice/gemini/disconnect"): "session:finalize",
    # Canonical product finalization and Builder evidence/control lanes.
    ("POST", "/api/sophia/{user_id}/end-session"): "session:finalize",
    ("GET", "/api/sophia/{user_id}/threads/{parent_thread_id}/builder-canvas/snapshot"): "session:read",
    ("GET", "/api/sophia/{user_id}/threads/{parent_thread_id}/builder-canvas/events"): "session:read",
    (
        "POST",
        "/api/sophia/{user_id}/threads/{parent_thread_id}/builder-canvas/tasks/{task_id}/runs/{run_id}/cancel",
    ): "session:finalize",
    (
        "POST",
        "/api/sophia/{user_id}/threads/{parent_thread_id}/builder-canvas/tasks/{task_id}/cancel",
    ): "session:finalize",
    # Canonical session/transcript plane.  Every handler independently
    # verifies the operation and exact Voice Lab session binding.
    ("POST", "/api/v1/sessions/start"): "session:create",
    ("GET", "/api/v1/sessions/active"): "session:read",
    ("GET", "/api/v1/sessions/open"): "session:read",
    ("GET", "/api/v1/sessions/list"): "session:read",
    ("GET", "/api/v1/sessions/{session_id}"): "session:read",
    ("PATCH", "/api/v1/sessions/{session_id}"): "session:create",
    ("DELETE", "/api/v1/sessions/bulk"): "session:create",
    ("DELETE", "/api/v1/sessions/{session_id}"): "session:create",
    ("POST", "/api/v1/sessions/end"): "session:finalize",
    ("GET", "/api/v1/sessions/{session_id}/messages"): "session:read",
    ("PUT", "/api/v1/sessions/{session_id}/messages"): "session:create",
    ("POST", "/api/v1/sessions/{session_id}/messages"): "session:create",
    ("POST", "/api/v1/sessions/{session_id}/touch"): "session:create",
    # Read-only synthetic Builder artifact/UI evidence.  Quick edit and
    # user artifact registry mutation routes are intentionally absent.
    ("GET", "/api/threads/{thread_id}/artifacts"): "session:read",
    ("GET", "/api/threads/{thread_id}/artifacts/{path:path}"): "session:read",
    ("GET", "/api/threads/{thread_id}/builder-events"): "session:read",
    ("GET", "/api/threads/{thread_id}/builder-events/last"): "session:read",
}

_VOICE_LAB_GOVERNED_ROUTE_KEYS = frozenset(_VOICE_LAB_GOVERNED_ROUTE_OPERATIONS)
_VOICE_LAB_PROVIDER_CLEANUP_ROUTE_KEY = (
    "POST",
    "/api/sophia/{user_id}/voice/gemini/disconnect",
)


def voice_lab_governed_route_keys() -> frozenset[tuple[str, str]]:
    """Expose the immutable route inventory to mount-policy tests."""

    return _VOICE_LAB_GOVERNED_ROUTE_KEYS


def voice_lab_governed_route_operations() -> dict[tuple[str, str], str]:
    """Expose a copy of the exact pre-handler operation contract to tests."""

    return dict(_VOICE_LAB_GOVERNED_ROUTE_OPERATIONS)


def _configured_voice_lab_principal() -> str:
    return (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip()


def _request_route_key(request: Request) -> tuple[str, str]:
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    if not isinstance(route_path, str) or not route_path:
        # A missing route template must never broaden the protected allowlist.
        route_path = "<unresolved>"
    return request.method.upper(), route_path


def _concrete_voice_lab_route_key(
    request: Request,
    user_id: str,
) -> tuple[str, str] | None:
    """Match the immutable templates before FastAPI route resolution.

    HTTP middleware runs before ``scope['route']`` exists.  Starlette's own
    path compiler keeps this pre-routing decision byte-for-byte aligned with
    the mounted templates instead of maintaining a second permissive prefix
    list.
    """

    path = request.url.path
    method = request.method.upper()
    for allowed_method, template in _VOICE_LAB_GOVERNED_ROUTE_KEYS:
        if method != allowed_method:
            continue
        matched = compile_path(template)[0].match(path)
        if matched is None:
            continue
        route_user_id = matched.groupdict().get("user_id")
        if route_user_id is not None and route_user_id != user_id:
            return None
        return allowed_method, template
    return None


def assert_voice_lab_gateway_route_allowed(request: Request, user_id: str) -> None:
    """Categorically fence the dedicated principal from ordinary surfaces."""

    configured_principal = _configured_voice_lab_principal()
    if not configured_principal or user_id != configured_principal:
        return
    route_key = _request_route_key(request)
    matched_route_key = route_key if route_key[1] != "<unresolved>" else _concrete_voice_lab_route_key(request, user_id)
    if matched_route_key not in _VOICE_LAB_GOVERNED_ROUTE_KEYS:
        logger.warning(
            "gateway.auth voice_lab_ordinary_route_denied method=%s route=%s",
            request.method.upper(),
            route_key[1] if route_key[1] != "<unresolved>" else request.url.path,
        )
        raise HTTPException(
            status_code=403,
            detail={"code": "voice_lab_ordinary_product_route_forbidden"},
        )


def _voice_lab_capability_authenticated_user(
    request: Request,
    *,
    requested_user_id: str | None = None,
) -> str | None:
    """Authenticate the governed lane without an ordinary legacy bearer.

    Presence of the capability header is an explicit request for the
    synthetic lane: malformed, wrong-route, wrong-operation, wrong-principal,
    or deployment-drifted capabilities fail closed and never fall through to
    the ordinary 30-day JWT bridge.
    """

    from app.gateway.voice_lab_capability import (
        VOICE_LAB_CAPABILITY_HEADER,
        capability_for_gateway_action,
    )

    if not request.headers.get(VOICE_LAB_CAPABILITY_HEADER):
        return None

    principal_id = _configured_voice_lab_principal()
    if not principal_id:
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_configuration_missing"},
        )
    if requested_user_id is not None and requested_user_id != principal_id:
        raise HTTPException(
            status_code=403,
            detail={"code": "voice_lab_capability_wrong_principal"},
        )

    route_key = _request_route_key(request)
    if route_key[1] == "<unresolved>":
        route_key = _concrete_voice_lab_route_key(request, principal_id) or route_key
    required_operation = _VOICE_LAB_GOVERNED_ROUTE_OPERATIONS.get(route_key)
    if required_operation is None:
        raise HTTPException(
            status_code=403,
            detail={"code": "voice_lab_ordinary_product_route_forbidden"},
        )

    claims = capability_for_gateway_action(
        request,
        principal_id,
        required_operation=required_operation,
    )
    if claims is None:  # pragma: no cover - a configured principal is exact.
        raise HTTPException(
            status_code=401,
            detail={"code": "voice_lab_capability_missing"},
        )
    if required_operation in {"voice:start", "session:create"}:
        from deerflow.sophia.cleanup_fence import (
            CleanupFenceError,
            assert_existing_cleanup_obligation_open,
        )

        try:
            assert_existing_cleanup_obligation_open(
                claims.cleanup_obligation_id,
                claims.provider_expires_at,
            )
        except CleanupFenceError as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_cleanup_obligation_closed"},
            ) from exc
    request.state.authenticated_user_id = claims.principal_id
    request.state.voice_lab_capability_claims = claims
    return claims.principal_id


def _voice_lab_provider_cleanup_authenticated_user(
    request: Request,
    *,
    requested_user_id: str | None = None,
) -> str | None:
    """Authenticate the standalone, settlement-only provider authority."""

    from app.gateway.voice_lab_capability import (
        VOICE_LAB_PROVIDER_CLEANUP_HEADER,
        provider_cleanup_claims_for_gateway,
    )

    if not request.headers.get(VOICE_LAB_PROVIDER_CLEANUP_HEADER):
        return None
    principal_id = _configured_voice_lab_principal()
    if not principal_id:
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_configuration_missing"},
        )
    if requested_user_id is not None and requested_user_id != principal_id:
        raise HTTPException(
            status_code=403,
            detail={"code": "voice_lab_provider_cleanup_wrong_principal"},
        )
    route_key = _request_route_key(request)
    if route_key[1] == "<unresolved>":
        route_key = _concrete_voice_lab_route_key(request, principal_id) or route_key
    if route_key != _VOICE_LAB_PROVIDER_CLEANUP_ROUTE_KEY:
        raise HTTPException(
            status_code=403,
            detail={"code": "voice_lab_provider_cleanup_route_denied"},
        )
    claims = provider_cleanup_claims_for_gateway(request, principal_id)
    if claims is None:  # pragma: no cover - header presence is exact.
        raise HTTPException(
            status_code=401,
            detail={"code": "voice_lab_provider_cleanup_missing"},
        )
    request.state.authenticated_user_id = claims.principal_id
    request.state.voice_lab_provider_cleanup_claims = claims
    return claims.principal_id


def _is_explicit_bypass_enabled() -> bool:
    raw_value = os.getenv("SOPHIA_AUTH_BYPASS")
    return isinstance(raw_value, str) and raw_value.strip().lower() == "true"


def _get_bypass_user_id() -> str:
    return (os.getenv("SOPHIA_USER_ID") or "local-dev-user").strip()


def _validated_auth_user_id(raw_user_id: str, *, invalid_detail: str) -> str:
    try:
        return validate_user_id(raw_user_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=invalid_detail) from exc


def is_auth_bypass_enabled() -> bool:
    """Public accessor for the explicit dev auth-bypass flag.

    True only when ``SOPHIA_AUTH_BYPASS=true`` (local dev / tests). In
    bypass mode, token resolution returns the configured dev user without
    a real token, and thread-scoped routes skip ownership enforcement —
    the same dev escape hatch ``require_authorized_user_scope`` already
    honors for the ``{user_id}``-scoped routers. NEVER set in production.
    """
    return _is_explicit_bypass_enabled()


async def resolve_bearer_user_id(request: Request) -> str:
    """Resolve the authenticated ``user_id`` from the request bearer token.

    For routes NOT scoped by a ``{user_id}`` path param (e.g. the
    thread-scoped upload routes). Honors ``SOPHIA_AUTH_BYPASS`` (returns
    the configured bypass user without a token). Otherwise extracts the
    bearer token and resolves it via the legacy ``/api/v1/auth/me`` bridge.

    Raises ``HTTPException`` 401 (missing/invalid token) or 503 (auth
    bridge unavailable) — same semantics as ``require_authorized_user_scope``,
    minus the path-param scope comparison.
    """
    provider_cleanup_user_id = _voice_lab_provider_cleanup_authenticated_user(request)
    if provider_cleanup_user_id is not None:
        return provider_cleanup_user_id
    capability_user_id = _voice_lab_capability_authenticated_user(request)
    if capability_user_id is not None:
        return capability_user_id

    cached_user_id = getattr(request.state, "authenticated_user_id", None)
    if isinstance(cached_user_id, str) and cached_user_id:
        assert_voice_lab_gateway_route_allowed(request, cached_user_id)
        return cached_user_id
    if _is_explicit_bypass_enabled():
        user_id = _get_bypass_user_id()
    else:
        token = _extract_bearer_token(request)
        authenticated_user = await _get_authenticated_user(token)
        user_id = authenticated_user["id"].strip()
    request.state.authenticated_user_id = user_id
    assert_voice_lab_gateway_route_allowed(request, user_id)
    return user_id


def _get_legacy_auth_base_url() -> str:
    return (os.getenv("SOPHIA_AUTH_BACKEND_URL") or os.getenv("BACKEND_API_URL") or os.getenv("VOICE_SERVER_URL") or "http://localhost:8000").strip().rstrip("/")


def _extract_bearer_token(request: Request) -> str:
    auth_header = request.headers.get("authorization", "")
    scheme, _, token = auth_header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return token.strip()


async def _get_authenticated_user(token: str) -> dict:
    auth_url = f"{_get_legacy_auth_base_url()}/api/v1/auth/me"

    try:
        async with httpx.AsyncClient(timeout=AUTH_ME_TIMEOUT_SECONDS) as client:
            response = await client.get(
                auth_url,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.TimeoutException as exc:
        logger.warning("gateway.auth auth_me_timeout url=%s", auth_url)
        raise HTTPException(status_code=503, detail="Auth service timed out") from exc
    except httpx.RequestError as exc:
        logger.warning("gateway.auth auth_me_unavailable url=%s error=%s", auth_url, exc)
        raise HTTPException(status_code=503, detail="Auth service unavailable") from exc

    _raise_for_auth_me_status(response, auth_url)
    payload = _auth_me_payload(response, auth_url)
    _validate_auth_me_payload(payload, auth_url)
    return payload


def _raise_for_auth_me_status(response: httpx.Response, auth_url: str) -> None:
    if response.status_code in {401, 403}:
        raise HTTPException(status_code=401, detail="Invalid or expired auth token")
    if response.status_code == 404:
        logger.warning("gateway.auth auth_me_missing url=%s", auth_url)
        raise HTTPException(status_code=503, detail="Legacy auth bridge unavailable")
    if response.status_code >= 500:
        logger.warning(
            "gateway.auth auth_me_server_error url=%s status=%s",
            auth_url,
            response.status_code,
        )
        raise HTTPException(status_code=503, detail="Auth service unavailable")

    if response.status_code >= 400:
        raise HTTPException(status_code=401, detail="Auth token rejected")


def _auth_me_payload(response: httpx.Response, auth_url: str) -> Any:
    try:
        return response.json()
    except ValueError as exc:
        logger.warning("gateway.auth auth_me_invalid_json url=%s", auth_url)
        raise HTTPException(status_code=503, detail="Auth service returned invalid JSON") from exc


def _validate_auth_me_payload(payload: Any, auth_url: str) -> None:
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not payload["id"].strip():
        logger.warning("gateway.auth auth_me_missing_id url=%s payload_type=%s", auth_url, type(payload).__name__)
        raise HTTPException(status_code=503, detail="Auth service returned an invalid user payload")


async def require_authorized_user_scope(request: Request) -> str:
    raw_user_id = request.path_params.get("user_id")
    if not isinstance(raw_user_id, str):
        raise HTTPException(status_code=500, detail="Route is missing user scope")

    try:
        user_id = validate_user_id(raw_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid user_id format") from exc

    provider_cleanup_user_id = _voice_lab_provider_cleanup_authenticated_user(
        request,
        requested_user_id=user_id,
    )
    if provider_cleanup_user_id is not None:
        return provider_cleanup_user_id
    capability_user_id = _voice_lab_capability_authenticated_user(
        request,
        requested_user_id=user_id,
    )
    if capability_user_id is not None:
        return capability_user_id
    if user_id == _configured_voice_lab_principal():
        assert_voice_lab_gateway_route_allowed(request, user_id)
        raise HTTPException(
            status_code=401,
            detail={"code": "voice_lab_capability_missing"},
        )

    if _is_explicit_bypass_enabled():
        bypass_user_id = _get_bypass_user_id()
        if user_id != bypass_user_id:
            raise HTTPException(status_code=403, detail="User scope does not match bypass user")
        request.state.authenticated_user_id = user_id
        assert_voice_lab_gateway_route_allowed(request, user_id)
        return user_id

    cached_user_id = getattr(request.state, "authenticated_user_id", None)
    if isinstance(cached_user_id, str) and cached_user_id:
        authenticated_user_id = cached_user_id
    else:
        token = _extract_bearer_token(request)
        authenticated_user = await _get_authenticated_user(token)
        authenticated_user_id = authenticated_user["id"].strip()
        request.state.authenticated_user_id = authenticated_user_id

    if authenticated_user_id != user_id:
        logger.warning(
            "gateway.auth user_scope_mismatch requested_user_id=%s authenticated_user_id=%s",
            user_id,
            authenticated_user_id,
        )
        raise HTTPException(status_code=403, detail="Token does not grant access to this user")

    assert_voice_lab_gateway_route_allowed(request, user_id)
    return user_id


async def require_authenticated_user(request: Request) -> str:
    """Return the authenticated user for routes without a user_id path segment."""
    provider_cleanup_user_id = _voice_lab_provider_cleanup_authenticated_user(request)
    if provider_cleanup_user_id is not None:
        return _validated_auth_user_id(
            provider_cleanup_user_id,
            invalid_detail="Voice Lab provider cleanup principal is invalid",
        )
    capability_user_id = _voice_lab_capability_authenticated_user(request)
    if capability_user_id is not None:
        return _validated_auth_user_id(
            capability_user_id,
            invalid_detail="Voice Lab capability principal is invalid",
        )

    if _is_explicit_bypass_enabled():
        user_id = _validated_auth_user_id(
            _get_bypass_user_id(),
            invalid_detail="Auth bypass user is invalid",
        )
        request.state.authenticated_user_id = user_id
        assert_voice_lab_gateway_route_allowed(request, user_id)
        return user_id

    cached_user_id = getattr(request.state, "authenticated_user_id", None)
    if isinstance(cached_user_id, str) and cached_user_id:
        user_id = cached_user_id
    else:
        token = _extract_bearer_token(request)
        authenticated_user = await _get_authenticated_user(token)
        user_id = _validated_auth_user_id(
            authenticated_user["id"],
            invalid_detail="Auth service returned an invalid user payload",
        )
        request.state.authenticated_user_id = user_id
    assert_voice_lab_gateway_route_allowed(request, user_id)
    return _validated_auth_user_id(
        user_id,
        invalid_detail="Auth service returned an invalid user payload",
    )
