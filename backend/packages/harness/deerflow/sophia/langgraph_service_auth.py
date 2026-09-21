"""Short-lived, owner/method/path-scoped internal LangGraph authentication.

Uses the already shared Builder-events secret with a separate protocol domain.
The underlying key is never sent to LangGraph callers. A token is valid for one
exact HTTP route for 30 seconds; thread policy still applies on every use.
This is an authentication credential, not a memory approval or erasure receipt.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from uuid import uuid4

from deerflow.sophia.builder_event_auth import _secret_bytes
from deerflow.sophia.user_id import validate_user_id

PREFIX = "SophiaLG1"
MAX_TTL = 30
READINESS_OWNER = "sophia-service-readiness"

# Non-owner service principals. These are not accounts: no person can sign in as
# one, `_owner` in the runtime policy refuses them as user identities, and a
# token for one can only be minted by a process holding the shared secret. They
# exist because three of the callers below cannot carry a principal at all --
# post-retention cleanup and the global reaper run precisely AFTER the raw
# identity has been erased, which is the Voice Lab retention obligation they
# implement.
MAINTENANCE_OWNER = "sophia-service-maintenance"
DECK_QUALITY_OWNER = "sophia-service-deck-quality"
SERVICE_OWNERS = frozenset({READINESS_OWNER, MAINTENANCE_OWNER, DECK_QUALITY_OWNER})

_THREAD_PATH = re.compile(r"^/threads(?:/[0-9a-f-]{36}(?:/(?:state(?:/checkpoint)?|history|copy|runs(?:/[0-9a-f-]{36}(?:/(?:join|stream|cancel))?|/(?:stream|wait))?))?|/search)?$")
_UUID = "[0-9a-f-]{36}"

# Exact (method, path) allow-lists, deliberately NOT `_THREAD_PATH`. The owner
# lane may reach /state, /history and /copy; a lane that is not owner-scoped
# must not, or it becomes a cross-owner content read. Retention maintenance
# needs to enumerate, identify, cancel and delete -- nothing else, and no run
# creation at all.
_MAINTENANCE_ROUTES = {
    "POST": (re.compile(r"^/threads/search$"),
             re.compile(rf"^/threads/{_UUID}/runs/{_UUID}/cancel$")),
    "GET": (re.compile(rf"^/threads/{_UUID}$"),
            re.compile(rf"^/threads/{_UUID}/runs$"),
            re.compile(rf"^/threads/{_UUID}/runs/{_UUID}$")),
    "DELETE": (re.compile(rf"^/threads/{_UUID}$"),),
}
# Deck quality dispatch DOES create runs, on its own deterministic thread id.
# It is a separate scope for that reason: the retention lane above must never
# gain run creation by sharing one.
_DECK_QUALITY_ROUTES = {
    "POST": (re.compile(r"^/threads$"), re.compile(rf"^/threads/{_UUID}/runs$")),
    "GET": (re.compile(rf"^/threads/{_UUID}/runs$"),),
}
_SERVICE_LANES = {
    MAINTENANCE_OWNER: ("maintenance", _MAINTENANCE_ROUTES),
    DECK_QUALITY_OWNER: ("deck_quality", _DECK_QUALITY_ROUTES),
}

_TOKEN_CHARS = re.compile(r"^[A-Za-z0-9_-]+$")
_DOMAIN = b"sophia.langgraph.service-auth.v1\x00"


class LangGraphServiceAuthError(ValueError):
    def __init__(self):
        super().__init__("langgraph_service_auth_denied")


def _scope(owner, method, path):
    if validate_user_id(owner) != owner or method not in {"GET", "POST", "PATCH", "DELETE"}:
        raise LangGraphServiceAuthError()
    if owner == (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip():
        raise LangGraphServiceAuthError()
    # Checked BEFORE the readiness route below: a lane principal is confined to
    # its own list and nothing else, not even a route every ordinary owner may
    # reach. Only READINESS_OWNER itself, which is not a lane, gets that one.
    if owner in _SERVICE_LANES:
        scope, routes = _SERVICE_LANES[owner]
        if any(pattern.fullmatch(path) for pattern in routes.get(method, ())):
            return scope
        raise LangGraphServiceAuthError()
    if method == "POST" and path == "/assistants/search":
        return "readiness"
    if owner == READINESS_OWNER or not _THREAD_PATH.fullmatch(path):
        raise LangGraphServiceAuthError()
    return "owner"


def _encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value):
    if not _TOKEN_CHARS.fullmatch(value):
        raise LangGraphServiceAuthError()
    result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _encode(result) != value:
        raise LangGraphServiceAuthError()
    return result


def mint_service_authorization(*, owner_id: str, method: str, path: str, now: int | None = None) -> str:
    try:
        scope = _scope(owner_id, method, path)
        issued = int(time.time()) if now is None else now
        if type(issued) is not int:
            raise LangGraphServiceAuthError()
        payload = {"v": 1, "sub": owner_id, "method": method, "path": path, "scope": scope,
                   "iat": issued, "exp": issued + MAX_TTL, "nonce": uuid4().hex}
        encoded = _encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
        signature = _encode(hmac.new(_secret_bytes(), _DOMAIN + encoded.encode(), hashlib.sha256).digest())
        return PREFIX + " " + encoded + "." + signature
    except Exception:
        raise LangGraphServiceAuthError() from None


def verify_service_authorization(authorization: str, *, method: str, path: str, now: int | None = None) -> dict:
    try:
        if not isinstance(authorization, str) or len(authorization) > 4096:
            raise LangGraphServiceAuthError()
        prefix, value = authorization.split(" ")
        if prefix != PREFIX:
            raise LangGraphServiceAuthError()
        encoded, signature = value.split(".")
        expected = hmac.new(_secret_bytes(), _DOMAIN + encoded.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(_decode(signature), expected):
            raise LangGraphServiceAuthError()
        payload = json.loads(_decode(encoded))
        if not isinstance(payload, dict) or set(payload) != {"v", "sub", "method", "path", "scope", "iat", "exp", "nonce"}:
            raise LangGraphServiceAuthError()
        current = int(time.time()) if now is None else now
        if (type(payload["v"]) is not int or payload["v"] != 1 or type(payload["iat"]) is not int or type(payload["exp"]) is not int
                or payload["exp"] - payload["iat"] != MAX_TTL or not payload["iat"] <= current < payload["exp"]
                or not isinstance(payload["nonce"], str) or not re.fullmatch(r"[a-f0-9]{32}", payload["nonce"])
                or payload["method"] != method or payload["path"] != path
                or payload["scope"] != _scope(payload["sub"], method, path)):
            raise LangGraphServiceAuthError()
        return payload
    except Exception:
        raise LangGraphServiceAuthError() from None
