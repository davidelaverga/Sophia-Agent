"""Per-request authentication for existing Gateway LangGraph SDK clients.

Owner context must be established by an authenticated route or a trusted
owner-bearing internal event. Shared clients do not cache a user's credential;
each request gets a fresh exact-route token using the current task's context.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar

import httpx

from .langgraph_service_auth import (
    DECK_QUALITY_OWNER,
    MAINTENANCE_OWNER,
    LangGraphServiceAuthError,
    mint_service_authorization,
)

_owner: ContextVar[str | None] = ContextVar("sophia_gateway_langgraph_owner", default=None)

_SERVICE_LANES = {"maintenance": MAINTENANCE_OWNER, "deck_quality": DECK_QUALITY_OWNER}


@contextmanager
def langgraph_owner_scope(owner_id):
    token = _owner.set(owner_id)
    try:
        yield
    finally:
        _owner.reset(token)


@contextmanager
def langgraph_service_scope(lane):
    """Enter a named non-owner lane, for callers that have no owner to carry.

    Deliberately the same mechanism as `langgraph_owner_scope`, so a service
    lane is a *value* in the existing owner context rather than a second,
    parallel credential path. The minting side refuses any route outside the
    lane's allow-list, so entering a lane grants nothing on its own.

    A caller that HAS an owner must use `langgraph_owner_scope`; this is only
    for the paths that structurally cannot, such as post-retention cleanup
    after the raw identity has been erased.
    """
    if lane not in _SERVICE_LANES:
        raise LangGraphServiceAuthError()
    token = _owner.set(_SERVICE_LANES[lane])
    try:
        yield
    finally:
        _owner.reset(token)


class OwnerScopedAuth(httpx.Auth):
    def auth_flow(self, request):
        owner = _owner.get()
        if not owner:
            raise LangGraphServiceAuthError()
        request.headers["Authorization"] = mint_service_authorization(owner_id=owner, method=request.method, path=request.url.path)
        yield request


def get_client(*, url=None, **kwargs):
    from langgraph_sdk import get_client as sdk_get_client
    # In-process SDK transport preserves the authenticated parent AuthContext;
    # do not replace that stronger owner binding with a guessed config user.
    # The signed service credential is sufficient; do not incidentally forward
    # a LangSmith tracing API key to the runtime as an SDK environment default.
    kwargs.setdefault("api_key", None)
    client = sdk_get_client(url=url, **kwargs)
    production = bool(os.getenv("RENDER_SERVICE_ID") or os.getenv("RENDER_GIT_COMMIT")) or os.getenv("RENDER", "").lower() == "true" or os.getenv("ENVIRONMENT", "").lower() == "production"
    if url is not None and (production or os.getenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET")):
        client.http.client.auth = OwnerScopedAuth()
    return client
