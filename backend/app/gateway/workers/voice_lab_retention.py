"""Restart-safe hard-retention maintenance for VT00 synthetic product data.

The MCP runner deliberately destroys raw run identity at the signed deadline,
so it cannot be the final retry authority when the Gateway is unavailable.
This worker discovers exact expired obligations from three independent durable
product indexes (canonical sessions, Builder artifact metadata, and immutable
finalization receipts), holds a cross-instance PostgreSQL advisory lease, and
reuses the authoritative recovery components before deleting the final raw
identity. Only the existing HMAC recovery purge tombstone survives.

The worker is intentionally independent of both Voice Lab enable switches.
Those switches govern new work; they must never disable cleanup of work that
was admitted earlier.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any, Literal, Protocol

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.gateway.artifact_registry import ArtifactRecord, LocalArtifactRegistry
from app.gateway.voice_lab_capability import (
    VoiceLabClaims,
    voice_lab_session_record_matches,
)
from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.sophia.session_store import SessionRecord, SessionTranscriptStore

logger = logging.getLogger(__name__)

_WORKER_ATTR = "_voice_lab_retention_reaper"
_FINALIZATION_PREFIX = ".builder/voice_lab_evidence/finalizations/v2"
_FINALIZATION_MAX_BYTES = 2 * 1024 * 1024
_FINALIZATION_LIST_MAX = 10_000
_FINALIZATION_LIST_DEPTH = 4
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SHA = re.compile(r"^[a-f0-9]{40}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_CLEANUP_OBLIGATION_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_GLOBAL_LEASE_NAME = "sophia_voice_lab_retention_reaper_v1"
_LOCAL_LEASE = threading.Lock()
_TERMINAL = {"completed", "already_terminal", "not_found"}
_SOURCE_PRIORITY = {"cleanup": -1, "session": 0, "finalization": 1, "artifact": 2}
_LEASE_IO_TIMEOUT_SECONDS = 7.0
_STORE_IO_TIMEOUT_SECONDS = 12.0
_COMPONENT_TIMEOUT_SECONDS = 30.0
_DISCOVERY_MAX_CANDIDATES_PER_SOURCE = 10_000
_LEASE_HANDOFF_TASKS: set[asyncio.Task[object]] = set()


async def _settle_non_cancellable_thread(task: asyncio.Task[Any]) -> None:
    """Defer lease release until a started blocking mutation has truly ended."""

    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            # Repeated shutdown cancellation must not detach the worker thread.
            continue
        except Exception:  # noqa: BLE001 - caller observes the original outcome.
            break


async def _lease_fenced_to_thread(
    function: Callable[..., Any],
    *args: object,
    timeout: float,
    **kwargs: object,
) -> Any:
    """Run blocking I/O without ever releasing the lease around a live thread."""

    task = asyncio.create_task(
        asyncio.to_thread(partial(function, *args, **kwargs))
    )
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except TimeoutError:
        await _settle_non_cancellable_thread(task)
        raise
    except asyncio.CancelledError:
        await _settle_non_cancellable_thread(task)
        raise


def _canonical_utc_millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _parse_canonical_utc_millis(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    normalized = parsed.astimezone(UTC)
    return normalized if _canonical_utc_millis(normalized) == value else None


def voice_lab_retention_reaper_required() -> bool:
    value = (os.getenv("SOPHIA_VOICE_LAB_RETENTION_REAPER_REQUIRED") or "").strip()
    if value:
        return value.lower() in {"1", "true", "yes", "on"}
    return bool(
        (os.getenv("RENDER") or "").strip().lower() == "true"
        or (os.getenv("RENDER_SERVICE_ID") or "").strip()
        or (os.getenv("ENVIRONMENT") or "").strip().lower() == "production"
    )


def _bounded_int_env(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = (os.getenv(name) or str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} is invalid") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} is invalid")
    return value


class CleanupControlWorkBinding(BaseModel):
    """Content-free database work facts captured under the scan cursor."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    state: Literal["open", "closed"]
    lifecycle_phase: Literal[
        "auth_provisional", "session_provisional", "finalizing", "finalized"
    ]
    retention_expires_at: str
    provider_expires_at: str
    retention_due: bool
    provider_due: bool
    active_admissions: int = Field(ge=0)
    expired_admissions: int = Field(ge=0)

    @model_validator(mode="after")
    def _validate_deadlines(self) -> CleanupControlWorkBinding:
        retention = _parse_canonical_utc_millis(self.retention_expires_at)
        provider = _parse_canonical_utc_millis(self.provider_expires_at)
        if retention is None or provider is None or provider > retention:
            raise ValueError("cleanup control work deadline is invalid")
        return self


