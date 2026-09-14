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

from .langgraph_service_auth import LangGraphServiceAuthError, mint_service_authorization

_owner: ContextVar[str | None] = ContextVar("sophia_gateway_langgraph_owner", default=None)


@contextmanager
def langgraph_owner_scope(owner_id):
    token = _owner.set(owner_id)
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
