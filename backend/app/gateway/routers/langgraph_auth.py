"""Existing bearer-bridge subject resolution for the LangGraph service.

This endpoint returns only the caller's authenticated subject. No token, memory,
session or checkpoint is returned, and development bypass is never honored.
"""

import hmac
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(prefix="/api/sophia-auth", tags=["authentication"])


async def _subject_id(request: Request) -> str:
    from app.gateway.auth import _extract_bearer_token, _get_authenticated_user, assert_voice_lab_gateway_route_allowed
    from deerflow.agents.sophia_agent.utils import validate_user_id

    # Do not use the request-state cache: development bypass can populate it.
    payload = await _get_authenticated_user(_extract_bearer_token(request))
    try:
        owner = validate_user_id(payload["id"])
        if owner != payload["id"]:
            raise ValueError("invalid subject")
    except (ValueError, KeyError, TypeError):
        raise HTTPException(503, "Authentication unavailable") from None
    assert_voice_lab_gateway_route_allowed(request, owner)
    return owner


@router.get("/subject")
async def authenticated_subject(request: Request):
    owner = await _subject_id(request)
    return JSONResponse({"id": owner}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@router.get("/memory-authority")
async def authenticated_memory_authority(request: Request):
    """Current routing observation, not a source or model admission."""
    from starlette.concurrency import run_in_threadpool
    from deerflow.sophia.memory_governance.owner_authority import resolve_owner_authority

    owner = await _subject_id(request)
    try:
        authority = await run_in_threadpool(resolve_owner_authority, owner)
        if authority.user_id != owner or authority.authority_state not in {"legacy", "governed"}:
            raise ValueError("invalid authority")
    except Exception:
        raise HTTPException(503, "Memory authority unavailable", headers={"Cache-Control": "no-store"}) from None
    return JSONResponse({"schema": "mem00.chat-authority.v1", "owner_id": owner,
        "authority": authority.authority_state, "observation_only": True},
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


class ServiceAuthorizationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner_id: str = Field(min_length=1, max_length=128)
    method: str = Field(min_length=3, max_length=6)
    path: str = Field(min_length=1, max_length=256)


@router.post("/langgraph-service-token")
async def langgraph_service_token(body: ServiceAuthorizationRequest, request: Request):
    # Voice is already a trusted owner-bearing internal caller. Reuse that
    # exact service credential to broker a narrow, short-lived token; never
    # distribute the Builder signing key to another service/browser.
    supplied = request.headers.get("X-Sophia-Voice-Internal-Auth")
    configured = (os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET") or "").strip()
    if len(configured.encode()) < 32:
        raise HTTPException(503, "Service authentication unavailable")
    if not supplied or not hmac.compare_digest(supplied, configured):
        raise HTTPException(401, "Service authentication required")
    from deerflow.sophia.langgraph_service_auth import LangGraphServiceAuthError, mint_service_authorization
    try:
        authorization = mint_service_authorization(owner_id=body.owner_id, method=body.method, path=body.path)
    except LangGraphServiceAuthError:
        raise HTTPException(403, "Service scope denied") from None
    return JSONResponse({"authorization": authorization, "expires_in": 30}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})
