"""Durable, content-free admission fence for synthetic Voice Lab resources.

The cleanup UUID is random control-plane authority, not a principal/run identity.
Every synthetic producer serializes on the same PostgreSQL advisory key as the
retention worker.  Cross-store producers reserve before allocating so cleanup
can close admission without falsely declaring an in-flight allocation absent.
"""

from __future__ import annotations

import json
import os
import re
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

_CLEANUP_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_ADMISSION_KINDS = frozenset({"session", "provider", "builder"})
_ADMISSION_LEASE_SECONDS = 120
_CLOSED_RETIRE_GRACE_SECONDS = 600
_PROVIDER_TERMINAL_RECEIPT_HISTORY_LIMIT = 16
_PROVIDER_ACTIVATION_METADATA_KEYS = frozenset(
    {
        "voice_provider_resource_state",
        "voice_provider_connection_epoch",
        "voice_provider_pending_connection_epoch",
        "voice_provider_activated_at",
        "voice_provider_activation_receipt",
    }
)
_PROVIDER_TERMINAL_METADATA_KEYS = frozenset(
    {
        "voice_provider_resource_state",
        "voice_provider_closed_at",
        "voice_provider_pending_connection_epoch",
        "voice_provider_browser_close_receipts",
        "voice_provider_activation_abort_receipts",
    }
)


class CleanupFenceError(RuntimeError):
    """Fail-closed synthetic cleanup admission error."""


@dataclass(frozen=True)
class CleanupAdmission:
    admission_id: str
    cleanup_obligation_id: str
    resource_kind: str
    resource_id: str | None
    lease_expires_at: datetime
    resource_expires_at: datetime | None = None
    status: str = "reserved"
    expired: bool = False


@dataclass(frozen=True)
class CleanupFenceStatus:
    state: str
    active_admissions: int
    expired_admissions: int
    retention_expires_at: datetime
    provider_expires_at: datetime


@dataclass(frozen=True)
class CleanupFenceWork:
    cleanup_obligation_id: str
    state: str
    lifecycle_phase: str
    retention_expires_at: datetime
    provider_expires_at: datetime
    retention_due: bool
    provider_due: bool
    admissions: tuple[CleanupAdmission, ...]


_LOCAL_LOCK = threading.RLock()
_LOCAL_OBLIGATIONS: dict[str, dict[str, Any]] = {}
_LOCAL_ADMISSIONS: dict[str, CleanupAdmission] = {}
_LOCAL_D02_PENDING_CLEANUPS: set[str] = set()
_LOCAL_D02_RELAY_CLEANUPS: dict[str, str] = {}
_LOCAL_SCAN_CURSORS: dict[
    str,
    tuple[datetime, str, str, str | None] | None,
] = {"work_v1": None, "complete_purge_v1": None}
_LOCAL_SCAN_WINDOWS: dict[
    str,
    tuple[datetime, str, str, str | None] | None,
] = {"work_v1": None, "complete_purge_v1": None}


def _local_d02_relay_present(cleanup_obligation_id: str) -> bool:
    """Return whether the local Gateway registered an owning live relay."""

    with _LOCAL_LOCK:
        return cleanup_obligation_id in _LOCAL_D02_RELAY_CLEANUPS.values()


def _register_local_d02_relay(
    relay_id: str,
    cleanup_obligation_id: str,
) -> None:
    """Mirror local Gateway relay ownership without importing the app layer."""

    with _LOCAL_LOCK:
        _LOCAL_D02_RELAY_CLEANUPS[relay_id] = cleanup_obligation_id


def _unregister_local_d02_relay(relay_id: str) -> None:
    with _LOCAL_LOCK:
        _LOCAL_D02_RELAY_CLEANUPS.pop(relay_id, None)


def _clear_local_d02_relays_for_tests() -> None:
    with _LOCAL_LOCK:
        _LOCAL_D02_RELAY_CLEANUPS.clear()


def _dsn() -> str:
    return (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()


def _production_runtime() -> bool:
    return (os.getenv("RENDER") or "").strip().lower() == "true" or bool(
        (os.getenv("RENDER_SERVICE_ID") or "").strip()
    )


def _validated_cleanup_id(value: str) -> str:
    if not isinstance(value, str) or not _CLEANUP_ID.fullmatch(value):
        raise CleanupFenceError("cleanup obligation id is malformed")
    return value


def _parsed_deadline(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise CleanupFenceError("cleanup retention deadline is malformed") from exc
    else:
        raise CleanupFenceError("cleanup retention deadline is malformed")
    if parsed.tzinfo is None:
        raise CleanupFenceError("cleanup retention deadline is malformed")
    return parsed.astimezone(UTC)


def _validated_kind(value: str) -> str:
    if value not in _ADMISSION_KINDS:
        raise CleanupFenceError("cleanup admission kind is invalid")
    return value


def _connect():  # noqa: ANN202
    dsn = _dsn()
    if not dsn:
        if _production_runtime():
            raise CleanupFenceError("cleanup admission database is unavailable")
        return None
    import psycopg

    return psycopg.connect(dsn, connect_timeout=5)


def _lock_cursor(cursor: Any, cleanup_obligation_id: str) -> None:
    cursor.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 731944))",
        (cleanup_obligation_id,),
    )


def ensure_open_with_cursor(
    cursor: Any,
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
    *,
    allow_auth_provisional: bool = False,
) -> None:
    """Check an existing OPEN fence without creating or extending authority."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    if provider_deadline > deadline:
        raise CleanupFenceError("provider absolute deadline exceeds retention")
    cursor.execute(
        """
        SELECT state, lifecycle_phase, retention_expires_at,
               provider_expires_at,
               clock_timestamp() < retention_expires_at,
               clock_timestamp() < provider_expires_at
          FROM public.sophia_voice_lab_cleanup_obligations
         WHERE cleanup_obligation_id = %s
         FOR UPDATE
        """,
        (cleanup_id,),
    )
    row = cursor.fetchone()
    if row is None or row[0] != "open":
        raise CleanupFenceError("cleanup obligation admission is closed")
    if row[3] != provider_deadline:
        raise CleanupFenceError("cleanup provider deadline binding conflicts")
    if row[1] == "auth_provisional":
        if (
            not allow_auth_provisional
            or row[2] != provider_deadline
            or deadline < provider_deadline
            or row[5] is not True
        ):
            raise CleanupFenceError("cleanup obligation admission is closed")
        return
    if row[1] != "session_provisional" or row[2] != deadline:
        raise CleanupFenceError("cleanup retention deadline binding conflicts")
    if row[4] is not True or row[5] is not True:
        raise CleanupFenceError("cleanup retention deadline has elapsed")


def assert_cleanup_obligation_open(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> None:
    """Durably reject Builder/external allocation after CLOSED."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    if provider_deadline > deadline:
        raise CleanupFenceError("provider absolute deadline exceeds retention")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            observed_at = datetime.now(UTC)
            row = _LOCAL_OBLIGATIONS.setdefault(
                cleanup_id,
                {
                    "state": "open",
                    "lifecycle_phase": "session_provisional",
                    "retention_expires_at": deadline,
                    "provider_expires_at": provider_deadline,
                    "live_cleanup_completed_at": None,
                    "created_at": observed_at,
                    "updated_at": observed_at,
                },
            )
            if (
                row["state"] != "open"
                or row["provider_expires_at"] != provider_deadline
                or row["retention_expires_at"] != deadline
                or observed_at >= deadline
            ):
                raise CleanupFenceError("cleanup obligation admission is closed")
        return
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            ensure_open_with_cursor(
                cursor, cleanup_id, deadline, provider_deadline
            )


def assert_existing_cleanup_obligation_open(
    cleanup_obligation_id: str,
    provider_expires_at: str | datetime,
) -> None:
    """Read-only capability-auth fence; never creates or extends authority."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    provider_deadline = _parsed_deadline(provider_expires_at)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if (
                row is None
                or row["state"] != "open"
                or row.get("provider_expires_at") != provider_deadline
                or datetime.now(UTC) >= row["retention_expires_at"]
                or datetime.now(UTC) >= provider_deadline
            ):
                raise CleanupFenceError("cleanup obligation admission is closed")
        return
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT 1
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = %s
                   AND state = 'open'
                   AND provider_expires_at = %s
                   AND retention_expires_at > clock_timestamp()
                   AND provider_expires_at > clock_timestamp()
                """,
                (cleanup_id, provider_deadline),
            )
            if cursor.fetchone() is None:
                raise CleanupFenceError("cleanup obligation admission is closed")


