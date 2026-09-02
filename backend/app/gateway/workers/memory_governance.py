"""Existing-Gateway claim loop for durable MEM00 extraction and projection."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from deerflow.sophia.memory_governance.extraction_service import MemoryExtractionService
from deerflow.sophia.memory_governance.faults import MemoryFaultController
from deerflow.sophia.memory_governance.flags import (
    MemoryFeatureFlags,
    MemoryFlagConfigurationError,
    memory_cohort_principals,
    memory_feature_flags,
)
from deerflow.sophia.memory_governance.identity import memory_certification_principal
from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ProjectionAdapter
from deerflow.sophia.memory_governance.projection import MemoryProjectionReconciler
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.store import configured_memory_store
from deerflow.sophia.session_store import SessionStore

logger = logging.getLogger(__name__)

_WORKER_ATTR = "_memory_governance_worker"


class MemoryGovernanceWorker:
    def __init__(
        self,
        *,
        extraction: MemoryExtractionService | None,
        projection: MemoryProjectionReconciler | None,
        recovery_principals: tuple[str, ...] = (),
        poll_seconds: float = 1.0,
    ) -> None:
        self.extraction = extraction
        self.projection = projection
        self.recovery_principals = recovery_principals
        self.poll_seconds = poll_seconds
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._last_expiry_at = 0.0
        self._recovery_pending = bool(extraction and recovery_principals)

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def run_once(self) -> bool:
        worked = False
        if self.extraction is not None and self._recovery_pending:
            recovered = await asyncio.to_thread(
                self.extraction.recover_finalized_sessions,
                user_ids=self.recovery_principals,
            )
            self._recovery_pending = False
            worked = recovered > 0
        if self.extraction is not None and time.monotonic() - self._last_expiry_at >= 3600:
            expired = await asyncio.to_thread(self.extraction.governance_store.expire_candidates)
            self._last_expiry_at = time.monotonic()
            worked = expired > 0 or worked
        if self.extraction is not None:
            worked = await asyncio.to_thread(self.extraction.run_once) or worked
        if self.projection is not None:
            worked = await asyncio.to_thread(self.projection.run_once) or worked
        return worked

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                worked = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - durable rows remain retryable.
                worked = False
                logger.error(
                    "MEM00 worker cycle failed error_type=%s contentExcluded=true",
                    exc.__class__.__name__,
                    exc_info=False,
                )
            if worked:
                continue
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)
            except TimeoutError:
                continue

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="mem00-governance-worker")

    async def stop(self) -> None:
        self._stop.set()
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._task = None


def build_configured_memory_governance_worker(*, flags: MemoryFeatureFlags | None = None) -> MemoryGovernanceWorker | None:
    resolved = flags or memory_feature_flags()
    if not resolved.candidate_ledger_write and not resolved.provider_projection:
        return None
    # The certification identity is required before any MEM00 worker can
    # claim production rows, and startup rejects overlap with Voice Lab.
    certification_principal = memory_certification_principal()
    if certification_principal not in memory_cohort_principals():
        raise MemoryFlagConfigurationError("memory_certification_principal_not_in_cohort")
    deployment = os.getenv("RENDER_GIT_COMMIT") or os.getenv("SOPHIA_DEPLOYMENT_SHA") or "local"
    lease_owner = keyed_ref("worker", f"gateway:{deployment}:{os.getpid()}")
    store = configured_memory_store()
    faults = MemoryFaultController(store=store) if resolved.memory_fault_injection else None
    extraction = None
    projection = None
    if resolved.candidate_ledger_write:
        extraction = MemoryExtractionService(
            governance_store=store,
            session_store=SessionStore(),
            lease_owner=lease_owner,
            service_name="sophia-gateway",
            faults=faults,
        )
    if resolved.provider_projection:
        projection = MemoryProjectionReconciler(
            store=store,
            adapter=Mem0ProjectionAdapter(),
            lease_owner=lease_owner,
            service_name="sophia-gateway",
            faults=faults,
        )
    return MemoryGovernanceWorker(
        extraction=extraction,
        projection=projection,
        recovery_principals=tuple(sorted(memory_cohort_principals())),
    )


def install_memory_governance_worker(app: Any, worker: MemoryGovernanceWorker | None) -> None:
    setattr(app.state, _WORKER_ATTR, worker)


def get_memory_governance_worker_or_none(app: Any) -> MemoryGovernanceWorker | None:
    worker = getattr(app.state, _WORKER_ATTR, None)
    return worker if isinstance(worker, MemoryGovernanceWorker) else None
