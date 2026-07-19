"""Durable, canary-only dispatcher for DQ-1 shadow quality runs.

The gateway owns no quality evidence and no judge credentials. It claims a
safe metadata-only Supabase outbox row and starts the separately registered
LangGraph graph. The graph owns lease renewal, evidence access, model calls,
stage persistence, and terminal completion.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
import re
import socket
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.persistence import (
    QualityRunErrorCode,
    QualityRunLease,
    QualityRunRecord,
    QualityRunTerminalState,
    SupabaseDeckQualityRunStore,
    configured_deck_quality_run_store,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock

logger = logging.getLogger(__name__)

_QUALITY_GRAPH_ID = "sophia_deck_quality_shadow"
_QUALITY_THREAD_ID_PREFIX = (
    "https://sophia-ei.com/ids/langgraph-thread/"
    f"{_QUALITY_GRAPH_ID}/v1/"
)
_RECONCILIATION_RUN_LIMIT = 100
_RECONCILIATION_ATTEMPTS = 4
_RECONCILIATION_INTERVAL_SECONDS = 0.2
_RECONCILIATION_TIMEOUT_SECONDS = 2.0
_IDEMPOTENT_PRELAUNCH_ATTEMPTS = 2
_WORKER_STOP_TIMEOUT_SECONDS = 5.0
_SHA40 = re.compile(r"^[0-9a-f]{40}$")
_CLAIM_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_WORKER_ATTR = "_deck_quality_dispatcher"
DispatchPreflightError = Literal["scope_mismatch", "instrument_mismatch"]


class DeckQualityDispatchStore(Protocol):
    async def claim(
        self,
        *,
        lease_owner: str,
        claim_token: str,
        lease_seconds: int = 120,
        limit: int = 1,
    ) -> tuple[QualityRunRecord, ...]: ...

    async def retry(
        self,
        lease: QualityRunLease,
        *,
        error_code: QualityRunErrorCode,
        error_stage: str,
        delay_seconds: int = 30,
        max_attempts: int = 5,
    ) -> QualityRunRecord: ...

    async def get(self, quality_run_id: str) -> QualityRunRecord | None: ...

    async def begin_dispatch(
        self,
        lease: QualityRunLease,
        *,
        intent_token: str,
    ) -> QualityRunRecord: ...

    async def resolve_dispatch(
        self,
        *,
        quality_run_id: str,
        intent_token: str,
        status: Literal["unresolved", "confirmed", "reconciled"],
    ) -> QualityRunRecord: ...

    async def unresolved_dispatches(self, *, limit: int = 100) -> tuple[str, ...]: ...

    async def recover_expired_finalizing(self, *, limit: int = 100) -> int: ...

    async def finish(
        self,
        lease: QualityRunLease,
        *,
        terminal_state: QualityRunTerminalState,
        decision_result: object | None = None,
        decision_failure_codes: tuple[str, ...] = (),
        decision_weighted_score: float | None = None,
        error_code: QualityRunErrorCode | None = None,
        error_stage: str | None = None,
        safe_metrics: dict[str, object] | None = None,
        trace_ids: dict[str, object] | None = None,
        stage_artifact_hashes: dict[str, object] | None = None,
    ) -> QualityRunRecord: ...


@dataclass(frozen=True)
class DispatchCycleResult:
    claimed: int = 0
    dispatched: int = 0
    reconciled: int = 0
    rejected: int = 0
    retry_scheduled: int = 0
    ambiguous: int = 0
    launch_fenced: int = 0

    @property
    def degraded(self) -> bool:
        return any(
            (
                self.rejected,
                self.retry_scheduled,
                self.ambiguous,
                self.launch_fenced,
            )
        )

    def safe_counts(self) -> dict[str, int]:
        return {
            "claimed": self.claimed,
            "dispatched": self.dispatched,
            "reconciled": self.reconciled,
            "rejected": self.rejected,
            "retry_scheduled": self.retry_scheduled,
            "ambiguous": self.ambiguous,
            "launch_fenced": self.launch_fenced,
        }


@dataclass(frozen=True)
class _UnresolvedDispatchOutcome:
    ambiguous: bool = False
    rejected: bool = False
    retry_scheduled: bool = False
    launch_fenced: bool = False

    def merged(
        self,
        *,
        ambiguous: bool = False,
        rejected: bool = False,
        retry_scheduled: bool = False,
        launch_fenced: bool = False,
    ) -> _UnresolvedDispatchOutcome:
        return _UnresolvedDispatchOutcome(
            ambiguous=self.ambiguous or ambiguous,
            rejected=self.rejected or rejected,
            retry_scheduled=self.retry_scheduled or retry_scheduled,
            launch_fenced=self.launch_fenced or launch_fenced,
        )


@dataclass(frozen=True)
class _DispatchOutcome:
    status: Literal["dispatched", "reconciled", "ambiguous"]
    error_stage: str | None = None
    launch_fenced: bool = False
    schedule_retry: bool = True


def _gateway_sha_from_env() -> str | None:
    for key in ("RENDER_GIT_COMMIT", "RENDER_GIT_COMMIT_SHA", "GIT_COMMIT_SHA", "SOURCE_COMMIT"):
        value = (os.getenv(key) or "").strip().lower()
        if _SHA40.fullmatch(value):
            return value
    return None


def _default_owner() -> str:
    host = re.sub(r"[^A-Za-z0-9_.:-]", "-", socket.gethostname())[:72] or "gateway"
    return f"dq1-gateway:{host}:{os.getpid()}"


def _default_claim_token() -> str:
    return f"dq1-quality-claim:{uuid.uuid4().hex}"


def _quality_thread_id(quality_run_id: str) -> str:
    """Map the semantic DQ-1 identity to LangGraph's UUID thread contract."""

    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"{_QUALITY_THREAD_ID_PREFIX}{quality_run_id}",
        )
    )


