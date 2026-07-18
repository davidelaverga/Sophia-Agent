"""Authenticated wire boundary for the private DQ-2 invocation route.

The route is mounted on the otherwise public LangGraph service, so every
request is authenticated over its exact canonical JSON bytes before any DQ-2
runtime, storage client, controller, or model authority is constructed.  DQ-2
uses the existing builder-events secret, but a distinct protocol domain and
header namespace prevent a valid signature for another Sophia endpoint from
being replayed here.

This module never logs, returns, or embeds the shared secret or a request
signature in an exception.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import time
from collections import OrderedDict
from collections.abc import Mapping
from threading import Lock
from typing import Any

from deerflow.sophia.builder_event_auth import BUILDER_EVENT_HMAC_SECRET_ENV

DECK_DESIGN_LIFT_INVOCATION_PATH = "/internal/deck-design-lift"
DECK_DESIGN_LIFT_TIMESTAMP_HEADER = "X-Sophia-Deck-Lift-Timestamp"
DECK_DESIGN_LIFT_NONCE_HEADER = "X-Sophia-Deck-Lift-Nonce"
DECK_DESIGN_LIFT_SIGNATURE_HEADER = "X-Sophia-Deck-Lift-Signature"
DECK_DESIGN_LIFT_AUTH_VERSION = "sophia-deck-design-lift-invocation-hmac/v1"

MAX_DECK_DESIGN_LIFT_BODY_BYTES = 16 * 1024
MAX_DECK_DESIGN_LIFT_CLOCK_SKEW_SECONDS = 90
MAX_DECK_DESIGN_LIFT_REPLAY_ENTRIES = 10_000

_NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
_SIGNATURE_RE = re.compile(r"^v1=[0-9a-f]{64}$")


class DeckDesignLiftInvocationAuthenticationError(RuntimeError):
    """A content-free DQ-2 invocation authentication failure."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _secret_bytes() -> bytes:
    raw = os.getenv(BUILDER_EVENT_HMAC_SECRET_ENV)
    if not isinstance(raw, str):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_auth_unavailable")
    encoded = raw.encode("utf-8")
    if raw != raw.strip() or not 32 <= len(encoded) <= 4_096:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_auth_unavailable")
    return encoded


def probe_deck_design_lift_invocation_auth() -> None:
    """Fail startup closed when the shared credential is absent or weak."""

    _secret_bytes()


