from __future__ import annotations

import asyncio
import hashlib
import inspect
import threading
import time
import uuid
from contextlib import asynccontextmanager, nullcontext
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.gateway.artifact_registry import (
    ArtifactRecord,
    SupabaseArtifactRegistry,
    SupabaseArtifactRegistryConfig,
)
from app.gateway.routers import voice_lab_recovery
from app.gateway.workers import voice_lab_retention as retention_worker
from app.gateway.workers.voice_lab_retention import VoiceLabRetentionReaper
from deerflow.sophia.session_store import (
    SessionRecord,
    SupabaseSessionStoreConfig,
    SupabaseSessionTranscriptStore,
)

BUILD = "41a9b127af780bbe9d88acf34566a6aaf443e6b0"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _builder_global_sweep_zero(monkeypatch: pytest.MonkeyPatch):
    from app.gateway.routers import builder_events

    async def _sweep(**_kwargs):
        return {
            "discovery_complete": True,
            "discovered": 0,
            "completed": 0,
            "pending": 0,
            "malformed": 0,
            "truncated": False,
            "raw_identity_excluded": True,
            "_completed_cleanup_handles": [],
        }

    monkeypatch.setattr(
        builder_events,
        "reap_expired_synthetic_builder_obligations",
        _sweep,
    )


@pytest.fixture(autouse=True)
def _reset_cleanup_control_fixtures():
    from deerflow.sophia.cleanup_fence import (
        _reset_local_cleanup_fences_for_tests,
    )

    _reset_local_cleanup_fences_for_tests()
    yield
    _reset_local_cleanup_fences_for_tests()


def _millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _cleanup_id(run_id: str) -> str:
    return str(uuid.UUID(hex=hashlib.sha256(run_id.encode()).hexdigest()[:32], version=4))


def test_restart_scanner_accepts_builder_global_prepared_authority() -> None:
    deadline = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    cleanup_id = _cleanup_id("builder-global")

    intent = retention_worker.PreparedCleanupIntent(
        cleanup_obligation_id=cleanup_id,
        prepared_at=_millis(deadline),
        retention_expires_at=_millis(deadline),
        provider_expires_at=_millis(deadline - timedelta(minutes=30)),
        control_expires_at=_millis(deadline + timedelta(hours=1)),
        cleanup_mode="builder_global",
        retention_sla_missed=False,
        overdue_seconds_at_preparation=0,
        object_path=(
            ".builder/voice_lab_evidence/retention-cleanup-intents/v2/"
            f"{hashlib.sha256(cleanup_id.encode()).hexdigest()}.json"
        ),
    )

    assert intent.cleanup_mode == "builder_global"


def test_restart_scanner_retains_overdue_prepared_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deadline = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    cleanup_id = _cleanup_id("overdue-prepared")
    object_path = (
        ".builder/voice_lab_evidence/retention-cleanup-intents/v2/"
        f"{hashlib.sha256(cleanup_id.encode()).hexdigest()}.json"
    )
    payload = {
        "cleanup_obligation_id": cleanup_id,
        "prepared_at": _millis(deadline),
        "retention_expires_at": _millis(deadline),
        "provider_expires_at": _millis(deadline - timedelta(minutes=30)),
        "control_expires_at": _millis(deadline + timedelta(hours=1)),
        "cleanup_mode": "canonical_session",
        "retention_sla_missed": False,
        "overdue_seconds_at_preparation": 0,
    }
    monkeypatch.setattr(
        voice_lab_recovery,
        "_list_retention_cleanup_handles_bounded",
        lambda *, limit: ([(object_path, payload, {"schema": "sealed"})], 0),
    )

    intents, invalid = retention_worker.scan_retention_cleanup_handles(
        now=deadline + timedelta(hours=2),
        limit=5,
    )

    assert [intent.cleanup_obligation_id for intent in intents] == [cleanup_id]
    assert intents[0].control_deadline == deadline + timedelta(hours=1)
    assert invalid == 1


def test_cleanup_scan_frozen_pass_retries_pending_head_during_new_ingress() -> None:
    from deerflow.sophia.cleanup_fence import (
        _seed_local_cleanup_obligation_for_tests,
        scan_cleanup_fence_work,
    )

    observed = datetime.now(UTC)
    pending_id = _cleanup_id("pending-control-head")
    _seed_local_cleanup_obligation_for_tests(
        pending_id,
        observed - timedelta(hours=3),
        observed - timedelta(hours=4),
        state="closed",
    )

    first, _truncated = scan_cleanup_fence_work(limit=1, max_scan=10)
    assert [work.cleanup_obligation_id for work in first] == [pending_id]

    newer_id = _cleanup_id("new-control-ingress")
    _seed_local_cleanup_obligation_for_tests(
        newer_id,
        observed - timedelta(hours=2),
        observed - timedelta(hours=4),
        state="closed",
    )
    exhausted, _truncated = scan_cleanup_fence_work(limit=1, max_scan=10)
    assert exhausted == ()

    newest_id = _cleanup_id("newest-control-ingress")
    _seed_local_cleanup_obligation_for_tests(
        newest_id,
        observed - timedelta(hours=1),
        observed - timedelta(hours=4),
        state="closed",
    )
    retried, _truncated = scan_cleanup_fence_work(limit=1, max_scan=10)
    assert [work.cleanup_obligation_id for work in retried] == [pending_id]