def _dispatch_metadata(
    record: QualityRunRecord,
    lease: QualityRunLease,
    *,
    intent_token: str,
    preflight_error: DispatchPreflightError | None = None,
) -> dict[str, Any]:
    metadata = {
        "dq1_quality_run_id": record.quality_run_id,
        "dq1_dispatch_fence": canonical_sha256(
            {
                "graph_id": _QUALITY_GRAPH_ID,
                "quality_run_id": record.quality_run_id,
                "schema_version": "dq1-dispatch-fence/v1",
            }
        ),
        "dq1_dispatch_intent_token": intent_token,
        "dq1_lease_owner": lease.owner,
        "dq1_lease_epoch": lease.epoch,
    }
    if preflight_error is not None:
        metadata["dq1_dispatch_preflight_error"] = preflight_error
    return metadata


def _dispatch_intent_token(
    record: QualityRunRecord,
    lease: QualityRunLease,
    *,
    preflight_error: DispatchPreflightError | None,
) -> str:
    return "dq1-dispatch:" + canonical_sha256(
        {
            "claim_hash": record.claim_hash,
            "claim_token": record.claim_token,
            "lease_epoch": lease.epoch,
            "lease_owner": lease.owner,
            "preflight_error": preflight_error,
            "quality_run_id": record.quality_run_id,
            "schema_version": "dq1-dispatch-intent/v1",
        }
    )