class RetentionObligation(BaseModel):
    """Safe exact binding reconstructed from one durable product index."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    source: Literal["cleanup", "session", "artifact", "finalization"]
    principal_id: str
    test_run_id: str
    scenario_id: str
    scenario_version: str
    environment: str
    cleanup_obligation_id: str
    retention_hours: int = Field(ge=1, le=168)
    retention_expires_at: str
    provider_expires_at: str
    expected_deployment: dict[str, str]
    voice_lab_run_id_sha256: str | None = None
    browser_worker_id_sha256: str | None = None
    browser_lease_epoch: int | None = None
    browser_context_id_sha256: str | None = None
    session_id: str | None = None
    thread_id: str | None = None
    cleanup_mode: Literal[
        "provisional_session", "canonical_session", "orphan_finalization"
    ] | None = None
    cleanup_handle_path: str | None = Field(default=None, exclude=True)
    cleanup_handle_grace_expires_at: str | None = None
    finalization_payload: dict[str, Any] | None = Field(default=None, exclude=True)
    cleanup_control: CleanupControlWorkBinding | None = Field(
        default=None,
        exclude=True,
    )

    @model_validator(mode="after")
    def _validate_exact_binding(self) -> RetentionObligation:
        for value in (
            self.principal_id,
            self.test_run_id,
            self.scenario_id,
            self.scenario_version,
            self.environment,
        ):
            if not _SAFE_ID.fullmatch(value):
                raise ValueError("retention obligation contains an invalid identifier")
        if not _CLEANUP_OBLIGATION_ID.fullmatch(self.cleanup_obligation_id):
            raise ValueError("retention obligation cleanup id is invalid")
        d02_values = (
            self.voice_lab_run_id_sha256,
            self.browser_worker_id_sha256,
            self.browser_lease_epoch,
            self.browser_context_id_sha256,
        )
        if self.scenario_id == "V-D02" and self.source == "session":
            if (
                not all(value is not None for value in d02_values)
                or not _SHA256.fullmatch(str(self.voice_lab_run_id_sha256))
                or not _SHA256.fullmatch(str(self.browser_worker_id_sha256))
                or not _SHA256.fullmatch(str(self.browser_context_id_sha256))
                or not isinstance(self.browser_lease_epoch, int)
                or isinstance(self.browser_lease_epoch, bool)
                or self.browser_lease_epoch <= 0
            ):
                raise ValueError("retention obligation D02 binding is invalid")
        elif self.scenario_id != "V-D02" and any(
            value is not None for value in d02_values
        ):
            raise ValueError("non-D02 retention obligation carried D02 binding")
        if set(self.expected_deployment) != {"frontend", "backend", "voice"}:
            raise ValueError("retention obligation deployment binding is incomplete")
        if any(
            not isinstance(value, str) or not _SHA.fullmatch(value)
            for value in self.expected_deployment.values()
        ):
            raise ValueError("retention obligation deployment binding is invalid")
        retention_deadline = _parse_canonical_utc_millis(
            self.retention_expires_at
        )
        provider_deadline = _parse_canonical_utc_millis(
            self.provider_expires_at
        )
        if (
            retention_deadline is None
            or provider_deadline is None
            or provider_deadline > retention_deadline
        ):
            raise ValueError("retention obligation expiry is not canonical")
        for value in (self.session_id, self.thread_id):
            if value is not None and (
                not isinstance(value, str)
                or not value
                or len(value) > 512
                or "\x00" in value
            ):
                raise ValueError("retention obligation resource id is invalid")
        if self.source == "cleanup":
            if (
                self.cleanup_mode is None
                or not isinstance(self.cleanup_handle_path, str)
                or not self.cleanup_handle_path
                or _parse_canonical_utc_millis(
                    self.cleanup_handle_grace_expires_at
                )
                is None
            ):
                raise ValueError("retention cleanup handle binding is incomplete")
        elif any(
            value is not None
            for value in (
                self.cleanup_mode,
                self.cleanup_handle_path,
                self.cleanup_handle_grace_expires_at,
            )
        ):
            raise ValueError("non-handle retention obligation carried handle state")
        if self.cleanup_control is not None and (
            self.cleanup_control.retention_expires_at
            != self.retention_expires_at
            or self.cleanup_control.provider_expires_at
            != self.provider_expires_at
        ):
            raise ValueError("cleanup control work binding conflicts")
        return self

    @property
    def identity(self) -> tuple[str, str]:
        return self.principal_id, self.test_run_id

    @property
    def deadline(self) -> datetime:
        parsed = _parse_canonical_utc_millis(self.retention_expires_at)
        if parsed is None:  # pragma: no cover - model invariant
            raise ValueError("retention obligation expiry is invalid")
        return parsed

    @property
    def binding(self) -> tuple[object, ...]:
        return (
            self.principal_id,
            self.test_run_id,
            self.scenario_id,
            self.scenario_version,
            self.environment,
            self.cleanup_obligation_id,
            self.retention_hours,
            self.provider_expires_at,
            tuple(sorted(self.expected_deployment.items())),
            self.voice_lab_run_id_sha256,
            self.browser_worker_id_sha256,
            self.browser_lease_epoch,
            self.browser_context_id_sha256,
        )

    def claims(self, *, now: datetime) -> VoiceLabClaims:
        issued_at = int(now.timestamp())
        raw: dict[str, Any] = {
            "v": 1,
            "iss": "sophia-gateway-retention-reaper",
            "aud": "sophia-voice-runtime",
            "sub": self.principal_id,
            "principal_id": self.principal_id,
            "test_run_id": self.test_run_id,
            "scenario_id": self.scenario_id,
            "scenario_version": self.scenario_version,
            "synthetic": True,
            "environment": self.environment,
            "cleanup_obligation_id": self.cleanup_obligation_id,
            "retention_hours": self.retention_hours,
            "provider_expires_at": self.provider_expires_at,
            "allowed_ops": ["session:recover"],
            "expected_deployment": dict(self.expected_deployment),
            "iat": issued_at,
            "nbf": issued_at,
            "exp": issued_at + 300,
            "jti": f"retention-reaper-{uuid.uuid4()}",
            "nonce": f"retention-reaper-{uuid.uuid4()}",
        }
        return VoiceLabClaims(
            principal_id=self.principal_id,
            test_run_id=self.test_run_id,
            scenario_id=self.scenario_id,
            scenario_version=self.scenario_version,
            environment=self.environment,
            cleanup_obligation_id=self.cleanup_obligation_id,
            retention_hours=self.retention_hours,
            provider_expires_at=self.provider_expires_at,
            allowed_ops=("session:recover",),
            expected_deployment=dict(self.expected_deployment),
            issued_at=issued_at,
            not_before=issued_at,
            expires_at=issued_at + 300,
            jti=str(raw["jti"]),
            nonce=str(raw["nonce"]),
            raw=raw,
            voice_lab_run_id_sha256=self.voice_lab_run_id_sha256,
            browser_worker_id_sha256=self.browser_worker_id_sha256,
            browser_lease_epoch=self.browser_lease_epoch,
            browser_context_id_sha256=self.browser_context_id_sha256,
        )


def _obligation_from_session(record: SessionRecord) -> RetentionObligation:
    metadata = record.metadata
    synthetic = metadata.get("synthetic_voice_lab")
    if not isinstance(synthetic, dict):
        raise ValueError("synthetic session metadata is unavailable")
    obligation = RetentionObligation(
        source="session",
        principal_id=record.user_id,
        test_run_id=str(record.run_id or ""),
        scenario_id=str(synthetic.get("scenario_id") or ""),
        scenario_version=str(synthetic.get("scenario_version") or ""),
        environment=str(synthetic.get("environment") or ""),
        cleanup_obligation_id=str(synthetic.get("cleanup_obligation_id") or ""),
        retention_hours=synthetic.get("retention_hours"),
        retention_expires_at=synthetic.get("retention_expires_at"),
        provider_expires_at=synthetic.get("provider_expires_at"),
        expected_deployment=metadata.get("expected_deployment"),
        session_id=record.session_id,
        thread_id=record.thread_id,
        voice_lab_run_id_sha256=synthetic.get("voice_lab_run_id_sha256"),
        browser_worker_id_sha256=synthetic.get("browser_worker_id_sha256"),
        browser_lease_epoch=synthetic.get("browser_lease_epoch"),
        browser_context_id_sha256=synthetic.get("browser_context_id_sha256"),
    )
    if not voice_lab_session_record_matches(
        record,
        obligation.claims(now=datetime.now(UTC)),
    ):
        raise ValueError("synthetic session retention binding is invalid")
    return obligation


def _artifact_expected_deployment(record: ArtifactRecord) -> dict[str, str]:
    deployment = record.deployment_identity or {}
    return {
        "frontend": str(deployment.get("frontend_sha") or ""),
        "backend": str(deployment.get("backend_sha") or ""),
        "voice": str(deployment.get("voice_sha") or ""),
    }


def _obligation_from_artifact(record: ArtifactRecord) -> RetentionObligation:
    if not record.synthetic_test or record.test_principal_id != record.user_id:
        raise ValueError("artifact is not an exact synthetic record")
    return RetentionObligation(
        source="artifact",
        principal_id=record.user_id,
        test_run_id=record.test_run_id,
        scenario_id=record.scenario_id,
        scenario_version=record.scenario_version,
        environment=record.environment,
        cleanup_obligation_id=record.cleanup_obligation_id,
        retention_hours=record.retention_hours,
        retention_expires_at=record.retention_expires_at,
        provider_expires_at=record.provider_expires_at,
        expected_deployment=_artifact_expected_deployment(record),
        session_id=record.session_id,
        thread_id=record.parent_thread_id or record.thread_id,
    )


def _attach_cleanup_control_work(
    obligation: RetentionObligation,
    work: Any,
) -> RetentionObligation:
    retention_text = _canonical_utc_millis(work.retention_expires_at)
    provider_text = _canonical_utc_millis(work.provider_expires_at)
    if (
        obligation.cleanup_obligation_id != work.cleanup_obligation_id
        or obligation.retention_expires_at != retention_text
        or obligation.provider_expires_at != provider_text
    ):
        raise ValueError("cleanup control work binding conflicts")
    binding = CleanupControlWorkBinding(
        state=work.state,
        lifecycle_phase=work.lifecycle_phase,
        retention_expires_at=retention_text,
        provider_expires_at=provider_text,
        retention_due=work.retention_due,
        provider_due=work.provider_due,
        active_admissions=sum(not admission.expired for admission in work.admissions),
        expired_admissions=sum(admission.expired for admission in work.admissions),
    )
    return obligation.model_copy(update={"cleanup_control": binding})


def _validate_finalization_payload(
    payload: object,
    *,
    object_path: str | None = None,
) -> RetentionObligation:
    from app.gateway.routers.sophia import _SYNTHETIC_FINALIZATION_EXCLUSIONS

    if not isinstance(payload, dict):
        raise ValueError("synthetic finalization receipt is malformed")
    transcript = payload.get("canonical_transcript")
    finalized_at = _parse_canonical_utc_millis(payload.get("finalized_at"))
    expires_at = _parse_canonical_utc_millis(payload.get("retention_expires_at"))
    provider_expires_at = _parse_canonical_utc_millis(
        payload.get("provider_expires_at")
    )
    retention_hours = payload.get("retention_hours")
    if (
        payload.get("schema") != "sophia_voice_lab_finalization_v1"
        or payload.get("status") != "synthetic_isolated"
        or payload.get("synthetic") is not True
        or not isinstance(retention_hours, int)
        or isinstance(retention_hours, bool)
        or not 1 <= retention_hours <= 168
        or payload.get("retention_anchor") != "finalized_at"
        or finalized_at is None
        or expires_at is None
        or provider_expires_at is None
        or provider_expires_at > expires_at
        or expires_at != finalized_at + timedelta(hours=retention_hours)
        or payload.get("ended_at") != payload.get("finalized_at")
        or payload.get("exclusions") != _SYNTHETIC_FINALIZATION_EXCLUSIONS
        or not isinstance(transcript, dict)
        or transcript.get("finalized_at") != payload.get("finalized_at")
        or transcript.get("retention_hours") != retention_hours
        or transcript.get("retention_anchor") != "finalized_at"
        or transcript.get("retention_expires_at") != payload.get("retention_expires_at")
        or transcript.get("provider_expires_at")
        != payload.get("provider_expires_at")
        or transcript.get("cleanup_obligation_id")
        != payload.get("cleanup_obligation_id")
    ):
        raise ValueError("synthetic finalization retention binding is invalid")
    obligation = RetentionObligation(
        source="finalization",
        principal_id=payload.get("principal_id"),
        test_run_id=payload.get("test_run_id"),
        scenario_id=payload.get("scenario_id"),
        scenario_version=payload.get("scenario_version"),
        environment=payload.get("environment"),
        cleanup_obligation_id=payload.get("cleanup_obligation_id"),
        retention_hours=retention_hours,
        retention_expires_at=payload.get("retention_expires_at"),
        provider_expires_at=payload.get("provider_expires_at"),
        expected_deployment=payload.get("expected_deployment"),
        session_id=payload.get("session_id"),
        thread_id=payload.get("thread_id"),
        finalization_payload=dict(payload),
    )
    expected_path = f"{_FINALIZATION_PREFIX}/{obligation.cleanup_obligation_id}.json"
    if object_path is not None and object_path != expected_path:
        raise ValueError("synthetic finalization path binding is invalid")
    return obligation


class _FinalizationScanner(Protocol):
    def __call__(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> tuple[list[RetentionObligation], int]: ...


class _CleanupHandleScanner(Protocol):
    def __call__(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> tuple[list[PreparedCleanupIntent], int]: ...


class _CleanupFenceScanner(Protocol):
    def __call__(
        self,
        *,
        limit: int,
        max_scan: int = 10_000,
        advance: bool = True,
    ) -> tuple[tuple[Any, ...], bool]: ...


class _CompletedFencePurger(Protocol):
    def __call__(
        self,
        *,
        eligibility_check: Callable[[str], bool],
        limit: int,
        max_scan: int = 1000,
    ) -> int: ...


def scan_cleanup_control_work(
    *,
    limit: int,
    max_scan: int = 10_000,
    advance: bool = True,
) -> tuple[tuple[Any, ...], bool]:
    from deerflow.sophia.cleanup_fence import scan_cleanup_fence_work

    return scan_cleanup_fence_work(
        limit=limit,
        max_scan=max_scan,
        advance=advance,
    )


def purge_completed_cleanup_control(
    *,
    eligibility_check: Callable[[str], bool],
    limit: int,
    max_scan: int = 1000,
) -> int:
    from deerflow.sophia.cleanup_fence import purge_completed_cleanup_obligations

    return purge_completed_cleanup_obligations(
        eligibility_check=eligibility_check,
        limit=limit,
        max_scan=max_scan,
    )


class PreparedCleanupIntent(BaseModel):
    """Short-lived content-free authority keyed only by an opaque UUID."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    cleanup_obligation_id: str
    prepared_at: str
    retention_expires_at: str
    provider_expires_at: str
    control_expires_at: str
    cleanup_mode: Literal[
        "provisional_session",
        "canonical_session",
        "orphan_finalization",
        "builder_global",
    ]
    retention_sla_missed: bool
    overdue_seconds_at_preparation: int = Field(ge=0)
    object_path: str = Field(exclude=True)

    @model_validator(mode="after")
    def _validate_intent(self) -> PreparedCleanupIntent:
        if not _CLEANUP_OBLIGATION_ID.fullmatch(self.cleanup_obligation_id):
            raise ValueError("cleanup intent id is invalid")
        deadline = _parse_canonical_utc_millis(self.retention_expires_at)
        provider_deadline = _parse_canonical_utc_millis(
            self.provider_expires_at
        )
        prepared = _parse_canonical_utc_millis(self.prepared_at)
        control = _parse_canonical_utc_millis(self.control_expires_at)
        if (
            deadline is None
            or provider_deadline is None
            or provider_deadline > deadline
            or prepared is None
            or prepared < deadline
            or self.retention_sla_missed
            != (prepared > deadline + timedelta(hours=1))
            or self.overdue_seconds_at_preparation
            != max(0, int((prepared - deadline).total_seconds()))
            or control
            != (
                prepared + timedelta(hours=1)
                if self.retention_sla_missed
                else deadline + timedelta(hours=1)
            )
        ):
            raise ValueError("cleanup intent control window is invalid")
        expected_path = (
            ".builder/voice_lab_evidence/retention-cleanup-intents/v2/"
        )
        if not self.object_path.startswith(expected_path):
            raise ValueError("cleanup intent path is invalid")
        return self

    @property
    def deadline(self) -> datetime:
        parsed = _parse_canonical_utc_millis(self.retention_expires_at)
        if parsed is None:  # pragma: no cover - model invariant.
            raise ValueError("cleanup intent deadline is invalid")
        return parsed

    @property
    def control_deadline(self) -> datetime:
        parsed = _parse_canonical_utc_millis(self.control_expires_at)
        if parsed is None:  # pragma: no cover - model invariant.
            raise ValueError("cleanup intent control deadline is invalid")
        return parsed


