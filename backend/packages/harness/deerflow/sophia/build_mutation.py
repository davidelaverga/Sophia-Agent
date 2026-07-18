from __future__ import annotations

import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from deerflow.sophia.build_runtime.identity import new_transaction_id

if TYPE_CHECKING:
    from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload
    from deerflow.sophia.build_manifest import BuildManifest

MIN_MUTATION_LEASE_SECONDS = 1
MAX_MUTATION_LEASE_SECONDS = 900
_SAFE_STORAGE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$")

_TERMINAL_STATUSES = frozenset({"committed", "rolled_back", "failed"})
_ALLOWED_TRANSITIONS = {
    "prepared": frozenset({"staged", "rolling_back", "failed"}),
    "staged": frozenset({"verified", "rolling_back", "failed"}),
    "verified": frozenset({"committing", "rolling_back", "failed"}),
    # A DQ-2 transaction may enter ``committed`` only through the atomic
    # manifest/registry/outbox commit boundary.  The generic status-CAS path
    # must never be able to certify a promotion on its own.
    "committing": frozenset({"rolling_back", "failed"}),
    "rolling_back": frozenset({"rolled_back", "failed"}),
}
_FROZEN_IDENTITY_FIELDS = (
    "build_id",
    "user_id",
    "operation_id",
    "owner_thread_id",
    "expected_manifest_revision",
    "expected_artifact_version_id",
    "expected_artifact_hash",
    "expected_component_versions",
    "authorized_selectors",
    "campaign_run_id",
    "authorized_source_roles",
    "repair_program_hash",
    "initial_quality_run_id",
)
_STAGED_IDENTITY_FIELDS = (
    "staged_object_paths",
    "candidate_version_ids",
    "candidate_manifest_object_path",
    "candidate_manifest_hash",
    "candidate_artifact_version_id",
    "candidate_artifact_hash",
)


def _aware_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("build_mutation_lease_timestamp_invalid")
    return parsed.astimezone(UTC)


def _require_lease_request(*, lease_owner: str, lease_seconds: int) -> None:
    if not lease_owner or len(lease_owner) > 256:
        raise ValueError("build_mutation_lease_owner_invalid")
    if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, int) or not MIN_MUTATION_LEASE_SECONDS <= lease_seconds <= MAX_MUTATION_LEASE_SECONDS:
        raise ValueError("build_mutation_lease_duration_invalid")


def _is_dq2(transaction: BuildMutationTransaction) -> bool:
    return any(
        (
            transaction.campaign_run_id is not None,
            bool(transaction.authorized_selectors),
            bool(transaction.authorized_source_roles),
            transaction.repair_program_hash is not None,
            transaction.initial_quality_run_id is not None,
            transaction.expected_artifact_version_id is not None,
            transaction.expected_artifact_hash is not None,
            bool(transaction.expected_component_versions),
        )
    )


def _is_recoverable_dq2(transaction: BuildMutationTransaction) -> bool:
    """Return true only for a complete durable DQ-2 transaction identity."""

    if not _is_dq2(transaction) or not transaction.gate_evidence:
        return False
    try:
        _require_dq2_identity(
            transaction,
            comparison_required=transaction.status in {"verified", "committing"},
        )
    except ValueError:
        return False
    return True


def _same_frozen_identity(
    left: BuildMutationTransaction,
    right: BuildMutationTransaction,
) -> bool:
    return all(getattr(left, field) == getattr(right, field) for field in _FROZEN_IDENTITY_FIELDS)


def _same_staged_identity(
    left: BuildMutationTransaction,
    right: BuildMutationTransaction,
) -> bool:
    return all(getattr(left, field) == getattr(right, field) for field in _STAGED_IDENTITY_FIELDS)


def _staged_object_prefix(transaction: BuildMutationTransaction) -> str:
    values = (transaction.user_id, transaction.owner_thread_id, transaction.build_id)
    if any(value is None or _SAFE_STORAGE_SEGMENT_RE.fullmatch(value) is None for value in values):
        raise ValueError("build_mutation_storage_scope_invalid")
    return f"artifacts/{transaction.user_id}/{transaction.owner_thread_id}/foundation/.builder/builds/{transaction.build_id}/"