def reserve_cleanup_admission(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    *,
    provider_expires_at: str | datetime,
    resource_kind: str,
    resource_id: str | None = None,
    resource_expires_at: str | datetime | None = None,
) -> CleanupAdmission:
    """Reserve one bounded cross-store allocation before it starts."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    kind = _validated_kind(resource_kind)
    if (
        not isinstance(resource_id, str)
        or not 1 <= len(resource_id) <= 256
        or any(ord(character) < 32 for character in resource_id)
    ):
        raise CleanupFenceError("cleanup admission resource id is invalid")
    deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    if provider_deadline > deadline:
        raise CleanupFenceError("provider absolute deadline exceeds retention")
    if kind == "provider":
        if resource_expires_at is None:
            raise CleanupFenceError("provider absolute deadline is missing")
        absolute_deadline = _parsed_deadline(resource_expires_at)
        if absolute_deadline != provider_deadline:
            raise CleanupFenceError("provider absolute deadline binding conflicts")
    elif resource_expires_at is not None:
        raise CleanupFenceError("resource absolute deadline is not allowed")
    else:
        absolute_deadline = deadline
    admission_id = str(uuid.uuid4())
    connection = _connect()
    if connection is None:
        database_now = datetime.now(UTC)
        if kind == "provider" and database_now >= absolute_deadline:
            raise CleanupFenceError("provider absolute deadline has elapsed")
        lease_expires_at = min(
            deadline,
            absolute_deadline,
            database_now + timedelta(seconds=_ADMISSION_LEASE_SECONDS),
        )
        admission = CleanupAdmission(
            admission_id=admission_id,
            cleanup_obligation_id=cleanup_id,
            resource_kind=kind,
            resource_id=resource_id,
            lease_expires_at=lease_expires_at,
            resource_expires_at=absolute_deadline,
        )
        with _LOCAL_LOCK:
            assert_cleanup_obligation_open(
                cleanup_id, deadline, provider_deadline
            )
            if kind == "provider" and any(
                item.cleanup_obligation_id == cleanup_id
                and item.resource_kind == "provider"
                for item in _LOCAL_ADMISSIONS.values()
            ):
                raise CleanupFenceError(
                    "provider cleanup admission already exists"
                )
            _LOCAL_ADMISSIONS[admission_id] = admission
        return admission
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            ensure_open_with_cursor(
                cursor,
                cleanup_id,
                deadline,
                provider_deadline,
                allow_auth_provisional=kind == "session",
            )
            if kind == "provider":
                cursor.execute(
                    "SELECT %s > clock_timestamp()",
                    (absolute_deadline,),
                )
                if cursor.fetchone()[0] is not True:
                    raise CleanupFenceError("provider absolute deadline has elapsed")
                cursor.execute(
                    """
                    SELECT 1
                      FROM public.sophia_voice_lab_cleanup_admissions
                     WHERE cleanup_obligation_id = %s
                       AND resource_kind = 'provider'
                     LIMIT 1
                    """,
                    (cleanup_id,),
                )
                if cursor.fetchone() is not None:
                    raise CleanupFenceError(
                        "provider cleanup admission already exists"
                    )
            cursor.execute(
                """
                INSERT INTO public.sophia_voice_lab_cleanup_admissions (
                  admission_id, cleanup_obligation_id, resource_kind,
                  resource_id, status, lease_expires_at, resource_expires_at
                ) VALUES (
                  %s, %s, %s, %s, 'reserved',
                  LEAST(
                    %s,
                    %s,
                    clock_timestamp() + make_interval(secs => %s)
                  ),
                  %s
                )
                RETURNING lease_expires_at, resource_expires_at
                """,
                (
                    admission_id,
                    cleanup_id,
                    kind,
                    resource_id,
                    deadline,
                    absolute_deadline,
                    _ADMISSION_LEASE_SECONDS,
                    absolute_deadline,
                ),
            )
            row = cursor.fetchone()
    return CleanupAdmission(
        admission_id=admission_id,
        cleanup_obligation_id=cleanup_id,
        resource_kind=kind,
        resource_id=resource_id,
        lease_expires_at=row[0],
        resource_expires_at=row[1],
    )


def cleanup_admission_authorized(admission: CleanupAdmission) -> bool:
    """Recheck ownership after external allocation and before durable binding."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    allowed_statuses = (
        {"allocating", "credential_minted"}
        if admission.resource_kind == "provider"
        else {"reserved"}
    )
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            return bool(
                obligation is not None
                and obligation["state"] == "open"
                and datetime.now(UTC) < obligation["retention_expires_at"]
                and current is not None
                and current.cleanup_obligation_id == cleanup_id
                and current.resource_kind == admission.resource_kind
                and current.resource_id == admission.resource_id
                and current.status in allowed_statuses
                and datetime.now(UTC) < current.lease_expires_at
            )
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT admission.resource_kind, admission.resource_id,
                       admission.status,
                       admission.lease_expires_at > clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_admissions AS admission
                  JOIN public.sophia_voice_lab_cleanup_obligations AS obligation
                    ON obligation.cleanup_obligation_id =
                       admission.cleanup_obligation_id
                 WHERE admission.admission_id = %s
                   AND admission.cleanup_obligation_id = %s
                   AND obligation.state = 'open'
                   AND obligation.retention_expires_at > clock_timestamp()
                 FOR UPDATE OF admission, obligation
                """,
                (admission.admission_id, cleanup_id),
            )
            row = cursor.fetchone()
            return bool(
                row is not None
                and row[0] == admission.resource_kind
                and row[1] == admission.resource_id
                and row[2] in allowed_statuses
                and row[3] is True
            )


def inspect_cleanup_admission(
    *,
    admission_id: str,
    cleanup_obligation_id: str,
    resource_kind: str,
    resource_id: str,
) -> CleanupAdmission:
    """Read one exact live admission without extending its lease."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    kind = _validated_kind(resource_kind)
    try:
        parsed_admission_id = str(uuid.UUID(admission_id))
    except (TypeError, ValueError) as exc:
        raise CleanupFenceError("cleanup admission id is invalid") from exc
    if parsed_admission_id != admission_id or not resource_id:
        raise CleanupFenceError("cleanup admission identity is invalid")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            now = datetime.now(UTC)
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission_id)
            if (
                obligation is None
                or obligation["state"] != "open"
                or now >= obligation["retention_expires_at"]
                or current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != kind
                or current.resource_id != resource_id
                or now >= current.lease_expires_at
            ):
                raise CleanupFenceError("cleanup obligation admission is closed")
            return current
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT admission.lease_expires_at, admission.status,
                       admission.resource_expires_at
                  FROM public.sophia_voice_lab_cleanup_admissions AS admission
                  JOIN public.sophia_voice_lab_cleanup_obligations AS obligation
                    ON obligation.cleanup_obligation_id =
                       admission.cleanup_obligation_id
                 WHERE admission.admission_id = %s
                   AND admission.cleanup_obligation_id = %s
                   AND admission.resource_kind = %s
                   AND admission.resource_id = %s
                   AND admission.lease_expires_at > clock_timestamp()
                   AND obligation.state = 'open'
                   AND obligation.retention_expires_at > clock_timestamp()
                 FOR UPDATE OF admission, obligation
                """,
                (admission_id, cleanup_id, kind, resource_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError("cleanup obligation admission is closed")
            return CleanupAdmission(
                admission_id=admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=kind,
                resource_id=resource_id,
                lease_expires_at=row[0],
                resource_expires_at=row[2],
                status=str(row[1]),
            )


def verify_cleanup_admission_start(
    *,
    admission_id: str,
    cleanup_obligation_id: str,
    resource_kind: str,
    resource_id: str,
) -> CleanupAdmission:
    """Durably mark that a producer received pre-allocation authority.

    An expired row that remains ``reserved`` is therefore provably undispatched
    and may be consumed without guessing whether an external call is in flight.
    ``allocating`` remains actionable until its owning producer settles it.
    """

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    kind = _validated_kind(resource_kind)
    try:
        parsed_admission_id = str(uuid.UUID(admission_id))
    except (TypeError, ValueError) as exc:
        raise CleanupFenceError("cleanup admission id is invalid") from exc
    if parsed_admission_id != admission_id or not resource_id:
        raise CleanupFenceError("cleanup admission identity is invalid")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            now = datetime.now(UTC)
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission_id)
            if (
                obligation is None
                or obligation["state"] != "open"
                or now >= obligation["retention_expires_at"]
                or current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != kind
                or current.resource_id != resource_id
                or current.status not in {"reserved", "allocating"}
                or now >= current.lease_expires_at
            ):
                raise CleanupFenceError("cleanup obligation admission is closed")
            allocating = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=current.resource_kind,
                resource_id=current.resource_id,
                lease_expires_at=current.lease_expires_at,
                resource_expires_at=current.resource_expires_at,
                status="allocating",
            )
            _LOCAL_ADMISSIONS[admission_id] = allocating
            return allocating
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions AS admission
                   SET status = 'allocating', updated_at = clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                 WHERE admission.admission_id = %s
                   AND admission.cleanup_obligation_id = %s
                   AND admission.resource_kind = %s
                   AND admission.resource_id = %s
                   AND admission.status IN ('reserved', 'allocating')
                   AND admission.lease_expires_at > clock_timestamp()
                   AND obligation.cleanup_obligation_id =
                       admission.cleanup_obligation_id
                   AND obligation.state = 'open'
                   AND obligation.retention_expires_at > clock_timestamp()
                RETURNING admission.lease_expires_at,
                          admission.resource_expires_at
                """,
                (admission_id, cleanup_id, kind, resource_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError("cleanup obligation admission is closed")
            return CleanupAdmission(
                admission_id=admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=kind,
                resource_id=resource_id,
                lease_expires_at=row[0],
                resource_expires_at=row[1],
                status="allocating",
            )


def mark_cleanup_admission_credential_minted(
    admission: CleanupAdmission,
) -> CleanupAdmission:
    """Confirm the credential mint without claiming a browser socket exists."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            now = datetime.now(UTC)
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                obligation is None
                or obligation["state"] != "open"
                or current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != admission.resource_kind
                or current.resource_id != admission.resource_id
                or current.status not in {"allocating", "credential_minted"}
                or now >= current.lease_expires_at
            ):
                raise CleanupFenceError("cleanup admission binding is unavailable")
            minted = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=current.resource_kind,
                resource_id=current.resource_id,
                lease_expires_at=current.lease_expires_at,
                resource_expires_at=current.resource_expires_at,
                status="credential_minted",
            )
            _LOCAL_ADMISSIONS[current.admission_id] = minted
            return minted
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions AS admission
                   SET status = 'credential_minted',
                       updated_at = clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                 WHERE admission.admission_id = %s
                   AND admission.cleanup_obligation_id = %s
                   AND admission.resource_kind = %s
                   AND admission.resource_id = %s
                   AND admission.status IN ('allocating', 'credential_minted')
                   AND admission.lease_expires_at > clock_timestamp()
                   AND obligation.cleanup_obligation_id =
                       admission.cleanup_obligation_id
                   AND obligation.state = 'open'
                   AND obligation.retention_expires_at > clock_timestamp()
                RETURNING admission.lease_expires_at,
                          admission.resource_expires_at
                """,
                (
                    admission.admission_id,
                    cleanup_id,
                    admission.resource_kind,
                    admission.resource_id,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError("cleanup admission binding is unavailable")
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=admission.resource_kind,
                resource_id=admission.resource_id,
                lease_expires_at=row[0],
                resource_expires_at=row[1],
                status="credential_minted",
            )


def bind_cleanup_provider_session(
    admission: CleanupAdmission,
    *,
    user_id: str,
    session_id: str,
    provider_connection_epoch: int,
    provider_owner: dict[str, str] | None = None,
    existing_synthetic: dict[str, Any],
    local_persist: Callable[[dict[str, Any], dict[str, Any]], bool],
) -> CleanupAdmission:
    """Atomically bind one allocated provider to its canonical session row.

    The admission promotion and provider-owned metadata merge share the cleanup
    advisory lock in PostgreSQL.  A terminal receipt from a prior, fully
    consumed pre-bind attempt is rolled into bounded append-only history so it
    cannot be mistaken for the new provider's terminal acknowledgement.
    """

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    if (
        admission.resource_kind != "provider"
        or not admission.resource_id
        or not user_id
        or not session_id
        or not isinstance(provider_connection_epoch, int)
        or provider_connection_epoch <= 0
        or admission.resource_expires_at is None
        or not isinstance(existing_synthetic, dict)
        or existing_synthetic.get("cleanup_obligation_id") != cleanup_id
    ):
        raise CleanupFenceError("provider credential binding is invalid")
    d02 = existing_synthetic.get("scenario_id") == "V-D02"
    owner_keys = {
        "voice_runtime_owner_deployment_sha",
        "voice_runtime_instance_id_sha256",
        "voice_runtime_instance_public_key_spki_base64",
    }
    if (
        d02
        and (
            not isinstance(provider_owner, dict)
            or set(provider_owner) != owner_keys
            or any(
                not isinstance(provider_owner.get(key), str)
                or not provider_owner[key]
                for key in owner_keys
            )
        )
    ) or (not d02 and provider_owner is not None):
        raise CleanupFenceError("provider owner binding is invalid")

    terminal_receipt_keys = {
        "schema",
        "cleanup_obligation_id",
        "cleanup_provider_admission_id",
        "provider_session_id",
        "trace_fault",
    }

    def validated_terminal_receipt(value: object) -> dict[str, object]:
        if (
            not isinstance(value, dict)
            or set(value) != terminal_receipt_keys
            or value.get("schema")
            != "sophia_voice_lab_provider_trace_fault_terminal_v1"
            or value.get("cleanup_obligation_id") != cleanup_id
            or not isinstance(value.get("cleanup_provider_admission_id"), str)
            or not isinstance(value.get("provider_session_id"), str)
            or not isinstance(value.get("trace_fault"), dict)
        ):
            raise CleanupFenceError("prior provider terminal receipt is malformed")
        return dict(value)

    def provider_updates(
        current_synthetic: dict[str, Any],
        database_now: datetime,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        current_provider_id = current_synthetic.get("voice_runtime_session_id")
        current_admission_id = current_synthetic.get(
            "cleanup_provider_admission_id"
        )
        current_state = current_synthetic.get("voice_provider_resource_state")
        current_pending_epoch = current_synthetic.get(
            "voice_provider_pending_connection_epoch"
        )
        idempotent = (
            current_provider_id == admission.resource_id
            and current_admission_id == admission.admission_id
            and current_state == "credential_minted"
            and current_pending_epoch == provider_connection_epoch
        )
        fresh = current_provider_id is None and current_admission_id is None
        if not (fresh or idempotent):
            raise CleanupFenceError("provider credential binding conflicts")

        raw_history = current_synthetic.get(
            "voice_provider_trace_fault_restore_receipt_history"
        )
        if raw_history is None:
            history: list[dict[str, object]] = []
        elif isinstance(raw_history, list):
            history = [validated_terminal_receipt(item) for item in raw_history]
        else:
            raise CleanupFenceError("provider terminal receipt history is malformed")
        if len(history) > _PROVIDER_TERMINAL_RECEIPT_HISTORY_LIMIT:
            raise CleanupFenceError("provider terminal receipt history is over limit")

        prior_terminal = current_synthetic.get(
            "voice_provider_trace_fault_restore_receipt"
        )
        if prior_terminal is not None:
            terminal = validated_terminal_receipt(prior_terminal)
            if (
                terminal["cleanup_provider_admission_id"]
                == admission.admission_id
                or terminal["provider_session_id"] == admission.resource_id
            ):
                raise CleanupFenceError("provider terminal receipt binding conflicts")
            if terminal not in history:
                if len(history) >= _PROVIDER_TERMINAL_RECEIPT_HISTORY_LIMIT:
                    raise CleanupFenceError(
                        "provider terminal receipt history is saturated"
                    )
                history.append(terminal)

        expected = {
            "cleanup_obligation_id": cleanup_id,
            "voice_runtime_session_id": current_provider_id,
            "cleanup_provider_admission_id": current_admission_id,
            "voice_provider_resource_state": current_state,
            "voice_provider_pending_connection_epoch": current_pending_epoch,
            "voice_provider_trace_fault_restore_receipt": prior_terminal,
            "voice_provider_trace_fault_restore_receipt_history": raw_history,
            **(
                {
                    key: current_synthetic.get(key)
                    for key in owner_keys
                }
                if d02
                else {}
            ),
        }
        updates: dict[str, Any] = {
            "voice_runtime_session_id": admission.resource_id,
            "cleanup_provider_admission_id": admission.admission_id,
            "voice_provider_resource_state": "credential_minted",
            "voice_provider_pending_connection_epoch": provider_connection_epoch,
            "voice_provider_resource_expires_at": admission.resource_expires_at
            .astimezone(UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "voice_provider_trace_fault_restore_receipt": None,
        }
        if not idempotent:
            updates["voice_provider_credential_minted_at"] = (
                database_now.astimezone(UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
        if history or raw_history is not None:
            updates["voice_provider_trace_fault_restore_receipt_history"] = history
        if d02:
            assert provider_owner is not None
            if idempotent and any(
                current_synthetic.get(key) != provider_owner[key]
                for key in owner_keys
            ):
                raise CleanupFenceError("provider owner binding conflicts")
            updates.update(provider_owner)
        return expected, updates

    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            database_now = datetime.now(UTC)
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                obligation is None
                or obligation.get("state") != "open"
                or database_now >= obligation["retention_expires_at"]
                or current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != "provider"
                or current.resource_id != admission.resource_id
                or current.status not in {"allocating", "credential_minted"}
                or database_now >= current.lease_expires_at
                or current.resource_expires_at is None
                or current.resource_expires_at != admission.resource_expires_at
                or database_now >= current.resource_expires_at
            ):
                raise CleanupFenceError("provider credential binding is unavailable")
            expected, updates = provider_updates(existing_synthetic, database_now)
            if not local_persist(expected, updates):
                raise CleanupFenceError("provider credential persistence failed")
            minted = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=current.resource_id,
                lease_expires_at=current.lease_expires_at,
                resource_expires_at=current.resource_expires_at,
                status="credential_minted",
            )
            _LOCAL_ADMISSIONS[current.admission_id] = minted
            return minted

    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT obligation.state,
                       obligation.retention_expires_at > clock_timestamp(),
                       admission.status,
                       admission.lease_expires_at,
                       admission.resource_expires_at,
                       admission.lease_expires_at > clock_timestamp(),
                       admission.resource_expires_at > clock_timestamp(),
                       session.metadata -> 'synthetic_voice_lab',
                       clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                  JOIN public.sophia_voice_lab_cleanup_admissions AS admission
                    ON admission.cleanup_obligation_id =
                       obligation.cleanup_obligation_id
                  JOIN public.sophia_sessions AS session
                    ON session.id = %s AND session.user_id = %s
                 WHERE obligation.cleanup_obligation_id = %s
                   AND admission.admission_id = %s
                   AND admission.resource_kind = 'provider'
                   AND admission.resource_id = %s
                 FOR UPDATE OF obligation, admission, session
                """,
                (
                    session_id,
                    user_id,
                    cleanup_id,
                    admission.admission_id,
                    admission.resource_id,
                ),
            )
            row = cursor.fetchone()
            if (
                row is None
                or row[0] != "open"
                or row[1] is not True
                or row[2] not in {"allocating", "credential_minted"}
                or row[5] is not True
                or row[6] is not True
                or row[4] != admission.resource_expires_at
            ):
                raise CleanupFenceError("provider credential binding is unavailable")
            current_synthetic = row[7]
            if isinstance(current_synthetic, str):
                try:
                    current_synthetic = json.loads(current_synthetic)
                except json.JSONDecodeError as exc:
                    raise CleanupFenceError(
                        "provider credential session binding is malformed"
                    ) from exc
            if (
                not isinstance(current_synthetic, dict)
                or current_synthetic.get("cleanup_obligation_id") != cleanup_id
            ):
                raise CleanupFenceError(
                    "provider credential session binding is malformed"
                )
            expected, updates = provider_updates(current_synthetic, row[8])
            next_synthetic = dict(current_synthetic)
            next_synthetic.update(updates)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions
                   SET status = 'credential_minted',
                       updated_at = clock_timestamp()
                 WHERE admission_id = %s
                   AND cleanup_obligation_id = %s
                   AND resource_kind = 'provider'
                   AND resource_id = %s
                   AND status IN ('allocating', 'credential_minted')
                   AND lease_expires_at > clock_timestamp()
                   AND resource_expires_at > clock_timestamp()
                """,
                (admission.admission_id, cleanup_id, admission.resource_id),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("provider credential binding is unavailable")
            cursor.execute(
                """
                UPDATE public.sophia_sessions
                   SET metadata = jsonb_set(
                         metadata, '{synthetic_voice_lab}', %s::jsonb, true
                       ),
                       updated_at = clock_timestamp()
                 WHERE id = %s AND user_id = %s
                   AND metadata -> 'synthetic_voice_lab' ->>
                       'cleanup_obligation_id' = %s
                """,
                (
                    json.dumps(
                        next_synthetic, sort_keys=True, separators=(",", ":")
                    ),
                    session_id,
                    user_id,
                    cleanup_id,
                ),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("provider credential persistence failed")
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=admission.resource_id,
                lease_expires_at=row[3],
                resource_expires_at=row[4],
                status="credential_minted",
            )


def mark_cleanup_admission_browser_active(
    admission: CleanupAdmission,
) -> CleanupAdmission:
    """Promote one minted provider credential after the browser socket opens."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    if admission.resource_kind != "provider":
        raise CleanupFenceError("browser activation requires a provider admission")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            now = datetime.now(UTC)
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                obligation is None
                or obligation["state"] != "open"
                or current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != "provider"
                or current.resource_id != admission.resource_id
                or current.status not in {"credential_minted", "browser_active"}
                or now >= current.lease_expires_at
                or (
                    current.resource_expires_at is not None
                    and now >= current.resource_expires_at
                )
            ):
                raise CleanupFenceError("provider browser activation is unavailable")
            active = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=current.resource_id,
                lease_expires_at=current.lease_expires_at,
                resource_expires_at=current.resource_expires_at,
                status="browser_active",
            )
            _LOCAL_ADMISSIONS[current.admission_id] = active
            return active
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions AS admission
                   SET status = 'browser_active', updated_at = clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                 WHERE admission.admission_id = %s
                   AND admission.cleanup_obligation_id = %s
                   AND admission.resource_kind = 'provider'
                   AND admission.resource_id = %s
                   AND admission.status IN ('credential_minted', 'browser_active')
                   AND admission.lease_expires_at > clock_timestamp()
                   AND admission.resource_expires_at > clock_timestamp()
                   AND obligation.cleanup_obligation_id = admission.cleanup_obligation_id
                   AND obligation.state = 'open'
                RETURNING admission.lease_expires_at,
                          admission.resource_expires_at
                """,
                (admission.admission_id, cleanup_id, admission.resource_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError("provider browser activation is unavailable")
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=admission.resource_id,
                lease_expires_at=row[0],
                resource_expires_at=row[1],
                status="browser_active",
            )


def activate_cleanup_provider_session(
    admission: CleanupAdmission,
    *,
    user_id: str,
    session_id: str,
    metadata: dict[str, Any],
    expected_synthetic: dict[str, Any],
    local_persist: Callable[[dict[str, Any], dict[str, Any]], bool],
) -> CleanupAdmission:
    """Atomically promote the admission and canonical session in production."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    desired_synthetic = metadata.get("synthetic_voice_lab")
    provider_updates = {
        key: desired_synthetic.get(key)
        for key in _PROVIDER_ACTIVATION_METADATA_KEYS
    } if isinstance(desired_synthetic, dict) else {}
    if (
        admission.resource_kind != "provider"
        or not isinstance(user_id, str)
        or not user_id
        or not isinstance(session_id, str)
        or not session_id
        or not isinstance(metadata, dict)
        or not isinstance(desired_synthetic, dict)
        or desired_synthetic.get("cleanup_obligation_id") != cleanup_id
        or desired_synthetic.get("cleanup_provider_admission_id")
        != admission.admission_id
        or desired_synthetic.get("voice_runtime_session_id")
        != admission.resource_id
        or not isinstance(expected_synthetic, dict)
    ):
        raise CleanupFenceError("provider browser activation binding is invalid")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            active = mark_cleanup_admission_browser_active(admission)
            if not local_persist(expected_synthetic, provider_updates):
                current = _LOCAL_ADMISSIONS.get(admission.admission_id)
                if current == active:
                    _LOCAL_ADMISSIONS[admission.admission_id] = admission
                raise CleanupFenceError(
                    "provider browser activation persistence failed"
                )
            return active
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT obligation.state, admission.status,
                       admission.lease_expires_at,
                       admission.resource_expires_at,
                       admission.lease_expires_at > clock_timestamp(),
                       admission.resource_expires_at > clock_timestamp(),
                       session.metadata -> 'synthetic_voice_lab'
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                  JOIN public.sophia_voice_lab_cleanup_admissions AS admission
                    ON admission.cleanup_obligation_id = obligation.cleanup_obligation_id
                  JOIN public.sophia_sessions AS session
                    ON session.id = %s
                   AND session.user_id = %s
                 WHERE obligation.cleanup_obligation_id = %s
                   AND admission.admission_id = %s
                   AND admission.resource_kind = 'provider'
                   AND admission.resource_id = %s
                 FOR UPDATE OF obligation, admission, session
                """,
                (
                    session_id,
                    user_id,
                    cleanup_id,
                    admission.admission_id,
                    admission.resource_id,
                ),
            )
            row = cursor.fetchone()
            if (
                row is None
                or row[0] != "open"
                or row[1] not in {"credential_minted", "browser_active"}
                or row[4] is not True
                or row[5] is not True
            ):
                raise CleanupFenceError("provider browser activation is unavailable")
            current_synthetic = row[6]
            if isinstance(current_synthetic, str):
                try:
                    current_synthetic = json.loads(current_synthetic)
                except json.JSONDecodeError as exc:
                    raise CleanupFenceError(
                        "provider browser activation session binding is malformed"
                    ) from exc
            if not isinstance(current_synthetic, dict):
                raise CleanupFenceError(
                    "provider browser activation session binding is malformed"
                )
            if any(
                current_synthetic.get(key) != value
                for key, value in expected_synthetic.items()
            ):
                raise CleanupFenceError(
                    "provider browser activation session binding conflicts"
                )
            desired_epoch = desired_synthetic.get("voice_provider_connection_epoch")
            current_epoch = current_synthetic.get("voice_provider_connection_epoch")
            current_pending_epoch = current_synthetic.get(
                "voice_provider_pending_connection_epoch"
            )
            common_binding_matches = (
                current_synthetic.get("cleanup_obligation_id") == cleanup_id
                and current_synthetic.get("cleanup_provider_admission_id")
                == admission.admission_id
                and current_synthetic.get("voice_runtime_session_id")
                == admission.resource_id
                and isinstance(desired_epoch, int)
                and desired_epoch > 0
            )
            pending_activation_matches = (
                row[1] == "credential_minted"
                and current_synthetic.get("voice_provider_resource_state")
                == "credential_minted"
                and current_pending_epoch == desired_epoch
                and (current_epoch if isinstance(current_epoch, int) else 0)
                == desired_epoch - 1
            )
            idempotent_activation_matches = (
                row[1] == "browser_active"
                and current_synthetic.get("voice_provider_resource_state") == "active"
                and current_epoch == desired_epoch
                and current_pending_epoch is None
                and current_synthetic.get("voice_provider_activation_receipt")
                == desired_synthetic.get("voice_provider_activation_receipt")
            )
            if not common_binding_matches or not (
                pending_activation_matches or idempotent_activation_matches
            ):
                raise CleanupFenceError(
                    "provider browser activation session binding conflicts"
                )
            next_synthetic = dict(current_synthetic)
            next_synthetic.update(provider_updates)
            serialized_synthetic = json.dumps(
                next_synthetic, sort_keys=True, separators=(",", ":")
            )
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions
                   SET status = 'browser_active', updated_at = clock_timestamp()
                 WHERE admission_id = %s
                   AND cleanup_obligation_id = %s
                   AND resource_kind = 'provider'
                   AND resource_id = %s
                   AND status IN ('credential_minted', 'browser_active')
                   AND lease_expires_at > clock_timestamp()
                   AND resource_expires_at > clock_timestamp()
                """,
                (admission.admission_id, cleanup_id, admission.resource_id),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("provider browser activation is unavailable")
            cursor.execute(
                """
                UPDATE public.sophia_sessions
                   SET metadata = jsonb_set(
                         metadata,
                         '{synthetic_voice_lab}',
                         %s::jsonb,
                         true
                       ),
                       updated_at = clock_timestamp()
                 WHERE user_id = %s
                   AND id = %s
                   AND metadata -> 'synthetic_voice_lab' ->>
                       'cleanup_obligation_id' = %s
                """,
                (serialized_synthetic, user_id, session_id, cleanup_id),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError(
                    "provider browser activation persistence failed"
                )
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=admission.resource_id,
                lease_expires_at=row[2],
                resource_expires_at=row[3],
                status="browser_active",
            )


def stage_cleanup_provider_candidate(
    admission: CleanupAdmission,
    *,
    user_id: str,
    session_id: str,
    expected_epoch: int,
    expected_pending_epoch: int | None,
    next_epoch: int,
    local_persist: Callable[[dict[str, Any], dict[str, Any]], bool],
) -> None:
    """Stage one continuation candidate under the durable cleanup fence."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    expected = {
        "cleanup_obligation_id": cleanup_id,
        "cleanup_provider_admission_id": admission.admission_id,
        "voice_runtime_session_id": admission.resource_id,
        "voice_provider_resource_state": "active",
        "voice_provider_connection_epoch": expected_epoch,
        "voice_provider_pending_connection_epoch": expected_pending_epoch,
    }
    updates = {"voice_provider_pending_connection_epoch": next_epoch}
    if (
        admission.resource_kind != "provider"
        or admission.status != "browser_active"
        or not user_id
        or not session_id
        or expected_epoch <= 0
        or next_epoch != expected_epoch + 1
        or expected_pending_epoch not in {None, next_epoch}
    ):
        raise CleanupFenceError("provider candidate binding is invalid")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            now = datetime.now(UTC)
            if (
                obligation is None
                or obligation.get("state") != "open"
                or current is None
                or current.status != "browser_active"
                or current.resource_id != admission.resource_id
                or now >= current.lease_expires_at
                or current.resource_expires_at is None
                or now >= current.resource_expires_at
                or not local_persist(expected, updates)
            ):
                raise CleanupFenceError("provider candidate staging is unavailable")
        return
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT session.metadata -> 'synthetic_voice_lab'
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                  JOIN public.sophia_voice_lab_cleanup_admissions AS admission
                    ON admission.cleanup_obligation_id = obligation.cleanup_obligation_id
                  JOIN public.sophia_sessions AS session
                    ON session.id = %s AND session.user_id = %s
                 WHERE obligation.cleanup_obligation_id = %s
                   AND obligation.state = 'open'
                   AND obligation.retention_expires_at > clock_timestamp()
                   AND admission.admission_id = %s
                   AND admission.resource_kind = 'provider'
                   AND admission.resource_id = %s
                   AND admission.status = 'browser_active'
                   AND admission.lease_expires_at > clock_timestamp()
                   AND admission.resource_expires_at > clock_timestamp()
                 FOR UPDATE OF obligation, admission, session
                """,
                (
                    session_id,
                    user_id,
                    cleanup_id,
                    admission.admission_id,
                    admission.resource_id,
                ),
            )
            row = cursor.fetchone()
            current_synthetic = row[0] if row is not None else None
            if isinstance(current_synthetic, str):
                try:
                    current_synthetic = json.loads(current_synthetic)
                except json.JSONDecodeError as exc:
                    raise CleanupFenceError(
                        "provider candidate session binding is malformed"
                    ) from exc
            if not isinstance(current_synthetic, dict) or any(
                current_synthetic.get(key) != value
                for key, value in expected.items()
            ):
                raise CleanupFenceError("provider candidate staging conflicts")
            next_synthetic = dict(current_synthetic)
            next_synthetic.update(updates)
            cursor.execute(
                """
                UPDATE public.sophia_sessions
                   SET metadata = jsonb_set(
                         metadata, '{synthetic_voice_lab}', %s::jsonb, true
                       ),
                       updated_at = clock_timestamp()
                 WHERE id = %s AND user_id = %s
                """,
                (
                    json.dumps(
                        next_synthetic, sort_keys=True, separators=(",", ":")
                    ),
                    session_id,
                    user_id,
                ),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("provider candidate persistence failed")


def close_cleanup_provider_session(
    admission: CleanupAdmission,
    *,
    user_id: str,
    session_id: str,
    metadata: dict[str, Any],
    expected_provider_state: str,
    expected_activated_epoch: int | None,
    expected_pending_epoch: int | None,
    expected_activation_receipt: object,
    terminal_status: str,
    settlement_sha256: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
    local_persist: Callable[[dict[str, Any], dict[str, Any]], bool],
) -> CleanupAdmission:
    """Atomically close admission, obligation, and canonical provider metadata."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    desired_synthetic = metadata.get("synthetic_voice_lab")
    provider_updates = {
        key: desired_synthetic.get(key)
        for key in _PROVIDER_TERMINAL_METADATA_KEYS
    } if isinstance(desired_synthetic, dict) else {}
    if (
        admission.resource_kind != "provider"
        or not isinstance(user_id, str)
        or not user_id
        or not isinstance(session_id, str)
        or not session_id
        or not isinstance(desired_synthetic, dict)
        or desired_synthetic.get("cleanup_obligation_id") != cleanup_id
        or desired_synthetic.get("cleanup_provider_admission_id")
        != admission.admission_id
        or desired_synthetic.get("voice_runtime_session_id")
        != admission.resource_id
        or desired_synthetic.get("voice_provider_resource_state") != "closed"
        or expected_provider_state not in {"credential_minted", "active", "closed"}
        or terminal_status not in {"activation_aborted", "browser_closed"}
        or re.fullmatch(r"[a-f0-9]{64}", settlement_sha256) is None
    ):
        raise CleanupFenceError("provider browser close binding is invalid")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            obligation_before = dict(_LOCAL_OBLIGATIONS.get(cleanup_id) or {})
            admission_before = _LOCAL_ADMISSIONS.get(admission.admission_id)
            existing_settlement = obligation_before.get("provider_settlement_sha256")
            if existing_settlement not in {None, settlement_sha256}:
                raise CleanupFenceError("provider browser settlement conflicts")
            close_cleanup_obligation(
                cleanup_id,
                retention_deadline,
                provider_deadline,
            )
            closed = (
                mark_cleanup_admission_activation_aborted(admission)
                if terminal_status == "activation_aborted"
                else mark_cleanup_admission_browser_closed(admission)
            )
            _LOCAL_OBLIGATIONS[cleanup_id]["provider_settlement_sha256"] = (
                settlement_sha256
            )
            expected_synthetic = {
                "cleanup_obligation_id": cleanup_id,
                "cleanup_provider_admission_id": admission.admission_id,
                "voice_runtime_session_id": admission.resource_id,
                "voice_provider_resource_state": expected_provider_state,
                "voice_provider_connection_epoch": expected_activated_epoch,
                "voice_provider_pending_connection_epoch": expected_pending_epoch,
                "voice_provider_activation_receipt": expected_activation_receipt,
            }
            if not local_persist(expected_synthetic, provider_updates):
                if obligation_before:
                    _LOCAL_OBLIGATIONS[cleanup_id] = obligation_before
                else:
                    _LOCAL_OBLIGATIONS.pop(cleanup_id, None)
                if admission_before is not None:
                    _LOCAL_ADMISSIONS[admission.admission_id] = admission_before
                raise CleanupFenceError("provider browser close persistence failed")
            return closed

    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT obligation.state,
                       obligation.retention_expires_at,
                       obligation.provider_expires_at,
                       obligation.provider_settlement_sha256,
                       admission.status,
                       admission.lease_expires_at,
                       admission.resource_expires_at,
                       session.metadata -> 'synthetic_voice_lab'
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                  JOIN public.sophia_voice_lab_cleanup_admissions AS admission
                    ON admission.cleanup_obligation_id = obligation.cleanup_obligation_id
                  JOIN public.sophia_sessions AS session
                    ON session.id = %s
                   AND session.user_id = %s
                 WHERE obligation.cleanup_obligation_id = %s
                   AND admission.admission_id = %s
                   AND admission.resource_kind = 'provider'
                   AND admission.resource_id = %s
                 FOR UPDATE OF obligation, admission, session
                """,
                (
                    session_id,
                    user_id,
                    cleanup_id,
                    admission.admission_id,
                    admission.resource_id,
                ),
            )
            row = cursor.fetchone()
            if (
                row is None
                or row[0] not in {"open", "closed"}
                or row[1] != retention_deadline
                or row[2] != provider_deadline
                or row[3] not in {None, settlement_sha256}
                or row[4]
                not in {
                    "credential_minted",
                    "browser_active",
                    "activation_aborted",
                    "browser_closed",
                }
                or (
                    terminal_status == "activation_aborted"
                    and (
                        row[4] not in {"credential_minted", "activation_aborted"}
                        or expected_provider_state != "credential_minted"
                    )
                )
                or (
                    terminal_status == "browser_closed"
                    and row[4]
                    not in {
                        "credential_minted",
                        "browser_active",
                        "browser_closed",
                    }
                )
            ):
                raise CleanupFenceError("provider browser close is unavailable")
            current_synthetic = row[7]
            if isinstance(current_synthetic, str):
                try:
                    current_synthetic = json.loads(current_synthetic)
                except json.JSONDecodeError as exc:
                    raise CleanupFenceError(
                        "provider browser close session binding is malformed"
                    ) from exc
            if (
                not isinstance(current_synthetic, dict)
                or current_synthetic.get("cleanup_obligation_id") != cleanup_id
                or current_synthetic.get("cleanup_provider_admission_id")
                != admission.admission_id
                or current_synthetic.get("voice_runtime_session_id")
                != admission.resource_id
                or current_synthetic.get("voice_provider_resource_state")
                != expected_provider_state
                or current_synthetic.get("voice_provider_connection_epoch")
                != expected_activated_epoch
                or current_synthetic.get("voice_provider_pending_connection_epoch")
                != expected_pending_epoch
                or current_synthetic.get("voice_provider_activation_receipt")
                != expected_activation_receipt
            ):
                raise CleanupFenceError(
                    "provider browser close session binding conflicts"
                )
            next_synthetic = dict(current_synthetic)
            next_synthetic.update(provider_updates)
            serialized_synthetic = json.dumps(
                next_synthetic, sort_keys=True, separators=(",", ":")
            )
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_obligations
                   SET state = 'closed',
                       closed_at = COALESCE(closed_at, clock_timestamp()),
                       provider_settlement_sha256 = COALESCE(
                         provider_settlement_sha256, %s
                       ),
                       updated_at = clock_timestamp()
                 WHERE cleanup_obligation_id = %s
                   AND state IN ('open', 'closed')
                   AND retention_expires_at = %s
                   AND provider_expires_at = %s
                   AND (
                     provider_settlement_sha256 IS NULL
                     OR provider_settlement_sha256 = %s
                   )
                """,
                (
                    settlement_sha256,
                    cleanup_id,
                    retention_deadline,
                    provider_deadline,
                    settlement_sha256,
                ),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("provider browser close fence is unavailable")
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions
                   SET status = %s, updated_at = clock_timestamp()
                 WHERE admission_id = %s
                   AND cleanup_obligation_id = %s
                   AND resource_kind = 'provider'
                   AND resource_id = %s
                   AND (
                     (%s = 'activation_aborted'
                      AND status IN ('credential_minted', 'activation_aborted'))
                     OR
                     (%s = 'browser_closed'
                      AND status IN (
                        'credential_minted', 'browser_active', 'browser_closed'
                      ))
                   )
                """,
                (
                    terminal_status,
                    admission.admission_id,
                    cleanup_id,
                    admission.resource_id,
                    terminal_status,
                    terminal_status,
                ),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("provider browser close is unavailable")
            cursor.execute(
                """
                UPDATE public.sophia_sessions
                   SET metadata = jsonb_set(
                         metadata,
                         '{synthetic_voice_lab}',
                         %s::jsonb,
                         true
                       ),
                       updated_at = clock_timestamp()
                 WHERE user_id = %s
                   AND id = %s
                   AND metadata -> 'synthetic_voice_lab' ->>
                       'cleanup_obligation_id' = %s
                """,
                (serialized_synthetic, user_id, session_id, cleanup_id),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("provider browser close persistence failed")
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=admission.resource_id,
                lease_expires_at=row[5],
                resource_expires_at=row[6],
                status=terminal_status,
            )


def mark_cleanup_admission_activation_aborted(
    admission: CleanupAdmission,
) -> CleanupAdmission:
    """Settle a credential that product code proves was never browser-activated."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    if admission.resource_kind != "provider":
        raise CleanupFenceError("activation abort requires a provider admission")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != "provider"
                or current.resource_id != admission.resource_id
                or current.status not in {"credential_minted", "activation_aborted"}
            ):
                raise CleanupFenceError("provider activation abort is unavailable")
            aborted = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=current.resource_id,
                lease_expires_at=current.lease_expires_at,
                resource_expires_at=current.resource_expires_at,
                status="activation_aborted",
            )
            _LOCAL_ADMISSIONS[current.admission_id] = aborted
            return aborted
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions
                   SET status = 'activation_aborted', updated_at = clock_timestamp()
                 WHERE admission_id = %s
                   AND cleanup_obligation_id = %s
                   AND resource_kind = 'provider'
                   AND resource_id = %s
                   AND status IN ('credential_minted', 'activation_aborted')
                RETURNING lease_expires_at, resource_expires_at
                """,
                (admission.admission_id, cleanup_id, admission.resource_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError("provider activation abort is unavailable")
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=admission.resource_id,
                lease_expires_at=row[0],
                resource_expires_at=row[1],
                status="activation_aborted",
            )


def abort_unpublished_cleanup_provider_session(
    admission: CleanupAdmission,
    *,
    user_id: str,
    session_id: str,
    expected_pending_epoch: int,
    existing_synthetic: dict[str, Any],
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
    local_persist: Callable[[dict[str, Any], dict[str, Any]], bool],
) -> CleanupAdmission:
    """Atomically settle a credential that was never returned to a browser.

    The initial provider allocation is bound before the Gateway serializes and
    returns its browser credential.  If CLOSED wins in that narrow interval,
    changing only the admission status leaves canonical metadata claiming a
    live credential and prevents the owning Voice terminal callback from ever
    being consumed.  This transition joins CLOSED, admission abort, and the
    provider-owned session metadata under the cleanup advisory key.
    """

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    if (
        admission.resource_kind != "provider"
        or not admission.resource_id
        or not user_id
        or not session_id
        or not isinstance(expected_pending_epoch, int)
        or expected_pending_epoch <= 0
        or not isinstance(existing_synthetic, dict)
        or admission.resource_expires_at is None
        or admission.resource_expires_at != provider_deadline
    ):
        raise CleanupFenceError("unpublished provider abort binding is invalid")

    def provider_transition(
        current_synthetic: dict[str, Any],
        database_now: datetime,
        current_status: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        current_state = current_synthetic.get("voice_provider_resource_state")
        current_pending = current_synthetic.get(
            "voice_provider_pending_connection_epoch"
        )
        current_epoch = current_synthetic.get("voice_provider_connection_epoch")
        current_activation = current_synthetic.get(
            "voice_provider_activation_receipt"
        )
        idempotent = (
            current_status == "activation_aborted"
            and current_state == "closed"
            and current_pending is None
        )
        unpublished = (
            current_status == "credential_minted"
            and current_state == "credential_minted"
            and current_pending == expected_pending_epoch
            and current_epoch in {None, 0}
            and current_activation is None
        )
        if not (unpublished or idempotent):
            raise CleanupFenceError("unpublished provider abort conflicts")
        if (
            current_synthetic.get("cleanup_obligation_id") != cleanup_id
            or current_synthetic.get("cleanup_provider_admission_id")
            != admission.admission_id
            or current_synthetic.get("voice_runtime_session_id")
            != admission.resource_id
        ):
            raise CleanupFenceError("unpublished provider abort binding conflicts")
        expected = {
            "cleanup_obligation_id": cleanup_id,
            "cleanup_provider_admission_id": admission.admission_id,
            "voice_runtime_session_id": admission.resource_id,
            "voice_provider_resource_state": current_state,
            "voice_provider_connection_epoch": current_epoch,
            "voice_provider_pending_connection_epoch": current_pending,
            "voice_provider_activation_receipt": current_activation,
        }
        updates: dict[str, Any] = {
            "voice_provider_resource_state": "closed",
            "voice_provider_pending_connection_epoch": None,
            "voice_provider_browser_close_receipts": [],
            "voice_provider_activation_abort_receipts": [],
        }
        if not idempotent:
            updates["voice_provider_closed_at"] = (
                database_now.astimezone(UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
        return expected, updates

    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                obligation is None
                or obligation.get("state") not in {"open", "closed"}
                or obligation.get("retention_expires_at") != retention_deadline
                or obligation.get("provider_expires_at") != provider_deadline
                or current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != "provider"
                or current.resource_id != admission.resource_id
                or current.status not in {"credential_minted", "activation_aborted"}
                or current.resource_expires_at != provider_deadline
            ):
                raise CleanupFenceError("unpublished provider abort is unavailable")
            database_now = datetime.now(UTC)
            expected, updates = provider_transition(
                existing_synthetic,
                database_now,
                current.status,
            )
            obligation_before = dict(obligation)
            current_before = current
            obligation["state"] = "closed"
            obligation.setdefault("closed_at", database_now)
            aborted = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=current.resource_id,
                lease_expires_at=current.lease_expires_at,
                resource_expires_at=current.resource_expires_at,
                status="activation_aborted",
            )
            _LOCAL_ADMISSIONS[current.admission_id] = aborted
            try:
                persisted = local_persist(expected, updates)
            except Exception:
                _LOCAL_OBLIGATIONS[cleanup_id] = obligation_before
                _LOCAL_ADMISSIONS[current.admission_id] = current_before
                raise
            if not persisted:
                _LOCAL_OBLIGATIONS[cleanup_id] = obligation_before
                _LOCAL_ADMISSIONS[current.admission_id] = current_before
                raise CleanupFenceError(
                    "unpublished provider abort persistence failed"
                )
            return aborted

    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT obligation.state,
                       obligation.retention_expires_at,
                       obligation.provider_expires_at,
                       admission.status,
                       admission.lease_expires_at,
                       admission.resource_expires_at,
                       session.metadata -> 'synthetic_voice_lab',
                       clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                  JOIN public.sophia_voice_lab_cleanup_admissions AS admission
                    ON admission.cleanup_obligation_id =
                       obligation.cleanup_obligation_id
                  JOIN public.sophia_sessions AS session
                    ON session.id = %s AND session.user_id = %s
                 WHERE obligation.cleanup_obligation_id = %s
                   AND admission.admission_id = %s
                   AND admission.resource_kind = 'provider'
                   AND admission.resource_id = %s
                 FOR UPDATE OF obligation, admission, session
                """,
                (
                    session_id,
                    user_id,
                    cleanup_id,
                    admission.admission_id,
                    admission.resource_id,
                ),
            )
            row = cursor.fetchone()
            if (
                row is None
                or row[0] not in {"open", "closed"}
                or row[1] != retention_deadline
                or row[2] != provider_deadline
                or row[3] not in {"credential_minted", "activation_aborted"}
                or row[5] != provider_deadline
            ):
                raise CleanupFenceError("unpublished provider abort is unavailable")
            current_synthetic = row[6]
            if isinstance(current_synthetic, str):
                try:
                    current_synthetic = json.loads(current_synthetic)
                except json.JSONDecodeError as exc:
                    raise CleanupFenceError(
                        "unpublished provider abort session binding is malformed"
                    ) from exc
            if not isinstance(current_synthetic, dict):
                raise CleanupFenceError(
                    "unpublished provider abort session binding is malformed"
                )
            _expected, updates = provider_transition(
                current_synthetic, row[7], row[3]
            )
            next_synthetic = dict(current_synthetic)
            next_synthetic.update(updates)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_obligations
                   SET state = 'closed',
                       closed_at = COALESCE(closed_at, clock_timestamp()),
                       updated_at = clock_timestamp()
                 WHERE cleanup_obligation_id = %s
                   AND state IN ('open', 'closed')
                   AND retention_expires_at = %s
                   AND provider_expires_at = %s
                """,
                (cleanup_id, retention_deadline, provider_deadline),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("unpublished provider abort fence is unavailable")
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions
                   SET status = 'activation_aborted',
                       updated_at = clock_timestamp()
                 WHERE admission_id = %s
                   AND cleanup_obligation_id = %s
                   AND resource_kind = 'provider'
                   AND resource_id = %s
                   AND status IN ('credential_minted', 'activation_aborted')
                """,
                (admission.admission_id, cleanup_id, admission.resource_id),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError("unpublished provider abort is unavailable")
            cursor.execute(
                """
                UPDATE public.sophia_sessions
                   SET metadata = jsonb_set(
                         metadata, '{synthetic_voice_lab}', %s::jsonb, true
                       ),
                       updated_at = clock_timestamp()
                 WHERE id = %s
                   AND user_id = %s
                   AND metadata -> 'synthetic_voice_lab' ->>
                       'cleanup_obligation_id' = %s
                """,
                (
                    json.dumps(
                        next_synthetic, sort_keys=True, separators=(",", ":")
                    ),
                    session_id,
                    user_id,
                    cleanup_id,
                ),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError(
                    "unpublished provider abort persistence failed"
                )
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=admission.resource_id,
                lease_expires_at=row[4],
                resource_expires_at=row[5],
                status="activation_aborted",
            )


