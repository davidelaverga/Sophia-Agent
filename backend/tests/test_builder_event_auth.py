from __future__ import annotations

import json

import pytest

from deerflow.sophia.builder_event_auth import (
    BUILDER_EVENT_HMAC_SECRET_ENV,
    BuilderEventAuthenticationError,
    BuilderEventReplayGuard,
    authenticate_builder_event,
    encode_builder_event_body,
    signed_builder_event_headers,
)

_SECRET = "dq1-test-builder-event-secret-" + "a" * 40
_NOW = 1_784_200_000.25
_NONCE = "0123456789abcdef0123456789abcdef"


@pytest.fixture(autouse=True)
def _configured_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _SECRET)


def _guard() -> BuilderEventReplayGuard:
    return BuilderEventReplayGuard(max_entries=4, retention_seconds=180)


def test_exact_canonical_body_authenticates_once() -> None:
    first = {"z": 1, "nested": {"value": "ok"}, "a": [True, None]}
    second = {"a": [True, None], "nested": {"value": "ok"}, "z": 1}
    body = encode_builder_event_body(first)
    assert body == encode_builder_event_body(second)
    headers = signed_builder_event_headers(body, now=_NOW, nonce=_NONCE)
    guard = _guard()

    authenticate_builder_event(body, headers, now=_NOW + 1, replay_guard=guard)
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_replay_detected"):
        authenticate_builder_event(body, headers, now=_NOW + 2, replay_guard=guard)


def test_body_header_and_clock_tampering_fail_closed() -> None:
    body = encode_builder_event_body({"task_id": "task-1"})
    headers = signed_builder_event_headers(body, now=_NOW, nonce=_NONCE)

    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_signature_invalid"):
        authenticate_builder_event(body + b" ", headers, now=_NOW, replay_guard=_guard())
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_nonce_invalid"):
        authenticate_builder_event(
            body,
            {**headers, "X-Sophia-Builder-Nonce": "not-a-nonce"},
            now=_NOW,
            replay_guard=_guard(),
        )
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_timestamp_invalid"):
        authenticate_builder_event(
            body,
            headers,
            now=_NOW + 91,
            replay_guard=_guard(),
        )


def test_missing_or_weak_secret_never_authenticates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = encode_builder_event_body({"task_id": "task-1"})
    monkeypatch.delenv(BUILDER_EVENT_HMAC_SECRET_ENV)
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_auth_unavailable"):
        signed_builder_event_headers(body, now=_NOW, nonce=_NONCE)
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, "short")
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_auth_unavailable"):
        signed_builder_event_headers(body, now=_NOW, nonce=_NONCE)


def test_noncanonical_json_is_signed_as_exact_bytes() -> None:
    body = b'{"task_id": "task-1"}'
    headers = signed_builder_event_headers(body, now=_NOW, nonce=_NONCE)
    authenticate_builder_event(body, headers, now=_NOW, replay_guard=_guard())

    reparsed = encode_builder_event_body(json.loads(body))
    assert reparsed != body
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_signature_invalid"):
        authenticate_builder_event(reparsed, headers, now=_NOW, replay_guard=_guard())


def test_nan_and_oversized_or_empty_bodies_are_rejected() -> None:
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_body_invalid"):
        encode_builder_event_body({"value": float("nan")})
    with pytest.raises(BuilderEventAuthenticationError, match="builder_event_body_invalid"):
        signed_builder_event_headers(b"", now=_NOW, nonce=_NONCE)
