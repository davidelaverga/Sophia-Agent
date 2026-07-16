from __future__ import annotations

import os
from collections.abc import Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict
from urllib.parse import urlsplit

import anyio
from langgraph.graph import END, START, StateGraph
from langsmith import Client as LangSmithClient
from pydantic import BaseModel, ConfigDict, Field

from deerflow.config.app_config import get_app_config
from deerflow.sophia.deck_quality.graph import (
    DeckQualityGraphError,
    DeckQualityGraphRuntime,
    DeckQualityGraphTraceRetry,
    DeckQualityShadowGraphState,
    compile_deck_quality_shadow_graph,
    derive_terminal_failure_trace_payload_hash,
    emit_terminal_failure_trace,
    replay_prepared_completion_trace,
    safe_trace_root_input_for_record,
    serialize_safe_trace_root_input,
)
from deerflow.sophia.deck_quality.instrument import compile_runtime_instrument
from deerflow.sophia.deck_quality.persistence import (
    QualityRunErrorCode,
    QualityRunLease,
    QualityRunRecord,
    QualityRunTerminalState,
    configured_deck_quality_run_store,
)
from deerflow.sophia.deck_quality.tracing import (
    SafeQualityTrace,
    SafeQualityTraceRootInput,
)
from deerflow.sophia.observability import langsmith_tracing_disabled
from deerflow.sophia.storage.supabase_artifact_store import (
    SupabaseImmutableObjectStore,
)


class RestartableDeckQualityRunStore(Protocol):
    async def renew(
        self,
        lease: QualityRunLease,
        *,
        lease_seconds: int = 120,
    ) -> QualityRunRecord: ...

    async def retry(
        self,
        lease: QualityRunLease,
        *,
        error_code: Any,
        error_stage: str,
        delay_seconds: int = 30,
        max_attempts: int = 5,
    ) -> QualityRunRecord: ...

    async def prepare_failure_trace(
        self,
        lease: QualityRunLease,
        *,
        terminal_state: QualityRunTerminalState,
        error_code: QualityRunErrorCode,
        error_stage: str,
        terminal_trace_payload_hash: str,
        safe_trace_root_input: Mapping[str, object],
    ) -> QualityRunRecord: ...

    async def finish(self, lease: QualityRunLease, **kwargs: Any) -> QualityRunRecord: ...

    async def get(self, quality_run_id: str) -> QualityRunRecord | None: ...


class _DispatchEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    lease_owner: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
    lease_epoch: int = Field(ge=1)
    gateway_deployed_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    dispatch_preflight_error: Literal["scope_mismatch", "instrument_mismatch"] | None = None


class DeckQualityDispatchState(TypedDict, total=False):
    quality_run_id: str
    lease_owner: str
    lease_epoch: int
    gateway_deployed_sha: str
    dispatch_preflight_error: str | None
    state: str
    stage: str
    stage_rank: int
    decision_result: str | None
    error_code: str | None


class _ConfiguredSafeTraceFactory:
    """Own one non-batching LangSmith client with no implicit env fallback."""

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        project_name: str,
        workspace_id: str | None,
    ) -> None:
        try:
            self._client = LangSmithClient(
                api_url=endpoint,
                api_key=api_key,
                workspace_id=workspace_id,
                timeout_ms=15_000,
                auto_batch_tracing=False,
                omit_traced_runtime_info=True,
            )
        except Exception:
            raise RuntimeError("DQ-1 safe LangSmith client configuration is invalid") from None
        self._project_name = project_name

    def __call__(self, root_input: SafeQualityTraceRootInput) -> SafeQualityTrace:
        return SafeQualityTrace(
            root_input,
            client=self._client,
            project_name=self._project_name,
            flush_timeout_seconds=15.0,
        )

    def close(self) -> None:
        self._client.close()


def _required_dq1_langsmith_env(name: str) -> str:
    value = (os.getenv(name) or "").strip().strip('"').strip("'").strip()
    if not value:
        raise RuntimeError(f"DQ-1 safe tracing requires explicit {name}")
    return value


def _optional_dq1_langsmith_env(name: str) -> str | None:
    value = (os.getenv(name) or "").strip().strip('"').strip("'").strip()
    return value or None