def _require_staged_identity(transaction: BuildMutationTransaction) -> None:
    paths = transaction.staged_object_paths
    versions = transaction.candidate_version_ids
    prefix = _staged_object_prefix(transaction)
    candidate_artifact_prefix = f"{prefix}artifacts/{transaction.candidate_artifact_version_id}/"
    invalid = (
        not paths
        or len(paths) != len(set(paths))
        or any(not isinstance(path, str) or not path.strip() or len(path) > 4_096 or path.startswith(("/", "\\")) or "\\" in path or any(part in {"", ".", ".."} for part in path.split("/")) or not path.startswith(prefix) for path in paths)
        or not versions
        or len(versions) != len(set(versions))
        or any(not isinstance(version, str) or not version.strip() or len(version) > 512 for version in versions)
        or transaction.candidate_manifest_object_path not in paths
        or transaction.candidate_manifest_hash is None
        or transaction.candidate_artifact_version_id not in versions
        or transaction.candidate_artifact_hash is None
        or not any(path.startswith(candidate_artifact_prefix) for path in paths)
    )
    if invalid:
        raise ValueError("build_mutation_staged_identity_invalid")


def _require_dq2_identity(
    transaction: BuildMutationTransaction,
    *,
    comparison_required: bool = False,
) -> None:
    selectors = transaction.authorized_selectors
    roles = transaction.authorized_source_roles
    components = transaction.expected_component_versions
    invalid = (
        transaction.campaign_run_id is None
        or transaction.owner_thread_id is None
        or _SAFE_STORAGE_SEGMENT_RE.fullmatch(transaction.owner_thread_id) is None
        or transaction.repair_program_hash is None
        or transaction.initial_quality_run_id is None
        or transaction.expected_artifact_version_id is None
        or not transaction.expected_artifact_version_id.strip()
        or transaction.expected_artifact_hash is None
        or re.fullmatch(r"[0-9a-f]{64}", transaction.expected_artifact_hash) is None
        or not selectors
        or len(selectors) != len(set(selectors))
        or any(not selector.strip() or len(selector) > 512 for selector in selectors)
        or set(roles) != set(selectors)
        or any(not source_roles or len(source_roles) != len(set(source_roles)) or any(not role.strip() or len(role) > 256 for role in source_roles) for source_roles in roles.values())
        or not components
        or not set(selectors).issubset(components)
        or any(not component.strip() or len(component) > 512 or not version.strip() or len(version) > 512 for component, version in components.items())
    )
    comparison_invalid = ((transaction.candidate_quality_run_id is None) != (transaction.comparison_hash is None)) or (
        transaction.comparison_hash is not None and (transaction.candidate_quality_run_id == transaction.initial_quality_run_id or re.fullmatch(r"[0-9a-f]{64}", transaction.comparison_hash) is None)
    )
    comparison_missing = comparison_required and (transaction.candidate_quality_run_id is None or transaction.comparison_hash is None)
    if invalid or comparison_invalid or comparison_missing:
        raise ValueError("build_mutation_dq2_identity_invalid")


