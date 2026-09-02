from __future__ import annotations

import json
from functools import partial

import httpx
import pytest

from deerflow.sophia.builder_event_auth import (
    BUILDER_EVENT_HMAC_SECRET_ENV,
    signed_builder_event_headers,
)
from deerflow.sophia.deck_design_lift import http_app as http_app_module
from deerflow.sophia.deck_design_lift.http_app import app
from deerflow.sophia.deck_design_lift.invocation_auth import (
    DECK_DESIGN_LIFT_INVOCATION_PATH,
    MAX_DECK_DESIGN_LIFT_BODY_BYTES,
    DeckDesignLiftInvocationAuthenticationError,
    DeckDesignLiftReplayGuard,
    authenticate_deck_design_lift_invocation,
    encode_deck_design_lift_invocation_body,
    probe_deck_design_lift_invocation_auth,
    reset_deck_design_lift_replay_guard_for_tests,
    signed_deck_design_lift_invocation_headers,
)

_SECRET = "0123456789abcdef0123456789abcdef"
_NOW = 2_000_000_000
_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"


def _payload(**updates: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "campaign_run_id": "campaign-0001",
        "experiment_id": "experiment-0001",
        "build_id": "build-0001",
        "user_id": "canary-user-01",
        "operation_id": "operation-0001",
    }
    payload.update(updates)
    return payload


@pytest.fixture(autouse=True)
def _configured_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, _SECRET)
    reset_deck_design_lift_replay_guard_for_tests()
    # Route tests must not depend on how long the full backend suite has been
    # running. Production still uses the real clock; only this app-local test
    # binding receives the controlled timestamp.
    monkeypatch.setattr(
        http_app_module,
        "authenticate_deck_design_lift_invocation",
        partial(authenticate_deck_design_lift_invocation, now=_NOW),
    )


@pytest.mark.anyio
async def test_version_exposes_only_the_exact_render_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RENDER_GIT_COMMIT", _COMMIT_SHA)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/version")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "service": "sophia-langgraph",
        "commit_sha": _COMMIT_SHA,
        "memory_contract_schema": "mem00.v1",
        "memory_supported_contract_epoch": 1,
    }


@pytest.mark.anyio
@pytest.mark.parametrize("candidate", [None, "main", "A" * 40, "a" * 39])
async def test_version_fails_closed_without_an_exact_render_commit(
    monkeypatch: pytest.MonkeyPatch,
    candidate: str | None,
) -> None:
    if candidate is None:
        monkeypatch.delenv("RENDER_GIT_COMMIT", raising=False)
    else:
        monkeypatch.setenv("RENDER_GIT_COMMIT", candidate)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/version")

    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "service": "sophia-langgraph",
        "status": "identity_unavailable",
    }


def test_invocation_auth_accepts_one_fresh_exact_body_and_rejects_replay() -> None:
    body = encode_deck_design_lift_invocation_body(_payload())
    headers = signed_deck_design_lift_invocation_headers(
        body,
        now=_NOW,
        nonce="a" * 32,
    )
    guard = DeckDesignLiftReplayGuard()

    authenticate_deck_design_lift_invocation(
        body,
        headers,
        now=_NOW,
        replay_guard=guard,
    )
    with pytest.raises(
        DeckDesignLiftInvocationAuthenticationError,
        match="deck_design_lift_replay_detected",
    ):
        authenticate_deck_design_lift_invocation(
            body,
            headers,
            now=_NOW,
            replay_guard=guard,
        )


def test_invocation_auth_rejects_expiry_tampering_and_other_protocol_domain() -> None:
    body = encode_deck_design_lift_invocation_body(_payload())
    headers = signed_deck_design_lift_invocation_headers(
        body,
        now=_NOW,
        nonce="b" * 32,
    )

    with pytest.raises(
        DeckDesignLiftInvocationAuthenticationError,
        match="deck_design_lift_timestamp_invalid",
    ):
        authenticate_deck_design_lift_invocation(
            body,
            headers,
            now=_NOW + 91,
            replay_guard=DeckDesignLiftReplayGuard(),
        )
    with pytest.raises(
        DeckDesignLiftInvocationAuthenticationError,
        match="deck_design_lift_signature_invalid",
    ):
        authenticate_deck_design_lift_invocation(
            body + b" ",
            headers,
            now=_NOW,
            replay_guard=DeckDesignLiftReplayGuard(),
        )
    with pytest.raises(DeckDesignLiftInvocationAuthenticationError):
        authenticate_deck_design_lift_invocation(
            body,
            signed_builder_event_headers(
                body,
                now=_NOW,
                nonce="c" * 32,
            ),
            now=_NOW,
            replay_guard=DeckDesignLiftReplayGuard(),
        )


def test_startup_probe_rejects_missing_or_weak_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(BUILDER_EVENT_HMAC_SECRET_ENV)
    with pytest.raises(
        DeckDesignLiftInvocationAuthenticationError,
        match="deck_design_lift_auth_unavailable",
    ):
        probe_deck_design_lift_invocation_auth()

    monkeypatch.setenv(BUILDER_EVENT_HMAC_SECRET_ENV, "too-short")
    with pytest.raises(
        DeckDesignLiftInvocationAuthenticationError,
        match="deck_design_lift_auth_unavailable",
    ):
        probe_deck_design_lift_invocation_auth()