def _configured_safe_trace_factory() -> _ConfiguredSafeTraceFactory:
    endpoint = _required_dq1_langsmith_env("LANGSMITH_ENDPOINT")
    parsed_endpoint = urlsplit(endpoint)
    if parsed_endpoint.scheme != "https" or not parsed_endpoint.netloc:
        raise RuntimeError("DQ-1 safe tracing requires an explicit HTTPS endpoint")
    return _ConfiguredSafeTraceFactory(
        endpoint=endpoint,
        api_key=_required_dq1_langsmith_env("LANGSMITH_API_KEY"),
        project_name=_required_dq1_langsmith_env("LANGSMITH_PROJECT"),
        workspace_id=_optional_dq1_langsmith_env("LANGSMITH_WORKSPACE_ID"),
    )


def _commit_sha(name: str, *, fallback: str | None = None) -> str:
    value = (os.getenv(name) or fallback or "").strip().lower()
    if len(value) != 40 or any(character not in "0123456789abcdef" for character in value):
        raise RuntimeError(f"DQ-1 requires exact deployed commit identity: {name}")
    return value


def configured_graph_runtime() -> DeckQualityGraphRuntime:
    config = get_app_config()
    if not config.deck_quality.enabled:
        raise RuntimeError("DQ-1 graph cannot start while deck quality is disabled")
    instrument = compile_runtime_instrument(config)
    store = configured_deck_quality_run_store()
    if store is None:
        raise RuntimeError("DQ-1 durable run storage is not configured")
    render_sha = (os.getenv("RENDER_GIT_COMMIT") or "").strip().lower()
    source_sha = _commit_sha("SOPHIA_SOURCE_COMMIT_SHA", fallback=render_sha)
    return DeckQualityGraphRuntime(
        instrument=instrument,
        store=store,
        objects=SupabaseImmutableObjectStore(),
        canary_user_ids=config.deck_quality.canary_user_ids,
        source_commit_sha=source_sha,
        gateway_deployed_sha=_commit_sha(
            "SOPHIA_GATEWAY_DEPLOYED_SHA",
            fallback=source_sha,
        ),
        langgraph_deployed_sha=_commit_sha(
            "SOPHIA_LANGGRAPH_DEPLOYED_SHA",
            fallback=source_sha,
        ),
        trace_factory=_configured_safe_trace_factory(),
        materialization_root=Path(os.getenv("SOPHIA_DECK_QUALITY_MATERIALIZATION_ROOT") or "/tmp/deerflow-dq1"),
        lease_seconds=min(
            config.deck_quality.max_quality_wall_clock_seconds + 120,
            900,
        ),
        timeout_seconds=config.deck_quality.max_quality_wall_clock_seconds,
        max_quality_calls=config.deck_quality.max_quality_calls,
        max_quality_cost_usd=config.deck_quality.max_quality_cost_usd or Decimal("0.60"),
    )


def initial_graph_state(
    record: QualityRunRecord,
    *,
    gateway_deployed_sha: str,
) -> DeckQualityShadowGraphState:
    """Construct the content-free graph input from one claimed durable row."""

    lease = QualityRunLease.from_record(record)
    return {
        "campaign_id": record.campaign_id,
        "quality_run_id": record.quality_run_id,
        "build_id": record.build_id,
        "user_id": record.user_id,
        "task_id": record.task_id or "missing-task",
        "builder_run_id": record.builder_run_id or "missing-builder-run",
        "parent_builder_trace_id": record.parent_builder_trace_id or "missing-builder-trace",
        "logical_artifact_id": record.logical_artifact_id,
        "artifact_version_id": record.artifact_version_id,
        "manifest_revision": record.manifest_revision,
        "lease_owner": lease.owner,
        "lease_epoch": lease.epoch,
        "gateway_deployed_sha": gateway_deployed_sha,
        "stage": record.stage.value,
        "stage_rank": record.stage_rank,
        "stage_artifact_hashes": dict(record.stage_artifact_hashes),
        "safe_metrics": dict(record.safe_metrics),
        "trace_ids": dict(record.trace_ids),
    }