class DeckQualityDispatcher:
    """Lease and dispatch DQ-1 rows without handling model-facing content."""

    def __init__(
        self,
        *,
        config: DeckQualityConfig,
        instrument: QualityInstrumentLock,
        store: DeckQualityDispatchStore,
        langgraph_url: str,
        gateway_deployed_sha: str,
        lease_owner: str | None = None,
        lease_seconds: int = 600,
        claim_limit: int = 2,
        poll_seconds: float = 5.0,
        claim_token_factory: Callable[[], str] = _default_claim_token,
        client: Any | None = None,
    ) -> None:
        if not config.enabled or config.mode != "shadow":
            raise ValueError("deck quality dispatcher requires enabled shadow configuration")
        if _SHA40.fullmatch(gateway_deployed_sha) is None:
            raise ValueError("deck quality dispatcher requires the deployed gateway Git SHA")
        if not 15 <= lease_seconds <= 900:
            raise ValueError("deck quality dispatcher lease duration is invalid")
        if not 1 <= claim_limit <= 2 or poll_seconds <= 0:
            raise ValueError("deck quality dispatcher polling configuration is invalid")
        self._config = config
        self._instrument_hash = canonical_sha256(instrument)
        self._store = store
        self._langgraph_url = langgraph_url.rstrip("/")
        self._gateway_deployed_sha = gateway_deployed_sha
        self._lease_owner = lease_owner or _default_owner()
        self._lease_seconds = lease_seconds
        self._claim_limit = claim_limit
        self._poll_seconds = poll_seconds
        self._claim_token_factory = claim_token_factory
        self._last_claim_token: str | None = None
        self._client = client
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._last_cycle_success_at: datetime | None = None
        self._last_cycle_error_type: str | None = None
        self._consecutive_cycle_errors = 0
        self._last_degraded_cycle_counts: dict[str, int] | None = None
        self._unresolved_outcomes: dict[str, _UnresolvedDispatchOutcome] = {}

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def _unresolved_counts(self) -> dict[str, int]:
        outcomes = tuple(self._unresolved_outcomes.values())
        return {
            "unresolved": len(outcomes),
            "ambiguous": sum(outcome.ambiguous for outcome in outcomes),
            "retry_scheduled": sum(
                outcome.retry_scheduled for outcome in outcomes
            ),
            "rejected": sum(outcome.rejected for outcome in outcomes),
            "launch_fenced": sum(
                outcome.launch_fenced for outcome in outcomes
            ),
        }

    def readiness(self) -> dict[str, object]:
        """Return safe live dispatch health for gateway readiness."""

        if not self.running:
            return {"status": "degraded", "reason": "worker_not_running"}
        unresolved_counts = self._unresolved_counts()
        if self._consecutive_cycle_errors > 0:
            result: dict[str, object] = {
                "status": "degraded",
                "reason": "cycle_failed",
                "error_type": self._last_cycle_error_type or "RuntimeError",
            }
            if unresolved_counts["unresolved"] > 0:
                result["counts"] = unresolved_counts
            return result
        if unresolved_counts["unresolved"] > 0:
            return {
                "status": "degraded",
                "reason": "dispatch_outcomes_unresolved",
                "counts": unresolved_counts,
            }
        if self._last_degraded_cycle_counts is not None:
            return {
                "status": "degraded",
                "reason": "cycle_outcome_degraded",
                "counts": dict(self._last_degraded_cycle_counts),
            }
        if self._last_cycle_success_at is None:
            if self._last_cycle_error_type is not None:
                return {
                    "status": "degraded",
                    "reason": "cycle_failed",
                    "error_type": self._last_cycle_error_type,
                }
            return {"status": "starting", "reason": "awaiting_first_cycle"}
        if (
            datetime.now(UTC) - self._last_cycle_success_at
        ).total_seconds() > max(30.0, self._poll_seconds * 4):
            return {"status": "degraded", "reason": "heartbeat_stale"}
        return {
            "status": "ready",
            "last_success_at": self._last_cycle_success_at.isoformat(),
        }

    async def probe(self) -> None:
        """Fail startup closed when the service-role RPC surface is absent."""

        probe = getattr(self._store, "probe", None)
        if probe is None:
            raise RuntimeError("deck quality persistence store is not probeable")
        await self._call_maybe_async(probe)

    @staticmethod
    async def _call_maybe_async(
        method: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        if inspect.iscoroutinefunction(method):
            return await method(*args, **kwargs)
        # Production stores and the LangGraph SDK expose native async methods.
        # Sync callables are supported only for deterministic test doubles and
        # must never block the gateway event loop.
        result = await asyncio.to_thread(method, *args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    async def _store_call(
        self,
        method_name: str,
        *args: object,
        **kwargs: object,
    ) -> object:
        method = getattr(self._store, method_name, None)
        if not callable(method):
            raise RuntimeError(
                f"deck quality persistence store cannot {method_name}"
            )
        return await self._call_maybe_async(method, *args, **kwargs)

    async def _client_call(
        self,
        resource: object,
        method_name: str,
        *args: object,
        **kwargs: object,
    ) -> object:
        method = getattr(resource, method_name, None)
        if not callable(method):
            raise RuntimeError(f"deck quality client cannot {method_name}")
        return await self._call_maybe_async(method, *args, **kwargs)

    def _get_client(self) -> Any:
        if self._client is None:
            from langgraph_sdk import get_client

            self._client = get_client(url=self._langgraph_url)
        return self._client

    def _next_claim_token(self) -> str:
        token = self._claim_token_factory()
        if _CLAIM_TOKEN.fullmatch(token) is None or token == self._last_claim_token:
            raise RuntimeError("deck quality dispatcher claim token factory is invalid")
        self._last_claim_token = token
        return token

    async def _claim(self, claim_token: str) -> tuple[QualityRunRecord, ...]:
        arguments = {
            "lease_owner": self._lease_owner,
            "claim_token": claim_token,
            "lease_seconds": self._lease_seconds,
            "limit": self._claim_limit,
        }
        try:
            result = await self._store_call("claim", **arguments)
        except Exception:  # noqa: BLE001 - the durable receipt makes one ambiguous replay safe.
            result = await self._store_call("claim", **arguments)
        if not isinstance(result, tuple) or any(
            not isinstance(record, QualityRunRecord) for record in result
        ):
            raise RuntimeError("deck quality dispatcher claim returned invalid records")
        return result

    async def _matching_dispatch_exists(
        self,
        record: QualityRunRecord,
        lease: QualityRunLease,
        *,
        intent_token: str,
        preflight_error: DispatchPreflightError | None = None,
        same_epoch: bool = True,
    ) -> bool | None:
        try:
            runs = await self._client_call(
                self._get_client().runs,
                "list",
                _quality_thread_id(record.quality_run_id),
                limit=_RECONCILIATION_RUN_LIMIT,
                select=["metadata"],
            )
        except Exception:  # noqa: BLE001 - ambiguous state is handled without relaunching.
            return None
        full_metadata = _dispatch_metadata(
            record,
            lease,
            intent_token=intent_token,
            preflight_error=preflight_error,
        )
        expected = (
            full_metadata
            if same_epoch
            else {
                "dq1_quality_run_id": full_metadata["dq1_quality_run_id"],
                "dq1_dispatch_fence": full_metadata["dq1_dispatch_fence"],
                "dq1_dispatch_intent_token": intent_token,
            }
        )
        for run in runs:
            metadata = run.get("metadata") if isinstance(run, dict) else getattr(run, "metadata", None)
            if (
                isinstance(metadata, dict)
                and all(
                    metadata.get(key) == value
                    for key, value in expected.items()
                )
                and (
                    not same_epoch
                    or metadata.get("dq1_dispatch_preflight_error")
                    == preflight_error
                )
            ):
                return True
        return False

    async def _bounded_matching_dispatch_exists(
        self,
        record: QualityRunRecord,
        lease: QualityRunLease,
        *,
        intent_token: str,
        preflight_error: DispatchPreflightError | None,
        same_epoch: bool,
    ) -> bool:
        try:
            async with asyncio.timeout(_RECONCILIATION_TIMEOUT_SECONDS):
                for attempt in range(_RECONCILIATION_ATTEMPTS):
                    if await self._matching_dispatch_exists(
                        record,
                        lease,
                        intent_token=intent_token,
                        preflight_error=preflight_error,
                        same_epoch=same_epoch,
                    ) is True:
                        return True
                    if attempt + 1 < _RECONCILIATION_ATTEMPTS:
                        await asyncio.sleep(
                            _RECONCILIATION_INTERVAL_SECONDS
                        )
        except TimeoutError:
            return False
        return False

    async def _resolve_dispatch_intent(
        self,
        record: QualityRunRecord,
        *,
        intent_token: str,
        status: Literal["unresolved", "confirmed", "reconciled"],
    ) -> bool:
        for _attempt in range(2):
            try:
                resolved = await self._store_call(
                    "resolve_dispatch",
                    quality_run_id=record.quality_run_id,
                    intent_token=intent_token,
                    status=status,
                )
            except Exception:  # noqa: BLE001 - exact-token replay is idempotent.
                continue
            if not isinstance(resolved, QualityRunRecord):
                return False
            if resolved.dispatch_intent_token != intent_token:
                return False
            if status == "confirmed":
                return resolved.dispatch_intent_status in {
                    "confirmed",
                    "reconciled",
                }
            if status == "reconciled":
                return resolved.dispatch_intent_status == "reconciled"
            return resolved.dispatch_intent_status in {
                "unresolved",
                "reconciled",
            }
        return False

    async def _dispatch(
        self,
        record: QualityRunRecord,
        lease: QualityRunLease,
        *,
        intent_token: str,
        preflight_error: DispatchPreflightError | None = None,
    ) -> _DispatchOutcome:
        client = self._get_client()
        metadata = _dispatch_metadata(
            record,
            lease,
            intent_token=intent_token,
            preflight_error=preflight_error,
        )
        safe_input = {
            "quality_run_id": record.quality_run_id,
            "lease_owner": lease.owner,
            "lease_epoch": lease.epoch,
            "gateway_deployed_sha": self._gateway_deployed_sha,
        }
        if preflight_error is not None:
            safe_input["dispatch_preflight_error"] = preflight_error
        thread_ready = False
        for _attempt in range(_IDEMPOTENT_PRELAUNCH_ATTEMPTS):
            try:
                # This operation is exactly idempotent: the deterministic
                # thread ID plus ``if_exists=do_nothing`` makes a response-loss
                # replay incapable of creating a run or duplicating delivery.
                await self._client_call(
                    client.threads,
                    "create",
                    thread_id=_quality_thread_id(record.quality_run_id),
                    if_exists="do_nothing",
                    graph_id=_QUALITY_GRAPH_ID,
                )
            except Exception:  # noqa: BLE001 - exact replay is safe.
                continue
            thread_ready = True
            break
        if not thread_ready:
            if await self._bounded_matching_dispatch_exists(
                record,
                lease,
                intent_token=intent_token,
                preflight_error=preflight_error,
                same_epoch=True,
            ):
                await self._resolve_dispatch_intent(
                    record,
                    intent_token=intent_token,
                    status="reconciled",
                )
                return _DispatchOutcome(
                    "reconciled",
                    launch_fenced=True,
                )
            await self._resolve_dispatch_intent(
                record,
                intent_token=intent_token,
                status="unresolved",
            )
            return _DispatchOutcome(
                "ambiguous",
                error_stage="shadow_dispatch_prelaunch",
                launch_fenced=True,
            )
        try:
            await self._client_call(
                client.runs,
                "create",
                _quality_thread_id(record.quality_run_id),
                _QUALITY_GRAPH_ID,
                input=safe_input,
                context=safe_input,
                metadata=metadata,
                multitask_strategy="enqueue",
                durability="sync",
            )
            if await self._resolve_dispatch_intent(
                record,
                intent_token=intent_token,
                status="confirmed",
            ):
                return _DispatchOutcome("dispatched")
            return _DispatchOutcome(
                "ambiguous",
                error_stage="shadow_dispatch_resolution",
                launch_fenced=True,
                schedule_retry=False,
            )
        except Exception:  # noqa: BLE001 - every create failure is ambiguous until reconciled.
            existing = await self._bounded_matching_dispatch_exists(
                record,
                lease,
                intent_token=intent_token,
                preflight_error=preflight_error,
                same_epoch=True,
            )
            if existing:
                await self._resolve_dispatch_intent(
                    record,
                    intent_token=intent_token,
                    status="reconciled",
                )
                return _DispatchOutcome(
                    "reconciled",
                    launch_fenced=True,
                )
            # An empty or failed list is not proof that the create did not
            # commit: list visibility may lag the create response. Never issue
            # a second create from this invocation. The caller records the
            # causal dispatch failure through the durable retry transition;
            # any late old-epoch run then fails its lease fence.
            await self._resolve_dispatch_intent(
                record,
                intent_token=intent_token,
                status="unresolved",
            )
            return _DispatchOutcome(
                "ambiguous",
                error_stage="shadow_dispatch_launch",
                launch_fenced=True,
            )

    async def _reconcile_fenced_launch(
        self,
        record: QualityRunRecord,
        lease: QualityRunLease,
        *,
        intent_token: str,
        preflight_error: DispatchPreflightError | None,
    ) -> _DispatchOutcome:
        """Reconcile later epochs without issuing another physical run."""

        if await self._bounded_matching_dispatch_exists(
            record,
            lease,
            intent_token=intent_token,
            preflight_error=preflight_error,
            same_epoch=False,
        ):
            await self._resolve_dispatch_intent(
                record,
                intent_token=intent_token,
                status="reconciled",
            )
            return _DispatchOutcome("reconciled", launch_fenced=True)
        resolution_persisted = await self._resolve_dispatch_intent(
            record,
            intent_token=intent_token,
            status="unresolved",
        )
        prior_stage = record.last_error_stage
        error_stage = (
            prior_stage
            if prior_stage
            in {
                "shadow_dispatch_launch",
                "shadow_dispatch_prelaunch",
                "shadow_dispatch_fence",
                "shadow_dispatch_resolution",
            }
            else "shadow_dispatch_fence"
        )
        return _DispatchOutcome(
            "ambiguous",
            error_stage=(
                error_stage
                if resolution_persisted
                else "shadow_dispatch_resolution"
            ),
            launch_fenced=True,
            schedule_retry=resolution_persisted,
        )

    async def _dispatch_or_reconcile(
        self,
        record: QualityRunRecord,
        lease: QualityRunLease,
        *,
        preflight_error: DispatchPreflightError | None,
    ) -> _DispatchOutcome:
        intent_token = _dispatch_intent_token(
            record,
            lease,
            preflight_error=preflight_error,
        )
        begun: object | None = None
        for _attempt in range(_IDEMPOTENT_PRELAUNCH_ATTEMPTS):
            try:
                # The begin RPC locks one exact lease/token pair and is
                # idempotent. Replaying it is required to distinguish a lost
                # response from a request that never committed; no physical
                # LangGraph operation has happened at this point.
                begun = await self._store_call(
                    "begin_dispatch",
                    lease,
                    intent_token=intent_token,
                )
            except Exception:  # noqa: BLE001 - exact-token replay is safe.
                continue
            break
        if begun is None:
            # An authoritative readback recovers a committed begin whose
            # responses were both lost. If it shows no intent, the durable
            # prelaunch retry marker permits a later lease to try again; only
            # ``runs.create`` is inherently ambiguous and permanently fenced.
            try:
                current = await self._store_call(
                    "get",
                    record.quality_run_id,
                )
            except Exception:  # noqa: BLE001 - ambiguity remains content-free.
                current = None
            if isinstance(current, QualityRunRecord) and (
                current.dispatch_intent_token is not None
                and current.dispatch_intent_status is not None
            ):
                begun = current
        if begun is None:
            await self._resolve_dispatch_intent(
                record,
                intent_token=intent_token,
                status="unresolved",
            )
            return _DispatchOutcome(
                "ambiguous",
                error_stage="shadow_dispatch_prelaunch",
                launch_fenced=True,
            )
        if not isinstance(begun, QualityRunRecord):
            raise RuntimeError("deck quality dispatch intent returned invalid record")
        persisted_token = begun.dispatch_intent_token
        if persisted_token is None or begun.dispatch_intent_status is None:
            raise RuntimeError("deck quality dispatch intent was not persisted")
        if persisted_token != intent_token or begun.dispatch_intent_status != "prepared":
            return await self._reconcile_fenced_launch(
                begun,
                lease,
                intent_token=persisted_token,
                preflight_error=preflight_error,
            )
        return await self._dispatch(
            begun,
            lease,
            intent_token=intent_token,
            preflight_error=preflight_error,
        )

    def _remember_unresolved(
        self,
        quality_run_id: str,
        *,
        ambiguous: bool = False,
        rejected: bool = False,
        retry_scheduled: bool = False,
        launch_fenced: bool = False,
    ) -> None:
        current = self._unresolved_outcomes.get(
            quality_run_id,
            _UnresolvedDispatchOutcome(),
        )
        self._unresolved_outcomes[quality_run_id] = current.merged(
            ambiguous=ambiguous,
            rejected=rejected,
            retry_scheduled=retry_scheduled,
            launch_fenced=launch_fenced,
        )

    async def _refresh_unresolved(self) -> None:
        recovered = await self._store_call(
            "recover_expired_finalizing",
            limit=100,
        )
        if (
            isinstance(recovered, bool)
            or not isinstance(recovered, int)
            or not 0 <= recovered <= 100
        ):
            raise RuntimeError(
                "deck quality expired recovery result is invalid"
            )
        lister = getattr(self._store, "unresolved_dispatches", None)
        if callable(lister):
            persisted = await self._call_maybe_async(lister, limit=100)
            if not isinstance(persisted, tuple) or any(
                not isinstance(quality_run_id, str)
                for quality_run_id in persisted
            ):
                raise RuntimeError(
                    "deck quality unresolved dispatch list is invalid"
                )
            for quality_run_id in persisted:
                self._remember_unresolved(
                    quality_run_id,
                    ambiguous=True,
                    launch_fenced=True,
                )
        getter = getattr(self._store, "get", None)
        if not callable(getter):
            return
        for quality_run_id in tuple(self._unresolved_outcomes):
            record = await self._call_maybe_async(getter, quality_run_id)
            if (
                isinstance(record, QualityRunRecord)
                and record.state in {"completed", "failed", "stale"}
            ):
                self._unresolved_outcomes.pop(quality_run_id, None)

    async def _schedule_ambiguous_retry(
        self,
        *,
        record: QualityRunRecord,
        lease: QualityRunLease,
        rejected: bool,
        error_stage: str,
    ) -> bool:
        self._remember_unresolved(
            record.quality_run_id,
            ambiguous=True,
            rejected=rejected,
            launch_fenced=True,
        )
        delay = min(300, 15 * (2 ** min(record.attempt_count, 4)))
        retried = await self._store_call(
            "retry",
            lease,
            error_code=QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
            error_stage=error_stage,
            delay_seconds=delay,
            max_attempts=5,
        )
        if not isinstance(retried, QualityRunRecord):
            raise RuntimeError("deck quality dispatcher retry returned invalid record")
        if retried.state in {"completed", "failed", "stale"}:
            self._unresolved_outcomes.pop(record.quality_run_id, None)
            return False
        self._remember_unresolved(
            record.quality_run_id,
            retry_scheduled=True,
            launch_fenced=True,
        )
        logger.error(
            "DQ1 ambiguous dispatch scheduled durable retry lease_epoch=%d retryDelaySeconds=%d contentExcluded=true",
            lease.epoch,
            delay,
        )
        return True

    async def run_once(self) -> DispatchCycleResult:
        await self._refresh_unresolved()
        records = await self._claim(self._next_claim_token())
        counts = {
            "claimed": len(records),
            "dispatched": 0,
            "reconciled": 0,
            "rejected": 0,
            "retry_scheduled": 0,
            "ambiguous": 0,
            "launch_fenced": 0,
        }
        for record in records:
            lease = QualityRunLease.from_record(record)
            current_instrument = canonical_sha256(record.instrument_lock()) == self._instrument_hash
            exact_canary = record.user_id in self._config.canary_user_ids
            if not exact_canary or not current_instrument:
                preflight_error: DispatchPreflightError = (
                    "scope_mismatch"
                    if not exact_canary
                    else "instrument_mismatch"
                )
                outcome = await self._dispatch_or_reconcile(
                    record,
                    lease,
                    preflight_error=preflight_error,
                )
                if outcome.status in {"dispatched", "reconciled"}:
                    counts["rejected"] += 1
                    self._remember_unresolved(
                        record.quality_run_id,
                        rejected=True,
                        ambiguous=outcome.launch_fenced,
                        launch_fenced=outcome.launch_fenced,
                    )
                    if outcome.launch_fenced:
                        counts["launch_fenced"] += 1
                elif outcome.status == "ambiguous":
                    counts["ambiguous"] += 1
                    counts["launch_fenced"] += 1
                    assert outcome.error_stage is not None
                    if outcome.schedule_retry:
                        if await self._schedule_ambiguous_retry(
                            record=record,
                            lease=lease,
                            rejected=True,
                            error_stage=outcome.error_stage,
                        ):
                            counts["retry_scheduled"] += 1
                    else:
                        self._remember_unresolved(
                            record.quality_run_id,
                            ambiguous=True,
                            rejected=True,
                            launch_fenced=True,
                        )
                else:
                    raise RuntimeError("deck quality dispatcher outcome is invalid")
                logger.error(
                    "DQ1 dispatch rejection handed off quality_run_id=%s reason=%s outcome=%s contentExcluded=true",
                    record.quality_run_id,
                    preflight_error,
                    outcome.status,
                )
                continue

            outcome = await self._dispatch_or_reconcile(
                record,
                lease,
                preflight_error=None,
            )
            if outcome.status in {"dispatched", "reconciled"}:
                counts[outcome.status] += 1
                if outcome.launch_fenced:
                    counts["launch_fenced"] += 1
                    self._remember_unresolved(
                        record.quality_run_id,
                        ambiguous=True,
                        launch_fenced=True,
                    )
                else:
                    self._unresolved_outcomes.pop(record.quality_run_id, None)
                logger.info(
                    "DQ1 dispatch outcome quality_run_id=%s outcome=%s lease_epoch=%d contentExcluded=true",
                    record.quality_run_id,
                    outcome.status,
                    lease.epoch,
                )
                continue
            if outcome.status == "ambiguous":
                counts["ambiguous"] += 1
                counts["launch_fenced"] += 1
                assert outcome.error_stage is not None
                if outcome.schedule_retry:
                    if await self._schedule_ambiguous_retry(
                        record=record,
                        lease=lease,
                        rejected=False,
                        error_stage=outcome.error_stage,
                    ):
                        counts["retry_scheduled"] += 1
                else:
                    self._remember_unresolved(
                        record.quality_run_id,
                        ambiguous=True,
                        launch_fenced=True,
                    )
                continue
            raise RuntimeError("deck quality dispatcher outcome is invalid")
        return DispatchCycleResult(**counts)

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                result = await self.run_once()
                self._last_cycle_error_type = None
                self._consecutive_cycle_errors = 0
                if result.degraded:
                    self._last_degraded_cycle_counts = result.safe_counts()
                elif not self._unresolved_outcomes:
                    self._last_degraded_cycle_counts = None
                    self._last_cycle_success_at = datetime.now(UTC)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - safe outer isolation; no response body logging.
                self._last_cycle_error_type = exc.__class__.__name__
                self._consecutive_cycle_errors += 1
                logger.error("DQ1 dispatcher cycle failed contentExcluded=true", exc_info=False)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._poll_seconds)
            except TimeoutError:
                continue

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._last_cycle_success_at = None
        self._last_cycle_error_type = None
        self._consecutive_cycle_errors = 0
        self._last_degraded_cycle_counts = None
        self._task = asyncio.create_task(self._run(), name="dq1-deck-quality-dispatcher")

    async def stop(self) -> None:
        self._stop.set()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _WORKER_STOP_TIMEOUT_SECONDS
        task = self._task
        if task is not None and not task.done():
            task.cancel()
        if task is not None:
            done, pending = await asyncio.wait(
                {task},
                timeout=max(0.0, deadline - loop.time()),
            )
            if pending:
                logger.error(
                    "DQ1 dispatcher stop timed out contentExcluded=true",
                    exc_info=False,
                )
                task.add_done_callback(self._consume_task_result)
            else:
                self._consume_task_result(next(iter(done)))
        self._task = None
        resources = tuple(
            resource
            for index, resource in enumerate((self._store, self._client))
            if resource is not None
            and all(
                resource is not previous
                for previous in (self._store, self._client)[:index]
            )
        )
        close_tasks = {
            asyncio.create_task(self._close_resource(resource))
            for resource in resources
        }
        if close_tasks:
            done, pending = await asyncio.wait(
                close_tasks,
                timeout=max(0.0, deadline - loop.time()),
            )
            for close_task in done:
                self._consume_task_result(close_task, close_failure=True)
            for close_task in pending:
                close_task.cancel()
                close_task.add_done_callback(
                    lambda finished: self._consume_task_result(
                        finished,
                        close_failure=True,
                    )
                )
            if pending:
                logger.error(
                    "DQ1 dispatcher resource close timed out contentExcluded=true",
                    exc_info=False,
                )

    async def _close_resource(self, resource: object) -> None:
        for method_name in ("aclose", "close"):
            method = getattr(resource, method_name, None)
            if callable(method):
                await self._call_maybe_async(method)
                return

    @staticmethod
    def _consume_task_result(
        task: asyncio.Task[object],
        *,
        close_failure: bool = False,
    ) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.error(
                "DQ1 dispatcher resource close failed contentExcluded=true"
                if close_failure
                else "DQ1 dispatcher task failed during stop contentExcluded=true",
                exc_info=False,
            )


def build_configured_deck_quality_dispatcher(
    *,
    config: DeckQualityConfig,
    instrument: QualityInstrumentLock,
    langgraph_url: str,
    store: SupabaseDeckQualityRunStore | None = None,
    gateway_deployed_sha: str | None = None,
) -> DeckQualityDispatcher | None:
    if not config.enabled:
        return None
    configured_store = store or configured_deck_quality_run_store()
    if configured_store is None:
        raise RuntimeError("enabled DQ1 dispatcher requires durable persistence")
    return DeckQualityDispatcher(
        config=config,
        instrument=instrument,
        store=configured_store,
        langgraph_url=langgraph_url,
        gateway_deployed_sha=gateway_deployed_sha or _gateway_sha_from_env() or "",
    )


def install_deck_quality_dispatcher(app: Any, dispatcher: DeckQualityDispatcher | None) -> None:
    setattr(app.state, _WORKER_ATTR, dispatcher)


def get_deck_quality_dispatcher_or_none(app: Any) -> DeckQualityDispatcher | None:
    value = getattr(app.state, _WORKER_ATTR, None)
    return value if isinstance(value, DeckQualityDispatcher) else None