class BuildMutationTransaction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["sophia-build-transaction/v1"] = "sophia-build-transaction/v1"
    transaction_id: str = Field(default_factory=new_transaction_id)
    build_id: str
    user_id: str
    operation_id: str
    owner_thread_id: str | None = Field(default=None, min_length=1, max_length=128)
    expected_manifest_revision: int = Field(ge=0)
    status: Literal[
        "prepared",
        "staged",
        "verified",
        "committing",
        "committed",
        "rolling_back",
        "rolled_back",
        "failed",
    ] = "prepared"
    lease_owner: str
    lease_expires_at: str
    staged_object_paths: list[str] = Field(default_factory=list)
    candidate_version_ids: list[str] = Field(default_factory=list)
    candidate_manifest_object_path: str | None = Field(default=None, min_length=1, max_length=4_096)
    candidate_manifest_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    candidate_artifact_version_id: str | None = Field(default=None, min_length=1, max_length=512)
    candidate_artifact_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    expected_artifact_version_id: str | None = None
    expected_artifact_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    expected_component_versions: dict[str, str] = Field(default_factory=dict)
    authorized_selectors: list[str] = Field(default_factory=list)
    campaign_run_id: str | None = Field(default=None, min_length=1, max_length=512)
    authorized_source_roles: dict[str, list[str]] = Field(default_factory=dict)
    repair_program_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    initial_quality_run_id: str | None = Field(default=None, min_length=1, max_length=512)
    candidate_quality_run_id: str | None = Field(default=None, min_length=1, max_length=512)
    comparison_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    gate_evidence: dict[str, Any] = Field(default_factory=dict)
    committed_manifest_revision: int | None = None
    failure_code: str | None = None
    recovery_action: str | None = None

    @classmethod
    def prepare(
        cls,
        *,
        build_id: str,
        user_id: str,
        operation_id: str,
        expected_manifest_revision: int,
        lease_owner: str,
        lease_seconds: int = 120,
        owner_thread_id: str | None = None,
        expected_artifact_version_id: str | None = None,
        expected_artifact_hash: str | None = None,
        expected_component_versions: dict[str, str] | None = None,
        authorized_selectors: list[str] | None = None,
        campaign_run_id: str | None = None,
        authorized_source_roles: dict[str, list[str]] | None = None,
        repair_program_hash: str | None = None,
        initial_quality_run_id: str | None = None,
        gate_evidence: dict[str, Any] | None = None,
    ) -> BuildMutationTransaction:
        _require_lease_request(lease_owner=lease_owner, lease_seconds=lease_seconds)
        expires = datetime.now(UTC) + timedelta(seconds=lease_seconds)
        return cls(
            build_id=build_id,
            user_id=user_id,
            operation_id=operation_id,
            expected_manifest_revision=expected_manifest_revision,
            lease_owner=lease_owner,
            lease_expires_at=expires.isoformat(),
            owner_thread_id=owner_thread_id,
            expected_artifact_version_id=expected_artifact_version_id,
            expected_artifact_hash=expected_artifact_hash,
            expected_component_versions=dict(expected_component_versions or {}),
            authorized_selectors=list(authorized_selectors or []),
            campaign_run_id=campaign_run_id,
            authorized_source_roles=dict(authorized_source_roles or {}),
            repair_program_hash=repair_program_hash,
            initial_quality_run_id=initial_quality_run_id,
            gate_evidence=dict(gate_evidence or {}),
        )


class BuildMutationStore(Protocol):
    def create(self, transaction: BuildMutationTransaction) -> BuildMutationTransaction: ...
    def load(self, *, transaction_id: str, user_id: str) -> BuildMutationTransaction: ...
    def load_by_operation(
        self,
        *,
        build_id: str,
        user_id: str,
        operation_id: str,
    ) -> BuildMutationTransaction | None: ...
    def acquire_lease(
        self,
        *,
        transaction_id: str,
        user_id: str,
        lease_owner: str,
        lease_seconds: int = 120,
    ) -> BuildMutationTransaction: ...
    def renew_lease(
        self,
        transaction: BuildMutationTransaction,
        *,
        lease_seconds: int = 120,
    ) -> BuildMutationTransaction: ...
    def transition(self, transaction: BuildMutationTransaction, *, expected_status: str) -> BuildMutationTransaction: ...
    def recover_incomplete(
        self,
        *,
        build_id: str,
        user_id: str,
        lease_owner: str | None = None,
        lease_seconds: int = 120,
        limit: int = 50,
    ) -> list[BuildMutationTransaction]: ...


class DurableBuildMutationStore(BuildMutationStore, Protocol):
    """Production DQ-2 store with the mandatory atomic promotion boundary."""

    def load_manifest_head(self, *, build_id: str, user_id: str) -> Any: ...

    def commit_manifest(
        self,
        transaction: BuildMutationTransaction,
        *,
        manifest: BuildManifest,
        manifest_object_path: str,
        manifest_hash: str,
        acceptance: ArtifactAcceptedPayload,
    ) -> BuildMutationTransaction: ...