def verify_cleanup_provider_settlement_replay(
    cleanup_obligation_id: str,
    settlement_sha256: str,
) -> bool:
    """Verify an exact settlement retry after raw session/admission deletion."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    if re.fullmatch(r"[a-f0-9]{64}", settlement_sha256) is None:
        raise CleanupFenceError("provider settlement digest is malformed")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            return bool(
                obligation is not None
                and obligation.get("state") in {"closed", "complete"}
                and obligation.get("provider_settlement_sha256")
                == settlement_sha256
            )
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT 1
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = %s
                   AND state IN ('closed', 'complete')
                   AND provider_settlement_sha256 = %s
                """,
                (cleanup_id, settlement_sha256),
            )
            return cursor.fetchone() is not None


def mark_cleanup_admission_browser_closed(
    admission: CleanupAdmission,
) -> CleanupAdmission:
    """Record the governed browser WebSocket close without claiming relay zero."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != "provider"
                or current.resource_id != admission.resource_id
                or current.status
                not in {"credential_minted", "browser_active", "browser_closed"}
            ):
                raise CleanupFenceError("provider browser close binding is unavailable")
            closed = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=current.resource_kind,
                resource_id=current.resource_id,
                lease_expires_at=current.lease_expires_at,
                resource_expires_at=current.resource_expires_at,
                status="browser_closed",
            )
            _LOCAL_ADMISSIONS[current.admission_id] = closed
            return closed
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions
                   SET status = 'browser_closed', updated_at = clock_timestamp()
                 WHERE admission_id = %s
                   AND cleanup_obligation_id = %s
                   AND resource_kind = 'provider'
                   AND resource_id IS NOT DISTINCT FROM %s
                   AND status IN (
                     'credential_minted', 'browser_active', 'browser_closed'
                   )
                RETURNING lease_expires_at, resource_expires_at
                """,
                (admission.admission_id, cleanup_id, admission.resource_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError("provider browser close binding is unavailable")
            return CleanupAdmission(
                admission_id=admission.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind="provider",
                resource_id=admission.resource_id,
                lease_expires_at=row[0],
                resource_expires_at=row[1],
                status="browser_closed",
            )


def renew_cleanup_admission(
    *,
    admission_id: str,
    cleanup_obligation_id: str,
    resource_kind: str,
    resource_id: str,
) -> CleanupAdmission:
    """Heartbeat one exact bound resource only while obligation remains OPEN."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    kind = _validated_kind(resource_kind)
    try:
        parsed_admission_id = str(uuid.UUID(admission_id))
    except (TypeError, ValueError) as exc:
        raise CleanupFenceError("cleanup admission id is invalid") from exc
    if parsed_admission_id != admission_id or not resource_id:
        raise CleanupFenceError("cleanup admission identity is invalid")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_id)
            current = _LOCAL_ADMISSIONS.get(admission_id)
            if (
                obligation is None
                or obligation["state"] != "open"
                or current is None
                or current.resource_kind != kind
                or current.resource_id != resource_id
                or current.status != "browser_active"
                or (
                    current.resource_expires_at is not None
                    and datetime.now(UTC) >= current.resource_expires_at
                )
            ):
                raise CleanupFenceError("cleanup obligation admission is closed")
            renewed = CleanupAdmission(
                admission_id=current.admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=kind,
                resource_id=resource_id,
                lease_expires_at=min(
                    current.resource_expires_at or obligation["retention_expires_at"],
                    obligation["retention_expires_at"],
                    datetime.now(UTC)
                    + timedelta(seconds=_ADMISSION_LEASE_SECONDS),
                ),
                resource_expires_at=current.resource_expires_at,
                status=current.status,
            )
            _LOCAL_ADMISSIONS[admission_id] = renewed
            return renewed
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                UPDATE public.sophia_voice_lab_cleanup_admissions AS admission
                   SET lease_expires_at = LEAST(
                         admission.resource_expires_at,
                         obligation.retention_expires_at,
                         clock_timestamp() + make_interval(secs => %s)
                       ),
                       updated_at = clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                 WHERE admission.admission_id = %s
                   AND admission.cleanup_obligation_id = %s
                   AND admission.resource_kind = %s
                   AND admission.resource_id = %s
                   AND obligation.cleanup_obligation_id = admission.cleanup_obligation_id
                   AND obligation.state = 'open'
                   AND obligation.retention_expires_at > clock_timestamp()
                   AND admission.status = 'browser_active'
                   AND admission.resource_expires_at > clock_timestamp()
                RETURNING admission.lease_expires_at, admission.status,
                          admission.resource_expires_at
                """,
                (
                    _ADMISSION_LEASE_SECONDS,
                    admission_id,
                    cleanup_id,
                    kind,
                    resource_id,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError("cleanup obligation admission is closed")
            return CleanupAdmission(
                admission_id=admission_id,
                cleanup_obligation_id=cleanup_id,
                resource_kind=kind,
                resource_id=resource_id,
                lease_expires_at=row[0],
                resource_expires_at=row[2],
                status=str(row[1]),
            )


def release_cleanup_admission(admission: CleanupAdmission) -> None:
    """Release only the exact reservation after bind or verified compensation."""

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                current is not None
                and current.cleanup_obligation_id == cleanup_id
                and current.resource_kind == admission.resource_kind
                and current.resource_id == admission.resource_id
                and current.status == admission.status
                and current.lease_expires_at == admission.lease_expires_at
                and current.resource_expires_at == admission.resource_expires_at
            ):
                _LOCAL_ADMISSIONS.pop(admission.admission_id, None)
        return
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                DELETE FROM public.sophia_voice_lab_cleanup_admissions
                 WHERE admission_id = %s AND cleanup_obligation_id = %s
                   AND resource_kind = %s
                   AND resource_id IS NOT DISTINCT FROM %s
                   AND status = %s
                   AND lease_expires_at = %s
                   AND resource_expires_at IS NOT DISTINCT FROM %s
                """,
                (
                    admission.admission_id,
                    cleanup_id,
                    admission.resource_kind,
                    admission.resource_id,
                    admission.status,
                    admission.lease_expires_at,
                    admission.resource_expires_at,
                ),
            )


def complete_cleanup_admission(
    admission: CleanupAdmission,
    *,
    basis: str,
) -> bool:
    """Consume a provider locator only after an authoritative terminal fact.

    Voice relay teardown is not browser/provider teardown.  It may consume a
    never-bound reservation after its DB lease.  A BOUND provider locator is
    retained until a separately validated browser WebSocket close receipt;
    the immutable message deadline bounds spend but does not prove socket zero.
    """

    if basis != "server_relay_zero":
        raise CleanupFenceError("cleanup completion basis is invalid")
    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if current is None:
                return True
            if (
                current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != admission.resource_kind
                or current.resource_id != admission.resource_id
                or current.status != admission.status
                or current.lease_expires_at != admission.lease_expires_at
                or current.resource_expires_at != admission.resource_expires_at
            ):
                return False
            now = datetime.now(UTC)
            allowed = (
                current.status
                in {"allocating", "browser_closed", "activation_aborted"}
            ) or (
                current.status == "reserved" and now >= current.lease_expires_at
            )
            if allowed and current.cleanup_obligation_id == cleanup_id:
                _LOCAL_ADMISSIONS.pop(admission.admission_id, None)
                return True
            return False
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                DELETE FROM public.sophia_voice_lab_cleanup_admissions
                 WHERE admission_id = %s
                   AND cleanup_obligation_id = %s
                   AND resource_kind = %s
                   AND resource_id IS NOT DISTINCT FROM %s
                   AND status = %s
                   AND lease_expires_at = %s
                   AND resource_expires_at IS NOT DISTINCT FROM %s
                   AND (
                     status IN (
                       'allocating', 'browser_closed', 'activation_aborted'
                     )
                     OR (status = 'reserved'
                         AND lease_expires_at <= clock_timestamp())
                   )
                """,
                (
                    admission.admission_id,
                    cleanup_id,
                    admission.resource_kind,
                    admission.resource_id,
                    admission.status,
                    admission.lease_expires_at,
                    admission.resource_expires_at,
                ),
            )
            return cursor.rowcount == 1


