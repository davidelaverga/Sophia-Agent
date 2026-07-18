from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import partial
from typing import Any, Protocol, TypedDict

import anyio
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict

from deerflow.sophia.deck_design_lift.runtime import (
    CorrelationId,
    DeckDesignLiftRequest,
    DeckDesignLiftResult,
)


class DeckDesignLiftGraphError(RuntimeError):
    """Content-free failure at the registered DQ-2 graph boundary."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class DeckDesignLiftGraphState(TypedDict, total=False):
    campaign_run_id: str
    experiment_id: str
    build_id: str
    user_id: str
    operation_id: str
    lease_owner: str
    transaction_id: str | None
    disposition: str
    terminal_code: str
    initial_quality_run_id: str | None
    candidate_quality_run_id: str | None
    comparison_result: str | None
    comparison_reasons: list[str]
    committed_manifest_revision: int | None


class _GraphEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    build_id: CorrelationId
    user_id: CorrelationId
    operation_id: CorrelationId
    lease_owner: CorrelationId
    transaction_id: CorrelationId | None = None


class DeckDesignLiftRequestFactory(Protocol):
    async def build_request(
        self,
        *,
        campaign_run_id: str,
        experiment_id: str,
        build_id: str,
        user_id: str,
        operation_id: str,
        lease_owner: str,
        transaction_id: str | None,
    ) -> DeckDesignLiftRequest: ...


class DeckDesignLiftController(Protocol):
    async def recover_incomplete(
        self,
        *,
        campaign_run_id: str,
        experiment_id: str,
        build_id: str,
        user_id: str,
        operation_id: str,
        lease_owner: str,
        lease_seconds: int,
        limit: int,
    ) -> str | None: ...

    async def run(self, request: DeckDesignLiftRequest) -> DeckDesignLiftResult: ...


@dataclass(frozen=True, slots=True)
class DeckDesignLiftGraphRuntime:
    controller: DeckDesignLiftController
    request_factory: DeckDesignLiftRequestFactory
    canary_user_ids: frozenset[str]
    timeout_seconds: int = 900
    recovery_limit: int = 50

    def __post_init__(self) -> None:
        if not self.canary_user_ids:
            raise ValueError("DQ-2 graph requires an exact canary user set")
        if not 300 <= self.timeout_seconds <= 1_200:
            raise ValueError("DQ-2 graph deadline is outside the locked campaign range")
        if not 1 <= self.recovery_limit <= 100:
            raise ValueError("DQ-2 graph recovery sweep limit is invalid")


def _envelope(state: DeckDesignLiftGraphState) -> _GraphEnvelope:
    fields = _GraphEnvelope.model_fields
    return _GraphEnvelope.model_validate({name: state.get(name) for name in fields if name in state})


def _validate_request_identity(
    envelope: _GraphEnvelope,
    request: DeckDesignLiftRequest,
    *,
    transaction_id: str | None,
) -> None:
    expected = (
        envelope.campaign_run_id,
        envelope.experiment_id,
        envelope.build_id,
        envelope.user_id,
        envelope.operation_id,
        envelope.lease_owner,
        transaction_id,
    )
    actual = (
        request.campaign_run_id,
        request.experiment_id,
        request.build_id,
        request.user_id,
        request.operation_id,
        request.lease_owner,
        request.transaction_id,
    )
    if actual != expected:
        raise DeckDesignLiftGraphError("request_identity_mismatch")


def _safe_result(result: DeckDesignLiftResult) -> DeckDesignLiftGraphState:
    comparison = result.comparison
    return {
        "campaign_run_id": result.campaign_run_id,
        "experiment_id": result.experiment_id,
        "build_id": result.build_id,
        "operation_id": result.operation_id,
        "transaction_id": result.transaction_id,
        "disposition": result.disposition,
        "terminal_code": result.terminal_code,
        "initial_quality_run_id": result.initial_quality_run_id,
        "candidate_quality_run_id": result.candidate_quality_run_id,
        "comparison_result": comparison.result if comparison is not None else None,
        "comparison_reasons": list(comparison.reasons) if comparison is not None else [],
        "committed_manifest_revision": result.committed_manifest_revision,
    }


async def run_deck_design_lift(
    runtime: DeckDesignLiftGraphRuntime,
    state: DeckDesignLiftGraphState,
) -> DeckDesignLiftGraphState:
    """Execute DQ-2 directly against its configured controller boundary."""

    try:
        envelope = _envelope(state)
    except Exception:
        raise DeckDesignLiftGraphError("invalid_campaign_envelope") from None
    if envelope.user_id not in runtime.canary_user_ids:
        raise DeckDesignLiftGraphError("canary_scope_mismatch")
    try:
        with anyio.fail_after(runtime.timeout_seconds):
            transaction_id = envelope.transaction_id
            if transaction_id is None:
                transaction_id = await runtime.controller.recover_incomplete(
                    campaign_run_id=envelope.campaign_run_id,
                    experiment_id=envelope.experiment_id,
                    build_id=envelope.build_id,
                    user_id=envelope.user_id,
                    operation_id=envelope.operation_id,
                    lease_owner=envelope.lease_owner,
                    lease_seconds=min(runtime.timeout_seconds, 900),
                    limit=runtime.recovery_limit,
                )
            request = await runtime.request_factory.build_request(
                campaign_run_id=envelope.campaign_run_id,
                experiment_id=envelope.experiment_id,
                build_id=envelope.build_id,
                user_id=envelope.user_id,
                operation_id=envelope.operation_id,
                lease_owner=envelope.lease_owner,
                transaction_id=transaction_id,
            )
            _validate_request_identity(
                envelope,
                request,
                transaction_id=transaction_id,
            )
            result = await runtime.controller.run(request)
    except TimeoutError:
        raise DeckDesignLiftGraphError("campaign_deadline_exceeded") from None
    except DeckDesignLiftGraphError:
        raise
    except Exception:
        raise DeckDesignLiftGraphError("campaign_runtime_failed") from None
    return _safe_result(result)


def compile_deck_design_lift_graph(runtime: DeckDesignLiftGraphRuntime) -> Any:
    builder = StateGraph(DeckDesignLiftGraphState)
    builder.add_node("run_design_lift", partial(run_deck_design_lift, runtime))
    builder.add_edge(START, "run_design_lift")
    builder.add_edge("run_design_lift", END)
    return builder.compile()


@asynccontextmanager
async def make_deck_design_lift_graph(config: RunnableConfig) -> AsyncIterator[Any]:
    """Yield one request-scoped graph and close every owning service client."""

    del config
    from deerflow.sophia.deck_design_lift.runner import configured_graph_runtime

    runtime = await anyio.to_thread.run_sync(configured_graph_runtime)
    try:
        yield compile_deck_design_lift_graph(runtime)
    finally:
        await runtime.aclose()


__all__ = [
    "DeckDesignLiftGraphError",
    "DeckDesignLiftGraphRuntime",
    "DeckDesignLiftGraphState",
    "DeckDesignLiftRequestFactory",
    "compile_deck_design_lift_graph",
    "make_deck_design_lift_graph",
    "run_deck_design_lift",
]
