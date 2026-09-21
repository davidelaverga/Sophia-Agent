"""Exact reserved-thread authority for Voice Lab session allocation and recovery.

This is neither an owner credential nor the retention maintenance lane. It
uses the existing service signing key, a separate domain, and the canonical
cleanup admission on both sides. It cannot address runs, state, or memory.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from uuid import UUID, uuid4

import httpx

from .builder_event_auth import _secret_bytes
from .cleanup_fence import cleanup_admission_authorized, cleanup_admissions
from .langgraph_service_auth import MAX_TTL, LangGraphServiceAuthError, _decode, _encode

PREFIX = "SophiaLGV1"
PERMISSION = "sophia:voice-lab-thread"
BINDING_KEY = "voice_lab_thread_authority"
_DOMAIN = b"sophia.langgraph.voice-lab-thread.v1\x00"


def metadata_digest(metadata):
    return hashlib.sha256(json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _admission(binding, purpose):
    if not isinstance(binding, dict) or set(binding) != {"cleanup_obligation_id", "admission_id", "resource_kind", "resource_id"}:
        raise LangGraphServiceAuthError()
    for key in ("cleanup_obligation_id", "admission_id", "resource_id"):
        if str(UUID(binding[key])) != binding[key]:
            raise LangGraphServiceAuthError()
    if binding["resource_kind"] not in {"session", "builder"} or purpose not in {"session_create", "discard", "fence"}:
        raise LangGraphServiceAuthError()
    if purpose != "fence" and binding["resource_kind"] != "session":
        raise LangGraphServiceAuthError()
    matches = [item for item in cleanup_admissions(binding["cleanup_obligation_id"])
               if all(getattr(item, key) == value for key, value in binding.items()) and item.status == "reserved"]
    if len(matches) != 1:
        raise LangGraphServiceAuthError()
    admission = matches[0]
    if purpose == "session_create" and not cleanup_admission_authorized(admission):
        raise LangGraphServiceAuthError()
    if purpose == "fence" and not admission.expired:
        raise LangGraphServiceAuthError()
    return admission


def _validate(claims, method, path):
    principal = (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip()
    if not principal or claims["sub"] != principal:
        raise LangGraphServiceAuthError()
    purpose, binding = claims["purpose"], claims["binding"]
    admission = _admission(binding, purpose)
    if claims["method"] != method or claims["path"] != path:
        raise LangGraphServiceAuthError()
    create = method == "POST" and path == "/threads"
    exact = path == "/threads/" + binding["resource_id"]
    if not ((purpose == "session_create" and create)
            or (purpose == "discard" and exact and method in {"GET", "DELETE"})
            or (purpose == "fence" and (create or (exact and method in {"GET", "DELETE"})))):
        raise LangGraphServiceAuthError()
    if not isinstance(claims["metadata_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", claims["metadata_sha256"]):
        raise LangGraphServiceAuthError()
    if purpose == "fence":
        if not isinstance(claims["fence_hmac"], str) or not re.fullmatch(r"[a-f0-9]{64}", claims["fence_hmac"]):
            raise LangGraphServiceAuthError()
    elif claims["fence_hmac"] is not None:
        raise LangGraphServiceAuthError()
    return admission


class VoiceLabThreadAuth(httpx.Auth):
    def __init__(self, admission, *, purpose, metadata=None, fence_hmac=None):
        self.binding = {key: getattr(admission, key) for key in ("cleanup_obligation_id", "admission_id", "resource_kind", "resource_id")}
        self.purpose = purpose
        self.metadata_sha256 = metadata_digest(metadata)
        self.fence_hmac = fence_hmac

    def auth_flow(self, request):
        now = int(time.time())
        claims = {"v": 1, "sub": (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip(),
                  "iat": now, "exp": now + MAX_TTL, "nonce": uuid4().hex,
                  "method": request.method, "path": request.url.path, "purpose": self.purpose,
                  "binding": self.binding, "metadata_sha256": self.metadata_sha256, "fence_hmac": self.fence_hmac}
        try:
            _validate(claims, request.method, request.url.path)
            encoded = _encode(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode())
            signature = _encode(hmac.new(_secret_bytes(), _DOMAIN + encoded.encode(), hashlib.sha256).digest())
            request.headers["Authorization"] = PREFIX + " " + encoded + "." + signature
        except Exception:
            raise LangGraphServiceAuthError() from None
        yield request


def verify_authorization(authorization, *, method, path):
    try:
        if len(authorization) > 8192:
            raise LangGraphServiceAuthError()
        prefix, token = authorization.split(" ")
        encoded, signature = token.split(".")
        if prefix != PREFIX or not hmac.compare_digest(_decode(signature), hmac.new(_secret_bytes(), _DOMAIN + encoded.encode(), hashlib.sha256).digest()):
            raise LangGraphServiceAuthError()
        claims = json.loads(_decode(encoded))
        if set(claims) != {"v", "sub", "iat", "exp", "nonce", "method", "path", "purpose", "binding", "metadata_sha256", "fence_hmac"}:
            raise LangGraphServiceAuthError()
        if (type(claims["v"]) is not int or claims["v"] != 1
                or type(claims["iat"]) is not int or type(claims["exp"]) is not int
                or claims["exp"] - claims["iat"] != MAX_TTL or not claims["iat"] <= int(time.time()) < claims["exp"]
                or not isinstance(claims["nonce"], str) or not re.fullmatch(r"[a-f0-9]{32}", claims["nonce"])):
            raise LangGraphServiceAuthError()
        _validate(claims, method, path)
        return claims
    except Exception:
        raise LangGraphServiceAuthError() from None


def authorize_thread(ctx, value, *, owner_key, maintenance_key, creating=False):
    """Called by the installed policy; recheck canonical admission at use time."""
    claims = ctx.user[BINDING_KEY]
    _validate(claims, claims["method"], claims["path"])
    binding, purpose = claims["binding"], claims["purpose"]
    if str(value.get("thread_id")) != binding["resource_id"]:
        raise LangGraphServiceAuthError()

    synthetic_filter = {maintenance_key: True, "cleanup_obligation_id": binding["cleanup_obligation_id"], "principal_id": claims["sub"]}
    fence_filter = {"synthetic_cleanup_fence": True, "cleanup_obligation_id_hmac": claims["fence_hmac"], "resource_kind": "session_thread"}
    if creating:
        if purpose not in {"session_create", "fence"} or value.get("if_exists", "raise") != "raise":
            raise LangGraphServiceAuthError()
        metadata = value.get("metadata")
        if not isinstance(metadata, dict) or metadata_digest(metadata) != claims["metadata_sha256"]:
            raise LangGraphServiceAuthError()
        if purpose == "fence":
            if metadata != fence_filter:
                raise LangGraphServiceAuthError()
            return fence_filter
        if (metadata.get("synthetic") is not True or metadata.get("principal_id") != claims["sub"]
                or metadata.get("cleanup_obligation_id") != binding["cleanup_obligation_id"]
                or metadata.get("cleanup_admission_id") != binding["admission_id"]
                or metadata.get("graph_id") != "sophia_companion"
                or any(key in metadata for key in (maintenance_key, owner_key, "sophia_deck_quality_v1", "synthetic_cleanup_fence"))):
            raise LangGraphServiceAuthError()
        metadata[maintenance_key] = True
        return synthetic_filter
    if purpose not in {"discard", "fence"} or ctx.action not in {"read", "delete"}:
        raise LangGraphServiceAuthError()
    return {"$or": [synthetic_filter, fence_filter]} if purpose == "fence" else synthetic_filter
