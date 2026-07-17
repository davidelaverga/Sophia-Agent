"""Authenticated wire envelope for the DQ-1 producer-failure fallback.

The LangGraph and gateway services are separate production processes, but the
gateway route is reachable through the public service.  Each request to the
dedicated ``/internal/deck-quality-producer-failures`` endpoint is therefore
signed over its exact JSON bytes with a shared, dashboard-managed secret. The baseline
``/internal/builder-events`` delivery remains unsigned and independent so a
shadow-only configuration issue cannot gate user delivery. The gateway verifies
timestamp freshness, signature equality, and a bounded nonce replay cache before
any failure-evidence side effect.

This module never logs, returns, or embeds the secret in an exception.
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
from collections.abc import Iterable, Mapping
from threading import Lock
from typing import Any

BUILDER_EVENT_HMAC_SECRET_ENV = "SOPHIA_BUILDER_EVENTS_HMAC_SECRET"
BUILDER_EVENT_TIMESTAMP_HEADER = "X-Sophia-Builder-Timestamp"
BUILDER_EVENT_NONCE_HEADER = "X-Sophia-Builder-Nonce"
BUILDER_EVENT_SIGNATURE_HEADER = "X-Sophia-Builder-Signature"
BUILDER_EVENT_PROBE_ACK_HEADER = "X-Sophia-Builder-Probe-Ack"
BUILDER_EVENT_AUTH_VERSION = "sophia-builder-event-hmac/v1"
BUILDER_EVENT_CANARY_SCOPE_PROOF_VERSION = (
    "sophia-builder-event-canary-scope-proof/v1"
)

MAX_BUILDER_EVENT_BODY_BYTES = 4 * 1024 * 1024
MAX_BUILDER_EVENT_CLOCK_SKEW_SECONDS = 90
MAX_BUILDER_EVENT_REPLAY_ENTRIES = 10_000

_NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
_SIGNATURE_RE = re.compile(r"^v1=[0-9a-f]{64}$")
_PROBE_ACK_RE = re.compile(r"^v1=[0-9a-f]{64}$")


class BuilderEventAuthenticationError(RuntimeError):
    """A content-free builder webhook authentication failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _secret_bytes() -> bytes:
    raw = os.getenv(BUILDER_EVENT_HMAC_SECRET_ENV)
    if not isinstance(raw, str):
        raise BuilderEventAuthenticationError("builder_event_auth_unavailable")
    encoded = raw.encode("utf-8")
    if raw != raw.strip() or not 32 <= len(encoded) <= 4_096:
        raise BuilderEventAuthenticationError("builder_event_auth_unavailable")
    return encoded


def probe_builder_event_auth() -> None:
    """Validate that the shared secret is present and non-weak.

    The value is intentionally neither returned nor included in an error.
    """

    _secret_bytes()


def builder_event_canary_scope_proof(
    canary_user_ids: Iterable[str],
) -> str:
    """Return a keyed, content-free proof of one exact canary set.

    The HMAC prevents the dashboard-managed synthetic identity from becoming
    an offline-guessable plain hash. Only the 64-character proof crosses the
    service boundary; neither the identities nor the shared secret do.
    """

    try:
        normalized = tuple(sorted(set(canary_user_ids)))
    except (TypeError, ValueError):
        raise BuilderEventAuthenticationError(
            "builder_event_canary_scope_invalid"
        ) from None
    if not normalized or any(
        not isinstance(user_id, str)
        or not user_id
        or user_id != user_id.strip()
        or "\x00" in user_id
        for user_id in normalized
    ):
        raise BuilderEventAuthenticationError(
            "builder_event_canary_scope_invalid"
        )
    material = encode_builder_event_body(
        {
            "campaign_id": "DQ-1",
            "canary_user_ids": normalized,
            "schema_version": BUILDER_EVENT_CANARY_SCOPE_PROOF_VERSION,
        }
    )
    return hmac.new(
        _secret_bytes(),
        material,
        hashlib.sha256,
    ).hexdigest()


def builder_event_probe_ack(body: bytes) -> str:
    """Create an endpoint-specific keyed acknowledgment for one probe body."""

    if (
        not isinstance(body, bytes)
        or not body
        or len(body) > MAX_BUILDER_EVENT_BODY_BYTES
    ):
        raise BuilderEventAuthenticationError("builder_event_body_invalid")
    body_hash = hashlib.sha256(body).hexdigest()
    material = (
        "sophia-builder-event-probe-ack/v1\n" + body_hash
    ).encode("ascii")
    return "v1=" + hmac.new(
        _secret_bytes(),
        material,
        hashlib.sha256,
    ).hexdigest()


def verify_builder_event_probe_ack(
    body: bytes,
    headers: Mapping[str, str],
) -> None:
    """Require the exact keyed acknowledgment returned by the gateway."""

    received = _header(headers, BUILDER_EVENT_PROBE_ACK_HEADER)
    if (
        received is None
        or _PROBE_ACK_RE.fullmatch(received) is None
        or not hmac.compare_digest(received, builder_event_probe_ack(body))
    ):
        raise BuilderEventAuthenticationError(
            "builder_event_gateway_probe_ack_invalid"
        )


