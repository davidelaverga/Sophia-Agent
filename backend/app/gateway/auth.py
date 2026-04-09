"""User-scoped authorization helpers for gateway routes."""

from __future__ import annotations

import logging
import os

import httpx
from fastapi import HTTPException, Request

from deerflow.agents.sophia_agent.utils import validate_user_id

logger = logging.getLogger(__name__)

AUTH_ME_TIMEOUT_SECONDS = 5.0


def _is_explicit_bypass_enabled() -> bool:
    raw_value = (
        os.getenv("SOPHIA_AUTH_BYPASS")
        or os.getenv("NEXT_PUBLIC_SOPHIA_AUTH_BYPASS")
        or os.getenv("NEXT_PUBLIC_DEV_BYPASS_AUTH")
    )
    return isinstance(raw_value, str) and raw_value.strip().lower() == "true"


def _get_bypass_user_id() -> str:
    return (
        os.getenv("SOPHIA_USER_ID")
        or os.getenv("NEXT_PUBLIC_SOPHIA_USER_ID")
        or "local-dev-user"
    ).strip()


def _get_legacy_auth_base_url() -> str:
    return (
        os.getenv("SOPHIA_AUTH_BACKEND_URL")
        or os.getenv("BACKEND_API_URL")
        or os.getenv("VOICE_SERVER_URL")
        or "http://localhost:8000"
    ).strip().rstrip("/")


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

    try:
        payload = response.json()
    except ValueError as exc:
        logger.warning("gateway.auth auth_me_invalid_json url=%s", auth_url)
        raise HTTPException(status_code=503, detail="Auth service returned invalid JSON") from exc

    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not payload["id"].strip():
        logger.warning("gateway.auth auth_me_missing_id url=%s payload_type=%s", auth_url, type(payload).__name__)
        raise HTTPException(status_code=503, detail="Auth service returned an invalid user payload")

    return payload


async def require_authorized_user_scope(request: Request) -> str:
    raw_user_id = request.path_params.get("user_id")
    if not isinstance(raw_user_id, str):
        raise HTTPException(status_code=500, detail="Route is missing user scope")

    try:
        user_id = validate_user_id(raw_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid user_id format") from exc

    if _is_explicit_bypass_enabled():
        bypass_user_id = _get_bypass_user_id()
        if user_id != bypass_user_id:
            raise HTTPException(status_code=403, detail="User scope does not match bypass user")
        return user_id

    token = _extract_bearer_token(request)
    authenticated_user = await _get_authenticated_user(token)
    authenticated_user_id = authenticated_user["id"].strip()

    if authenticated_user_id != user_id:
        logger.warning(
            "gateway.auth user_scope_mismatch requested_user_id=%s authenticated_user_id=%s",
            user_id,
            authenticated_user_id,
        )
        raise HTTPException(status_code=403, detail="Token does not grant access to this user")

    return user_id