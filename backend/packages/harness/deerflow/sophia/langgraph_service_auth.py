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

from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.sophia.builder_event_auth import _secret_bytes

PREFIX = "SophiaLG1"
MAX_TTL = 30
READINESS_OWNER = "sophia-service-readiness"
_THREAD_PATH = re.compile(r"^/threads(?:/[0-9a-f-]{36}(?:/(?:state(?:/checkpoint)?|history|copy|runs(?:/[0-9a-f-]{36}(?:/(?:join|stream|cancel))?|/(?:stream|wait))?))?|/search)?$")
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