class InMemoryBuildMutationStore:
    def __init__(
        self,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._items: dict[tuple[str, str], BuildMutationTransaction] = {}
        self._operations: dict[tuple[str, str, str], tuple[str, str]] = {}
        self._clock = clock or (lambda: datetime.now(UTC))

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("build_mutation_clock_invalid")
        return now.astimezone(UTC)

    def create(self, transaction: BuildMutationTransaction) -> BuildMutationTransaction:
        transaction = BuildMutationTransaction.model_validate(transaction.model_dump(mode="json"))
        key = (transaction.user_id, transaction.transaction_id)
        operation_key = (transaction.user_id, transaction.build_id, transaction.operation_id)
        existing_key = self._operations.get(operation_key)
        if existing_key is not None:
            existing = self._items[existing_key]
            if transaction.status != "prepared" or not _same_frozen_identity(existing, transaction):
                raise ValueError("build_mutation_operation_id_conflict")
            return existing.model_copy(deep=True)
        if key in self._items:
            raise ValueError("build_mutation_transaction_id_conflict")
        if _is_dq2(transaction):
            if transaction.status != "prepared":
                raise ValueError("build_mutation_new_status_invalid")
            _require_dq2_identity(transaction)
            if (
                transaction.staged_object_paths
                or transaction.candidate_version_ids
                or transaction.candidate_manifest_object_path is not None
                or transaction.candidate_manifest_hash is not None
                or transaction.candidate_artifact_version_id is not None
                or transaction.candidate_artifact_hash is not None
                or transaction.candidate_quality_run_id is not None
                or transaction.comparison_hash is not None
            ):
                raise ValueError("build_mutation_new_staged_identity_invalid")
            if not transaction.gate_evidence:
                raise ValueError("build_mutation_initial_evidence_required")
            now = self._now()
            expires_at = _aware_timestamp(transaction.lease_expires_at)
            if not now < expires_at <= now + timedelta(seconds=MAX_MUTATION_LEASE_SECONDS):
                raise ValueError("build_mutation_initial_lease_invalid")
        self._items[key] = transaction.model_copy(deep=True)
        self._operations[operation_key] = key
        return transaction.model_copy(deep=True)

    def load(self, *, transaction_id: str, user_id: str) -> BuildMutationTransaction:
        return self._items[(user_id, transaction_id)].model_copy(deep=True)

    def load_by_operation(
        self,
        *,
        build_id: str,
        user_id: str,
        operation_id: str,
    ) -> BuildMutationTransaction | None:
        key = self._operations.get((user_id, build_id, operation_id))
        if key is None:
            return None
        return self._items[key].model_copy(deep=True)

    def acquire_lease(
        self,
        *,
        transaction_id: str,
        user_id: str,
        lease_owner: str,
        lease_seconds: int = 120,
    ) -> BuildMutationTransaction:
        _require_lease_request(lease_owner=lease_owner, lease_seconds=lease_seconds)
        key = (user_id, transaction_id)
        current = self._items[key]
        expires_at = _aware_timestamp(current.lease_expires_at)
        now = self._now()
        if current.status in _TERMINAL_STATUSES:
            raise ValueError("build_mutation_terminal")
        if current.lease_owner != lease_owner and expires_at > now:
            raise ValueError("build_mutation_lease_held")
        leased = current.model_copy(
            update={
                "lease_owner": lease_owner,
                "lease_expires_at": (now + timedelta(seconds=lease_seconds)).isoformat(),
            }
        )
        self._items[key] = leased
        return leased.model_copy(deep=True)

    def renew_lease(
        self,
        transaction: BuildMutationTransaction,
        *,
        lease_seconds: int = 120,
    ) -> BuildMutationTransaction:
        """Renew only the exact, still-live lease snapshot held by a worker.

        Unlike ``acquire_lease``, renewal can never reclaim an expired lease.
        The expected expiry is the fencing token, so an old heartbeat cannot
        overwrite a later renewal or a recovery worker's lease.
        """

        transaction = BuildMutationTransaction.model_validate(transaction.model_dump(mode="json"))
        _require_lease_request(
            lease_owner=transaction.lease_owner,
            lease_seconds=lease_seconds,
        )
        key = (transaction.user_id, transaction.transaction_id)
        current = self._items[key]
        now = self._now()
        if current.status in _TERMINAL_STATUSES:
            raise ValueError("build_mutation_terminal")
        if current.lease_owner != transaction.lease_owner or _aware_timestamp(current.lease_expires_at) != _aware_timestamp(transaction.lease_expires_at) or _aware_timestamp(current.lease_expires_at) <= now:
            raise ValueError("build_mutation_stale_lease")
        renewed = current.model_copy(
            update={
                "lease_expires_at": (
                    max(
                        now + timedelta(seconds=lease_seconds),
                        _aware_timestamp(current.lease_expires_at) + timedelta(microseconds=1),
                    )
                ).isoformat(),
            }
        )
        self._items[key] = renewed
        return renewed.model_copy(deep=True)

    def transition(self, transaction: BuildMutationTransaction, *, expected_status: str) -> BuildMutationTransaction:
        transaction = BuildMutationTransaction.model_validate(transaction.model_dump(mode="json"))
        key = (transaction.user_id, transaction.transaction_id)
        current = self._items.get(key)
        if current is None or current.status != expected_status:
            raise ValueError("build_mutation_stale_transition")
        if _is_dq2(current) or _is_dq2(transaction):
            _require_dq2_identity(
                transaction,
                comparison_required=transaction.status in {"verified", "committing", "committed"},
            )
            if transaction.status not in _ALLOWED_TRANSITIONS.get(expected_status, frozenset()):
                raise ValueError("build_mutation_transition_invalid")
            if not _same_frozen_identity(current, transaction):
                raise ValueError("build_mutation_identity_changed")
            if transaction.status == "staged":
                _require_staged_identity(transaction)
                if transaction.candidate_quality_run_id is not None or transaction.comparison_hash is not None:
                    raise ValueError("build_mutation_candidate_judgment_too_early")
            elif expected_status == "prepared" and (
                transaction.staged_object_paths
                or transaction.candidate_version_ids
                or transaction.candidate_manifest_object_path is not None
                or transaction.candidate_manifest_hash is not None
                or transaction.candidate_artifact_version_id is not None
                or transaction.candidate_artifact_hash is not None
                or transaction.candidate_quality_run_id is not None
                or transaction.comparison_hash is not None
            ):
                raise ValueError("build_mutation_prepared_staged_identity_invalid")
            if expected_status != "prepared":
                current_has_staged_identity = bool(
                    current.staged_object_paths
                    or current.candidate_version_ids
                    or current.candidate_manifest_object_path is not None
                    or current.candidate_manifest_hash is not None
                    or current.candidate_artifact_version_id is not None
                    or current.candidate_artifact_hash is not None
                )
                if current_has_staged_identity:
                    _require_staged_identity(current)
                elif expected_status != "rolling_back":
                    raise ValueError("build_mutation_staged_identity_missing")
                if not _same_staged_identity(current, transaction):
                    raise ValueError("build_mutation_staged_identity_changed")
                if current_has_staged_identity:
                    _require_staged_identity(transaction)
            if current.lease_owner != transaction.lease_owner or _aware_timestamp(current.lease_expires_at) != _aware_timestamp(transaction.lease_expires_at) or _aware_timestamp(current.lease_expires_at) <= self._now():
                raise ValueError("build_mutation_stale_lease")
            if (current.candidate_quality_run_id is not None and current.candidate_quality_run_id != transaction.candidate_quality_run_id) or (current.comparison_hash is not None and current.comparison_hash != transaction.comparison_hash):
                raise ValueError("build_mutation_identity_changed")
            candidate_evidence_introduced = (current.candidate_quality_run_id is None and transaction.candidate_quality_run_id is not None) or (current.comparison_hash is None and transaction.comparison_hash is not None)
            if candidate_evidence_introduced and expected_status != "staged":
                raise ValueError("build_mutation_candidate_judgment_transition_invalid")
            if expected_status not in {"prepared", "staged"} and current.gate_evidence != transaction.gate_evidence:
                raise ValueError("build_mutation_gate_evidence_changed")
            if transaction.status in {"verified", "committing", "committed"} and not transaction.gate_evidence:
                raise ValueError("build_mutation_verification_evidence_required")
        self._items[key] = transaction.model_copy(deep=True)
        return transaction.model_copy(deep=True)

    def begin(self, **kwargs: object) -> BuildMutationTransaction:
        return self.create(BuildMutationTransaction.prepare(**kwargs))  # type: ignore[arg-type]

    def stage(
        self,
        transaction: BuildMutationTransaction,
        *,
        object_paths: list[str],
        candidate_version_ids: list[str],
        candidate_manifest_object_path: str,
        candidate_manifest_hash: str,
        candidate_artifact_version_id: str,
        candidate_artifact_hash: str,
    ) -> BuildMutationTransaction:
        staged = transaction.model_copy(
            update={
                "status": "staged",
                "staged_object_paths": list(object_paths),
                "candidate_version_ids": list(candidate_version_ids),
                "candidate_manifest_object_path": candidate_manifest_object_path,
                "candidate_manifest_hash": candidate_manifest_hash,
                "candidate_artifact_version_id": candidate_artifact_version_id,
                "candidate_artifact_hash": candidate_artifact_hash,
            }
        )
        return self.transition(staged, expected_status="prepared")

    def mark_verified(self, transaction: BuildMutationTransaction, *, gate_evidence: dict[str, Any]) -> BuildMutationTransaction:
        verified = transaction.model_copy(update={"status": "verified", "gate_evidence": dict(gate_evidence)})
        return self.transition(verified, expected_status="staged")

    def commit(self, transaction: BuildMutationTransaction, *, manifest_revision: int) -> BuildMutationTransaction:
        if _is_dq2(transaction):
            raise ValueError("build_mutation_atomic_manifest_commit_required")
        committed = transaction.model_copy(update={"status": "committed", "committed_manifest_revision": manifest_revision})
        return self.transition(committed, expected_status=transaction.status)

    def rollback(
        self,
        transaction: BuildMutationTransaction,
        *,
        failure_code: str,
        recovery_action: str,
    ) -> BuildMutationTransaction:
        if _is_dq2(transaction) and transaction.status != "rolling_back":
            transaction = self.transition(
                transaction.model_copy(update={"status": "rolling_back"}),
                expected_status=transaction.status,
            )
        rolled_back = transaction.model_copy(
            update={
                "status": "rolled_back",
                "failure_code": failure_code,
                "recovery_action": recovery_action,
            }
        )
        return self.transition(rolled_back, expected_status=transaction.status)

    def recover_incomplete(
        self,
        *,
        build_id: str,
        user_id: str,
        lease_owner: str | None = None,
        lease_seconds: int = 120,
        limit: int = 50,
    ) -> list[BuildMutationTransaction]:
        if lease_owner is None:
            raise ValueError("build_mutation_recovery_lease_owner_required")
        _require_lease_request(lease_owner=lease_owner, lease_seconds=lease_seconds)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("build_mutation_recovery_limit_invalid")
        incomplete = [
            transaction.model_copy(deep=True) for (owner, _), transaction in self._items.items() if owner == user_id and transaction.build_id == build_id and transaction.status not in _TERMINAL_STATUSES and _is_recoverable_dq2(transaction)
        ]
        recovered: list[BuildMutationTransaction] = []
        now = self._now()
        for transaction in incomplete:
            if len(recovered) >= limit:
                break
            if _aware_timestamp(transaction.lease_expires_at) > now:
                continue
            recovered.append(
                self.acquire_lease(
                    transaction_id=transaction.transaction_id,
                    user_id=user_id,
                    lease_owner=lease_owner,
                    lease_seconds=lease_seconds,
                )
            )
        return recovered
