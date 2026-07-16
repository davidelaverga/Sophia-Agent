"""Durable, canary-only dispatcher for DQ-1 shadow quality runs.

The gateway owns no quality evidence and no judge credentials. It claims a
safe metadata-only Supabase outbox row and starts the separately registered
LangGraph graph. The graph owns lease renewal, evidence access, model calls,
stage persistence, and terminal completion.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
import uuid
from collections.abc import Callable
from dataclasses import dataclass
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
_RECONCILIATION_RUN_LIMIT = 100
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


def _dispatch_metadata(
    record: QualityRunRecord,
    lease: QualityRunLease,
    *,
    preflight_error: DispatchPreflightError | None = None,
) -> dict[str, Any]:
    metadata = {
        "dq1_quality_run_id": record.quality_run_id,
        "dq1_lease_owner": lease.owner,
        "dq1_lease_epoch": lease.epoch,
    }
    if preflight_error is not None:
        metadata["dq1_dispatch_preflight_error"] = preflight_error
    return metadata


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

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def probe(self) -> None:
        """Fail startup closed when the service-role RPC surface is absent."""

        probe = getattr(self._store, "probe", None)
        if probe is None:
            raise RuntimeError("deck quality persistence store is not probeable")
        await probe()

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
            return await self._store.claim(**arguments)
        except Exception:  # noqa: BLE001 - the durable receipt makes one ambiguous replay safe.
            return await self._store.claim(**arguments)

    async def _matching_dispatch_exists(
        self,
        record: QualityRunRecord,
        lease: QualityRunLease,
        *,
        preflight_error: DispatchPreflightError | None = None,
    ) -> bool | None:
        try:
            runs = await self._get_client().runs.list(
                record.quality_run_id,
                limit=_RECONCILIATION_RUN_LIMIT,
                select=["metadata"],
            )
        except Exception:  # noqa: BLE001 - ambiguous state is handled without relaunching.
            return None
        expected = _dispatch_metadata(
            record,
            lease,
            preflight_error=preflight_error,
        )
        for run in runs:
            metadata = run.get("metadata") if isinstance(run, dict) else getattr(run, "metadata", None)
            if isinstance(metadata, dict) and all(metadata.get(key) == value for key, value in expected.items()):
                return True
        return False

    async def _dispatch(
        self,
        record: QualityRunRecord,
        lease: QualityRunLease,
        *,
        preflight_error: DispatchPreflightError | None = None,
    ) -> str:
        client = self._get_client()
        metadata = _dispatch_metadata(
            record,
            lease,
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
        try:
            await client.threads.create(
                thread_id=record.quality_run_id,
                if_exists="do_nothing",
                graph_id=_QUALITY_GRAPH_ID,
            )
            await client.runs.create(
                record.quality_run_id,
                _QUALITY_GRAPH_ID,
                input=safe_input,
                context=safe_input,
                metadata=metadata,
                multitask_strategy="enqueue",
                durability="sync",
            )
            return "dispatched"
        except Exception:  # noqa: BLE001 - every create failure is ambiguous until reconciled.
            existing = await self._matching_dispatch_exists(
                record,
                lease,
                preflight_error=preflight_error,
            )
            if existing is True:
                return "reconciled"
            # An empty or failed list is not proof that the create did not
            # commit: list visibility may lag the create response. Keep the
            # current epoch leased and never issue a second create from this
            # dispatcher invocation. A genuinely absent run is retried only
            # after lease expiry under a new epoch.
            return "ambiguous"

    async def run_once(self) -> DispatchCycleResult:
        records = await self._claim(self._next_claim_token())
        counts = {
            "claimed": len(records),
            "dispatched": 0,
            "reconciled": 0,
            "rejected": 0,
            "retry_scheduled": 0,
            "ambiguous": 0,
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
                outcome = await self._dispatch(
                    record,
                    lease,
                    preflight_error=preflight_error,
                )
                if outcome in {"dispatched", "reconciled"}:
                    counts["rejected"] += 1
                else:
                    counts[outcome] += 1
                logger.error(
                    "DQ1 dispatch rejection handed off quality_run_id=%s reason=%s outcome=%s contentExcluded=true",
                    record.quality_run_id,
                    preflight_error,
                    outcome,
                )
                continue

            outcome = await self._dispatch(record, lease)
            if outcome in {"dispatched", "reconciled", "ambiguous"}:
                counts[outcome] += 1
                logger.info(
                    "DQ1 dispatch outcome quality_run_id=%s outcome=%s lease_epoch=%d contentExcluded=true",
                    record.quality_run_id,
                    outcome,
                    lease.epoch,
                )
                continue

            delay = min(300, 15 * (2 ** min(record.attempt_count, 4)))
            await self._store.retry(
                lease,
                error_code=QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
                error_stage="shadow_dispatch",
                delay_seconds=delay,
                max_attempts=5,
            )
            counts["retry_scheduled"] += 1
            logger.error(
                "DQ1 dispatch failed quality_run_id=%s lease_epoch=%d retryDelaySeconds=%d contentExcluded=true",
                record.quality_run_id,
                lease.epoch,
                delay,
            )
        return DispatchCycleResult(**counts)

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - safe outer isolation; no response body logging.
                logger.error("DQ1 dispatcher cycle failed contentExcluded=true", exc_info=False)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._poll_seconds)
            except TimeoutError:
                continue

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="dq1-deck-quality-dispatcher")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
        self._task = None
        close = getattr(self._store, "aclose", None)
        if close is not None:
            await close()


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