def _read_local_finalizations(
    *,
    now: datetime,
    limit: int,
) -> tuple[list[RetentionObligation], int]:
    obligations: list[RetentionObligation] = []
    invalid = 0
    root = Path(USERS_DIR)
    if not root.is_dir():
        return obligations, invalid
    for path in sorted(root.glob("*/synthetic_voice_lab/finalizations/*.json")):
        if len(obligations) >= limit:
            break
        try:
            if path.stat().st_size > _FINALIZATION_MAX_BYTES:
                raise ValueError("synthetic finalization receipt is oversized")
            payload = json.loads(path.read_text(encoding="utf-8"))
            obligation = _validate_finalization_payload(payload)
            expected = (
                root
                / obligation.principal_id
                / "synthetic_voice_lab"
                / "finalizations"
                / f"{obligation.cleanup_obligation_id}.json"
            )
            if path != expected:
                raise ValueError("synthetic local finalization path binding is invalid")
            if obligation.deadline <= now:
                obligations.append(obligation)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            invalid += 1
    return obligations, invalid


def scan_expired_finalizations(
    *,
    now: datetime,
    limit: int,
) -> tuple[list[RetentionObligation], int]:
    """Discover due immutable receipts without logging their raw content."""

    from deerflow.sophia.storage import supabase_artifact_store

    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10_000:
        raise ValueError("synthetic finalization scan limit must be between 1 and 10000")
    obligations: list[RetentionObligation] = []
    invalid = 0
    if supabase_artifact_store.is_configured():
        paths = supabase_artifact_store.list_artifact_object_paths_bounded(
            _FINALIZATION_PREFIX,
            max_objects=_FINALIZATION_LIST_MAX,
            max_depth=_FINALIZATION_LIST_DEPTH,
            page_size=100,
        )
        for object_path in sorted(paths):
            if len(obligations) >= limit:
                break
            try:
                stored = supabase_artifact_store.download_artifact_object_bounded(
                    object_path,
                    max_bytes=_FINALIZATION_MAX_BYTES,
                )
                if stored is None:
                    continue
                raw, content_type = stored
                if content_type.split(";", 1)[0].strip().lower() != "application/json":
                    raise ValueError("synthetic finalization content type drifted")
                obligation = _validate_finalization_payload(
                    json.loads(raw.decode("utf-8")),
                    object_path=object_path,
                )
                if obligation.deadline <= now:
                    obligations.append(obligation)
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                invalid += 1
    local, local_invalid = _read_local_finalizations(now=now, limit=limit)
    invalid += local_invalid
    by_identity = {obligation.identity: obligation for obligation in obligations}
    for obligation in local:
        by_identity.setdefault(obligation.identity, obligation)
    return sorted(
        by_identity.values(),
        key=lambda item: (item.deadline, item.principal_id, item.test_run_id),
    )[:limit], invalid


def scan_retention_cleanup_handles(
    *,
    now: datetime,
    limit: int,
) -> tuple[list[PreparedCleanupIntent], int]:
    """Read bounded opaque PREPARED authorities for restart recovery."""

    from app.gateway.routers import voice_lab_recovery as recovery

    opened, invalid = recovery._list_retention_cleanup_handles_bounded(limit=limit)
    obligations: list[PreparedCleanupIntent] = []
    for object_path, payload, envelope in opened:
        try:
            obligation = PreparedCleanupIntent(
                cleanup_obligation_id=payload.get("cleanup_obligation_id"),
                prepared_at=payload.get("prepared_at"),
                retention_expires_at=payload.get("retention_expires_at"),
                provider_expires_at=payload.get("provider_expires_at"),
                control_expires_at=payload.get("control_expires_at"),
                cleanup_mode=payload.get("cleanup_mode"),
                retention_sla_missed=payload.get("retention_sla_missed"),
                overdue_seconds_at_preparation=payload.get(
                    "overdue_seconds_at_preparation"
                ),
                object_path=object_path,
            )
            if obligation.deadline > now:
                raise ValueError("retention cleanup intent predates its signed deadline")
            if obligation.retention_sla_missed:
                invalid += 1
            if now >= obligation.control_deadline:
                # The content-free UUID authority remains actionable until
                # COMPLETE, but an exceeded control target must keep Voice Lab
                # admission/readiness degraded rather than silently extending
                # the retention SLA.
                invalid += 1
            obligations.append(obligation)
        except (TypeError, ValueError):
            invalid += 1
    return sorted(
        obligations,
        key=lambda item: (item.deadline, item.cleanup_obligation_id),
    )[:limit], invalid


@dataclass
class _RetentionLeaseHandle:
    acquired: bool
    connection: Any | None = None
    cursor: Any | None = None
    local_lock_held: bool = False

    def close(self) -> None:
        try:
            if self.acquired and self.cursor is not None:
                self.cursor.execute(
                    "SELECT pg_advisory_unlock(hashtextextended(%s, 731943))",
                    (_GLOBAL_LEASE_NAME,),
                )
        finally:
            try:
                if self.cursor is not None:
                    self.cursor.close()
            finally:
                try:
                    if self.connection is not None:
                        self.connection.close()
                finally:
                    if self.local_lock_held:
                        self.local_lock_held = False
                        _LOCAL_LEASE.release()