def encode_deck_design_lift_invocation_body(payload: Mapping[str, Any]) -> bytes:
    """Serialize one DQ-2 request into the only accepted canonical form."""

    try:
        body = json.dumps(
            dict(payload),
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid") from None
    if not body or len(body) > MAX_DECK_DESIGN_LIFT_BODY_BYTES:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid")
    return body


def _signing_input(*, timestamp: int, nonce: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return (f"{DECK_DESIGN_LIFT_AUTH_VERSION}\nPOST\n{DECK_DESIGN_LIFT_INVOCATION_PATH}\n{timestamp}\n{nonce}\n{body_hash}").encode("ascii")


def signed_deck_design_lift_invocation_headers(
    body: bytes,
    *,
    now: float | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """Create domain-separated headers for one exact canonical request."""

    if not isinstance(body, bytes) or not body or len(body) > MAX_DECK_DESIGN_LIFT_BODY_BYTES:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid")
    current = time.time() if now is None else now
    if isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(float(current)):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_timestamp_invalid")
    timestamp = int(current)
    request_nonce = secrets.token_hex(16) if nonce is None else nonce
    if not isinstance(request_nonce, str) or _NONCE_RE.fullmatch(request_nonce) is None:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_nonce_invalid")
    digest = hmac.new(
        _secret_bytes(),
        _signing_input(timestamp=timestamp, nonce=request_nonce, body=body),
        hashlib.sha256,
    ).hexdigest()
    return {
        "Content-Type": "application/json",
        DECK_DESIGN_LIFT_TIMESTAMP_HEADER: str(timestamp),
        DECK_DESIGN_LIFT_NONCE_HEADER: request_nonce,
        DECK_DESIGN_LIFT_SIGNATURE_HEADER: f"v1={digest}",
    }


def _header(headers: Mapping[str, str], name: str) -> str | None:
    direct = headers.get(name)
    if isinstance(direct, str):
        return direct
    expected = name.casefold()
    for key, value in headers.items():
        if str(key).casefold() == expected and isinstance(value, str):
            return value
    return None


class DeckDesignLiftReplayGuard:
    """Bounded process-local replay guard for authenticated DQ-2 nonces."""

    def __init__(
        self,
        *,
        max_entries: int = MAX_DECK_DESIGN_LIFT_REPLAY_ENTRIES,
        retention_seconds: int = MAX_DECK_DESIGN_LIFT_CLOCK_SKEW_SECONDS * 2,
    ) -> None:
        if not 1 <= max_entries <= MAX_DECK_DESIGN_LIFT_REPLAY_ENTRIES:
            raise ValueError("DQ-2 replay capacity is invalid")
        if not (MAX_DECK_DESIGN_LIFT_CLOCK_SKEW_SECONDS <= retention_seconds <= 600):
            raise ValueError("DQ-2 replay retention is invalid")
        self._max_entries = max_entries
        self._retention_seconds = retention_seconds
        self._entries: OrderedDict[tuple[int, str], float] = OrderedDict()
        self._lock = Lock()

    def mark(self, *, timestamp: int, nonce: str, now: float) -> None:
        key = (timestamp, nonce)
        with self._lock:
            while self._entries:
                first_key = next(iter(self._entries))
                if self._entries[first_key] > now:
                    break
                self._entries.popitem(last=False)
            if key in self._entries:
                raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_replay_detected")
            self._entries[key] = now + self._retention_seconds
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_REPLAY_GUARD = DeckDesignLiftReplayGuard()


def authenticate_deck_design_lift_invocation(
    body: bytes,
    headers: Mapping[str, str],
    *,
    now: float | None = None,
    replay_guard: DeckDesignLiftReplayGuard | None = None,
) -> None:
    """Authenticate exact body bytes and consume their one-time nonce."""

    if not isinstance(body, bytes) or not body or len(body) > MAX_DECK_DESIGN_LIFT_BODY_BYTES:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid")
    current = time.time() if now is None else now
    if isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(float(current)):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_timestamp_invalid")
    timestamp_text = _header(headers, DECK_DESIGN_LIFT_TIMESTAMP_HEADER)
    nonce = _header(headers, DECK_DESIGN_LIFT_NONCE_HEADER)
    signature = _header(headers, DECK_DESIGN_LIFT_SIGNATURE_HEADER)
    try:
        if timestamp_text is None or len(timestamp_text) > 16 or not timestamp_text.isascii() or not timestamp_text.isdecimal():
            raise ValueError
        timestamp = int(timestamp_text)
    except (TypeError, ValueError, OverflowError):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_timestamp_invalid") from None
    if abs(float(current) - timestamp) > MAX_DECK_DESIGN_LIFT_CLOCK_SKEW_SECONDS:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_timestamp_invalid")
    if nonce is None or _NONCE_RE.fullmatch(nonce) is None:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_nonce_invalid")
    if signature is None or _SIGNATURE_RE.fullmatch(signature) is None:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_signature_invalid")
    expected = hmac.new(
        _secret_bytes(),
        _signing_input(timestamp=timestamp, nonce=nonce, body=body),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, f"v1={expected}"):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_signature_invalid")
    (replay_guard or _REPLAY_GUARD).mark(
        timestamp=timestamp,
        nonce=nonce,
        now=float(current),
    )


def reset_deck_design_lift_replay_guard_for_tests() -> None:
    _REPLAY_GUARD.clear()


__all__ = [
    "DECK_DESIGN_LIFT_AUTH_VERSION",
    "DECK_DESIGN_LIFT_INVOCATION_PATH",
    "DECK_DESIGN_LIFT_NONCE_HEADER",
    "DECK_DESIGN_LIFT_SIGNATURE_HEADER",
    "DECK_DESIGN_LIFT_TIMESTAMP_HEADER",
    "DeckDesignLiftInvocationAuthenticationError",
    "DeckDesignLiftReplayGuard",
    "authenticate_deck_design_lift_invocation",
    "encode_deck_design_lift_invocation_body",
    "probe_deck_design_lift_invocation_auth",
    "reset_deck_design_lift_replay_guard_for_tests",
    "signed_deck_design_lift_invocation_headers",
]