def encode_builder_event_body(payload: Mapping[str, Any]) -> bytes:
    """Serialize one webhook body deterministically for signing and sending."""

    try:
        body = json.dumps(
            dict(payload),
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError):
        raise BuilderEventAuthenticationError("builder_event_body_invalid") from None
    if not body or len(body) > MAX_BUILDER_EVENT_BODY_BYTES:
        raise BuilderEventAuthenticationError("builder_event_body_invalid")
    return body


def _signing_input(*, timestamp: int, nonce: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return (f"{BUILDER_EVENT_AUTH_VERSION}\n{timestamp}\n{nonce}\n{body_hash}").encode("ascii")


def signed_builder_event_headers(
    body: bytes,
    *,
    now: float | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """Return the exact headers for one request attempt.

    A new nonce must be generated for every transport retry.  The body may be
    identical because downstream delivery/publication operations are
    independently idempotent.
    """

    if not isinstance(body, bytes) or not body or len(body) > MAX_BUILDER_EVENT_BODY_BYTES:
        raise BuilderEventAuthenticationError("builder_event_body_invalid")
    current = time.time() if now is None else now
    if isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(float(current)):
        raise BuilderEventAuthenticationError("builder_event_timestamp_invalid")
    timestamp = int(current)
    request_nonce = secrets.token_hex(16) if nonce is None else nonce
    if not isinstance(request_nonce, str) or _NONCE_RE.fullmatch(request_nonce) is None:
        raise BuilderEventAuthenticationError("builder_event_nonce_invalid")
    digest = hmac.new(
        _secret_bytes(),
        _signing_input(timestamp=timestamp, nonce=request_nonce, body=body),
        hashlib.sha256,
    ).hexdigest()
    return {
        "Content-Type": "application/json",
        BUILDER_EVENT_TIMESTAMP_HEADER: str(timestamp),
        BUILDER_EVENT_NONCE_HEADER: request_nonce,
        BUILDER_EVENT_SIGNATURE_HEADER: f"v1={digest}",
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


class BuilderEventReplayGuard:
    """Bounded process-local replay guard for already authenticated nonces."""

    def __init__(
        self,
        *,
        max_entries: int = MAX_BUILDER_EVENT_REPLAY_ENTRIES,
        retention_seconds: int = MAX_BUILDER_EVENT_CLOCK_SKEW_SECONDS * 2,
    ) -> None:
        if not 1 <= max_entries <= MAX_BUILDER_EVENT_REPLAY_ENTRIES:
            raise ValueError("builder event replay capacity is invalid")
        if not MAX_BUILDER_EVENT_CLOCK_SKEW_SECONDS <= retention_seconds <= 600:
            raise ValueError("builder event replay retention is invalid")
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
                raise BuilderEventAuthenticationError("builder_event_replay_detected")
            self._entries[key] = now + self._retention_seconds
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_REPLAY_GUARD = BuilderEventReplayGuard()


def authenticate_builder_event(
    body: bytes,
    headers: Mapping[str, str],
    *,
    now: float | None = None,
    replay_guard: BuilderEventReplayGuard | None = None,
) -> None:
    """Authenticate exact request bytes and consume their one-time nonce."""

    if not isinstance(body, bytes) or not body or len(body) > MAX_BUILDER_EVENT_BODY_BYTES:
        raise BuilderEventAuthenticationError("builder_event_body_invalid")
    current = time.time() if now is None else now
    if isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(float(current)):
        raise BuilderEventAuthenticationError("builder_event_timestamp_invalid")
    timestamp_text = _header(headers, BUILDER_EVENT_TIMESTAMP_HEADER)
    nonce = _header(headers, BUILDER_EVENT_NONCE_HEADER)
    signature = _header(headers, BUILDER_EVENT_SIGNATURE_HEADER)
    try:
        if timestamp_text is None or not timestamp_text.isascii() or not timestamp_text.isdecimal():
            raise ValueError
        timestamp = int(timestamp_text)
    except (TypeError, ValueError, OverflowError):
        raise BuilderEventAuthenticationError("builder_event_timestamp_invalid") from None
    if abs(float(current) - timestamp) > MAX_BUILDER_EVENT_CLOCK_SKEW_SECONDS:
        raise BuilderEventAuthenticationError("builder_event_timestamp_invalid")
    if nonce is None or _NONCE_RE.fullmatch(nonce) is None:
        raise BuilderEventAuthenticationError("builder_event_nonce_invalid")
    if signature is None or _SIGNATURE_RE.fullmatch(signature) is None:
        raise BuilderEventAuthenticationError("builder_event_signature_invalid")
    expected = hmac.new(
        _secret_bytes(),
        _signing_input(timestamp=timestamp, nonce=nonce, body=body),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, f"v1={expected}"):
        raise BuilderEventAuthenticationError("builder_event_signature_invalid")
    (replay_guard or _REPLAY_GUARD).mark(
        timestamp=timestamp,
        nonce=nonce,
        now=float(current),
    )


def reset_builder_event_replay_guard_for_tests() -> None:
    _REPLAY_GUARD.clear()