def _acquire_retention_reaper_lease() -> _RetentionLeaseHandle:
    """Blocking lease primitive; callers must execute it off the event loop."""

    if not _LOCAL_LEASE.acquire(timeout=5.0):
        return _RetentionLeaseHandle(acquired=False)
    handle = _RetentionLeaseHandle(acquired=False, local_lock_held=True)
    dsn = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()
    try:
        if not dsn:
            if voice_lab_retention_reaper_required():
                raise RuntimeError("voice lab retention reaper lease database is unavailable")
            handle.acquired = True
            return handle
        import psycopg

        handle.connection = psycopg.connect(dsn, connect_timeout=5, autocommit=True)
        handle.cursor = handle.connection.cursor()
        handle.cursor.execute(
            "SELECT pg_try_advisory_lock(hashtextextended(%s, 731943))",
            (_GLOBAL_LEASE_NAME,),
        )
        row = handle.cursor.fetchone()
        handle.acquired = bool(row and row[0] is True)
        if not handle.acquired:
            handle.close()
        return handle
    except Exception:
        handle.close()
        raise


def _retain_lease_handoff(task: asyncio.Task[object]) -> None:
    """Keep a timed-out lease handoff alive until it releases its handle."""

    _LEASE_HANDOFF_TASKS.add(task)

    def _consume(completed: asyncio.Task[object]) -> None:
        _LEASE_HANDOFF_TASKS.discard(completed)
        try:
            completed.result()
        except BaseException:  # noqa: BLE001 - cleanup is best-effort and content-free.
            logger.error(
                "Voice Lab retention lease handoff failed contentExcluded=true",
                exc_info=False,
            )

    task.add_done_callback(_consume)


async def _close_retention_lease_handle(handle: _RetentionLeaseHandle) -> None:
    close_task: asyncio.Task[object] = asyncio.create_task(
        asyncio.to_thread(handle.close)
    )
    try:
        await asyncio.wait_for(
            asyncio.shield(close_task),
            timeout=_LEASE_IO_TIMEOUT_SECONDS,
        )
    except BaseException:
        # asyncio.to_thread cannot be cancelled. Retain the task so the local
        # and PostgreSQL leases are still released after our caller times out
        # or is cancelled.
        _retain_lease_handoff(close_task)
        raise


async def _close_late_lease_handle(
    acquisition_task: asyncio.Task[_RetentionLeaseHandle],
) -> None:
    try:
        handle = await acquisition_task
    except BaseException:
        return
    await _close_retention_lease_handle(handle)


@asynccontextmanager
async def retention_reaper_lease():  # noqa: ANN201
    """Hold the sync PostgreSQL lease without blocking ordinary requests."""

    acquisition_task = asyncio.create_task(
        asyncio.to_thread(_acquire_retention_reaper_lease)
    )
    try:
        handle = await asyncio.wait_for(
            asyncio.shield(acquisition_task),
            timeout=_LEASE_IO_TIMEOUT_SECONDS,
        )
    except BaseException:
        # A worker thread is not cancellable. Hand its eventual result to a
        # retained cleanup task so a late advisory-lock acquisition can never
        # become an orphaned permanent lease.
        handoff: asyncio.Task[object] = asyncio.create_task(
            _close_late_lease_handle(acquisition_task)
        )
        _retain_lease_handoff(handoff)
        raise
    try:
        yield handle.acquired
    finally:
        if handle.acquired or handle.local_lock_held:
            await _close_retention_lease_handle(handle)


@dataclass(frozen=True)
class RetentionCycleResult:
    lease_acquired: bool = False
    discovered: int = 0
    completed: int = 0
    pending: int = 0
    conflicts: int = 0
    malformed: int = 0
    discovery_failed: bool = False
    processing_failed: int = 0