def test_closed_live_cleanup_checkpoint_switches_retry_to_retention_wait() -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    cleanup_id = _cleanup_id("closed-live-zero-checkpoint")
    retention = observed + timedelta(hours=2)
    provider = observed + timedelta(hours=1)
    cleanup_fence._seed_local_cleanup_obligation_for_tests(
        cleanup_id,
        retention,
        provider,
        state="closed",
    )

    unfinished, _truncated = cleanup_fence.scan_cleanup_fence_work(
        limit=1,
        max_scan=10,
        advance=False,
    )
    checkpoint = cleanup_fence.mark_cleanup_live_zero(
        cleanup_id,
        retention,
        provider,
    )
    waiting, _truncated = cleanup_fence.scan_cleanup_fence_work(
        limit=1,
        max_scan=10,
        advance=False,
    )

    assert [work.cleanup_obligation_id for work in unfinished] == [cleanup_id]
    assert isinstance(checkpoint, datetime)
    assert waiting == ()


def test_cleanup_scan_probe_requires_both_cursor_rows() -> None:
    from deerflow.sophia import cleanup_fence

    cleanup_fence.probe_cleanup_scan_cursors()
    with cleanup_fence._LOCAL_LOCK:
        cleanup_fence._LOCAL_SCAN_CURSORS.pop("complete_purge_v1")

    with pytest.raises(
        cleanup_fence.CleanupFenceError,
        match="cleanup scan cursor set drifted",
    ):
        cleanup_fence.probe_cleanup_scan_cursors()


def test_cleanup_runtime_d02_boundary_uses_only_sources_zero_readback() -> None:
    from deerflow.sophia import cleanup_fence

    source = inspect.getsource(cleanup_fence)
    assert source.count("public.sophia_voice_lab_d02_sources_zero") == 5
    assert "public.sophia_voice_lab_d02_gateway_settlements" not in source
    assert "public.sophia_voice_lab_d02_gateway_relay_leases" not in source


def test_cleanup_scan_advances_across_ten_thousand_duplicate_admissions() -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    duplicate_id = _cleanup_id("duplicate-admission-head")
    later_id = _cleanup_id("later-obligation")
    cleanup_fence._seed_local_cleanup_obligation_for_tests(
        duplicate_id,
        observed + timedelta(hours=2),
        observed + timedelta(hours=1),
    )
    cleanup_fence._seed_local_cleanup_obligation_for_tests(
        later_id,
        observed - timedelta(hours=1),
        observed - timedelta(hours=2),
        state="closed",
    )
    lease_deadline = observed - timedelta(hours=2)
    with cleanup_fence._LOCAL_LOCK:
        for index in range(10_001):
            admission_id = str(uuid.UUID(int=index + 1, version=4))
            cleanup_fence._LOCAL_ADMISSIONS[admission_id] = (
                cleanup_fence.CleanupAdmission(
                    admission_id=admission_id,
                    cleanup_obligation_id=duplicate_id,
                    resource_kind="provider",
                    resource_id=f"provider-{index}",
                    lease_expires_at=lease_deadline,
                    resource_expires_at=observed + timedelta(hours=1),
                )
            )

    first, first_truncated = cleanup_fence.scan_cleanup_fence_work(
        limit=1,
        max_scan=10_000,
    )
    second, second_truncated = cleanup_fence.scan_cleanup_fence_work(
        limit=1,
        max_scan=10_000,
    )
    third, _third_truncated = cleanup_fence.scan_cleanup_fence_work(
        limit=1,
        max_scan=10_000,
    )

    assert [work.cleanup_obligation_id for work in first] == [duplicate_id]
    assert [work.cleanup_obligation_id for work in second] == [duplicate_id]
    assert [work.cleanup_obligation_id for work in third] == [later_id]
    assert first_truncated is True
    assert second_truncated is True