def persist_cleanup_provider_terminal_receipt(
    admission: CleanupAdmission,
    *,
    user_id: str,
    session_id: str,
    receipt: dict[str, Any],
    local_persist: Callable[[dict[str, Any], dict[str, Any]], bool],
) -> None:
    """Persist an owning Voice terminal receipt before consuming its locator.

    The raw, product-authored trace receipt belongs with the governed session,
    never in the content-free cleanup-control tables.  The admission and
    session row are locked under the cleanup-obligation advisory key so a
    callback cannot attach a receipt to a replaced provider binding.
    """

    cleanup_id = _validated_cleanup_id(admission.cleanup_obligation_id)
    if (
        admission.resource_kind != "provider"
        or admission.status
        not in {
            "reserved",
            "allocating",
            "browser_closed",
            "activation_aborted",
        }
        or (admission.status == "reserved" and not admission.expired)
        or not user_id
        or not session_id
        or not isinstance(receipt, dict)
    ):
        raise CleanupFenceError("provider terminal receipt binding is invalid")
    expected = {"cleanup_obligation_id": cleanup_id}
    if admission.status in {"reserved", "allocating"}:
        expected.update(
            {
                "cleanup_provider_admission_id": None,
                "voice_runtime_session_id": None,
            }
        )
    else:
        expected.update(
            {
                "cleanup_provider_admission_id": admission.admission_id,
                "voice_runtime_session_id": admission.resource_id,
                "voice_provider_resource_state": "closed",
            }
        )
    receipt_envelope = {
        "schema": "sophia_voice_lab_provider_trace_fault_terminal_v1",
        "cleanup_obligation_id": cleanup_id,
        "cleanup_provider_admission_id": admission.admission_id,
        "provider_session_id": admission.resource_id,
        "trace_fault": receipt,
    }
    updates = {
        "voice_provider_trace_fault_restore_receipt": receipt_envelope
    }
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            current = _LOCAL_ADMISSIONS.get(admission.admission_id)
            if (
                current is None
                or current.cleanup_obligation_id != cleanup_id
                or current.resource_kind != "provider"
                or current.resource_id != admission.resource_id
                or current.status
                not in {
                    "reserved",
                    "allocating",
                    "browser_closed",
                    "activation_aborted",
                }
                or (
                    current.status == "reserved"
                    and datetime.now(UTC) < current.lease_expires_at
                )
                or not local_persist(expected, updates)
            ):
                raise CleanupFenceError(
                    "provider terminal receipt persistence failed"
                )
        return

    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT obligation.state, admission.status,
                       admission.lease_expires_at <= clock_timestamp(),
                       session.metadata -> 'synthetic_voice_lab'
                  FROM public.sophia_voice_lab_cleanup_obligations AS obligation
                  JOIN public.sophia_voice_lab_cleanup_admissions AS admission
                    ON admission.cleanup_obligation_id = obligation.cleanup_obligation_id
                  JOIN public.sophia_sessions AS session
                    ON session.id = %s AND session.user_id = %s
                 WHERE obligation.cleanup_obligation_id = %s
                   AND admission.admission_id = %s
                   AND admission.resource_kind = 'provider'
                   AND admission.resource_id = %s
                 FOR UPDATE OF obligation, admission, session
                """,
                (
                    session_id,
                    user_id,
                    cleanup_id,
                    admission.admission_id,
                    admission.resource_id,
                ),
            )
            row = cursor.fetchone()
            if (
                row is None
                or row[0] not in {"open", "closed", "complete"}
                or row[1]
                not in {
                    "reserved",
                    "allocating",
                    "browser_closed",
                    "activation_aborted",
                }
                or (row[1] == "reserved" and row[2] is not True)
            ):
                raise CleanupFenceError(
                    "provider terminal receipt persistence is unavailable"
                )
            current_synthetic = row[3]
            if isinstance(current_synthetic, str):
                try:
                    current_synthetic = json.loads(current_synthetic)
                except json.JSONDecodeError as exc:
                    raise CleanupFenceError(
                        "provider terminal receipt session binding is malformed"
                    ) from exc
            if not isinstance(current_synthetic, dict) or any(
                current_synthetic.get(key) != value
                for key, value in expected.items()
            ):
                raise CleanupFenceError(
                    "provider terminal receipt session binding conflicts"
                )
            existing = current_synthetic.get(
                "voice_provider_trace_fault_restore_receipt"
            )
            if existing is not None and existing != receipt_envelope:
                raise CleanupFenceError("provider terminal receipt conflicts")
            if existing == receipt_envelope:
                return
            if row[0] == "complete":
                raise CleanupFenceError(
                    "provider terminal receipt persistence is unavailable"
                )
            next_synthetic = dict(current_synthetic)
            next_synthetic.update(updates)
            cursor.execute(
                """
                UPDATE public.sophia_sessions
                   SET metadata = jsonb_set(
                         metadata,
                         '{synthetic_voice_lab}',
                         %s::jsonb,
                         true
                       ),
                       updated_at = clock_timestamp()
                 WHERE id = %s
                   AND user_id = %s
                   AND metadata -> 'synthetic_voice_lab' ->>
                       'cleanup_obligation_id' = %s
                """,
                (
                    json.dumps(
                        next_synthetic, sort_keys=True, separators=(",", ":")
                    ),
                    session_id,
                    user_id,
                    cleanup_id,
                ),
            )
            if cursor.rowcount != 1:
                raise CleanupFenceError(
                    "provider terminal receipt persistence failed"
                )


def close_cleanup_obligation_with_cursor(
    cursor: Any,
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> CleanupFenceStatus:
    """Publish durable CLOSED before any live-cleanup success is observable."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    if provider_deadline > deadline:
        raise CleanupFenceError("provider absolute deadline exceeds retention")
    cursor.execute(
        """
        UPDATE public.sophia_voice_lab_cleanup_obligations
           SET state = 'closed',
               closed_at = clock_timestamp(),
               updated_at = clock_timestamp()
         WHERE cleanup_obligation_id = %s
           AND state = 'open'
           AND retention_expires_at = %s
           AND provider_expires_at = %s
        RETURNING state, retention_expires_at, provider_expires_at
        """,
        (cleanup_id, deadline, provider_deadline),
    )
    row = cursor.fetchone()
    if row is None:
        cursor.execute(
            """
            SELECT state, retention_expires_at, provider_expires_at
             FROM public.sophia_voice_lab_cleanup_obligations
             WHERE cleanup_obligation_id = %s
             FOR UPDATE
            """,
            (cleanup_id,),
        )
        row = cursor.fetchone()
        if row is None:
            raise CleanupFenceError("cleanup obligation fence is unavailable")
    if row[1] != deadline or row[2] != provider_deadline:
        raise CleanupFenceError("cleanup deadline binding conflicts")
    if row[0] not in {"closed", "complete"}:
        raise CleanupFenceError("cleanup obligation close conflicts")
    cursor.execute(
        """
        SELECT
          count(*) FILTER (WHERE lease_expires_at > clock_timestamp()),
          count(*) FILTER (WHERE lease_expires_at <= clock_timestamp())
          FROM public.sophia_voice_lab_cleanup_admissions
         WHERE cleanup_obligation_id = %s
        """,
        (cleanup_id,),
    )
    counts = cursor.fetchone() or (0, 0)
    return CleanupFenceStatus(
        state=str(row[0]),
        active_admissions=int(counts[0] or 0),
        expired_admissions=int(counts[1] or 0),
        retention_expires_at=row[1],
        provider_expires_at=row[2],
    )