class VoiceLabRetentionReaper:
    """Bounded, rate-limited, restart-safe synthetic retention worker."""

    def __init__(
        self,
        *,
        session_store: SessionTranscriptStore,
        artifact_registry: LocalArtifactRegistry,
        interval_seconds: int = 60,
        batch_size: int = 25,
        finalization_scanner: _FinalizationScanner = scan_expired_finalizations,
        cleanup_handle_scanner: _CleanupHandleScanner = scan_retention_cleanup_handles,
        cleanup_fence_scanner: _CleanupFenceScanner = scan_cleanup_control_work,
        completed_fence_purger: _CompletedFencePurger = (
            purge_completed_cleanup_control
        ),
        lease_factory: Callable[[], Any] = retention_reaper_lease,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not 5 <= interval_seconds <= 3600:
            raise ValueError("voice lab retention reaper interval is invalid")
        if not 1 <= batch_size <= 100:
            raise ValueError("voice lab retention reaper batch size is invalid")
        self._session_store = session_store
        self._artifact_registry = artifact_registry
        self._interval_seconds = interval_seconds
        self._batch_size = batch_size
        self._scan_finalizations = finalization_scanner
        self._scan_cleanup_handles = cleanup_handle_scanner
        self._scan_cleanup_fences = cleanup_fence_scanner
        self._purge_completed_fences = completed_fence_purger
        self._lease_factory = lease_factory
        self._clock = clock or (lambda: datetime.now(UTC))
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._last_cycle: RetentionCycleResult | None = None
        self._last_cycle_at: str | None = None
        self._last_error_type: str | None = None

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(
            self._run_loop(),
            name="voice-lab-retention-reaper",
        )

    async def stop(self) -> None:
        self._stop.set()
        task = self._task
        self._task = None
        if task is None:
            return
        try:
            await asyncio.wait_for(task, timeout=5.0)
        except TimeoutError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def readiness(self) -> dict[str, object]:
        running = self._task is not None and not self._task.done()
        cycle = self._last_cycle
        degraded = self._last_error_type is not None or bool(
            cycle and (
                cycle.discovery_failed
                or cycle.processing_failed
                or cycle.pending
                or cycle.conflicts
                or cycle.malformed
            )
        )
        return {
            "status": "degraded" if degraded else "ready" if running else "not_started",
            "running": running,
            "last_cycle_at": self._last_cycle_at,
            "last_error_type": self._last_error_type,
            "last_cycle": (
                {
                    "lease_acquired": cycle.lease_acquired,
                    "discovered": cycle.discovered,
                    "completed": cycle.completed,
                    "pending": cycle.pending,
                    "conflicts": cycle.conflicts,
                    "malformed": cycle.malformed,
                    "discovery_failed": cycle.discovery_failed,
                    "processing_failed": cycle.processing_failed,
                }
                if cycle is not None
                else None
            ),
            "raw_identity_excluded": True,
        }

    async def _run_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.run_once()
            except Exception as exc:  # noqa: BLE001 - heartbeat is content-free.
                self._last_error_type = type(exc).__name__
                logger.error(
                    "Voice Lab retention reaper cycle failed error_type=%s contentExcluded=true",
                    type(exc).__name__,
                    exc_info=False,
                )
            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=self._interval_seconds,
                )
            except TimeoutError:
                continue

    def _discover_cleanup_control(
        self,
        now: datetime,
    ) -> tuple[list[RetentionObligation], int]:
        """Advance the durable DB queue independently of legacy indexes."""

        from app.gateway.routers import voice_lab_recovery as recovery

        faults = 0
        candidates: list[RetentionObligation] = []
        cleanup_works, _cleanup_work_truncated = self._scan_cleanup_fences(
            limit=self._batch_size,
            max_scan=_DISCOVERY_MAX_CANDIDATES_PER_SOURCE,
            advance=True,
        )
        for work in cleanup_works:
            try:
                resolved: list[RetentionObligation] = []
                session = self._session_store.find_session_by_cleanup_obligation_id(
                    work.cleanup_obligation_id
                )
                if session is not None:
                    resolved.append(_obligation_from_session(session))
                resolved.extend(
                    _obligation_from_artifact(record)
                    for record in self._artifact_registry.synthetic_cleanup_obligation_records(
                        cleanup_obligation_id=work.cleanup_obligation_id,
                    )
                )
                finalization = _load_finalization_by_cleanup_obligation_id(
                    work.cleanup_obligation_id
                )
                if finalization is not None:
                    resolved.append(finalization)
                if not resolved:
                    opaque = recovery._finish_database_cleanup_fence_work(
                        work,
                        now=now,
                    )
                    if opaque.get("status") not in {
                        "completed",
                        "already_terminal",
                    }:
                        faults += 1
                    continue
                attached = [
                    _attach_cleanup_control_work(candidate, work)
                    for candidate in resolved
                ]
                if any(
                    candidate.binding != attached[0].binding
                    for candidate in attached[1:]
                ):
                    faults += 1
                    continue
                candidates.extend(attached)
            except (OSError, RuntimeError, TypeError, ValueError):
                faults += 1
        selected: dict[tuple[str, str], RetentionObligation] = {}
        for candidate in sorted(
            candidates,
            key=lambda item: (
                item.deadline,
                _SOURCE_PRIORITY[item.source],
                item.principal_id,
                item.test_run_id,
            ),
        ):
            current = selected.get(candidate.identity)
            if current is None or (
                _SOURCE_PRIORITY[candidate.source]
                < _SOURCE_PRIORITY[current.source]
            ):
                selected[candidate.identity] = candidate
        return list(selected.values())[: self._batch_size], faults

    def _discover(
        self,
        now: datetime,
        *,
        cleanup_control_candidates: tuple[RetentionObligation, ...] = (),
        cleanup_control_faults: int = 0,
    ) -> tuple[list[RetentionObligation], int, int]:
        # Source limits are expanded until a full process batch survives
        # obligation validation and cross-source conflict removal. This keeps
        # an earliest page of parseable-but-invalid/conflicting rows from
        # occupying every cycle forever while preserving a strict scan cap.
        from app.gateway.routers import builder_events
        from app.gateway.routers import voice_lab_recovery as recovery

        async def sweep_builder() -> dict[str, object]:
            return await asyncio.wait_for(
                builder_events.reap_expired_synthetic_builder_obligations(
                    now=now,
                    limit=self._batch_size,
                    artifact_registry=self._artifact_registry,
                ),
                timeout=_STORE_IO_TIMEOUT_SECONDS,
            )

        builder_sweep = asyncio.run(sweep_builder())
        completed_handles = builder_sweep.pop("_completed_cleanup_handles", [])
        builder_faults = int(builder_sweep.get("malformed") or 0) + int(
            builder_sweep.get("pending") or 0
        )
        if builder_sweep.get("discovery_complete") is not True:
            builder_faults += 1
        if not isinstance(completed_handles, list):
            raise RuntimeError("synthetic Builder sweep handoff drifted")
        for completed_handle in completed_handles:
            if (
                not isinstance(completed_handle, tuple)
                or len(completed_handle) != 2
                or not all(isinstance(value, str) for value in completed_handle)
            ):
                raise RuntimeError("synthetic Builder sweep handoff drifted")
            cleanup_obligation_id, object_path = completed_handle
            finish = recovery._finish_retention_cleanup_intent(
                cleanup_obligation_id,
                expected_path=object_path,
                now=now,
            )
            if finish.get("status") not in {"completed", "already_terminal"}:
                builder_faults += 1

        scan_limit = self._batch_size
        while True:
            sessions = self._session_store.expired_synthetic_sessions(
                now=now,
                limit=scan_limit,
            )
            artifacts = self._artifact_registry.expired_synthetic_records_global(
                now=now,
                limit=scan_limit,
            )
            finalizations, malformed = self._scan_finalizations(
                now=now,
                limit=scan_limit,
            )
            cleanup_intents, cleanup_invalid = self._scan_cleanup_handles(
                now=now,
                limit=scan_limit,
            )
            malformed += cleanup_invalid + builder_faults + cleanup_control_faults
            candidates: list[RetentionObligation] = list(
                cleanup_control_candidates
            )
            for record in sessions:
                try:
                    candidates.append(_obligation_from_session(record))
                except (TypeError, ValueError):
                    malformed += 1
            for record in artifacts:
                try:
                    candidates.append(_obligation_from_artifact(record))
                except (TypeError, ValueError):
                    malformed += 1
            candidates.extend(finalizations)
            blocked_cleanup_ids: set[str] = set()
            for intent in cleanup_intents:
                resolved: list[RetentionObligation] = []
                try:
                    session = self._session_store.find_session_by_cleanup_obligation_id(
                        intent.cleanup_obligation_id
                    )
                    if session is not None:
                        resolved.append(_obligation_from_session(session))
                    resolved.extend(
                        _obligation_from_artifact(record)
                        for record in self._artifact_registry.synthetic_cleanup_obligation_records(
                            cleanup_obligation_id=intent.cleanup_obligation_id,
                        )
                    )
                    finalization = _load_finalization_by_cleanup_obligation_id(
                        intent.cleanup_obligation_id
                    )
                    if finalization is not None:
                        resolved.append(finalization)
                    if not resolved:
                        finish = recovery._finish_retention_cleanup_intent(
                            intent.cleanup_obligation_id,
                            expected_path=intent.object_path,
                            now=now,
                        )
                        if finish.get("status") not in {
                            "completed",
                            "already_terminal",
                        }:
                            malformed += 1
                        continue
                    if any(
                        candidate.cleanup_obligation_id
                        != intent.cleanup_obligation_id
                        or candidate.retention_expires_at
                        != intent.retention_expires_at
                        for candidate in resolved
                    ):
                        blocked_cleanup_ids.add(intent.cleanup_obligation_id)
                        continue
                    candidates.extend(resolved)
                except (OSError, RuntimeError, TypeError, ValueError):
                    blocked_cleanup_ids.add(intent.cleanup_obligation_id)
                    malformed += 1
            candidates.sort(
                key=lambda item: (
                    item.deadline,
                    _SOURCE_PRIORITY[item.source],
                    item.principal_id,
                    item.test_run_id,
                )
            )
            selected: dict[tuple[str, str], RetentionObligation] = {}
            conflicts: set[tuple[str, str]] = set()
            cleanup_bindings: dict[str, tuple[object, ...]] = {}
            cleanup_conflicts: set[str] = set(blocked_cleanup_ids)
            for candidate in candidates:
                prior_cleanup_binding = cleanup_bindings.get(
                    candidate.cleanup_obligation_id
                )
                if (
                    prior_cleanup_binding is not None
                    and prior_cleanup_binding != candidate.binding
                ):
                    cleanup_conflicts.add(candidate.cleanup_obligation_id)
                    continue
                cleanup_bindings[candidate.cleanup_obligation_id] = candidate.binding
                current = selected.get(candidate.identity)
                if current is None:
                    selected[candidate.identity] = candidate
                    continue
                if current.binding != candidate.binding:
                    conflicts.add(candidate.identity)
                    continue
                if _SOURCE_PRIORITY[candidate.source] < _SOURCE_PRIORITY[current.source]:
                    selected[candidate.identity] = candidate
            for identity in conflicts:
                selected.pop(identity, None)
            for identity, candidate in list(selected.items()):
                if candidate.cleanup_obligation_id in cleanup_conflicts:
                    selected.pop(identity, None)
            conflicts.update(
                candidate.identity
                for candidate in candidates
                if candidate.cleanup_obligation_id in cleanup_conflicts
            )
            due = sorted(
                selected.values(),
                key=lambda item: (item.deadline, item.principal_id, item.test_run_id),
            )
            saturated = any(
                len(source) >= scan_limit
                for source in (sessions, artifacts, finalizations, cleanup_intents)
            )
            if (
                not saturated
                or scan_limit >= _DISCOVERY_MAX_CANDIDATES_PER_SOURCE
            ):
                if len(due) <= self._batch_size:
                    batch = due
                else:
                    # A full earliest batch can remain pending for many cycles
                    # during a provider outage. Select a deterministic page
                    # from the complete bounded due set so later obligations
                    # still make progress. The wall-clock slot is restart-safe:
                    # a replacement replica continues the same rotation without
                    # persisting raw principal/run cursor state.
                    page_count = (len(due) + self._batch_size - 1) // self._batch_size
                    cycle_slot = int(now.timestamp()) // self._interval_seconds
                    page_index = cycle_slot % page_count
                    start = page_index * self._batch_size
                    batch = due[start : start + self._batch_size]
                return batch, malformed, len(conflicts)
            scan_limit = min(
                scan_limit * 2,
                _DISCOVERY_MAX_CANDIDATES_PER_SOURCE,
            )

    async def run_once(self) -> RetentionCycleResult:
        now = self._clock().astimezone(UTC)
        try:
            async with self._lease_factory() as acquired:
                if not acquired:
                    result = RetentionCycleResult(lease_acquired=False)
                    self._record_cycle(result, now=now)
                    return result
                discovery_failed = False
                cleanup_control_candidates: list[RetentionObligation] = []
                cleanup_control_faults = 0
                try:
                    (
                        cleanup_control_candidates,
                        cleanup_control_faults,
                    ) = await _lease_fenced_to_thread(
                        self._discover_cleanup_control,
                        now,
                        timeout=_STORE_IO_TIMEOUT_SECONDS,
                    )
                except Exception as exc:  # noqa: BLE001 - DB queue retries durably.
                    discovery_failed = True
                    self._last_error_type = type(exc).__name__
                try:
                    obligations, malformed, conflicts = await _lease_fenced_to_thread(
                        self._discover,
                        now,
                        cleanup_control_candidates=tuple(
                            cleanup_control_candidates
                        ),
                        cleanup_control_faults=cleanup_control_faults,
                        timeout=_STORE_IO_TIMEOUT_SECONDS,
                    )
                except Exception as exc:  # noqa: BLE001 - retry from durable indexes.
                    discovery_failed = True
                    self._last_error_type = type(exc).__name__
                    obligations = cleanup_control_candidates
                    malformed = cleanup_control_faults
                    conflicts = 0
                completed = 0
                pending = 0
                processing_failed = 0
                for obligation in obligations:
                    try:
                        processed = await self._process(obligation, now=now)
                    except Exception as exc:  # noqa: BLE001 - isolate poisoned due runs.
                        processed = False
                        processing_failed += 1
                        self._last_error_type = type(exc).__name__
                        logger.error(
                            "Voice Lab retention obligation failed error_type=%s contentExcluded=true",
                            type(exc).__name__,
                            exc_info=False,
                        )
                    if processed:
                        completed += 1
                    else:
                        pending += 1
                    await asyncio.sleep(0)
                from app.gateway.routers import voice_lab_recovery as recovery

                try:
                    await _lease_fenced_to_thread(
                        self._purge_completed_fences,
                        eligibility_check=(
                            recovery._completed_cleanup_fence_purge_eligible
                        ),
                        limit=self._batch_size,
                        max_scan=_DISCOVERY_MAX_CANDIDATES_PER_SOURCE,
                        timeout=_STORE_IO_TIMEOUT_SECONDS,
                    )
                except Exception as exc:  # noqa: BLE001 - retry from COMPLETE.
                    processing_failed += 1
                    self._last_error_type = type(exc).__name__
                result = RetentionCycleResult(
                    lease_acquired=True,
                    discovered=len(obligations),
                    completed=completed,
                    pending=pending,
                    conflicts=conflicts,
                    malformed=malformed,
                    discovery_failed=discovery_failed,
                    processing_failed=processing_failed,
                )
                self._record_cycle(result, now=now)
                return result
        except Exception as exc:  # noqa: BLE001 - typed heartbeat, durable retry.
            self._last_error_type = type(exc).__name__
            result = RetentionCycleResult(
                lease_acquired=False,
                discovery_failed=True,
            )
            self._record_cycle(result, now=now)
            return result

    def _probe_durable_indexes(self, now: datetime) -> None:
        """Bounded schema/connectivity probe with no cleanup side effects."""

        from app.gateway.routers import voice_lab_recovery as recovery

        recovery._assert_auth_tombstone_keyring_drain_ready_sync()
        from deerflow.sophia.cleanup_fence import probe_cleanup_scan_cursors

        probe_cleanup_scan_cursors()
        self._session_store.expired_synthetic_sessions(now=now, limit=1)
        self._artifact_registry.expired_synthetic_records_global(now=now, limit=1)
        self._scan_finalizations(now=now, limit=1)
        self._scan_cleanup_handles(now=now, limit=1)
        self._scan_cleanup_fences(limit=1, max_scan=1, advance=False)

    async def probe(self) -> RetentionCycleResult:
        """Probe lease/index availability without processing a retention backlog."""

        now = self._clock().astimezone(UTC)
        try:
            async with self._lease_factory() as acquired:
                # Read-only schema/key-drain attestation is safe without the
                # destructive advisory lease and must run on every replica.
                # Lease contention alone remains a healthy rolling-deploy state.
                await _lease_fenced_to_thread(
                    self._probe_durable_indexes,
                    now,
                    timeout=_STORE_IO_TIMEOUT_SECONDS,
                )
                result = RetentionCycleResult(lease_acquired=bool(acquired))
                self._record_cycle(result, now=now)
                return result
        except Exception as exc:  # noqa: BLE001 - typed fail-closed probe.
            self._last_error_type = type(exc).__name__
            result = RetentionCycleResult(
                lease_acquired=False,
                discovery_failed=True,
            )
            self._record_cycle(result, now=now)
            return result

    def _record_cycle(self, result: RetentionCycleResult, *, now: datetime) -> None:
        self._last_cycle = result
        self._last_cycle_at = _canonical_utc_millis(now)
        if not result.discovery_failed and not result.processing_failed:
            self._last_error_type = None

    async def _process(self, obligation: RetentionObligation, *, now: datetime) -> bool:
        from app.gateway.routers import voice_lab_recovery as recovery

        cleanup_obligation = obligation if obligation.source == "cleanup" else None
        discovered_control = obligation.cleanup_control
        claims = obligation.claims(now=now)
        try:
            record_by_cleanup = await _lease_fenced_to_thread(
                self._session_store.find_session_by_cleanup_obligation_id,
                claims.cleanup_obligation_id,
                timeout=_STORE_IO_TIMEOUT_SECONDS,
            )
            record_by_run = await _lease_fenced_to_thread(
                self._session_store.find_session_by_run_id,
                claims.principal_id,
                claims.test_run_id,
                timeout=_STORE_IO_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001 - preserve durable discovery authority.
            return False
        if record_by_cleanup is not record_by_run and (
            record_by_cleanup is None
            or record_by_run is None
            or record_by_cleanup.session_id != record_by_run.session_id
        ):
            return False
        record = record_by_cleanup
        if record is not None and not voice_lab_session_record_matches(record, claims):
            return False
        if (
            record is not None
            and cleanup_obligation is not None
            and cleanup_obligation.cleanup_mode == "orphan_finalization"
        ):
            return False
        # An artifact-only orphan must retain its last raw discovery authority
        # until an exact session or immutable finalization proves the run.
        if record is None and obligation.source in {"artifact", "cleanup"}:
            try:
                finalization = await _lease_fenced_to_thread(
                    _load_finalization_for_identity,
                    obligation,
                    strict=obligation.source == "cleanup",
                    timeout=_STORE_IO_TIMEOUT_SECONDS,
                )
            except Exception:  # noqa: BLE001 - PREPARED must remain actionable.
                return False
            if obligation.source == "artifact":
                if finalization is None or finalization.binding != obligation.binding:
                    return False
                obligation = finalization
                claims = obligation.claims(now=now)
            elif finalization is not None:
                if (
                    finalization.binding != obligation.binding
                    or cleanup_obligation is None
                    or cleanup_obligation.cleanup_mode == "provisional_session"
                ):
                    return False
                obligation = finalization
                claims = obligation.claims(now=now)

        if discovered_control is not None:
            try:
                from deerflow.sophia.cleanup_fence import (
                    refresh_cleanup_fence_work_for_reconciliation,
                )

                fresh_work = await _lease_fenced_to_thread(
                    refresh_cleanup_fence_work_for_reconciliation,
                    claims.cleanup_obligation_id,
                    discovered_control.retention_expires_at,
                    discovered_control.provider_expires_at,
                    timeout=_STORE_IO_TIMEOUT_SECONDS,
                )
                obligation = _attach_cleanup_control_work(obligation, fresh_work)
                claims = obligation.claims(now=now)
            except Exception:  # noqa: BLE001 - stale discovery cannot close work.
                return False

        try:
            from deerflow.sophia.cleanup_fence import (
                close_cleanup_obligation_if_provider_due,
                close_cleanup_obligation_if_retention_due,
                close_existing_cleanup_obligation,
            )

            control = obligation.cleanup_control
            if control is not None and control.state == "closed":
                # CLOSED+no live-zero checkpoint is itself durable immediate
                # retry authority, even when neither immutable deadline is due.
                close_function = close_existing_cleanup_obligation
                close_arguments = (claims.cleanup_obligation_id,)
            elif control is None or control.retention_due:
                close_function = close_cleanup_obligation_if_retention_due
                close_arguments = (
                    claims.cleanup_obligation_id,
                    obligation.retention_expires_at,
                    claims.provider_expires_at,
                )
            elif control.provider_due:
                close_function = close_cleanup_obligation_if_provider_due
                close_arguments = (
                    claims.cleanup_obligation_id,
                    obligation.retention_expires_at,
                    claims.provider_expires_at,
                )
            elif control.expired_admissions:
                close_function = close_existing_cleanup_obligation
                close_arguments = (claims.cleanup_obligation_id,)
            else:
                return False
            due_fence = await _lease_fenced_to_thread(
                close_function,
                *close_arguments,
                timeout=_STORE_IO_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001 - DB deadline authority remains pending.
            return False
        if due_fence is None:
            return False

        admission_fence = await _lease_fenced_to_thread(
            recovery._close_live_cleanup_admission,
            claims,
            record,
            timeout=_STORE_IO_TIMEOUT_SECONDS,
        )
        if (
            admission_fence.get("status") == "pending"
            and int(admission_fence.get("cleanup_admissions_overdue") or 0) > 0
        ):
            reconciliation = await recovery._reconcile_overdue_cleanup_admissions(
                claims,
                record,
            )
            if reconciliation.get("status") in _TERMINAL:
                admission_fence = await _lease_fenced_to_thread(
                    recovery._close_live_cleanup_admission,
                    claims,
                    record,
                    timeout=_STORE_IO_TIMEOUT_SECONDS,
                )
        if admission_fence.get("status") not in _TERMINAL:
            return False
        if record is not None:
            # Admission reconciliation can synchronously receive the owning
            # Voice callback, persist terminal provider metadata, and consume
            # the admission. Never project the pre-reconciliation snapshot
            # back over that exact settlement.
            try:
                refreshed_by_cleanup = await _lease_fenced_to_thread(
                    self._session_store.find_session_by_cleanup_obligation_id,
                    claims.cleanup_obligation_id,
                    timeout=_STORE_IO_TIMEOUT_SECONDS,
                )
                refreshed_by_run = await _lease_fenced_to_thread(
                    self._session_store.find_session_by_run_id,
                    claims.principal_id,
                    claims.test_run_id,
                    timeout=_STORE_IO_TIMEOUT_SECONDS,
                )
            except Exception:  # noqa: BLE001 - durable evidence remains pending.
                return False
            if (
                refreshed_by_cleanup is None
                or refreshed_by_run is None
                or refreshed_by_cleanup.session_id != refreshed_by_run.session_id
                or not voice_lab_session_record_matches(refreshed_by_cleanup, claims)
            ):
                return False
            record = refreshed_by_cleanup
        provider = await asyncio.wait_for(
            recovery._recover_voice_provider(
                claims,
                record,
                retention_reaper=True,
            ),
            timeout=_COMPONENT_TIMEOUT_SECONDS,
        )
        builder = await asyncio.wait_for(
            recovery._recover_builder(claims),
            timeout=_COMPONENT_TIMEOUT_SECONDS,
        )
        auth = await _lease_fenced_to_thread(
            recovery._recover_auth_sessions_sync,
            claims,
            timeout=_STORE_IO_TIMEOUT_SECONDS,
        )
        if any(component.get("status") not in _TERMINAL for component in (provider, builder, auth)):
            return False
        remaining_after_builder = await _lease_fenced_to_thread(
            self._artifact_registry.synthetic_cleanup_obligation_records,
            cleanup_obligation_id=claims.cleanup_obligation_id,
            timeout=_STORE_IO_TIMEOUT_SECONDS,
        )
        if remaining_after_builder:
            return False
        if obligation.cleanup_control is not None:
            try:
                from deerflow.sophia.cleanup_fence import mark_cleanup_live_zero

                await _lease_fenced_to_thread(
                    mark_cleanup_live_zero,
                    claims.cleanup_obligation_id,
                    obligation.retention_expires_at,
                    claims.provider_expires_at,
                    timeout=_STORE_IO_TIMEOUT_SECONDS,
                )
            except Exception:  # noqa: BLE001 - CLOSED remains retry authority.
                return False
        if obligation.cleanup_control is not None and not obligation.cleanup_control.retention_due:
            # Provider/admission cleanup won before transcript retention. The
            # exact CLOSED fence and live-zero checkpoint retain canonical
            # evidence without letting a crash strand Builder/auth work.
            return True

        if record is not None:
            synthetic = record.metadata.get("synthetic_voice_lab")
            if not isinstance(synthetic, dict):
                return False
            session_deadline = _parse_canonical_utc_millis(
                synthetic.get("retention_expires_at")
            )
            if session_deadline is None:
                return False
            database_retention_due = bool(
                obligation.cleanup_control is not None
                and obligation.cleanup_control.retention_due
            )
            if session_deadline > now and not database_retention_due:
                # Builder artifacts may have an earlier task-created deadline;
                # canonical transcript evidence remains until its own receipt.
                return cleanup_obligation is None
            if synthetic.get("retention_anchor") == "finalized_at":
                evidence = await _lease_fenced_to_thread(
                    recovery._recover_canonical_evidence_retention,
                    claims,
                    record,
                    timeout=_COMPONENT_TIMEOUT_SECONDS,
                )
            elif synthetic.get("retention_anchor") == "session_created_at_provisional":
                provisional_kwargs = (
                    {"database_due": True}
                    if database_retention_due
                    else {}
                )
                evidence = await _lease_fenced_to_thread(
                    _purge_expired_provisional_session,
                    claims,
                    record,
                    now,
                    **provisional_kwargs,
                    timeout=_COMPONENT_TIMEOUT_SECONDS,
                )
            else:
                return False
        else:
            if obligation.source == "cleanup":
                prepared_kwargs = (
                    {"database_due": True}
                    if obligation.cleanup_control is not None
                    and obligation.cleanup_control.retention_due
                    else {}
                )
                evidence = await _lease_fenced_to_thread(
                    _finish_prepared_cleanup_handle,
                    claims,
                    obligation,
                    now,
                    **prepared_kwargs,
                    timeout=_COMPONENT_TIMEOUT_SECONDS,
                )
            else:
                evidence = await _lease_fenced_to_thread(
                    _purge_orphan_finalization,
                    claims,
                    obligation,
                    now,
                    cleanup_mode=(
                        cleanup_obligation.cleanup_mode
                        if cleanup_obligation is not None
                        else "orphan_finalization"
                    ),
                    prepared_handle_path=(
                        cleanup_obligation.cleanup_handle_path
                        if cleanup_obligation is not None
                        else None
                    ),
                    timeout=_COMPONENT_TIMEOUT_SECONDS,
                )
        if evidence.get("status") not in _TERMINAL:
            return False
        try:
            remaining_session = await _lease_fenced_to_thread(
                self._session_store.find_session_by_cleanup_obligation_id,
                claims.cleanup_obligation_id,
                timeout=_STORE_IO_TIMEOUT_SECONDS,
            )
            remaining_artifacts = await _lease_fenced_to_thread(
                self._artifact_registry.synthetic_cleanup_obligation_records,
                cleanup_obligation_id=claims.cleanup_obligation_id,
                timeout=_STORE_IO_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001
            return False
        return remaining_session is None and not remaining_artifacts


def _finalization_object_path(claims: VoiceLabClaims) -> str:
    return f"{_FINALIZATION_PREFIX}/{claims.cleanup_obligation_id}.json"


def _local_finalization_path(claims: VoiceLabClaims) -> Path:
    return (
        Path(USERS_DIR)
        / claims.principal_id
        / "synthetic_voice_lab"
        / "finalizations"
        / f"{claims.cleanup_obligation_id}.json"
    )


def _load_finalization_for_identity(
    obligation: RetentionObligation,
    *,
    strict: bool = False,
) -> RetentionObligation | None:
    from deerflow.sophia.storage import supabase_artifact_store

    claims = obligation.claims(now=datetime.now(UTC))
    object_path = _finalization_object_path(claims)
    try:
        if supabase_artifact_store.is_configured():
            stored = supabase_artifact_store.download_artifact_object_bounded(
                object_path,
                max_bytes=_FINALIZATION_MAX_BYTES,
            )
            if stored is not None:
                raw, content_type = stored
                if content_type.split(";", 1)[0].strip().lower() != "application/json":
                    return None
                return _validate_finalization_payload(
                    json.loads(raw.decode("utf-8")),
                    object_path=object_path,
                )
        local = _local_finalization_path(claims)
        if local.is_file() and local.stat().st_size <= _FINALIZATION_MAX_BYTES:
            return _validate_finalization_payload(
                json.loads(local.read_text(encoding="utf-8"))
            )
    except (OSError, RuntimeError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        if strict:
            raise
        return None
    return None


def _load_finalization_by_cleanup_obligation_id(
    cleanup_obligation_id: str,
) -> RetentionObligation | None:
    """Load one v2 receipt without requiring already-retained raw identity."""

    from deerflow.sophia.storage import supabase_artifact_store

    if not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id):
        raise ValueError("cleanup obligation id is invalid")
    found: list[RetentionObligation] = []
    object_path = f"{_FINALIZATION_PREFIX}/{cleanup_obligation_id}.json"
    if supabase_artifact_store.is_configured():
        stored = supabase_artifact_store.download_artifact_object_bounded(
            object_path,
            max_bytes=_FINALIZATION_MAX_BYTES,
        )
        if stored is not None:
            raw, content_type = stored
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                raise ValueError("synthetic finalization content type drifted")
            found.append(
                _validate_finalization_payload(
                    json.loads(raw.decode("utf-8")),
                    object_path=object_path,
                )
            )
    local_paths = list(
        Path(USERS_DIR).glob(
            "*/synthetic_voice_lab/finalizations/"
            f"{cleanup_obligation_id}.json"
        )
    )
    if len(local_paths) > 1:
        raise ValueError("duplicate local synthetic finalization receipts")
    if local_paths:
        path = local_paths[0]
        if path.stat().st_size > _FINALIZATION_MAX_BYTES:
            raise ValueError("synthetic finalization receipt is oversized")
        found.append(
            _validate_finalization_payload(
                json.loads(path.read_text(encoding="utf-8"))
            )
        )
    if not found:
        return None
    first = found[0]
    if any(candidate.binding != first.binding for candidate in found[1:]):
        raise ValueError("synthetic finalization copies conflict")
    return first


def _finish_prepared_cleanup_handle(
    claims: VoiceLabClaims,
    obligation: RetentionObligation,
    now: datetime,
    *,
    database_due: bool = False,
) -> dict[str, object]:
    """Complete PREPARED after authoritative source/artifact zero verification."""

    from app.gateway.routers import voice_lab_recovery as recovery

    if (
        obligation.source != "cleanup"
        or obligation.binding
        != (
            claims.principal_id,
            claims.test_run_id,
            claims.scenario_id,
            claims.scenario_version,
            claims.environment,
            claims.cleanup_obligation_id,
            claims.retention_hours,
            tuple(sorted(claims.expected_deployment.items())),
        )
        or (not database_due and obligation.deadline > now)
        or obligation.cleanup_handle_path is None
    ):
        return {"status": "failed", "code": "cleanup_handle_binding_mismatch"}
    try:
        result = recovery._finish_retention_cleanup_intent(
            claims.cleanup_obligation_id,
            expected_path=obligation.cleanup_handle_path,
            now=now,
        )
        if result.get("status") != "completed":
            return {
                "status": "pending",
                "code": "cleanup_handle_global_zero_unconfirmed",
            }
    except Exception:  # noqa: BLE001 - sealed handle remains restart authority.
        return {"status": "pending", "code": "cleanup_handle_completion_unavailable"}
    return {
        "status": "completed",
        "canonical_evidence_purged": True,
        "retention_purge_pending": False,
    }


def _purge_expired_provisional_session(
    claims: VoiceLabClaims,
    record: SessionRecord,
    now: datetime,
    *,
    database_due: bool = False,
) -> dict[str, object]:
    from app.gateway.inactivity_watcher import unregister_thread
    from app.gateway.routers import voice_lab_recovery as recovery
    from app.gateway.routers.sessions import _store
    from deerflow.sophia.storage import supabase_artifact_store

    if not voice_lab_session_record_matches(record, claims):
        return {"status": "failed", "code": "provisional_session_binding_mismatch"}
    synthetic = record.metadata.get("synthetic_voice_lab")
    deadline = (
        _parse_canonical_utc_millis(synthetic.get("retention_expires_at"))
        if isinstance(synthetic, dict)
        else None
    )
    if (
        not isinstance(synthetic, dict)
        or synthetic.get("retention_anchor") != "session_created_at_provisional"
        or deadline is None
        or (not database_due and deadline > now)
    ):
        return {"status": "failed", "code": "provisional_session_retention_invalid"}
    # A provisional row and a final receipt cannot both be authoritative.
    if _load_finalization_for_identity(_obligation_from_session(record)) is not None:
        return {"status": "failed", "code": "provisional_finalization_conflict"}
    try:
        from deerflow.sophia.cleanup_fence import cleanup_retention_expired

        retention_due = cleanup_retention_expired(
            claims.cleanup_obligation_id,
            str(synthetic["retention_expires_at"]),
            claims.provider_expires_at,
        )
    except Exception:  # noqa: BLE001 - the durable DB clock/fence is authoritative.
        return {"status": "pending", "code": "provisional_retention_fence_unavailable"}
    if not retention_due:
        return {"status": "retention_pending"}
    durable = supabase_artifact_store.is_configured()
    if recovery._durable_evidence_required() and not durable:
        return {"status": "pending", "code": "durable_purge_unavailable"}
    cleanup_handle_path: str | None = None
    try:
        if durable:
            cleanup_handle_path = recovery._ensure_retention_cleanup_handle(
                claims,
                retention_expires_at=str(synthetic["retention_expires_at"]),
                cleanup_mode="provisional_session",
                session_id=record.session_id,
                thread_id=record.thread_id,
            )
            with recovery._recovery_receipt_fence_lock(recovery._recovery_id(claims)):
                prepared = recovery._prepare_recovery_receipt_purge(claims)
            if prepared.get("already_purged") is True:
                return {"status": "failed", "code": "provisional_purge_state_conflict"}
        _store.purge_synthetic_session(
            claims.principal_id,
            record.session_id,
            cleanup_obligation_id=claims.cleanup_obligation_id,
            retention_expires_at=str(synthetic["retention_expires_at"]),
            provider_expires_at=claims.provider_expires_at,
        )
        if _store.find_session_by_run_id(claims.principal_id, claims.test_run_id) is not None:
            return {"status": "pending", "code": "provisional_session_purge_unconfirmed"}
        unregister_thread(record.thread_id)
        if durable:
            finished = recovery._finish_retention_cleanup_intent(
                claims.cleanup_obligation_id,
                expected_path=cleanup_handle_path,
                now=now,
            )
            if finished.get("status") != "completed":
                return {
                    "status": "pending",
                    "code": "provisional_global_zero_unconfirmed",
                }
    except Exception:  # noqa: BLE001 - retry via the still-durable source/intent.
        return {"status": "pending", "code": "provisional_session_purge_unavailable"}
    return {
        "status": "completed",
        "canonical_evidence_purged": True,
        "retention_purge_pending": False,
    }


def _purge_orphan_finalization(
    claims: VoiceLabClaims,
    obligation: RetentionObligation,
    now: datetime,
    *,
    cleanup_mode: str = "orphan_finalization",
    prepared_handle_path: str | None = None,
) -> dict[str, object]:
    from app.gateway.routers import voice_lab_recovery as recovery
    from deerflow.sophia.storage import supabase_artifact_store

    if obligation.source != "finalization" or obligation.binding != (
        claims.principal_id,
        claims.test_run_id,
        claims.scenario_id,
        claims.scenario_version,
        claims.environment,
        claims.cleanup_obligation_id,
        claims.retention_hours,
        tuple(sorted(claims.expected_deployment.items())),
    ):
        return {"status": "failed", "code": "orphan_finalization_binding_mismatch"}
    try:
        from deerflow.sophia.cleanup_fence import cleanup_retention_expired

        retention_due = cleanup_retention_expired(
            claims.cleanup_obligation_id,
            obligation.retention_expires_at,
            claims.provider_expires_at,
        )
    except Exception:  # noqa: BLE001 - the durable DB clock/fence is authoritative.
        return {"status": "pending", "code": "orphan_retention_fence_unavailable"}
    if not retention_due:
        return {"status": "retention_pending"}
    durable = supabase_artifact_store.is_configured()
    if recovery._durable_evidence_required() and not durable:
        return {"status": "pending", "code": "durable_purge_unavailable"}
    object_path = _finalization_object_path(claims)
    cleanup_handle_path: str | None = None
    try:
        if durable:
            current = _load_finalization_for_identity(obligation)
            if current is None or current.binding != obligation.binding:
                return {"status": "failed", "code": "orphan_finalization_drifted"}
            cleanup_handle_path = prepared_handle_path or (
                recovery._ensure_retention_cleanup_handle(
                    claims,
                    retention_expires_at=obligation.retention_expires_at,
                    cleanup_mode=cleanup_mode,
                    session_id=obligation.session_id,
                    thread_id=obligation.thread_id,
                )
            )
            with recovery._recovery_receipt_fence_lock(recovery._recovery_id(claims)):
                prepared = recovery._prepare_recovery_receipt_purge(claims)
            if prepared.get("already_purged") is True:
                return {"status": "failed", "code": "orphan_purge_state_conflict"}
            supabase_artifact_store.delete_artifact_object_if_present(object_path)
            if supabase_artifact_store.download_artifact_object_bounded(
                object_path,
                max_bytes=_FINALIZATION_MAX_BYTES,
            ) is not None:
                return {"status": "pending", "code": "orphan_finalization_purge_unconfirmed"}
        local = _local_finalization_path(claims)
        try:
            local.unlink()
        except FileNotFoundError:
            pass
        if local.exists():
            return {"status": "pending", "code": "orphan_local_purge_unconfirmed"}
        if durable:
            finished = recovery._finish_retention_cleanup_intent(
                claims.cleanup_obligation_id,
                expected_path=cleanup_handle_path,
                now=now,
            )
            if finished.get("status") != "completed":
                return {
                    "status": "pending",
                    "code": "orphan_global_zero_unconfirmed",
                }
    except Exception:  # noqa: BLE001 - source or purge intent remains retryable.
        return {"status": "pending", "code": "orphan_finalization_purge_unavailable"}
    return {
        "status": "completed",
        "canonical_evidence_purged": True,
        "retention_purge_pending": False,
    }


def build_configured_voice_lab_retention_reaper() -> VoiceLabRetentionReaper:
    from app.gateway.artifact_registry import ArtifactRegistry
    from app.gateway.routers import voice_lab_recovery as recovery
    from deerflow.sophia.session_store import SessionStore

    interval = _bounded_int_env(
        "SOPHIA_VOICE_LAB_RETENTION_REAPER_INTERVAL_SECONDS",
        60,
        minimum=5,
        maximum=3600,
    )
    batch = _bounded_int_env(
        "SOPHIA_VOICE_LAB_RETENTION_REAPER_BATCH_SIZE",
        25,
        minimum=1,
        maximum=100,
    )
    if voice_lab_retention_reaper_required():
        dsn = (
            os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
            or os.getenv("BETTER_AUTH_DATABASE_URL")
            or ""
        ).strip()
        recovery_secret = (
            os.getenv("SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET") or ""
        ).strip()
        if not dsn:
            raise ValueError("gateway_voice_lab_retention_reaper_database_missing")
        if len(recovery_secret.encode("utf-8")) < 32:
            raise ValueError("gateway_voice_lab_retention_reaper_secret_invalid")
        try:
            recovery._auth_tombstone_keyring()
        except RuntimeError as exc:
            raise ValueError("gateway_voice_lab_auth_tombstone_keyring_invalid") from exc
    return VoiceLabRetentionReaper(
        session_store=SessionStore(),
        artifact_registry=ArtifactRegistry(),
        interval_seconds=interval,
        batch_size=batch,
    )


def install_voice_lab_retention_reaper(
    app: FastAPI,
    worker: VoiceLabRetentionReaper,
) -> None:
    setattr(app.state, _WORKER_ATTR, worker)


def get_voice_lab_retention_reaper_or_none(
    app: FastAPI,
) -> VoiceLabRetentionReaper | None:
    candidate = getattr(app.state, _WORKER_ATTR, None)
    return candidate if isinstance(candidate, VoiceLabRetentionReaper) else None