def test_stale_reserved_scan_never_consumes_current_allocating_provider() -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    observed = observed.replace(microsecond=(observed.microsecond // 1000) * 1000)
    cleanup_id = _cleanup_id("reserved-to-allocating-race")
    retention = observed + timedelta(hours=2)
    provider = observed + timedelta(hours=1)
    cleanup_fence._seed_local_cleanup_obligation_for_tests(
        cleanup_id,
        retention,
        provider,
    )
    admission_id = str(uuid.uuid4())
    current = cleanup_fence.CleanupAdmission(
        admission_id=admission_id,
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="provider-race",
        lease_expires_at=observed - timedelta(milliseconds=1),
        resource_expires_at=provider,
        status="allocating",
    )
    with cleanup_fence._LOCAL_LOCK:
        cleanup_fence._LOCAL_ADMISSIONS[admission_id] = current
    stale = current.__class__(
        **{
            **vars(current),
            "status": "reserved",
            "expired": True,
        }
    )
    work = cleanup_fence.CleanupFenceWork(
        cleanup_obligation_id=cleanup_id,
        state="open",
        lifecycle_phase="session_provisional",
        retention_expires_at=retention,
        provider_expires_at=provider,
        retention_due=False,
        provider_due=False,
        admissions=(stale,),
    )

    result = voice_lab_recovery._finish_database_cleanup_fence_work(work)

    assert result["status"] == "pending"
    assert result["code"] == "cleanup_database_work_admissions_pending"
    with cleanup_fence._LOCAL_LOCK:
        assert cleanup_fence._LOCAL_ADMISSIONS[admission_id].status == "allocating"
        assert cleanup_fence._LOCAL_OBLIGATIONS[cleanup_id]["state"] == "closed"


def test_stale_session_admission_snapshot_does_not_close_after_atomic_consume() -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    observed = observed.replace(microsecond=(observed.microsecond // 1000) * 1000)
    cleanup_id = _cleanup_id("session-admission-consume-race")
    retention = observed + timedelta(hours=2)
    provider = observed + timedelta(hours=1)
    cleanup_fence._seed_local_cleanup_obligation_for_tests(
        cleanup_id,
        retention,
        provider,
    )
    stale = cleanup_fence.CleanupAdmission(
        admission_id=str(uuid.uuid4()),
        cleanup_obligation_id=cleanup_id,
        resource_kind="session",
        resource_id="thread-already-bound",
        lease_expires_at=observed - timedelta(milliseconds=1),
        resource_expires_at=retention,
        status="reserved",
        expired=True,
    )
    work = cleanup_fence.CleanupFenceWork(
        cleanup_obligation_id=cleanup_id,
        state="open",
        lifecycle_phase="session_provisional",
        retention_expires_at=retention,
        provider_expires_at=provider,
        retention_due=False,
        provider_due=False,
        admissions=(stale,),
    )

    result = voice_lab_recovery._finish_database_cleanup_fence_work(work)

    assert result["status"] == "completed"
    assert result["retention_purge_pending"] is True
    with cleanup_fence._LOCAL_LOCK:
        assert cleanup_fence._LOCAL_OBLIGATIONS[cleanup_id]["state"] == "open"


def test_stale_admission_snapshot_cannot_complete_or_release_advanced_row() -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    observed = observed.replace(microsecond=(observed.microsecond // 1000) * 1000)
    cleanup_id = _cleanup_id("generic-admission-stale-snapshot")
    retention = observed + timedelta(hours=2)
    provider = observed + timedelta(hours=1)
    cleanup_fence._seed_local_cleanup_obligation_for_tests(
        cleanup_id,
        retention,
        provider,
    )
    stale = cleanup_fence.CleanupAdmission(
        admission_id=str(uuid.uuid4()),
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="advanced-provider",
        lease_expires_at=observed - timedelta(seconds=1),
        resource_expires_at=provider,
        status="reserved",
        expired=True,
    )
    current = stale.__class__(
        **{
            **vars(stale),
            "status": "allocating",
            "expired": False,
        }
    )
    with cleanup_fence._LOCAL_LOCK:
        cleanup_fence._LOCAL_ADMISSIONS[current.admission_id] = current

    assert not cleanup_fence.complete_cleanup_admission(
        stale,
        basis="server_relay_zero",
    )
    cleanup_fence.release_cleanup_admission(stale)

    with cleanup_fence._LOCAL_LOCK:
        assert cleanup_fence._LOCAL_ADMISSIONS[current.admission_id] == current


def _session(now: datetime, *, run_id: str = "run-001") -> SessionRecord:
    created = now - timedelta(hours=2)
    expiry = created + timedelta(hours=1)
    return SessionRecord(
        session_id=f"session-{run_id}",
        thread_id=f"thread-{run_id}",
        user_id="voice-lab-user-1",
        run_id=run_id,
        created_at=created.isoformat(),
        metadata={
            "expected_deployment": {
                "frontend": BUILD,
                "backend": BUILD,
                "voice": BUILD,
            },
            "memory_retrieval_disabled": True,
            "inactivity_finalization_disabled": True,
            "offline_pipeline_disabled": True,
            "memory_learning_disabled": True,
            "ordinary_analytics_disabled": True,
            "ordinary_projects_disabled": True,
            "shared_spaces_disabled": True,
            "synthetic_voice_lab": {
                "synthetic": True,
                "principal_id": "voice-lab-user-1",
                "test_run_id": run_id,
                "scenario_id": "vt00-realtime-001",
                "scenario_version": "v1",
                "environment": "production",
                "retention_hours": 1,
                "cleanup_obligation_id": _cleanup_id(run_id),
                "provider_expires_at": _millis(created + timedelta(minutes=30)),
                "retention_anchor": "session_created_at_provisional",
                "retention_expires_at": _millis(expiry),
            },
        },
    )


class _SessionStore:
    def __init__(self, record: SessionRecord | None) -> None:
        self.record = record
        self.scans = 0
        if record is not None:
            from deerflow.sophia.cleanup_fence import (
                _seed_local_cleanup_obligation_for_tests,
            )

            synthetic = record.metadata["synthetic_voice_lab"]
            _seed_local_cleanup_obligation_for_tests(
                str(synthetic["cleanup_obligation_id"]),
                str(synthetic["retention_expires_at"]),
                str(synthetic["provider_expires_at"]),
            )

    def expired_synthetic_sessions(self, *, now: datetime, limit: int):
        self.scans += 1
        return [self.record] if self.record is not None else []

    def find_session_by_run_id(self, user_id: str, run_id: str):
        if (
            self.record is not None
            and self.record.user_id == user_id
            and self.record.run_id == run_id
        ):
            return self.record
        return None

    def find_session_by_cleanup_obligation_id(self, cleanup_obligation_id: str):
        if self.record is None:
            return None
        synthetic = self.record.metadata.get("synthetic_voice_lab")
        if (
            isinstance(synthetic, dict)
            and synthetic.get("cleanup_obligation_id") == cleanup_obligation_id
        ):
            return self.record
        return None


class _ArtifactRegistry:
    def expired_synthetic_records_global(self, *, now: datetime, limit: int):
        return []

    def synthetic_run_records(self, *, user_id: str, test_run_id: str):
        return []

    def synthetic_cleanup_obligation_records(self, *, cleanup_obligation_id: str):
        return []


def test_provisional_retention_reuses_existing_recovery_tombstone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.gateway.routers import sessions
    from deerflow.sophia import cleanup_fence
    from deerflow.sophia.storage import supabase_artifact_store

    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    record = _session(now, run_id="existing-recovery-tombstone")
    obligation = retention_worker._obligation_from_session(record)
    claims = obligation.claims(now=now)
    events: list[str] = []

    class _PurgeStore:
        def purge_synthetic_session(self, *_args, **_kwargs):
            events.append("session_purged")
            return True

        def find_session_by_run_id(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(sessions, "_store", _PurgeStore())
    monkeypatch.setattr(
        "app.gateway.inactivity_watcher.unregister_thread",
        lambda _thread_id: events.append("thread_unregistered"),
    )
    monkeypatch.setattr(
        supabase_artifact_store,
        "is_configured",
        lambda: True,
    )
    monkeypatch.setattr(
        cleanup_fence,
        "cleanup_retention_expired",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_durable_evidence_required",
        lambda: True,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_ensure_retention_cleanup_handle",
        lambda *_args, **_kwargs: "retention-cleanup-intent.json",
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_prepare_recovery_receipt_purge",
        lambda _claims: {"already_purged": True, "target_count": 0},
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recovery_receipt_fence_lock",
        lambda _stable_id: nullcontext(),
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_finish_retention_cleanup_intent",
        lambda *_args, **_kwargs: {"status": "completed"},
    )

    result = retention_worker._purge_expired_provisional_session(
        claims,
        record,
        now,
        database_due=True,
    )

    assert result == {
        "status": "completed",
        "canonical_evidence_purged": True,
        "retention_purge_pending": False,
    }
    assert events == ["session_purged", "thread_unregistered"]


@asynccontextmanager
async def _lease(acquired: bool = True):
    yield acquired


@pytest.mark.anyio
async def test_due_run_survives_cleanup_outage_and_converges_on_later_cycle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    sessions = _SessionStore(_session(now))
    builder_available = False

    async def recover_builder(_claims):
        return {
            "status": "completed" if builder_available else "pending",
            "cleanup_complete": builder_available,
        }

    def recover_evidence(_claims, _record):
        sessions.record = None
        return {"status": "completed", "canonical_evidence_purged": True}

    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_voice_provider",
        AsyncMock(return_value={"status": "not_found"}),
    )
    monkeypatch.setattr(voice_lab_recovery, "_recover_builder", recover_builder)
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_auth_sessions_sync",
        lambda _claims: {"status": "already_terminal"},
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_canonical_evidence_retention",
        recover_evidence,
    )
    # The provisional helper is the due session path in this fixture.
    monkeypatch.setattr(
        "app.gateway.workers.voice_lab_retention._purge_expired_provisional_session",
        lambda claims, record, current: recover_evidence(claims, record),
    )
    reaper = VoiceLabRetentionReaper(
        session_store=sessions,  # type: ignore[arg-type]
        artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: now,
    )

    first = await reaper.run_once()
    assert first.discovered == 1
    assert first.pending == 1
    assert sessions.record is not None

    builder_available = True
    second = await reaper.run_once()
    assert second.completed == 1
    assert second.pending == 0
    assert sessions.record is None


@pytest.mark.anyio
async def test_database_scan_and_complete_purge_survive_builder_discovery_outage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.gateway.routers import builder_events
    from deerflow.sophia.cleanup_fence import CleanupFenceWork

    observed = datetime.now(UTC)
    cleanup_id = _cleanup_id("isolated-database-cycle")
    work = CleanupFenceWork(
        cleanup_obligation_id=cleanup_id,
        state="closed",
        lifecycle_phase="auth_provisional",
        retention_expires_at=observed - timedelta(hours=1),
        provider_expires_at=observed - timedelta(hours=1),
        retention_due=True,
        provider_due=True,
        admissions=(),
    )
    opaque_calls: list[str] = []
    purge_calls: list[int] = []

    async def unavailable_builder_sweep(**_kwargs):
        raise RuntimeError("builder discovery unavailable")

    def finish_opaque(candidate, *, now):
        assert now == observed
        opaque_calls.append(candidate.cleanup_obligation_id)
        return {"status": "completed"}

    def purge_complete(**kwargs):
        assert callable(kwargs["eligibility_check"])
        purge_calls.append(int(kwargs["limit"]))
        return 0

    monkeypatch.setattr(
        builder_events,
        "reap_expired_synthetic_builder_obligations",
        unavailable_builder_sweep,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_finish_database_cleanup_fence_work",
        finish_opaque,
    )
    reaper = VoiceLabRetentionReaper(
        session_store=_SessionStore(None),  # type: ignore[arg-type]
        artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        cleanup_fence_scanner=lambda **_kwargs: ((work,), False),
        completed_fence_purger=purge_complete,
        lease_factory=_lease,
        clock=lambda: observed,
    )

    cycle = await reaper.run_once()

    assert opaque_calls == [cleanup_id]
    assert purge_calls == [5]
    assert cycle.discovery_failed is True
    assert cycle.processing_failed == 0


@pytest.mark.anyio
async def test_reaper_reloads_canonical_record_after_admission_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    stale = _session(now, run_id="reload-after-settlement")
    refreshed = stale.model_copy(deep=True)
    refreshed.metadata["synthetic_voice_lab"]["settlement_marker"] = "durable"
    sessions = _SessionStore(stale)

    def settle_admission(_claims, _record):
        sessions.record = refreshed
        return {"status": "completed", "cleanup_admissions_pending": 0}

    async def recover_provider(_claims, record, *, retention_reaper: bool):
        assert retention_reaper is True
        assert record is refreshed
        assert record.metadata["synthetic_voice_lab"]["settlement_marker"] == "durable"
        return {"status": "already_terminal"}

    def purge(_claims, record, _now):
        assert record is refreshed
        sessions.record = None
        return {"status": "completed"}

    monkeypatch.setattr(
        voice_lab_recovery,
        "_close_live_cleanup_admission",
        settle_admission,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_voice_provider",
        recover_provider,
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_builder",
        AsyncMock(return_value={"status": "completed"}),
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_auth_sessions_sync",
        lambda _claims: {"status": "already_terminal"},
    )
    monkeypatch.setattr(
        retention_worker,
        "_purge_expired_provisional_session",
        purge,
    )
    reaper = VoiceLabRetentionReaper(
        session_store=sessions,  # type: ignore[arg-type]
        artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: now,
    )

    completed = await reaper._process(
        retention_worker._obligation_from_session(stale),
        now=now,
    )

    assert completed is True
    assert sessions.record is None


@pytest.mark.anyio
async def test_closed_crash_before_live_zero_retries_builder_auth_before_retention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia import cleanup_fence

    observed = datetime.now(UTC)
    observed = observed.replace(microsecond=(observed.microsecond // 1000) * 1000)
    record = _session(observed + timedelta(hours=2), run_id="closed-crash-retry")
    sessions = _SessionStore(record)
    synthetic = record.metadata["synthetic_voice_lab"]
    cleanup_id = str(synthetic["cleanup_obligation_id"])
    cleanup_fence.close_cleanup_obligation(
        cleanup_id,
        str(synthetic["retention_expires_at"]),
        str(synthetic["provider_expires_at"]),
    )
    work, _truncated = cleanup_fence.scan_cleanup_fence_work(
        limit=1,
        max_scan=10,
        advance=False,
    )
    assert [candidate.cleanup_obligation_id for candidate in work] == [cleanup_id]
    obligation = retention_worker._attach_cleanup_control_work(
        retention_worker._obligation_from_session(record),
        work[0],
    )
    provider = AsyncMock(return_value={"status": "already_terminal"})
    builder = AsyncMock(return_value={"status": "completed"})
    auth_calls: list[str] = []

    monkeypatch.setattr(
        voice_lab_recovery,
        "_close_live_cleanup_admission",
        lambda _claims, _record: {"status": "completed"},
    )
    monkeypatch.setattr(voice_lab_recovery, "_recover_voice_provider", provider)
    monkeypatch.setattr(voice_lab_recovery, "_recover_builder", builder)
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_auth_sessions_sync",
        lambda claims: auth_calls.append(claims.cleanup_obligation_id)
        or {"status": "already_terminal"},
    )
    reaper = VoiceLabRetentionReaper(
        session_store=sessions,  # type: ignore[arg-type]
        artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: observed,
    )

    completed = await reaper._process(obligation, now=observed)
    waiting, _truncated = cleanup_fence.scan_cleanup_fence_work(
        limit=1,
        max_scan=10,
        advance=False,
    )

    assert completed is True
    provider.assert_awaited_once()
    builder.assert_awaited_once()
    assert auth_calls == [cleanup_id]
    with cleanup_fence._LOCAL_LOCK:
        checkpoint = cleanup_fence._LOCAL_OBLIGATIONS[cleanup_id][
            "live_cleanup_completed_at"
        ]
    assert isinstance(checkpoint, datetime)
    assert waiting == ()


@pytest.mark.anyio
async def test_resolved_session_rechecks_renewed_admission_before_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia import cleanup_fence

    database_now = datetime.now(UTC)
    database_now = database_now.replace(
        microsecond=(database_now.microsecond // 1000) * 1000
    )
    app_now = database_now + timedelta(hours=2)
    record = _session(app_now, run_id="renewed-browser-active")
    sessions = _SessionStore(record)
    synthetic = record.metadata["synthetic_voice_lab"]
    cleanup_id = str(synthetic["cleanup_obligation_id"])
    provider_deadline = datetime.fromisoformat(
        str(synthetic["provider_expires_at"]).replace("Z", "+00:00")
    )
    retention_deadline = datetime.fromisoformat(
        str(synthetic["retention_expires_at"]).replace("Z", "+00:00")
    )
    admission_id = str(uuid.uuid4())
    current = cleanup_fence.CleanupAdmission(
        admission_id=admission_id,
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="renewed-runtime",
        lease_expires_at=database_now + timedelta(minutes=10),
        resource_expires_at=provider_deadline,
        status="browser_active",
    )
    with cleanup_fence._LOCAL_LOCK:
        cleanup_fence._LOCAL_ADMISSIONS[admission_id] = current
    stale = current.__class__(
        **{
            **vars(current),
            "lease_expires_at": database_now - timedelta(seconds=1),
            "expired": True,
        }
    )
    stale_work = cleanup_fence.CleanupFenceWork(
        cleanup_obligation_id=cleanup_id,
        state="open",
        lifecycle_phase="session_provisional",
        retention_expires_at=retention_deadline,
        provider_expires_at=provider_deadline,
        retention_due=False,
        provider_due=False,
        admissions=(stale,),
    )
    obligation = retention_worker._attach_cleanup_control_work(
        retention_worker._obligation_from_session(record),
        stale_work,
    )
    close_live = AsyncMock(
        side_effect=AssertionError("renewed admission must retain OPEN authority")
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_close_live_cleanup_admission",
        close_live,
    )
    reaper = VoiceLabRetentionReaper(
        session_store=sessions,  # type: ignore[arg-type]
        artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: app_now,
    )

    completed = await reaper._process(obligation, now=app_now)

    assert completed is False
    with cleanup_fence._LOCAL_LOCK:
        assert cleanup_fence._LOCAL_OBLIGATIONS[cleanup_id]["state"] == "open"
        assert cleanup_fence._LOCAL_ADMISSIONS[admission_id] == current
    close_live.assert_not_awaited()


@pytest.mark.anyio
async def test_ahead_reaper_clock_cannot_close_before_database_retention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia import cleanup_fence

    app_now = datetime.now(UTC) + timedelta(hours=2)
    record = _session(app_now, run_id="ahead-clock")
    sessions = _SessionStore(record)
    close_live = AsyncMock(
        side_effect=AssertionError("DB-future retention must not start cleanup")
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_close_live_cleanup_admission",
        close_live,
    )
    reaper = VoiceLabRetentionReaper(
        session_store=sessions,  # type: ignore[arg-type]
        artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: app_now,
    )

    cycle = await reaper.run_once()

    cleanup_id = record.metadata["synthetic_voice_lab"]["cleanup_obligation_id"]
    assert cycle.pending == 1
    assert cleanup_fence._LOCAL_OBLIGATIONS[cleanup_id]["state"] == "open"
    close_live.assert_not_awaited()


@pytest.mark.anyio
async def test_raising_first_obligation_is_pending_without_starving_later_due_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    records = [_session(now, run_id="run-raises"), _session(now, run_id="run-valid")]

    class Sessions:
        def expired_synthetic_sessions(self, *, now: datetime, limit: int):
            return records[:limit]

        def find_session_by_run_id(self, user_id: str, run_id: str):
            return next((record for record in records if record.run_id == run_id), None)

    async def process(obligation, *, now):
        if obligation.test_run_id == "run-raises":
            raise TimeoutError("provider deadline")
        return True

    reaper = VoiceLabRetentionReaper(
        session_store=Sessions(),  # type: ignore[arg-type]
        artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: now,
    )
    monkeypatch.setattr(reaper, "_process", process)

    cycle = await reaper.run_once()

    assert cycle.discovered == 2
    assert cycle.processing_failed == 1
    assert cycle.pending == 1
    assert cycle.completed == 1
    readiness = reaper.readiness()
    assert readiness["status"] == "degraded"
    assert readiness["last_cycle"]["processing_failed"] == 1


@pytest.mark.anyio
async def test_full_pending_batch_rotates_restart_safely_to_later_due_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    # Make the first 5-second slot select page zero of two, then restart the
    # worker in the next slot. Rotation derives only from time, not raw IDs.
    if (int(now.timestamp()) // 5) % 2:
        now += timedelta(seconds=5)
    clock = [now]
    records = [
        *[_session(now, run_id=f"run-pending-{index}") for index in range(5)],
        _session(now, run_id="run-z-later-valid"),
    ]

    class Sessions:
        def expired_synthetic_sessions(self, *, now: datetime, limit: int):
            return records[:limit]

        def find_session_by_run_id(self, user_id: str, run_id: str):
            return next((record for record in records if record.run_id == run_id), None)

    processed: list[str] = []

    async def process(obligation, *, now):
        processed.append(obligation.test_run_id)
        return obligation.test_run_id == "run-z-later-valid"

    def make_reaper() -> VoiceLabRetentionReaper:
        worker = VoiceLabRetentionReaper(
            session_store=Sessions(),  # type: ignore[arg-type]
            artifact_registry=_ArtifactRegistry(),  # type: ignore[arg-type]
            interval_seconds=5,
            batch_size=5,
            finalization_scanner=lambda **_kwargs: ([], 0),
            lease_factory=_lease,
            clock=lambda: clock[0],
        )
        monkeypatch.setattr(worker, "_process", process)
        return worker

    first = await make_reaper().run_once()
    assert first.discovered == 5
    assert first.completed == 0
    assert first.pending == 5
    assert "run-z-later-valid" not in processed

    # Simulate a rolling replacement rather than retaining an in-memory cursor.
    clock[0] += timedelta(seconds=5)
    second = await make_reaper().run_once()
    assert second.discovered == 1
    assert second.completed == 1
    assert processed[-1] == "run-z-later-valid"


@pytest.mark.anyio
async def test_rolling_replica_lease_overlap_is_not_a_probe_failure() -> None:
    class NeverScanned:
        def expired_synthetic_sessions(self, **_kwargs):
            raise AssertionError("contended replica must not scan")

    reaper = VoiceLabRetentionReaper(
        session_store=NeverScanned(),  # type: ignore[arg-type]
        artifact_registry=NeverScanned(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=lambda: _lease(False),
        clock=lambda: datetime(2026, 8, 23, 12, 0, tzinfo=UTC),
    )

    cycle = await reaper.run_once()
    assert cycle.lease_acquired is False
    assert cycle.discovery_failed is False
    assert reaper.readiness()["last_error_type"] is None


@pytest.mark.anyio
async def test_slow_durable_discovery_does_not_block_the_event_loop() -> None:
    class SlowSessionStore:
        def expired_synthetic_sessions(self, **_kwargs):
            time.sleep(0.25)
            return []

    class EmptyArtifactRegistry:
        def expired_synthetic_records_global(self, **_kwargs):
            return []

    reaper = VoiceLabRetentionReaper(
        session_store=SlowSessionStore(),  # type: ignore[arg-type]
        artifact_registry=EmptyArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: datetime(2026, 8, 23, 12, 0, tzinfo=UTC),
    )

    cycle_task = asyncio.create_task(reaper.run_once())
    started = asyncio.get_running_loop().time()
    await asyncio.sleep(0.02)
    heartbeat_elapsed = asyncio.get_running_loop().time() - started

    assert heartbeat_elapsed < 0.1
    cycle = await cycle_task
    assert cycle.discovery_failed is False
    assert cycle.discovered == 0


@pytest.mark.anyio
async def test_slow_per_run_store_verification_does_not_block_gateway_heartbeat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    sessions = _SessionStore(_session(now))

    class SlowArtifactRegistry(_ArtifactRegistry):
        def synthetic_cleanup_obligation_records(self, *, cleanup_obligation_id: str):
            time.sleep(0.25)
            return []

    def purge_session(_claims, _record, _now, **_kwargs):
        sessions.record = None
        return {"status": "completed"}

    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_voice_provider",
        AsyncMock(return_value={"status": "not_found"}),
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_builder",
        AsyncMock(return_value={"status": "completed"}),
    )
    monkeypatch.setattr(
        voice_lab_recovery,
        "_recover_auth_sessions_sync",
        lambda _claims: {"status": "already_terminal"},
    )
    monkeypatch.setattr(
        retention_worker,
        "_purge_expired_provisional_session",
        purge_session,
    )
    reaper = VoiceLabRetentionReaper(
        session_store=sessions,  # type: ignore[arg-type]
        artifact_registry=SlowArtifactRegistry(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: now,
    )

    cycle_task = asyncio.create_task(reaper.run_once())
    started = asyncio.get_running_loop().time()
    await asyncio.sleep(0.02)
    heartbeat_elapsed = asyncio.get_running_loop().time() - started

    assert heartbeat_elapsed < 0.1
    cycle = await cycle_task
    assert cycle.completed == 1


@pytest.mark.anyio
async def test_timed_out_lease_acquisition_hands_late_handle_to_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed = threading.Event()

    class LateHandle:
        acquired = True
        local_lock_held = True

        def close(self) -> None:
            closed.set()
            self.local_lock_held = False

    def acquire_late():
        time.sleep(0.05)
        return LateHandle()

    monkeypatch.setattr(retention_worker, "_LEASE_IO_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(
        retention_worker,
        "_acquire_retention_reaper_lease",
        acquire_late,
    )

    with pytest.raises(TimeoutError):
        async with retention_worker.retention_reaper_lease():
            raise AssertionError("timed-out lease must not enter")

    await asyncio.sleep(0.1)
    assert closed.is_set()
    assert not retention_worker._LEASE_HANDOFF_TASKS


def test_session_scan_pages_past_a_poisoned_first_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    store = SupabaseSessionTranscriptStore(
        config=SupabaseSessionStoreConfig(
            url="https://example.supabase.co",
            service_role_key="test-service-role",
        )
    )
    valid = store._session_row_from_record(_session(now, run_id="valid-run"))
    poison: list[dict[str, Any]] = []
    for index in range(100):
        row = store._session_row_from_record(_session(now, run_id=f"poison-{index}"))
        row["metadata"]["synthetic_voice_lab"]["retention_hours"] = "one"
        poison.append(row)
    rows = [*poison, valid]
    offsets: list[int] = []

    def request(_method: str, _table: str, *, params: dict[str, str], **_kwargs):
        offset = int(params["offset"])
        limit = int(params["limit"])
        offsets.append(offset)
        return rows[offset : offset + limit]

    monkeypatch.setattr(store, "_request", request)
    due = store.expired_synthetic_sessions(now=now, limit=1)

    assert [record.run_id for record in due] == ["valid-run"]
    assert offsets == [0, 100]


def _artifact(
    now: datetime,
    *,
    run_id: str = "valid-run",
    voice_sha: str = BUILD,
) -> ArtifactRecord:
    anchor = now - timedelta(hours=2)
    return ArtifactRecord(
        artifact_id=f"synthetic-artifact-{run_id}",
        user_id="voice-lab-user-1",
        thread_id=f"thread-{run_id}",
        session_id=f"session-{run_id}",
        parent_thread_id=f"thread-{run_id}",
        task_id=f"task-{run_id}",
        run_id=f"builder-{run_id}",
        logical_artifact_id=f"logical-{run_id}",
        version_id=f"version-{run_id}",
        title="Synthetic artifact",
        filename="artifact.html",
        artifact_type="html",
        renderer_kind="html",
        source="builder",
        local_path="mnt/user-data/outputs/artifact.html",
        created_at=_millis(anchor + timedelta(minutes=30)),
        updated_at=_millis(anchor + timedelta(minutes=30)),
        synthetic_test=True,
        test_run_id=run_id,
        test_principal_id="voice-lab-user-1",
        scenario_id="vt00-realtime-001",
        scenario_version="v1",
        environment="production",
        retention_hours=1,
        cleanup_obligation_id=_cleanup_id(run_id),
        provider_expires_at=_millis(anchor + timedelta(minutes=30)),
        retention_anchor="builder_task_created_at_provisional",
        retention_anchor_at=_millis(anchor),
        retention_expires_at=_millis(anchor + timedelta(hours=1)),
        deployment_identity={
            "frontend_sha": BUILD,
            "backend_sha": BUILD,
            "voice_sha": voice_sha,
        },
        memory_retrieval_excluded=True,
        memory_learning_excluded=True,
        ordinary_artifact_publication_excluded=True,
        ordinary_analytics_excluded=True,
        deck_quality_publication_excluded=True,
        langsmith_export_excluded=True,
        langsmith_trace_status="trace_unavailable",
        langsmith_trace_unavailable_reason="synthetic_isolation_policy",
    )


def test_artifact_scan_pages_past_a_poisoned_first_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    registry = SupabaseArtifactRegistry(
        config=SupabaseArtifactRegistryConfig(
            url="https://example.supabase.co",
            service_role_key="test-service-role",
            bucket="builder-artifacts",
        )
    )
    poison = [
        {
            "artifact_id": f"poison-{index}",
            "record_payload": {
                "synthetic_test": True,
                "retention_expires_at": "2026-08-23T00:00:00.000Z",
            },
        }
        for index in range(100)
    ]
    rows = [*poison, registry._row_from_record(_artifact(now))]
    offsets: list[int] = []

    def request(_method: str, *, params: dict[str, str], **_kwargs):
        offset = int(params["offset"])
        limit = int(params["limit"])
        offsets.append(offset)
        return rows[offset : offset + limit]

    monkeypatch.setattr(registry, "_request", request)
    due = registry.expired_synthetic_records_global(now=now, limit=1)

    assert [record.test_run_id for record in due] == ["valid-run"]
    assert offsets == [0, 100]


def test_discovery_expands_past_a_full_batch_of_cross_source_conflicts() -> None:
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    sessions = [_session(now, run_id=f"conflict-{index}") for index in range(5)]
    sessions.append(_session(now, run_id="later-valid"))
    artifacts = [
        _artifact(now, run_id=f"conflict-{index}", voice_sha="b" * 40)
        for index in range(5)
    ]
    session_limits: list[int] = []
    artifact_limits: list[int] = []

    class PagedSessions:
        def expired_synthetic_sessions(self, *, now: datetime, limit: int):
            session_limits.append(limit)
            return sessions[:limit]

    class PagedArtifacts:
        def expired_synthetic_records_global(self, *, now: datetime, limit: int):
            artifact_limits.append(limit)
            return artifacts[:limit]

    reaper = VoiceLabRetentionReaper(
        session_store=PagedSessions(),  # type: ignore[arg-type]
        artifact_registry=PagedArtifacts(),  # type: ignore[arg-type]
        interval_seconds=5,
        batch_size=5,
        finalization_scanner=lambda **_kwargs: ([], 0),
        lease_factory=_lease,
        clock=lambda: now,
    )

    due, malformed, conflicts = reaper._discover(now)

    assert [obligation.test_run_id for obligation in due] == ["later-valid"]
    assert malformed == 0
    assert conflicts == 5
    assert session_limits == [5, 10]
    assert artifact_limits == [5, 10]