@contextmanager
def local_cleanup_finalization_guard(
    cleanup_obligation_id: str,
    provisional_retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
    finalized_retention_expires_at: str | datetime,
) -> Iterator[None]:
    """Serialize local-dev product writes with the sole retention promotion."""

    if _dsn():
        raise CleanupFenceError("local finalization guard requires local mode")
    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    provisional_deadline = _parsed_deadline(provisional_retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    finalized_deadline = _parsed_deadline(finalized_retention_expires_at)
    if provider_deadline > provisional_deadline or provider_deadline > finalized_deadline:
        raise CleanupFenceError("provider absolute deadline exceeds retention")
    with _LOCAL_LOCK:
        row = _LOCAL_OBLIGATIONS.get(cleanup_id)
        if (
            row is None
            or row.get("state") != "open"
            or row.get("retention_expires_at") != provisional_deadline
            or row.get("provider_expires_at") != provider_deadline
            or datetime.now(UTC) >= provisional_deadline
        ):
            raise CleanupFenceError("synthetic provisional finalization is unavailable")
        yield
        row["state"] = "closed"
        row.setdefault("closed_at", datetime.now(UTC))
        row["lifecycle_phase"] = "finalized"
        row["retention_expires_at"] = finalized_deadline


@contextmanager
def local_cleanup_retention_guard(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
    *,
    expected_lifecycle_phase: str,
) -> Iterator[None]:
    """Hold the local cleanup fence across an exact due-retention purge."""

    if _dsn():
        raise CleanupFenceError("local retention guard requires local mode")
    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    if expected_lifecycle_phase not in {"session_provisional", "finalized"}:
        raise CleanupFenceError("cleanup retention lifecycle phase is invalid")
    with _LOCAL_LOCK:
        row = _LOCAL_OBLIGATIONS.get(cleanup_id)
        if (
            row is None
            or row.get("state") != "closed"
            or row.get("lifecycle_phase") != expected_lifecycle_phase
            or row.get("retention_expires_at") != retention_deadline
            or row.get("provider_expires_at") != provider_deadline
            or datetime.now(UTC) < retention_deadline
            or any(
                item.cleanup_obligation_id == cleanup_id
                for item in _LOCAL_ADMISSIONS.values()
            )
        ):
            raise CleanupFenceError("cleanup retention deletion fence is unavailable")
        yield


@contextmanager
def local_cleanup_prepared_guard(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> Iterator[None]:
    """Serialize local PREPARED creation against terminal completion."""

    if _dsn():
        raise CleanupFenceError("local PREPARED guard requires local mode")
    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    with _LOCAL_LOCK:
        row = _LOCAL_OBLIGATIONS.get(cleanup_id)
        if (
            row is None
            or row.get("state") != "closed"
            or row.get("retention_expires_at") != retention_deadline
            or row.get("provider_expires_at") != provider_deadline
            or datetime.now(UTC) < retention_deadline
        ):
            raise CleanupFenceError("cleanup PREPARED authority is unavailable")
        yield


def close_cleanup_obligation(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> CleanupFenceStatus:
    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    if provider_deadline > deadline:
        raise CleanupFenceError("provider absolute deadline exceeds retention")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if row is None:
                raise CleanupFenceError("cleanup obligation fence is unavailable")
            if (
                row["provider_expires_at"] != provider_deadline
                or row["retention_expires_at"] != deadline
            ):
                raise CleanupFenceError("cleanup deadline binding conflicts")
            if row["state"] == "open":
                row["state"] = "closed"
                row["closed_at"] = datetime.now(UTC)
            elif row["state"] not in {"closed", "complete"}:
                raise CleanupFenceError("cleanup obligation close conflicts")
            active = sum(
                1
                for item in _LOCAL_ADMISSIONS.values()
                if item.cleanup_obligation_id == cleanup_id
                and item.lease_expires_at > datetime.now(UTC)
            )
            expired = sum(
                1
                for item in _LOCAL_ADMISSIONS.values()
                if item.cleanup_obligation_id == cleanup_id
                and item.lease_expires_at <= datetime.now(UTC)
            )
            return CleanupFenceStatus(
                str(row["state"]),
                active,
                expired,
                row["retention_expires_at"],
                row["provider_expires_at"],
            )
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            return close_cleanup_obligation_with_cursor(
                cursor, cleanup_id, deadline, provider_deadline
            )


def close_existing_cleanup_obligation(
    cleanup_obligation_id: str,
) -> CleanupFenceStatus:
    """Close using only the immutable deadlines already owned by the fence."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if row is None:
                raise CleanupFenceError("cleanup obligation fence is unavailable")
            deadline = row.get("retention_expires_at")
            provider_deadline = row.get("provider_expires_at")
            if not isinstance(deadline, datetime) or not isinstance(
                provider_deadline, datetime
            ):
                raise CleanupFenceError("cleanup deadline authority is unavailable")
            return close_cleanup_obligation(
                cleanup_id,
                deadline,
                provider_deadline,
            )
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT retention_expires_at, provider_expires_at
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = %s
                 FOR UPDATE
                """,
                (cleanup_id,),
            )
            row = cursor.fetchone()
            if row is None or row[0] is None or row[1] is None:
                raise CleanupFenceError("cleanup deadline authority is unavailable")
            return close_cleanup_obligation_with_cursor(
                cursor,
                cleanup_id,
                row[0],
                row[1],
            )


def close_or_seed_auth_provisional_cleanup_obligation(
    cleanup_obligation_id: str,
    provider_expires_at: str | datetime,
) -> CleanupFenceStatus:
    """Close an existing fence or atomically seed a rejected-auth fence CLOSED.

    The frontend grant transaction creates the auth-provisional obligation
    before it creates any Better Auth session or grant row. A rejection before
    that boundary rolls the entire transaction back, so recovery can observe no
    row at all. Serializing on the same cleanup advisory lock lets the private,
    signed recovery boundary publish CLOSED for that allocation-free case. A
    concurrent grant exchange either commits first and is closed here, or sees
    CLOSED afterward and cannot allocate.
    """

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    provider_deadline = _parsed_deadline(provider_expires_at)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if row is None:
                observed_at = datetime.now(UTC)
                _LOCAL_OBLIGATIONS[cleanup_id] = {
                    "state": "closed",
                    "lifecycle_phase": "auth_provisional",
                    "retention_expires_at": provider_deadline,
                    "provider_expires_at": provider_deadline,
                    "live_cleanup_completed_at": None,
                    "created_at": observed_at,
                    "updated_at": observed_at,
                    "closed_at": observed_at,
                }
                return CleanupFenceStatus(
                    "closed",
                    0,
                    0,
                    provider_deadline,
                    provider_deadline,
                )
            return close_cleanup_obligation(
                cleanup_id,
                row["retention_expires_at"],
                row["provider_expires_at"],
            )
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                INSERT INTO public.sophia_voice_lab_cleanup_obligations (
                    cleanup_obligation_id, state, lifecycle_phase,
                    retention_expires_at, provider_expires_at, closed_at
                )
                VALUES (%s, 'closed', 'auth_provisional', %s, %s,
                        clock_timestamp())
                ON CONFLICT (cleanup_obligation_id) DO NOTHING
                """,
                (cleanup_id, provider_deadline, provider_deadline),
            )
            cursor.execute(
                """
                SELECT retention_expires_at, provider_expires_at
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = %s
                 FOR UPDATE
                """,
                (cleanup_id,),
            )
            row = cursor.fetchone()
            if row is None or row[0] is None or row[1] is None:
                raise CleanupFenceError(
                    "cleanup deadline authority is unavailable"
                )
            return close_cleanup_obligation_with_cursor(
                cursor,
                cleanup_id,
                row[0],
                row[1],
            )


def close_cleanup_obligation_if_retention_due(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> CleanupFenceStatus | None:
    """Atomically publish CLOSED only after the owning DB clock reaches retention."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if (
                row is None
                or row.get("state") not in {"open", "closed"}
                or row.get("retention_expires_at") != retention_deadline
                or row.get("provider_expires_at") != provider_deadline
            ):
                raise CleanupFenceError(
                    "cleanup retention deadline authority is unavailable"
                )
            if datetime.now(UTC) < retention_deadline:
                return None
            if row["state"] == "open":
                row["state"] = "closed"
                row["closed_at"] = datetime.now(UTC)
            active = sum(
                1
                for item in _LOCAL_ADMISSIONS.values()
                if item.cleanup_obligation_id == cleanup_id
                and item.lease_expires_at > datetime.now(UTC)
            )
            expired = sum(
                1
                for item in _LOCAL_ADMISSIONS.values()
                if item.cleanup_obligation_id == cleanup_id
                and item.lease_expires_at <= datetime.now(UTC)
            )
            return CleanupFenceStatus(
                state="closed",
                active_admissions=active,
                expired_admissions=expired,
                retention_expires_at=retention_deadline,
                provider_expires_at=provider_deadline,
            )
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            if not cleanup_retention_due_before_close_with_cursor(
                cursor,
                cleanup_id,
                retention_deadline,
                provider_deadline,
            ):
                return None
            return close_cleanup_obligation_with_cursor(
                cursor,
                cleanup_id,
                retention_deadline,
                provider_deadline,
            )


def close_cleanup_obligation_if_provider_due(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> CleanupFenceStatus | None:
    """Atomically publish CLOSED only after the owning DB provider deadline."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if (
                row is None
                or row.get("state") not in {"open", "closed"}
                or row.get("retention_expires_at") != retention_deadline
                or row.get("provider_expires_at") != provider_deadline
            ):
                raise CleanupFenceError(
                    "cleanup provider deadline authority is unavailable"
                )
            if datetime.now(UTC) < provider_deadline:
                return None
            return close_cleanup_obligation(
                cleanup_id,
                retention_deadline,
                provider_deadline,
            )
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT clock_timestamp() >= provider_expires_at
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = %s
                   AND state IN ('open', 'closed')
                   AND retention_expires_at = %s
                   AND provider_expires_at = %s
                 FOR UPDATE
                """,
                (cleanup_id, retention_deadline, provider_deadline),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError(
                    "cleanup provider deadline authority is unavailable"
                )
            if row[0] is not True:
                return None
            return close_cleanup_obligation_with_cursor(
                cursor,
                cleanup_id,
                retention_deadline,
                provider_deadline,
            )


def cleanup_retention_expired(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> bool:
    """Read the immutable CLOSED deadline against the owning database clock."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if (
                row is None
                or row.get("state") != "closed"
                or row.get("retention_expires_at") != retention_deadline
                or row.get("provider_expires_at") != provider_deadline
                or any(
                    item.cleanup_obligation_id == cleanup_id
                    for item in _LOCAL_ADMISSIONS.values()
                )
            ):
                raise CleanupFenceError(
                    "cleanup retention deletion fence is unavailable"
                )
            return datetime.now(UTC) >= retention_deadline
    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                SELECT clock_timestamp() >= retention_expires_at
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = %s
                   AND state = 'closed'
                   AND retention_expires_at = %s
                   AND provider_expires_at = %s
                   AND NOT EXISTS (
                     SELECT 1
                       FROM public.sophia_voice_lab_cleanup_admissions admission
                      WHERE admission.cleanup_obligation_id = %s
                   )
                 FOR UPDATE
                """,
                (
                    cleanup_id,
                    retention_deadline,
                    provider_deadline,
                    cleanup_id,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                raise CleanupFenceError(
                    "cleanup retention deletion fence is unavailable"
                )
            return row[0] is True


def cleanup_retention_expired_with_cursor(
    cursor: Any,
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> bool:
    """Check exact CLOSED retention against DB time inside an existing barrier."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    cursor.execute(
        """
        SELECT clock_timestamp() >= retention_expires_at
          FROM public.sophia_voice_lab_cleanup_obligations
         WHERE cleanup_obligation_id = %s
           AND state = 'closed'
           AND retention_expires_at = %s
           AND provider_expires_at = %s
           AND NOT EXISTS (
             SELECT 1
               FROM public.sophia_voice_lab_cleanup_admissions admission
              WHERE admission.cleanup_obligation_id = %s
           )
         FOR UPDATE
        """,
        (cleanup_id, retention_deadline, provider_deadline, cleanup_id),
    )
    row = cursor.fetchone()
    if row is None:
        raise CleanupFenceError("cleanup retention deletion fence is unavailable")
    return row[0] is True


def cleanup_retention_due_before_close_with_cursor(
    cursor: Any,
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> bool:
    """Check DB time before an overdue worker is allowed to publish CLOSED."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    cursor.execute(
        """
        SELECT clock_timestamp() >= retention_expires_at
          FROM public.sophia_voice_lab_cleanup_obligations
         WHERE cleanup_obligation_id = %s
           AND state IN ('open', 'closed')
           AND retention_expires_at = %s
           AND provider_expires_at = %s
         FOR UPDATE
        """,
        (cleanup_id, retention_deadline, provider_deadline),
    )
    row = cursor.fetchone()
    if row is None:
        raise CleanupFenceError("cleanup retention deadline authority is unavailable")
    return row[0] is True


def cleanup_retention_prepared_authorized_with_cursor(
    cursor: Any,
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> datetime | None:
    """Return the locked DB clock only while exact CLOSED/due remains live."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    cursor.execute(
        """
        WITH observed AS MATERIALIZED (
          SELECT clock_timestamp() AS observed_at
        )
        SELECT observed.observed_at,
               observed.observed_at >= obligation.retention_expires_at
          FROM public.sophia_voice_lab_cleanup_obligations obligation
          CROSS JOIN observed
         WHERE obligation.cleanup_obligation_id = %s
           AND state = 'closed'
           AND retention_expires_at = %s
           AND provider_expires_at = %s
         FOR UPDATE OF obligation
        """,
        (cleanup_id, retention_deadline, provider_deadline),
    )
    row = cursor.fetchone()
    if row is None:
        raise CleanupFenceError("cleanup PREPARED authority is unavailable")
    return row[0] if row[1] is True else None


def cleanup_admissions(
    cleanup_obligation_id: str,
) -> tuple[CleanupAdmission, ...]:
    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            return tuple(
                CleanupAdmission(
                    admission_id=item.admission_id,
                    cleanup_obligation_id=item.cleanup_obligation_id,
                    resource_kind=item.resource_kind,
                    resource_id=item.resource_id,
                    lease_expires_at=item.lease_expires_at,
                    resource_expires_at=item.resource_expires_at,
                    status=item.status,
                    expired=item.lease_expires_at <= datetime.now(UTC),
                )
                for item in _LOCAL_ADMISSIONS.values()
                if item.cleanup_obligation_id == cleanup_id
            )
    with connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT admission_id, resource_kind, resource_id, lease_expires_at,
                       resource_expires_at, status,
                       lease_expires_at <= clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_admissions
                 WHERE cleanup_obligation_id = %s
                 ORDER BY created_at, admission_id
                """,
                (cleanup_id,),
            )
            return tuple(
                CleanupAdmission(
                    admission_id=str(row[0]),
                    cleanup_obligation_id=cleanup_id,
                    resource_kind=str(row[1]),
                    resource_id=row[2],
                    lease_expires_at=row[3],
                    resource_expires_at=row[4],
                    status=str(row[5]),
                    expired=row[6] is True,
                )
                for row in cursor.fetchall()
            )


@dataclass(frozen=True)
class _CleanupScanEntry:
    due_at: datetime
    source: str
    cleanup_obligation_id: str
    admission_id: str | None = None

    @property
    def key(self) -> tuple[datetime, int, str, str]:
        return (
            self.due_at,
            0 if self.source == "obligation" else 1,
            self.cleanup_obligation_id,
            self.admission_id or "",
        )


def _select_cleanup_scan_entries(
    entries: list[_CleanupScanEntry],
    *,
    limit: int,
    max_scan: int,
) -> tuple[list[_CleanupScanEntry], bool, _CleanupScanEntry | None]:
    selected: list[_CleanupScanEntry] = []
    selected_ids: set[str] = set()
    examined = 0
    last_examined: _CleanupScanEntry | None = None
    ordered = sorted(entries, key=lambda item: item.key)
    for entry in ordered:
        if examined >= max_scan:
            break
        if (
            len(selected_ids) >= limit
            and entry.cleanup_obligation_id not in selected_ids
        ):
            break
        examined += 1
        last_examined = entry
        if entry.cleanup_obligation_id in selected_ids:
            continue
        selected_ids.add(entry.cleanup_obligation_id)
        selected.append(entry)
    return selected, len(ordered) > examined, last_examined


def probe_cleanup_scan_cursors() -> None:
    """Read and validate both durable scan cursors without advancing either."""

    expected_names = {"work_v1", "complete_purge_v1"}

    def validate_position(
        name: str,
        cursor_position: tuple[datetime, str, str, str | None] | None,
        window_position: tuple[datetime, str, str, str | None] | None,
    ) -> None:
        if (cursor_position is None) != (window_position is None):
            raise CleanupFenceError("cleanup scan cursor window drifted")
        if cursor_position is None or window_position is None:
            return
        cursor_due, cursor_source, cursor_cleanup, cursor_admission = (
            cursor_position
        )
        window_due, window_source, window_cleanup, window_admission = (
            window_position
        )
        _validated_cleanup_id(cursor_cleanup)
        _validated_cleanup_id(window_cleanup)
        if not isinstance(cursor_due, datetime) or not isinstance(
            window_due, datetime
        ):
            raise CleanupFenceError("cleanup scan cursor deadline drifted")
        if name == "work_v1":
            for source, admission_id in (
                (cursor_source, cursor_admission),
                (window_source, window_admission),
            ):
                if source == "obligation":
                    if admission_id is not None:
                        raise CleanupFenceError("cleanup work cursor shape drifted")
                elif source == "admission":
                    try:
                        canonical_admission_id = str(uuid.UUID(str(admission_id)))
                    except (TypeError, ValueError, AttributeError) as exc:
                        raise CleanupFenceError(
                            "cleanup work cursor shape drifted"
                        ) from exc
                    if canonical_admission_id != str(admission_id):
                        raise CleanupFenceError("cleanup work cursor shape drifted")
                else:
                    raise CleanupFenceError("cleanup work cursor shape drifted")
            cursor_key = _CleanupScanEntry(
                due_at=cursor_due,
                source=cursor_source,
                cleanup_obligation_id=cursor_cleanup,
                admission_id=cursor_admission,
            ).key
            window_key = _CleanupScanEntry(
                due_at=window_due,
                source=window_source,
                cleanup_obligation_id=window_cleanup,
                admission_id=window_admission,
            ).key
        else:
            if (
                cursor_source != "complete"
                or window_source != "complete"
                or cursor_admission is not None
                or window_admission is not None
            ):
                raise CleanupFenceError("cleanup COMPLETE cursor shape drifted")
            cursor_key = (cursor_due, cursor_cleanup)
            window_key = (window_due, window_cleanup)
        if cursor_key > window_key:
            raise CleanupFenceError("cleanup scan cursor window drifted")

    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            if (
                set(_LOCAL_SCAN_CURSORS) != expected_names
                or set(_LOCAL_SCAN_WINDOWS) != expected_names
            ):
                raise CleanupFenceError("cleanup scan cursor set drifted")
            for name in sorted(expected_names):
                validate_position(
                    name,
                    _LOCAL_SCAN_CURSORS[name],
                    _LOCAL_SCAN_WINDOWS[name],
                )
        return
    with connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT cursor_name, cursor_due_at, cursor_source,
                       cursor_cleanup_obligation_id,
                       cursor_admission_id::text,
                       window_due_at, window_source,
                       window_cleanup_obligation_id,
                       window_admission_id::text,
                       updated_at
                  FROM public.sophia_voice_lab_cleanup_scan_cursors
                 ORDER BY cursor_name
                """
            )
            rows = cursor.fetchall()
    if len(rows) != 2 or {str(row[0]) for row in rows} != expected_names:
        raise CleanupFenceError("cleanup scan cursor set drifted")
    for row in rows:
        name = str(row[0])
        if not isinstance(row[9], datetime):
            raise CleanupFenceError("cleanup scan cursor timestamp drifted")
        cursor_position = (
            None
            if row[1] is None
            else (row[1], str(row[2]), str(row[3]), row[4])
        )
        window_position = (
            None
            if row[5] is None
            else (row[5], str(row[6]), str(row[7]), row[8])
        )
        validate_position(name, cursor_position, window_position)


def scan_cleanup_fence_work(
    *,
    limit: int,
    max_scan: int = 10_000,
    advance: bool = True,
) -> tuple[tuple[CleanupFenceWork, ...], bool]:
    """Discover due DB-only work through a durable, restart-safe keyset."""

    if not 1 <= limit <= 100 or not limit <= max_scan <= 10_000:
        raise ValueError("cleanup fence scan bounds are invalid")
    if not isinstance(advance, bool):
        raise ValueError("cleanup fence scan advance flag is invalid")
    connection = _connect()
    if connection is None:
        now = datetime.now(UTC)
        with _LOCAL_LOCK:
            entries: list[_CleanupScanEntry] = []
            for cleanup_id, row in _LOCAL_OBLIGATIONS.items():
                if row["state"] == "complete":
                    continue
                provider_deadline = row.get("provider_expires_at")
                if not isinstance(provider_deadline, datetime):
                    raise CleanupFenceError("cleanup provider deadline is unavailable")
                if row["state"] == "closed":
                    live_cleanup_completed_at = row.get(
                        "live_cleanup_completed_at"
                    )
                    closed_at = row.get("closed_at")
                    if live_cleanup_completed_at is not None and not isinstance(
                        live_cleanup_completed_at, datetime
                    ):
                        raise CleanupFenceError(
                            "cleanup live-zero checkpoint is malformed"
                        )
                    if not isinstance(closed_at, datetime):
                        raise CleanupFenceError(
                            "cleanup CLOSED timestamp is unavailable"
                        )
                    due_at = (
                        row["retention_expires_at"]
                        if live_cleanup_completed_at is not None
                        else closed_at
                    )
                else:
                    due_at = provider_deadline
                if due_at <= now:
                    entries.append(
                        _CleanupScanEntry(
                            due_at=due_at,
                            source="obligation",
                            cleanup_obligation_id=cleanup_id,
                        )
                    )
            for admission in _LOCAL_ADMISSIONS.values():
                obligation = _LOCAL_OBLIGATIONS.get(
                    admission.cleanup_obligation_id
                )
                if (
                    obligation is not None
                    and obligation.get("state") != "complete"
                    and admission.lease_expires_at <= now
                ):
                    entries.append(
                        _CleanupScanEntry(
                            due_at=admission.lease_expires_at,
                            source="admission",
                            cleanup_obligation_id=admission.cleanup_obligation_id,
                            admission_id=admission.admission_id,
                        )
                    )
            scan_cursor = _LOCAL_SCAN_CURSORS["work_v1"]
            scan_window = _LOCAL_SCAN_WINDOWS["work_v1"]
            if scan_window is None and entries:
                maximum = max(entries, key=lambda entry: entry.key)
                scan_window = (
                    maximum.due_at,
                    maximum.source,
                    maximum.cleanup_obligation_id,
                    maximum.admission_id,
                )
            cursor_key = (
                _CleanupScanEntry(
                    due_at=scan_cursor[0],
                    source=scan_cursor[1],
                    cleanup_obligation_id=scan_cursor[2],
                    admission_id=scan_cursor[3],
                ).key
                if scan_cursor is not None
                else None
            )
            window_key = (
                _CleanupScanEntry(
                    due_at=scan_window[0],
                    source=scan_window[1],
                    cleanup_obligation_id=scan_window[2],
                    admission_id=scan_window[3],
                ).key
                if scan_window is not None
                else None
            )
            if cursor_key is not None and (
                window_key is None or cursor_key > window_key
            ):
                raise CleanupFenceError("cleanup work scan window drifted")
            entries = [
                entry
                for entry in entries
                if (cursor_key is None or entry.key > cursor_key)
                and (window_key is None or entry.key <= window_key)
            ]
            selected, truncated, last_examined = _select_cleanup_scan_entries(
                entries,
                limit=limit,
                max_scan=max_scan,
            )
            if advance:
                if last_examined is None:
                    _LOCAL_SCAN_CURSORS["work_v1"] = None
                    _LOCAL_SCAN_WINDOWS["work_v1"] = None
                else:
                    _LOCAL_SCAN_CURSORS["work_v1"] = (
                        last_examined.due_at,
                        last_examined.source,
                        last_examined.cleanup_obligation_id,
                        last_examined.admission_id,
                    )
                    _LOCAL_SCAN_WINDOWS["work_v1"] = scan_window
            works: list[CleanupFenceWork] = []
            for entry in selected:
                row = _LOCAL_OBLIGATIONS.get(entry.cleanup_obligation_id)
                if row is None or row.get("state") == "complete":
                    continue
                works.append(
                    CleanupFenceWork(
                        cleanup_obligation_id=entry.cleanup_obligation_id,
                        state=str(row["state"]),
                        lifecycle_phase=str(row["lifecycle_phase"]),
                        retention_expires_at=row["retention_expires_at"],
                        provider_expires_at=row["provider_expires_at"],
                        retention_due=row["retention_expires_at"] <= now,
                        provider_due=row["provider_expires_at"] <= now,
                        admissions=tuple(
                            CleanupAdmission(
                                admission_id=item.admission_id,
                                cleanup_obligation_id=item.cleanup_obligation_id,
                                resource_kind=item.resource_kind,
                                resource_id=item.resource_id,
                                lease_expires_at=item.lease_expires_at,
                                resource_expires_at=item.resource_expires_at,
                                status=item.status,
                                expired=item.lease_expires_at <= now,
                            )
                            for item in _LOCAL_ADMISSIONS.values()
                            if item.cleanup_obligation_id
                            == entry.cleanup_obligation_id
                        ),
                    )
                )
            return tuple(works), truncated

    def fetch_entries(
        cursor: Any,
        scan_cursor: tuple[datetime, str, str, str | None] | None,
        scan_window: tuple[datetime, str, str, str | None],
    ) -> list[_CleanupScanEntry]:
        cursor_due = scan_cursor[0] if scan_cursor is not None else None
        cursor_source = scan_cursor[1] if scan_cursor is not None else None
        cursor_cleanup = scan_cursor[2] if scan_cursor is not None else None
        cursor_admission = scan_cursor[3] if scan_cursor is not None else None
        window_due, window_source, window_cleanup, window_admission = scan_window
        cursor.execute(
            """
            SELECT work.due_at, work.cleanup_obligation_id
              FROM (
                SELECT obligation.cleanup_obligation_id,
                       CASE
                         WHEN obligation.state = 'closed'
                           AND obligation.live_cleanup_completed_at IS NULL
                           THEN obligation.closed_at
                         WHEN obligation.state = 'closed'
                           THEN obligation.retention_expires_at
                         ELSE obligation.provider_expires_at
                       END AS due_at
                  FROM public.sophia_voice_lab_cleanup_obligations obligation
                 WHERE obligation.state <> 'complete'
              ) work
             WHERE work.due_at <= clock_timestamp()
               AND (
                 %s::timestamptz IS NULL
                 OR work.due_at > %s::timestamptz
                 OR (work.due_at = %s::timestamptz
                   AND %s::text = 'obligation'
                   AND work.cleanup_obligation_id > %s::text)
               )
               AND (
                 work.due_at < %s::timestamptz
                 OR (work.due_at = %s::timestamptz
                   AND (
                     %s::text = 'admission'
                     OR (%s::text = 'obligation'
                       AND work.cleanup_obligation_id <= %s::text)
                   ))
               )
             ORDER BY work.due_at, work.cleanup_obligation_id
             LIMIT %s
            """,
            (
                cursor_due,
                cursor_due,
                cursor_due,
                cursor_source,
                cursor_cleanup,
                window_due,
                window_due,
                window_source,
                window_source,
                window_cleanup,
                max_scan + 1,
            ),
        )
        entries = [
            _CleanupScanEntry(
                due_at=row[0],
                source="obligation",
                cleanup_obligation_id=str(row[1]),
            )
            for row in cursor.fetchall()
        ]
        cursor.execute(
            """
            SELECT admission.lease_expires_at,
                   admission.cleanup_obligation_id,
                   admission.admission_id::text
              FROM public.sophia_voice_lab_cleanup_admissions admission
              JOIN public.sophia_voice_lab_cleanup_obligations obligation
                ON obligation.cleanup_obligation_id =
                   admission.cleanup_obligation_id
             WHERE obligation.state <> 'complete'
               AND admission.lease_expires_at <= clock_timestamp()
               AND (
                 %s::timestamptz IS NULL
                 OR admission.lease_expires_at > %s::timestamptz
                 OR (admission.lease_expires_at = %s::timestamptz
                   AND (
                     %s::text = 'obligation'
                     OR (%s::text = 'admission'
                       AND (admission.cleanup_obligation_id,
                            admission.admission_id)
                         > (%s::text, %s::uuid))
                   ))
               )
               AND (
                 admission.lease_expires_at < %s::timestamptz
                 OR (admission.lease_expires_at = %s::timestamptz
                   AND %s::text = 'admission'
                   AND (admission.cleanup_obligation_id,
                        admission.admission_id)
                     <= (%s::text, %s::uuid))
               )
             ORDER BY admission.lease_expires_at,
                      admission.cleanup_obligation_id,
                      admission.admission_id
             LIMIT %s
            """,
            (
                cursor_due,
                cursor_due,
                cursor_due,
                cursor_source,
                cursor_source,
                cursor_cleanup,
                cursor_admission,
                window_due,
                window_due,
                window_source,
                window_cleanup,
                window_admission,
                max_scan + 1,
            ),
        )
        entries.extend(
            _CleanupScanEntry(
                due_at=row[0],
                source="admission",
                cleanup_obligation_id=str(row[1]),
                admission_id=str(row[2]),
            )
            for row in cursor.fetchall()
        )
        return sorted(entries, key=lambda entry: entry.key)

    def maximum_entry(cursor: Any) -> _CleanupScanEntry | None:
        maxima: list[_CleanupScanEntry] = []
        cursor.execute(
            """
            SELECT CASE
                     WHEN state = 'closed'
                       AND live_cleanup_completed_at IS NULL
                       THEN closed_at
                     WHEN state = 'closed' THEN retention_expires_at
                     ELSE provider_expires_at
                   END AS due_at,
                   cleanup_obligation_id
              FROM public.sophia_voice_lab_cleanup_obligations
             WHERE state <> 'complete'
               AND CASE
                     WHEN state = 'closed'
                       AND live_cleanup_completed_at IS NULL
                       THEN closed_at
                     WHEN state = 'closed' THEN retention_expires_at
                     ELSE provider_expires_at
                   END <= clock_timestamp()
             ORDER BY due_at DESC, cleanup_obligation_id DESC
             LIMIT 1
            """
        )
        obligation_row = cursor.fetchone()
        if obligation_row is not None:
            maxima.append(
                _CleanupScanEntry(
                    due_at=obligation_row[0],
                    source="obligation",
                    cleanup_obligation_id=str(obligation_row[1]),
                )
            )
        cursor.execute(
            """
            SELECT admission.lease_expires_at,
                   admission.cleanup_obligation_id,
                   admission.admission_id::text
              FROM public.sophia_voice_lab_cleanup_admissions admission
              JOIN public.sophia_voice_lab_cleanup_obligations obligation
                ON obligation.cleanup_obligation_id =
                   admission.cleanup_obligation_id
             WHERE obligation.state <> 'complete'
               AND admission.lease_expires_at <= clock_timestamp()
             ORDER BY admission.lease_expires_at DESC,
                      admission.cleanup_obligation_id DESC,
                      admission.admission_id DESC
             LIMIT 1
            """
        )
        admission_row = cursor.fetchone()
        if admission_row is not None:
            maxima.append(
                _CleanupScanEntry(
                    due_at=admission_row[0],
                    source="admission",
                    cleanup_obligation_id=str(admission_row[1]),
                    admission_id=str(admission_row[2]),
                )
            )
        return max(maxima, key=lambda entry: entry.key) if maxima else None

    with connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT cursor_due_at, cursor_source,
                       cursor_cleanup_obligation_id,
                       cursor_admission_id::text,
                       window_due_at, window_source,
                       window_cleanup_obligation_id,
                       window_admission_id::text
                  FROM public.sophia_voice_lab_cleanup_scan_cursors
                 WHERE cursor_name = 'work_v1'
                 FOR UPDATE
                """
            )
            cursor_row = cursor.fetchone()
            if cursor_row is None:
                raise CleanupFenceError("cleanup work scan cursor is unavailable")
            scan_cursor = (
                None
                if cursor_row[0] is None
                else (
                    cursor_row[0],
                    str(cursor_row[1]),
                    _validated_cleanup_id(str(cursor_row[2])),
                    str(cursor_row[3]) if cursor_row[3] is not None else None,
                )
            )
            scan_window = (
                None
                if cursor_row[4] is None
                else (
                    cursor_row[4],
                    str(cursor_row[5]),
                    _validated_cleanup_id(str(cursor_row[6])),
                    str(cursor_row[7]) if cursor_row[7] is not None else None,
                )
            )
            if (scan_cursor is None) != (scan_window is None):
                raise CleanupFenceError("cleanup work scan window drifted")
            if scan_window is None:
                maximum = maximum_entry(cursor)
                if maximum is not None:
                    scan_window = (
                        maximum.due_at,
                        maximum.source,
                        maximum.cleanup_obligation_id,
                        maximum.admission_id,
                    )
            if scan_window is not None and scan_cursor is not None:
                cursor_entry = _CleanupScanEntry(
                    due_at=scan_cursor[0],
                    source=scan_cursor[1],
                    cleanup_obligation_id=scan_cursor[2],
                    admission_id=scan_cursor[3],
                )
                window_entry = _CleanupScanEntry(
                    due_at=scan_window[0],
                    source=scan_window[1],
                    cleanup_obligation_id=scan_window[2],
                    admission_id=scan_window[3],
                )
                if cursor_entry.key > window_entry.key:
                    raise CleanupFenceError("cleanup work scan window drifted")
            entries = (
                fetch_entries(cursor, scan_cursor, scan_window)
                if scan_window is not None
                else []
            )
            selected, truncated, last_examined = _select_cleanup_scan_entries(
                entries,
                limit=limit,
                max_scan=max_scan,
            )
            if advance:
                if last_examined is not None:
                    cursor.execute(
                        """
                        UPDATE public.sophia_voice_lab_cleanup_scan_cursors
                           SET cursor_due_at = %s,
                               cursor_source = %s,
                               cursor_cleanup_obligation_id = %s,
                               cursor_admission_id = %s::uuid,
                               window_due_at = %s,
                               window_source = %s,
                               window_cleanup_obligation_id = %s,
                               window_admission_id = %s::uuid,
                               updated_at = clock_timestamp()
                         WHERE cursor_name = 'work_v1'
                        """,
                        (
                            last_examined.due_at,
                            last_examined.source,
                            last_examined.cleanup_obligation_id,
                            last_examined.admission_id,
                            scan_window[0],
                            scan_window[1],
                            scan_window[2],
                            scan_window[3],
                        ),
                    )
                elif scan_window is not None:
                    cursor.execute(
                        """
                        UPDATE public.sophia_voice_lab_cleanup_scan_cursors
                           SET cursor_due_at = NULL, cursor_source = NULL,
                               cursor_cleanup_obligation_id = NULL,
                               cursor_admission_id = NULL,
                               window_due_at = NULL, window_source = NULL,
                               window_cleanup_obligation_id = NULL,
                               window_admission_id = NULL,
                               updated_at = clock_timestamp()
                         WHERE cursor_name = 'work_v1'
                        """
                    )
            cleanup_ids = [entry.cleanup_obligation_id for entry in selected]
            admissions_by_id: dict[str, list[CleanupAdmission]] = {
                cleanup_id: [] for cleanup_id in cleanup_ids
            }
            if cleanup_ids:
                cursor.execute(
                    """
                    SELECT admission_id, cleanup_obligation_id, resource_kind,
                           resource_id, lease_expires_at, resource_expires_at,
                           status, lease_expires_at <= clock_timestamp()
                      FROM public.sophia_voice_lab_cleanup_admissions
                     WHERE cleanup_obligation_id = ANY(%s::text[])
                     ORDER BY cleanup_obligation_id, created_at, admission_id
                    """,
                    (cleanup_ids,),
                )
                for admission_row in cursor.fetchall():
                    admissions_by_id[str(admission_row[1])].append(
                        CleanupAdmission(
                            admission_id=str(admission_row[0]),
                            cleanup_obligation_id=str(admission_row[1]),
                            resource_kind=str(admission_row[2]),
                            resource_id=str(admission_row[3]),
                            lease_expires_at=admission_row[4],
                            resource_expires_at=admission_row[5],
                            status=str(admission_row[6]),
                            expired=admission_row[7] is True,
                        )
                    )
            cursor.execute(
                """
                SELECT cleanup_obligation_id, state, lifecycle_phase,
                       retention_expires_at, provider_expires_at,
                       retention_expires_at <= clock_timestamp(),
                       provider_expires_at <= clock_timestamp()
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = ANY(%s::text[])
                   AND state <> 'complete'
                """,
                (cleanup_ids,),
            )
            rows_by_id = {str(row[0]): row for row in cursor.fetchall()}
            return tuple(
                CleanupFenceWork(
                    cleanup_obligation_id=cleanup_id,
                    state=str(rows_by_id[cleanup_id][1]),
                    lifecycle_phase=str(rows_by_id[cleanup_id][2]),
                    retention_expires_at=rows_by_id[cleanup_id][3],
                    provider_expires_at=rows_by_id[cleanup_id][4],
                    retention_due=rows_by_id[cleanup_id][5] is True,
                    provider_due=rows_by_id[cleanup_id][6] is True,
                    admissions=tuple(admissions_by_id[cleanup_id]),
                )
                for cleanup_id in cleanup_ids
                if cleanup_id in rows_by_id
            ), truncated


def refresh_cleanup_fence_work_for_reconciliation(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> CleanupFenceWork:
    """Lock/re-read due truth and publish CLOSED before external cleanup.

    Scanner rows are discovery hints only.  This helper serializes with every
    producer, re-reads the current admission statuses, and closes only when the
    provider deadline or a *current* admission lease is due.  The returned
    admissions are therefore safe inputs for post-lock compensation: CLOSED
    prevents any later reserved -> allocating or admission-consume transition.
    """

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if (
                row is None
                or row.get("state") not in {"open", "closed"}
                or row.get("retention_expires_at") != retention_deadline
                or row.get("provider_expires_at") != provider_deadline
            ):
                raise CleanupFenceError(
                    "cleanup reconciliation fence is unavailable"
                )
            observed_at = datetime.now(UTC)
            admissions = tuple(
                CleanupAdmission(
                    admission_id=item.admission_id,
                    cleanup_obligation_id=item.cleanup_obligation_id,
                    resource_kind=item.resource_kind,
                    resource_id=item.resource_id,
                    lease_expires_at=item.lease_expires_at,
                    resource_expires_at=item.resource_expires_at,
                    status=item.status,
                    expired=item.lease_expires_at <= observed_at,
                )
                for item in _LOCAL_ADMISSIONS.values()
                if item.cleanup_obligation_id == cleanup_id
            )
            retention_due = retention_deadline <= observed_at
            provider_due = provider_deadline <= observed_at
            if row["state"] == "open" and (
                provider_due or any(item.expired for item in admissions)
            ):
                row["state"] = "closed"
                row["closed_at"] = observed_at
                row["updated_at"] = observed_at
            return CleanupFenceWork(
                cleanup_obligation_id=cleanup_id,
                state=str(row["state"]),
                lifecycle_phase=str(row["lifecycle_phase"]),
                retention_expires_at=retention_deadline,
                provider_expires_at=provider_deadline,
                retention_due=retention_due,
                provider_due=provider_due,
                admissions=admissions,
            )

    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            cursor.execute(
                """
                WITH observed AS MATERIALIZED (
                  SELECT clock_timestamp() AS observed_at
                )
                SELECT obligation.state, obligation.lifecycle_phase,
                       obligation.retention_expires_at,
                       obligation.provider_expires_at,
                       observed.observed_at,
                       observed.observed_at >= obligation.retention_expires_at,
                       observed.observed_at >= obligation.provider_expires_at
                  FROM public.sophia_voice_lab_cleanup_obligations obligation
                  CROSS JOIN observed
                 WHERE obligation.cleanup_obligation_id = %s
                   AND obligation.state IN ('open', 'closed')
                   AND obligation.retention_expires_at = %s
                   AND obligation.provider_expires_at = %s
                 FOR UPDATE OF obligation
                """,
                (cleanup_id, retention_deadline, provider_deadline),
            )
            obligation_row = cursor.fetchone()
            if obligation_row is None:
                raise CleanupFenceError(
                    "cleanup reconciliation fence is unavailable"
                )
            observed_at = obligation_row[4]
            cursor.execute(
                """
                SELECT admission_id, resource_kind, resource_id,
                       lease_expires_at, resource_expires_at, status
                  FROM public.sophia_voice_lab_cleanup_admissions
                 WHERE cleanup_obligation_id = %s
                 ORDER BY created_at, admission_id
                 FOR UPDATE
                """,
                (cleanup_id,),
            )
            admissions = tuple(
                CleanupAdmission(
                    admission_id=str(row[0]),
                    cleanup_obligation_id=cleanup_id,
                    resource_kind=str(row[1]),
                    resource_id=str(row[2]),
                    lease_expires_at=row[3],
                    resource_expires_at=row[4],
                    status=str(row[5]),
                    expired=row[3] <= observed_at,
                )
                for row in cursor.fetchall()
            )
            state = str(obligation_row[0])
            retention_due = obligation_row[5] is True
            provider_due = obligation_row[6] is True
            if state == "open" and (
                provider_due or any(item.expired for item in admissions)
            ):
                cursor.execute(
                    """
                    UPDATE public.sophia_voice_lab_cleanup_obligations
                       SET state = 'closed',
                           closed_at = clock_timestamp(),
                           updated_at = clock_timestamp()
                     WHERE cleanup_obligation_id = %s AND state = 'open'
                    """,
                    (cleanup_id,),
                )
                if cursor.rowcount != 1:
                    raise CleanupFenceError(
                        "cleanup reconciliation close raced"
                    )
                state = "closed"
            return CleanupFenceWork(
                cleanup_obligation_id=cleanup_id,
                state=state,
                lifecycle_phase=str(obligation_row[1]),
                retention_expires_at=obligation_row[2],
                provider_expires_at=obligation_row[3],
                retention_due=retention_due,
                provider_due=provider_due,
                admissions=admissions,
            )


def mark_cleanup_live_zero_with_cursor(
    cursor: Any,
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> datetime:
    """Persist the exact CLOSED checkpoint after every live owner is terminal.

    The caller owns the source-specific provider, Builder, and auth zero proof.
    This final database step proves that CLOSED still holds and no admission can
    re-authorize work, then turns an immediate cleanup retry into a retention
    wait.  The shared advisory lock must already be held by the caller.
    """

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    cursor.execute(
        """
        WITH observed AS MATERIALIZED (
          SELECT clock_timestamp() AS observed_at
        )
        UPDATE public.sophia_voice_lab_cleanup_obligations AS obligation
           SET live_cleanup_completed_at = COALESCE(
                 obligation.live_cleanup_completed_at,
                 GREATEST(obligation.closed_at, observed.observed_at)
               ),
               updated_at = GREATEST(
                 obligation.updated_at,
                 obligation.closed_at,
                 observed.observed_at
               )
          FROM observed
         WHERE obligation.cleanup_obligation_id = %s
           AND obligation.state = 'closed'
           AND obligation.retention_expires_at = %s
           AND obligation.provider_expires_at = %s
           AND NOT EXISTS (
             SELECT 1
               FROM public.sophia_voice_lab_cleanup_admissions AS admission
              WHERE admission.cleanup_obligation_id =
                    obligation.cleanup_obligation_id
           )
           AND public.sophia_voice_lab_d02_sources_zero(
                 obligation.cleanup_obligation_id
               )
        RETURNING obligation.live_cleanup_completed_at
        """,
        (cleanup_id, retention_deadline, provider_deadline),
    )
    row = cursor.fetchone()
    if row is None or not isinstance(row[0], datetime):
        raise CleanupFenceError("cleanup live-zero checkpoint is unavailable")
    return row[0]


def mark_cleanup_live_zero(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
) -> datetime:
    """Serialize the source-owned live-zero checkpoint with every producer."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            row = _LOCAL_OBLIGATIONS.get(cleanup_id)
            if (
                row is None
                or row.get("state") != "closed"
                or row.get("retention_expires_at") != retention_deadline
                or row.get("provider_expires_at") != provider_deadline
                or any(
                    admission.cleanup_obligation_id == cleanup_id
                    for admission in _LOCAL_ADMISSIONS.values()
                )
                or cleanup_id in _LOCAL_D02_PENDING_CLEANUPS
                or _local_d02_relay_present(cleanup_id)
            ):
                raise CleanupFenceError(
                    "cleanup live-zero checkpoint is unavailable"
                )
            checkpoint = row.get("live_cleanup_completed_at")
            if checkpoint is None:
                observed_at = datetime.now(UTC)
                closed_at = row.get("closed_at")
                if not isinstance(closed_at, datetime):
                    raise CleanupFenceError(
                        "cleanup CLOSED timestamp is unavailable"
                    )
                checkpoint = max(closed_at, observed_at)
                row["live_cleanup_completed_at"] = checkpoint
                row["updated_at"] = max(
                    row.get("updated_at", checkpoint), checkpoint
                )
            if not isinstance(checkpoint, datetime):
                raise CleanupFenceError(
                    "cleanup live-zero checkpoint is malformed"
                )
            return checkpoint

    with connection:
        with connection.cursor() as cursor:
            _lock_cursor(cursor, cleanup_id)
            return mark_cleanup_live_zero_with_cursor(
                cursor,
                cleanup_id,
                retention_deadline,
                provider_deadline,
            )


def mark_cleanup_obligation_complete_with_cursor(
    cursor: Any,
    cleanup_obligation_id: str,
) -> None:
    """Transition CLOSED only after the caller's immediate global-zero barrier."""

    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    cursor.execute(
        """
        WITH observed AS MATERIALIZED (
          SELECT clock_timestamp() AS observed_at
        )
        UPDATE public.sophia_voice_lab_cleanup_obligations AS obligation
           SET state = 'complete',
               completed_at = GREATEST(
                 obligation.live_cleanup_completed_at,
                 observed.observed_at
               ),
               purge_after = GREATEST(
                 obligation.retention_expires_at
                   + make_interval(secs => %s),
                 observed.observed_at + interval '1 minute'
               ),
               updated_at = GREATEST(
                 obligation.updated_at,
                 obligation.live_cleanup_completed_at,
                 observed.observed_at
               )
          FROM observed
         WHERE obligation.cleanup_obligation_id = %s
           AND obligation.state = 'closed'
           AND obligation.live_cleanup_completed_at IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM public.sophia_voice_lab_cleanup_admissions AS admission
              WHERE admission.cleanup_obligation_id = obligation.cleanup_obligation_id
           )
           AND public.sophia_voice_lab_d02_sources_zero(
                 obligation.cleanup_obligation_id
               )
        """,
        (_CLOSED_RETIRE_GRACE_SECONDS, cleanup_id),
    )
    if cursor.rowcount != 1:
        raise CleanupFenceError("cleanup CLOSED fence is not globally terminal")


def purge_completed_cleanup_obligations(
    *,
    eligibility_check: Callable[[str], bool],
    limit: int = 100,
    max_scan: int = 1000,
) -> int:
    """Retire COMPLETE only after owning PREPARED/tombstone verification.

    The durable keyset advances over ineligible rows, so a surviving legacy
    PREPARED handle can never poison the head and starve later safe rows.
    """

    if not 1 <= limit <= 1000 or not limit <= max_scan <= 10_000:
        raise ValueError("cleanup fence purge limit is invalid")
    if not callable(eligibility_check):
        raise ValueError("cleanup fence purge eligibility check is invalid")
    connection = _connect()
    if connection is None:
        with _LOCAL_LOCK:
            return 0
    try:
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT cursor_due_at, cursor_cleanup_obligation_id,
                           window_due_at, window_cleanup_obligation_id
                      FROM public.sophia_voice_lab_cleanup_scan_cursors
                     WHERE cursor_name = 'complete_purge_v1'
                     FOR UPDATE
                    """
                )
                cursor_row = cursor.fetchone()
                if cursor_row is None:
                    raise CleanupFenceError(
                        "cleanup COMPLETE purge cursor is unavailable"
                    )

                def fetch(
                    due_at: datetime | None,
                    cleanup_id: str | None,
                    window_due_at: datetime,
                    window_cleanup_id: str,
                ) -> list[tuple[datetime, str]]:
                    cursor.execute(
                        """
                        SELECT purge_after, cleanup_obligation_id
                          FROM public.sophia_voice_lab_cleanup_obligations
                         WHERE state = 'complete'
                           AND purge_after <= clock_timestamp()
                           AND public.sophia_voice_lab_d02_sources_zero(
                                 sophia_voice_lab_cleanup_obligations.cleanup_obligation_id
                               )
                           AND (
                             %s::timestamptz IS NULL
                             OR (purge_after, cleanup_obligation_id) >
                                (%s::timestamptz, %s::text)
                           )
                           AND (purge_after, cleanup_obligation_id) <=
                               (%s::timestamptz, %s::text)
                         ORDER BY purge_after, cleanup_obligation_id
                         LIMIT %s
                        """,
                        (
                            due_at,
                            due_at,
                            cleanup_id,
                            window_due_at,
                            window_cleanup_id,
                            max_scan + 1,
                        ),
                    )
                    return [(row[0], str(row[1])) for row in cursor.fetchall()]

                cursor_due = cursor_row[0]
                cursor_cleanup = (
                    _validated_cleanup_id(str(cursor_row[1]))
                    if cursor_row[1] is not None
                    else None
                )
                window_due = cursor_row[2]
                window_cleanup = (
                    _validated_cleanup_id(str(cursor_row[3]))
                    if cursor_row[3] is not None
                    else None
                )
                if (cursor_due is None) != (window_due is None) or (
                    (cursor_cleanup is None) != (window_cleanup is None)
                ):
                    raise CleanupFenceError(
                        "cleanup COMPLETE purge window drifted"
                    )
                if window_due is None:
                    cursor.execute(
                        """
                        SELECT purge_after, cleanup_obligation_id
                          FROM public.sophia_voice_lab_cleanup_obligations
                         WHERE state = 'complete'
                           AND purge_after <= clock_timestamp()
                           AND public.sophia_voice_lab_d02_sources_zero(
                                 sophia_voice_lab_cleanup_obligations.cleanup_obligation_id
                               )
                         ORDER BY purge_after DESC, cleanup_obligation_id DESC
                         LIMIT 1
                        """
                    )
                    maximum_row = cursor.fetchone()
                    if maximum_row is not None:
                        window_due = maximum_row[0]
                        window_cleanup = _validated_cleanup_id(
                            str(maximum_row[1])
                        )
                if (
                    cursor_due is not None
                    and window_due is not None
                    and (cursor_due, str(cursor_cleanup))
                    > (window_due, str(window_cleanup))
                ):
                    raise CleanupFenceError(
                        "cleanup COMPLETE purge window drifted"
                    )
                candidates = (
                    fetch(
                        cursor_due,
                        cursor_cleanup,
                        window_due,
                        str(window_cleanup),
                    )
                    if window_due is not None and window_cleanup is not None
                    else []
                )
                selected = candidates[: min(limit, max_scan)]
                cleanup_ids = [item[1] for item in selected]
                if selected:
                    cursor.execute(
                        """
                        UPDATE public.sophia_voice_lab_cleanup_scan_cursors
                           SET cursor_due_at = %s,
                               cursor_source = 'complete',
                               cursor_cleanup_obligation_id = %s,
                               cursor_admission_id = NULL,
                               window_due_at = %s,
                               window_source = 'complete',
                               window_cleanup_obligation_id = %s,
                               window_admission_id = NULL,
                               updated_at = clock_timestamp()
                         WHERE cursor_name = 'complete_purge_v1'
                        """,
                        (*selected[-1], window_due, window_cleanup),
                    )
                elif window_due is not None:
                    cursor.execute(
                        """
                        UPDATE public.sophia_voice_lab_cleanup_scan_cursors
                           SET cursor_due_at = NULL, cursor_source = NULL,
                               cursor_cleanup_obligation_id = NULL,
                               cursor_admission_id = NULL,
                               window_due_at = NULL, window_source = NULL,
                               window_cleanup_obligation_id = NULL,
                               window_admission_id = NULL,
                               updated_at = clock_timestamp()
                         WHERE cursor_name = 'complete_purge_v1'
                        """
                    )

        eligible_ids: list[str] = []
        for cleanup_id in cleanup_ids:
            eligible = eligibility_check(cleanup_id)
            if not isinstance(eligible, bool):
                raise CleanupFenceError(
                    "cleanup COMPLETE purge eligibility proof drifted"
                )
            if eligible:
                eligible_ids.append(cleanup_id)

        purged = 0
        for cleanup_id in eligible_ids:
            with connection.transaction():
                with connection.cursor() as cursor:
                    _lock_cursor(cursor, cleanup_id)
                    cursor.execute(
                        """
                        DELETE FROM public.sophia_voice_lab_cleanup_obligations
                         WHERE cleanup_obligation_id = %s
                           AND state = 'complete'
                           AND purge_after <= clock_timestamp()
                           AND NOT EXISTS (
                             SELECT 1
                               FROM public.sophia_voice_lab_cleanup_admissions
                              WHERE cleanup_obligation_id = %s
                           )
                           AND public.sophia_voice_lab_d02_sources_zero(%s)
                        """,
                        (cleanup_id, cleanup_id, cleanup_id),
                    )
                    purged += int(cursor.rowcount)
        return purged
    finally:
        connection.close()


def _reset_local_cleanup_fences_for_tests() -> None:
    with _LOCAL_LOCK:
        _LOCAL_OBLIGATIONS.clear()
        _LOCAL_ADMISSIONS.clear()
        _LOCAL_D02_PENDING_CLEANUPS.clear()
        _LOCAL_D02_RELAY_CLEANUPS.clear()
        _LOCAL_SCAN_CURSORS.update(
            {"work_v1": None, "complete_purge_v1": None}
        )
        _LOCAL_SCAN_WINDOWS.update(
            {"work_v1": None, "complete_purge_v1": None}
        )


def _seed_local_cleanup_obligation_for_tests(
    cleanup_obligation_id: str,
    retention_expires_at: str | datetime,
    provider_expires_at: str | datetime,
    *,
    state: str = "open",
    lifecycle_phase: str = "session_provisional",
) -> None:
    """Seed durable-control truth in local-only recovery fixtures."""

    if state not in {"open", "closed", "complete"}:
        raise CleanupFenceError("cleanup obligation state is invalid")
    cleanup_id = _validated_cleanup_id(cleanup_obligation_id)
    retention_deadline = _parsed_deadline(retention_expires_at)
    provider_deadline = _parsed_deadline(provider_expires_at)
    seeded_at = datetime.now(UTC)
    with _LOCAL_LOCK:
        _LOCAL_OBLIGATIONS[cleanup_id] = {
            "state": state,
            "lifecycle_phase": lifecycle_phase,
            "retention_expires_at": retention_deadline,
            "provider_expires_at": provider_deadline,
            "created_at": seeded_at,
            "updated_at": seeded_at,
            **({"closed_at": seeded_at} if state != "open" else {}),
            "live_cleanup_completed_at": (
                seeded_at if state == "complete" else None
            ),
            **({"completed_at": seeded_at} if state == "complete" else {}),
        }


__all__ = [
    "CleanupAdmission",
    "CleanupFenceError",
    "CleanupFenceStatus",
    "CleanupFenceWork",
    "assert_cleanup_obligation_open",
    "assert_existing_cleanup_obligation_open",
    "abort_unpublished_cleanup_provider_session",
    "bind_cleanup_provider_session",
    "cleanup_admission_authorized",
    "cleanup_admissions",
    "complete_cleanup_admission",
    "persist_cleanup_provider_terminal_receipt",
    "close_cleanup_obligation",
    "close_cleanup_obligation_if_retention_due",
    "close_cleanup_obligation_if_provider_due",
    "close_cleanup_obligation_with_cursor",
    "close_existing_cleanup_obligation",
    "close_or_seed_auth_provisional_cleanup_obligation",
    "cleanup_retention_expired",
    "cleanup_retention_expired_with_cursor",
    "cleanup_retention_due_before_close_with_cursor",
    "cleanup_retention_prepared_authorized_with_cursor",
    "local_cleanup_finalization_guard",
    "local_cleanup_prepared_guard",
    "local_cleanup_retention_guard",
    "ensure_open_with_cursor",
    "mark_cleanup_live_zero",
    "mark_cleanup_live_zero_with_cursor",
    "mark_cleanup_obligation_complete_with_cursor",
    "mark_cleanup_admission_credential_minted",
    "mark_cleanup_admission_browser_active",
    "activate_cleanup_provider_session",
    "stage_cleanup_provider_candidate",
    "close_cleanup_provider_session",
    "mark_cleanup_admission_activation_aborted",
    "mark_cleanup_admission_browser_closed",
    "purge_completed_cleanup_obligations",
    "probe_cleanup_scan_cursors",
    "release_cleanup_admission",
    "renew_cleanup_admission",
    "reserve_cleanup_admission",
    "refresh_cleanup_fence_work_for_reconciliation",
    "scan_cleanup_fence_work",
    "inspect_cleanup_admission",
    "verify_cleanup_admission_start",
    "verify_cleanup_provider_settlement_replay",
]
