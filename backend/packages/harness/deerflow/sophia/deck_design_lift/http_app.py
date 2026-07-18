"""Private authenticated HTTP entry point for the DQ-2 campaign runtime."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Annotated, Any, Literal

import anyio
from pydantic import BaseModel, ConfigDict, Field
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from deerflow.sophia.deck_design_lift.graph import (
    DeckDesignLiftGraphError,
    run_deck_design_lift,
)
from deerflow.sophia.deck_design_lift.invocation_auth import (
    DECK_DESIGN_LIFT_INVOCATION_PATH,
    MAX_DECK_DESIGN_LIFT_BODY_BYTES,
    DeckDesignLiftInvocationAuthenticationError,
    authenticate_deck_design_lift_invocation,
    encode_deck_design_lift_invocation_body,
)
from deerflow.sophia.deck_design_lift.runtime import (
    CorrelationId,
    RuntimeDisposition,
    RuntimeTerminalCode,
    new_dq2_lease_owner,
)


class _InvocationEnvelope(BaseModel):
    """Caller-controlled identifiers; lease authority is server-generated."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    build_id: CorrelationId
    user_id: CorrelationId
    operation_id: CorrelationId


_SafeReason = Annotated[
    str,
    Field(min_length=1, max_length=128, pattern=r"^[a-z][a-z0-9_]*$"),
]


class _SafeInvocationResult(BaseModel):
    """Exact content-free response allowlist for the private wire boundary."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    build_id: CorrelationId
    operation_id: CorrelationId
    transaction_id: CorrelationId | None
    disposition: RuntimeDisposition
    terminal_code: RuntimeTerminalCode
    initial_quality_run_id: CorrelationId | None
    candidate_quality_run_id: CorrelationId | None
    comparison_result: (
        Literal[
            "approved_improvement",
            "not_improved",
            "regressed",
            "incomparable",
        ]
        | None
    )
    comparison_reasons: tuple[_SafeReason, ...]
    committed_manifest_revision: int | None = Field(ge=1)


async def _bounded_body(request: Request) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_DECK_DESIGN_LIFT_BODY_BYTES:
            raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid")
    return bytes(body)


def _validated_canonical_payload(body: bytes) -> dict[str, Any]:
    try:
        raw = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid") from None
    if not isinstance(raw, Mapping):
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid")
    canonical = encode_deck_design_lift_invocation_body(raw)
    if canonical != body:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid")
    try:
        envelope = _InvocationEnvelope.model_validate(raw)
    except Exception:
        raise DeckDesignLiftInvocationAuthenticationError("deck_design_lift_body_invalid") from None
    payload = envelope.model_dump(mode="python")
    payload["lease_owner"] = new_dq2_lease_owner(envelope.operation_id)
    return payload


def _configured_runtime() -> Any:
    from deerflow.sophia.deck_design_lift.runner import configured_graph_runtime

    return configured_graph_runtime()


async def invoke_deck_design_lift(request: Request) -> Response:
    """Authenticate, validate, and execute exactly one content-free DQ-2 run."""

    try:
        body = await _bounded_body(request)
        authenticate_deck_design_lift_invocation(body, request.headers)
        payload = _validated_canonical_payload(body)
    except DeckDesignLiftInvocationAuthenticationError:
        return JSONResponse(
            {"detail": "deck_design_lift_request_rejected"},
            status_code=401,
        )

    runtime = None
    response: Response
    try:
        # Runtime composition creates sync HTTP/LangSmith clients and compiles
        # the locked instrument. Keep that bounded setup off the ASGI loop.
        runtime = await anyio.to_thread.run_sync(_configured_runtime)
        result = await run_deck_design_lift(runtime, payload)
        safe_result = _SafeInvocationResult.model_validate(result)
        response = JSONResponse(safe_result.model_dump(mode="json"), status_code=200)
    except DeckDesignLiftGraphError as exc:
        response = JSONResponse({"detail": exc.code}, status_code=409)
    except Exception:
        response = JSONResponse(
            {"detail": "deck_design_lift_runtime_failed"},
            status_code=500,
        )
    finally:
        if runtime is not None:
            try:
                await runtime.aclose()
            except Exception:
                response = JSONResponse(
                    {"detail": "deck_design_lift_runtime_failed"},
                    status_code=500,
                )
    return response


app = Starlette(
    routes=[
        Route(
            DECK_DESIGN_LIFT_INVOCATION_PATH,
            invoke_deck_design_lift,
            methods=["POST"],
            name="sophia_deck_design_lift_internal",
        )
    ]
)


__all__ = ["app", "invoke_deck_design_lift"]