class DeckQualityShadowRunner:
    """Run or resume one claimed row; only durable stage artifacts own progress."""

    def __init__(
        self,
        runtime: DeckQualityGraphRuntime,
        *,
        retry_delay_seconds: int = 30,
        max_attempts: int = 5,
    ) -> None:
        if not 0 <= retry_delay_seconds <= 86_400:
            raise ValueError("retry delay is invalid")
        if not 1 <= max_attempts <= 100:
            raise ValueError("maximum attempts are invalid")
        self._runtime = runtime
        self._store = runtime.store
        self._graph = compile_deck_quality_shadow_graph(runtime)
        self._retry_delay_seconds = retry_delay_seconds
        self._max_attempts = max_attempts

    async def aclose(self) -> None:
        """Close the owned durable client from the gateway lifespan."""

        try:
            close = getattr(self._store, "aclose", None)
            if close is not None:
                await close()
        finally:
            trace_close = getattr(self._runtime.trace_factory, "close", None)
            if trace_close is not None:
                trace_close()

    async def run(self, record: QualityRunRecord) -> QualityRunRecord:
        pending_terminal_state = getattr(
            record,
            "pending_terminal_state",
            None,
        )
        if record.state == "finalizing" and pending_terminal_state is not None:
            # A terminal precursor owns a separate, bounded trace-only grace
            # lease. It must never re-enter the evidence/judge graph, and an
            # expired grace window cannot be extended process-locally.
            if self._runtime.clock() >= record.trace_deadline_at:
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="failure_trace_lease",
                    retryable=True,
                ) from None
            if record.last_error_code is None or record.last_error_stage is None:
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="failure_trace_precursor",
                    retryable=True,
                ) from None
            return await self._handle_error(
                record,
                DeckQualityGraphError(
                    record.last_error_code,
                    stage=record.last_error_stage,
                    retryable=False,
                ),
            )
        if (
            record.state == "finalizing"
            and pending_terminal_state is None
            and record.decision_result is not None
        ):
            if self._runtime.clock() >= record.trace_deadline_at:
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="success_trace_lease",
                    retryable=True,
                ) from None
            state = initial_graph_state(
                record,
                gateway_deployed_sha=self._runtime.gateway_deployed_sha,
            )
            remaining = max(
                0.0,
                (record.trace_deadline_at - self._runtime.clock()).total_seconds(),
            )
            try:
                with langsmith_tracing_disabled():
                    with anyio.fail_after(remaining):
                        return await replay_prepared_completion_trace(
                            self._runtime,
                            state,
                            record,
                        )
            except DeckQualityGraphError as error:
                return await self._handle_error(record, error)
            except TimeoutError:
                return await self._handle_error(
                    record,
                    DeckQualityGraphError(
                        QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                        stage="success_trace_lease",
                        retryable=True,
                    ),
                )
            except Exception:
                return await self._handle_error(
                    record,
                    DeckQualityGraphError(
                        QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                        stage="success_trace_replay",
                        retryable=True,
                    ),
                )
        state = initial_graph_state(
            record,
            gateway_deployed_sha=self._runtime.gateway_deployed_sha,
        )
        started_at = record.started_at or record.requested_at
        elapsed = max(
            0.0,
            (self._runtime.clock() - started_at).total_seconds(),
        )
        remaining = self._runtime.timeout_seconds - elapsed
        if remaining <= 0:
            return await self._handle_error(
                record,
                DeckQualityGraphError(
                    QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
                    stage="wall_clock",
                    retryable=False,
                ),
            )
        try:
            # LangGraph nodes manipulate raw rendered/plan evidence internally.
            # Suppress every ambient/global tracing surface for the whole inner
            # graph, including exception recording. The graph emits only its
            # explicit hash/count-only trace through a dedicated client.
            with langsmith_tracing_disabled():
                with anyio.fail_after(remaining):
                    await self._graph.ainvoke(
                        state,
                        config={
                            "callbacks": [],
                            "tags": ["dq1_safe_graph"],
                            "metadata": {
                                "campaign_id": record.campaign_id,
                                "quality_run_id": record.quality_run_id,
                                "artifact_version_id": record.artifact_version_id,
                            },
                        },
                    )
            get = getattr(self._store, "get", None)
            if get is None:
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="runner_terminal_read",
                    retryable=True,
                )
            finished = await get(record.quality_run_id)
            if finished is None or finished.state != "completed":
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="runner_terminal_read",
                    retryable=True,
                )
            return finished
        except DeckQualityGraphError as error:
            return await self._handle_error(record, error)
        except TimeoutError:
            return await self._handle_error(
                record,
                DeckQualityGraphError(
                    QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
                    stage="wall_clock",
                    retryable=False,
                ),
            )
        except Exception:
            return await self._handle_error(
                record,
                DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="runner_unexpected",
                    retryable=True,
                ),
            )

    async def _handle_error(
        self,
        record: QualityRunRecord,
        error: DeckQualityGraphError,
    ) -> QualityRunRecord:
        try:
            latest = await self._store.renew(
                QualityRunLease.from_record(record),
                lease_seconds=self._runtime.lease_seconds,
            )
        except Exception:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="failure_trace_lease",
                retryable=True,
            ) from None
        lease = QualityRunLease.from_record(latest)
        prepared_success = (
            latest.state == "finalizing"
            and latest.pending_terminal_state is None
            and latest.decision_result is not None
        )
        if error.retryable and (
            prepared_success or latest.attempt_count < self._max_attempts
        ):
            retry = getattr(self._store, "retry", None)
            if retry is None:
                raise error from None
            try:
                return await retry(
                    lease,
                    error_code=error.code,
                    error_stage=error.stage,
                    delay_seconds=self._retry_delay_seconds,
                    max_attempts=self._max_attempts,
                )
            except Exception:
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="failure_retry",
                    retryable=True,
                ) from None

        terminal_error = error
        terminal_precursor = latest.state == "finalizing" and getattr(latest, "pending_terminal_state", None) is not None
        if terminal_precursor:
            if latest.last_error_code is None or latest.last_error_stage is None:
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="failure_trace_precursor",
                    retryable=True,
                ) from None
            terminal_error = DeckQualityGraphError(
                latest.last_error_code,
                stage=latest.last_error_stage,
                retryable=False,
            )
        elif (
            not prepared_success
            and self._runtime.clock() >= latest.run_deadline_at
        ):
            terminal_error = DeckQualityGraphError(
                QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
                stage="run_deadline",
                retryable=False,
            )
        elif error.retryable and latest.attempt_count >= self._max_attempts:
            terminal_error = DeckQualityGraphError(
                QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED,
                stage="attempt_limit",
                retryable=False,
            )
        terminal = QualityRunTerminalState(latest.pending_terminal_state) if terminal_precursor else (QualityRunTerminalState.STALE if terminal_error.code is QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE else QualityRunTerminalState.FAILED)
        root_input = safe_trace_root_input_for_record(self._runtime, latest)
        root_payload = serialize_safe_trace_root_input(root_input)
        terminal_trace_payload_hash = derive_terminal_failure_trace_payload_hash(
            latest,
            root_input=root_input,
            error=terminal_error,
            terminal_state=terminal,
        )
        prepare_failure_trace = getattr(
            self._store,
            "prepare_failure_trace",
            None,
        )
        if prepare_failure_trace is None:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="failure_trace_prepare",
                retryable=True,
            ) from None
        try:
            prepared = await prepare_failure_trace(
                lease,
                terminal_state=terminal,
                error_code=terminal_error.code,
                error_stage=terminal_error.stage,
                terminal_trace_payload_hash=terminal_trace_payload_hash,
                safe_trace_root_input=root_payload,
            )
        except Exception:
            try:
                prepared = await self._store.get(latest.quality_run_id)
            except Exception:
                prepared = None
        prepared_root_input = safe_trace_root_input_for_record(self._runtime, prepared) if prepared is not None else None
        if (
            prepared is None
            or prepared.state != "finalizing"
            or prepared.pending_terminal_state != terminal.value
            or prepared.last_error_code is not terminal_error.code
            or prepared.last_error_stage != terminal_error.stage
            or prepared.terminal_trace_payload_hash != terminal_trace_payload_hash
            or prepared_root_input != root_input
        ):
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="failure_trace_prepare",
                retryable=True,
            ) from None
        latest = prepared
        lease = QualityRunLease.from_record(latest)
        failure_state = initial_graph_state(
            latest,
            gateway_deployed_sha=self._runtime.gateway_deployed_sha,
        )
        try:
            trace_ids = await emit_terminal_failure_trace(
                self._runtime,
                failure_state,
                latest,
                error=terminal_error,
                terminal_state=terminal,
            )
        except DeckQualityGraphTraceRetry:
            retry = getattr(self._store, "retry", None)
            if retry is None:
                raise DeckQualityGraphTraceRetry() from None
            try:
                return await retry(
                    lease,
                    # Preserve a terminal precursor across a lost trace ACK.
                    # Replacing it with a generic persistence error would make
                    # a reclaimed finalizing row re-enter the raw graph.
                    error_code=terminal_error.code,
                    error_stage=terminal_error.stage,
                    delay_seconds=self._retry_delay_seconds,
                    max_attempts=self._max_attempts,
                )
            except Exception:
                raise DeckQualityGraphTraceRetry() from None

        try:
            finished = await self._store.finish(
                lease,
                terminal_state=terminal,
                error_code=terminal_error.code,
                error_stage=terminal_error.stage,
                stage_artifact_hashes=latest.stage_artifact_hashes,
                safe_metrics=latest.safe_metrics,
                trace_ids=trace_ids,
                terminal_trace_payload_hash=terminal_trace_payload_hash,
            )
        except Exception:
            try:
                finished = await self._store.get(latest.quality_run_id)
            except Exception:
                finished = None
            if finished is None:
                raise DeckQualityGraphError(
                    QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                    stage="failure_terminal_write",
                    retryable=True,
                ) from None
        if (
            finished.state != terminal.value
            or finished.last_error_code is not terminal_error.code
            or finished.pending_terminal_state != terminal.value
            or finished.terminal_trace_payload_hash != terminal_trace_payload_hash
            or any(finished.trace_ids.get(key) != value for key, value in trace_ids.items())
        ):
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="failure_terminal_read",
                retryable=True,
            ) from None
        return finished

    async def dispatch(
        self,
        payload: DeckQualityDispatchState,
    ) -> DeckQualityDispatchState:
        """Guard the registered four-field gateway contract end to end."""

        try:
            envelope = _DispatchEnvelope.model_validate(payload)
        except Exception:
            raise DeckQualityGraphError(
                QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
                stage="shadow_dispatch",
                retryable=False,
            ) from None
        lease = QualityRunLease(
            quality_run_id=envelope.quality_run_id,
            owner=envelope.lease_owner,
            epoch=envelope.lease_epoch,
        )
        try:
            record = await self._store.renew(
                lease,
                lease_seconds=self._runtime.lease_seconds,
            )
        except Exception:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="shadow_dispatch",
                retryable=True,
            ) from None
        if envelope.dispatch_preflight_error is not None:
            record = await self._handle_error(
                record,
                DeckQualityGraphError(
                    QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
                    stage="shadow_dispatch",
                    retryable=False,
                ),
            )
        elif envelope.gateway_deployed_sha != self._runtime.gateway_deployed_sha:
            record = await self._handle_error(
                record,
                DeckQualityGraphError(
                    QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
                    stage="shadow_dispatch",
                    retryable=False,
                ),
            )
        else:
            record = await self.run(record)
        return {
            "quality_run_id": record.quality_run_id,
            "lease_owner": envelope.lease_owner,
            "lease_epoch": envelope.lease_epoch,
            "gateway_deployed_sha": envelope.gateway_deployed_sha,
            "dispatch_preflight_error": envelope.dispatch_preflight_error,
            "state": record.state,
            "stage": record.stage.value,
            "stage_rank": record.stage_rank,
            "decision_result": (record.decision_result.value if record.decision_result else None),
            "error_code": (record.last_error_code.value if record.last_error_code else None),
        }


def compile_registered_deck_quality_shadow_graph(
    runtime: DeckQualityGraphRuntime,
) -> Any:
    """Registered wrapper that always persists retry or terminal failures."""

    runner = DeckQualityShadowRunner(runtime)
    builder = StateGraph(DeckQualityDispatchState)
    builder.add_node("guarded_shadow_run", runner.dispatch)
    builder.add_edge(START, "guarded_shadow_run")
    builder.add_edge("guarded_shadow_run", END)
    return builder.compile()


__all__ = [
    "DeckQualityShadowRunner",
    "compile_registered_deck_quality_shadow_graph",
    "configured_graph_runtime",
    "initial_graph_state",
]