@pytest.mark.anyio
async def test_http_route_rejects_before_runtime_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        http_app_module,
        "_configured_runtime",
        lambda: calls.append("runtime"),
    )
    body = encode_deck_design_lift_invocation_body(_payload())

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            DECK_DESIGN_LIFT_INVOCATION_PATH,
            content=body,
            headers={"Content-Type": "application/json"},
        )
        oversized_response = await client.post(
            DECK_DESIGN_LIFT_INVOCATION_PATH,
            content=b"x" * (MAX_DECK_DESIGN_LIFT_BODY_BYTES + 1),
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 401
    assert oversized_response.status_code == 401
    assert response.json() == {"detail": "deck_design_lift_request_rejected"}
    assert calls == []
    assert _SECRET not in response.text


@pytest.mark.anyio
async def test_http_route_requires_canonical_body_and_server_owned_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtimes: list[_Runtime] = []
    states: list[dict[str, object]] = []

    class _Runtime:
        closed = False

        async def aclose(self) -> None:
            self.closed = True

    def runtime_factory() -> _Runtime:
        runtime = _Runtime()
        runtimes.append(runtime)
        return runtime

    async def run_node(
        runtime: _Runtime,
        state: dict[str, object],
    ) -> dict[str, object]:
        assert runtime in runtimes
        states.append(state)
        return {
            "campaign_run_id": state["campaign_run_id"],
            "experiment_id": state["experiment_id"],
            "build_id": state["build_id"],
            "operation_id": state["operation_id"],
            "transaction_id": None,
            "disposition": "NO_REPAIR_NEEDED",
            "terminal_code": "no_repair_needed",
            "initial_quality_run_id": "quality-initial-0001",
            "candidate_quality_run_id": None,
            "comparison_result": None,
            "comparison_reasons": [],
            "committed_manifest_revision": None,
        }

    monkeypatch.setattr(http_app_module, "_configured_runtime", runtime_factory)
    monkeypatch.setattr(http_app_module, "run_deck_design_lift", run_node)

    noncanonical = json.dumps(_payload(), sort_keys=False).encode()
    noncanonical_headers = signed_deck_design_lift_invocation_headers(
        noncanonical,
        now=_NOW,
        nonce="d" * 32,
    )
    caller_lease_body = encode_deck_design_lift_invocation_body(_payload(lease_owner="caller-controlled"))
    caller_lease_headers = signed_deck_design_lift_invocation_headers(
        caller_lease_body,
        now=_NOW,
        nonce="e" * 32,
    )
    caller_transaction_body = encode_deck_design_lift_invocation_body(_payload(transaction_id="transaction-caller-0001"))
    caller_transaction_headers = signed_deck_design_lift_invocation_headers(
        caller_transaction_body,
        now=_NOW,
        nonce="2" * 32,
    )
    valid_body = encode_deck_design_lift_invocation_body(_payload())

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        noncanonical_response = await client.post(
            DECK_DESIGN_LIFT_INVOCATION_PATH,
            content=noncanonical,
            headers=noncanonical_headers,
        )
        caller_lease_response = await client.post(
            DECK_DESIGN_LIFT_INVOCATION_PATH,
            content=caller_lease_body,
            headers=caller_lease_headers,
        )
        caller_transaction_response = await client.post(
            DECK_DESIGN_LIFT_INVOCATION_PATH,
            content=caller_transaction_body,
            headers=caller_transaction_headers,
        )
        for nonce in ("f" * 32, "1" * 32):
            valid_response = await client.post(
                DECK_DESIGN_LIFT_INVOCATION_PATH,
                content=valid_body,
                headers=signed_deck_design_lift_invocation_headers(
                    valid_body,
                    now=_NOW,
                    nonce=nonce,
                ),
            )
            assert valid_response.status_code == 200
            assert valid_response.json()["terminal_code"] == "no_repair_needed"

    assert noncanonical_response.status_code == 401
    assert caller_lease_response.status_code == 401
    assert caller_transaction_response.status_code == 401
    assert len(runtimes) == 2
    assert all(runtime.closed for runtime in runtimes)
    assert len(states) == 2
    first_owner = states[0]["lease_owner"]
    second_owner = states[1]["lease_owner"]
    assert isinstance(first_owner, str) and first_owner.startswith("dq2:")
    assert isinstance(second_owner, str) and second_owner.startswith("dq2:")
    assert first_owner != second_owner
    assert len(first_owner) <= 128
    assert all("transaction_id" not in state for state in states)
    assert "lease_owner" not in valid_response.json()
    assert _SECRET not in valid_response.text


@pytest.mark.anyio
async def test_http_route_rejects_non_allowlisted_runtime_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Runtime:
        closed = False

        async def aclose(self) -> None:
            self.closed = True

    runtime = _Runtime()

    async def unsafe_result(
        _runtime: _Runtime,
        state: dict[str, object],
    ) -> dict[str, object]:
        return {
            "campaign_run_id": state["campaign_run_id"],
            "experiment_id": state["experiment_id"],
            "build_id": state["build_id"],
            "operation_id": state["operation_id"],
            "transaction_id": None,
            "disposition": "NO_REPAIR_NEEDED",
            "terminal_code": "no_repair_needed",
            "initial_quality_run_id": "quality-initial-0001",
            "candidate_quality_run_id": None,
            "comparison_result": None,
            "comparison_reasons": [],
            "committed_manifest_revision": None,
            "lease_owner": "must-never-cross-the-wire",
        }

    monkeypatch.setattr(http_app_module, "_configured_runtime", lambda: runtime)
    monkeypatch.setattr(http_app_module, "run_deck_design_lift", unsafe_result)
    body = encode_deck_design_lift_invocation_body(_payload())
    headers = signed_deck_design_lift_invocation_headers(
        body,
        now=_NOW,
        nonce="3" * 32,
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            DECK_DESIGN_LIFT_INVOCATION_PATH,
            content=body,
            headers=headers,
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "deck_design_lift_runtime_failed"}
    assert "must-never-cross-the-wire" not in response.text
    assert runtime.closed is True
